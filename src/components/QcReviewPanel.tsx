import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { QC_FILENAME, parseQcV1, sameQcComparisonKey, type QcV1 } from '../../shared/qc.ts';
import type { WorkflowJob } from '../../shared/types.ts';
import { ApiError, fetchReviewQc, request, useProjectJobs, type InspectedOutput } from '../api.ts';
import { useI18n } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';

function QcSummary({ qc, label }: { qc: QcV1; label: string }) {
  const { pick } = useI18n();
  return (
    <section>
      <h5>
        {label} · {pick('試料', 'Sample')} {qc.sampleId}
      </h5>
      <p>
        RMSE{' '}
        <strong>
          {qc.value} {qc.unit}
        </strong>{' '}
        · {pick('閾値', 'Threshold')} ≤ {qc.threshold} {qc.unit}
      </p>
      <p>
        {pick('自動QC判定', 'Automated QC')} ·{' '}
        {qc.passed ? pick('合格', 'Pass') : pick('不合格', 'Fail')}
      </p>
    </section>
  );
}

function QcComparison({ current, baseline }: { current: QcV1; baseline: QcV1 }) {
  const { pick } = useI18n();
  const mismatches = [];
  if (!sameQcComparisonKey(current, baseline)) {
    for (const [key, label] of [
      ['sampleId', pick('試料', 'Sample')],
      ['metricId', pick('指標', 'Metric')],
      ['unit', pick('単位', 'Unit')],
      ['validatorVersion', pick('検証器版', 'Validator version')],
    ] as const) {
      if (current[key] !== baseline[key]) mismatches.push(label);
    }
  }
  if (current.observedSha256 !== baseline.observedSha256)
    mismatches.push(pick('観測データのハッシュ', 'Observed data hash'));
  const byId = new Map(baseline.residuals.map((p) => [p.pointId, p.residual]));
  if (current.residuals.length !== byId.size || current.residuals.some((p) => !byId.has(p.pointId)))
    mismatches.push(pick('測定点IDの集合', 'Point ID set'));
  if (mismatches.length)
    return (
      <p role="status">
        {pick('比較できません。一致しない項目：', 'Cannot compare. Mismatched fields: ')}
        {mismatches.join(', ')}
      </p>
    );

  const delta = current.value - baseline.value;
  const series = [
    {
      label: pick('今回', 'Current'),
      color: '#193c83',
      values: current.residuals.map((p) => p.residual),
    },
    {
      label: pick('基準', 'Baseline'),
      color: '#9c4812',
      values: current.residuals.map((p) => byId.get(p.pointId)!),
    },
  ];
  const peak = Math.max(...series.flatMap((s) => s.values.map(Math.abs))) || 1;
  const yAxis = pick('符号付き残差', 'Signed residual') + ' (' + current.unit + ')';
  const xAxis = pick('測定点（今回の観測行順）', 'Measurement point (current observation order)');
  return (
    <>
      <p>
        {pick('RMSE差（今回 − 基準）', 'RMSE difference (current − baseline)')}{' '}
        <strong>
          {delta > 0 ? '+' : ''}
          {delta} {current.unit}
        </strong>
      </p>
      <figure className="max-w-xl">
        <figcaption>
          {yAxis} · {pick('実線：今回 / 破線：基準', 'Solid: current / dashed: baseline')}
        </figcaption>
        <svg
          viewBox="0 0 420 164"
          role="img"
          aria-label={yAxis + ' · ' + xAxis}
          className="w-full"
          fontSize="11"
        >
          <path d="M78 12 V132 H406 M78 72 H406" fill="none" stroke="#aab2c2" />
          {[peak, 0, -peak].map((v, i) => (
            <text key={i} x="72" y={16 + 60 * i} textAnchor="end">
              {Number.isInteger(v) && Math.abs(v) < 1e7 ? v : v.toExponential(2)}
            </text>
          ))}
          <text x="78" y="148">
            1
          </text>
          <text x="406" y="148" textAnchor="end">
            {current.residuals.length}
          </text>
          <text x="242" y="160" textAnchor="middle">
            {xAxis}
          </text>
          {series.map(({ label, color, values }, i) => (
            <polyline
              key={label}
              aria-label={label}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeDasharray={i ? '5 4' : undefined}
              points={values
                .map((v, j) => 78 + (328 * j) / (values.length - 1) + ',' + (72 - 60 * (v / peak)))
                .join(' ')}
            />
          ))}
        </svg>
      </figure>
    </>
  );
}

export function QcReviewPanel({
  job,
  review,
  inspection,
  onReload,
  onTargetChanged,
}: {
  job: WorkflowJob;
  review: InspectedOutput;
  inspection: number;
  onReload: () => Promise<void>;
  onTargetChanged: () => void;
}) {
  const { pick } = useI18n();
  const [selected, setSelected] = useState('');
  const project = useProjectJobs(job.projectId);
  const candidates = (project.data?.jobs ?? []).filter(
    (j) =>
      j.id !== job.id &&
      j.projectId === job.projectId &&
      j.status === 'done' &&
      j.workflow?.version === 2 &&
      j.stages.some((s) => s.key === 'qc' && s.status === 'success'),
  );
  const baselineJobId = candidates.find((j) => j.id === selected)?.id;
  const file = review.files.find((f) => f.path === QC_FILENAME);
  const key = [job.id, review.stageKey, review.reviewSequence, inspection];
  const current = useQuery({
    queryKey: ['review-qc', ...key],
    enabled: !!file,
    retry: false,
    queryFn: ({ signal }) =>
      fetchReviewQc(job.id, review.stageKey, review.reviewSequence, file!.bytes, signal),
  });
  useEffect(() => {
    if (current.error instanceof ApiError && current.error.status === 409) onTargetChanged();
  }, [current.error, onTargetChanged]);
  const baseline = useQuery({
    queryKey: ['review-qc-baseline', ...key, baselineJobId],
    enabled: !!baselineJobId && current.isSuccess,
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        task: review.stageKey,
        sequence: String(review.reviewSequence),
        baselineJobId: baselineJobId!,
      });
      const result = await request<{ baselineJobId: string; stageKey: string; qc: unknown }>(
        `/api/jobs/${job.id}/qc-baseline?${params}`,
        { signal },
      );
      if (result.baselineJobId !== baselineJobId || result.stageKey !== review.stageKey)
        throw new Error('Unexpected baseline job or task');
      return parseQcV1(result.qc);
    },
  });
  function errorDetails(error: Error) {
    if (error instanceof ApiError && error.status === 409)
      return (
        <>
          {pick(
            'ジョブまたは出力が更新されています。再取得して確認してください。',
            'The job or its output has changed. Reload and inspect it again.',
          )}
          <button type="button" className="wf-secondary" onClick={() => void onReload()}>
            {pick('出力を再取得', 'Reload outputs')}
          </button>
        </>
      );
    if (error.message.includes('validatorVersion'))
      return pick('未対応または不正な検証器版です。', 'Unsupported or invalid validatorVersion.');
    if (error.message.includes('formatVersion'))
      return pick('未対応または不正なQC形式の版です。', 'Unsupported or invalid formatVersion.');
    return error.message;
  }
  return (
    <section className="my-3 space-y-3 border-l-2 border-science-blue pl-3">
      <h4>{pick('承認前のQC比較', 'Pre-approval QC comparison')}</h4>
      {!file ? (
        <p>
          {pick('この試行のルートに qc.json がありません。', 'This attempt has no root qc.json.')}
        </p>
      ) : current.isError ? (
        <p role="alert">
          {pick('今回のQCを確認できません。', 'Cannot read current QC.')}{' '}
          {errorDetails(current.error)}
        </p>
      ) : !current.isSuccess || current.isFetching ? (
        <p role="status">{pick('今回のQCを読み込み中…', 'Loading current QC…')}</p>
      ) : (
        <>
          <QcSummary qc={current.data} label={pick('今回', 'Current')} />
          <CustomSelect
            ariaLabel={pick('基準ジョブ', 'Baseline job')}
            value={baselineJobId ?? ''}
            onChange={setSelected}
            options={[
              { value: '', label: pick('基準ジョブを選択', 'Select a baseline job') },
              ...candidates.map((j) => ({ value: j.id, label: j.file + ' · ' + j.id })),
            ]}
          />
          {baselineJobId &&
            (baseline.isError ? (
              <p role="alert">
                {pick('基準のQCを確認できません。', 'Cannot read baseline QC.')}{' '}
                {errorDetails(baseline.error)}
              </p>
            ) : !baseline.isSuccess || baseline.isFetching ? (
              <p role="status">{pick('基準を読み込み中…', 'Loading baseline…')}</p>
            ) : (
              <>
                <QcSummary qc={baseline.data} label={pick('基準', 'Baseline')} />
                <QcComparison current={current.data} baseline={baseline.data} />
              </>
            ))}
        </>
      )}
    </section>
  );
}
