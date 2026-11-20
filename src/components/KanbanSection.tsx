import { useState } from 'react';

import type { WorkflowJob } from '../../shared/types.ts';
import { useClock } from '../api.ts';
import {
  dateMs,
  elapsed,
  KANBAN_COLUMNS,
  STATUS_LABELS,
  monitorJobHref,
  type KanbanColumnDef,
} from '../utils/workflow.ts';

const INITIAL_JOB_COUNT = 5;

export function KanbanSection({ jobs }: { jobs: WorkflowJob[] }) {
  const nowMs = useClock();
  return (
    <section
      id="board"
      aria-label="状態別のジョブ"
      className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @5xl:grid-cols-4"
    >
      {KANBAN_COLUMNS.map((column) => (
        <JobColumn
          key={column.id}
          column={column}
          jobs={jobs.filter((job) =>
            column.id === 'review'
              ? job.status === 'review' || job.status === 'failed'
              : column.id === 'queued'
                ? ['queued', 'paused', 'pausing'].includes(job.status)
                : column.id === 'running'
                  ? ['running', 'cancelling'].includes(job.status)
                  : ['done', 'cancelled'].includes(job.status),
          )}
          nowMs={nowMs}
        />
      ))}
    </section>
  );
}

function JobColumn({
  column,
  jobs,
  nowMs,
}: {
  column: KanbanColumnDef;
  jobs: WorkflowJob[];
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section
      className="flex min-w-0 flex-col bg-bg-2 p-4 sm:min-h-48"
      aria-labelledby={`column-${column.id}`}
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2
          id={`column-${column.id}`}
          lang="en"
          className="font-en text-base font-semibold text-ink"
        >
          {column.label}
        </h2>
        <span className="font-en text-sm text-ink-muted tabular-nums">{jobs.length}</span>
      </div>
      {jobs.length === 0 ? (
        <p className="py-3 text-sm text-ink-muted">{column.hint}</p>
      ) : (
        <ul className="space-y-2.5" id={`jobs-${column.id}`}>
          {(expanded ? jobs : jobs.slice(0, INITIAL_JOB_COUNT)).map((job) => (
            <li key={job.id}>
              <JobCard job={job} nowMs={nowMs} />
            </li>
          ))}
        </ul>
      )}
      {jobs.length > INITIAL_JOB_COUNT && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`jobs-${column.id}`}
          onClick={() => setExpanded(!expanded)}
          className="mt-2 w-fit py-2 text-sm font-semibold text-science-blue hover:underline"
        >
          {expanded ? '折りたたむ' : `残り${jobs.length - INITIAL_JOB_COUNT}件を表示`}
        </button>
      )}
    </section>
  );
}

function JobCard({ job, nowMs }: { job: WorkflowJob; nowMs: number }) {
  const total = Math.max(1, job.stages.length);
  const done = job.stages.filter((stage) => stage.status === 'success').length;
  const activeStage = job.stages.find(
    (stage) =>
      stage.status === 'running' ||
      stage.status === 'review' ||
      stage.status === 'failed' ||
      stage.status === 'retry',
  );
  const tag =
    job.status === 'running'
      ? activeStage?.short || 'Running'
      : job.status === 'review'
        ? 'Approval required'
        : job.status === 'failed'
          ? 'Failed'
          : `${STATUS_LABELS[job.status]} · 優先度 ${job.priority ?? 0}`;
  const start = job.startedAt || job.createdAt;
  return (
    <a
      href={monitorJobHref(job.projectId, job.id)}
      title={job.lastMessage}
      className="block w-full rounded-lg border border-line bg-white p-3 text-left hover:border-eyebrow"
    >
      <span className="block font-mono text-xs text-eyebrow">{job.id}</span>
      <strong className="mt-1 block truncate text-xs font-bold text-ink">{job.file}</strong>
      <span className="mt-0.5 block truncate text-xs text-ink-muted">{tag}</span>
      <div className="my-2.5 h-1.5 overflow-hidden rounded-full bg-bg-1">
        <div
          className={`h-full rounded-full transition-all ${
            job.status === 'failed'
              ? 'bg-st-red'
              : job.status === 'review'
                ? 'bg-st-orange'
                : job.status === 'done'
                  ? 'bg-st-green'
                  : 'bg-science-blue'
          }`}
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-1 text-xs text-ink-muted tabular-nums">
        <span className="truncate font-en font-semibold text-science-blue">
          {(job.agent || 'unassigned').toUpperCase()}
        </span>
        <span className="shrink-0 font-mono">
          {done}/{job.stages.length} ·{' '}
          {elapsed(start, job.finishedAt ? dateMs(job.finishedAt) : nowMs)}
        </span>
      </div>
    </a>
  );
}
