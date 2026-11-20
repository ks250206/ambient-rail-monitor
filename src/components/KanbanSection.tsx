import { RefreshCw } from 'lucide-react';

import type { WorkflowJob } from '../../shared/types.ts';
import { dateMs, elapsed, KANBAN_COLUMNS } from '../utils/workflow.ts';

interface KanbanSectionProps {
  jobs: WorkflowJob[];
  selectedJobId: string | null;
  nowMs: number;
  onSelectJob: (jobId: string) => void;
  onRefresh: () => void;
}

const COLUMN_DOT: Record<'queued' | 'running' | 'review' | 'done', string> = {
  queued: 'border-2 border-ink-muted bg-white',
  running: 'bg-navy-700 animate-st-pulse',
  review: 'bg-st-orange',
  done: 'bg-st-green',
};

export function KanbanSection({
  jobs,
  selectedJobId,
  nowMs,
  onSelectJob,
  onRefresh,
}: KanbanSectionProps) {
  return (
    <section id="board" className="mt-9 scroll-mt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="font-en text-[11px] font-bold tracking-[0.14em] text-eyebrow uppercase">
            02 / Work Queue
          </span>
          <h2 className="mt-0.5 text-lg font-bold tracking-tight text-science-blue">
            Workflow board <span className="font-normal text-ink-muted">/ Kanban</span>
          </h2>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="hidden items-center gap-1.5 rounded-md border border-line bg-bg-2 px-2.5 py-1 font-en text-[10px] font-bold tracking-wider text-eyebrow sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-st-green animate-st-pulse" />
            AUTO UPDATING
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-science-blue transition-colors hover:bg-bg-1"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {KANBAN_COLUMNS.map((column) => {
          const columnJobs = jobs.filter((job) =>
            column.id === 'review'
              ? job.status === 'review' || job.status === 'failed'
              : job.status === column.id,
          );

          return (
            <div
              key={column.id}
              className="flex min-h-[210px] flex-col rounded-xl border border-line bg-bg-2 p-3"
            >
              <div className="mb-3 flex items-center gap-2 border-b border-line pb-2.5">
                <span className={`h-2.5 w-2.5 rounded-full ${COLUMN_DOT[column.id]}`} />
                <strong className="font-en text-xs font-bold text-science-blue">
                  {column.label}
                </strong>
                <span className="ml-auto rounded-md bg-bg-1 px-2 py-0.5 font-mono text-[11px] font-bold text-science-blue">
                  {columnJobs.length}
                </span>
              </div>

              {columnJobs.length === 0 ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-navy-300 bg-white/60 p-4 text-center text-xs text-ink-muted">
                  {column.hint}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {columnJobs.slice(0, 5).map((job) => {
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
                            : '6-stage pipeline';
                    const start = job.startedAt || job.createdAt;
                    const selected = job.id === selectedJobId;

                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => onSelectJob(job.id)}
                        title={job.lastMessage}
                        className={`block w-full rounded-lg border p-3 text-left transition-all ${
                          selected
                            ? 'border-science-blue bg-white shadow-sm ring-1 ring-science-blue/25'
                            : 'border-line bg-white hover:-translate-y-0.5 hover:border-eyebrow hover:shadow-xs'
                        }`}
                      >
                        <span className="block font-mono text-[10px] text-eyebrow">{job.id}</span>
                        <strong className="mt-1 block truncate text-xs font-bold text-ink">
                          {job.file}
                        </strong>
                        <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
                          {tag}
                        </span>
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
                            style={{ width: `${(done / 6) * 100}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-ink-muted tabular-nums">
                          <span className="font-en font-semibold text-science-blue">
                            ◆ {(job.agent || 'unassigned').toUpperCase()}
                          </span>
                          <span className="font-mono">
                            {done}/6 ·{' '}
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
