import * as http from 'node:http';
import * as https from 'node:https';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseServerOrigin, validateRequestTimeout } from './config.ts';
import { RailflowError, type ClientOptions, type RailflowErrorData } from './types.ts';

const MAX_ERROR_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_DELAY = 2 ** 31 - 1;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type UploadBody = Buffer | AsyncIterable<Buffer>;
type RequestContext = Pick<RailflowErrorData, 'operation' | 'uploadId' | 'jobId'>;

interface RequestOptions extends RequestContext {
  independentSignal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface JsonOptions<T> extends RequestOptions {
  validate?: (data: unknown) => T;
  mutating?: boolean;
}

interface PutOptions extends Omit<RequestOptions, 'jobId'> {
  contentLength?: number;
}

interface OpenOptions extends Omit<RequestOptions, 'jobId' | 'uploadId'> {
  accept?: string;
}

export interface BytesResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  contentType: string;
  contentLength: number | null;
  stream: Readable;
  close: () => void;
}

export interface RailflowHttpClient {
  json<T>(method: Method, route: string, body?: unknown, opts?: JsonOptions<T>): Promise<T>;
  putBytes<T>(route: string, body: UploadBody, opts?: PutOptions): Promise<T>;
  openBytes(route: string, opts?: OpenOptions): Promise<BytesResponse>;
}

async function readBody(response: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function isJson(response: http.IncomingMessage): boolean {
  return (
    response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() === 'application/json'
  );
}

function statusOf(response: http.IncomingMessage): number {
  // IncomingMessage only reaches the response callback after a status line.
  return response.statusCode!;
}

async function checkStatus(response: http.IncomingMessage, context: RequestContext): Promise<void> {
  const status = statusOf(response);
  if (status >= 300 && status < 400) {
    throw new RailflowError({
      ...context,
      kind: 'protocol',
      status,
      message: `Unexpected redirect (HTTP ${status})`,
    });
  }
  if (status >= 200 && status < 300) return;

  const body = await readBody(response, MAX_ERROR_BYTES);
  const data: RailflowErrorData = {
    ...context,
    kind: 'http',
    status,
    message: body === null ? `HTTP ${status} (error body exceeds 16 KiB)` : `HTTP ${status}`,
  };
  if (body !== null && isJson(response)) {
    try {
      const payload: { error?: unknown; result?: RailflowErrorData['result'] } | null = JSON.parse(
        body.toString('utf8'),
      );
      if (typeof payload?.error === 'string') data.message = payload.error;
      if (payload?.result) data.result = payload.result;
    } catch {
      // The HTTP status remains usable even if its error body is malformed.
    }
  } else if (body !== null) {
    const excerpt = body.toString('utf8').trim().slice(0, 500);
    if (excerpt) data.message = `HTTP ${status}: ${excerpt}`;
  }
  throw new RailflowError(data);
}

async function readJson<T>(
  response: http.IncomingMessage,
  context: RequestContext,
  validate?: (value: unknown) => T,
): Promise<T> {
  const status = statusOf(response);
  if (!isJson(response)) {
    throw new RailflowError({
      ...context,
      kind: 'protocol',
      status,
      message: 'Expected application/json response',
    });
  }
  const body = await readBody(response, MAX_JSON_BYTES);
  if (body === null) {
    throw new RailflowError({
      ...context,
      kind: 'limit',
      status,
      message: 'JSON response exceeds 16 MiB',
    });
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return validate ? validate(parsed) : (parsed as T);
  } catch (error) {
    if (error instanceof RailflowError) {
      Object.assign(error.data, { ...context, status, ...error.data });
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RailflowError({
      ...context,
      kind: 'protocol',
      status,
      message: `Invalid JSON response: ${detail}`,
    });
  }
}

export function createClient(options: ClientOptions): RailflowHttpClient {
  const origin = parseServerOrigin(options.origin.href);
  const { requestTimeoutMs } = options;
  validateRequestTimeout(requestTimeoutMs);
  const secure = origin.protocol === 'https:';
  const transport = secure ? https : http;

  async function request<T>(
    method: Method,
    route: string,
    headers: http.OutgoingHttpHeaders,
    body: UploadBody | undefined,
    opts: RequestOptions,
    mutating: boolean,
    consume: (response: http.IncomingMessage, context: RequestContext) => Promise<T> | T,
    streaming = false,
  ): Promise<T> {
    const context = requestContext(opts);
    if (!route.startsWith('/') || route.startsWith('//') || /[^!-~]|[\\#]/.test(route)) {
      throw new RailflowError({
        ...context,
        kind: 'usage',
        message: 'Route must be a relative /path',
      });
    }
    const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
    validateRequestTimeout(timeoutMs, context);

    const signals = new Set([opts.independentSignal ? undefined : options.signal, opts.signal]);
    let connected = false;
    let finished = false;
    let stopped: RailflowError | undefined;
    let outgoing: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    const start = performance.now();

    function failure(kind: 'transport' | 'timeout' | 'interrupted', message: string) {
      if (kind !== 'interrupted' && response?.statusCode && response.statusCode >= 400) {
        return new RailflowError({
          ...context,
          kind: 'http',
          status: response.statusCode,
          message: `HTTP ${response.statusCode} (error body unavailable: ${message})`,
        });
      }
      if (kind !== 'interrupted' && mutating && connected && finished) {
        return new RailflowError({
          ...context,
          kind: 'outcome_unknown',
          message: `${message}. The server may have applied the mutation.`,
        });
      }
      return new RailflowError({ ...context, kind, message });
    }

    function stop(error: RailflowError) {
      stopped ??= error;
      response?.destroy(stopped);
      outgoing?.destroy(stopped);
    }

    function interrupt() {
      stop(failure('interrupted', 'Request interrupted'));
    }

    function setDeadline() {
      const remaining = timeoutMs - (performance.now() - start);
      if (remaining <= 0) {
        stop(failure('timeout', 'Request timed out'));
        return;
      }
      timer = setTimeout(setDeadline, Math.min(MAX_TIMER_DELAY, Math.ceil(remaining)));
    }

    function cleanup() {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener('abort', interrupt);
    }

    let handedOff = false;
    try {
      for (const signal of signals) {
        if (signal?.aborted) throw failure('interrupted', 'Request interrupted');
        signal?.addEventListener('abort', interrupt, { once: true });
      }

      const incoming = await new Promise<http.IncomingMessage>((resolve, reject) => {
        outgoing = transport.request(
          origin,
          {
            method,
            path: route,
            headers: { ...headers, Host: origin.host },
            // A per-request agent does not inherit the global agent's proxy settings.
            agent: false,
          },
          (message) => {
            response = message;
            // The socket may fail before the consumer starts iterating.
            message.on('error', () => {});
            resolve(message);
          },
        );
        outgoing.on('error', reject);
        outgoing.once('socket', (socket) => {
          if (!secure && !socket.connecting && !socket.destroyed) connected = true;
          socket.once(secure ? 'secureConnect' : 'connect', () => {
            connected = true;
          });
        });
        outgoing.once('finish', () => {
          finished = true;
        });
        setDeadline();

        if (body === undefined || Buffer.isBuffer(body)) {
          outgoing.end(body);
        } else {
          const destination = outgoing;
          void pipeline(body, destination).catch((error: Error) => destination.destroy(error));
        }
      });
      if (stopped) throw stopped;
      await checkStatus(incoming, context);
      const value = await consume(incoming, context);
      if (stopped) throw stopped;
      if (streaming) {
        clearTimeout(timer);
        if (incoming.destroyed) cleanup();
        else incoming.once('close', cleanup);
        handedOff = true;
      }
      return value;
    } catch (error) {
      if (stopped) throw stopped;
      if (error instanceof RailflowError) throw error;
      throw failure('transport', error instanceof Error ? error.message : String(error));
    } finally {
      if (!handedOff) {
        cleanup();
        outgoing?.destroy();
      }
    }
  }

  return {
    async json<T>(method: Method, route: string, body?: unknown, opts: JsonOptions<T> = {}) {
      const headers: http.OutgoingHttpHeaders = { Accept: 'application/json' };
      let bytes: Buffer | undefined;
      if (method !== 'GET') {
        try {
          bytes = Buffer.from(JSON.stringify(body ?? {}));
        } catch {
          throw new RailflowError({
            ...requestContext(opts),
            kind: 'usage',
            message: 'Request body must be JSON serializable',
          });
        }
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = bytes.length;
      }
      return request(
        method,
        route,
        headers,
        bytes,
        opts,
        opts.mutating ?? method !== 'GET',
        (response, context) => readJson(response, context, opts.validate),
      );
    },

    async putBytes<T>(route: string, body: UploadBody, opts: PutOptions = {}) {
      const headers: http.OutgoingHttpHeaders = {
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
      };
      const length = opts.contentLength ?? (Buffer.isBuffer(body) ? body.length : undefined);
      if (length !== undefined) {
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          (Buffer.isBuffer(body) && body.length !== length)
        ) {
          throw new RailflowError({
            ...requestContext(opts),
            kind: 'usage',
            message: 'Invalid upload content length',
          });
        }
        headers['Content-Length'] = length;
      }
      return request<T>('PUT', route, headers, body, opts, true, readJson<T>);
    },

    async openBytes(route: string, opts: OpenOptions = {}) {
      return request(
        'GET',
        route,
        { Accept: opts.accept ?? '*/*' },
        undefined,
        opts,
        false,
        (response) => {
          const rawLength = response.headers['content-length'];
          const length = rawLength === undefined ? NaN : Number(rawLength);
          return {
            status: statusOf(response),
            headers: response.headers,
            contentType: response.headers['content-type'] ?? 'application/octet-stream',
            contentLength: Number.isSafeInteger(length) && length >= 0 ? length : null,
            stream: response,
            close: () => {
              response.destroy();
            },
          };
        },
        true,
      );
    },
  };
}

function requestContext({ operation, uploadId, jobId }: RequestOptions): RequestContext {
  return {
    ...(operation === undefined ? {} : { operation }),
    ...(uploadId === undefined ? {} : { uploadId }),
    ...(jobId === undefined ? {} : { jobId }),
  };
}
