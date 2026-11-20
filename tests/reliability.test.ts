import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vite-plus/test';
import type { ClaimResponse, WorkflowJob } from '../shared/types.ts';
import { cliPrelude, workflowFixture } from './workflow-fixture.ts';

it('deduplicates a committed event after its response is lost, including terminal events', async () => {
  const f = await workflowFixture();
  try {
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo');
    const claim = await f.json<ClaimResponse>('/api/jobs/claim');
    const body = {
      type: 'stage.started',
      stage: 'ingest',
      attempt: 1,
      leaseToken: claim.lease!.token,
      requestId: randomUUID(),
    };
    const first = await f.json(`/api/jobs/${job.id}/events`, body);
    expect(await f.json(`/api/jobs/${job.id}/events`, body)).toEqual(first);
    expect((await f.job(job.id)).stages[0].attempts).toBe(1);
    const terminal = {
      type: 'job.failed',
      leaseToken: claim.lease!.token,
      requestId: randomUUID(),
    };
    const last = await f.json(`/api/jobs/${job.id}/events`, terminal);
    expect(await f.json(`/api/jobs/${job.id}/events`, terminal)).toEqual(last);
    expect((await f.state()).queue!.active).toBe(0);
    expect(
      (await f.response(`/api/jobs/${job.id}/events`, { ...terminal, requestId: randomUUID() }))
        .status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

it('persists the remaining retry delay and recovery cap without granting free retries', async () => {
  const f = await workflowFixture();
  try {
    await f.json(
      '/api/queue',
      { maxConcurrentJobs: 4, maxJobsPerWorker: 2, maxRecoveries: 1 },
      'PUT',
    );
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo');
    const claim = await f.json<ClaimResponse>('/api/jobs/claim');
    const post = (type: string, extra = {}) =>
      f.json(`/api/jobs/${job.id}/events`, {
        type,
        stage: 'ingest',
        attempt: 1,
        leaseToken: claim.lease!.token,
        ...extra,
      });
    await post('stage.started');
    await post('stage.failed', { failureKind: 'execution_error', elapsedMs: 10 });
    await post('stage.retry', { retryAt: new Date(Date.now() + 10_000).toISOString() });
    await f.json(`/api/jobs/${job.id}/pause`);
    await f.json(`/api/jobs/${job.id}/release`, { leaseToken: claim.lease!.token });
    const paused = await f.job(job.id);
    expect(paused.stages[0].retryCount).toBe(1);
    expect(paused.stages[0].retryRemainingMs).toBeGreaterThan(5000);
    await f.json(`/api/jobs/${job.id}/resume`);
    const next = await f.json<ClaimResponse>('/api/jobs/claim');
    expect(
      (
        await f.response(`/api/jobs/${job.id}/events`, {
          type: 'stage.started',
          stage: 'ingest',
          attempt: 2,
          leaseToken: next.lease!.token,
        })
      ).status,
    ).toBe(409);
    await f.json(`/api/jobs/${job.id}/release`, { leaseToken: next.lease!.token });
    expect((await f.job(job.id)).recoveryCount).toBe(1);
    const last = await f.json<ClaimResponse>('/api/jobs/claim');
    await f.json(`/api/jobs/${job.id}/release`, { leaseToken: last.lease!.token });
    expect((await f.job(job.id)).status).toBe('failed');
  } finally {
    await f.close();
  }
});

it('claims atomically by priority while enforcing server, project and worker limits', async () => {
  const f = await workflowFixture();
  try {
    await f.json(
      '/api/queue',
      { maxConcurrentJobs: 2, maxJobsPerWorker: 1, maxRecoveries: 3 },
      'PUT',
    );
    for (const id of ['a', 'b'])
      await f.json('/api/projects', { id, name: id, queue: { maxConcurrentJobs: 1, priority: 0 } });
    const created: WorkflowJob[] = [];
    for (const projectId of ['a', 'a', 'b'])
      created.push((await f.json<{ job: WorkflowJob }>('/api/demo', { projectId })).job);
    await f.json(`/api/jobs/${created[1].id}/priority`, { priority: 100 });
    const claims = await Promise.all(
      ['one', 'two', 'three'].map((worker) => f.json<ClaimResponse>('/api/jobs/claim', { worker })),
    );
    expect(claims.map((c) => c.job?.id).filter(Boolean)).toEqual([created[1].id, created[2].id]);
    expect(new Set(claims.filter((c) => c.job).map((c) => c.lease!.token)).size).toBe(2);
    expect((await f.json<ClaimResponse>('/api/jobs/claim', { worker: 'one' })).job).toBeNull();
    await f.json(`/api/jobs/${created[1].id}/cancel`);
    expect((await f.state()).queue!.active).toBe(2);
    await f.json(`/api/jobs/${created[1].id}/release`, { leaseToken: claims[0].lease!.token });
    expect((await f.job(created[1].id)).status).toBe('cancelled');
    expect((await f.json<ClaimResponse>('/api/jobs/claim', { worker: 'three' })).job?.id).toBe(
      created[0].id,
    );
  } finally {
    await f.close();
  }
});

it('recovers an expired lease with accepted checkpoints and rejects all stale writes', async () => {
  const f = await workflowFixture(undefined, { RAILFLOW_LEASE_MS: '1000' });
  try {
    await f.json('/api/projects', {
      id: 'recovery',
      name: 'Recovery',
      execution: { maxRetries: 0 },
      stages: [{ key: 'a' }, { key: 'b' }],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'recovery' });
    const claim = await f.json<ClaimResponse>('/api/jobs/claim', { worker: 'old' });
    const event = (type: string, stage: string, extra = {}) =>
      f.json(`/api/jobs/${job.id}/events`, {
        type,
        stage,
        attempt: 1,
        leaseToken: claim.lease!.token,
        ...extra,
      });
    mkdirSync(path.join(claim.paths!.work, '.attempts/a/1'), { recursive: true });
    writeFileSync(path.join(claim.paths!.work, '.attempts/a/1/accepted.txt'), 'checkpoint');
    await event('stage.started', 'a', { workspace: '.attempts/a/1' });
    await event('stage.executed', 'a');
    await event('stage.succeeded', 'a', { elapsedMs: 10 });
    await event('stage.started', 'b', { workspace: '.attempts/b/1' });
    const recovered = await f.until(job.id, 'queued');
    expect(recovered.recoveryCount).toBe(1);
    expect(recovered.stages.map((s) => s.status)).toEqual(['success', 'pending']);
    expect(recovered.stages[1].activeMs).toBeGreaterThan(0);
    const next = await f.json<ClaimResponse>('/api/jobs/claim', { worker: 'new' });
    expect(next.lease!.token).not.toBe(claim.lease!.token);
    for (const type of ['stage.succeeded', 'job.failed', 'artifact.created']) {
      expect(
        (
          await f.response(`/api/jobs/${job.id}/events`, {
            type,
            stage: 'b',
            attempt: 1,
            leaseToken: claim.lease!.token,
          })
        ).status,
      ).toBe(409);
    }
    expect(
      (
        await f.response(`/api/jobs/${job.id}/events`, {
          type: 'stage.started',
          stage: 'b',
          attempt: 2,
          workspace: '.attempts/b/2',
          leaseToken: next.lease!.token,
        })
      ).status,
    ).toBe(200);
    expect((await f.job(job.id)).stages[1].retryCount).toBe(0);
  } finally {
    await f.close();
  }
});

it('pauses a process and resumes only its unfinished stage without consuming retries', async () => {
  const f = await workflowFixture(undefined, { RAILFLOW_LEASE_MS: '1200' });
  try {
    await f.json('/api/projects', {
      id: 'pause',
      name: 'Pause',
      execution: { maxRetries: 0 },
      stages: [{ key: 'a' }, { key: 'b' }],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'pause' });
    f.worker(
      cliPrelude +
        `
if (stage === 'a') fs.writeFileSync('accepted.txt', 'accepted');
if (stage === 'b' && attempt === 1) { fs.writeFileSync('bad.txt', 'unfinished'); setInterval(() => {}, 1000); }
if (stage === 'b' && attempt === 2) {
  if (!fs.existsSync('accepted.txt') || fs.existsSync('bad.txt')) process.exit(9);
  fs.writeFileSync('report.html', 'resumed');
}`,
    );
    await expect.poll(async () => (await f.job(job.id)).stages[1].status).toBe('running');
    await f.json(`/api/jobs/${job.id}/pause`);
    const paused = await f.until(job.id, 'paused');
    expect(paused.stages.map((s) => s.status)).toEqual(['success', 'pending']);
    expect((await f.state()).queue!.active).toBe(0);
    await f.json(`/api/jobs/${job.id}/resume`);
    const done = await f.until(job.id, 'done');
    expect(done.stages.map((s) => s.attempts)).toEqual([1, 2]);
    expect(done.stages[1].retryCount).toBe(0);
    expect(await (await fetch(f.url + done.artifacts[0].uri)).text()).toBe('resumed');
  } finally {
    await f.close();
  }
});

it.skipIf(process.platform === 'win32')(
  'reaps a killed worker’s CLI and resumes after lease expiry',
  async () => {
    const f = await workflowFixture(undefined, { RAILFLOW_LEASE_MS: '1200' });
    try {
      await f.json('/api/projects', {
        id: 'kill',
        name: 'Kill',
        execution: { maxRetries: 0 },
        stages: [{ key: 'report' }],
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'kill' });
      const script =
        cliPrelude +
        `
if (attempt === 1) { fs.writeFileSync(path.join(process.env.TEST_HOME, 'pid'), String(process.pid)); setInterval(() => {}, 1000); }
else fs.writeFileSync('report.html', 'recovered');`;
      const worker = f.worker(script);
      await expect.poll(() => existsSync(path.join(f.home, 'pid'))).toBe(true);
      const pid = Number(readFileSync(path.join(f.home, 'pid'), 'utf8'));
      worker.kill();
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      await f.until(job.id, 'queued');
      f.worker(script);
      const done = await f.until(job.id, 'done');
      expect(done.stages[0].attempts).toBe(2);
      expect(done.recoveryCount).toBe(1);
      expect(done.stages[0].retryCount).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it('restores paused reviews from SQLite and repairs a damaged JSONL export', async () => {
  let f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'review',
      name: 'Review',
      stages: [{ key: 'report', gate: { requireReview: true } }],
    });
    const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'review' });
    f.worker(cliPrelude + `fs.writeFileSync('report.html', 'review output');`);
    const review = await f.until(job.id, 'review');
    const approval = {
      stage: 'report',
      attempt: 1,
      reviewSequence: review.stages[0].reviewSequence,
    };
    await f.json(`/api/jobs/${job.id}/pause`);
    expect((await f.response(`/api/jobs/${job.id}/approve`, approval)).status).toBe(409);
    const home = f.home;
    await f.close(true);
    writeFileSync(path.join(home, 'data/events.jsonl'), 'broken export');
    f = await workflowFixture(home);
    expect((await f.job(job.id)).status).toBe('paused');
    await f.json(`/api/jobs/${job.id}/resume`);
    expect((await f.job(job.id)).status).toBe('review');
    expect((await f.job(job.id)).stages[0].reviewSequence).toBe(approval.reviewSequence);
    await f.json(`/api/jobs/${job.id}/approve`, approval);
    expect((await f.job(job.id)).status).toBe('queued');
    expect(readFileSync(path.join(home, 'data/events.jsonl'), 'utf8')).toContain('review.required');
  } finally {
    await f.close();
  }
});
