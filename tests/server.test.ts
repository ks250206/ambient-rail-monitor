import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import type {
  AppStateResponse,
  ClaimResponse,
  WorkflowJob,
  WorkflowSpec,
} from '../shared/types.ts';
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
  it('handles workflow spec, stage summaries, file enqueue -> pull claim -> spans -> review -> artifact -> replay', async () => {
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

      // Update workflow spec (purpose, acceptance criteria, custom stage instructions)
      const putRes = await fetch(`${api}/api/workflow`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'XPS 実験解析',
          purpose: 'スペクトル CSV を検品・解析してレポートを作成する',
          acceptanceCriteria: '- 単位の欠損を明示すること\n- HTML レポートを出力すること',
          stageInstructions: {
            ingest: '列名と欠損行数を必ず確認する',
            preprocess: '',
            analysis: '54 eV 付近の最大強度を報告する',
            validate: '',
            visualize: '',
            publish: '',
          },
        }),
      });
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as { workflow: WorkflowSpec };
      expect(putBody.workflow.title).toBe('XPS 実験解析');
      expect(putBody.workflow.stageInstructions.ingest).toBe('列名と欠損行数を必ず確認する');
      expect(existsSync(path.join(temp, 'data', 'workflow-spec.json'))).toBe(true);

      const init = await post<{ job: WorkflowJob }>('/api/demo', { review: true });
      expect(init.status).toBe(201);
      const id = init.body.job.id;

      const claim = await post<ClaimResponse>('/api/jobs/claim', {
        agent: 'demo',
        worker: 'test-worker',
      });
      expect(claim.body.job?.id).toBe(id);
      expect(claim.body.workflow?.title).toBe('XPS 実験解析');
      expect(claim.body.workflow?.stageInstructions.analysis).toBe(
        '54 eV 付近の最大強度を報告する',
      );

      const second = await post<ClaimResponse>('/api/jobs/claim', { agent: 'demo' });
      expect(second.body.job).toBeNull();

      const send = async (
        type: string,
        stage: string | null,
        message = '',
        extra: Record<string, unknown> = {},
      ) => post(`/api/jobs/${id}/events`, { type, stage, message, ...extra });

      await send('stage.started', 'ingest');
      await send('stage.succeeded', 'ingest', 'ingest: 完了', {
        summary: '141行・2列のCSVを確認し欠損なし',
      });
      await send('stage.started', 'analysis');
      await send('stage.failed', 'analysis', 'failed once');
      await send('stage.retry', 'analysis');
      await send('stage.started', 'analysis');
      await send('stage.succeeded', 'analysis', 'analysis: 完了', {
        summary: '2回目の試行でピーク強度 790 を算出',
      });
      await send('review.required', 'validate', 'please inspect');

      let state = (await (await fetch(`${api}/api/state`)).json()) as AppStateResponse;
      expect(state.workflow.title).toBe('XPS 実験解析');
      expect(state.jobs[0].status).toBe('review');
      expect(state.jobs[0].stages[0].summary).toBe('141行・2列のCSVを確認し欠損なし');
      expect(state.jobs[0].stages[2].attempts).toBe(2);
      expect(state.jobs[0].stages[2].summary).toBe('2回目の試行でピーク強度 790 を算出');
      expect(state.events.filter((event) => event.type === 'stage.failed')).toHaveLength(1);

      const approval = await post(`/api/jobs/${id}/approve`);
      expect(approval.status).toBe(200);

      const resumed = await post<ClaimResponse>('/api/jobs/claim', { agent: 'demo' });
      expect(resumed.body.job?.id).toBe(id);

      const out = path.join(temp, 'artifacts', id, 'report 100%.html');
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, '<h1>Hello</h1>');

      const artifact = await post(`/api/jobs/${id}/events`, {
        type: 'artifact.created',
        stage: 'publish',
        artifact: { name: 'report 100%.html' },
      });
      expect(artifact.status).toBe(200);
      await send('job.completed', null, 'done');

      const file = await fetch(`${api}/artifacts/${id}/report%20100%25.html`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-security-policy')).toMatch(/sandbox/);

      writeFileSync(
        path.join(temp, 'artifacts', id, 'chart.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );
      const chart = await fetch(`${api}/artifacts/${id}/chart.svg`);
      expect(chart.status).toBe(200);
      expect(chart.headers.get('content-security-policy')).toMatch(/sandbox/);

      state = (await (await fetch(`${api}/api/state`)).json()) as AppStateResponse;
      expect(state.jobs[0].status).toBe('done');
      expect(state.jobs[0].artifacts).toHaveLength(1);

      const logs = await fetch(`${api}/api/jobs/${id}/logs`);
      expect(logs.status).toBe(200);
      expect(logs.headers.get('content-disposition')).toMatch(/attachment/);
      const logText = await logs.text();
      expect(logText).toMatch(/stage\.failed \[analysis\] failed once/);
      expect(logText).toMatch(/Summary: 141行・2列のCSVを確認し欠損なし/);
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
      }

      writeFileSync(path.join(temp, 'inbox', 'watch_test.csv'), 'x,y\n1,2\n2,3\n');
      const watched = await until(async () => {
        const result = (await (await fetch(`${api}/api/state`)).json()) as AppStateResponse;
        return result.jobs.find((job) => job.file === 'watch_test.csv');
      }, 6500);
      expect(watched.status).toBe('queued');
    } finally {
      proc.kill('SIGTERM');
      await sleep(200);
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
