import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { expect, it } from 'vite-plus/test';
import { createClient } from '../client/http.ts';
import { createReviewOperations, type ReviewInspection } from '../client/review.ts';
import type { WorkflowEvent, WorkflowJob } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;

const reportRunner = {
  kind: 'command',
  program: process.execPath,
  args: ['-e', "require('node:fs').writeFileSync('report.html','review output')"],
};

async function reviewProject(f: Fixture, second?: 'normal' | 'failed') {
  await f.json('/api/projects', {
    id: 'exact',
    name: 'Exact review',
    graph: { mode: 'dag', maxParallelTasks: 2, publishStage: 'publish' },
    execution: { maxRetries: 0, onFailure: 'review' },
    stages: [
      { key: 'first', runner: reportRunner, gate: { requireReview: true } },
      ...(second
        ? [
            {
              key: 'second',
              runner: reportRunner,
              gate:
                second === 'failed'
                  ? { condition: { op: 'file.exists', pattern: 'required.txt' } }
                  : { requireReview: true },
            },
          ]
        : []),
      { key: 'publish', dependsOn: second ? ['first', 'second'] : ['first'], runner: reportRunner },
    ],
  });
}

async function enqueue(f: Fixture) {
  const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'exact' });
  return job.id;
}

function operations(f: Fixture) {
  return createReviewOperations(createClient({ origin: new URL(f.url), requestTimeoutMs: 5000 }));
}

function receiptFor(review: ReviewInspection) {
  expect(review.receipt).toMatch(/^[a-f0-9]{64}$/);
  return review.receipt!;
}

function approvals(job: WorkflowJob) {
  return job.events.filter((event) => event.type === 'review.approved');
}

async function waitingReview(f: Fixture) {
  await reviewProject(f);
  const id = await enqueue(f);
  f.worker('process.exit(99)');
  const job = await f.until(id, 'review');
  return { job, review: await operations(f).inspectReview(id, 'first') };
}

it.each(['exact', 'UI'])('keeps the queued sibling available for %s approval', async (mode) => {
  const f = await workflowFixture();
  try {
    await reviewProject(f, 'normal');
    const id = await enqueue(f);
    const worker = f.worker('process.exit(99)');
    const job = await f.until(id, 'review');
    await worker.close();
    expect(job.stages.map((stage) => stage.status)).toEqual(['review', 'review', 'pending']);

    const client = operations(f);
    const targets = await Promise.all(
      ['first', 'second'].map((key) => client.inspectReview(id, key)),
    );
    expect(receiptFor(targets[0])).not.toBe(receiptFor(targets[1]));
    await expect(
      client.approveExact(targets[1].ref, receiptFor(targets[0]), false),
    ).rejects.toMatchObject({ status: 409 });
    expect(targets.map(({ ref }) => ref)).toEqual(
      job.stages.slice(0, 2).map((stage) => ({
        jobId: id,
        stageKey: stage.key,
        attempt: 1,
        reviewSequence: stage.reviewSequence,
      })),
    );
    for (const target of targets) {
      expect(target.failureKind).toBeNull();
      expect(target.files).toContainEqual({ path: 'report.html', bytes: 13 });
    }
    const [first, second] = targets;
    await expect(client.approveExact(first.ref, receiptFor(first), false)).resolves.toEqual({
      ok: true,
      ref: first.ref,
      exception: false,
    });
    expect((await f.job(id)).status).toBe('queued');

    const queuedReview = await client.inspectReview(id, 'second');
    expect(queuedReview).toEqual(second);
    const file = await client.openReviewFile(queuedReview.ref, 'report.html');
    try {
      expect(await text(file.stream)).toBe('review output');
    } finally {
      file.close();
    }
    if (mode === 'exact') {
      await expect(
        client.approveExact(queuedReview.ref, receiptFor(queuedReview), false),
      ).resolves.toEqual({ ok: true, ref: second.ref, exception: false });
    } else {
      const { stageKey, attempt, reviewSequence } = queuedReview.ref;
      await expect(
        f.json(`/api/jobs/${id}/approve`, { stage: stageKey, attempt, reviewSequence }),
      ).resolves.toEqual({ ok: true });
    }
    expect(approvals(await f.job(id))).toHaveLength(2);
    expect((await f.job(id)).stages.map((stage) => stage.status)).toEqual([
      'success',
      'success',
      'pending',
    ]);
  } finally {
    await f.close();
  }
});

it('rejects stale coordinates and a receipt from a different job', async () => {
  const f = await workflowFixture();
  try {
    const { job, review } = await waitingReview(f);
    const other = await enqueue(f);
    await f.until(other, 'review');
    const client = operations(f);
    const otherReview = await client.inspectReview(other, 'first');
    const { ref } = review;
    const receipt = receiptFor(review);
    for (const target of [
      { ...ref, reviewSequence: ref.reviewSequence + 1 },
      { ...ref, attempt: ref.attempt + 1 },
      otherReview.ref,
    ]) {
      await expect(client.approveExact(target, receipt, false)).rejects.toMatchObject({
        status: 409,
      });
    }
    expect(approvals(await f.job(job.id))).toHaveLength(0);
    expect(approvals(await f.job(other))).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('invalidates a receipt on restart while preserving the review target', async () => {
  const first = await workflowFixture();
  let restarted: Fixture | undefined;
  try {
    const { review } = await waitingReview(first);
    const oldReceipt = receiptFor(review);
    await first.close(true);
    restarted = await workflowFixture(first.home);
    const client = operations(restarted);
    const current = await client.inspectReview(review.ref.jobId, review.ref.stageKey);
    expect(current.ref).toEqual(review.ref);
    expect(current.receipt).not.toBe(oldReceipt);
    await expect(client.approveExact(review.ref, oldReceipt, false)).rejects.toMatchObject({
      status: 409,
    });
    expect(approvals(await restarted.job(review.ref.jobId))).toHaveLength(0);
    await expect(
      client.approveExact(current.ref, receiptFor(current), false),
    ).resolves.toMatchObject({
      ok: true,
    });
  } finally {
    if (restarted) await restarted.close();
    else {
      await first.close(true);
      rmSync(first.home, { recursive: true, force: true });
    }
  }
});

it('requires an exception exactly for a failed gate review', async () => {
  const f = await workflowFixture();
  try {
    await reviewProject(f, 'failed');
    const id = await enqueue(f);
    f.worker('process.exit(99)');
    await f.until(id, 'review');
    const client = operations(f);
    const normal = await client.inspectReview(id, 'first');
    const failed = await client.inspectReview(id, 'second');
    expect(failed.failureKind).toBe('acceptance_failed');
    expect(failed.summary).toEqual(expect.any(String));
    await expect(client.approveExact(normal.ref, receiptFor(normal), true)).rejects.toMatchObject({
      status: 409,
      message: 'A normal review requires approval without an exception.',
    });
    await expect(client.approveExact(failed.ref, receiptFor(failed), false)).rejects.toMatchObject({
      status: 409,
      message: 'A failed stage requires exception approval.',
    });
    expect(approvals(await f.job(id))).toHaveLength(0);
    await expect(client.approveExact(failed.ref, receiptFor(failed), true)).resolves.toEqual({
      ok: true,
      ref: failed.ref,
      exception: true,
    });
    const reviewed = (await f.job(id)).stages[1];
    expect(reviewed).toMatchObject({
      status: 'success',
      approvedAttempt: 1,
      failureKind: 'acceptance_failed',
    });
  } finally {
    await f.close();
  }
});

it('rejects an approval when reviewed output bytes change', async () => {
  const f = await workflowFixture();
  try {
    const { job, review } = await waitingReview(f);
    writeFileSync(
      path.join(
        f.home,
        'projects',
        job.projectId,
        'work',
        job.id,
        job.stages[0].workspace!,
        'report.html',
      ),
      'edited output',
    );
    await expect(
      operations(f).approveExact(review.ref, receiptFor(review), false),
    ).rejects.toMatchObject({ status: 409 });
    const current = await f.job(job.id);
    expect(current.stages[0].status).toBe('review');
    expect(approvals(current)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it.each([1, 2])(
  'binds all files shown in a v%s inspection to its exact receipt',
  async (version) => {
    const f = await workflowFixture();
    try {
      const human = version === 2;
      await f.json('/api/projects', {
        id: 'exact',
        name: 'Review evidence',
        ...(human ? { graph: { mode: 'dag', publishStage: 'publish' } } : {}),
        stages: human
          ? [
              { key: 'source', runner: reportRunner },
              { key: 'inspect', dependsOn: ['source'], runner: { kind: 'human' } },
              { key: 'publish', dependsOn: ['inspect'], runner: reportRunner },
            ]
          : [{ key: 'inspect', gate: { requireReview: true } }],
      });
      const id = await enqueue(f);
      f.worker("require('node:fs').writeFileSync('report.html','review output')");
      const job = await f.until(id, 'review');
      expect(job.workflow?.version).toBe(version);
      const stage = job.stages.find((s) => s.key === 'inspect')!;
      const client = operations(f);
      const review = await client.inspectReview(id, stage.key);
      const receipt = receiptFor(review);
      for (const relative of human
        ? ['_inputs/source/report.html', '_railflow/review.md']
        : ['report.html']) {
        const file = path.join(f.home, 'projects/exact/work', id, stage.workspace!, relative);
        const original = readFileSync(file);
        expect(review.files).toContainEqual({ path: relative, bytes: original.length });
        const opened = await client.openReviewFile(review.ref, relative);
        try {
          expect(await text(opened.stream)).toBe(original.toString());
        } finally {
          opened.close();
        }
        chmodSync(file, 0o600);
        writeFileSync(file, Buffer.alloc(original.length, 88));
        expect(receiptFor(await client.inspectReview(id, stage.key))).not.toBe(receipt);
        await expect(client.approveExact(review.ref, receipt, false)).rejects.toMatchObject({
          status: 409,
        });
        expect(approvals(await f.job(id))).toHaveLength(0);
        writeFileSync(file, original);
      }
      await expect(client.approveExact(review.ref, receipt, false)).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      await f.close();
    }
  },
);

it('writes exactly one approval event for concurrent requests using the same receipt', async () => {
  const f = await workflowFixture();
  try {
    const { job, review } = await waitingReview(f);
    const client = operations(f);
    const receipt = receiptFor(review);
    const results = await Promise.allSettled([
      client.approveExact(review.ref, receipt, false),
      client.approveExact(review.ref, receipt, false),
    ]);
    expect(results).toContainEqual({
      status: 'fulfilled',
      value: { ok: true, ref: review.ref, exception: false },
    });
    expect(results).toContainEqual({
      status: 'rejected',
      reason: expect.objectContaining({ status: 409 }),
    });
    const persisted = readFileSync(path.join(f.home, 'data', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as WorkflowEvent)
      .filter((event) => event.jobId === job.id && event.type === 'review.approved');
    expect(persisted).toEqual([
      expect.objectContaining({
        stage: review.ref.stageKey,
        attempt: review.ref.attempt,
        reviewSequence: review.ref.reviewSequence,
      }),
    ]);
    expect(approvals(await f.job(job.id))).toEqual(persisted);
  } finally {
    await f.close();
  }
});

it('previews legacy review files without an exact receipt and preserves UI approval', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-legacy-review-'));
  const id = 'run_12345678';
  const data = path.join(home, 'data');
  const workspace = path.join(home, 'work', id, 'draft');
  let f: Fixture | undefined;
  try {
    mkdirSync(data, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'report.html'), 'legacy');
    const events = [
      { type: 'job.created', file: 'legacy.csv', needsReview: true },
      { type: 'stage.started', stage: 'validate', workspace: 'draft' },
      { type: 'review.required', stage: 'validate', summary: 'Legacy review' },
    ];
    writeFileSync(
      path.join(data, 'events.jsonl'),
      events
        .map((event, index) =>
          JSON.stringify({ ...event, jobId: id, sequence: index + 1, at: '2026-01-01T00:00:00Z' }),
        )
        .join('\n') + '\n',
    );
    f = await workflowFixture(home);
    const client = operations(f);
    const review = await client.inspectReview(id, 'validate');
    expect(review.receipt).toBeNull();
    expect(review.summary).toBe('Legacy review');
    expect(review.files).toEqual([{ path: 'report.html', bytes: 6 }]);
    await expect(client.approveExact(review.ref, 'placeholder', false)).rejects.toMatchObject({
      status: 409,
    });
    expect(approvals(await f.job(id))).toHaveLength(0);
    await expect(f.json(`/api/jobs/${id}/approve`)).resolves.toEqual({ ok: true });
  } finally {
    if (f) await f.close();
    else rmSync(home, { recursive: true, force: true });
  }
});

it('opens the requested review bytes and refuses a stale reference or invalid path', async () => {
  const f = await workflowFixture();
  try {
    const { review } = await waitingReview(f);
    const client = operations(f);
    const stream = await client.openReviewFile(review.ref, 'report.html');
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of stream.stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('review output');
    } finally {
      stream.close();
    }
    await expect(
      client.openReviewFile({ ...review.ref, attempt: 2 }, 'report.html'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.openReviewFile(
        { ...review.ref, reviewSequence: review.ref.reviewSequence + 1 },
        'report.html',
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(client.openReviewFile(review.ref, '../report.html')).rejects.toMatchObject({
      kind: 'usage',
    });
    await expect(client.approveExact(review.ref, '', false)).rejects.toMatchObject({
      kind: 'usage',
    });
    await expect(
      client.approveExact({ ...review.ref, attempt: 0 }, receiptFor(review), false),
    ).rejects.toMatchObject({ kind: 'usage' });
  } finally {
    await f.close();
  }
});

it('rejects malformed requests and leaves a cancelled job closed to exact approval', async () => {
  const f = await workflowFixture();
  try {
    const { job, review } = await waitingReview(f);
    const route = `/api/jobs/${job.id}/approve-exact`;
    const body = {
      stage: review.ref.stageKey,
      attempt: review.ref.attempt,
      reviewSequence: review.ref.reviewSequence,
      receipt: receiptFor(review),
      exception: false,
    };
    for (const invalid of [
      { stage: '' },
      { attempt: Number.MAX_SAFE_INTEGER + 1 },
      { reviewSequence: 0 },
      { receipt: 1 },
      { exception: undefined },
      { exception: 'false' },
    ]) {
      expect((await f.response(route, { ...body, ...invalid })).status).toBe(400);
    }
    await f.json(`/api/jobs/${job.id}/cancel`);
    expect((await f.response(route, body)).status).toBe(409);
    const current = await f.job(job.id);
    expect(current.status).toBe('cancelled');
    expect(approvals(current)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('rejects an inspection response for a stage other than the one requested', async () => {
  const client = createReviewOperations({
    async json(method, route, _body, opts) {
      expect(method).toBe('GET');
      expect(route).toBe('/api/jobs/run_12345678/review?task=first');
      return opts!.validate!({
        stageKey: 'second',
        attempt: 1,
        reviewSequence: 5,
        files: [],
        failureKind: null,
        summary: null,
        receipt: 'f'.repeat(64),
      });
    },
    async putBytes() {
      throw new Error('Unexpected upload');
    },
    async openBytes() {
      throw new Error('Unexpected file request');
    },
  });
  await expect(client.inspectReview('run_12345678', 'first')).rejects.toMatchObject({
    kind: 'protocol',
  });
});
