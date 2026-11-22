import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import { createClient } from '../client/http.ts';
import { createReviewOperations } from '../client/review.ts';
import { collectSelection, submitDataset } from '../client/upload.ts';
import { LINEAR_FIT_TEMPLATE } from '../shared/linear-fit-template.ts';
import { parseQcV1Bytes, QC_MAX_BYTES } from '../shared/qc.ts';
import type { WorkflowTemplate } from '../shared/templates.ts';
import type { WorkflowJob } from '../shared/types.ts';
import { observedCsv, qcFixture, sha256 } from './qc-fixture.ts';
import { workflowFixture } from './workflow-fixture.ts';

it('compares real reviewed outputs without changing either job or its evidence', async () => {
  const f = await workflowFixture();
  try {
    const client = createClient({ origin: new URL(f.url), requestTimeoutMs: 5000 });
    const { builtins } = await client.json<{ builtins: WorkflowTemplate[] }>(
      'GET',
      '/api/templates',
    );
    const template = builtins.find((t) => t.template.name === LINEAR_FIT_TEMPLATE.name)!;
    await f.json('/api/projects', { id: 'pair', name: 'QC pair', template });
    const input = path.join(f.home, 'observed.csv');
    writeFileSync(input, observedCsv());
    // A known bias changes predictions while both QC runs receive byte-identical observations.
    const biasedStages = structuredClone(LINEAR_FIT_TEMPLATE.stages);
    biasedStages[0].runner.code = biasedStages[0].runner.code.replace(
      'pid, value, unit)',
      'pid, value + 1, unit)',
    );
    await f.json('/api/workflow?project=pair', { stages: biasedStages }, 'PUT');
    const submit = async () =>
      (await submitDataset(client, 'pair', await collectSelection([input]))).job.id;
    const base = await submit();
    f.worker('process.exit(99)');
    await f.until(base, 'review');
    const review = createReviewOperations(client);
    const b = await review.inspectReview(base, 'qc');
    await review.approveExact(b.ref, b.receipt!, true);
    const done = await f.until(base, 'done');
    await f.json('/api/workflow?project=pair', { stages: template.definition.stages }, 'PUT');
    const id = await submit();
    const waiting = await f.until(id, 'review');
    const current = await review.inspectReview(id, 'qc');
    const raw = await fetch(
      f.url +
        `/api/jobs/${id}/review/file?task=qc&sequence=${current.ref.reviewSequence}&path=qc.json`,
      { headers: { Accept: 'application/json' } },
    );
    expect(parseQcV1Bytes(new Uint8Array(await raw.arrayBuffer()))).toEqual(qcFixture());
    const endpoint = f.url + '/api/jobs/' + id + '/qc-baseline';
    const params = new URLSearchParams({
      task: 'qc',
      sequence: String(current.ref.reviewSequence),
      baselineJobId: base,
    });
    const get = (changes = {}) =>
      fetch(endpoint + '?' + new URLSearchParams({ ...Object.fromEntries(params), ...changes }));
    const stage = done.stages.find((s) => s.key === 'qc')!;
    const file = path.join(f.home, 'projects/pair/work', base, stage.workspace!, 'qc.json');
    const original = readFileSync(file);
    expect(await (await get()).json()).toEqual({
      baselineJobId: base,
      stageKey: 'qc',
      outputHash: stage.output!.hash,
      qc: parseQcV1Bytes(original),
    });
    const baselineEvidence = parseQcV1Bytes(original);
    expect(baselineEvidence.passed).toBe(false);
    expect(baselineEvidence.observedSha256).toBe(qcFixture().observedSha256);
    expect(baselineEvidence.predictedSha256).not.toBe(qcFixture().predictedSha256);
    expect(baselineEvidence.value).toBeCloseTo(Math.sqrt(1.25));
    const currentFile = path.join(
      f.home,
      'projects/pair/work',
      id,
      waiting.stages[1].workspace!,
      'qc.json',
    );
    const currentBytes = readFileSync(currentFile);
    writeFileSync(currentFile, currentBytes.toString().replace('S-01', 'S-02'));
    for (const accept of [
      'application/json',
      'application/json, */*',
      'text/html,application/xhtml+xml,*/*',
      'text/plain, Application/JSON ; charset=utf-8',
    ]) {
      expect((await fetch(raw.url, { headers: { Accept: accept } })).status).toBe(409);
    }
    await expect(review.approveExact(current.ref, current.receipt!, false)).rejects.toMatchObject({
      status: 409,
    });
    for (const replacement of [null, Buffer.alloc(QC_MAX_BYTES + 1)]) {
      if (replacement) writeFileSync(currentFile, replacement);
      else unlinkSync(currentFile);
      const refreshed = await review.inspectReview(id, 'qc');
      expect(refreshed.files.find((file) => file.path === 'qc.json')?.bytes).toBe(
        replacement?.length,
      );
      expect((await fetch(raw.url)).status).toBe(409);
      await expect(
        review.approveExact(refreshed.ref, refreshed.receipt!, false),
      ).rejects.toMatchObject({ status: 409 });
    }
    writeFileSync(currentFile, currentBytes);
    expect((await get({ baselineJobId: id })).status).toBe(400);
    expect((await get({ path: 'other.json' })).status).toBe(400);
    expect((await fetch(endpoint)).status).toBe(400);
    const post = await fetch(endpoint + '?' + params, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
    expect((await get({ sequence: String(current.ref.reviewSequence + 1) })).status).toBe(409);
    const foreign = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'default' });
    expect((await get({ baselineJobId: foreign.job.id })).status).toBe(404);
    const pending = await submit();
    expect((await get({ baselineJobId: pending })).status).toBe(409);
    writeFileSync(file, Buffer.alloc(original.length, 32));
    expect((await get()).status).toBe(409);
    writeFileSync(file, Buffer.alloc(QC_MAX_BYTES + 1));
    expect((await get()).status).toBe(409);
    renameSync(file, file + '.saved');
    writeFileSync(file + '.saved', original);
    for (const link of [symlinkSync, linkSync]) {
      link(file + '.saved', file);
      expect((await get()).status).toBe(409);
      unlinkSync(file);
    }
    expect((await get()).status).toBe(409);
    renameSync(file + '.saved', file);
    expect(readFileSync(file)).toEqual(original);
    expect(await f.job(base)).toEqual(done);
    expect(await f.job(id)).toEqual(waiting);
  } finally {
    await f.close();
  }
});

it.each([
  ['unknown format version', JSON.stringify({ ...qcFixture(), formatVersion: 2 })],
  ['oversized recorded file', JSON.stringify(qcFixture()).padEnd(QC_MAX_BYTES + 1)],
])('rejects a baseline with %s and preserves legacy 404', async (_reason, raw) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-qc-baseline-'));
  let fixture: Awaited<ReturnType<typeof workflowFixture>> | undefined;
  try {
    const files = [
      { path: 'qc.json', bytes: Buffer.byteLength(raw), hash: sha256(raw), executable: false },
    ];
    const ids = ['run_00000001', 'run_00000002', 'run_00000003'];
    const root = path.join(home, 'projects/default/work', ids[1], 'attempt');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'qc.json'), raw);
    const stage = { key: 'qc', label: 'QC', short: 'QC' };
    const workflow = { version: 2, plan: [stage], project: { stages: [stage] } };
    const events = [
      { jobId: ids[0], type: 'job.created', workflow },
      { jobId: ids[0], type: 'review.required', stage: 'qc' },
      { jobId: ids[1], type: 'job.created', workflow },
      {
        jobId: ids[1],
        type: 'stage.succeeded',
        stage: 'qc',
        workspace: 'attempt',
        output: { files, hash: sha256(JSON.stringify(files)) },
      },
      { jobId: ids[1], type: 'job.completed' },
      { jobId: ids[2], type: 'job.created' },
      { jobId: ids[2], type: 'job.completed' },
    ];
    mkdirSync(path.join(home, 'data'));
    writeFileSync(
      path.join(home, 'data/events.jsonl'),
      events
        .map((e, i) =>
          JSON.stringify({
            ...e,
            projectId: 'default',
            sequence: i + 1,
            at: '2026-01-01T00:00:00Z',
          }),
        )
        .join('\n'),
    );
    fixture = await workflowFixture(home);
    const endpoint =
      fixture.url + '/api/jobs/' + ids[0] + '/qc-baseline?task=qc&sequence=2&baselineJobId=';
    expect((await fetch(endpoint + ids[1])).status).toBe(422);
    writeFileSync(path.join(root, 'qc.json'), '');
    expect((await fetch(endpoint + ids[1])).status).toBe(409);
    expect((await fetch(endpoint + ids[2])).status).toBe(404);
  } finally {
    if (fixture) await fixture.close();
    else rmSync(home, { recursive: true, force: true });
  }
});

it.each(['absent', 'oversized', 'unknown version'])(
  'allows manual review when the recorded QC is %s',
  async (kind) => {
    const f = await workflowFixture();
    try {
      const json = JSON.stringify({ ...qcFixture(), formatVersion: 2 });
      let code = "require('node:fs').writeFileSync('notes.txt','review notes');";
      if (kind !== 'absent')
        code += `require('node:fs').writeFileSync('qc.json',${JSON.stringify(json)}.padEnd(${kind === 'oversized' ? QC_MAX_BYTES + 1 : json.length}));`;
      const runner = { kind: 'command', program: process.execPath, args: ['-e', code] };
      await f.json('/api/projects', {
        id: 'manual',
        name: 'Manual QC review',
        graph: { mode: 'dag', publishStage: 'publish' },
        stages: [
          { key: 'qc', runner, gate: { requireReview: true } },
          {
            key: 'publish',
            dependsOn: ['qc'],
            runner: {
              ...runner,
              args: ['-e', "require('node:fs').writeFileSync('report.html','done')"],
            },
          },
        ],
      });
      const { job } = await f.json<{ job: WorkflowJob }>('/api/demo', { projectId: 'manual' });
      f.worker('process.exit(99)');
      await f.until(job.id, 'review');
      const client = createReviewOperations(
        createClient({ origin: new URL(f.url), requestTimeoutMs: 5000 }),
      );
      const current = await client.inspectReview(job.id, 'qc');
      const file = (name: string) =>
        fetch(
          f.url +
            `/api/jobs/${job.id}/review/file?task=qc&sequence=${current.ref.reviewSequence}&path=${name}`,
          { headers: { Accept: 'text/html,application/xhtml+xml,*/*' } },
        );
      expect(await (await file('notes.txt')).text()).toBe('review notes');
      const qc = await file('qc.json');
      if (kind === 'unknown version') {
        expect(qc.status).toBe(200);
        expect(await qc.text()).toBe(json);
      } else {
        expect(qc.status).toBe(kind === 'absent' ? 404 : 422);
      }
      await expect(
        client.approveExact(current.ref, current.receipt!, false),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await f.close();
    }
  },
);
