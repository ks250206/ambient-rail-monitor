import type { WorkflowJob } from '../../shared/types.ts';
import { axisTime, dateMs } from '../utils/workflow.ts';

interface MetricsGridProps {
  jobs: WorkflowJob[];
  loading: boolean;
}

export function MetricsGrid({ jobs, loading }: MetricsGridProps) {
  const completed = jobs.filter((job) => job.status === 'done' && job.startedAt && job.finishedAt);
  const avgDurationMs = completed.length
    ? completed.reduce((acc, job) => acc + (dateMs(job.finishedAt) - dateMs(job.startedAt)), 0) /
      completed.length
    : 0;

  const activeCount = jobs.filter((job) => job.status === 'running').length;
  const attentionCount = jobs.filter(
    (job) => job.status === 'review' || job.status === 'failed',
  ).length;

  const metrics = [
    { label: '総ジョブ数', value: jobs.length },
    { label: '実行中', value: activeCount },
    { label: '要対応（レビュー・失敗）', value: attentionCount },
    { label: '平均実行時間', value: completed.length ? axisTime(avgDurationMs / 1000) : '—' },
  ];

  return (
    <dl
      aria-label="ジョブの集計"
      aria-busy={loading}
      className="mt-6 grid grid-cols-2 gap-px border-y border-line bg-line sm:mt-8 md:grid-cols-4"
    >
      {metrics.map(({ label, value }) => (
        <div key={label} className="bg-bg-2 px-4 py-4 sm:px-6">
          <dt className="text-sm font-medium text-ink">{label}</dt>
          <dd className="mt-1 font-en text-3xl font-semibold leading-tight text-science-blue tabular-nums sm:text-4xl">
            {loading ? '…' : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
