import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

import type { WorkflowJob } from '../../shared/types.ts';
import { dateMs, elapsed, KANBAN_COLUMNS } from '../utils/workflow.ts';

interface KanbanSectionProps {
  children: ReactNode;
  jobs: WorkflowJob[];
  selectedJobId: string | null;
  nowMs: number;
  onSelectJob: (jobId: string) => void;
  onRefresh: () => void;
}

export function KanbanSection({
  children,
  jobs,
  selectedJobId,
  nowMs,
  onSelectJob,
  onRefresh,
}: KanbanSectionProps) {
  return (
    <section id="board" className="scroll-mt-6 border-t border-line pt-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="section-heading">ジョブボード</h3>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-science-blue transition-colors hover:bg-bg-1"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            更新
          </button>
        </div>
      </div>

      {children}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KANBAN_COLUMNS.map((column) => {
          const columnJobs = jobs.filter((job) =>
            column.id === 'review'
              ? job.status === 'review' || job.status === 'failed'
              : job.status === column.id,
          );

          return (
            <div key={column.id} className="flex min-w-0 flex-col bg-bg-2 p-4 sm:min-h-48">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h4 lang="en" className="font-en text-base font-semibold text-ink">
                  {column.label}
                </h4>
                <span className="font-en text-sm text-ink-muted tabular-nums">
                  {columnJobs.length}
                </span>
              </div>

              {columnJobs.length === 0 ? (
                <div className="py-3 text-sm text-ink-muted">{column.hint}</div>
              ) : (
                <div className="space-y-2.5">
                  {columnJobs.slice(0, 5).map((job) => {
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
                            : `${job.stages.length}-stage pipeline`;
                    const start = job.startedAt || job.createdAt;
                    const selected = job.id === selectedJobId;

                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => onSelectJob(job.id)}
                        aria-pressed={selected}
                        title={job.lastMessage}
                        className={`block w-full rounded-lg border p-3 text-left transition-all ${
                          selected
                            ? 'border-science-blue bg-white ring-1 ring-science-blue'
                            : 'border-line bg-white hover:border-eyebrow'
                        }`}
                      >
                        <span className="block font-mono text-xs text-eyebrow">{job.id}</span>
                        <strong className="mt-1 block truncate text-xs font-bold text-ink">
                          {job.file}
                        </strong>
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
                        <div className="flex items-center justify-between text-xs text-ink-muted tabular-nums">
                          <span className="font-en font-semibold text-science-blue">
                            {(job.agent || 'unassigned').toUpperCase()}
                          </span>
                          <span className="font-mono">
                            {done}/{job.stages.length} ·{' '}
                            {elapsed(start, job.finishedAt ? dateMs(job.finishedAt) : nowMs)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
