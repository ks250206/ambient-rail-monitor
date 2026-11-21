import type { WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { axisTime, dateMs, needsApproval } from '../utils/workflow.ts';

interface MetricsGridProps {
  jobs: WorkflowJob[];
  loading: boolean;
}

export function MetricsGrid({ jobs, loading }: MetricsGridProps) {
  const { pick } = useI18n();
  const completed = jobs.filter((job) => job.status === 'done' && job.startedAt && job.finishedAt);
  const avgDurationMs = completed.length
    ? completed.reduce((acc, job) => acc + (dateMs(job.finishedAt) - dateMs(job.startedAt)), 0) /
      completed.length
    : 0;

  const activeCount = jobs.filter((job) => job.status === 'running').length;
  const reviewCount = jobs.filter(needsApproval).length;

  const metrics = [
    { label: pick('総ジョブ数', 'Total jobs'), value: jobs.length },
    { label: pick('実行中', 'Running'), value: activeCount },
    { label: pick('要承認', 'Needs approval'), value: reviewCount },
    {
      label: pick('成功したジョブの平均実行時間', 'Avg. duration (succeeded)'),
      value: completed.length ? axisTime(avgDurationMs / 1000) : '—',
    },
  ];

  return (
    <dl
      aria-label={pick('ジョブの集計', 'Job summary')}
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
