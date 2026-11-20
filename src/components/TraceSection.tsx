import type { StageKey, WorkflowJob } from '../../shared/types.ts';
import { axisTime, dateMs, elapsed, getSpans } from '../utils/workflow.ts';

interface TraceSectionProps {
  job: WorkflowJob | null;
  nowMs: number;
  onSelectStage: (stage: StageKey) => void;
}

export function TraceSection({ job, nowMs, onSelectStage }: TraceSectionProps) {
  const spans = job ? getSpans(job) : [];
  const start = spans.length
    ? Math.min(...spans.map((span) => span.start))
    : job
      ? dateMs(job.createdAt)
      : nowMs;
  const actualEnd = job?.finishedAt
    ? dateMs(job.finishedAt)
    : spans.length
      ? Math.max(...spans.map((span) => span.end || nowMs))
      : start + 12_000;
  const duration = Math.max(12_000, actualEnd - start);
  const ticks = Array.from({ length: 5 }, (_, index) => axisTime(((duration / 1000) * index) / 4));

  return (
    <section
      id="trace"
      className="mt-5 scroll-mt-6 rounded-xl border border-line bg-white p-5 shadow-2xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-en text-[11px] font-bold tracking-[0.14em] text-eyebrow uppercase">
            04 / Distributed Tracing
          </span>
          <h2 className="mt-0.5 text-lg font-bold tracking-tight text-science-blue">
            Trace explorer <span className="font-normal text-ink-muted">/ Gantt</span>
          </h2>
        </div>

        <span className="font-mono text-xs text-ink-muted tabular-nums">
          {job
            ? `${spans.length} spans · ${elapsed(
                job.startedAt || job.createdAt,
                job.finishedAt ? dateMs(job.finishedAt) : nowMs,
              )} total`
            : ''}
        </span>
      </div>

      <div className="mt-5">
        {!job ? (
          <div className="flex min-h-[120px] items-center justify-center text-xs text-ink-muted">
            No trace available
          </div>
        ) : spans.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center text-xs text-ink-muted">
            No trace data yet. Workerがジョブを取得すると表示されます。
          </div>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-[120px_1fr] items-center gap-3 sm:grid-cols-[170px_1fr]">
              <span className="font-mono text-[10px] font-semibold text-ink-muted uppercase">
                Span / Attempt
              </span>
              <div className="flex justify-between font-mono text-[10px] text-ink-muted tabular-nums">
                {ticks.map((tick, index) => (
                  <span key={`${tick}-${index}`}>{tick}</span>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {spans.map((span) => {
                const leftPct = Math.max(0, ((span.start - start) / duration) * 100);
                const widthPct = Math.max(
                  1.8,
                  (((span.end || nowMs) - span.start) / duration) * 100,
                );
                const stage = job.stages.find((item) => item.key === span.stage);
                const labelDuration = elapsed(
                  new Date(span.start).toISOString(),
                  span.end || nowMs,
                );

                // Science Tokyo CVD-safe chart colors: #435ea5 (Navy 700), #fb5b01 (Orange), #00a3bf (Cyan)
                const barTone =
                  span.status === 'failed'
                    ? 'bg-st-orange text-white border-st-orange-dark'
                    : span.status === 'running'
                      ? 'bg-st-cyan-dark text-white border-st-cyan animate-st-pulse'
                      : 'bg-navy-700 text-white border-science-blue';

                return (
                  <div
                    key={`${span.stage}-${span.attempt}`}
                    className="grid min-h-[30px] grid-cols-[120px_1fr] items-center gap-3 sm:grid-cols-[170px_1fr]"
                  >
                    <span className="truncate text-xs font-medium text-ink">
                      <span className="mr-1.5 text-eyebrow">↳</span>
                      {stage?.short || span.stage}{' '}
                      <span className="font-mono text-[10px] text-ink-muted">#{span.attempt}</span>
                    </span>
                    <div className="trace-grid-bg relative h-7 rounded-md bg-bg-2">
                      <button
                        type="button"
                        onClick={() => onSelectStage(span.stage)}
                        style={{
                          left: `${Math.min(98, leftPct).toFixed(2)}%`,
                          width: `${Math.min(widthPct, 100 - leftPct).toFixed(2)}%`,
                        }}
                        title={`${span.stage} attempt #${span.attempt}: ${labelDuration}`}
                        className={`absolute top-1 flex h-5 min-w-[8px] items-center justify-center overflow-hidden rounded border px-1.5 font-mono text-[10px] font-semibold whitespace-nowrap transition-opacity hover:opacity-90 ${barTone}`}
                      >
                        {widthPct > 9 ? labelDuration : ''}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <p className="mt-4 border-t border-line pt-3 text-[11px] text-ink-muted">
        Each bar represents an actual stage attempt. Failures and retries are retained as separate
        spans. Time axis is relative to the first step.
      </p>
    </section>
  );
}
