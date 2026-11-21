import type { Readable } from 'node:stream';
import type { WorkflowJob } from '../shared/types.ts';
import type { BytesResponse, RailflowHttpClient } from './http.ts';
import { RailflowError } from './types.ts';

export type WatchUntil = 'terminal' | 'attention';

type ReachedReason = 'done' | 'failed' | 'cancelled' | 'paused' | 'review';

export interface JobObservation {
  job: WorkflowJob;
  sequence: number;
  source: 'initial' | 'sse' | 'poll' | 'reconnect';
  reached: boolean;
  reason?: ReachedReason;
}

export interface WatchOptions {
  until?: WatchUntil;
  timeoutMs?: number;
  signal?: AbortSignal;
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  pollIntervalMs?: number;
  minReconnectMs?: number;
  maxReconnectMs?: number;
}

export interface WaitResult {
  job: WorkflowJob;
  reached: boolean;
  reason: ReachedReason | 'timeout';
}

export function classifyJobState(
  job: WorkflowJob,
  until: WatchUntil,
): { reached: true; reason: ReachedReason } | { reached: false } {
  const { status } = job;
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    return { reached: true, reason: status };
  }
  if (until === 'attention') {
    if (status === 'paused') return { reached: true, reason: 'paused' };
    if (status === 'review' || job.stages.some((stage) => stage.status === 'review')) {
      return { reached: true, reason: 'review' };
    }
  }
  return { reached: false };
}

export type SseEvent =
  | { type: 'data'; data: string; event?: string; id?: string }
  | { type: 'heartbeat' }
  | { type: 'retry'; retry: number };

export function parseSseStream(stream: Readable): AsyncIterable<SseEvent> {
  return parseSse(stream);
}

async function* parseSse(stream: Readable, onBytes?: () => void): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let partial = '';
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for await (const chunk of stream) {
    onBytes?.();
    const decoded =
      typeof chunk === 'string'
        ? decoder.decode() + chunk
        : decoder.decode(chunk, { stream: true });
    const lines = (partial + decoded).split('\n');
    partial = lines.pop()!;
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        const message = data.length
          ? {
              type: 'data' as const,
              data: data.join('\n'),
              ...(event ? { event } : {}),
              ...(id === undefined ? {} : { id }),
            }
          : undefined;
        data = [];
        event = undefined;
        if (message) yield message;
        continue;
      }
      if (line.startsWith(':')) {
        yield { type: 'heartbeat' };
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      switch (field) {
        case 'data':
          data.push(value);
          break;
        case 'event':
          event = value;
          break;
        case 'id':
          if (!value.includes('\0')) id = value;
          break;
        case 'retry': {
          const retry = Number(value);
          if (/^[0-9]+$/.test(value) && Number.isSafeInteger(retry)) yield { type: 'retry', retry };
          break;
        }
      }
    }
  }
  // SSE dispatches data only after a blank line, including at EOF.
}

class WatchTimeoutError extends RailflowError {
  constructor(jobId: string) {
    super({ kind: 'timeout', jobId, message: 'Job watch timed out' });
  }
}

type Source = JobObservation['source'];

const sourcePriority: Record<Source, number> = { poll: 0, sse: 1, reconnect: 2, initial: 3 };
const maxTimerDelay = 2 ** 31 - 1;

export async function* watchJob(
  client: RailflowHttpClient,
  jobId: string,
  options: WatchOptions = {},
): AsyncIterable<JobObservation> {
  const {
    until = 'terminal',
    timeoutMs,
    signal,
    heartbeatTimeoutMs = 36_000,
    handshakeTimeoutMs = Math.min(heartbeatTimeoutMs, 5_000),
    pollIntervalMs = 2_000,
    minReconnectMs = 1_500,
    maxReconnectMs = 15_000,
  } = options;
  const lifetime = new AbortController();
  const stopped = lifetime.signal;
  const route = `/api/jobs/${encodeURIComponent(jobId)}`;
  const observations: JobObservation[] = [];
  const earlyProjects = new Set<string | undefined>();
  let projectId: string | undefined;
  let lastKey: string | undefined;
  let pendingSource: Source | undefined;
  let snapshotTask: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let failure: unknown;

  let activeStream: BytesResponse | undefined;
  let streamTask: Promise<void> | undefined;
  let connectionTask: Promise<void> | undefined;
  let serverRetry = 0;
  let backoff = minReconnectMs;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;

  function stop(error?: unknown) {
    if (stopped.aborted) return;
    failure = error;
    clearTimeout(deadlineTimer);
    clearTimeout(heartbeatTimer);
    clearTimeout(reconnectTimer);
    clearInterval(pollTimer);
    signal?.removeEventListener('abort', interrupt);
    lifetime.abort();
    activeStream?.close();
    wake?.();
  }

  function interrupt() {
    stop(new RailflowError({ kind: 'interrupted', jobId, message: 'Job watch interrupted' }));
  }

  function setDeadline(remainingMs: number) {
    if (remainingMs <= 0) {
      stop(new WatchTimeoutError(jobId));
      return;
    }
    const delay = Math.min(remainingMs, maxTimerDelay);
    deadlineTimer = setTimeout(() => setDeadline(remainingMs - delay), delay);
  }

  function refresh(source: Source) {
    if (stopped.aborted) return;
    // Keep one dirty refresh while a GET is in flight. A reconnect or notification
    // can replace a queued poll because its snapshot also covers the poll.
    if (!pendingSource || sourcePriority[source] > sourcePriority[pendingSource]) {
      pendingSource = source;
    }
    snapshotTask ??= Promise.resolve().then(readSnapshots);
  }

  async function readSnapshots() {
    try {
      while (pendingSource && !stopped.aborted) {
        const source = pendingSource;
        pendingSource = undefined;
        let job: WorkflowJob;
        try {
          ({ job } = await client.json<{ job: WorkflowJob }>('GET', route, undefined, {
            jobId,
            signal: stopped,
          }));
        } catch (error) {
          if (stopped.aborted) return;
          if (
            source !== 'initial' &&
            error instanceof RailflowError &&
            (error.kind === 'transport' ||
              error.kind === 'timeout' ||
              (error.kind === 'http' && (error.status ?? 0) >= 500))
          ) {
            // A lost snapshot read needs another chance even if SSE still appears live.
            activeStream?.close();
            continue;
          }
          throw error;
        }
        if (stopped.aborted) return;
        if (source === 'initial') {
          projectId = job.projectId;
          if (earlyProjects.has(undefined) || earlyProjects.has(projectId)) refresh('sse');
          earlyProjects.clear();
        }

        // The job's journal tracks its revision. The SSE sequence can belong to another job.
        const sequence = job.events.at(-1)?.sequence ?? 0;
        const key = JSON.stringify([
          sequence,
          job.status,
          job.stages.map((s) => [s.key, s.status]),
        ]);
        if (key === lastKey) continue;
        lastKey = key;
        const state = classifyJobState(job, until);
        observations.push({ job, source, sequence, ...state });
        wake?.();
        if (state.reached) stop();
      }
    } catch (error) {
      stop(error);
    } finally {
      snapshotTask = undefined;
    }
  }

  function handleNotification(data: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const project = 'projectId' in payload ? payload.projectId : undefined;
    if (project !== undefined && typeof project !== 'string') return;
    if (projectId === undefined) earlyProjects.add(project);
    else if (project === undefined || project === projectId) refresh('sse');
  }

  function scheduleReconnect() {
    if (stopped.aborted) return;
    pollTimer ??= setInterval(() => refresh('poll'), pollIntervalMs);
    const delay = Math.min(maxReconnectMs, Math.max(backoff, serverRetry));
    backoff = Math.min(maxReconnectMs, delay * 2);
    reconnectTimer = setTimeout(() => {
      connectionTask = connect(false);
    }, delay);
  }

  async function readStream(response: BytesResponse) {
    const connectedAt = performance.now();
    let lastBytesAt = connectedAt;
    function resetHeartbeat() {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(response.close, heartbeatTimeoutMs);
    }

    try {
      resetHeartbeat();
      for await (const event of parseSse(response.stream, () => {
        lastBytesAt = performance.now();
        resetHeartbeat();
      })) {
        if (stopped.aborted) break;
        if (event.type === 'retry') serverRetry = event.retry;
        if (event.type === 'data') handleNotification(event.data);
      }
    } catch (error) {
      if (error instanceof RailflowError && error.kind === 'interrupted') interrupt();
    } finally {
      clearTimeout(heartbeatTimer);
      response.close();
      activeStream = undefined;
      if (lastBytesAt - connectedAt >= heartbeatTimeoutMs) backoff = minReconnectMs;
      scheduleReconnect();
    }
  }

  async function connect(initial: boolean) {
    const handshake = new AbortController();
    heartbeatTimer = setTimeout(() => handshake.abort(), handshakeTimeoutMs);
    let response: BytesResponse;
    try {
      response = await client.openBytes('/api/stream', {
        signal: AbortSignal.any([stopped, handshake.signal]),
        accept: 'text/event-stream',
      });
    } catch (error) {
      if (
        !handshake.signal.aborted &&
        error instanceof RailflowError &&
        error.kind === 'interrupted'
      ) {
        interrupt();
      }
      scheduleReconnect();
      return;
    } finally {
      clearTimeout(heartbeatTimer);
    }
    if (
      stopped.aborted ||
      response.contentType.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream'
    ) {
      response.close();
      scheduleReconnect();
      return;
    }
    activeStream = response;
    clearInterval(pollTimer);
    pollTimer = undefined;
    streamTask = readStream(response);
    if (!initial) refresh('reconnect');
  }

  try {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
      throw new RailflowError({
        kind: 'usage',
        jobId,
        message: 'Watch timeout must be a non-negative safe integer',
      });
    }
    if (signal?.aborted) interrupt();
    else signal?.addEventListener('abort', interrupt, { once: true });
    if (timeoutMs !== undefined && !stopped.aborted) setDeadline(timeoutMs);
    if (!stopped.aborted) await connect(true);
    refresh('initial');

    while (true) {
      const next = observations.shift();
      if (next) {
        yield next;
        if (next.reached) return;
      } else if (stopped.aborted) {
        if (failure !== undefined) throw failure;
        return;
      } else {
        const ready = Promise.withResolvers<void>();
        wake = ready.resolve;
        await ready.promise;
        wake = undefined;
      }
    }
  } finally {
    stop();
    await Promise.all([snapshotTask, connectionTask, streamTask]);
  }
}

export async function waitJob(
  client: RailflowHttpClient,
  jobId: string,
  options?: WatchOptions,
): Promise<WaitResult> {
  let lastJob: WorkflowJob | undefined;
  try {
    for await (const observation of watchJob(client, jobId, options)) {
      lastJob = observation.job;
      if (observation.reached && observation.reason) {
        return { job: lastJob, reached: true, reason: observation.reason };
      }
    }
  } catch (error) {
    if (lastJob && error instanceof WatchTimeoutError) {
      return { job: lastJob, reached: false, reason: 'timeout' };
    }
    throw error;
  }
  throw new RailflowError({ kind: 'protocol', jobId, message: 'Job watch ended without a result' });
}
