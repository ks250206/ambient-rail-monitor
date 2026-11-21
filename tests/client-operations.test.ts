import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vite-plus/test';
import { createClient } from '../client/http.ts';
import {
  createOperations,
  paginate,
  toJobHead,
  toProjectHead,
  toStageHead,
} from '../client/operations.ts';
import { readTailLines, readTextWindow, writeStreamToFile } from '../client/output.ts';
import { DEFAULT_QUEUE } from '../shared/queue.ts';
import { executionDetails } from '../shared/template-preview.ts';
import { exportTemplate } from '../shared/templates.ts';
import type { ProjectSpec } from '../shared/types.ts';

const project = {
  id: 'lab',
  name: 'Lab',
  updatedAt: '2026-01-02',
  createdAt: '2026-01-01',
  purpose: '',
  acceptanceCriteria: '',
  inboxDir: '/inbox',
  artifactsDir: '/artifacts',
  llm: { model: '', effort: '' },
  stages: [
    {
      key: 'analyze',
      label: 'Analyze',
      short: 'A',
      instruction: '',
      llm: { model: '', effort: '' },
      runner: { kind: 'command', program: 'node', args: ['a b'] },
    },
  ],
} satisfies ProjectSpec;
const input = { name: 'a.csv' };
const result = { status: 'pass', label: 'Input', message: 'OK' };
const candidate = {
  ...input,
  origin: 'project',
  kind: 'file',
  fileCount: 1,
  bytes: 5,
  status: 'waiting',
  message: '',
};
const template = exportTemplate(project, 'Example', 'r1');
const preview = { stages: 1, kinds: ['command'] };
const stages = [
  { key: 'analyze', label: 'Analyze', attempts: 0, status: 'pending' },
  {
    key: 'prepare',
    label: 'Prepare',
    attempts: 0,
    status: 'success',
    completion: { mode: 'reused' },
  },
];
const artifact = { name: '日本語 %.txt', uri: 'https://example.invalid/report', bytes: 6 };
const job = {
  id: 'run_12345678',
  projectId: project.id,
  file: input.name,
  status: 'queued',
  createdAt: '2026-01-02',
  artifacts: [artifact],
  events: [{ sequence: 42 }],
  stages,
};
const olderJob = {
  ...job,
  id: 'run_12345679',
  projectId: 'other',
  createdAt: '2026-01-01',
  status: 'done',
};
const queue = { ...DEFAULT_QUEUE, active: 0, workers: [] };
const state = { project, jobs: [job], candidates: [candidate], queue };
const allState = { ...state, jobs: [olderJob, job] };
const provenance = {
  format: 'railflow.provenance',
  formatVersion: 1,
  job,
  asOfSequence: 42,
  exportedAt: job.createdAt,
  complete: false,
  metrics: {},
};
const projectRoute = '/api/projects/lab';
const jobRoute = '/api/jobs/run_12345678';

type Reply = [
  method: string,
  url: string,
  body: unknown,
  response: unknown,
  mime?: string,
  status?: number | 'disconnect',
];
async function service(
  replies: Reply[],
  run: (
    ops: ReturnType<typeof createOperations>,
    json: ReturnType<typeof vi.fn>,
    origin: URL,
  ) => Promise<void>,
) {
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    received.push([req.method, req.url, raw ? JSON.parse(raw) : undefined]);
    const reply = replies[received.length - 1];
    if (!reply) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const [, , , response, mime, status = 200] = reply;
    if (status === 'disconnect') {
      req.socket.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': mime ?? 'application/json' });
    res.end(mime ? response : JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const origin = new URL(`http://127.0.0.1:${address.port}`);
  const client = createClient({ origin, requestTimeoutMs: 2000 });
  const json = vi.spyOn(client, 'json');
  try {
    await run(createOperations(client, { origin }), json, origin);
    expect(received).toEqual(replies.map(([method, url, body]) => [method, url, body]));
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

it('maps health, project CRUD, and workflow aliases to project routes', async () => {
  const body = { name: project.name, id: project.id, template };
  const definition = { name: 'Renamed' };
  const updated = { ...project, ...definition };
  const list: Reply = ['GET', '/api/projects', undefined, { projects: [project] }];
  const get: Reply = ['GET', projectRoute, undefined, { project }];
  const put: Reply = [
    'PUT',
    projectRoute,
    { ...definition, expectedUpdatedAt: project.updatedAt },
    { project: updated },
  ];
  await service(
    [
      list,
      list,
      get,
      ['POST', '/api/projects', body, { project }],
      put,
      get,
      put,
      ['DELETE', projectRoute, {}, { ok: true, projects: [] }],
    ],
    async (ops, _, origin) => {
      expect(await ops.health()).toEqual({
        origin: origin.origin,
        latencyMs: expect.any(Number),
        reachable: true,
      });
      expect(await ops.listProjects()).toEqual([project]);
      expect(await ops.getProject('lab')).toEqual(project);
      expect(await ops.createProject(body)).toEqual(project);
      expect(await ops.updateProject('lab', definition, project.updatedAt)).toEqual(updated);
      expect(await ops.getWorkflow('lab')).toEqual(project);
      expect(await ops.setWorkflow('lab', definition, project.updatedAt)).toEqual(updated);
      expect(await ops.deleteProject('lab')).toEqual({ ok: true, projectId: 'lab' });
    },
  );
});

it('maps template operations and exposes validated execution details', async () => {
  const identity = template.template;
  await service(
    [
      ['GET', '/api/templates', undefined, { builtins: [template], saved: [] }],
      ['GET', projectRoute + '/template?name=a+b%26c&revision=r%2F1', undefined, template],
      ['POST', '/api/templates/validate', { template }, { template, preview }],
      [
        'POST',
        '/api/templates',
        { projectId: 'lab', name: identity.name, revision: identity.revision },
        { template },
      ],
      ['DELETE', '/api/templates', identity, { ok: true }],
    ],
    async (ops, json) => {
      expect(await ops.listTemplates()).toEqual({ builtins: [template], saved: [] });
      expect(await ops.exportTemplate('lab', { name: 'a b&c', revision: 'r/1' })).toEqual(template);
      expect(await ops.validateTemplate(template)).toEqual({
        template,
        preview,
        executionDetails: executionDetails(template.definition.stages),
      });
      expect(json.mock.calls[2][3]).toMatchObject({ mutating: false });
      expect(await ops.saveTemplate('lab', identity.name, identity.revision)).toEqual({ template });
      expect(await ops.deleteTemplate(identity)).toEqual({ ok: true });
    },
  );
});

it('maps inputs, check-input defaults, demo, and queue settings', async () => {
  const condition = { op: 'file.exists', pattern: '*.csv' } as const;
  await service(
    [
      ['GET', '/api/state?project=lab', undefined, state],
      ['GET', projectRoute, undefined, { project: { ...project, input: { condition } } }],
      [
        'POST',
        projectRoute + '/check-input',
        { ...input, origin: 'project', condition },
        { result },
      ],
      ['POST', projectRoute + '/check-input', { ...input, condition: null }, { result }],
      ['POST', '/api/demo', { projectId: 'lab', review: true }, { job }],
      ['GET', '/api/state', undefined, state],
      ['PUT', '/api/queue', DEFAULT_QUEUE, { queue }],
    ],
    async (ops) => {
      expect(await ops.listInputs('lab')).toEqual([candidate]);
      expect(await ops.checkInput('lab', { ...input, origin: 'project' })).toEqual(result);
      expect(await ops.checkInput('lab', { ...input, condition: null })).toEqual(result);
      expect(await ops.createDemoJob('lab', true)).toMatchObject(job);
      expect(await ops.getQueue()).toEqual(queue);
      expect(await ops.setQueue(DEFAULT_QUEUE)).toEqual(DEFAULT_QUEUE);
    },
  );
});

it('rejects fallback project IDs, malformed health payloads, and out-of-range settings', async () => {
  await service(
    [
      ['GET', '/api/projects', undefined, { projects: {} }],
      ['GET', '/api/state?project=missing', undefined, state],
      ['GET', '/api/state?project=missing', undefined, state],
      ['GET', '/api/projects/missing', undefined, { project }],
    ],
    async (ops) => {
      await expect(ops.health()).rejects.toMatchObject({ kind: 'protocol' });
      await expect(ops.listInputs('missing')).rejects.toMatchObject({ kind: 'http', status: 404 });
      await expect(ops.listJobs({ projectId: 'missing' })).rejects.toMatchObject({
        kind: 'http',
        status: 404,
      });
      await expect(ops.getProject('missing')).rejects.toMatchObject({ kind: 'protocol' });
      await expect(ops.setQueue({ ...DEFAULT_QUEUE, maxConcurrentJobs: 33 })).rejects.toMatchObject(
        { kind: 'usage' },
      );
      await expect(ops.setJobPriority(job.id, -101)).rejects.toMatchObject({ kind: 'usage' });
    },
  );
});

it('maps job listing, controls, and rerun preview and execution', async () => {
  const rerun = { rerun: ['analyze'], reuse: ['prepare'] };
  const created = { ...job, id: 'run_87654321', parentJobId: job.id };
  await service(
    [
      ['GET', '/api/state', undefined, allState],
      ['GET', '/api/state?project=lab', undefined, state],
      ['GET', jobRoute, undefined, { job }],
      ['POST', jobRoute + '/pause', {}, { job }],
      ['POST', jobRoute + '/resume', {}, { job }],
      ['POST', jobRoute + '/cancel', {}, { job }],
      ['POST', jobRoute + '/priority', { priority: 5 }, { job }],
      ['POST', jobRoute + '/rerun', { task: 'analyze', preview: true }, rerun],
      ['POST', jobRoute + '/rerun', { task: 'analyze', preview: false }, { job: created }],
    ],
    async (ops, json) => {
      expect((await ops.listJobs()).map(({ id }) => id)).toEqual([job.id, olderJob.id]);
      expect(await ops.listJobs({ projectId: 'lab', status: 'done' })).toEqual([]);
      expect(await ops.getJob(job.id)).toMatchObject({ ...job, lastSequence: 42 });
      expect(await ops.pauseJob(job.id)).toMatchObject(job);
      expect(await ops.resumeJob(job.id)).toMatchObject(job);
      expect(await ops.cancelJob(job.id)).toMatchObject(job);
      expect(await ops.setJobPriority(job.id, 5)).toMatchObject(job);
      expect(await ops.previewRerun(job.id, 'analyze')).toEqual(rerun);
      expect(await ops.executeRerun(job.id, 'analyze')).toMatchObject({ ...rerun, job: created });
      expect(json.mock.calls.slice(-2).map((call) => call[3].mutating)).toEqual([false, true]);
    },
  );
});

it('streams logs, original provenance, and registered artifacts through same-origin routes', async () => {
  const raw = JSON.stringify(provenance, null, 2) + '\n';
  const get: Reply = ['GET', jobRoute, undefined, { job }];
  await service(
    [
      ['GET', jobRoute + '/logs', undefined, 'log\n', 'text/plain'],
      ['GET', jobRoute + '/provenance', undefined, provenance],
      ['GET', jobRoute + '/provenance', undefined, raw, 'application/json'],
      get,
      get,
      get,
      [
        'GET',
        '/artifacts/lab/run_12345678/' + encodeURIComponent(artifact.name),
        undefined,
        'report',
        'text/plain',
      ],
    ],
    async (ops) => {
      const read = async (stream: Readable) => (await stream.toArray()).map(String).join('');
      expect(await read((await ops.openJobLogs(job.id)).stream)).toBe('log\n');
      expect(await ops.getProvenance(job.id)).toEqual(provenance);
      expect(await read((await ops.openProvenance(job.id)).stream)).toBe(raw);
      expect(await ops.listArtifacts(job.id)).toEqual([artifact]);
      for (const name of ['../secret', '..', 'a\\b', '/b', ''])
        await expect(ops.openArtifact(job.id, name)).rejects.toMatchObject({ kind: 'usage' });
      await expect(ops.openArtifact(job.id, 'missing')).rejects.toMatchObject({ status: 404 });
      expect(await read((await ops.openArtifact(job.id, artifact.name)).stream)).toBe('report');
    },
  );
});

it('projects stable heads and paginates with explicit offsets', async () => {
  await service([['GET', jobRoute, undefined, { job }]], async (ops) => {
    const run = await ops.getJob(job.id);
    expect(toProjectHead(project)).toEqual({
      id: 'lab',
      name: 'Lab',
      updatedAt: project.updatedAt,
    });
    expect(toJobHead(run)).toEqual({
      id: run.id,
      projectId: 'lab',
      file: input.name,
      status: 'queued',
      createdAt: job.createdAt,
      lastSequence: 42,
    });
    expect(toStageHead(run.stages[0])).toEqual(stages[0]);
    expect(paginate([1, 2, 3], 1, 1)).toEqual({ items: [2], total: 3, nextOffset: 2 });
    expect(paginate([1, 2, 3], 5, 1)).toEqual({ items: [], total: 3, nextOffset: null });
  });
});

const textOptions = { contentType: 'text/plain', contentLength: null };

it('identifies failed HTTP operations, including streamed reads and unknown mutation outcomes', async () => {
  await service(
    [
      [
        'PUT',
        projectRoute,
        { name: 'Lab', expectedUpdatedAt: project.updatedAt },
        { error: 'Conflict' },
        undefined,
        409,
      ],
      [
        'POST',
        '/api/templates/validate',
        { template },
        { error: 'Unsupported media type' },
        undefined,
        415,
      ],
      [
        'POST',
        jobRoute + '/rerun',
        { task: 'analyze', preview: false },
        undefined,
        undefined,
        'disconnect',
      ],
      ['GET', jobRoute + '/logs', undefined, { error: 'Missing logs' }, undefined, 404],
    ],
    async (ops) => {
      await expect(
        ops.updateProject(project.id, { name: 'Lab' }, project.updatedAt),
      ).rejects.toMatchObject({
        kind: 'http',
        status: 409,
        operation: 'projects.update',
      });
      await expect(ops.validateTemplate(template)).rejects.toMatchObject({
        kind: 'http',
        status: 415,
        operation: 'templates.validate',
      });
      await expect(ops.executeRerun(job.id, 'analyze')).rejects.toMatchObject({
        kind: 'outcome_unknown',
        operation: 'rerun.execute',
        jobId: job.id,
      });
      await expect(ops.openJobLogs(job.id, { operation: 'caller-label' })).rejects.toMatchObject({
        kind: 'http',
        operation: 'jobs.logs',
        jobId: job.id,
      });
    },
  );
});

it.each([1, 2, 3])(
  'reports a limit when maxBytes %d cannot advance past a UTF-8 character',
  async (maxBytes) => {
    const stream = Readable.from(['a🚂']);
    await expect(
      readTextWindow(stream, { ...textOptions, offsetBytes: 1, maxBytes }),
    ).rejects.toMatchObject({ kind: 'limit' });
    expect(stream.destroyed).toBe(true);
    await expect(
      readTextWindow(Readable.from(['abcde']), { ...textOptions, maxBytes }),
    ).resolves.toMatchObject({ nextOffsetBytes: maxBytes });
  },
);

it('skips continuation bytes and resumes at an intact UTF-8 character', async () => {
  const chunks = Array.from(Buffer.from('a日😀z'), (byte) => Buffer.of(byte));
  expect(
    await readTextWindow(Readable.from(chunks), { ...textOptions, offsetBytes: 2, maxBytes: 4 }),
  ).toEqual({
    text: '😀',
    offsetBytes: 4,
    nextOffsetBytes: 8,
    truncated: true,
  });
  expect(await readTextWindow(Readable.from(chunks), { ...textOptions, maxBytes: 6 })).toEqual({
    text: 'a日',
    offsetBytes: 0,
    nextOffsetBytes: 4,
    truncated: true,
  });
  expect(
    await readTextWindow(Readable.from(chunks), { ...textOptions, offsetBytes: 4, maxBytes: 5 }),
  ).toEqual({
    text: '😀z',
    offsetBytes: 4,
    nextOffsetBytes: null,
    truncated: false,
  });
});

it('destroys streams that exceed the skip limit', async () => {
  const stream = Readable.from(['text']);
  await expect(
    readTextWindow(stream, { ...textOptions, offsetBytes: 1024 * 1024 + 1 }),
  ).rejects.toMatchObject({ kind: 'limit' });
  expect(stream.destroyed).toBe(true);
});

it.each([
  ['application/pdf', [Buffer.from('text')]],
  ['application/octet-stream', [Buffer.of(97), Buffer.of(0)]],
  ['application/x-unknown', [Buffer.of(0xe3), Buffer.of(0x21)]],
] as const)('identifies binary %s', async (contentType, chunks) => {
  const stream = Readable.from(chunks);
  expect(await readTextWindow(stream, { contentType, contentLength: 4 })).toEqual({
    binary: true,
    mimeType: contentType,
    bytes: 4,
  });
  expect(stream.destroyed).toBe(true);
});

it('sniffs valid UTF-8 in octet streams across chunk boundaries', async () => {
  const chunks = Array.from(Buffer.from('日'), (byte) => Buffer.of(byte));
  expect(
    await readTextWindow(Readable.from(chunks), {
      contentType: 'application/octet-stream',
      contentLength: null,
    }),
  ).toEqual({
    text: '日',
    offsetBytes: 0,
    nextOffsetBytes: null,
    truncated: false,
  });
});

it('keeps the last lines across chunks and bounds oversized lines', async () => {
  expect(await readTailLines(Readable.from(['old\r', '\n中', '\n\nlast\n']), 3)).toBe('中\n\nlast');
  expect(await readTailLines(Readable.from(['0123456789', '\nend']), 2, 4)).toBe('0123\nend');
  expect(await readTailLines(Readable.from([]), 2)).toBe('');
});

it('publishes complete files atomically and cleans up failed streams', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'railflow-output-'));
  const path = join(dir, 'result.txt');
  try {
    const attempts = await Promise.allSettled([
      writeStreamToFile(Readable.from(['hello']), path),
      writeStreamToFile(Readable.from(['hello']), path),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: { path, bytes: 5 } },
    ]);
    expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({
      reason: { kind: 'usage' },
    });
    await expect(writeStreamToFile(Readable.from(['new']), path)).rejects.toMatchObject({
      kind: 'usage',
    });
    expect(await readFile(path, 'utf8')).toBe('hello');
    const failing = Readable.from(
      (async function* () {
        yield 'partial';
        throw new Error('stream failed');
      })(),
    );
    await expect(writeStreamToFile(failing, join(dir, 'missing.txt'))).rejects.toThrow(
      'stream failed',
    );
    const cancelled = new Readable({
      read() {
        this.push('partial');
        this.destroy();
      },
    });
    await expect(writeStreamToFile(cancelled, join(dir, 'cancelled.txt'))).rejects.toMatchObject({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
    expect(await readdir(dir)).toEqual(['result.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('preserves the stream error when the temporary file disappears during a write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'railflow-output-'));
  const failure = new Error('source failed after temporary file was removed');
  try {
    const source = Readable.from(
      (async function* () {
        yield 'partial';
        await expect.poll(async () => (await readdir(dir)).length).toBe(1);
        const [temporary] = await readdir(dir);
        await unlink(join(dir, temporary));
        throw failure;
      })(),
    );
    await expect(writeStreamToFile(source, join(dir, 'result.txt'))).rejects.toBe(failure);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
