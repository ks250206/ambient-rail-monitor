import { ArtifactViewer } from './ArtifactViewer.tsx';

import type { WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { clock } from '../utils/workflow.ts';

interface BottomGridProps {
  job: WorkflowJob | null;
  jobs: WorkflowJob[];
}

export function BottomGrid({ job, jobs }: BottomGridProps) {
  const { pick } = useI18n();
  const recentEvents = job ? job.events.slice(-35).reverse() : [];

  return (
    <>
      <section
        id="events"
        aria-labelledby="events-heading"
        className="mt-7 min-w-0 scroll-mt-6 border-t border-line pt-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="events-heading" className="section-heading">
            {pick('イベント', 'Events')}
          </h3>
          {job && <span className="font-mono text-xs text-ink-muted">{job.id}</span>}
        </div>
        <div className="mt-4 max-h-[280px] overflow-y-auto divide-y divide-line">
          {recentEvents.length === 0 ? (
            <div className="flex min-h-[140px] items-center justify-center text-xs text-ink-muted">
              {pick(
                'このジョブのイベントはまだありません。',
                'No events recorded for this job yet.',
              )}
            </div>
          ) : (
            recentEvents.map((event) => {
              const isFailure = event.type.includes('failed');
              const isReview = event.type.includes('review');
              const typeTone = isFailure
                ? 'text-st-red-dark'
                : isReview
                  ? 'text-st-orange-dark'
                  : 'text-eyebrow';

              return (
                <div
                  key={event.sequence}
                  className="grid grid-cols-[64px_112px_minmax(0,1fr)] items-start gap-2.5 py-2.5 text-xs"
                >
                  <span className="font-mono text-xs text-ink-muted tabular-nums">
                    {clock(event.at)}
                  </span>
                  <span
                    className={`truncate font-mono text-xs font-semibold ${typeTone}`}
                    title={event.type}
                  >
                    {event.type}
                  </span>
                  <span className="truncate text-ink" title={event.message || ''}>
                    {event.message || event.stage || pick('イベント受信', 'Event received')}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>
      <section
        id="artifacts"
        aria-labelledby="artifacts-heading"
        className="mt-7 min-w-0 scroll-mt-6 border-t border-line pt-5"
      >
        <h3 id="artifacts-heading" className="section-heading mb-4">
          {pick('成果物', 'Artifacts')}
        </h3>
        <ArtifactViewer job={job} jobs={jobs} />
      </section>
    </>
  );
}
