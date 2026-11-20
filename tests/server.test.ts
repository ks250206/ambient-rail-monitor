import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import type { AppStateResponse, ClaimResponse, ProjectSpec, WorkflowJob } from '../shared/types.ts';
import { actionSeconds, axisTime, bytes, getSpans } from '../src/utils/workflow.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Retry until timeout.
    }
    await sleep(90);
  }
  throw new Error('Timed out');
}

describe('workflow helpers', () => {
  it('formats durations and byte sizes deterministically', () => {
    expect(actionSeconds(65)).toBe('01m 05s');
    expect(actionSeconds(3661)).toBe('1h 01m 01s');
    expect(axisTime(45)).toBe('45s');
    expect(axisTime(120)).toBe('2m');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(2500)).toBe('2.5 KB');
  });

  it('reconstructs attempt spans from stage events', () => {
    const job: WorkflowJob = {
      id: 'run_12345678',
      projectId: 'default',
      file: 'sample.csv',
      bytes: 128,
      hash: 'abc',
      createdAt: '2026-11-20T00:00:00.000Z',
      demo: true,
      needsReview: false,
      status: 'done',
      agent: 'demo',
      worker: 'host-1',
      startedAt: '2026-11-20T00:00:01.000Z',
      finishedAt: '2026-11-20T00:00:10.000Z',
      stages: [],
      artifacts: [],
      reviewApproved: false,
      lastMessage: 'done',
      events: [
        {
          type: 'stage.started',
          jobId: 'run_12345678',
          stage: 'analysis',
          at: '2026-11-20T00:00:02.000Z',
          sequence: 1,
        },
        {
          type: 'stage.failed',
          jobId: 'run_12345678',
          stage: 'analysis',
          at: '2026-11-20T00:00:04.000Z',
          sequence: 2,
        },
        {
          type: 'stage.started',
          jobId: 'run_12345678',
          stage: 'analysis',
          at: '2026-11-20T00:00:05.000Z',
          sequence: 3,
        },
        {
          type: 'stage.succeeded',
          jobId: 'run_12345678',
          stage: 'analysis',
          at: '2026-11-20T00:00:09.000Z',
          sequence: 4,
        },
      ],
    };

    const spans = getSpans(job);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ stage: 'analysis', attempt: 1, status: 'failed' });
    expect(spans[1]).toMatchObject({ stage: 'analysis', attempt: 2, status: 'success' });
  });
});

describe('API integration', () => {
  it('supports multiple projects, custom stage counts, project-scoped inbox/artifacts, summaries, review & replay', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'railflow-test-'));
    const port = 30_000 + Math.floor(Math.random() * 25_000);
    const api = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, ['server.ts'], {
      cwd: root,
      env: { ...process.env, RAILFLOW_HOME: temp, PORT: String(port) },
      stdio: 'ignore',
    });

    const post = async <T>(route: string, body: unknown = {}) => {
      const response = await fetch(api + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as T };
    };

    try {
      await until(async () => {
        const res = await fetch(`${api}/api/state`);
        return res.ok;
      });

      // Create a second project with a custom 3-stage workflow and separate inbox/artifacts.
      const createProj = await post<{ project: ProjectSpec; projects: ProjectSpec[] }>(
        '/api/projects',
        {
          id: 'xrd-lab',
          name: 'XRD 回折解析',
          purpose: 'XRD パターンを3工程で迅速解析する',
          acceptanceCriteria: '- 波長条件を明記すること',
          llm: { model: 'gpt-5.4', effort: 'high' },
          stages: [
            {
              key: 'load',
              label: 'データ読込',
              short: 'Load',
              instruction: '2theta 列を確認',
              llm: { model: 'gpt-5.3-codex', effort: 'low' },
            },
            {
              key: 'fit',
              label: 'ピーク解析',
              short: 'PeakFit',
              instruction: '主要ピークを抽出',
              llm: { model: '', effort: 'xhigh' },
            },
            {
              key: 'report',
              label: 'レポート公開',
              short: 'Report',
              instruction: 'HTML レポートを生成',
              llm: { model: '', effort: '' },
            },
          ],
        },
      );
      expect(createProj.status).toBe(201);
      expect(createProj.body.project.id).toBe('xrd-lab');
      expect(createProj.body.project.stages).toHaveLength(3);
      expect(createProj.body.project.inboxDir).toBe('projects/xrd-lab/inbox');
      expect(createProj.body.project.artifactsDir).toBe('projects/xrd-lab/artifacts');
      expect(existsSync(path.join(temp, 'projects', 'xrd-lab', 'inbox'))).toBe(true);
      expect(existsSync(path.join(temp, 'projects', 'xrd-lab', 'artifacts'))).toBe(true);
      expect(existsSync(path.join(temp, 'data', 'projects.json'))).toBe(true);

      // Enqueue demo job in xrd-lab project.
      const init = await post<{ job: WorkflowJob }>('/api/demo', {
        projectId: 'xrd-lab',
        review: true,
      });
      expect(init.status).toBe(201);
      const id = init.body.job.id;
      expect(init.body.job.projectId).toBe('xrd-lab');
      expect(init.body.job.stages.map((stage) => stage.key)).toEqual(['load', 'fit', 'report']);

      // Default project state should not include xrd-lab jobs.
      const defaultState = (await (
        await fetch(`${api}/api/state?project=default`)
      ).json()) as AppStateResponse;
      expect(defaultState.jobs).toHaveLength(0);

      const claim = await post<ClaimResponse>('/api/jobs/claim', {
        agent: 'demo',
        worker: 'test-worker',
        projectId: 'xrd-lab',
      });
      expect(claim.body.job?.id).toBe(id);
      expect(claim.body.project?.id).toBe('xrd-lab');
      expect(claim.body.paths?.input).toContain(path.join('data', 'inputs', id));
      expect(claim.body.paths?.artifacts).toContain(path.join('projects', 'xrd-lab', 'artifacts'));

      expect((await fetch(api + '/api/projects/xrd-lab', { method: 'DELETE' })).status).toBe(409);
      const second = await post<ClaimResponse>('/api/jobs/claim', {
        agent: 'demo',
        projectId: 'xrd-lab',
      });
      expect(second.body.job).toBeNull();

      const send = async (
        type: string,
        stage: string | null,
        message = '',
        extra: Record<string, unknown> = {},
      ) => post(`/api/jobs/${id}/events`, { type, stage, message, ...extra });

      await send('stage.started', 'load');
      await send('stage.succeeded', 'load', 'load: 完了', {
        summary: '141行・2列のXRDデータを確認',
      });
      await send('stage.started', 'fit');
      await send('stage.failed', 'fit', 'failed once');
      await send('stage.retry', 'fit');
      await send('stage.started', 'fit');
      await send('stage.succeeded', 'fit', 'fit: 完了', {
        summary: '2回目の試行でピーク強度 790 を算出',
      });
      await send('review.required', 'fit', 'please inspect');

      let state = (await (
        await fetch(`${api}/api/state?project=xrd-lab`)
      ).json()) as AppStateResponse;
      expect(state.project.name).toBe('XRD 回折解析');
      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0].status).toBe('review');
      expect(state.jobs[0].stages[0].summary).toBe('141行・2列のXRDデータを確認');
      expect(state.jobs[0].stages[1].attempts).toBe(2);
      expect(state.jobs[0].stages[1].summary).toBe('2回目の試行でピーク強度 790 を算出');

      const approval = await post(`/api/jobs/${id}/approve`);
      expect(approval.status).toBe(200);

      const resumed = await post<ClaimResponse>('/api/jobs/claim', { agent: 'demo' });
      expect(resumed.body.job?.id).toBe(id);

      const out = path.join(temp, 'projects', 'xrd-lab', 'artifacts', id, 'report 100%.html');
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, '<h1>Hello</h1>');

      const artifact = await post(`/api/jobs/${id}/events`, {
        type: 'artifact.created',
        stage: 'report',
        artifact: { name: 'report 100%.html' },
      });
      expect(artifact.status).toBe(200);
      await send('job.completed', null, 'done');

      const file = await fetch(`${api}/artifacts/xrd-lab/${id}/report%20100%25.html`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-security-policy')).toMatch(/sandbox/);

      writeFileSync(
        path.join(temp, 'projects', 'xrd-lab', 'artifacts', id, 'chart.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );
      const chart = await fetch(`${api}/artifacts/xrd-lab/${id}/chart.svg`);
      expect(chart.status).toBe(200);
      expect(chart.headers.get('content-security-policy')).toMatch(/sandbox/);

      // Wrong project prefix must return 404.
      const wrongProjectArtifact = await fetch(`${api}/artifacts/default/${id}/chart.svg`);
      expect(wrongProjectArtifact.status).toBe(404);

      state = (await (await fetch(`${api}/api/state?project=xrd-lab`)).json()) as AppStateResponse;
      expect(state.jobs[0].status).toBe('done');
      expect(state.jobs[0].artifacts).toHaveLength(1);
      expect(state.jobs[0].artifacts[0].uri).toBe(`/artifacts/xrd-lab/${id}/report%20100%25.html`);

      const logs = await fetch(`${api}/api/jobs/${id}/logs`);
      expect(logs.status).toBe(200);
      expect(logs.headers.get('content-disposition')).toMatch(/attachment/);
      const logText = await logs.text();
      expect(logText).toMatch(/Project: xrd-lab/);
      expect(logText).toMatch(/stage\.failed \[fit\] failed once/);
      expect(logText).toMatch(/Summary: 141行・2列のXRDデータを確認/);
      expect(logText).toMatch(/review\.approved/);

      const noLogs = await fetch(`${api}/api/jobs/run_deadbeef/logs`);
      expect(noLogs.status).toBe(404);
      expect(existsSync(path.join(temp, 'data', 'events.jsonl'))).toBe(true);

      if (existsSync(path.join(root, 'dist', 'index.html'))) {
        const html = await fetch(`${api}/`);
        expect(html.status).toBe(200);
        expect(html.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
        expect(html.headers.get('content-security-policy')).not.toMatch(/sandbox/);
        expect(await html.text()).toMatch(/RAILFLOW/);

        const wfHtml = await fetch(`${api}/workflow`);
        expect(wfHtml.status).toBe(200);
        expect(wfHtml.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
        expect(await wfHtml.text()).toMatch(/ワークフロー定義/);

        const management = await fetch(`${api}/projects/?project=xrd-lab`);
        expect(management.status).toBe(200);
        expect(await management.text()).toContain('data-page="projects"');
      }

      // Drop a file directly into xrd-lab's dedicated inbox directory.
      writeFileSync(
        path.join(temp, 'projects', 'xrd-lab', 'inbox', 'watch_xrd.csv'),
        'x,y\n1,2\n2,3\n',
      );
      const watched = await until(async () => {
        const result = (await (
          await fetch(`${api}/api/state?project=xrd-lab`)
        ).json()) as AppStateResponse;
        return result.jobs.find((job) => job.file === 'watch_xrd.csv');
      }, 6500);
      expect(watched.status).toBe('queued');
      expect(watched.projectId).toBe('xrd-lab');
      expect(watched.stages).toHaveLength(3);
    } finally {
      proc.kill('SIGTERM');
      await sleep(200);
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
