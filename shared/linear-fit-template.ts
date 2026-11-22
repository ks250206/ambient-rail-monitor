import {
  QC_FILENAME,
  QC_HASH_PATTERN,
  QC_ID_PATTERN,
  QC_MAX_BYTES,
  QC_MAX_POINTS,
  QC_MIN_POINTS,
  QC_RMSE_TOLERANCE,
  QC_VALIDATOR_VERSION,
  QC_V1_SCHEMA,
} from './qc.ts';

// Compose self-contained Python stages so exported templates run without the source checkout.
const imports = `import hashlib
import json
import math
import os
import re
from pathlib import Path
`;

const readCsv = `import csv
import io

def read_points(raw, measurements):
    reader = csv.reader(io.StringIO(raw.decode('utf-8'), newline=''), strict=True)
    header = next(reader, [])
    expected = ['sample_id', 'point_id', *measurements, 'unit']
    if sorted(header) != sorted(expected):
        raise ValueError(f'Expected unique CSV columns {expected}, got {header}')
    points = {}
    sample = unit = None
    for cells in reader:
        if len(points) >= ${QC_MAX_POINTS} or len(cells) != len(header):
            raise ValueError(f'Row {reader.line_num}: too many points or wrong column count')
        row = dict(zip(header, cells))
        sid, pid, u = row['sample_id'], row['point_id'], row['unit']
        if not all(re.fullmatch(r'${QC_ID_PATTERN}', key) for key in (sid, pid)):
            raise ValueError(f'Row {reader.line_num}: invalid sample_id or point_id')
        if pid in points:
            raise ValueError(f'Duplicate point_id: {pid}')
        if u not in ('mV', 'V') or (points and (sid, u) != (sample, unit)):
            raise ValueError(f'Inconsistent sample_id or unit at {pid}')
        values = tuple(float(row[name]) for name in measurements)
        if not all(map(math.isfinite, values)):
            raise ValueError(f'Non-finite measurement at {pid}')
        sample, unit = sid, u
        points[pid] = values
    if len(points) < ${QC_MIN_POINTS}:
        raise ValueError('Expected at least two points')
    return sample, unit, points

observed_bytes = (Path(os.environ['RAILFLOW_INPUT_DIR']) / 'observed.csv').read_bytes()
sample, unit, observed = read_points(observed_bytes, ['x', 'observed'])
`;

const readUpstream = `
def upstream_bytes(stage, filename, limit=None):
    manifest = json.loads(Path(os.environ['RAILFLOW_UPSTREAM_MANIFEST']).read_text(encoding='utf-8'))
    sources = [s for s in manifest['upstream'] if s['stage'] == stage and s['task'] == stage]
    if len(sources) != 1:
        raise ValueError(f'Expected one upstream {stage} task')
    source = sources[0]
    entries = [f for f in source['manifest']['files'] if f['path'] == filename]
    if len(entries) != 1:
        raise ValueError(f'Missing or duplicate {stage}/{filename} in manifest')
    with (Path(source['directory']) / filename).open('rb') as stream:
        raw = stream.read() if limit is None else stream.read(limit + 1)
    if limit is not None and len(raw) > limit:
        raise ValueError(f'{filename} exceeds the byte limit')
    if len(raw) != entries[0]['bytes'] or hashlib.sha256(raw).hexdigest() != entries[0]['hash']:
        raise ValueError(f'{stage}/{filename} differs from its manifest')
    return raw
`;

const fitCode =
  imports +
  readCsv +
  `
from fractions import Fraction

# Exact sums on binary64 inputs avoid overflow and cancellation in the normal equations.
xs, ys = zip(*observed.values())
xs = list(map(Fraction, xs))
ys = list(map(Fraction, ys))
mean_x = sum(xs) / len(xs)
mean_y = sum(ys) / len(ys)
variance = sum((x - mean_x)**2 for x in xs)
if not variance:
    raise ValueError('Cannot fit a line when all x values are equal')
slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / variance
predictions = [float(mean_y + slope * (x - mean_x)) for x in xs]
with Path('predicted.csv').open('w', encoding='utf-8', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['sample_id', 'point_id', 'predicted', 'unit'])
    writer.writerows((sample, pid, value, unit) for pid, value in zip(observed, predictions))
`;

const rmseCode = `
def rmse(values):
    scale = max(map(abs, values))
    if scale == 0:
        return 0.0
    return scale * math.sqrt(math.fsum((v / scale)**2 for v in values) / len(values))
`;

const qcCode =
  imports +
  readCsv +
  readUpstream +
  rmseCode +
  `
THRESHOLD_MV = 0.5
if not math.isfinite(THRESHOLD_MV) or THRESHOLD_MV < 0:
    raise ValueError('THRESHOLD_MV must be finite and nonnegative')
threshold = THRESHOLD_MV if unit == 'mV' else THRESHOLD_MV / 1000
predicted_bytes = upstream_bytes('fit', 'predicted.csv')
sid, u, predicted = read_points(predicted_bytes, ['predicted'])
if (sid, u) != (sample, unit):
    raise ValueError('Predicted sample_id or unit differs from observed.csv')
if predicted.keys() != observed.keys():
    raise ValueError('Predicted point_id set differs from observed.csv')
residuals = [{'pointId': pid, 'residual': y - predicted[pid][0]} for pid, (_, y) in observed.items()]
values = [point['residual'] for point in residuals]
if not all(map(math.isfinite, values)):
    raise ValueError('Non-finite residual')
value = rmse(values)
evidence = {
    'format': 'railflow.qc', 'formatVersion': 1, 'sampleId': sample, 'metricId': 'rmse',
    'unit': unit, 'validatorVersion': '${QC_VALIDATOR_VERSION}',
    'observedSha256': hashlib.sha256(observed_bytes).hexdigest(),
    'predictedSha256': hashlib.sha256(predicted_bytes).hexdigest(),
    'value': value, 'threshold': threshold, 'passed': value <= threshold, 'residuals': residuals,
}
raw = json.dumps(evidence, allow_nan=False, separators=(',', ':')).encode('utf-8')
if len(raw) > ${QC_MAX_BYTES}:
    raise ValueError('qc.json exceeds the byte limit')
temporary = Path('${QC_FILENAME}.tmp')
try:
    temporary.write_bytes(raw)
    temporary.replace('${QC_FILENAME}')
finally:
    temporary.unlink(missing_ok=True)
`;

const publishCode =
  imports +
  readUpstream +
  rmseCode +
  `
def finite(value):
    return type(value) in (int, float) and math.isfinite(value)

def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'${QC_ID_PATTERN}', value)

qc = json.loads(upstream_bytes('qc', '${QC_FILENAME}', ${QC_MAX_BYTES}).decode('utf-8'))
if not isinstance(qc, dict) or set(qc) != set(${JSON.stringify(QC_V1_SCHEMA.required)}):
    raise ValueError('Invalid QC fields')
if (qc['format'] != 'railflow.qc' or not finite(qc['formatVersion']) or qc['formatVersion'] != 1
        or qc['metricId'] != 'rmse' or qc['validatorVersion'] != '${QC_VALIDATOR_VERSION}'
        or qc['unit'] not in ('mV', 'V') or not identifier(qc['sampleId'])):
    raise ValueError('Invalid QC version, metric, sample or unit')
if not all(isinstance(qc[k], str) and re.fullmatch(r'${QC_HASH_PATTERN}', qc[k])
           for k in ('observedSha256', 'predictedSha256')):
    raise ValueError('Invalid CSV SHA-256')
points = qc['residuals']
if not isinstance(points, list) or not ${QC_MIN_POINTS} <= len(points) <= ${QC_MAX_POINTS}:
    raise ValueError('Invalid residual count')
ids = set()
for p in points:
    if (not isinstance(p, dict) or set(p) != {'pointId', 'residual'} or not identifier(p['pointId'])
            or p['pointId'] in ids or not finite(p['residual'])):
        raise ValueError('Invalid residual or duplicate pointId')
    ids.add(p['pointId'])
value, threshold, passed = qc['value'], qc['threshold'], qc['passed']
if not all(finite(v) and v >= 0 for v in (value, threshold)) or type(passed) is not bool:
    raise ValueError('Invalid QC value, threshold or decision')
actual = rmse([p['residual'] for p in points])
if abs(actual - value) > ${QC_RMSE_TOLERANCE} * max(1, abs(value)) or passed != (value <= threshold):
    raise ValueError('QC value or decision is inconsistent')
decision = '合格' if passed else '不合格'
unit = qc['unit']
Path('report.html').write_text(
    f'<!doctype html><html lang="ja"><meta charset="utf-8"><title>線形フィットの残差検証</title>'
    f'<h1>試料 {qc["sampleId"]} の残差検証</h1><p>自動QC判定: {decision}</p>'
    f'<p>RMSE: {value} {unit}</p><p>閾値: {threshold} {unit} 以下</p></html>', encoding='utf-8')
`;

const observedInput = { pattern: 'observed.csv', source: 'dataset', minFiles: 1, maxFiles: 1 };
export const LINEAR_FIT_TEMPLATE = {
  name: '線形フィットの残差検証',
  purpose:
    '単一試料のobserved.csvから直線を当てはめ、点IDごとの観測値と予測値の差からRMSEを独立に検証する。例示の合格条件はRMSEが0.5 mV以下（V入力では0.0005 V以下）。試料に適した閾値はqc工程のPythonコード内のTHRESHOLD_MVで設定する。',
  graph: { mode: 'dag', maxParallelTasks: 1, publishStage: 'publish' },
  stages: [
    {
      key: 'fit',
      label: '直線フィット',
      short: 'Fit',
      dependsOn: [],
      runner: { kind: 'python', code: fitCode },
      contracts: {
        inputs: [observedInput],
        outputs: [{ pattern: 'predicted.csv', minFiles: 1, maxFiles: 1 }],
      },
    },
    {
      key: 'qc',
      label: '残差を検証',
      short: 'QC',
      dependsOn: ['fit'],
      runner: { kind: 'python', code: qcCode },
      execution: { maxRetries: 0, onFailure: 'review' },
      contracts: {
        inputs: [
          observedInput,
          { pattern: 'fit/predicted.csv', source: 'upstream', minFiles: 1, maxFiles: 1 },
        ],
        outputs: [
          { pattern: QC_FILENAME, minFiles: 1, maxFiles: 1, schema: QC_V1_SCHEMA },
          { pattern: '**', minFiles: 1, maxFiles: 1 },
        ],
      },
      gate: {
        requireReview: true,
        condition: {
          op: 'json.value',
          path: QC_FILENAME,
          field: 'passed',
          compare: 'eq',
          value: true,
        },
      },
    },
    {
      key: 'publish',
      label: '検証結果を公開',
      short: 'Report',
      dependsOn: ['qc'],
      runner: { kind: 'python', code: publishCode },
      contracts: {
        inputs: [
          {
            pattern: 'qc/' + QC_FILENAME,
            source: 'upstream',
            minFiles: 1,
            maxFiles: 1,
            schema: QC_V1_SCHEMA,
          },
        ],
        outputs: [{ pattern: 'report.html', minFiles: 1, maxFiles: 1 }],
      },
    },
  ],
};
