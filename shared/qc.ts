import { validateJson, type JsonSchema } from './contracts.ts';

export const QC_FILENAME = 'qc.json';
export const QC_MAX_BYTES = 2 * 1024 * 1024;
export const QC_MIN_POINTS = 2;
export const QC_MAX_POINTS = 4096;
export const QC_VALIDATOR_VERSION = 'residual-rmse/1';
export const QC_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
export const QC_HASH_PATTERN = '[0-9a-f]{64}';
export const QC_RMSE_TOLERANCE = 1e-12;

export interface QcV1 {
  format: 'railflow.qc';
  formatVersion: 1;
  sampleId: string;
  metricId: 'rmse';
  unit: 'mV' | 'V';
  validatorVersion: typeof QC_VALIDATOR_VERSION;
  observedSha256: string;
  predictedSha256: string;
  value: number;
  threshold: number;
  passed: boolean;
  residuals: Array<{ pointId: string; residual: number }>;
}

function exactObject(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const identifier: JsonSchema = { type: 'string', minLength: 1, maxLength: 64 };
const digest: JsonSchema = { type: 'string', minLength: 64, maxLength: 64 };
export const QC_V1_SCHEMA = exactObject({
  format: { type: 'string', enum: ['railflow.qc'] },
  formatVersion: { type: 'integer', enum: [1] },
  sampleId: identifier,
  metricId: { type: 'string', enum: ['rmse'] },
  unit: { type: 'string', enum: ['mV', 'V'] },
  validatorVersion: { type: 'string', enum: [QC_VALIDATOR_VERSION] },
  observedSha256: digest,
  predictedSha256: digest,
  value: { type: 'number', minimum: 0 },
  threshold: { type: 'number', minimum: 0 },
  passed: { type: 'boolean' },
  residuals: {
    type: 'array',
    minItems: QC_MIN_POINTS,
    maxItems: QC_MAX_POINTS,
    items: exactObject({ pointId: identifier, residual: { type: 'number' } }),
  },
} satisfies Record<keyof QcV1, JsonSchema>);

const id = new RegExp('^' + QC_ID_PATTERN + '$');
const hash = new RegExp('^' + QC_HASH_PATTERN + '$');

/** Validate a decoded JSON value, including relationships outside the file-contract schema. */
export function parseQcV1(input: unknown): QcV1 {
  const errors = validateJson(input, QC_V1_SCHEMA);
  if (errors.length) throw new Error(errors.join('; '));
  const qc = input as QcV1;
  if (!id.test(qc.sampleId)) throw new Error('Invalid sampleId');
  if (!hash.test(qc.observedSha256) || !hash.test(qc.predictedSha256))
    throw new Error('Invalid CSV SHA-256');
  const seen = new Set<string>();
  let scale = 0;
  for (const point of qc.residuals) {
    if (!point || !id.test(point.pointId) || seen.has(point.pointId))
      throw new Error('Invalid or duplicate pointId');
    seen.add(point.pointId);
    scale = Math.max(scale, Math.abs(point.residual));
  }
  // Scale before squaring so finite residuals near either floating-point limit are supported.
  const rmse =
    scale === 0
      ? 0
      : scale *
        Math.sqrt(qc.residuals.reduce((sum, p) => sum + (p.residual / scale) ** 2, 0) / seen.size);
  if (!Number.isFinite(rmse)) throw new Error('Non-finite RMSE');
  if (Math.abs(qc.value - rmse) > QC_RMSE_TOLERANCE * Math.max(1, Math.abs(qc.value)))
    throw new Error('RMSE does not match residuals');
  const passed = qc.value <= qc.threshold;
  if (qc.passed !== passed) throw new Error('QC decision does not match threshold');
  return qc;
}

/** Use on the original artifact bytes, before decoding or displaying evidence. */
export function parseQcV1Bytes(bytes: Uint8Array): QcV1 {
  if (bytes.byteLength > QC_MAX_BYTES) throw new Error('qc.json exceeds 2 MiB');
  return parseQcV1(
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)),
  );
}

/** Callers independently check project identity and observedSha256 before comparing. */
export function sameQcComparisonKey(a: QcV1, b: QcV1): boolean {
  return (
    a.sampleId === b.sampleId &&
    a.metricId === b.metricId &&
    a.unit === b.unit &&
    a.validatorVersion === b.validatorVersion
  );
}
