import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vite-plus/test';
import type { AppStateResponse, ClaimResponse, WorkflowJob } from '../shared/types.ts';

async function startServer(home: string) {
  const server = spawn(process.execPath, ['server.ts'], {
    env: { ...process.env, RAILFLOW_HOME: home, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exit = once(server, 'exit');
  const lines = createInterface({ input: server.stdout });
  const [line] = await once(lines, 'line');
  const url = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)![0];
  async function post<T>(route: string, body: unknown = {}) {
    const res = await fetch(url + route, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.ok).toBe(true);
    return res.json() as Promise<T>;
  }
  async function jobs() {
    const state = (await (await fetch(url + '/api/state')).json()) as AppStateResponse;
    return state.jobs;
  }
  return {
    url,
    post,
    jobs,
    close: async () => {
      lines.close();
      server.kill();
      await exit;
    },
  };
}

it('restores the legacy stages and workspace and claims the original bytes for identically named inputs', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-input-'));
  const id = 'run_12345678';
  const work = path.join(home, 'work', id);
  const data = path.join(home, 'data');
  const oldInbox = path.join(home, 'inbox');
  const inbox = path.join(home, 'projects/default/inbox');
  for (const dir of [work, data, oldInbox, inbox]) mkdirSync(dir, { recursive: true });
  const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
  const legacy = 'x,y\n0,7\n';
  writeFileSync(path.join(work, '03_analysis.md'), 'previous result');
  writeFileSync(path.join(oldInbox, 'sample.csv'), legacy);
  writeFileSync(path.join(inbox, 'sample.csv'), 'x,y\n0,9\n');
  writeFileSync(
    path.join(data, 'projects.json'),
    JSON.stringify([
      { id: 'default', name: 'Edited', stages: [{ key: 'publish', label: 'Report' }] },
    ]),
  );
  const events = [
    { type: 'job.created', file: 'sample.csv', hash: hash(legacy), needsReview: true },
    { type: 'stage.succeeded', stage: 'analysis' },
    { type: 'review.required', stage: 'validate' },
  ];
  writeFileSync(
    path.join(data, 'events.jsonl'),
    events
      .map((e, i) =>
        JSON.stringify({ ...e, jobId: id, sequence: i + 1, at: '2026-01-01T00:00:00Z' }),
      )
      .join('\n') + '\n',
  );
  const server = await startServer(home);
  try {
    await expect.poll(async () => (await server.jobs()).length, { timeout: 8000 }).toBe(2);
    // Replace the newer inbox file after registration. Both claims must still match their events.
    writeFileSync(path.join(inbox, 'sample.csv'), 'x,y\n0,13\n');
    await server.post('/api/jobs/' + id + '/approve');
    const old = await server.post<ClaimResponse>('/api/jobs/claim');
    expect(old.job?.id).toBe(id);
    expect(old.job?.stages.map((s) => s.key)).toEqual([
      'ingest',
      'preprocess',
      'analysis',
      'validate',
      'visualize',
      'publish',
    ]);
    expect(old.job?.stages.find((s) => s.key === 'analysis')?.status).toBe('success');
    expect(readFileSync(path.join(old.paths!.work, '03_analysis.md'), 'utf8')).toBe(
      'previous result',
    );
    const next = await server.post<ClaimResponse>('/api/jobs/claim');
    expect(next.job?.id).not.toBe(id);
    for (const claim of [old, next])
      expect(hash(readFileSync(claim.paths!.input))).toBe(claim.job!.hash);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32').each([
  ['publish', 'validate', 'analysis'],
  ['publish', 'validate'],
])(
  'holds final reports until the review is approved (%s → %s)',
  async (...keys) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-gate-'));
    const server = await startServer(home);
    writeFileSync(
      path.join(home, 'codex'),
      `#!/usr/bin/env node
const fs=require('node:fs');
const prompt=process.argv.at(-1);
const stage=prompt.match(/running stage "([^"]+)"/)[1];
if(stage==='publish') fs.writeFileSync('report.html','draft');
if(stage==='${keys.at(-1)}' && prompt.includes('Create a self-contained report.html')) fs.writeFileSync('report.html','reviewed final report');
`,
      { mode: 0o755 },
    );
    const projectId = 'reordered';
    const worker = spawn(
      process.execPath,
      ['worker.ts', '--mode=codex', '--project=' + projectId],
      {
        env: {
          ...process.env,
          RAILFLOW_URL: server.url,
          PATH: home + path.delimiter + process.env.PATH,
        },
        stdio: 'ignore',
      },
    );
    const exit = once(worker, 'exit');
    try {
      await server.post('/api/projects', {
        id: projectId,
        name: 'Reordered',
        stages: keys.map((key) => ({ key, label: key })),
      });
      const { job } = await server.post<{ job: WorkflowJob }>('/api/demo', {
        projectId,
        review: true,
      });
      const url = server.url + '/artifacts/' + projectId + '/' + job.id + '/report.html';
      const current = async () => (await server.jobs())[0];
      await expect.poll(async () => (await current()).status, { timeout: 8000 }).toBe('review');
      expect((await current()).artifacts).toEqual([]);
      expect((await fetch(url)).status).toBe(404);
      await server.post('/api/jobs/' + job.id + '/approve');
      await expect.poll(async () => (await current()).status, { timeout: 8000 }).toBe('done');
      expect(await (await fetch(url)).text()).toBe('reviewed final report');
      expect((await current()).stages.map((s) => s.attempts)).toEqual(keys.map(() => 1));
    } finally {
      worker.kill();
      await exit;
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
  15000,
);
