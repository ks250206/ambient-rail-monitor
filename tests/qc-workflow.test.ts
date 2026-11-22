import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { observedCsv, predictedCsv, qcFixture, sha256 } from './qc-fixture.ts';
import { workflowFixture } from './workflow-fixture.ts';

function pythonFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'railflow-qc-'));
  const manifest = path.join(root, 'upstream.json');
  writeFileSync(path.join(root, 'observed.csv'), observedCsv());
  function upstream(stage: string, filename: string, data: string) {
    const directory = path.join(root, stage);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, filename), data);
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        upstream: [
          {
            task: stage,
            stage,
            directory,
            manifest: {
              files: [{ path: filename, bytes: Buffer.byteLength(data), hash: sha256(data) }],
            },
          },
        ],
      }),
    );
  }
  function run(key: string) {
    const code = LINEAR_FIT_TEMPLATE.stages.find((stage) => stage.key === key)!.runner.code;
    return spawnSync(process.env.RAILFLOW_PYTHON || 'python3', ['-c', code], {
      cwd: root,
      env: { ...process.env, RAILFLOW_INPUT_DIR: root, RAILFLOW_UPSTREAM_MANIFEST: manifest },
      encoding: 'utf8',
    });
  }
  return { root, upstream, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

it('rejoins reordered predictions by exact ID, ignores a false pass memo and hashes original bytes', () => {
  const f = pythonFixture();
  try {
    const reordered =
      'unit,predicted,point_id,sample_id\n' +
      ['mV,4,1,S-01', 'mV,3,a,S-01', 'mV,2,A,S-01', 'mV,1,01,S-01'].join('\n');
    const observations = observedCsv(1);
    writeFileSync(path.join(f.root, 'observed.csv'), observations);
    f.upstream('fit', 'predicted.csv', reordered);
    writeFileSync(path.join(f.root, 'fit', 'qc.json'), JSON.stringify({ passed: true, value: 0 }));
    const result = f.run('qc');
    expect(result.status, result.stderr).toBe(0);
    expect(parseQcV1Bytes(readFileSync(path.join(f.root, 'qc.json')))).toEqual({
      ...qcFixture(),
      value: 1,
      passed: false,
      observedSha256: sha256(observations),
      predictedSha256: sha256(reordered),
      residuals: qcFixture().residuals.map((p) => ({ ...p, residual: p.residual * 2 })),
    });

    const volts = 'unit,point_id,observed,sample_id,x\nV,B,0.0005,S,1\nV,b,-0.0005,S,2';
    writeFileSync(path.join(f.root, 'observed.csv'), volts);
    f.upstream('fit', 'predicted.csv', 'sample_id,point_id,predicted,unit\nS,b,0,V\nS,B,0,V');
    const equal = f.run('qc');
    expect(equal.status, equal.stderr).toBe(0);
    expect(parseQcV1Bytes(readFileSync(path.join(f.root, 'qc.json')))).toMatchObject({
      value: 0.0005,
      threshold: 0.0005,
      unit: 'V',
      passed: true,
    });
  } finally {
    f.close();
  }
});

it('fits a line with an intercept and computes the hand-calculated RMSE for unequal residuals', () => {
  const f = pythonFixture();
  try {
    const data = 'sample_id,point_id,x,observed,unit\nS,01,0,0,mV\nS,02,1,0,mV\nS,03,2,3,mV';
    writeFileSync(path.join(f.root, 'observed.csv'), data);
    const fit = f.run('fit');
    expect(fit.status, fit.stderr).toBe(0);
    f.upstream('fit', 'predicted.csv', readFileSync(path.join(f.root, 'predicted.csv'), 'utf8'));
    const qc = f.run('qc');
    expect(qc.status, qc.stderr).toBe(0);
    const evidence = parseQcV1Bytes(readFileSync(path.join(f.root, 'qc.json')));
    expect(evidence.residuals).toEqual([
      { pointId: '01', residual: 0.5 },
      { pointId: '02', residual: -1 },
      { pointId: '03', residual: 0.5 },
    ]);
    expect(evidence.value).toBeCloseTo(Math.sqrt(0.5), 14);
    expect(evidence.passed).toBe(false);
  } finally {
    f.close();
  }
});

it('rejects malformed CSVs and mismatched inputs before writing evidence, with a reason', () => {
  const f = pythonFixture();
  try {
    const lines = predictedCsv.trimEnd().split('\r\n');
    for (const [data, reason] of [
      [lines.slice(0, -1).join('\n'), /point_id set/],
      [[...lines, lines[1]].join('\n'), /Duplicate point_id/],
      [[...lines, 'S-01,B,0,mV'].join('\n'), /point_id set/],
      [predictedCsv.replaceAll('S-01', 'S-02'), /sample_id or unit/],
      [predictedCsv.replace('mV', 'V'), /sample_id or unit/],
      [predictedCsv.replace('1.0', 'NaN'), /Non-finite/],
      [predictedCsv.replace('1.0', 'inf'), /Non-finite/],
      [predictedCsv.replace('1.0', '1_0'), /Underscore in numeric cell/],
      [predictedCsv.replace(',01,', ',_01,'), /invalid sample_id or point_id/],
      [predictedCsv.replace('predicted,unit', 'predicted,predicted'), /unique CSV columns/],
      [predictedCsv.replace(',predicted', ''), /unique CSV columns/],
      [lines.slice(0, 2).join('\n'), /at least two/],
      [
        [lines[0], ...Array.from({ length: 4097 }, (_, i) => 'S-01,' + i + ',0,mV')].join('\n'),
        /too many points/,
      ],
    ] as const) {
      f.upstream('fit', 'predicted.csv', data);
      const result = f.run('qc');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(reason);
      expect(existsSync(path.join(f.root, 'qc.json'))).toBe(false);
    }
    f.upstream('fit', 'predicted.csv', predictedCsv);
    writeFileSync(path.join(f.root, 'fit/predicted.csv'), predictedCsv.replace('1.0', '1.1'));
    expect(f.run('qc').stderr).toMatch(/differs from its manifest/);
    for (const [data, reason] of [
      [observedCsv().replace('x,observed', 'x,x'), /unique CSV columns/],
      [observedCsv().replace('1.5', 'Infinity'), /Non-finite/],
      [observedCsv().replace('1.5', '1_0'), /Underscore in numeric cell/],
      [observedCsv().replace('S-01,A', 'other,A'), /sample_id or unit/],
      [observedCsv().replace('mV', 'K'), /sample_id or unit/],
      ['sample_id,point_id,x,observed,unit\nS,1,1,4,V\nS,2,1,8,V', /all x values are equal/],
    ] as const) {
      writeFileSync(path.join(f.root, 'observed.csv'), data);
      expect(f.run('fit').stderr).toMatch(reason);
      expect(existsSync(path.join(f.root, 'predicted.csv'))).toBe(false);
    }
  } finally {
    f.close();
  }
});

it('leaves no partial predictions on overflow or failed replacement', () => {
  const f = pythonFixture();
  try {
    const observed = path.join(f.root, 'observed.csv');
    const predicted = path.join(f.root, 'predicted.csv');
    // The fitted value at x=2 is 4/3 of the largest finite float.
    const rows = [-Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE].map((value, x) =>
      ['S', x, x, value, 'V'].join(','),
    );
    writeFileSync(observed, ['sample_id,point_id,x,observed,unit', ...rows].join('\n'));
    const overflow = f.run('fit');
    expect(overflow.status).toBe(1);
    expect(overflow.stderr).toMatch(/OverflowError|Non-finite fitted prediction/);
    expect(existsSync(predicted)).toBe(false);
    expect(existsSync(predicted + '.tmp')).toBe(false);

    writeFileSync(observed, observedCsv());
    mkdirSync(predicted);
    expect(f.run('fit').status).toBe(1);
    expect(existsSync(predicted + '.tmp')).toBe(false);
  } finally {
    f.close();
  }
});

it('stops publication on missing, malformed or internally inconsistent evidence', () => {
  const f = pythonFixture();
  try {
    f.upstream('qc', 'other.json', '{}');
    expect(f.run('publish').stderr).toMatch(/Missing or duplicate/);
    const qc = qcFixture();
    const serialized = JSON.stringify(qc);
    for (const token of ['NaN', 'Infinity', '-Infinity']) {
      f.upstream('qc', 'qc.json', serialized.replace('"value":0.5', '"value":' + token));
      const result = f.run('publish');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid JSON constant: ' + token);
      expect(existsSync(path.join(f.root, 'report.html'))).toBe(false);
    }
    for (const data of [
      '{',
      serialized.replace('"formatVersion":1', '"formatVersion":1.0'),
      ' '.repeat(QC_MAX_BYTES + 1),
      ...[
        { formatVersion: 2 },
        { formatVersion: true },
        { extra: false },
        { value: 0.49 },
        { value: '0.5' },
        { passed: false },
        { passed: 1 },
        { threshold: null },
        { unit: 'A' },
        { observedSha256: 'X'.repeat(64) },
        { residuals: [...qc.residuals, qc.residuals[0]] },
      ].map((changes) => JSON.stringify({ ...qc, ...changes })),
    ]) {
      f.upstream('qc', 'qc.json', data);
      expect(f.run('publish').status).toBe(1);
      expect(existsSync(path.join(f.root, 'report.html'))).toBe(false);
    }
  } finally {
    f.close();
  }
});

it.each([0, 0.5, 1])('runs fit → QC → review → publication with RMSE %s mV', async (amplitude) => {
  const f = await workflowFixture();
  try {
    const client = createClient({ origin: new URL(f.url), requestTimeoutMs: 5000 });
    const catalog = await client.json<{ builtins: WorkflowTemplate[] }>('GET', '/api/templates');
    const template = catalog.builtins.find((t) => t.template.name === LINEAR_FIT_TEMPLATE.name)!;
    await f.json('/api/templates/validate', { template });
    await f.json('/api/projects', { id: 'fit-qc', name: 'QC test', template });
    const observed = path.join(f.home, 'observed.csv');
    writeFileSync(observed, observedCsv(amplitude));
    const { job } = await submitDataset(client, 'fit-qc', await collectSelection([observed]));
    f.worker('process.exit(99)');
    const waiting = await f.until(job.id, 'review');
    const passed = amplitude <= 0.5;
    expect(waiting.stages.map((task) => task.status)).toEqual(['success', 'review', 'pending']);
    expect(waiting.artifacts).toHaveLength(0);
    const qcStage = waiting.stages[1];
    expect(qcStage.attempts).toBe(1);
    expect(qcStage.gates).toContainEqual(
      expect.objectContaining({
        scope: 'stage',
        result: expect.objectContaining({ status: passed ? 'pass' : 'fail', actual: passed }),
      }),
    );
    const review = createReviewOperations(client);
    const target = await review.inspectReview(job.id, 'qc');
    expect(target.failureKind).toBe(passed ? null : 'acceptance_failed');
    expect(target.files.map((file) => file.path)).toContain('qc.json');
    expect(qcStage.output?.files.map((file) => file.path)).toEqual(['qc.json']);
    const workspace = path.join(f.home, 'projects/fit-qc/work', job.id);
    const evidenceFile = path.join(workspace, qcStage.workspace!, 'qc.json');
    const raw = readFileSync(evidenceFile);
    const evidence = parseQcV1Bytes(raw);
    expect(evidence).toEqual({
      ...qcFixture(),
      observedSha256: sha256(observedCsv(amplitude)),
      value: amplitude,
      passed,
      residuals: qcFixture().residuals.map((p) => ({
        ...p,
        residual: amplitude === 0 ? 0 : p.residual * 2 * amplitude,
      })),
    });
    expect(target.receipt).toBeTruthy();
    expect(await review.approveExact(target.ref, target.receipt!, !passed)).toMatchObject({
      exception: !passed,
    });
    const done = await f.until(job.id, 'done');
    const report = await (
      await fetch(f.url + done.artifacts.find((a) => a.name === 'report.html')!.uri)
    ).text();
    expect(report).toContain('自動QC判定: ' + (passed ? '合格' : '不合格'));
    expect(report).toContain('RMSE: ' + amplitude.toFixed(1) + ' mV');
    expect(report).toContain('閾値: 0.5 mV');
    expect(readFileSync(evidenceFile)).toEqual(raw);
    const provenance = await client.json<{ job: WorkflowJob }>(
      'GET',
      '/api/jobs/' + job.id + '/provenance',
    );
    const archived = provenance.job.stages[1];
    expect(archived.attempts).toBe(1);
    expect(archived.approvedAttempt).toBe(1);
    expect(archived.failureKind ?? null).toBe(target.failureKind);
    expect(archived.gates).toEqual(qcStage.gates);
    expect(archived.output?.files).toMatchObject([{ path: 'qc.json', hash: sha256(raw) }]);
    expect(provenance.job.events.filter((e) => e.type === 'review.approved')).toMatchObject([
      { stage: 'qc', attempt: 1 },
    ]);
  } finally {
    await f.close();
  }
});

it('retains the reason for an incomplete prediction and stops publication after exception approval', async () => {
  const f = await workflowFixture();
  try {
    const client = createClient({ origin: new URL(f.url), requestTimeoutMs: 5000 });
    const stages = structuredClone(LINEAR_FIT_TEMPLATE.stages);
    // Emulate a fit that exited successfully after writing only two of four predictions.
    stages[0].runner.code =
      "from pathlib import Path\nPath('predicted.csv').write_text(" +
      JSON.stringify(predictedCsv.trimEnd().split('\r\n').slice(0, 3).join('\n')) +
      ", encoding='utf-8')";
    await f.json('/api/projects', { ...LINEAR_FIT_TEMPLATE, id: 'incomplete', stages });
    const file = path.join(f.home, 'observed.csv');
    writeFileSync(file, observedCsv());
    const { job } = await submitDataset(client, 'incomplete', await collectSelection([file]));
    f.worker('process.exit(99)');
    const waiting = await f.until(job.id, 'review');
    expect(waiting.stages[1]).toMatchObject({
      attempts: 1,
      failureKind: 'execution_error',
      output: { files: [] },
    });
    expect(
      waiting.events.some((e) => e.stage === 'qc' && e.message?.includes('point_id set differs')),
    ).toBe(true);
    const reviews = createReviewOperations(client);
    const target = await reviews.inspectReview(job.id, 'qc');
    await reviews.approveExact(target.ref, target.receipt!, true);
    const failed = await f.until(job.id, 'failed');
    expect(failed.artifacts).toEqual([]);
    expect(failed.stages[2].gates).toContainEqual(
      expect.objectContaining({
        scope: 'input',
        result: expect.objectContaining({ status: 'fail' }),
      }),
    );
  } finally {
    await f.close();
  }
});
