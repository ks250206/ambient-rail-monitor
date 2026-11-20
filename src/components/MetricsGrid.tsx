import { Activity, AlertTriangle, Clock, Layers } from 'lucide-react';

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
    {
      label: 'Total workflows',
      value: String(jobs.length),
      foot: 'All jobs from local event store',
      icon: Layers,
      accentBorder: 'border-t-science-blue',
      valueClass: 'text-science-blue',
      iconClass: 'bg-bg-1 text-science-blue',
    },
    {
      label: 'Active agents',
      value: String(activeCount),
      foot: 'Currently claimed and executing',
      icon: Activity,
      accentBorder: 'border-t-navy-700',
      valueClass: activeCount > 0 ? 'text-st-green-dark' : 'text-science-blue',
      iconClass: 'bg-navy-100 text-eyebrow',
    },
    {
      label: 'Awaiting review',
      value: String(attentionCount),
      foot: 'Manual checks or failed jobs',
      icon: AlertTriangle,
      accentBorder: attentionCount > 0 ? 'border-t-st-orange' : 'border-t-science-sub',
      valueClass: attentionCount > 0 ? 'text-st-orange-dark' : 'text-science-blue',
      iconClass:
        attentionCount > 0 ? 'bg-st-orange-bg text-st-orange-dark' : 'bg-bg-1 text-eyebrow',
    },
    {
      label: 'Avg. run duration',
      value: completed.length ? axisTime(avgDurationMs / 1000) : '—',
      foot: 'From claim to completion',
      icon: Clock,
      accentBorder: 'border-t-science-sub',
      valueClass: 'text-science-blue',
      iconClass: 'bg-bg-1 text-science-blue',
    },
  ];

  if (loading && jobs.length === 0) {
    return (
      <div className="mt-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="h-28 animate-pulse rounded-xl border border-line bg-bg-2 p-5"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <div
            key={metric.label}
            className={`rounded-xl border border-line border-t-[3px] bg-white p-4 shadow-2xs sm:p-5 ${metric.accentBorder}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-en text-xs font-semibold text-ink-muted">{metric.label}</span>
              <span
                className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${metric.iconClass}`}
              >
                <Icon className="h-4 w-4" />
              </span>
            </div>
            <div
              className={`mt-2 font-en text-2xl font-bold tracking-tight tabular-nums sm:text-3xl ${metric.valueClass}`}
            >
              {metric.value}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-muted">{metric.foot}</p>
          </div>
        );
      })}
    </div>
  );
}
