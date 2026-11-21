import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vite-plus/test';
import type { RailflowHttpClient } from '../client/http.ts';
import { RailflowError, type RailflowErrorData } from '../client/types.ts';
import { runCli, type CliRuntime } from '../cli/main.ts';
import { exportTemplate } from '../shared/templates.ts';
import type { JobStatus, ProjectSpec } from '../shared/types.ts';

const jobId = 'run_12345678';
const uploadId = '00000000-0000-0000-0000-000000000001';
const condition = { op: 'file.exists', pattern: '*.csv' };
const project = {
  id: 'lab',
  name: 'Lab',
  updatedAt: '2026-11-21T00:00:00Z',
  stages: [
    {
      key: 'run',
      label: 'Run',
      runner: { kind: 'command', program: 'node', args: ['run.mjs', 'two words'] },
    },
  ],
  input: { condition },
} as ProjectSpec;

function job(status: JobStatus = 'done', sequence = 1) {
  return {
    id: jobId,
    projectId: 'lab',
    file: 'data.csv',
    createdAt: '2026-11-21T00:00:00Z',
    status,
    stages: [],
    artifacts: [{ name: 'image.png', uri: '/image.png', bytes: 3 }],
    events: [{ sequence }],
  };
}

type JsonOptions<T> = Omit<NonNullable<Parameters<RailflowHttpClient['json']>[3]>, 'validate'> & {
  validate?: (response: unknown) => T;
};
type Reply = (operation: string | undefined, body: unknown) => unknown;

function bytes(contentType: string, data: string | Buffer | Readable) {
  const stream = data instanceof Readable ? data : Readable.from([data]);
  return {
    status: 200,
    headers: {},
    contentType,
    contentLength: null,
    stream,
    close: () => stream.destroy(),
  };
}

function mockClient(reply: Reply = () => ({ projects: [] })) {
  const calls: Array<{ operation?: string; body: unknown }> = [];
  const client: RailflowHttpClient = {
    async json<T>(_method: string, _route: string, body?: unknown, options?: JsonOptions<T>) {
      calls.push({ operation: options?.operation, body });
      const response = reply(options?.operation, body);
      return options?.validate ? options.validate(response) : (response as T);
    },
    putBytes: vi.fn(() => {
      throw new Error('Unexpected upload');
    }),
    openBytes: vi.fn(() => {
      throw new Error('Unexpected stream');
    }),
  };
  return { client, calls };
}

async function cli(
  args: string[],
  {
    client = mockClient().client,
    ...runtime
  }: CliRuntime & {
    client?: RailflowHttpClient;
  } = {},
) {
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const sink = (chunks: Buffer[]) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
  const clientFactory = vi.fn(() => client);
  const code = await runCli(args, {
    env: {},
    stdin: Readable.from([]),
    stdout: sink(output),
    stderr: sink(errors),
    isTTY: false,
    version: '1.2.3',
    clientFactory,
    ...runtime,
  });
  return {
    code,
    out: Buffer.concat(output).toString(),
    err: Buffer.concat(errors).toString(),
    clientFactory,
  };
}

it('prints help and version without creating a client', async () => {
  const help = await cli(['-h']);
  expect(help).toMatchObject({ code: 0, out: expect.stringContaining('review approve'), err: '' });
  expect(help.clientFactory).not.toHaveBeenCalled();
  expect(await cli(['jobs', 'rerun', 'execute', '--help'])).toMatchObject({
    code: 0,
    out: expect.stringContaining('--task'),
  });
  expect(await cli(['--version'])).toMatchObject({ code: 0, out: '1.2.3\n' });
  expect(await cli(['unknown'])).toMatchObject({ code: 2, out: '' });
  expect(await cli(['jobs', 'pause', jobId, '--watch'])).toMatchObject({ code: 2, out: '' });
});

it('accepts global options anywhere and resolves the project fallback', async () => {
  const { client, calls } = mockClient(() => ({ project }));
  const result = await cli(
    ['--server', 'http://localhost:4567', 'projects', '--json', 'get', '--request-timeout-ms=60'],
    {
      client,
      env: { RAILFLOW_PROJECT: 'lab' },
    },
  );
  expect(result.code).toBe(0);
  expect(result.clientFactory).toHaveBeenCalledWith(
    expect.objectContaining({
      origin: new URL('http://127.0.0.1:4567'),
      requestTimeoutMs: 60,
    }),
  );
  expect(JSON.parse(result.out)).toEqual(project);
  expect(await cli(['projects', 'get', 'lab', '--project', 'other'], { client })).toMatchObject({
    code: 2,
    err: expect.stringContaining('--project'),
  });
  expect(calls).toHaveLength(1);
});

it.each([
  ['projects', 'delete', 'lab'],
  ['templates', 'delete', '--name', 'A', '--revision', '1', '--hash', 'a'.repeat(64)],
  ['jobs', 'cancel', jobId],
  [
    'review',
    'approve',
    jobId,
    '--stage',
    'run',
    '--attempt',
    '1',
    '--sequence',
    '2',
    '--receipt',
    'token',
  ],
])('requires explicit confirmation for %j', async (...args) => {
  const { client, calls } = mockClient();
  expect(await cli(args, { client })).toMatchObject({
    code: 2,
    out: '',
    err: expect.stringContaining('--yes'),
  });
  expect(calls).toEqual([]);
});

const failures: Array<[number, RailflowErrorData]> = [
  [2, { kind: 'usage', message: 'invalid' }],
  [3, { kind: 'transport', message: 'offline' }],
  [4, { kind: 'limit', message: 'too large' }],
  [4, { kind: 'protocol', message: 'malformed response' }],
  [4, { kind: 'http', status: 415, operation: 'health', message: 'unsupported media type' }],
  [5, { kind: 'http', status: 409, operation: 'projects.update', message: 'stale' }],
  [
    6,
    {
      kind: 'http',
      status: 422,
      message: 'rejected',
      result: { status: 'fail', label: 'File', message: 'Missing CSV' },
    },
  ],
  [9, { kind: 'timeout', message: 'timed out' }],
  [
    10,
    { kind: 'outcome_unknown', operation: 'upload.commit', uploadId, jobId, message: 'unknown' },
  ],
  [130, { kind: 'interrupted', message: 'interrupted' }],
];

it.each(failures)(
  'maps client failures to exit %i and preserves error data',
  async (code, error) => {
    const { client } = mockClient(() => {
      throw new RailflowError(error);
    });
    const result = await cli(['health', '--json'], { client });
    expect(result).toMatchObject({ code, out: '' });
    expect(JSON.parse(result.err)).toEqual({ error });
  },
);

it('maps an unexpected exception to exit 1', async () => {
  const { client } = mockClient(() => {
    throw new Error('unexpected');
  });
  const result = await cli(['health', '--json'], { client });
  expect(result).toMatchObject({ code: 1, out: '' });
  expect(JSON.parse(result.err)).toEqual({ error: { kind: 'internal', message: 'unexpected' } });
});

it('reports malformed configuration and interrupted stdin through the normal exit codes', async () => {
  const invalid = await cli(['health', '--json', '--server', 'https://example.com']);
  expect(invalid).toMatchObject({ code: 2, out: '' });
  expect(JSON.parse(invalid.err)).toMatchObject({ error: { kind: 'usage' } });
  expect(invalid.clientFactory).not.toHaveBeenCalled();

  const controller = new AbortController();
  const result = cli(['templates', 'validate', '--file', '-', '--json'], {
    stdin: new PassThrough(),
    signal: controller.signal,
  });
  setImmediate(() => controller.abort());
  const interrupted = await result;
  expect(interrupted).toMatchObject({ code: 130, out: '' });
  expect(JSON.parse(interrupted.err)).toMatchObject({ error: { kind: 'interrupted' } });
});

it('uses the provided update timestamp and requires an explicit project for mutations', async () => {
  const { client, calls } = mockClient(() => ({ project }));
  const args = ['--file', '-', '--expected-updated-at', project.updatedAt, '--json'];
  const runtime = () => ({ client, stdin: Readable.from(['{"name":"Updated"}']) });
  expect(await cli(['projects', 'update', ...args], runtime())).toMatchObject({ code: 2 });
  expect(calls).toEqual([]);
  for (const command of [
    ['projects', 'update'],
    ['workflow', 'set'],
  ]) {
    expect(await cli([...command, 'lab', ...args], runtime())).toMatchObject({ code: 0, err: '' });
    expect(calls.at(-1)).toEqual({
      operation: 'projects.update',
      body: { name: 'Updated', expectedUpdatedAt: project.updatedAt },
    });
  }
});

it.each([
  ['projects update', ['--file', '-', '--expected-updated-at', project.updatedAt]],
  ['projects delete', ['--yes']],
  ['workflow set', ['--file', '-', '--expected-updated-at', project.updatedAt]],
  ['templates save', ['--name', 'Example', '--revision', '1']],
  ['submit', ['missing.csv']],
  ['demo', []],
] as const)('rejects an environment-only project for %s', async (command, args) => {
  const { client, calls } = mockClient(() => ({ project }));
  const result = await cli([...command.split(' '), ...args], {
    client,
    env: { RAILFLOW_PROJECT: 'lab' },
    stdin: Readable.from(['{}']),
  });
  expect(result).toMatchObject({ code: 2, out: '', err: expect.stringContaining('--project') });
  expect(calls).toEqual([]);
});

it('prints condition failures from the default project condition, stdin and a file', async () => {
  const result = { status: 'fail', label: 'Required', message: 'Missing CSV', children: [] };
  const { client, calls } = mockClient((operation, body) =>
    operation === 'inputs.check' && body === undefined ? { project } : { result },
  );
  const args = ['inputs', 'check', 'lab', '--name', 'dataset', '--json'];
  const dir = await mkdtemp(join(tmpdir(), 'railflow-cli-'));
  try {
    const path = join(dir, 'condition.json');
    await writeFile(path, JSON.stringify(condition));
    for (const [extra, runtime] of [
      [[], {}],
      [['--condition', '-'], { stdin: Readable.from([Buffer.from(JSON.stringify(condition))]) }],
      [['--condition', path, '--origin', 'legacy'], {}],
    ] as const) {
      const response = await cli([...args, ...extra], { client, ...runtime });
      expect(response).toMatchObject({ code: 6, err: '' });
      expect(JSON.parse(response.out)).toEqual(result);
      expect(calls.at(-1)?.body).toMatchObject({ name: 'dataset', condition });
    }
    expect(calls.at(-1)?.body).toMatchObject({ origin: 'legacy' });
    expect(
      await cli([...args, '--condition', '-'], {
        client,
        stdin: Readable.from(['{"op":"unknown"}']),
      }),
    ).toMatchObject({ code: 2, out: '' });
    expect(calls).toHaveLength(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('shows server preview and execution details when validating a template', async () => {
  const template = exportTemplate(project, 'Example', 'r1');
  const { client } = mockClient(() => ({ template, preview: { stages: 1, kinds: ['command'] } }));
  const result = await cli(['templates', 'validate', '--file', '-'], {
    client,
    stdin: Readable.from([JSON.stringify(template)]),
  });
  expect(result).toMatchObject({ code: 0, err: '' });
  for (const value of ['preview', 'executionDetails', 'run.mjs', 'two words']) {
    expect(result.out).toContain(value);
  }
});

it('inspects, reads and approves the exact review coordinates', async () => {
  const { client, calls } = mockClient((operation, body) =>
    operation === 'review.inspect'
      ? {
          stageKey: 'run',
          attempt: 2,
          reviewSequence: 4,
          summary: null,
          failureKind: 'timeout',
          receipt: 'receipt',
          files: [{ path: 'out.txt', bytes: 4 }],
        }
      : { ok: true, stageKey: 'run', ...(body as object) },
  );
  const open = vi.fn(async () => bytes('text/plain', 'test'));
  client.openBytes = open;
  const args = [jobId, '--stage', 'run'];
  const exact = [...args, '--attempt', '2', '--sequence', '4'];
  const listed = await cli(['review', 'list', ...args, '--json'], { client });
  expect(JSON.parse(listed.out)).toMatchObject({
    ref: { jobId, stageKey: 'run', attempt: 2, reviewSequence: 4 },
    receipt: 'receipt',
  });
  expect(await cli(['review', 'read', ...exact, '--path', 'out.txt'], { client })).toMatchObject({
    code: 0,
    out: 'test',
  });
  expect(open).toHaveBeenCalledWith(
    expect.stringContaining('sequence=4&path=out.txt'),
    expect.anything(),
  );
  for (const exception of [true, false]) {
    expect(
      await cli(
        [
          'review',
          'approve',
          ...exact,
          '--receipt',
          'receipt',
          '--yes',
          ...(exception ? ['--exception'] : []),
        ],
        { client },
      ),
    ).toMatchObject({ code: 0 });
    expect(calls.at(-1)).toEqual({
      operation: 'review.approve_exact',
      body: { stage: 'run', attempt: 2, reviewSequence: 4, receipt: 'receipt', exception },
    });
  }
});

it('rejects binary stdout in JSON or a terminal and allows raw redirected output', async () => {
  const { client } = mockClient((operation) =>
    operation === 'review.inspect'
      ? {
          stageKey: 'run',
          attempt: 1,
          reviewSequence: 2,
          summary: null,
          failureKind: null,
          receipt: 'token',
          files: [],
        }
      : { job: job() },
  );
  client.openBytes = async () => bytes('application/octet-stream', Buffer.from([0, 65, 66]));
  const artifact = ['artifacts', 'get', jobId, '--name', 'image.png', '--out', '-'];
  const review = [
    'review',
    'read',
    jobId,
    '--stage',
    'run',
    '--attempt',
    '1',
    '--sequence',
    '2',
    '--path',
    'image.png',
  ];
  for (const args of [artifact, review]) {
    expect(await cli([...args, '--json'], { client })).toMatchObject({ code: 2, out: '' });
    expect(await cli(args, { client, isTTY: true })).toMatchObject({ code: 2, out: '' });
    expect(await cli(args, { client })).toMatchObject({ code: 0, out: '\0AB' });
  }
});

it('tails logs and writes original provenance bytes', async () => {
  const { client } = mockClient();
  const raw = '{  "raw": true }\n';
  client.openBytes = async (_route, options) =>
    options?.operation === 'provenance.get'
      ? bytes('application/json', raw)
      : bytes('text/plain', 'one\ntwo\nthree\n');
  const dir = await mkdtemp(join(tmpdir(), 'railflow-cli-'));
  try {
    const output = join(dir, 'provenance.json');
    expect(await cli(['jobs', 'logs', jobId, '--tail', '2'], { client })).toMatchObject({
      code: 0,
      out: 'two\nthree\n',
    });
    expect(
      await cli(['jobs', 'provenance', jobId, '--out', output, '--json'], { client }),
    ).toMatchObject({ code: 0 });
    expect(await readFile(output, 'utf8')).toBe(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('preserves ANSI-colored logs when streaming to a terminal or formatting JSON', async () => {
  const { client } = mockClient();
  const text = '\x1b[32mready\x1b[0m\n';
  client.openBytes = async () => bytes('text/plain', text);
  const args = ['jobs', 'logs', jobId];
  const runtime = { client, isTTY: true };
  expect(await cli(args, runtime)).toMatchObject({ code: 0, out: text, err: '' });
  expect(await cli([...args, '--tail', '1'], runtime)).toMatchObject({
    code: 0,
    out: text,
    err: '',
  });
  const json = await cli([...args, '--json'], { client });
  expect(json).toMatchObject({ code: 0, err: '' });
  expect(JSON.parse(json.out)).toEqual({ text });
});

it('streams a split UTF-8 character safely to a terminal', async () => {
  const { client } = mockClient(() => ({ job: job() }));
  const text = Buffer.from('粒');
  client.openBytes = async () =>
    bytes('application/octet-stream', Readable.from([text.subarray(0, 1), text.subarray(1)]));
  expect(
    await cli(['artifacts', 'get', jobId, '--name', 'image.png', '--out', '-'], {
      client,
      isTTY: true,
    }),
  ).toMatchObject({ code: 0, out: '粒', err: '' });
});

it('watches the new job after submit, demo, or rerun execution', async () => {
  const { client, calls } = mockClient((operation) => {
    if (operation === 'upload.create') return { id: uploadId };
    if (operation !== undefined) return { job: job('queued') };
    return { job: job('review') };
  });
  client.openBytes = async () => bytes('text/event-stream', new PassThrough());
  const uploaded: Buffer[] = [];
  client.putBytes = async <T>(_route: string, body: Buffer | AsyncIterable<Buffer>) => {
    if (Buffer.isBuffer(body)) uploaded.push(body);
    else for await (const chunk of body) uploaded.push(chunk);
    return { ok: true } as T;
  };
  const dir = await mkdtemp(join(tmpdir(), 'railflow-cli-'));
  try {
    const path = join(dir, 'data.csv');
    await writeFile(path, '1,2\n');
    for (const args of [
      ['submit', path, '--project', 'lab', '--name', 'measurement'],
      ['demo', '--project', 'lab', '--review'],
      ['jobs', 'rerun', 'execute', jobId, '--task', 'run'],
    ]) {
      const result = await cli([...args, '--watch', '--json'], { client });
      expect(result).toMatchObject({ code: 8, err: '' });
      expect(JSON.parse(result.out)).toMatchObject({ job: { id: jobId }, reason: 'review' });
    }
    expect(Buffer.concat(uploaded).toString()).toBe('1,2\n');
    expect(calls).toContainEqual({
      operation: 'demo.create',
      body: { projectId: 'lab', review: true },
    });
    expect(calls).toContainEqual({
      operation: 'upload.create',
      body: {
        projectId: 'lab',
        name: 'measurement',
        kind: 'file',
        files: [{ path: 'data.csv', bytes: 4 }],
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('separates preview from execution, supports negative priority and retries upload commit', async () => {
  const { client, calls } = mockClient((operation) =>
    operation === 'rerun.preview'
      ? { rerun: ['run'], reuse: [] }
      : {
          job: job(
            operation === 'jobs.pause'
              ? 'pausing'
              : operation === 'jobs.cancel'
                ? 'cancelling'
                : 'done',
          ),
        },
  );
  for (const [args, operation, body] of [
    [
      ['jobs', 'rerun', 'preview', jobId, '--task', 'run'],
      'rerun.preview',
      { task: 'run', preview: true },
    ],
    [
      ['jobs', 'rerun', 'execute', jobId, '--task', 'run'],
      'rerun.execute',
      { task: 'run', preview: false },
    ],
    [['jobs', 'priority', jobId, '-15'], 'jobs.priority', { priority: -15 }],
    [['uploads', 'commit', uploadId], 'upload.commit', undefined],
  ] as const) {
    expect(await cli([...args, '--json'], { client })).toMatchObject({ code: 0, err: '' });
    expect(calls.at(-1)).toEqual({ operation, body });
  }
  for (const [action, status] of [
    ['pause', 'pausing'],
    ['cancel', 'cancelling'],
  ] as const) {
    const result = await cli(['jobs', action, jobId, ...(action === 'cancel' ? ['--yes'] : [])], {
      client,
    });
    expect(result).toMatchObject({ code: 0, out: expect.stringContaining(status) });
  }
});

it.each([
  ['done', 0],
  ['failed', 7],
  ['cancelled', 7],
  ['paused', 8],
  ['review', 8],
] as const)('maps %s wait/watch state to %i', async (status, code) => {
  const { client } = mockClient(() => ({ job: job(status) }));
  client.openBytes = async () => bytes('text/event-stream', new PassThrough());
  const waited = await cli(['jobs', 'wait', jobId, '--until', 'attention', '--json'], { client });
  expect(waited).toMatchObject({ code, err: '' });
  expect(JSON.parse(waited.out)).toMatchObject({ reason: status });
  const watched = await cli(['jobs', 'get', jobId, '--watch', '--json'], { client });
  expect(watched).toMatchObject({ code, err: '' });
  expect(JSON.parse(watched.out)).toMatchObject({ reason: status, source: 'initial' });
});

it('emits one JSON line per watch observation and uses terminal wait by default', async () => {
  const stream = new PassThrough();
  let calls = 0;
  const { client } = mockClient(() => {
    if (calls++ === 0) {
      setImmediate(() => stream.write('data: {"projectId":"lab","sequence":2}\n\n'));
      return { job: job('running') };
    }
    return { job: job('done', 2) };
  });
  client.openBytes = async () => bytes('text/event-stream', stream);
  const result = await cli(['jobs', 'get', jobId, '--watch', '--json'], { client });
  expect(result).toMatchObject({ code: 0, err: '' });
  expect(
    result.out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).job.status),
  ).toEqual(['running', 'done']);
  const paused = mockClient(() => ({ job: job('paused') })).client;
  paused.openBytes = async () => bytes('text/event-stream', new PassThrough());
  const timeout = await cli(['jobs', 'wait', jobId, '--timeout-ms', '20', '--json'], {
    client: paused,
  });
  expect(timeout).toMatchObject({ code: 9, err: '' });
  expect(JSON.parse(timeout.out)).toMatchObject({ reason: 'timeout' });
});

it('delegates MCP with its original arguments and no stdout output', async () => {
  const runMcp = vi.fn(async () => {});
  const env = { RAILFLOW_PROJECT: 'lab' };
  const args = [
    '--server',
    'http://localhost:4567',
    '--upload-root',
    '/tmp',
    '--request-timeout-ms=42',
  ];
  const result = await cli([...args.slice(0, 2), 'mcp', ...args.slice(2)], { runMcp, env });
  expect(result).toMatchObject({ code: 0, out: '', err: '' });
  expect(runMcp).toHaveBeenCalledWith(args, env);
  expect(result.clientFactory).not.toHaveBeenCalled();
});

it.each([['--json'], ['--project', 'lab']])(
  'rejects the unsupported MCP option %s before delegation',
  async (...args) => {
    const runMcp = vi.fn(async () => {});
    expect(await cli(['mcp', ...args], { runMcp })).toMatchObject({
      code: 2,
      out: '',
      err: expect.stringContaining(`${args[0]} is not valid for mcp`),
    });
    expect(runMcp).not.toHaveBeenCalled();
  },
);

it('keeps HTTP routes out of CLI command modules', async () => {
  for (const name of ['projects', 'jobs', 'inputs', 'review']) {
    const source = await readFile(new URL(`../cli/commands/${name}.ts`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/\/api\/|\.openBytes\(|\.json\s*(?:<|\()/);
  }
});
