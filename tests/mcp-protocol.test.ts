import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { McpProtocolError, type McpServerHandlers } from '../mcp/protocol.ts';
import { MAX_FRAME_BYTES, runStdioServer } from '../mcp/stdio.ts';

const handlers: McpServerHandlers = {
  serverInfo: { name: 'railflow', version: 'test' },
  listTools: (page) => ({ tools: [], page }),
  callTool: (params) => ({ content: [{ type: 'text', text: JSON.stringify(params) }] }),
  listResources: (page) => ({ resources: [], page }),
  listResourceTemplates: (page) => ({ resourceTemplates: [], page }),
  readResource: ({ uri }) => ({ contents: [{ uri, text: 'resource' }] }),
};

function request(id: string | number, method: string, params?: unknown) {
  return { jsonrpc: '2.0', id, method, params };
}
function notify(method: string, params?: unknown) {
  return { jsonrpc: '2.0', method, params };
}
function init(version = '2025-11-25') {
  return request('init', 'initialize', {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 'wire-test', version: '1' },
  });
}
function result(id: string | number, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}
function error(id: unknown, code: number) {
  return { jsonrpc: '2.0', id, error: expect.objectContaining({ code }) };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

function wire(
  overrides: Partial<McpServerHandlers> = {},
  options: { maxFrameBytes?: number; maxConcurrent?: number } = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const done = runStdioServer({
    input,
    output,
    stderr,
    handlers: { ...handlers, ...overrides },
    signal: controller.signal,
    ...options,
  });
  let partial = '';
  const messages: unknown[] = [];
  output.setEncoding('utf8').on('data', (text: string) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop()!;
    for (const line of lines) messages.push(JSON.parse(line));
  });
  function send(message: unknown) {
    input.write(JSON.stringify(message) + '\n');
  }
  async function next() {
    while (!messages.length) await once(output, 'data');
    return messages.shift();
  }
  async function ready() {
    send(init());
    expect(await next()).toMatchObject({ id: 'init', result: { protocolVersion: '2025-11-25' } });
    send(notify('notifications/initialized'));
  }
  return { input, output, stderr, controller, done, messages, send, next, ready };
}

it('negotiates, declares capabilities, and serves each request with its original ID', async () => {
  const w = wire();
  w.send(init());
  expect(await w.next()).toEqual(
    result('init', {
      protocolVersion: '2025-11-25',
      serverInfo: handlers.serverInfo,
      capabilities: { tools: {}, resources: {} },
    }),
  );
  w.send(notify('notifications/initialized'));
  const call = { name: 'echo', arguments: { value: 'a\nb' } };
  const cases = [
    ['ping', {}, {}],
    ['tools/list', { cursor: 'tools' }, { tools: [], page: { cursor: 'tools' } }],
    ['tools/call', call, { content: [{ type: 'text', text: JSON.stringify(call) }] }],
    ['resources/list', undefined, { resources: [], page: {} }],
    ['resources/templates/list', { cursor: '' }, { resourceTemplates: [], page: { cursor: '' } }],
    [
      'resources/read',
      { uri: 'railflow://x' },
      { contents: [{ uri: 'railflow://x', text: 'resource' }] },
    ],
  ] as const;
  for (const [id, [method, params, expected]] of cases.entries()) {
    w.send(request(id, method, params));
    expect(await w.next()).toEqual(result(id, expected));
  }
});

it('allows ping and guards business requests until the initialized notification', async () => {
  const w = wire();
  w.send(notify('notifications/initialized'));
  for (const phase of ['new', 'initializing']) {
    if (phase === 'initializing') {
      w.send(init('unsupported'));
      expect(await w.next()).toMatchObject({
        id: 'init',
        result: { protocolVersion: '2025-11-25' },
      });
      w.send(init());
      expect(await w.next()).toEqual(error('init', -32600));
    }
    for (const method of [
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/templates/list',
      'resources/read',
    ]) {
      w.send(request(1, method));
      expect(await w.next()).toEqual(error(1, -32600));
    }
    w.send(request(0, 'ping'));
    expect(await w.next()).toEqual(result(0, {}));
  }
  w.send(notify('notifications/initialized'));
  w.send(notify('notifications/initialized'));
  w.send(init());
  expect(await w.next()).toEqual(error('init', -32600));
  w.send(request('missing', 'unknown'));
  expect(await w.next()).toEqual(error('missing', -32601));
});

it('rejects invalid request shapes, IDs and params before invoking handlers', async () => {
  const callTool = vi.fn(handlers.callTool);
  const w = wire({ callTool });
  for (const [message, id] of [
    [null, null],
    [{ id: 1, method: 'ping' }, 1],
    [{ jsonrpc: '2.0', id: 1, method: 7 }, 1],
    ...[null, [], 1].map((params) => [request('p', 'ping', params), 'p']),
    ...[null, true, {}, [], 1.25].map((id) => [{ ...request(0, 'ping'), id }, null]),
  ]) {
    w.send(message);
    expect(await w.next()).toEqual(error(id, -32600));
  }
  for (const params of [
    {},
    { ...(init().params as object), capabilities: [] },
    { ...(init().params as object), clientInfo: { name: 'x' } },
  ]) {
    w.send(request(1, 'initialize', params));
    expect(await w.next()).toEqual(error(1, -32602));
  }
  await w.ready();
  for (const [method, params] of [
    ['tools/list', { cursor: 1 }],
    ['resources/list', { cursor: null }],
    ['resources/templates/list', { cursor: [] }],
    ['tools/call', {}],
    ['tools/call', { name: '' }],
    ['tools/call', { name: 'x', arguments: [] }],
    ['tools/call', { name: 'x', arguments: null }],
    ['resources/read', { uri: '' }],
    ['resources/read', {}],
    ['ping', { extra: 1 }],
  ] as const) {
    w.send(request('bad', method, params));
    expect(await w.next()).toEqual(error('bad', -32602));
  }
  expect(callTool).not.toHaveBeenCalled();
});

it('handles split UTF-8 and CRLF, ignores blank lines, and recovers after bad frames', async () => {
  const w = wire();
  const bytes = Buffer.from(JSON.stringify(request('🚂東京', 'ping')) + '\r\n');
  for (const byte of bytes) {
    w.input.write(Buffer.from([byte]));
    await nextTurn();
  }
  expect(await w.next()).toEqual(result('🚂東京', {}));
  w.input.write('  \r\n\nContent-Length: 21\r\n\r\n{broken}\n');
  w.input.write(
    Buffer.concat([
      Buffer.from('{"id":"'),
      Buffer.from([0xff]),
      Buffer.from('","method":"ping","jsonrpc":"2.0"}\n'),
    ]),
  );
  w.send([request(1, 'ping')]);
  w.send(request(2, 'ping'));
  for (let i = 0; i < 3; i++) expect(await w.next()).toEqual(error(null, -32700));
  expect(await w.next()).toEqual(error(null, -32600));
  expect(await w.next()).toEqual(result(2, {}));
});

it.each([1024, 1024 * 1024])(
  'enforces the %i-byte limit before a newline arrives',
  async (limit) => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    const w = wire({}, limit === 1024 ? { maxFrameBytes: limit } : {});
    const ping = JSON.stringify(request(3, 'ping'));
    w.input.write(ping.padEnd(limit, ' ') + '\n');
    expect(await w.next()).toEqual(result(3, {}));
    w.input.write(Buffer.alloc(limit, 0x61));
    await nextTurn();
    expect(w.input.destroyed).toBe(false);
    w.input.write('x');
    await w.done;
    expect(w.input.destroyed).toBe(true);
    expect(w.messages).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Frame exceeds maximum size' } },
    ]);
  },
);

it('accepts a frame at the byte limit with a split CRLF delimiter', async () => {
  const line = JSON.stringify(request(3, 'ping'));
  const w = wire({}, { maxFrameBytes: Buffer.byteLength(line) });
  w.input.write(line + '\r');
  await nextTurn();
  w.input.write('\n');
  expect(await w.next()).toEqual(result(3, {}));
  w.input.write(line + '\r');
  await nextTurn();
  w.input.write(' ');
  await w.done;
  expect(w.messages).toEqual([error(null, -32600)]);
});

it('limits concurrency at eight, rejects active duplicates and correlates reversed replies', async () => {
  const ids = [1, '1', 2, 3, 4, 5, 6, 7];
  const gates = new Map(ids.map((id) => [id, Promise.withResolvers<object>()]));
  const w = wire({ callTool: (_params, { requestId }) => gates.get(requestId)!.promise });
  await w.ready();
  for (const id of ids) w.send(request(id, 'tools/call', { name: 'held' }));
  w.send(request(1, 'tools/call', { name: 'duplicate' }));
  w.send(request('overflow', 'tools/call', { name: 'busy' }));
  expect(await w.next()).toEqual(error(1, -32600));
  expect(await w.next()).toEqual({
    jsonrpc: '2.0',
    id: 'overflow',
    error: { code: -32000, message: 'Server busy' },
  });
  for (const id of ids.toReversed()) {
    gates.get(id)!.resolve({ value: id });
    expect(await w.next()).toEqual(result(id, { value: id }));
  }
});

it('cancels only the matching ID and discards its eventual response', async () => {
  const numeric = Promise.withResolvers<object>();
  const textual = Promise.withResolvers<object>();
  const signals = new Map<string | number, AbortSignal>();
  const w = wire({
    callTool: (_params, { signal, requestId }) => {
      signals.set(requestId, signal);
      return typeof requestId === 'string' ? textual.promise : numeric.promise;
    },
  });
  await w.ready();
  for (const id of [4, '4']) w.send(request(id, 'tools/call', { name: 'wait' }));
  w.send(notify('notifications/cancelled', { requestId: 4, reason: 'stop' }));
  w.send(notify('notifications/cancelled', { requestId: '4', reason: {} }));
  w.send(notify('notifications/other'));
  w.send(request('barrier', 'ping'));
  expect(await w.next()).toEqual(result('barrier', {}));
  expect(signals.get(4)?.reason).toBe('stop');
  expect(signals.get('4')?.aborted).toBe(false);
  numeric.reject(new Error('late failure'));
  textual.resolve({ ok: true });
  expect(await w.next()).toEqual(result('4', { ok: true }));
  w.send(notify('notifications/cancelled', { requestId: '4' }));
  w.input.end();
  await w.done;
  expect(w.messages).toEqual([]);
  expect(w.stderr.readableLength).toBe(0);
});

it('preserves protocol error data and keeps unexpected handler errors off the wire and stderr', async () => {
  const w = wire({
    readResource: () => {
      throw new McpProtocolError(-32002, 'Resource not found', { gone: true });
    },
    callTool: () => Promise.reject(new Error('secret response')),
  });
  await w.ready();
  w.send(request(1, 'resources/read', { uri: 'railflow://gone' }));
  expect(await w.next()).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32002, message: 'Resource not found', data: { gone: true } },
  });
  w.send(request(2, 'tools/call', { name: 'secret request' }));
  expect(await w.next()).toEqual({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32603, message: 'Internal error' },
  });
  expect(String(w.stderr.read())).toBe('MCP request handler failed\n');
});

it('returns a complete internal error when a handler supplies an unwritable response', async () => {
  const w = wire({
    callTool: () => undefined,
    listResources: () => {
      throw new McpProtocolError(-32002, 'failed', { value: 3n });
    },
  });
  await w.ready();
  w.send(request(1, 'tools/call', { name: 'empty' }));
  w.send(request(2, 'resources/list'));
  w.send(request(3, 'ping'));
  expect(await w.next()).toEqual(error(1, -32603));
  expect(await w.next()).toEqual(error(2, -32603));
  expect(await w.next()).toEqual(result(3, {}));
});

it('waits for drain and flushes every complete frame in FIFO order at EOF', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  let drains = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      expect(lines.length).toBe(drains);
      lines.push(chunk.toString());
      setImmediate(callback);
    },
  });
  output.on('drain', () => drains++);
  const done = runStdioServer({ input, output, handlers });
  const ids = Array.from({ length: 1000 }, (_, id) => id);
  input.end(ids.map((id) => JSON.stringify(request(id, 'ping')) + '\n').join(''));
  await done;
  expect(drains).toBe(ids.length);
  expect(lines).toEqual(ids.map((id) => JSON.stringify(result(id, {})) + '\n'));
});

it.each(['EOF', 'input close', 'EPIPE', 'output close', 'abort'])(
  '%s aborts every pending request and releases the transport',
  async (event) => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<object>();
    const signals: AbortSignal[] = [];
    const w = wire({
      callTool: (_params, { signal }) => {
        signals.push(signal);
        if (signals.length === 2) started.resolve();
        return pending.promise;
      },
    });
    await w.ready();
    for (const id of [1, 2]) w.send(request(id, 'tools/call', { name: 'wait' }));
    await started.promise;
    if (event === 'EOF') w.input.end();
    if (event === 'input close') w.input.destroy();
    if (event === 'EPIPE') {
      w.output._write = (_chunk, _encoding, callback) =>
        callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
      w.send(request(3, 'ping'));
    }
    if (event === 'output close') w.output.destroy();
    if (event === 'abort') w.controller.abort();
    await w.done;
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    pending.resolve({ tooLate: true });
    await nextTurn();
    expect(w.messages).toEqual([]);
  },
);
