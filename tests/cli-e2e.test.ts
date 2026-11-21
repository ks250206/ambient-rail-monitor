import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { ReviewInspection } from '../client/review.ts';
import type { WorkflowTemplate } from '../shared/templates.ts';
import type { ProjectSpec, WorkflowJob } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

const projectId = 'cli-e2e';
const stageKey = 'publish';
const report = '<!doctype html>\n<p>測定レポート</p>\n';
const binary = Buffer.from([0, 10, 128, 255]);
const reportScript = [
  "const fs = require('node:fs');",
  `fs.writeFileSync('report.html', ${JSON.stringify(report)});`,
  `fs.writeFileSync('report.pptx', Buffer.from(${JSON.stringify([...binary])}));`,
].join('\n');

function startCli(server: string, args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['cli.ts', '--server', server, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 12_000,
    killSignal: 'SIGKILL',
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const stderr = () => Buffer.concat(errors).toString('utf8');
  let spawnError: Error | undefined;
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  child.once('error', (error) => {
    spawnError = error;
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer;
    stderr: string;
  }>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(output), stderr: stderr() });
    });
  });
  return {
    child,
    stderr,
    async result() {
      const result = await done;
      if (spawnError) throw spawnError;
      return result;
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    },
  };
}

function cliAt(server: string) {
  async function cli(args: string[], code = 0) {
    const running = startCli(server, args);
    try {
      const result = await running.result();
      expect(result, args.join(' ')).toMatchObject({ code, signal: null });
      return result;
    } finally {
      await running.close();
    }
  }
  async function json<T = unknown>(args: string[], code = 0): Promise<T> {
    const { stdout, stderr } = await cli([...args, '--json'], code);
    expect(stderr, args.join(' ')).toBe('');
    return JSON.parse(stdout.toString('utf8')) as T;
  }
  return { cli, json };
}

function reviewableProject(script = reportScript, requireReview = true) {
  return {
    id: projectId,
    name: 'CLI reports',
    graph: { mode: 'dag', maxParallelTasks: 1, publishStage: stageKey },
    stages: [
      {
        key: stageKey,
        label: 'Publish',
        runner: { kind: 'command', program: process.execPath, args: ['-e', script] },
        gate: { requireReview },
      },
    ],
  };
}

it('checks health and updates a project with optimistic concurrency', async () => {
  const f = await workflowFixture();
  try {
    const { cli, json } = cliAt(f.url);
    expect(await json(['health'])).toEqual({
      reachable: true,
      origin: f.url,
      latencyMs: expect.any(Number),
    });
    const created = await json<ProjectSpec>([
      'projects',
      'create',
      '--id',
      projectId,
      '--name',
      'New project',
    ]);
    expect(created).toMatchObject({ id: projectId, name: 'New project' });
    expect(await json(['projects', 'list'])).toContainEqual(
      expect.objectContaining({ id: projectId, updatedAt: created.updatedAt }),
    );

    const updatePath = join(f.home, 'update.json');
    const update = ['projects', 'update', projectId, '--file', updatePath, '--expected-updated-at'];
    await writeFile(updatePath, JSON.stringify({ name: 'Updated project' }));
    const updated = await json<ProjectSpec>([...update, created.updatedAt]);
    expect(updated).toMatchObject({ id: projectId, name: 'Updated project' });
    expect(updated.updatedAt).not.toBe(created.updatedAt);

    await writeFile(updatePath, JSON.stringify({ name: 'Stale change' }));
    const conflict = await cli([...update, created.updatedAt, '--json'], 5);
    expect(conflict.stdout).toHaveLength(0);
    expect(JSON.parse(conflict.stderr)).toMatchObject({ error: { kind: 'http', status: 409 } });
    expect(await json(['projects', 'get', projectId])).toEqual(updated);
    expect(await json(['projects', 'delete', projectId, '--yes'])).toMatchObject({ ok: true });
    expect(await json(['projects', 'list'])).not.toContainEqual(
      expect.objectContaining({ id: projectId }),
    );
  } finally {
    await f.close();
  }
});

it('submits a directory, approves the exact reviewed output and downloads published bytes', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', reviewableProject());
    const { cli, json } = cliAt(f.url);
    const input = join(f.home, 'selection');
    const csv = Buffer.from('x,y\r\n1,2\r\n');
    await mkdir(join(input, 'samples'), { recursive: true });
    await writeFile(join(input, 'samples', 'scan.csv'), csv);
    await writeFile(join(input, 'README.txt'), 'Sample data\n');
    const { job } = await json<{ job: WorkflowJob }>(['submit', input, '--project', projectId]);
    const id = job.id;
    expect(job).toMatchObject({ projectId, status: 'queued', workflow: { version: 2 } });
    expect(job.dataset?.files.map(({ path }) => path).sort()).toEqual([
      'README.txt',
      'samples/scan.csv',
    ]);
    expect(await readFile(join(f.home, 'data', 'inputs', id, 'samples', 'scan.csv'))).toEqual(csv);

    f.worker('process.exit(99)', { RAILFLOW_PROJECT: projectId });
    expect(
      await json(['jobs', 'wait', id, '--until', 'attention', '--timeout-ms', '10000'], 8),
    ).toMatchObject({
      reason: 'review',
      reached: true,
      job: { id, stages: [{ key: stageKey, status: 'review' }] },
    });
    const inspection = await json<ReviewInspection>(['review', 'list', id, '--stage', stageKey]);
    expect(inspection.ref).toMatchObject({
      jobId: id,
      stageKey,
      attempt: 1,
      reviewSequence: expect.any(Number),
    });
    expect(inspection.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(inspection.files).toEqual(
      expect.arrayContaining([
        { path: 'report.html', bytes: Buffer.byteLength(report) },
        { path: 'report.pptx', bytes: binary.length },
      ]),
    );
    const { ref, receipt } = inspection;
    const target = [
      id,
      '--stage',
      ref.stageKey,
      '--attempt',
      String(ref.attempt),
      '--sequence',
      String(ref.reviewSequence),
    ];
    for (const [name, bytes] of [
      ['report.html', Buffer.from(report)],
      ['report.pptx', binary],
    ] as const) {
      const result = await cli(['review', 'read', ...target, '--path', name]);
      expect(result.stdout).toEqual(bytes);
      expect(result.stderr).toBe('');
    }
    expect(await json(['review', 'approve', ...target, '--receipt', receipt!, '--yes'])).toEqual({
      ok: true,
      ref,
      exception: false,
    });
    expect(
      await json(['jobs', 'wait', id, '--until', 'terminal', '--timeout-ms', '10000']),
    ).toMatchObject({ reason: 'done', reached: true, job: { id, status: 'done' } });

    expect(await json(['artifacts', 'list', id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'report.html', bytes: Buffer.byteLength(report) }),
        expect.objectContaining({ name: 'report.pptx', bytes: binary.length }),
      ]),
    );
    const downloadPath = join(f.home, 'download.html');
    const download = ['artifacts', 'get', id, '--name', 'report.html', '--out', downloadPath];
    await cli(download);
    expect(await readFile(downloadPath)).toEqual(Buffer.from(report));
    const sentinel = Buffer.from('Keep this existing download\n');
    await writeFile(downloadPath, sentinel);
    await cli(download, 2);
    expect(await readFile(downloadPath)).toEqual(sentinel);

    const log = await cli(['jobs', 'logs', id, '--tail', '10']);
    const fullLog = await fetch(`${f.url}/api/jobs/${id}/logs`);
    expect(fullLog.ok).toBe(true);
    const lines = (await fullLog.text()).split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.length).toBeGreaterThan(10);
    expect(log.stdout.toString('utf8')).toBe(lines.slice(-10).join('\n') + '\n');
    expect(log.stderr).toBe('');

    const provenancePath = join(f.home, 'provenance.json');
    await cli(['jobs', 'provenance', id, '--out', provenancePath]);
    const raw = await readFile(provenancePath, 'utf8');
    const provenance = JSON.parse(raw) as { exportedAt: string };
    expect(provenance).toMatchObject({
      format: 'railflow.provenance',
      formatVersion: 1,
      complete: true,
      job: { id, status: 'done' },
      asOfSequence: expect.any(Number),
    });
    const response = await fetch(`${f.url}/api/jobs/${id}/provenance`);
    expect(response.ok).toBe(true);
    const serverBytes = await response.text();
    // Export time is generated independently on each request.
    expect(raw.replace(provenance.exportedAt, '<export time>')).toBe(
      serverBytes.replace(
        (JSON.parse(serverBytes) as typeof provenance).exportedAt,
        '<export time>',
      ),
    );
  } finally {
    await f.close();
  }
});

it('saves, exports, validates and deletes a template and persists queue limits', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', reviewableProject());
    const { json } = cliAt(f.url);
    const identity = ['--name', 'Report workflow', '--revision', '1'];
    const { template } = await json<{ template: WorkflowTemplate }>([
      'templates',
      'save',
      projectId,
      ...identity,
    ]);
    expect(template.template).toMatchObject({
      name: 'Report workflow',
      revision: '1',
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await json(['templates', 'list'])).toMatchObject({ saved: [template] });
    const file = join(f.home, 'template.json');
    await json(['templates', 'export', projectId, ...identity, '--out', file]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(template);
    expect(await json(['templates', 'validate', '--file', file])).toMatchObject({
      template,
      preview: { stages: 1, kinds: ['command'] },
      executionDetails: [
        {
          key: stageKey,
          kind: 'command',
          fields: [{ value: process.execPath }, { value: JSON.stringify(['-e', reportScript]) }],
        },
      ],
    });
    expect(
      await json(['templates', 'delete', ...identity, '--hash', template.template.hash, '--yes']),
    ).toMatchObject({ ok: true });
    expect(await json(['templates', 'list'])).toMatchObject({ saved: [] });

    expect(await json(['queue', 'get'])).toMatchObject({
      maxConcurrentJobs: 4,
      maxJobsPerWorker: 2,
      maxRecoveries: 3,
    });
    const settings = { maxConcurrentJobs: 2, maxJobsPerWorker: 1, maxRecoveries: 0 };
    expect(
      await json([
        'queue',
        'set',
        '--max-concurrent-jobs',
        '2',
        '--max-jobs-per-worker',
        '1',
        '--max-recoveries',
        '0',
      ]),
    ).toEqual(settings);
    expect(await json(['queue', 'get'])).toMatchObject(settings);
  } finally {
    await f.close();
  }
});

it('links a rerun to its parent and leaves the worker running after SIGINT interrupts the CLI wait', async () => {
  const f = await workflowFixture();
  try {
    const hold = join(f.home, 'hold-rerun');
    const runnerReady = join(f.home, 'rerun-ready');
    const script = `${reportScript}
const hold = ${JSON.stringify(hold)};
if (fs.existsSync(hold)) {
  fs.writeFileSync(${JSON.stringify(runnerReady)}, 'ready');
  const timer = setInterval(() => {
    if (!fs.existsSync(hold)) clearInterval(timer);
  }, 50);
}`;
    await f.json('/api/projects', reviewableProject(script, false));
    const { json } = cliAt(f.url);
    const file = join(f.home, 'input.csv');
    await writeFile(file, 'x\n1\n');
    const { job: parent } = await json<{ job: WorkflowJob }>([
      'submit',
      file,
      '--project',
      projectId,
    ]);
    f.worker('process.exit(99)', { RAILFLOW_PROJECT: projectId });
    await f.until(parent.id, 'done');

    expect(await json(['jobs', 'rerun', 'preview', parent.id, '--task', stageKey])).toEqual({
      rerun: [stageKey],
      reuse: [],
    });
    expect((await f.state()).jobs.map(({ id }) => id)).toEqual([parent.id]);
    await writeFile(hold, '');
    const { job: child } = await json<{ job: WorkflowJob }>([
      'jobs',
      'rerun',
      'execute',
      parent.id,
      '--task',
      stageKey,
    ]);
    expect(child.id).not.toBe(parent.id);
    expect(child.parentJobId).toBe(parent.id);
    expect(await f.until(child.id, 'running')).toMatchObject({ parentJobId: parent.id });
    await expect
      .poll(() => readFile(runnerReady, 'utf8').catch(() => ''), {
        timeout: 8_000,
        interval: 60,
      })
      .toBe('ready');

    const waiter = startCli(f.url, ['jobs', 'wait', child.id, '--json'], { NODE_DEBUG: 'http' });
    try {
      // Wait for a real HTTP response so SIGINT cannot race CLI startup.
      await expect
        .poll(waiter.stderr, { timeout: 8_000, interval: 60 })
        .toMatch(/HTTP \d+: AGENT incoming response!/);
      expect(waiter.child.kill('SIGINT')).toBe(true);
      const result = await waiter.result();
      expect(result).toMatchObject({ code: 130, signal: null, stdout: Buffer.alloc(0) });
      expect(result.stderr).toContain('"kind":"interrupted"');
      expect(await f.job(child.id)).toMatchObject({ status: 'running', parentJobId: parent.id });
    } finally {
      await waiter.close();
      await rm(hold, { force: true });
    }
    expect(await f.until(child.id, 'done')).toMatchObject({ parentJobId: parent.id });
  } finally {
    await f.close();
  }
});
