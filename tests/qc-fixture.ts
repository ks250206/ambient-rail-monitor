import { createHash } from 'node:crypto';
import type { QcV1 } from '../shared/qc.ts';

export const qcPointIds = ['01', 'A', 'a', '1'];
export const sha256 = (raw: string | Uint8Array) => createHash('sha256').update(raw).digest('hex');

// The fitted line is y = x + 1. The signed deviations have zero sum and zero covariance with x.
export function observedCsv(amplitude = 0.5, unit: QcV1['unit'] = 'mV') {
  const offsets = [amplitude, -amplitude, -amplitude, amplitude];
  return (
    [
      'sample_id,point_id,x,observed,unit',
      ...qcPointIds.map((id, x) => ['S-01', id, x, x + 1 + offsets[x], unit].join(',')),
    ].join('\r\n') + '\r\n'
  );
}

export const predictedCsv =
  [
    'sample_id,point_id,predicted,unit',
    ...qcPointIds.map((id, x) => ['S-01', id, (x + 1).toFixed(1), 'mV'].join(',')),
  ].join('\r\n') + '\r\n';

/** Fresh, valid evidence at the inclusive threshold, with the hashes of the exact CSV fixtures. */
export function qcFixture(): QcV1 {
  return {
    format: 'railflow.qc',
    formatVersion: 1,
    sampleId: 'S-01',
    metricId: 'rmse',
    unit: 'mV',
    validatorVersion: 'residual-rmse/1',
    observedSha256: sha256(observedCsv()),
    predictedSha256: sha256(predictedCsv),
    value: 0.5,
    threshold: 0.5,
    passed: true,
    residuals: qcPointIds.map((pointId, x) => ({ pointId, residual: [0.5, -0.5, -0.5, 0.5][x] })),
  };
}
