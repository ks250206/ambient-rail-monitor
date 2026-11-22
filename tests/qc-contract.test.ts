import { expect, it } from 'vite-plus/test';
import { parseQcV1, parseQcV1Bytes, QC_MAX_BYTES, sameQcComparisonKey } from '../shared/qc.ts';
import { qcFixture } from './qc-fixture.ts';

it('parses versioned evidence from UTF-8 bytes and enforces the file limit before decoding', () => {
  const qc = qcFixture();
  const serialized = JSON.stringify(qc);
  expect(parseQcV1Bytes(Buffer.from(serialized.padEnd(QC_MAX_BYTES)))).toEqual(qc);
  expect(() => parseQcV1Bytes(Buffer.from(serialized.padEnd(QC_MAX_BYTES + 1)))).toThrow();
  expect(() => parseQcV1Bytes(Uint8Array.of(0xff))).toThrow();
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serialized)]);
  expect(() => parseQcV1Bytes(withBom)).toThrow();
});

it('rejects malformed or inconsistent QC evidence', () => {
  const qc = qcFixture();
  for (const changes of [
    { format: 'other' },
    { formatVersion: 2 },
    { validatorVersion: 'residual-rmse/2' },
    { metricId: 'mae' },
    { unit: 'mA' },
    { sampleId: '.id' },
    { sampleId: 'A\n' },
    { observedSha256: 'G'.repeat(64) },
    { predictedSha256: 'a'.repeat(63) },
    { review: 'accepted' },
    { passed: false },
    { passed: 1 },
    { passed: null },
    { value: Infinity },
    { value: NaN },
    { value: -1 },
    { threshold: -1 },
    { value: '0.5' },
    { value: 0.4 },
    { threshold: qc.value - Number.EPSILON },
    { residuals: [] },
    { residuals: [qc.residuals[0]] },
    { residuals: Array.from({ length: 4097 }, (_, i) => ({ pointId: String(i), residual: 0.5 })) },
    ...[
      null,
      { pointId: '01', residual: -0.5 },
      { pointId: '_1', residual: 0 },
      { pointId: 'b', residual: NaN },
      { pointId: 'b', residual: null },
      { pointId: 'b' },
      { pointId: 'b', residual: '0' },
      { pointId: 'b', residual: 0, extra: false },
    ].map((p) => ({ residuals: [qc.residuals[0], p] })),
  ])
    expect(() => parseQcV1({ ...qc, ...changes })).toThrow();
  for (const key of Object.keys(qc))
    expect(() =>
      parseQcV1(Object.fromEntries(Object.entries(qc).filter(([k]) => k !== key))),
    ).toThrow();
});

it('checks scaled RMSE with the specified tolerance and compares the saved value exactly', () => {
  const qc = qcFixture();
  expect(parseQcV1({ ...qc, value: 0.5 + 0.5e-12, passed: false }).passed).toBe(false);
  expect(() => parseQcV1({ ...qc, value: 0.5 + 2e-12, passed: false })).toThrow();
  for (const value of [0, Number.MIN_VALUE, Number.MAX_VALUE]) {
    const residuals = qc.residuals.map((p) => ({ ...p, residual: -value }));
    expect(parseQcV1({ ...qc, residuals, value, threshold: value }).value).toBe(value);
  }
});

it('uses the four exact comparison fields independently of dataset identity and results', () => {
  const qc = qcFixture();
  for (const changes of [
    { sampleId: 's-01' },
    { unit: 'V' },
    { metricId: 'mae' },
    { validatorVersion: 'residual-rmse/2' },
  ])
    expect(sameQcComparisonKey(qc, { ...qc, ...changes } as typeof qc)).toBe(false);
  expect(
    sameQcComparisonKey(qc, {
      ...qc,
      observedSha256: 'a'.repeat(64),
      predictedSha256: 'b'.repeat(64),
      threshold: 0,
      passed: false,
    }),
  ).toBe(true);
});
