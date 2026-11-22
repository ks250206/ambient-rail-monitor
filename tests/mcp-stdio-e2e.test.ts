import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { ReviewInspection } from '../client/review.ts';
import type { FileHead, ListPage } from '../client/types.ts';
import { McpWireClient } from './mcp-wire-client.ts';
import { workflowFixture } from './workflow-fixture.ts';

const protocolVersion = '2025-11-25';
const uploadTools = ['railflow_dataset_submit', 'railflow_upload_commit'];

async function closedLoopbackOrigin() {
  const listener = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP port');
    return `http://127.0.0.1:${address.port}`;
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

function session(wire: McpWireClient) {
  let id = 0;
  async function result<T = unknown>(method: string, params?: object): Promise<T> {
    const requestId = ++id;
    const reply = await wire.request(requestId, method, params);
    if ('error' in reply) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    expect(reply.id).toBe(requestId);
    return reply.result as T;
  }
  async function call(name: string, args: object = {}) {
    return result<{
      isError?: boolean;
      structuredContent: { ok: true; data: unknown } | { ok: false; error: unknown };
      content: Array<{ type: string; text: string }>;
    }>('tools/call', { name, arguments: args });
  }
  async function tool<T = unknown>(name: string, args?: object): Promise<T> {
    const reply = await call(name, args);
    expect(reply.isError ?? false, JSON.stringify(reply.structuredContent)).toBe(false);
    expect(reply.structuredContent.ok).toBe(true);
    expect(reply.content).toEqual([
      { type: 'text', text: JSON.stringify(reply.structuredContent) },
    ]);
    if (!reply.structuredContent.ok) throw new Error(`${name} failed`);
    return reply.structuredContent.data as T;
  }
  async function listToolNames() {
    const seenCursors = new Set<string>();
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page: { tools: Array<{ name: string }>; nextCursor?: string } = await result(
        'tools/list',
        cursor === undefined ? undefined : { cursor },
      );
      expect(page.tools.length).toBeGreaterThan(0);
      names.push(...page.tools.map(({ name }) => name));
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        expect(cursor).toEqual(expect.any(String));
        expect(cursor).not.toBe('');
        expect(seenCursors.has(cursor)).toBe(false);
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    expect(seenCursors.size).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    return names;
  }
  async function resource(uri: string): Promise<unknown> {
    const { contents } = await result<{ contents: Array<{ text: string }> }>('resources/read', {
      uri,
    });
    expect(contents).toEqual([{ uri, mimeType: 'application/json', text: expect.any(String) }]);
    return JSON.parse(contents[0].text) as unknown;
  }
  return { result, call, tool, listToolNames, resource };
}

it('discovers the MCP catalog and resources over stdio while the API is offline', async () => {
  const wire = new McpWireClient('mcp.ts', ['--server', await closedLoopbackOrigin()]);
  try {
    expect(await wire.initialize()).toMatchObject({
      protocolVersion,
      serverInfo: { name: 'railflow' },
      capabilities: { tools: expect.any(Object), resources: expect.any(Object) },
    });
    const { result, call, listToolNames } = session(wire);
    expect(await result('ping')).toEqual({});
    const names = await listToolNames();
    expect(names).toHaveLength(32);
    expect(names).toContain('railflow_health');
    for (const name of uploadTools) expect(names).not.toContain(name);
    expect(await result('resources/list')).toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ uri: 'railflow://projects' }),
        expect.objectContaining({ uri: 'railflow://queue' }),
      ]),
    });
    expect(await result('resources/templates/list')).toMatchObject({
      resourceTemplates: expect.arrayContaining([
        expect.objectContaining({ uriTemplate: 'railflow://jobs/{jobId}' }),
        expect.objectContaining({ uriTemplate: 'railflow://jobs/{jobId}/logs' }),
      ]),
    });
    expect(await call('railflow_health')).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { kind: 'transport' } },
    });
  } finally {
    await wire.close();
  }
  expect(await wire.close()).toEqual({ exitCode: 0, stderr: '' });
});

it('negotiates the supported version, ignores notifications and recovers after malformed JSON', async () => {
  const wire = new McpWireClient('mcp.ts', ['--server', await closedLoopbackOrigin()]);
  try {
    expect(await wire.initialize('1900-01-01')).toMatchObject({ protocolVersion });
    wire.notify('notifications/unknown', { ignored: true });
    const malformed = wire.waitForResponse(null);
    wire.sendRaw('{"jsonrpc":broken}\n');
    expect(await malformed).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: expect.any(String) },
    });
    expect(await wire.request('after-parse-error', 'ping')).toEqual({
      jsonrpc: '2.0',
      id: 'after-parse-error',
      result: {},
    });
    const [ping, tools, anotherPing] = await Promise.all([
      wire.request(7, 'ping'),
      wire.request('7', 'tools/list'),
      wire.request(8, 'ping'),
    ]);
    expect(ping).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(tools).toEqual({
      jsonrpc: '2.0',
      id: '7',
      result: { tools: expect.any(Array), nextCursor: expect.any(String) },
    });
    expect(anotherPing).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
  } finally {
    await wire.close();
  }
  expect(await wire.close()).toEqual({ exitCode: 0, stderr: '' });
  expect(wire.stdoutLines).toHaveLength(6);
  expect(wire.stdout).toEqual(Buffer.from(wire.stdoutLines.join('\n') + '\n'));
});

it('rejects an oversized frame before a newline or EOF and exits cleanly', async () => {
  const wire = new McpWireClient('mcp.ts', ['--server', await closedLoopbackOrigin()]);
  try {
    await wire.initialize();
    const response = wire.waitForResponse(null);
    wire.sendRaw(Buffer.alloc(1024 * 1024 + 1, 0x61));
    expect(await response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: expect.any(String) },
    });
    await expect.poll(() => wire.exited, { timeout: 8_000, interval: 60 }).toBe(true);
  } finally {
    await wire.close();
  }
  expect(await wire.close()).toEqual({ exitCode: 0, stderr: '' });
});

it('submits, reviews and reads a live workflow over the supported MCP stdio entrypoints', async () => {
  const f = await workflowFixture();
  try {
    const projectId = 'mcp-e2e';
    const stageKey = 'publish';
    const report = '<!doctype html>\n<p>測定結果</p>\n';
    await f.json('/api/projects', {
      id: projectId,
      name: 'MCP reports',
      graph: { mode: 'dag', maxParallelTasks: 1, publishStage: stageKey },
      stages: [
        {
          key: stageKey,
          runner: {
            kind: 'command',
            program: process.execPath,
            args: [
              '-e',
              `require('node:fs').writeFileSync('report.html', ${JSON.stringify(report)})`,
            ],
          },
          gate: { requireReview: true },
        },
      ],
    });
    const root = join(f.home, 'uploads');
    await mkdir(join(root, 'dataset', 'samples'), { recursive: true });
    await writeFile(join(root, 'dataset', 'samples', 'run.csv'), 'x,y\n1,2\n');
    await writeFile(join(f.home, 'outside.csv'), 'outside root\n');

    const wire = new McpWireClient('mcp.ts', ['--server', f.url, '--upload-root', root]);
    try {
      await wire.initialize();
      const { call, tool, listToolNames, resource } = session(wire);
      const names = await listToolNames();
      expect(names).toHaveLength(34);
      expect(names).toEqual(expect.arrayContaining(uploadTools));
      expect(
        await call('railflow_dataset_submit', { projectId, paths: ['../outside.csv'] }),
      ).toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { kind: 'usage' } },
      });
      expect((await f.state()).jobs).toEqual([]);

      const submission = await tool<{ uploadId: string; job: { id: string } }>(
        'railflow_dataset_submit',
        { projectId, paths: ['dataset'] },
      );
      const jobId = submission.job.id;
      expect(submission).toMatchObject({
        uploadId: expect.any(String),
        job: { id: expect.stringMatching(/^run_[a-f0-9]{8}$/), projectId, status: 'queued' },
      });
      expect((await f.job(jobId)).dataset?.files.map(({ path }) => path)).toEqual([
        'samples/run.csv',
      ]);

      f.worker('process.exit(99)', { RAILFLOW_PROJECT: projectId });
      expect(
        await tool('railflow_job_wait', { jobId, until: 'attention', timeoutMs: 10_000 }),
      ).toMatchObject({ reason: 'review', reached: true, job: { id: jobId } });
      const review = await tool<Omit<ReviewInspection, 'files'> & { files: ListPage<FileHead> }>(
        'railflow_review_list',
        { jobId, stageKey },
      );
      expect(review.ref).toMatchObject({
        jobId,
        stageKey,
        attempt: 1,
        reviewSequence: expect.any(Number),
      });
      expect(review.receipt).toMatch(/^[a-f0-9]{64}$/);
      const file = { path: 'report.html', bytes: Buffer.byteLength(report) };
      expect(review.files.items).toContainEqual(file);
      expect(
        await tool('railflow_review_read', {
          ...review.ref,
          path: file.path,
          sha256: review.fileHashes![file.path],
        }),
      ).toEqual({
        ref: review.ref,
        file,
        preview: { text: report, offsetBytes: 0, nextOffsetBytes: null, truncated: false },
      });
      expect(
        await tool('railflow_review_approve', {
          ...review.ref,
          receipt: review.receipt,
          exception: false,
          confirm: true,
        }),
      ).toEqual({ ok: true, ref: review.ref, exception: false });
      expect(
        await tool('railflow_job_wait', { jobId, until: 'terminal', timeoutMs: 10_000 }),
      ).toMatchObject({ reason: 'done', reached: true, job: { id: jobId, status: 'done' } });

      const uri = `railflow://jobs/${jobId}`;
      expect(await resource('railflow://projects')).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: projectId, name: 'MCP reports' }),
        ]),
      });
      expect(await resource(uri)).toMatchObject({
        job: { id: jobId, projectId, status: 'done' },
        stages: { items: [expect.objectContaining({ key: stageKey, status: 'success' })] },
      });
      const logs = await fetch(`${f.url}/api/jobs/${jobId}/logs`);
      expect(logs.ok).toBe(true);
      expect(await resource(`${uri}/logs`)).toEqual({
        text: await logs.text(),
        offsetBytes: 0,
        nextOffsetBytes: null,
        truncated: false,
      });
      expect(await resource(`${uri}/artifacts`)).toEqual({
        items: [{ name: file.path, bytes: file.bytes }],
        total: 1,
        nextOffset: null,
      });
      expect(
        await wire.request('missing', 'resources/read', { uri: 'railflow://jobs/run_00000000' }),
      ).toMatchObject({ jsonrpc: '2.0', id: 'missing', error: { code: -32002 } });
    } finally {
      await wire.close();
    }
    expect(await wire.close()).toEqual({ exitCode: 0, stderr: '' });

    const viaCli = new McpWireClient('cli.ts', ['mcp', '--server', f.url]);
    try {
      expect(await viaCli.initialize()).toMatchObject({ protocolVersion });
      const { result, tool } = session(viaCli);
      expect(await result('ping')).toEqual({});
      expect(await tool('railflow_health')).toMatchObject({ reachable: true, origin: f.url });
    } finally {
      await viaCli.close();
    }
    expect(await viaCli.close()).toEqual({ exitCode: 0, stderr: '' });
  } finally {
    await f.close();
  }
});
