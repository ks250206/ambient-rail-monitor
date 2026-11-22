import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vite-plus/test';
import { createMcpHandlers, MAX_TOOL_RESULT_BYTES } from '../mcp/catalog.ts';
import { runMcp } from '../mcp/main.ts';
import { createMcpSession, type JsonRpcResponse } from '../mcp/protocol.ts';
import { toolSchemas } from '../mcp/schemas.ts';
import { exportTemplate } from '../shared/templates.ts';

const names = [
  'health',
  'projects_list',
  'project_get',
  'project_create',
  'workflow_set',
  'project_delete',
  'templates_list',
  'template_export',
  'template_validate',
  'template_save',
  'template_delete',
  'inputs_list',
  'input_check',
  'dataset_submit',
  'upload_commit',
  'demo_create',
  'queue_get',
  'queue_set',
  'jobs_list',
  'job_get',
  'job_wait',
  'job_logs',
  'job_pause',
  'job_resume',
  'job_cancel',
  'job_priority',
  'rerun_preview',
  'rerun_execute',
  'review_list',
  'review_read',
  'review_approve',
  'provenance_get',
  'artifacts_list',
  'artifact_read',
].map((name) => 'railflow_' + name);
const hints = 'RRRAEMRRRSIRRECARIRRRRMEMMRE RR ERRR'.replaceAll(' ', '');
const uploadId = '12345678-1234-4234-8234-123456789abc';
const jobId = 'run_1234abcd';
const origin = new URL('http://127.0.0.1:1');
const project = { id: 'sample', name: 'Sample', updatedAt: 'now', stages: [] };
const job = {
  id: jobId,
  projectId: project.id,
  file: 'a.txt',
  status: 'running',
  createdAt: 'now',
  stages: [],
  events: [],
  artifacts: [],
};
const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture(options: Partial<Parameters<typeof createMcpHandlers>[0]> = {}) {
  const replies: JsonRpcResponse[] = [];
  const session = createMcpSession(
    createMcpHandlers({ origin, requestTimeoutMs: 500, ...options }),
    (reply) => {
      replies.push(reply);
    },
  );
  cleanup.push(session.close);
  let id = 0;
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const current = ++id;
    await session.handleMessage({ jsonrpc: '2.0', id: current, method, params });
    const reply = replies.pop()!;
    expect(reply.id).toBe(current);
    return reply;
  }
  async function result<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const reply = await rpc(method, params);
    if ('error' in reply) throw new Error(JSON.stringify(reply.error));
    return reply.result as T;
  }
  async function ready() {
    await result('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  async function tool(name: string, args = {}) {
    const response = await result<{
      isError?: boolean;
      structuredContent: { ok: boolean; data?: unknown; error?: { kind: string; message: string } };
      content: [{ type: string; text: string }];
    }>('tools/call', { name: 'railflow_' + name, arguments: args });
    expect(response.content).toEqual([
      {
        type: 'text',
        text: response.isError
          ? response.structuredContent.error?.message
          : JSON.stringify(response.structuredContent),
      },
    ]);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    return response;
  }
  return { rpc, result, ready, tool };
}

type ToolPage = {
  tools: Array<{
    name: string;
    inputSchema: {
      type: string;
      properties: Record<string, { default?: unknown }>;
      additionalProperties: boolean;
      required: string[];
    };
    outputSchema: { oneOf: unknown[] };
    annotations: Record<string, boolean>;
  }>;
  nextCursor?: string;
};

async function toolsOf(mcp: ReturnType<typeof fixture>) {
  const pageSizes: number[] = [];
  const tools: ToolPage['tools'] = [];
  let cursor: string | undefined;
  do {
    const page: ToolPage = await mcp.result('tools/list', cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    pageSizes.push(page.tools.length);
    cursor = page.nextCursor;
    if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pageSizes.length).toBeLessThan(6);
  } while (cursor !== undefined);
  return { tools, pageSizes };
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function api(
  route: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<URL> {
  const server = createServer((req, res) => {
    void Promise.resolve(route(req, res)).catch((error: unknown) => {
      json(res, { error: String(error) }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return new URL('http://127.0.0.1:' + address.port);
}

it('lists all tools and expanded schemas in fixed pages of eight', async () => {
  const mcp = fixture({ uploadRoot: await realpath(tmpdir()) });
  await mcp.ready();
  const { tools, pageSizes } = await toolsOf(mcp);
  expect(pageSizes).toEqual([8, 8, 8, 8, 2]);
  expect(tools.map((tool) => tool.name)).toEqual(names);
  expect(Object.keys(toolSchemas)).toEqual(names);

  const annotations = {
    R: [true, false, true, false],
    A: [false, false, false, false],
    M: [false, true, false, false],
    I: [false, true, true, false],
    E: [false, true, false, true],
    S: [false, false, true, false],
    C: [false, false, true, true],
  };
  for (const [index, tool] of tools.entries()) {
    expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    for (const key of tool.inputSchema.required)
      expect(Object.hasOwn(tool.inputSchema.properties, key)).toBe(true);
    expect(tool.outputSchema.oneOf).toHaveLength(2);
    const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = tool.annotations;
    expect([readOnlyHint, destructiveHint, idempotentHint, openWorldHint]).toEqual(
      annotations[hints[index] as keyof typeof annotations],
    );
    const invalid = await mcp.tool(tool.name.slice('railflow_'.length), { unknown: true });
    expect(invalid.structuredContent.error?.kind).toBe('usage');
  }
  expect(
    tools.find((tool) => tool.name === 'railflow_review_approve')?.inputSchema.required,
  ).toEqual(['jobId', 'stageKey', 'attempt', 'reviewSequence', 'receipt', 'exception', 'confirm']);
  for (const cursor of ['', '8', 'not a cursor!', 'OA==', Buffer.from('9').toString('base64url')]) {
    expect(await mcp.rpc('tools/list', { cursor })).toMatchObject({
      error: { code: -32602, message: 'Invalid cursor' },
    });
  }
});

it('hides upload tools without a configured root and treats them as unknown', async () => {
  const mcp = fixture();
  await mcp.ready();
  const { tools, pageSizes } = await toolsOf(mcp);
  expect(pageSizes).toEqual([8, 8, 8, 8]);
  expect(tools.map((tool) => tool.name)).toEqual(names.filter((_, i) => i !== 13 && i !== 14));
  for (const name of [names[13], names[14], 'railflow_missing', 'constructor']) {
    expect(await mcp.rpc('tools/call', { name })).toMatchObject({ error: { code: -32602 } });
  }
});

it('retries an uncertain commit only in the MCP session that created the upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railflow-mcp-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'data');
  let commits = 0;
  const server = await api(async (req, res) => {
    for await (const _ of req) {
      /* Drain upload body before responding. */
    }
    if (req.url === '/api/uploads') return json(res, { id: uploadId });
    if (req.url?.endsWith('/files?path=a.txt')) return json(res, { ok: true });
    if (req.url?.endsWith('/commit')) {
      if (++commits === 1) return req.socket.destroy() && undefined;
      return json(res, { job });
    }
    json(res, { error: 'Unexpected request' }, 404);
  });
  const mcp = fixture({ origin: server, uploadRoot: await realpath(root) });
  const other = fixture({ origin: server, uploadRoot: await realpath(root) });
  await mcp.ready();
  await other.ready();
  expect((await mcp.tool('upload_commit', { uploadId })).structuredContent.error?.kind).toBe(
    'usage',
  );
  const submitted = await mcp.tool('dataset_submit', { projectId: project.id, paths: ['a.txt'] });
  expect(submitted.structuredContent.error).toMatchObject({ kind: 'outcome_unknown', uploadId });
  expect((await other.tool('upload_commit', { uploadId })).structuredContent.error?.kind).toBe(
    'usage',
  );
  const replay = await mcp.tool('upload_commit', { uploadId });
  expect(replay.structuredContent).toMatchObject({
    ok: true,
    data: { uploadId, job: { id: jobId } },
  });
  expect(commits).toBe(2);
});

it('keeps a failed PUT ineligible for a session commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railflow-mcp-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'data');
  const routes: string[] = [];
  const server = await api(async (req, res) => {
    for await (const _ of req) {
      /* Drain request. */
    }
    routes.push(req.method + ' ' + req.url);
    if (req.method === 'PUT') {
      req.socket.destroy();
      return;
    }
    json(res, req.method === 'POST' ? { id: uploadId } : { ok: true });
  });
  const mcp = fixture({ origin: server, uploadRoot: await realpath(root) });
  await mcp.ready();
  expect(
    (await mcp.tool('dataset_submit', { projectId: project.id, paths: ['a.txt'] }))
      .structuredContent.error?.kind,
  ).toBe('outcome_unknown');
  expect((await mcp.tool('upload_commit', { uploadId })).structuredContent.error?.kind).toBe(
    'usage',
  );
  expect(routes).toEqual([
    'POST /api/uploads',
    'PUT /api/uploads/' + uploadId + '/files?path=a.txt',
    'DELETE /api/uploads/' + uploadId,
  ]);
});

it('fits project pages to the byte budget with the actual next offset', async () => {
  const projects = Array.from({ length: 20 }, (_, i) => ({
    ...project,
    id: 'proj-' + i,
    name: '界'.repeat(1250),
  }));
  const mcp = fixture({ origin: await api((_, res) => json(res, { projects })) });
  await mcp.ready();
  const { structuredContent } = await mcp.tool('projects_list', { offset: 2, limit: 20 });
  const data = structuredContent.data as {
    items: typeof projects;
    total: number;
    nextOffset: number;
  };
  expect(data.items.length).toBeGreaterThan(0);
  expect(data.items.length).toBeLessThan(18);
  expect(data.items[0].id).toBe('proj-2');
  expect(data.total).toBe(20);
  expect(data.nextOffset).toBe(2 + data.items.length);
});

it('returns CLI guidance for indivisible results beyond the byte budget', async () => {
  const mcp = fixture({
    origin: await api((_, res) =>
      json(res, { project: { ...project, purpose: '界'.repeat(12000) } }),
    ),
  });
  await mcp.ready();
  const response = await mcp.tool('project_get', { projectId: project.id });
  expect(response).toMatchObject({
    isError: true,
    structuredContent: {
      ok: false,
      error: { kind: 'limit', message: expect.stringContaining('railflow projects get') },
    },
  });
});

it('lists the exact resources and reads bounded log windows as JSON', async () => {
  const mcp = fixture({
    origin: await api((req, res) => {
      if (req.url === '/api/jobs/' + jobId + '/logs')
        res.writeHead(200, { 'content-type': 'text/plain' }).end('a'.repeat(5000));
      else json(res, { error: 'Missing' }, 404);
    }),
  });
  await mcp.ready();
  const resources = await mcp.result<{ resources: Array<{ uri: string }> }>('resources/list');
  expect(resources.resources.map(({ uri }) => uri)).toEqual([
    'railflow://projects',
    'railflow://queue',
    'railflow://templates',
  ]);
  const templates = await mcp.result<{ resourceTemplates: Array<{ uriTemplate: string }> }>(
    'resources/templates/list',
  );
  expect(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual([
    'railflow://projects/{projectId}',
    'railflow://projects/{projectId}/jobs',
    'railflow://jobs/{jobId}',
    'railflow://jobs/{jobId}/logs',
    'railflow://jobs/{jobId}/provenance',
    'railflow://jobs/{jobId}/artifacts',
  ]);
  const uri = 'railflow://jobs/' + jobId + '/logs';
  const {
    contents: [content],
  } = await mcp.result<{ contents: [{ uri: string; mimeType: string; text: string }] }>(
    'resources/read',
    { uri },
  );
  expect(content).toMatchObject({ uri, mimeType: 'application/json' });
  const logs = await mcp.tool('job_logs', { jobId });
  expect(JSON.parse(content.text)).toEqual(logs.structuredContent.data);
  expect(JSON.parse(content.text)).toMatchObject({ truncated: true, nextOffsetBytes: 4096 });
  expect(await mcp.rpc('resources/read', { uri: 'railflow://projects/missing' })).toMatchObject({
    error: { code: -32002 },
  });
  expect(await mcp.rpc('resources/read', { uri: 'railflow://jobs/run_00000000' })).toMatchObject({
    error: { code: -32002 },
  });
});

it('rejects noncanonical resource URIs before accessing the API', async () => {
  const mcp = fixture();
  await mcp.ready();
  for (const uri of [
    'railflow://projects?',
    'railflow://queue#',
    'railflow://projects:1234',
    'railflow://user@jobs/' + jobId,
    'railflow://projects/one%2ftwo',
    'railflow://projects/one%2Ftwo',
    'railflow://projects/one/jobs/extra',
    'railflow://projects/SAMPLE',
    'railflow://jobs/run_abc/logs',
    'railflow://queue/',
    'railflow://projects\n',
    'railflow://projects/./jobs',
  ]) {
    expect(await mcp.rpc('resources/read', { uri })).toMatchObject({ error: { code: -32602 } });
  }
});

it('rejects invalid approvals, forbidden workflow fields, and oversized log offsets locally', async () => {
  const mcp = fixture();
  await mcp.ready();
  const approve = { jobId, stageKey: 'inspect', attempt: 1, reviewSequence: 2 };
  for (const args of [
    { ...approve, receipt: 'r', exception: false },
    { ...approve, receipt: 'r', exception: false, confirm: false },
    { ...approve, receipt: 'r', confirm: true },
    { ...approve, receipt: 'r', confirm: true, exception: 'false' },
    { ...approve, confirm: true, exception: false },
    { ...approve, receipt: '', confirm: true, exception: false },
  ]) {
    expect((await mcp.tool('review_approve', args)).structuredContent.error?.kind).toBe('usage');
  }
  for (const field of ['id', 'inboxDir', 'artifactsDir', 'createdAt', 'updatedAt']) {
    expect(
      (
        await mcp.tool('workflow_set', {
          projectId: project.id,
          expectedUpdatedAt: 'now',
          definition: { [field]: 'secret' },
        })
      ).structuredContent.error?.kind,
    ).toBe('usage');
  }
  expect(
    (
      await mcp.tool('input_check', {
        projectId: project.id,
        name: 'a.txt',
        condition: { op: 'file.exists', pattern: '../secret' },
      })
    ).structuredContent.error?.kind,
  ).toBe('usage');
  expect(
    (await mcp.tool('job_logs', { jobId, offsetBytes: 1024 * 1024 + 1 })).structuredContent.error,
  ).toMatchObject({ kind: 'limit', message: expect.stringContaining('--out FILE') });
});

it('passes the exact approval target and explicit exception to the approval route', async () => {
  const ref = { jobId, stageKey: 'inspect__0123456789abcdef', attempt: 1, reviewSequence: 2 };
  const payloads: unknown[] = [];
  const mcp = fixture({
    origin: await api(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      payloads.push({
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      json(res, {
        ok: true,
        stageKey: ref.stageKey,
        attempt: ref.attempt,
        reviewSequence: ref.reviewSequence,
        exception: false,
      });
    }),
  });
  await mcp.ready();
  expect(
    (
      await mcp.tool('review_approve', {
        ...ref,
        receipt: 'receipt',
        confirm: true,
        exception: false,
      })
    ).structuredContent,
  ).toEqual({ ok: true, data: { ok: true, ref, exception: false } });
  expect(payloads).toEqual([
    {
      method: 'POST',
      url: '/api/jobs/' + jobId + '/approve-exact',
      body: {
        stage: ref.stageKey,
        attempt: 1,
        reviewSequence: 2,
        receipt: 'receipt',
        exception: false,
      },
    },
  ]);
});

it('reports a wait deadline as a successful observation', async () => {
  const mcp = fixture({
    origin: await api((req, res) => {
      if (req.url === '/api/jobs/' + jobId) json(res, { job });
      else res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
    }),
  });
  await mcp.ready();
  expect((await mcp.tool('job_wait', { jobId, timeoutMs: 100 })).structuredContent).toMatchObject({
    ok: true,
    data: { job: { id: jobId, status: 'running' }, reached: false, reason: 'timeout' },
  });
});

it('serves stdio metadata with an unreachable API and ignores an environment upload root', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const done = runMcp({
    argv: ['--server', origin.href, '--request-timeout-ms', '100'],
    env: { RAILFLOW_UPLOAD_ROOT: tmpdir() },
    input,
    output,
    stderr,
    signal: controller.signal,
    version: 'test',
  });
  const lines = output.setEncoding('utf8')[Symbol.asyncIterator]();
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }) + '\n',
  );
  expect(JSON.parse((await lines.next()).value)).toMatchObject({
    id: 1,
    result: { serverInfo: { name: 'railflow', version: 'test' } },
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (const [id, method, params, expected] of [
    [2, 'ping', {}, {}],
    [3, 'tools/list', {}, { tools: expect.any(Array) }],
    [4, 'resources/list', {}, { resources: expect.any(Array) }],
    [5, 'resources/templates/list', {}, { resourceTemplates: expect.any(Array) }],
    [6, 'tools/call', { name: 'railflow_health' }, { isError: true }],
  ]) {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    expect(JSON.parse((await lines.next()).value)).toMatchObject({ id, result: expected });
  }
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'railflow_dataset_submit' },
    }) + '\n',
  );
  expect(JSON.parse((await lines.next()).value)).toMatchObject({ error: { code: -32602 } });
  controller.abort();
  await done;
});

it('rejects a missing upload root before starting the stdio server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railflow-mcp-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await expect(
    runMcp({
      argv: ['--upload-root', join(root, 'missing')],
      input: new PassThrough(),
      output: new PassThrough(),
    }),
  ).rejects.toMatchObject({ kind: 'usage', message: expect.stringContaining('upload root') });
  await expect(runMcp({ argv: ['--upload-root', '.'] })).rejects.toMatchObject({ kind: 'usage' });
});

it('preserves byte offsets when an escaped log window reaches the result budget', async () => {
  const body = '\ufffd' + '\0'.repeat(8192) + 'end';
  const mcp = fixture({
    origin: await api((_, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(body);
    }),
  });
  await mcp.ready();
  const first = (await mcp.tool('job_logs', { jobId, maxBytes: 8192 })).structuredContent.data as {
    text: string;
    truncated: boolean;
    nextOffsetBytes: number;
  };
  expect(first.truncated).toBe(true);
  expect(first.nextOffsetBytes).toBe(Buffer.byteLength(first.text));
  expect(first.text.length).toBeLessThan(8192);
  let reconstructed = first.text;
  let offset: number | null = first.nextOffsetBytes;
  while (offset !== null) {
    const next = (await mcp.tool('job_logs', { jobId, offsetBytes: offset })).structuredContent
      .data as { text: string; offsetBytes: number; nextOffsetBytes: number | null };
    expect(next.offsetBytes).toBe(offset);
    expect(next.text.length).toBeGreaterThan(0);
    reconstructed += next.text;
    offset = next.nextOffsetBytes;
  }
  expect(reconstructed).toEqual(body);
});

it('includes the job when shrinking its nested page of stages', async () => {
  const stages = Array.from({ length: 40 }, (_, index) => ({
    key: 'stage_' + index,
    label: '長'.repeat(600),
    status: 'pending',
    attempts: 0,
  }));
  const mcp = fixture({ origin: await api((_, res) => json(res, { job: { ...job, stages } })) });
  await mcp.ready();
  const { structuredContent } = await mcp.tool('job_get', { jobId, offset: 1, limit: 30 });
  const data = structuredContent.data as {
    job: { id: string };
    stages: { items: typeof stages; total: number; nextOffset: number };
  };
  expect(data.job.id).toBe(jobId);
  expect(data.stages.items.length).toBeGreaterThan(0);
  expect(data.stages.items.length).toBeLessThan(30);
  expect(data.stages.items[0]).toEqual(stages[1]);
  expect(data.stages.nextOffset).toBe(data.stages.items.length + 1);
  expect(data.stages.total).toBe(40);
});

it('accepts a portable workflow patch that clears the graph', async () => {
  const bodies: unknown[] = [];
  const mcp = fixture({
    origin: await api(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      json(res, { project });
    }),
  });
  await mcp.ready();
  const response = await mcp.tool('workflow_set', {
    projectId: project.id,
    expectedUpdatedAt: project.updatedAt,
    definition: { graph: null },
  });
  expect(response.structuredContent).toMatchObject({
    ok: true,
    data: { project: { id: project.id } },
  });
  expect(bodies).toEqual([{ graph: null, expectedUpdatedAt: project.updatedAt }]);
});

it('reports oversized template exports, validation details, and provenance with their CLI commands', async () => {
  const source = exportTemplate(
    {
      ...project,
      purpose: '',
      acceptanceCriteria: '',
      inboxDir: '',
      artifactsDir: '',
      createdAt: 'now',
      llm: { model: '', effort: '' },
      stages: [
        {
          key: 'python',
          label: 'Python',
          short: 'Py',
          instruction: '',
          llm: { model: '', effort: '' },
          runner: { kind: 'python', code: '# ' + '界'.repeat(12000), args: [] },
        },
      ],
    },
    'Large workflow',
    '1',
  );
  const mcp = fixture({
    origin: await api((req, res) => {
      if (req.url === '/api/templates/validate')
        return json(res, { template: source, preview: { stages: 1, kinds: ['python'] } });
      if (req.url?.endsWith('/template')) return json(res, source);
      if (req.url?.endsWith('/provenance'))
        return json(res, {
          format: 'railflow.provenance',
          formatVersion: 1,
          exportedAt: 'now',
          complete: false,
          asOfSequence: 0,
          job: { ...job, file: '界'.repeat(12000) },
          metrics: {},
        });
      json(res, { error: 'Unexpected request' }, 404);
    }),
  });
  await mcp.ready();
  for (const [tool, args, command] of [
    [
      'template_export',
      { projectId: project.id },
      'railflow templates export PROJECT_ID --out FILE',
    ],
    ['template_validate', { template: source }, 'railflow templates validate --file FILE'],
    ['provenance_get', { jobId }, 'railflow jobs provenance JOB_ID --out FILE'],
  ] as const) {
    const result = await mcp.tool(tool, args);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { kind: 'limit', message: expect.stringContaining(command) },
      },
    });
  }
});

it('returns the exact review file head with a binary preview', async () => {
  const path = 'reports/export.pdf';
  const ref = { jobId, stageKey: 'inspect', attempt: 1, reviewSequence: 2 };
  const file = { path, bytes: 42 };
  const mcp = fixture({
    origin: await api((req, res) => {
      const url = new URL(req.url!, origin);
      if (url.pathname.endsWith('/review'))
        return json(res, {
          ...ref,
          receipt: 'receipt',
          summary: null,
          failureKind: null,
          files: [file],
          fileHashes: { [path]: 'a'.repeat(64) },
        });
      expect(url.pathname).toBe('/api/jobs/' + jobId + '/review/file');
      expect(url.searchParams.get('sequence')).toBe('2');
      expect(url.searchParams.get('path')).toBe(path);
      expect(url.searchParams.get('sha256')).toBe('a'.repeat(64));
      res
        .writeHead(200, { 'content-type': 'application/pdf', 'content-length': '42' })
        .end(Buffer.alloc(42));
    }),
  });
  await mcp.ready();
  const result = await mcp.tool('review_read', { ...ref, path });
  expect(result.structuredContent).toEqual({
    ok: true,
    data: { ref, file, preview: { binary: true, mimeType: 'application/pdf', bytes: 42 } },
  });
});

it('returns a job snapshot even when the deadline expires during the SSE handshake', async () => {
  const mcp = fixture({
    origin: await api((req, res) => {
      if (req.url === '/api/jobs/' + jobId) json(res, { job });
      // The /api/stream response sends no headers before the watch deadline.
    }),
  });
  await mcp.ready();
  expect((await mcp.tool('job_wait', { jobId, timeoutMs: 160 })).structuredContent).toMatchObject({
    ok: true,
    data: { job: { id: jobId }, reached: false, reason: 'timeout' },
  });
});

it('ends a wait without starting another GET when the first snapshot stalls', async () => {
  let reads = 0;
  const mcp = fixture({
    origin: await api((req, res) => {
      if (req.url === '/api/stream')
        res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      else reads++;
    }),
  });
  await mcp.ready();
  expect(
    (await mcp.tool('job_wait', { jobId, timeoutMs: 100 })).structuredContent.error?.kind,
  ).toBe('timeout');
  expect(reads).toBe(1);
});
