import { AlertTriangle, Check, Command, Loader2, RotateCw, X } from 'lucide-react';

import type { StageKey, StageStatus, WorkflowJob } from '../../shared/types.ts';
import { bytes, clock, dateMs, elapsed, getSpans, STAGE_STATUS_LABELS } from '../utils/workflow.ts';
import { StatusPill } from './StatusBadge.tsx';

interface RailwayAndInspectorProps {
  job: WorkflowJob | null;
  selectedStage: StageKey;
  nowMs: number;
  onSelectStage: (stage: StageKey) => void;
  onApproveReview: (jobId: string) => void;
}

function stageNodeClasses(status: StageStatus, selected: boolean): string {
  const ring = selected ? 'ring-2 ring-science-blue ring-offset-2' : '';
  switch (status) {
    case 'success':
      return `border-st-green bg-st-green-bg text-st-green-dark ${ring}`;
    case 'running':
      return `border-science-blue bg-science-blue text-white ${ring}`;
    case 'failed':
    case 'retry':
      return `border-st-orange bg-st-orange-bg text-st-orange-dark ${ring}`;
    case 'review':
      return `border-st-orange bg-st-orange-bg text-st-orange-dark ${ring}`;
    default:
      return `border-line bg-bg-2 text-ink-muted ${ring}`;
  }
}

export function RailwayAndInspector({
  job,
  selectedStage,
  nowMs,
  onSelectStage,
  onApproveReview,
}: RailwayAndInspectorProps) {
  const spans = job ? getSpans(job) : [];
  const failedStages = new Set(
    spans.filter((span) => span.status === 'failed').map((span) => span.stage),
  );
  const currentStage =
    job?.stages.find((stage) => stage.key === selectedStage) || job?.stages[0] || null;
  const stageHistory =
    job && currentStage ? job.events.filter((event) => event.stage === currentStage.key) : [];
  const relevantEvents = stageHistory.filter((event) =>
    [
      'stage.failed',
      'stage.progress',
      'stage.retry',
      'stage.succeeded',
      'stage.started',
      'review.required',
      'agent.event',
    ].includes(event.type),
  );
  const latestEvent = relevantEvents.at(-1);
  const stageSpans = currentStage ? spans.filter((span) => span.stage === currentStage.key) : [];

  return (
    <section
      id="railway"
      className="mt-6 grid scroll-mt-6 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(290px,0.85fr)]"
    >
      {/* Execution Railway Panel */}
      <div className="min-w-0 border-t-2 border-science-sub bg-white pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="section-heading">実行工程</h2>
          </div>
          <span className="rounded-md border border-line bg-bg-2 px-2.5 py-1 font-mono text-xs font-semibold text-science-blue">
            {job?.id || '—'}
          </span>
        </div>

        {!job ? (
          <div className="flex min-h-[220px] items-center justify-center text-xs text-ink-muted">
            Start a demo run to inspect a workflow.
          </div>
        ) : (
          <>
            <div className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-4 py-3">
              <div className="min-w-0">
                <strong className="block truncate text-sm font-bold text-science-blue">
                  {job.file}
                </strong>
                <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                  {(job.agent || 'UNASSIGNED').toUpperCase()} / {bytes(job.bytes)} /{' '}
                  {elapsed(
                    job.startedAt || job.createdAt,
                    job.finishedAt ? dateMs(job.finishedAt) : nowMs,
                  )}{' '}
                  elapsed / {job.stages.filter((stage) => stage.status === 'success').length} of{' '}
                  {job.stages.length} completed
                </p>
              </div>
              <StatusPill status={job.status} />
            </div>

            <div className="overflow-x-auto pb-2">
              <div className="min-w-[680px]">
                {/* Primary success rail */}
                <div className="relative grid grid-cols-6 gap-2">
                  <div
                    className="pointer-events-none absolute left-10 right-10 top-7 border-t-2 border-science-sub"
                    aria-hidden="true"
                  />
                  {job.stages.map((stage, index) => {
                    const isSelected = selectedStage === stage.key;
                    const duration = stage.startedAt
                      ? elapsed(stage.startedAt, stage.endedAt ? dateMs(stage.endedAt) : nowMs)
                      : '—';

                    return (
                      <button
                        key={stage.key}
                        type="button"
                        onClick={() => onSelectStage(stage.key)}
                        className="group relative z-10 flex flex-col items-center text-center"
                      >
                        <div
                          className={`flex h-14 w-14 items-center justify-center rounded-xl border-2 text-base font-bold transition-transform group-hover:-translate-y-0.5 ${stageNodeClasses(
                            stage.status,
                            isSelected,
                          )}`}
                        >
                          {stage.status === 'success' ? (
                            <Check className="h-5 w-5" strokeWidth={2.75} />
                          ) : stage.status === 'running' ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : stage.status === 'retry' ? (
                            <RotateCw className="h-5 w-5" />
                          ) : stage.status === 'failed' ? (
                            <X className="h-5 w-5" strokeWidth={2.75} />
                          ) : stage.status === 'review' ? (
                            <AlertTriangle className="h-5 w-5" />
                          ) : (
                            <span className="font-mono text-sm">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                          )}
                        </div>
                        <span className="font-en mt-2.5 text-xs font-bold text-ink">
                          {stage.short}
                        </span>
                        <span className="mt-0.5 font-mono text-xs text-ink-muted tabular-nums">
                          {duration}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Failure / Recovery Rail */}
                <div className="font-en mt-5 text-xs font-bold tracking-[0.1em] text-st-orange-dark uppercase">
                  Failure / Recovery Rail
                </div>
                <div className="relative mt-2 grid h-11 grid-cols-6 gap-2">
                  <div
                    className="pointer-events-none absolute left-10 right-10 top-4 border-t-2 border-dashed border-st-orange/60"
                    aria-hidden="true"
                  />
                  {job.stages.map((stage) => {
                    const retried = failedStages.has(stage.key);
                    return (
                      <div
                        key={stage.key}
                        className="relative z-10 flex items-start justify-center"
                      >
                        {retried && (
                          <div className="relative">
                            <span
                              className="absolute -top-4 left-1/2 h-4 -translate-x-1/2 border-l-2 border-dashed border-st-orange"
                              aria-hidden="true"
                            />
                            <span className="inline-flex items-center gap-1 rounded-md border border-st-orange/50 bg-st-orange-bg px-2 py-1 text-xs font-bold text-st-orange-dark">
                              <RotateCw className="h-2.5 w-2.5" />
                              Retried
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-4 border-t border-line pt-3.5 text-xs text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full bg-st-green" /> Success path
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full bg-st-orange" /> Failure / retry
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full bg-science-blue" /> In progress
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full bg-navy-300" /> Pending
              </span>
            </div>
          </>
        )}
      </div>

      {/* Step Inspector Panel */}
      <div className="min-w-0 border-t-2 border-science-sub bg-white pt-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="section-heading">工程の詳細</h2>
          </div>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-bg-1 text-science-blue">
            <Command className="h-4 w-4" />
          </span>
        </div>

        {!job || !currentStage ? (
          <div className="flex min-h-[220px] items-center justify-center text-xs text-ink-muted">
            Select a workflow.
          </div>
        ) : (
          <div className="mt-4">
            <div className="rounded-lg border border-line bg-bg-2 p-3.5">
              <strong className="block text-sm font-bold text-science-blue">
                {currentStage.label}
              </strong>
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-muted">
                <span className="font-mono text-xs">
                  {currentStage.short} / {currentStage.key}
                </span>
                <StatusPill
                  status={currentStage.status}
                  label={STAGE_STATUS_LABELS[currentStage.status]}
                />
              </div>
            </div>

            <dl className="mt-3 divide-y divide-line text-xs">
              <div className="flex items-center justify-between py-2">
                <dt className="text-ink-muted">Attempts</dt>
                <dd className="font-mono font-bold text-ink">{currentStage.attempts}</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-ink-muted">Elapsed</dt>
                <dd className="font-mono font-bold text-ink tabular-nums">
                  {currentStage.startedAt
                    ? elapsed(
                        currentStage.startedAt,
                        currentStage.endedAt ? dateMs(currentStage.endedAt) : nowMs,
                      )
                    : '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-ink-muted">Started at</dt>
                <dd className="font-mono font-bold text-ink tabular-nums">
                  {clock(currentStage.startedAt)}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-ink-muted">Agent events</dt>
                <dd className="font-mono font-bold text-ink">
                  {stageHistory.filter((event) => event.type === 'agent.event').length}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-ink-muted">Failed attempts</dt>
                <dd className="font-mono font-bold text-ink">
                  {stageSpans.filter((span) => span.status === 'failed').length}
                </dd>
              </div>
            </dl>

            <div className="mt-3 rounded-lg border border-line bg-bg-2 p-3 text-xs leading-relaxed text-ink">
              {latestEvent?.message || 'この工程はまだ開始していません。'}
            </div>

            {job.status === 'review' && (
              <button
                type="button"
                onClick={() => onApproveReview(job.id)}
                className="mt-3.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-science-blue px-4 py-2.5 text-xs font-bold text-white shadow-2xs transition-colors hover:bg-navy-800"
              >
                <Check className="h-4 w-4" />
                Reviewを承認して再開
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
