import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { runCommand } from '../shared/process-runner.ts';
import type { WorkflowJob } from '../shared/types.ts';
import { cliPrelude, workflowFixture } from './workflow-fixture.ts';

const quality = {
  op: 'json.value',
  path: 'metrics.json',
  field: 'quality.passed',
  compare: 'eq',
  value: true,
};
const stages = [{ key: 'analyze', label: '解析' }];

describe.skipIf(process.platform === 'win32')('execution policy integration', () => {
  it('retries failed acceptance in a clean attempt, keeps accepted inputs, and supplies evidence in the next prompt', async () => {
    const f = await workflowFixture();
    try {
      await f.json('/api/projects', {
        id: 'gates',
        name: 'Gates',
        execution: { retryDelayMs: 0 },
        stages: [
          { key: 'prepare', label: '準備' },
          { key: 'analyze', label: '解析', gate: { condition: quality } },
        ],
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'gates' });
      f.worker(
        cliPrelude +
          `
if (stage === 'prepare') { fs.writeFileSync('baseline.txt', 'accepted'); fs.writeFileSync('check.sh', ['#!/bin/sh','exit 0',''].join(String.fromCharCode(10)), {mode:0o700}); }
else {
  if (fs.readFileSync('baseline.txt','utf8') !== 'accepted') process.exit(8);
  require('node:child_process').execFileSync('./check.sh');
  if (attempt === 2 && fs.existsSync('failed-only.txt')) process.exit(9);
  fs.writeFileSync('metrics.json', JSON.stringify({ quality: { passed: attempt === 2 } }));
  fs.writeFileSync('report.html', 'report attempt ' + attempt);
  if (attempt === 1) fs.writeFileSync('failed-only.txt', 'must not be reused');
}
`,
      );
      const result = await f.until(job.id, 'done');
      expect(result.stages.map((stage) => stage.attempts)).toEqual([1, 2]);
      const checks = result.events.filter(
        (event) =>
          event.type === 'gate.evaluated' &&
          event.stage === 'analyze' &&
          event.gate?.scope === 'stage',
      );
      expect(checks.map((event) => event.gate!.result.status)).toEqual(['fail', 'pass']);
      expect(
        result.events.some(
          (event) =>
            event.type === 'stage.succeeded' && event.stage === 'analyze' && event.attempt === 1,
        ),
      ).toBe(false);
      const retry = result.events.find(
        (event) =>
          event.type === 'stage.started' && event.stage === 'analyze' && event.attempt === 2,
      )!;
      expect(retry.stageConfig?.prompt).toContain('quality.passed');
      expect(retry.stageConfig?.prompt).toContain('false');
      expect(await (await fetch(f.url + result.artifacts[0].uri)).text()).toBe('report attempt 2');
      expect(
        existsSync(
          path.join(f.home, 'projects/gates/work', job.id, '.attempts/analyze/1/failed-only.txt'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(f.home, 'projects/gates/work', job.id, '.attempts/analyze/2/failed-only.txt'),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.each([
    { maxRetries: 0, retryOn: ['execution_error'], count: 1, gateFailure: false },
    { maxRetries: 2, retryOn: ['execution_error'], count: 3, gateFailure: false },
    { maxRetries: 2, retryOn: [], count: 1, gateFailure: false },
    { maxRetries: 2, retryOn: ['execution_error'], count: 1, gateFailure: true },
  ])(
    'honors retry counts and categories: $maxRetries / $retryOn / gate=$gateFailure',
    async ({ maxRetries, retryOn, count, gateFailure }) => {
      const f = await workflowFixture();
      try {
        await f.json('/api/projects', {
          id: 'retry',
          name: 'Retry',
          execution: { maxRetries, retryOn, retryDelayMs: 0 },
          stages: [{ ...stages[0], gate: { condition: gateFailure ? quality : null } }],
        });
        const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'retry' });
        f.worker(
          cliPrelude +
            (gateFailure
              ? `fs.writeFileSync('metrics.json','{"quality":{"passed":false}}');`
              : 'process.exit(1);'),
        );
        const result = await f.until(job.id, 'failed');
        expect(result.stages[0].attempts).toBe(count);
        expect(
          readFileSync(path.join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n'),
        ).toHaveLength(count);
        expect(result.stages[0].failureKind).toBe(
          gateFailure ? 'acceptance_failed' : 'execution_error',
        );
        expect(result.artifacts).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('times out and kills TERM-ignoring process trees before retrying', async () => {
    const f = await workflowFixture();
    try {
      await f.json('/api/projects', {
        id: 'timeout',
        name: 'Timeout',
        execution: { maxRetries: 0, attemptTimeoutMs: 250 },
        stages,
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'timeout' });
      f.worker(
        cliPrelude +
          `
const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},100);"], {stdio:'inherit'});
fs.writeFileSync(path.join(process.env.TEST_HOME, 'pids.json'), JSON.stringify([process.pid,child.pid]));
process.on('SIGTERM',()=>{});setInterval(()=>{},100);
`,
      );
      const result = await f.until(job.id, 'failed');
      expect(result.stages[0].failureKind).toBe('timeout');
      expect(result.stages[0].attempts).toBe(1);
      expect(result.artifacts).toEqual([]);
      for (const pid of JSON.parse(
        readFileSync(path.join(f.home, 'pids.json'), 'utf8'),
      ) as number[]) {
        // Some container PID 1 implementations retain a dead orphan as a zombie.
        const status = `/proc/${pid}/status`;
        if (existsSync(status)) expect(readFileSync(status, 'utf8')).toMatch(/State:\s+Z/);
      }
    } finally {
      await f.close();
    }
  });

  it.each(['stage_timeout', 'job_timeout'] as const)(
    'does not start retries whose backoff exceeds the remaining %s budget',
    async (kind) => {
      const f = await workflowFixture();
      try {
        await f.json('/api/projects', {
          id: 'budget',
          name: 'Budget',
          jobTimeoutMs: kind === 'job_timeout' ? 1000 : 0,
          execution: {
            maxRetries: 5,
            stageTimeoutMs: kind === 'stage_timeout' ? 1000 : 0,
            retryDelayMs: 1500,
          },
          stages,
        });
        const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'budget' });
        f.worker(cliPrelude + 'process.exit(1);');
        const result = await f.until(job.id, 'failed');
        expect(result.stages[0].attempts).toBe(1);
        expect(result.events.at(-1)?.failureKind).toBe(kind);
        expect(result.events.some((event) => event.type === 'stage.retry')).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it('requires independent reviews, rejects stale approvals, and resumes after restart without rerunning accepted stages', async () => {
    let f = await workflowFixture();
    const mock =
      cliPrelude +
      `fs.writeFileSync('report.html', 'reviewable ' + stage);fs.writeFileSync('summary_' + stage + '.txt','summary ' + stage);`;
    try {
      await f.json('/api/projects', {
        id: 'reviews',
        name: 'Reviews',
        stages: [
          { key: 'first', label: 'First', gate: { requireReview: true } },
          { key: 'last', label: 'Last', gate: { requireReview: true } },
        ],
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'reviews' });
      f.worker(mock);
      const first = await f.until(job.id, 'review');
      const review = first.stages[0];
      const firstApproval = {
        stage: review.key,
        attempt: review.attempts,
        reviewSequence: review.reviewSequence,
      };
      const output = await fetch(
        f.url +
          `/api/jobs/${job.id}/review/file?path=report.html&sequence=${review.reviewSequence}`,
      );
      expect(await output.text()).toBe('reviewable first');
      expect(output.headers.get('content-security-policy')).toContain('sandbox');
      await f.json(`/api/jobs/${job.id}/approve`, firstApproval);
      await expect
        .poll(async () => (await f.job(job.id)).stages[1].status, { timeout: 9000 })
        .toBe('review');
      const second = await f.job(job.id);
      expect(second.artifacts).toEqual([]);
      const activeMs = second.stages.map((stage) => stage.activeMs);
      const home = f.home;
      await f.close(true);
      f = await workflowFixture(home);
      f.worker(mock);
      expect((await f.response(`/api/jobs/${job.id}/approve`, firstApproval)).status).toBe(409);
      const resumed = await f.job(job.id);
      expect(resumed.stages.map((stage) => stage.activeMs)).toEqual(activeMs);
      const last = resumed.stages[1];
      await f.json(`/api/jobs/${job.id}/approve`, {
        stage: last.key,
        attempt: last.attempts,
        reviewSequence: last.reviewSequence,
      });
      const result = await f.until(job.id, 'done');
      expect(result.stages.map((stage) => stage.attempts)).toEqual([1, 1]);
      expect(readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
        2,
      );
      expect(await (await fetch(f.url + result.artifacts[0].uri)).text()).toBe('reviewable last');
      expect(result.events.filter((event) => event.type === 'artifact.created')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('does not retry or offer review for a prompt that can never be built', async () => {
    let f = await workflowFixture();
    try {
      await f.json('/api/projects', {
        id: 'badprompt',
        name: 'Bad prompt',
        execution: { maxRetries: 3, retryDelayMs: 0, onFailure: 'review' },
        stages,
      });
      const home = f.home;
      await f.close(true);
      // Legacy projects.json may contain unknown variables; it loads, but cannot run.
      const file = path.join(home, 'data', 'projects.json');
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<{
        id: string;
        stages: Array<{ instruction: string }>;
      }>;
      saved.find((item) => item.id === 'badprompt')!.stages[0].instruction = 'Use {{unknown}}';
      writeFileSync(file, JSON.stringify(saved));
      f = await workflowFixture(home);
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'badprompt' });
      f.worker(cliPrelude);
      const result = await f.until(job.id, 'failed');
      expect(result.stages[0].attempts).toBe(1);
      expect(result.stages[0].failureKind).toBe('execution_error');
      expect(result.events.some((event) => event.type === 'stage.retry')).toBe(false);
      expect(result.events.some((event) => event.type === 'review.required')).toBe(false);
      expect(existsSync(path.join(home, 'calls.jsonl'))).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('does not retry after the agent alters the frozen input snapshot', async () => {
    const f = await workflowFixture();
    try {
      await f.json('/api/projects', {
        id: 'tamper',
        name: 'Tamper',
        execution: { maxRetries: 3, retryDelayMs: 0, onFailure: 'review' },
        stages,
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'tamper' });
      f.worker(
        cliPrelude +
          `
const dir = prompt.match(/INPUT DIRECTORY \\(read only\\): (.+)/)[1];
const target = path.join(dir, fs.readdirSync(dir)[0]);
fs.chmodSync(target, 0o600);
fs.appendFileSync(target, 'tampered');
fs.writeFileSync('report.html', 'report');
`,
      );
      const result = await f.until(job.id, 'failed');
      expect(result.stages[0].attempts).toBe(1);
      expect(result.events.some((event) => event.type === 'stage.retry')).toBe(false);
      expect(result.events.some((event) => event.type === 'review.required')).toBe(false);
      expect(
        readFileSync(path.join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n'),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('retains failed evidence when a human explicitly approves exhausted output', async () => {
    const f = await workflowFixture();
    try {
      await f.json('/api/projects', {
        id: 'exception',
        name: 'Exception',
        execution: { maxRetries: 0, onFailure: 'review' },
        stages: [{ ...stages[0], gate: { condition: quality } }],
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'exception' });
      f.worker(
        cliPrelude +
          `console.log('null');fs.writeFileSync('metrics.json','{"quality":{"passed":false}}');fs.writeFileSync('report.html','report with known limitation');`,
      );
      const review = (await f.until(job.id, 'review')).stages[0];
      expect(review.failureKind).toBe('acceptance_failed');
      await f.json(`/api/jobs/${job.id}/approve`, {
        stage: review.key,
        attempt: review.attempts,
        reviewSequence: review.reviewSequence,
      });
      const result = await f.until(job.id, 'done');
      expect(result.stages[0].attempts).toBe(1);
      expect(result.stages[0].gates?.[0].result.status).toBe('fail');
      expect(result.stages[0].approvedAttempt).toBe(1);
      expect(result.events.some((event) => event.type === 'stage.succeeded')).toBe(false);
    } finally {
      await f.close();
    }
  });
});

it('keeps timeouts as failures even when a child exits zero on TERM', async () => {
  await expect(
    runCommand(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100);"],
      { cwd: process.cwd(), timeoutMs: 200, timeoutKind: 'timeout', graceMs: 50 },
    ),
  ).rejects.toMatchObject({ kind: 'timeout' });
});

it('bounds telemetry drain after a child exits', async () => {
  const start = performance.now();
  await expect(
    runCommand(process.execPath, ['-e', "console.log('event');"], {
      cwd: process.cwd(),
      timeoutMs: 150,
      timeoutKind: 'timeout',
      onLine: () => new Promise(() => {}),
    }),
  ).rejects.toMatchObject({ kind: 'timeout' });
  expect(performance.now() - start).toBeLessThan(2000);
});

it('ignores synchronous telemetry parser errors without terminating the worker', async () => {
  await expect(
    runCommand(process.execPath, ['-e', "console.log('null')"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      timeoutKind: 'timeout',
      onLine: () => {
        throw new Error('bad telemetry');
      },
    }),
  ).resolves.toBeUndefined();
});
