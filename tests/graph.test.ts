import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import { parseSchema, validateJson } from '../shared/contracts.ts';
import type { ClaimResponse, WorkflowJob } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

const command = (code: string) => ({
  kind: 'command',
  program: process.execPath,
  args: ['-e', `const fs=require('node:fs'),path=require('node:path');${code}`],
});
const graph = { mode: 'dag', maxParallelTasks: 2, publishStage: 'publish' };
const final = {
  key: 'publish',
  dependsOn: ['b', 'c'],
  runner: command(
    `const input=JSON.parse(fs.readFileSync(process.env.RAILFLOW_UPSTREAM_MANIFEST,'utf8'));const files=input.upstream.filter(x=>['b','c'].includes(x.stage)).map(x=>fs.readFileSync(path.join(x.directory,'metrics.json'),'utf8'));fs.writeFileSync('report.html',files.join(' + '));`,
  ),
};

it('runs diamond branches concurrently, gates the join, and selectively reruns one branch', async () => {
  const f = await workflowFixture();
  try {
    const stage = (key: string, dependsOn: string[]) => ({
      key,
      dependsOn,
      runner: command(
        `fs.appendFileSync(path.join(process.env.TEST_HOME,'calls'), '${key}\\n');setTimeout(()=>fs.writeFileSync('metrics.json',JSON.stringify({branch:'${key}'})),300);`,
      ),
    });
    await f.json('/api/projects', {
      id: 'diamond',
      name: 'Diamond',
      graph,
      stages: [stage('a', []), stage('b', ['a']), stage('c', ['a']), final],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'diamond' });
    expect(
      (await f.json<ClaimResponse>('/api/jobs/claim', { worker: 'old-worker' })).job,
    ).toBeNull();
    f.worker('process.exit(99)');
    const done = await f.until(job.id, 'done');
    const b = done.stages.find((task) => task.key === 'b')!,
      c = done.stages.find((task) => task.key === 'c')!;
    expect(Date.parse(b.startedAt!)).toBeLessThan(Date.parse(c.endedAt!));
    expect(Date.parse(c.startedAt!)).toBeLessThan(Date.parse(b.endedAt!));
    expect(done.stages.find((task) => task.key === 'publish')!.startedAt! >= b.endedAt!).toBe(true);
    expect(done.stages.every((task) => task.output?.hash)).toBe(true);
    expect(await (await fetch(f.url + done.artifacts[0].uri)).text()).toContain('"branch":"b"');
    const preview = await f.json<{ rerun: string[]; reuse: string[] }>(
      `/api/jobs/${job.id}/rerun`,
      { task: 'b', preview: true },
    );
    expect(preview).toEqual({ rerun: ['b', 'publish'], reuse: ['a', 'c'] });
    const originalEvents = done.events.length;
    const { job: rerun } = await f.json<{ job: WorkflowJob }>(`/api/jobs/${job.id}/rerun`, {
      task: 'b',
    });
    const next = await f.until(rerun.id, 'done');
    expect(next.parentJobId).toBe(job.id);
    expect(next.stages.map((task) => task.attempts)).toEqual([0, 1, 0, 1]);
    expect(
      next.stages.filter((task) => task.completion?.mode === 'reused').map((task) => task.key),
    ).toEqual(['a', 'c']);
    expect((await f.job(job.id)).events).toHaveLength(originalEvents);
    expect(
      readFileSync(path.join(f.home, 'calls'), 'utf8').split('\n').filter(Boolean).sort(),
    ).toEqual(['a', 'b', 'b', 'c']);
    expect(existsSync(path.join(f.home, 'calls.jsonl'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('maps same-basename files into isolated attempts and reduces only accepted results', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'map',
      name: 'Map',
      graph,
      execution: { retryDelayMs: 1 },
      stages: [
        {
          key: 'analysis',
          dependsOn: [],
          map: { pattern: '**/*.csv', maxItems: 5 },
          runner: command(
            `if(process.env.RAILFLOW_INPUT_ITEM.startsWith('B/')&&process.env.RAILFLOW_ATTEMPT==='1'){fs.writeFileSync('failed-only','bad');process.exit(1);}if(fs.existsSync('failed-only'))process.exit(9);const n=Number(fs.readFileSync(path.join(process.env.RAILFLOW_INPUT_DIR,process.env.RAILFLOW_INPUT_ITEM),'utf8'));fs.writeFileSync('metrics.json',JSON.stringify({value:n}));`,
          ),
          contracts: {
            inputs: [{ pattern: '**/*.csv', minFiles: 1, maxFiles: 1 }],
            outputs: [
              {
                pattern: 'metrics.json',
                schema: {
                  type: 'object',
                  required: ['value'],
                  properties: { value: { type: 'number' } },
                },
              },
            ],
          },
        },
        {
          key: 'publish',
          dependsOn: ['analysis'],
          runner: command(
            `const m=JSON.parse(fs.readFileSync(process.env.RAILFLOW_UPSTREAM_MANIFEST,'utf8'));const sum=m.upstream.reduce((n,x)=>n+JSON.parse(fs.readFileSync(path.join(x.directory,'metrics.json'),'utf8')).value,0);fs.writeFileSync('report.html',String(sum));`,
          ),
        },
      ],
    });
    const files = [
      { path: 'A/data.csv', bytes: 1 },
      { path: 'B/data.csv', bytes: 1 },
    ];
    const session = await f.json<{ id: string }>('/api/uploads', {
      projectId: 'map',
      name: 'measurements',
      kind: 'directory',
      files,
    });
    for (const [i, file] of files.entries())
      expect(
        (
          await fetch(
            `${f.url}/api/uploads/${session.id}/files?path=${encodeURIComponent(file.path)}`,
            { method: 'PUT', body: String(i + 2) },
          )
        ).ok,
      ).toBe(true);
    const { job } = await f.json<{ job: WorkflowJob }>(`/api/uploads/${session.id}/commit`);
    f.worker('process.exit(99)');
    const done = await f.until(job.id, 'done');
    expect(done.stages.map((task) => task.attempts)).toEqual([1, 2, 1]);
    expect(done.stages[0].key).not.toBe(done.stages[1].key);
    expect(done.stages[2].dependsOn).toHaveLength(2);
    expect(await (await fetch(f.url + done.artifacts[0].uri)).text()).toBe('5');
  } finally {
    await f.close();
  }
});

it('keeps independent work running while a human task awaits its exact approval', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'reviews',
      name: 'Reviews',
      graph,
      stages: [
        { key: 'human', dependsOn: [], runner: { kind: 'human' } },
        {
          key: 'slow',
          dependsOn: [],
          runner: command(`setTimeout(()=>fs.writeFileSync('value.json','{}'),1200);`),
          gate: { requireReview: true },
        },
        {
          key: 'publish',
          dependsOn: ['human', 'slow'],
          runner: command(`fs.writeFileSync('report.html','approved');`),
        },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'reviews' });
    f.worker('process.exit(99)');
    await expect.poll(async () => (await f.job(job.id)).stages[0].status).toBe('review');
    const running = await f.job(job.id);
    expect(running.status).toBe('running');
    const approval = {
      stage: 'human',
      attempt: 1,
      reviewSequence: running.stages[0].reviewSequence,
    };
    expect((await fetch(`${f.url}/api/jobs/${job.id}/review?task=human`)).ok).toBe(true);
    await f.json(`/api/jobs/${job.id}/approve`, approval);
    const review = await f.until(job.id, 'review');
    expect(review.stages[1].status).toBe('review');
    expect(
      (await f.response(`/api/jobs/${job.id}/approve`, { ...approval, stage: 'slow' })).status,
    ).toBe(409);
    await f.json(`/api/jobs/${job.id}/approve`, {
      stage: 'slow',
      attempt: 1,
      reviewSequence: review.stages[1].reviewSequence,
    });
    const done = await f.until(job.id, 'done');
    expect(done.stages.map((task) => task.attempts)).toEqual([1, 1, 1]);
  } finally {
    await f.close();
  }
});

it('resumes independent tasks while another branch remains under review', async () => {
  const f = await workflowFixture(undefined, { RAILFLOW_LEASE_MS: '1200' });
  try {
    await f.json('/api/projects', {
      id: 'pause-dag',
      name: 'Pause DAG',
      graph,
      stages: [
        { key: 'human', dependsOn: [], runner: { kind: 'human' } },
        {
          key: 'work',
          dependsOn: [],
          runner: command(
            `if(process.env.RAILFLOW_ATTEMPT==='1')setInterval(()=>{},1000);else fs.writeFileSync('result.json','{}');`,
          ),
        },
        {
          key: 'publish',
          dependsOn: ['human', 'work'],
          runner: command(`fs.writeFileSync('report.html','approved');`),
        },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'pause-dag' });
    f.worker('process.exit(99)');
    await expect.poll(async () => (await f.job(job.id)).stages[0].status).toBe('review');
    await f.json(`/api/jobs/${job.id}/pause`);
    await f.until(job.id, 'paused');
    await f.json(`/api/jobs/${job.id}/resume`);
    await expect
      .poll(async () => (await f.job(job.id)).stages[1].status, { timeout: 6000 })
      .toBe('success');
    const review = await f.until(job.id, 'review');
    expect(review.stages[0].attempts).toBe(1);
    expect(review.stages[1].attempts).toBe(2);
  } finally {
    await f.close();
  }
});

it('does not roll completed tasks back when an older status response arrives late', async () => {
  const f = await workflowFixture();
  let delayed = false;
  const proxy = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const upstream = await fetch(f.url + req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      ...(req.method === 'GET' ? {} : { body: Buffer.concat(parts) }),
    });
    const body = await upstream.text();
    if (req.method === 'GET' && (req.url ?? '').startsWith('/api/jobs/run_')) {
      const snapshot = JSON.parse(body) as { job: WorkflowJob };
      if (snapshot.job.stages[0].status === 'running' && !delayed) {
        delayed = true;
        await expect
          .poll(async () => (await f.job(snapshot.job.id)).stages[0].status)
          .toBe('success');
      }
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(body);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    await f.json('/api/projects', {
      id: 'stale',
      name: 'Stale snapshot',
      graph,
      stages: [
        {
          key: 'publish',
          dependsOn: [],
          runner: command(`setTimeout(()=>fs.writeFileSync('report.html','done'),650);`),
        },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'stale' });
    const address = proxy.address();
    f.worker('process.exit(99)', {
      RAILFLOW_URL: `http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}`,
    });
    const done = await f.until(job.id, 'done');
    expect(delayed).toBe(true);
    expect(done.stages[0].attempts).toBe(1);
  } finally {
    await f.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

it('rejects cycles, unknown dependencies, premature starts and unsupported schemas', async () => {
  const f = await workflowFixture();
  try {
    for (const stages of [
      [
        { key: 'a', dependsOn: ['publish'] },
        { key: 'publish', dependsOn: ['a'] },
      ],
      [{ key: 'publish', dependsOn: ['missing'] }],
    ]) {
      expect((await f.response('/api/projects', { name: 'Invalid', graph, stages })).status).toBe(
        400,
      );
    }
    await f.json('/api/projects', {
      id: 'guards',
      name: 'Guards',
      graph,
      stages: [
        { key: 'a', dependsOn: [] },
        { key: 'publish', dependsOn: ['a'] },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'guards' });
    const claim = await f.json<ClaimResponse>('/api/jobs/claim', { protocol: 2 });
    expect(
      (
        await f.response(`/api/jobs/${job.id}/events`, {
          type: 'stage.started',
          stage: 'publish',
          attempt: 1,
          leaseToken: claim.lease!.token,
        })
      ).status,
    ).toBe(409);
    expect(() => parseSchema({ type: 'string', pattern: '(a+)+$' })).toThrow('未対応');
    expect(
      validateJson(
        { value: '2' },
        parseSchema({
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'number' } },
        }),
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('fails only the affected job when a crashed review attempt has no recoverable workspace', async () => {
  const f = await workflowFixture(undefined, { RAILFLOW_LEASE_MS: '1000' });
  try {
    await f.json('/api/projects', {
      id: 'missing',
      name: 'Missing workspace',
      graph,
      execution: { maxRetries: 0, onFailure: 'review' },
      stages: [{ key: 'publish', dependsOn: [] }],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'missing' });
    const claim = await f.json<ClaimResponse>('/api/jobs/claim', { protocol: 2 });
    for (const type of ['stage.started', 'stage.failed'])
      await f.json(`/api/jobs/${job.id}/events`, {
        type,
        stage: 'publish',
        attempt: 1,
        workspace: '.attempts/publish/1',
        leaseToken: claim.lease!.token,
        ...(type === 'stage.failed' ? { failureKind: 'execution_error' } : {}),
      });
    const failed = await f.until(job.id, 'failed');
    expect(failed.lastMessage).toContain('復旧時の出力を検証できません');
    expect((await fetch(f.url + '/api/state')).ok).toBe(true);
  } finally {
    await f.close();
  }
});

it('executes Python and HTTP stages with stable idempotency keys across retry', async () => {
  const keys: string[] = [];
  const api = http.createServer((req, res) => {
    keys.push(String(req.headers['idempotency-key']));
    res.writeHead(keys.length === 1 ? 503 : 200, { 'content-type': 'application/json' });
    res.end('{"value":7}');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'typed',
      name: 'Typed',
      graph,
      execution: { retryDelayMs: 1 },
      stages: [
        {
          key: 'http',
          dependsOn: [],
          runner: {
            kind: 'http',
            method: 'POST',
            url: `http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}`,
            output: 'response.json',
            idempotencyKey: true,
          },
          contracts: {
            outputs: [
              { pattern: 'response.json', schema: { type: 'object', required: ['value'] } },
            ],
          },
        },
        {
          key: 'publish',
          dependsOn: ['http'],
          runner: {
            kind: 'python',
            code: 'import json, os\nfrom pathlib import Path\nm = json.loads(Path(os.environ["RAILFLOW_UPSTREAM_MANIFEST"]).read_text())\nx = json.loads((Path(m["upstream"][0]["directory"]) / "response.json").read_text())\nPath("report.html").write_text(str(x["value"]))\n',
          },
        },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'typed' });
    f.worker('process.exit(99)');
    const done = await f.until(job.id, 'done');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(await (await fetch(f.url + done.artifacts[0].uri)).text()).toBe('7');
  } finally {
    await f.close();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

it('fails wrong output types before publication and stops parallel tasks at the shared job deadline', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'schema',
      name: 'Schema',
      graph,
      execution: { maxRetries: 0 },
      stages: [
        {
          key: 'publish',
          dependsOn: [],
          runner: command(
            `fs.writeFileSync('report.html','bad');fs.writeFileSync('metrics.json','{"value":"wrong"}');`,
          ),
          contracts: {
            outputs: [
              {
                pattern: 'metrics.json',
                schema: {
                  type: 'object',
                  required: ['value'],
                  properties: { value: { type: 'number' } },
                },
              },
            ],
          },
        },
      ],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'schema' });
    f.worker('process.exit(99)');
    const failed = await f.until(job.id, 'failed');
    expect(failed.stages[0].failureKind).toBe('acceptance_failed');
    expect(failed.artifacts).toEqual([]);
    await f.json('/api/projects', {
      id: 'deadline',
      name: 'Deadline',
      graph,
      jobTimeoutMs: 500,
      stages: [
        { key: 'b', dependsOn: [], runner: command('setInterval(()=>{},1000);') },
        { key: 'c', dependsOn: [], runner: command('setInterval(()=>{},1000);') },
        final,
      ],
    });
    const { job: timed } = await f.json<{ job: WorkflowJob }>('/api/demo', {
      projectId: 'deadline',
    });
    const timeout = await f.until(timed.id, 'failed');
    expect(timeout.events.findLast((event) => event.type === 'job.failed')!.failureKind).toBe(
      'job_timeout',
    );
    expect(timeout.stages.filter((task) => task.status === 'running')).toEqual([]);
    expect(timeout.activeMs).toBeGreaterThanOrEqual(400);
  } finally {
    await f.close();
  }
});

it('blocks cross-origin/non-JSON CSRF attempts, detects added unreviewed files, blocks self-API SSRF, and preserves sibling branches on stage_timeout', async () => {
  const { outputManifest, verifyOutput } = await import('../shared/task-files.ts');
  const { inventory } = await import('../shared/datasets.ts');
  const f = await workflowFixture();
  try {
    // 1. CSRF / Content-Type / Origin / Host guards reject drive-by requests.
    const textPlain = await fetch(f.url + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id: 'csrf', name: 'CSRF' }),
    });
    expect(textPlain.status).toBe(415);

    const crossOrigin = await fetch(f.url + '/api/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ id: 'csrf', name: 'CSRF' }),
    });
    expect(crossOrigin.status).toBe(403);

    const crossSiteFetch = await fetch(f.url + '/api/demo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({}),
    });
    expect(crossSiteFetch.status).toBe(403);

    // 2. verifyOutput rejects newly added files (and empty-manifest tampering).
    const dir = path.join(f.home, 'verify-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'report.html'), '<h1>ok</h1>');
    const manifest = outputManifest(inventory(dir, undefined, true));
    expect(verifyOutput(dir, manifest, { excludeInternal: true })).toBe(true);
    writeFileSync(path.join(dir, 'report.pptx'), 'unreviewed');
    expect(verifyOutput(dir, manifest, { excludeInternal: true })).toBe(false);

    const emptyDir = path.join(f.home, 'empty-test');
    mkdirSync(emptyDir, { recursive: true });
    const emptyManifest = outputManifest(inventory(emptyDir, undefined, true));
    expect(verifyOutput(emptyDir, emptyManifest)).toBe(true);
    writeFileSync(path.join(emptyDir, 'forged.json'), '{}');
    expect(verifyOutput(emptyDir, emptyManifest)).toBe(false);

    // 3. HTTP stage cannot call Railflow's own control API (SSRF defense).
    await f.json('/api/projects', {
      id: 'ssrf',
      name: 'SSRF',
      graph: { mode: 'dag', maxParallelTasks: 2, publishStage: 'call' },
      execution: { maxRetries: 0 },
      stages: [
        {
          key: 'call',
          dependsOn: [],
          runner: {
            kind: 'http',
            method: 'GET',
            url: `${f.url}/api/projects`,
            body: '',
            output: 'response.json',
            successStatus: 200,
            idempotencyKey: false,
          },
        },
      ],
    });
    const { job: ssrfJob } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'ssrf' });
    f.worker('process.exit(99)');
    const ssrfFailed = await f.until(ssrfJob.id, 'failed');
    expect(ssrfFailed.stages[0].status).toBe('failed');
    expect(ssrfFailed.artifacts).toEqual([]);

    // 4. stage_timeout retry budget exhaustion does not abort independent sibling branches.
    await f.json('/api/projects', {
      id: 'branch-budget',
      name: 'Branch Budget',
      graph: { mode: 'dag', maxParallelTasks: 2, publishStage: 'publish' },
      execution: { maxRetries: 2, retryDelayMs: 500, stageTimeoutMs: 250 },
      stages: [
        {
          key: 'b',
          dependsOn: [],
          runner: command('process.exit(1);'),
        },
        {
          key: 'c',
          dependsOn: [],
          execution: { maxRetries: 0, stageTimeoutMs: 5000 },
          runner: command(
            `setTimeout(()=>{fs.writeFileSync('ok.txt','survived');process.exit(0);}, 350);`,
          ),
        },
        final,
      ],
    });
    const { job: branchJob } = await f.json<{ job: WorkflowJob }>('/api/demo', {
      projectId: 'branch-budget',
    });
    const branchResult = await f.until(branchJob.id, 'failed');
    expect(branchResult.stages.find((task) => task.key === 'b')?.status).toBe('failed');
    expect(branchResult.stages.find((task) => task.key === 'c')?.status).toBe('success');
  } finally {
    await f.close();
  }
});

it('fails a recovered task whose stage budget was spent by a crash instead of looping', async () => {
  const f = await workflowFixture(undefined, { RAILFLOW_LEASE_MS: '1000' });
  try {
    await f.json('/api/projects', {
      id: 'spent',
      name: 'Spent budget',
      graph: { mode: 'dag', maxParallelTasks: 2, publishStage: 'publish' },
      execution: { maxRetries: 0, stageTimeoutMs: 300 },
      stages: [{ key: 'publish', dependsOn: [], runner: command(`process.exit(0);`) }],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'spent' });
    // A worker starts the attempt and dies without heartbeats; the expired lease
    // charges the elapsed time (> stageTimeoutMs) and requeues the task as pending.
    const claim = await f.json<ClaimResponse>('/api/jobs/claim', { protocol: 2 });
    await f.json(`/api/jobs/${job.id}/events`, {
      type: 'stage.started',
      stage: 'publish',
      attempt: 1,
      workspace: '.attempts/publish/1',
      leaseToken: claim.lease!.token,
    });
    await f.until(job.id, 'queued');
    f.worker('process.exit(99)');
    const failed = await f.until(job.id, 'failed');
    const task = failed.stages[0];
    expect(task.status).toBe('failed');
    expect(task.failureKind).toBe('stage_timeout');
    expect(task.attempts).toBe(1);
    expect(
      failed.events.filter((event) => event.type === 'stage.started' && event.stage === 'publish'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('accepts extra Host names only when listed in RAILFLOW_ALLOWED_HOSTS', async () => {
  const f = await workflowFixture(undefined, { RAILFLOW_ALLOWED_HOSTS: 'railflow.lan, *.evil' });
  const port = new URL(f.url).port;
  const statusFor = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = http.get({
        host: '127.0.0.1',
        port,
        path: '/api/projects',
        headers: { host },
      });
      request.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
    });
  try {
    expect(await statusFor(`railflow.lan:${port}`)).toBe(200);
    expect(await statusFor(`RAILFLOW.LAN:${port}`)).toBe(200);
    expect(await statusFor(`attacker.example:${port}`)).toBe(403);
    expect(await statusFor(`x.evil:${port}`)).toBe(403);
  } finally {
    await f.close();
  }
});
