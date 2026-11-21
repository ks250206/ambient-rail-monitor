import type { StageKey, WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { axisTime, dateMs, elapsed, getSpans } from '../utils/workflow.ts';

interface TraceSectionProps {
  job: WorkflowJob | null;
  nowMs: number;
  onSelectStage: (stage: StageKey) => void;
}

export function TraceSection({ job, nowMs, onSelectStage }: TraceSectionProps) {
  const { pick } = useI18n();
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
    <section id="trace" className="mt-5 scroll-mt-6 border-t-2 border-science-sub bg-white pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="section-heading">{pick('トレース', 'Trace')}</h3>
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
            {pick('トレースがありません', 'No trace available')}
          </div>
        ) : spans.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center text-xs text-ink-muted">
            {pick(
              'まだトレースデータがありません。ワーカーがジョブを取得すると表示されます。',
              'No trace data yet. Spans appear once a worker claims the job.',
            )}
          </div>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-[120px_1fr] items-center gap-3 sm:grid-cols-[170px_1fr]">
              <span className="font-mono text-xs font-semibold text-ink-muted uppercase">
                {pick('工程 / 試行', 'Span / Attempt')}
              </span>
              <div className="flex justify-between font-mono text-xs text-ink-muted tabular-nums">
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

                const barTone =
                  span.status === 'failed'
                    ? 'bg-st-orange-dark text-white border-st-orange-dark'
                    : span.status === 'running'
                      ? 'bg-st-cyan-dark text-white border-st-cyan'
                      : 'bg-navy-700 text-white border-science-blue';

                return (
                  <div
                    key={`${span.stage}-${span.attempt}`}
                    className="grid min-h-[30px] grid-cols-[120px_1fr] items-center gap-3 sm:grid-cols-[170px_1fr]"
                  >
                    <span className="text-xs font-medium text-ink">
                      <span className="mr-1.5 text-eyebrow">↳</span>
                      {stage?.short || span.stage}{' '}
                      <span className="text-xs text-ink-muted">
                        #{span.attempt} · {span.status}
                      </span>
                    </span>
                    <div className="trace-grid-bg relative h-7 rounded-md bg-bg-2">
                      <button
                        type="button"
                        onClick={() => onSelectStage(span.stage)}
                        style={{
                          left: `${Math.min(98, leftPct).toFixed(2)}%`,
                          width: `${Math.min(widthPct, 100 - leftPct).toFixed(2)}%`,
                        }}
                        aria-label={`${span.stage} attempt #${span.attempt} (${span.status}): ${labelDuration}`}
                        title={`${span.stage} attempt #${span.attempt} (${span.status}): ${labelDuration}`}
                        className={`absolute top-1 flex h-5 min-w-[8px] items-center justify-center overflow-hidden rounded border px-1.5 font-mono text-xs font-semibold whitespace-nowrap transition-opacity hover:opacity-90 ${barTone}`}
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

      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-muted">
        {pick(
          '各バーは実際の試行を表します。失敗と再試行も個別のスパンとして保持されます。時間軸は最初の工程を基準としています。',
          'Each bar represents an actual stage attempt. Failures and retries are retained as separate spans. The time axis is relative to the first step.',
        )}
      </p>
    </section>
  );
}
