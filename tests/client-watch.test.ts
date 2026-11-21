import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vite-plus/test';
import { createClient } from '../client/http.ts';
import { RailflowError } from '../client/types.ts';
import { classifyJobState, parseSseStream, waitJob, watchJob } from '../client/watch.ts';
import type { JobStage, JobStatus, WorkflowJob } from '../shared/types.ts';

const jobId = 'run_12345678';
const projectId = '研究';
const at = '2025-01-01T00:00:00.000Z';
const timings = {
  timeoutMs: 2_000,
  heartbeatTimeoutMs: 120,
  pollIntervalMs: 40,
  minReconnectMs: 20,
  maxReconnectMs: 80,
};

function snapshot(
  sequence = 1,
  status: JobStatus = 'running',
  stageStatus: JobStage['status'] = 'running',
): WorkflowJob {
  return {
    id: jobId,
    projectId,
    file: 'sample.txt',
    bytes: 1,
    hash: 'sample',
    createdAt: at,
    demo: false,
    needsReview: true,
    status,
    agent: null,
    worker: null,
    startedAt: at,
    finishedAt: null,
    stages: [
      {
        key: 'analyze',
        label: 'Analyze',
        short: 'Analyze',
        status: stageStatus,
        attempts: 1,
        startedAt: at,
        endedAt: null,
        summary: null,
      },
    ],
    artifacts: [],
    events: [{ type: 'stage.started', stage: 'analyze', jobId, projectId, at, sequence }],
    reviewApproved: false,
    lastMessage: '',
  };
}

function sendJob(res: ServerResponse, job: WorkflowJob) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ job }));
}

function notify(res: ServerResponse, payload: { sequence: number; projectId?: string }) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of stream) results.push(value);
  return results;
}

async function serve({
  getJob,
  onStream,
  retry = 20,
  requestTimeoutMs = 1_000,
}: {
  getJob: (res: ServerResponse, count: number) => void;
  onStream?: (res: ServerResponse, count: number) => void;
  retry?: number;
  requestTimeoutMs?: number;
}) {
  const requests: string[] = [];
  const active = new Set<ServerResponse>();
  let streamCount = 0;
  let jobCount = 0;
  const server = createServer((req, res) => {
    const route = req.url ?? '';
    requests.push(route);
    if (route !== '/api/stream' && route !== `/api/jobs/${jobId}`) {
      res.writeHead(404).end();
      return;
    }
    active.add(res);
    res.once('close', () => active.delete(res));
    if (route === '/api/stream') {
      streamCount++;
      if (onStream) onStream(res, streamCount);
      else res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write(`retry: ${retry}\n\n`);
    } else {
      getJob(res, ++jobCount);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  return {
    requests,
    active,
    get streamCount() {
      return streamCount;
    },
    get jobCount() {
      return jobCount;
    },
    client: createClient({
      origin: new URL(`http://127.0.0.1:${address.port}`),
      requestTimeoutMs,
    }),
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it('decodes byte-split UTF-8 and CRLF SSE with metadata, comments and data lines', async () => {
  const data = Buffer.from(
    '\uFEFFretry: 1500\r\n\r\n: heartbeat\r\n\r\nid: 7\r\nevent: update\r\n' +
      'data: 研究\r\ndata: second:value\r\n\r\ndata: next\n\ndata: incomplete\n',
  );
  const stream = Readable.from(Array.from(data, (byte) => Buffer.from([byte])));
  expect(await collect(parseSseStream(stream))).toEqual([
    { type: 'retry', retry: 1500 },
    { type: 'heartbeat' },
    { type: 'data', data: '研究\nsecond:value', event: 'update', id: '7' },
    { type: 'data', data: 'next', id: '7' },
  ]);
});

it('subscribes before the initial GET and coalesces notifications during a GET', async () => {
  let stream!: ServerResponse;
  const fixture = await serve({
    onStream(res) {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();
    },
    getJob(res, count) {
      if (count === 1) {
        notify(stream, { sequence: 2, projectId });
        notify(stream, { sequence: 3, projectId });
        // Deliver both notifications while the first snapshot is still in flight.
        void delay(25).then(() => sendJob(res, snapshot()));
      } else {
        sendJob(res, snapshot(3, 'done', 'success'));
      }
    },
  });
  try {
    const observations = await collect(watchJob(fixture.client, jobId, timings));
    expect(fixture.requests).toEqual(['/api/stream', `/api/jobs/${jobId}`, `/api/jobs/${jobId}`]);
    expect(
      observations.map(({ source, sequence, reason }) => ({ source, sequence, reason })),
    ).toEqual([
      { source: 'initial', sequence: 1, reason: undefined },
      { source: 'sse', sequence: 3, reason: 'done' },
    ]);
  } finally {
    await fixture.close();
  }
});

it('ignores notifications tagged with a different project and accepts unscoped updates', async () => {
  const streamReady = Promise.withResolvers<ServerResponse>();
  const fixture = await serve({
    onStream(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();
      streamReady.resolve(res);
    },
    getJob: (res, count) => sendJob(res, count === 1 ? snapshot() : snapshot(2, 'done')),
  });
  const observations = watchJob(fixture.client, jobId, { ...timings, heartbeatTimeoutMs: 500 });
  try {
    const iterator = observations[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ source: 'initial' });
    const terminal = iterator.next();
    const stream = await streamReady.promise;
    notify(stream, { sequence: 9, projectId: 'other' });
    await delay(35);
    expect(fixture.jobCount).toBe(1);
    notify(stream, { sequence: 10 });
    expect((await terminal).value).toMatchObject({ source: 'sse', sequence: 2, reason: 'done' });
    expect((await iterator.next()).done).toBe(true);
  } finally {
    await fixture.close();
  }
});

it.each([
  ['done', 'terminal', 'done'],
  ['failed', 'terminal', 'failed'],
  ['cancelled', 'attention', 'cancelled'],
  ['paused', 'attention', 'paused'],
  ['review', 'attention', 'review'],
] as const)('classifies %s when waiting for %s', (status, until, reason) => {
  expect(classifyJobState(snapshot(1, status), until)).toEqual({ reached: true, reason });
});

it('finds a Workflow v2 branch in review while the job is still running', async () => {
  const reviewing = snapshot(2, 'running', 'review');
  expect(classifyJobState(reviewing, 'terminal')).toEqual({ reached: false });
  const fixture = await serve({ getJob: (res) => sendJob(res, reviewing) });
  try {
    await expect(
      waitJob(fixture.client, jobId, { ...timings, until: 'attention' }),
    ).resolves.toMatchObject({ job: reviewing, reached: true, reason: 'review' });
  } finally {
    await fixture.close();
  }
});

it('suppresses unchanged snapshots while preserving sequence and stage-status changes', async () => {
  const streamReady = Promise.withResolvers<ServerResponse>();
  const fixture = await serve({
    onStream(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();
      streamReady.resolve(res);
    },
    getJob(res, count) {
      const jobs = [
        snapshot(),
        snapshot(),
        snapshot(2),
        snapshot(2, 'running', 'review'),
        snapshot(2, 'done', 'success'),
      ];
      sendJob(res, jobs[count - 1]);
      if (count < jobs.length) {
        void streamReady.promise.then((stream) => notify(stream, { projectId, sequence: 10 }));
      }
    },
  });
  try {
    const observations = await collect(watchJob(fixture.client, jobId, timings));
    expect(fixture.jobCount).toBe(5);
    expect(
      observations.map(({ sequence, job }) => [sequence, job.status, job.stages[0].status]),
    ).toEqual([
      [1, 'running', 'running'],
      [2, 'running', 'running'],
      [2, 'running', 'review'],
      [2, 'done', 'success'],
    ]);
  } finally {
    await fixture.close();
  }
});

it.each(['poll', 'reconnect'] as const)(
  'finds completion during a disconnect through %s',
  async (source) => {
    let firstStream!: ServerResponse;
    const fixture = await serve({
      onStream(res, count) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('retry: 1500\n\n');
        if (count === 1) firstStream = res;
      },
      getJob(res, count) {
        sendJob(res, count === 1 ? snapshot() : snapshot(2, 'done', 'success'));
        if (count === 1) firstStream.end();
      },
    });
    try {
      const observations = await collect(
        watchJob(fixture.client, jobId, {
          ...timings,
          pollIntervalMs: source === 'poll' ? 25 : 300,
        }),
      );
      expect(observations.at(-1)).toMatchObject({ source, sequence: 2, reason: 'done' });
      expect(fixture.streamCount).toBe(source === 'poll' ? 1 : 2);
    } finally {
      await fixture.close();
    }
  },
);

it('falls back to polling if the first SSE connection fails', async () => {
  const fixture = await serve({
    onStream: (res) => res.writeHead(503).end(),
    getJob: (res, count) => sendJob(res, count === 1 ? snapshot() : snapshot(2, 'done')),
  });
  try {
    const observations = await collect(watchJob(fixture.client, jobId, timings));
    expect(observations.map(({ source }) => source)).toEqual(['initial', 'poll']);
    expect(fixture.requests.slice(0, 2)).toEqual(['/api/stream', `/api/jobs/${jobId}`]);
  } finally {
    await fixture.close();
  }
});

it.each([
  ['the shorter heartbeat timeout', { heartbeatTimeoutMs: 120 }],
  ['an explicit handshake timeout', { heartbeatTimeoutMs: 3_000, handshakeTimeoutMs: 120 }],
] as const)(
  'falls back to polling when the initial SSE handshake reaches %s',
  async (_label, connectionTimeouts) => {
    const fixture = await serve({
      onStream() {},
      getJob: (res, count) => sendJob(res, count === 1 ? snapshot() : snapshot(2, 'done')),
      requestTimeoutMs: 3_000,
    });
    try {
      const observations = await collect(
        watchJob(fixture.client, jobId, {
          ...timings,
          ...connectionTimeouts,
          timeoutMs: 1_500,
          minReconnectMs: 300,
          maxReconnectMs: 300,
        }),
      );
      expect(observations.map(({ source }) => source)).toEqual(['initial', 'poll']);
      expect(fixture.streamCount).toBe(1);
    } finally {
      await fixture.close();
    }
  },
);

it('reconnects after heartbeat silence', async () => {
  const fixture = await serve({
    getJob: (res, count) => sendJob(res, count === 1 ? snapshot() : snapshot(2, 'done')),
  });
  try {
    const observations = await collect(
      watchJob(fixture.client, jobId, { ...timings, pollIntervalMs: 500 }),
    );
    expect(observations.at(-1)).toMatchObject({ source: 'reconnect', reason: 'done' });
    expect(fixture.streamCount).toBe(2);
  } finally {
    await fixture.close();
  }
});

it('resets the heartbeat watchdog on comments and partial SSE bytes', async () => {
  const streamReady = Promise.withResolvers<ServerResponse>();
  const fixture = await serve({
    onStream(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write(': ping\n\n');
      streamReady.resolve(res);
    },
    getJob: (res, count) => sendJob(res, count === 1 ? snapshot() : snapshot(2, 'done')),
  });
  const observations = watchJob(fixture.client, jobId, { ...timings, heartbeatTimeoutMs: 300 });
  try {
    const iterator = observations[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ source: 'initial' });
    const terminal = iterator.next();
    const stream = await streamReady.promise;
    await delay(180);
    stream.write(': heartbeat\n\n');
    await delay(180);
    stream.write('data: ');
    await delay(180);
    stream.write('{"sequence":2}\n\n');
    expect((await terminal).value).toMatchObject({ source: 'sse', reason: 'done' });
    expect((await iterator.next()).done).toBe(true);
    expect(fixture.streamCount).toBe(1);
  } finally {
    await fixture.close();
  }
});

it('returns the last job on timeout and releases the SSE stream and timers', async () => {
  const followUpRequested = Promise.withResolvers<void>();
  let stream!: ServerResponse;
  const fixture = await serve({
    onStream(res) {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();
    },
    getJob(res, count) {
      if (count === 1) {
        sendJob(res, snapshot());
        notify(stream, { sequence: 2, projectId });
      } else {
        followUpRequested.resolve();
      }
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    const wait = waitJob(fixture.client, jobId, { ...timings, timeoutMs: 50 });
    const result = expect(wait).resolves.toEqual({
      job: snapshot(),
      reached: false,
      reason: 'timeout',
    });
    await followUpRequested.promise;
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await vi.waitFor(() => expect(fixture.active.size).toBe(0));
  } finally {
    vi.useRealTimers();
    await fixture.close();
  }
});

it('throws interrupted on caller abort and closes the stream and in-flight GET', async () => {
  const jobRequested = Promise.withResolvers<void>();
  const controller = new AbortController();
  const fixture = await serve({
    getJob() {
      jobRequested.resolve();
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    const wait = waitJob(fixture.client, jobId, { ...timings, signal: controller.signal });
    const interrupted = expect(wait).rejects.toMatchObject({ kind: 'interrupted', jobId });
    await jobRequested.promise;
    expect(fixture.active.size).toBe(2);
    controller.abort();
    await interrupted;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await vi.waitFor(() => expect(fixture.active.size).toBe(0));
  } finally {
    vi.useRealTimers();
    await fixture.close();
  }
});

it('clears the poll and reconnect timers when interrupted during backoff', async () => {
  const initial = Promise.withResolvers<void>();
  const polling = Promise.withResolvers<void>();
  const controller = new AbortController();
  const fixture = await serve({
    onStream: (res) => res.writeHead(503).end(),
    getJob(res, count) {
      if (count === 1) {
        sendJob(res, snapshot());
        initial.resolve();
      } else {
        polling.resolve();
      }
    },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    const wait = waitJob(fixture.client, jobId, {
      ...timings,
      signal: controller.signal,
      minReconnectMs: 80,
    });
    const interrupted = expect(wait).rejects.toMatchObject({ kind: 'interrupted', jobId });
    await initial.promise;
    await vi.advanceTimersByTimeAsync(timings.pollIntervalMs);
    await polling.promise;
    controller.abort();
    await interrupted;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(fixture.streamCount).toBe(1);
    await vi.waitFor(() => expect(fixture.active.size).toBe(0));
  } finally {
    vi.useRealTimers();
    await fixture.close();
  }
});

it('throws a watch timeout if no snapshot has been obtained', async () => {
  const fixture = await serve({ getJob() {} });
  try {
    const wait = waitJob(fixture.client, jobId, { ...timings, timeoutMs: 80 });
    await expect(wait).rejects.toBeInstanceOf(RailflowError);
    await expect(wait).rejects.toMatchObject({ kind: 'timeout', jobId });
  } finally {
    await fixture.close();
  }
});

it('rejects a terminal snapshot for a different job', async () => {
  const fixture = await serve({
    getJob: (res) => sendJob(res, { ...snapshot(2, 'done'), id: 'run_87654321' }),
  });
  try {
    await expect(waitJob(fixture.client, jobId, timings)).rejects.toMatchObject({
      kind: 'protocol',
      jobId,
    });
  } finally {
    await fixture.close();
  }
});

it('rejects a snapshot with incomplete stage state', async () => {
  const job = snapshot();
  const fixture = await serve({
    getJob: (res) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ job: { ...job, stages: [{ key: 'analyze' }] } })),
  });
  try {
    await expect(waitJob(fixture.client, jobId, timings)).rejects.toMatchObject({
      kind: 'protocol',
    });
  } finally {
    await fixture.close();
  }
});
