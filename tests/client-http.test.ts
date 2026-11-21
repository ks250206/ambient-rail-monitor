import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { promisify } from 'node:util';
import { expect, expectTypeOf, it, vi } from 'vite-plus/test';
import { DEFAULT_SERVER, parseServerOrigin, resolveConfig } from '../client/config.ts';
import { createClient } from '../client/http.ts';
import { RailflowError } from '../client/types.ts';
import type {
  BinaryInfo,
  FileHead,
  JobHead,
  ListPage,
  ProjectHead,
  StageHead,
  TextWindow,
} from '../client/types.ts';
import type { ConditionResult } from '../shared/conditions.ts';
import type { JobStage, JobStatus, StageStatus } from '../shared/types.ts';

async function serve(handler: RequestListener, timeout = 2_000) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  const origin = new URL(`http://127.0.0.1:${address.port}`);
  const client = createClient({ origin, requestTimeoutMs: timeout });
  return {
    origin,
    client,
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it('resolves options before environment values and ignores RAILFLOW_URL', () => {
  const env = {
    RAILFLOW_SERVER: 'http://localhost:5000',
    RAILFLOW_URL: 'http://127.0.0.1:9999',
    RAILFLOW_PROJECT: 'env_project',
  };
  expect(
    resolveConfig(
      { server: 'https://localhost:6000', project: 'explicit', requestTimeoutMs: 7 },
      env,
    ),
  ).toEqual({
    origin: new URL('https://127.0.0.1:6000'),
    projectId: 'explicit',
    requestTimeoutMs: 7,
  });
  expect(resolveConfig({}, env)).toEqual({
    origin: new URL('http://127.0.0.1:5000'),
    projectId: 'env_project',
    requestTimeoutMs: 30_000,
  });
  expect(resolveConfig({}, { RAILFLOW_URL: env.RAILFLOW_URL }).origin.origin).toBe(DEFAULT_SERVER);
  expect(parseServerOrigin('http://[::1]:5000/').host).toBe('[::1]:5000');
});

it.each([
  'http://example.com',
  'http://127.0.0.2',
  'http://127.1',
  'http://127.0.0.1:0',
  'https://localhost:000',
  'http://[::1]:0',
  'http://::1',
  'http://user:pass@localhost',
  'http://@localhost',
  'http://127.0.0.1/prefix',
  'http://localhost/./',
  'http://localhost?x=1',
  'http://localhost#x',
  'http://localhost/?',
  'http://localhost/#',
  'ftp://localhost',
])('rejects invalid server origin %s', (origin) => {
  expect(() => parseServerOrigin(origin)).toThrow(expect.objectContaining({ kind: 'usage' }));
});

it('rejects invalid project identifiers and timeouts', () => {
  expect(() => resolveConfig({ project: 'a\n' }, {})).toThrow(RailflowError);
  for (const requestTimeoutMs of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => resolveConfig({ requestTimeoutMs }, {})).toThrow(RailflowError);
  }
});

it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid default request timeout %s when constructing the client',
  (requestTimeoutMs) => {
    expect(() => createClient({ origin: new URL(DEFAULT_SERVER), requestTimeoutMs })).toThrow(
      expect.objectContaining({ kind: 'usage' }),
    );
  },
);

it('exposes the specified client projection types', () => {
  expectTypeOf<ProjectHead>().toEqualTypeOf<{ id: string; name: string; updatedAt: string }>();
  expectTypeOf<JobHead>().toEqualTypeOf<{
    id: string;
    projectId: string;
    file: string;
    status: JobStatus;
    createdAt: string;
    parentJobId?: string;
    lastSequence: number;
  }>();
  expectTypeOf<StageHead>().toEqualTypeOf<{
    key: string;
    label: string;
    status: StageStatus;
    attempts: number;
    reviewSequence?: number;
    failureKind?: JobStage['failureKind'];
  }>();
  expectTypeOf<FileHead>().toEqualTypeOf<{ path: string; bytes: number }>();
  expectTypeOf<TextWindow>().toEqualTypeOf<{
    text: string;
    offsetBytes: number;
    nextOffsetBytes: number | null;
    truncated: boolean;
  }>();
  expectTypeOf<BinaryInfo>().toEqualTypeOf<{
    binary: true;
    mimeType: string;
    bytes: number | null;
  }>();
  expectTypeOf<ListPage<FileHead>>().toEqualTypeOf<{
    items: FileHead[];
    total: number;
    nextOffset: number | null;
  }>();
});

it('rejects redirects without reaching the target', async () => {
  const handler = vi.fn<RequestListener>((_req, res) => {
    res.writeHead(302, { Location: '/target' }).end();
  });
  const { client, close } = await serve(handler);
  try {
    await expect(
      client.json('GET', '/start', undefined, { operation: 'start' }),
    ).rejects.toMatchObject({
      kind: 'protocol',
      status: 302,
      operation: 'start',
      message: expect.stringMatching(/^Unexpected redirect/),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await close();
  }
});

it('rejects invalid route forms before making a request', async () => {
  const handler = vi.fn<RequestListener>();
  const { client, close } = await serve(handler);
  try {
    for (const route of [
      'relative',
      'http://127.0.0.1/path',
      '//localhost/path',
      '/\\localhost',
      '/path#fragment',
    ]) {
      await expect(client.json('GET', route)).rejects.toMatchObject({ kind: 'usage' });
    }
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it.each([
  ['text/html', '<html></html>'],
  ['application/json', '{'],
  ['application/json', '{}'],
])('reports invalid JSON responses as protocol errors (%s %s)', async (type, body) => {
  const { client, close } = await serve((_req, res) =>
    res.writeHead(200, { 'Content-Type': type }).end(body),
  );
  try {
    await expect(
      client.json('GET', '/', undefined, {
        validate: () => {
          throw new Error('Missing field');
        },
      }),
    ).rejects.toMatchObject({ kind: 'protocol', status: 200 });
  } finally {
    await close();
  }
});

it.each([409, 415, 422])('preserves HTTP %i status and error details', async (status) => {
  const result: ConditionResult = { status: 'fail', label: 'Input', message: 'Missing file' };
  const data = { error: 'Rejected', ...(status === 422 ? { result } : {}) };
  const { client, close } = await serve((_req, res) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)),
  );
  try {
    const error: unknown = await client
      .json('POST', '/', {}, { operation: 'submit' })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RailflowError);
    expect((error as RailflowError).toJSON()).toEqual({
      kind: 'http',
      status,
      operation: 'submit',
      message: data.error,
      ...(status === 422 ? { result } : {}),
    });
  } finally {
    await close();
  }
});

it('preserves a RailflowError thrown by the JSON validator', async () => {
  const { client, close } = await serve((_req, res) =>
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'),
  );
  const error = new RailflowError({
    kind: 'usage',
    status: 404,
    operation: 'project.get',
    message: 'Project ID mismatch',
  });
  try {
    await expect(
      client.json('GET', '/', undefined, {
        validate: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  } finally {
    await close();
  }
});

it.each([
  [415, '  Unsupported upload format\n', 'HTTP 415: Unsupported upload format'],
  [500, ` ${'x'.repeat(500)}omitted\n`, `HTTP 500: ${'x'.repeat(500)}`],
  [500, ' \n\t', 'HTTP 500'],
] as const)('includes a bounded plain-text excerpt for HTTP %i', async (status, body, message) => {
  const { client, close } = await serve((_req, res) =>
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body),
  );
  try {
    await expect(client.json('GET', '/')).rejects.toMatchObject({ kind: 'http', status, message });
  } finally {
    await close();
  }
});

it.each([
  [409, 16 * 1024, 'http'],
  [200, 16 * 1024 * 1024, 'limit'],
] as const)('bounds HTTP %i reads to %i bytes', async (status, limit, kind) => {
  const { client, close } = await serve((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.write(Buffer.alloc(limit + 1, 32));
  });
  try {
    await expect(client.json('GET', '/')).rejects.toMatchObject({ kind, status });
  } finally {
    await close();
  }
});

it('distinguishes deadline expiry from caller cancellation', async () => {
  const { client, close } = await serve(() => {});
  try {
    await expect(client.json('GET', '/', undefined, { timeoutMs: 25 })).rejects.toMatchObject({
      kind: 'timeout',
    });
    const controller = new AbortController();
    const request = client.json('GET', '/', undefined, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: 'interrupted' });
  } finally {
    await close();
  }
});

it('reports loss after mutation transmission as outcome_unknown', async () => {
  const { client, close } = await serve((req) => {
    req.resume();
    req.once('end', () => req.socket.destroy());
  });
  try {
    await expect(
      client.json('POST', '/', {}, { operation: 'submit', uploadId: 'u1', jobId: 'j1' }),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      operation: 'submit',
      uploadId: 'u1',
      jobId: 'j1',
    });
  } finally {
    await close();
  }
});

it('reports refusal before mutation transmission as transport', async () => {
  const { client, close } = await serve(() => {});
  await close();
  await expect(client.json('POST', '/')).rejects.toMatchObject({ kind: 'transport' });
});

it('reports deadline after mutation transmission as outcome_unknown', async () => {
  const { client, close } = await serve((req) => {
    req.resume();
  });
  try {
    await expect(client.json('POST', '/', undefined, { timeoutMs: 100 })).rejects.toMatchObject({
      kind: 'outcome_unknown',
    });
  } finally {
    await close();
  }
});

it('sends the local Host and an empty JSON body without browser headers', async () => {
  const { client, origin, close } = await serve(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
  try {
    const result = await client.json<{ headers: Record<string, string>; body: string }>(
      'POST',
      '/',
    );
    expect(result.body).toBe('{}');
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers.host).toBe(origin.host);
    expect(result.headers).not.toHaveProperty('origin');
    expect(result.headers).not.toHaveProperty('sec-fetch-site');
  } finally {
    await close();
  }
});

it('bypasses the Node environment proxy in a fresh process', async () => {
  const proxyHandler = vi.fn<RequestListener>((_req, res) => {
    res.writeHead(502).end();
  });
  const proxy = await serve(proxyHandler);
  const target = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"direct":true}');
  });
  try {
    const moduleUrl = new URL('../client/http.ts', import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { createClient } from ${JSON.stringify(moduleUrl)};
       const client = createClient({ origin: new URL(process.argv[1]), requestTimeoutMs: 1000 });
       console.log(JSON.stringify(await client.json('GET', '/')));`,
        target.origin.href,
      ],
      {
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: proxy.origin.href,
          http_proxy: proxy.origin.href,
          NO_PROXY: '',
          no_proxy: '',
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({ direct: true });
    expect(proxyHandler).not.toHaveBeenCalled();
  } finally {
    await Promise.all([proxy.close(), target.close()]);
  }
});

it.each([false, true])('sends binary PUT bytes (streaming = %s)', async (streaming) => {
  const { client, close } = await serve(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        method: req.method,
        type: req.headers['content-type'],
        length: req.headers['content-length'],
        hex: Buffer.concat(chunks).toString('hex'),
      }),
    );
  });
  async function* chunks() {
    yield Buffer.from([0, 255]);
    yield Buffer.from([23]);
  }
  try {
    expect(
      await client.putBytes('/', streaming ? chunks() : Buffer.from([0, 255, 23]), {
        contentLength: 3,
      }),
    ).toEqual({ method: 'PUT', type: 'application/octet-stream', length: '3', hex: '00ff17' });
  } finally {
    await close();
  }
});

it('streams a binary response with its metadata', async () => {
  const { client, close } = await serve((req, res) =>
    res
      .writeHead(200, {
        'Content-Type': req.headers.accept ?? 'application/octet-stream',
        'Content-Length': '3',
      })
      .end(Buffer.from([0, 255, 23])),
  );
  try {
    const response = await client.openBytes('/', { accept: 'application/zip' });
    expect(response).toMatchObject({
      status: 200,
      contentLength: 3,
      contentType: 'application/zip',
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 23]));
    response.close();
  } finally {
    await close();
  }
});

it('cancels a stream after headers without applying the header deadline to the body', async () => {
  let reportClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    reportClosed = resolve;
  });
  const { client, close } = await serve((_req, res) => {
    res.once('close', reportClosed);
    res.writeHead(200).flushHeaders();
  });
  try {
    const controller = new AbortController();
    const response = await client.openBytes('/', { signal: controller.signal, timeoutMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(response.stream.destroyed).toBe(false);
    const error = once(response.stream, 'error');
    controller.abort();
    await expect(error).resolves.toEqual([expect.objectContaining({ kind: 'interrupted' })]);
    await closed;
  } finally {
    await close();
  }
});

it('reports a dropped JSON body as a transport error after headers', async () => {
  const { client, close } = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{', () => res.socket?.destroy());
  });
  try {
    await expect(client.json('GET', '/')).rejects.toMatchObject({ kind: 'transport' });
  } finally {
    await close();
  }
});

it('cancels an in-progress upload without marking its outcome unknown', async () => {
  const controller = new AbortController();
  const { client, close } = await serve((req) => {
    req.once('data', () => controller.abort());
  });
  async function* chunks() {
    yield Buffer.from('part');
    await once(new EventEmitter(), 'never', { signal: controller.signal });
  }
  try {
    await expect(
      client.putBytes('/', chunks(), { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'interrupted' });
  } finally {
    await close();
  }
});

it('rejects invalid UTF-8 inside a JSON string', async () => {
  const fixture = await serve((_, res) =>
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(Buffer.from([34, 255, 34])),
  );
  try {
    await expect(fixture.client.json('GET', '/')).rejects.toMatchObject({ kind: 'protocol' });
  } finally {
    await fixture.close();
  }
});

it('preserves a confirmed rejection when the error body stalls', async () => {
  const fixture = await serve((_, res) =>
    res.writeHead(409, { 'Content-Type': 'application/json' }).flushHeaders(),
  );
  try {
    await expect(fixture.client.json('POST', '/', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      kind: 'http',
      status: 409,
    });
  } finally {
    await fixture.close();
  }
});
