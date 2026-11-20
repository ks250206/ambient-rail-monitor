import { ArrowUpRight, FileCode2, FileSpreadsheet } from 'lucide-react';

import type { WorkflowJob } from '../../shared/types.ts';
import { bytes, clock } from '../utils/workflow.ts';

interface BottomGridProps {
  job: WorkflowJob | null;
}

export function BottomGrid({ job }: BottomGridProps) {
  const recentEvents = job ? job.events.slice(-35).reverse() : [];

  return (
    <section className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(290px,0.85fr)]">
      {/* Recent Events */}
      <div id="events" className="min-w-0 scroll-mt-6 border-t-2 border-science-sub bg-white pt-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="section-heading">イベント</h2>
          </div>
          <span className="font-mono text-xs text-ink-muted">JSONL · Event-sourced</span>
        </div>

        <div className="mt-4 max-h-[280px] min-h-[160px] overflow-y-auto divide-y divide-line">
          {recentEvents.length === 0 ? (
            <div className="flex min-h-[140px] items-center justify-center text-xs text-ink-muted">
              No events yet.
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
                    {event.message || event.stage || 'Event received'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Artifacts */}
      <div
        id="artifacts"
        className="flex min-w-0 scroll-mt-6 flex-col border-t-2 border-science-sub bg-white pt-4"
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="section-heading">成果物</h2>
          </div>
          <ArrowUpRight className="h-5 w-5 text-eyebrow" />
        </div>

        <div className="mt-4 flex-1">
          {!job || job.artifacts.length === 0 ? (
            <div className="flex min-h-[130px] items-center justify-center rounded-lg border border-dashed border-line bg-bg-2/70 p-4 text-center text-xs text-ink-muted">
              工程の完了後、HTML / PPTXがここに表示されます。
            </div>
          ) : (
            <div className="space-y-2.5">
              {job.artifacts.map((artifact) => {
                const isPptx = artifact.name.toLowerCase().endsWith('.pptx');
                return (
                  <a
                    key={artifact.name}
                    href={artifact.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 rounded-lg border border-line bg-bg-2 p-3 transition-colors hover:border-science-blue hover:bg-navy-50"
                  >
                    <span
                      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold ${
                        isPptx
                          ? 'bg-st-orange-bg text-st-orange-dark'
                          : 'bg-navy-100 text-science-blue'
                      }`}
                    >
                      {isPptx ? (
                        <FileSpreadsheet className="h-4 w-4" />
                      ) : (
                        <FileCode2 className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-xs font-bold text-science-blue">
                        {artifact.name}
                      </strong>
                      <small className="text-xs text-ink-muted">
                        {bytes(artifact.bytes)} · Open artifact
                      </small>
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-eyebrow" />
                  </a>
                );
              })}
            </div>
          )}
        </div>

        <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
          Artifacts are served locally. The demo uses descriptive quicklook analysis; it does not
          assign XPS peaks or make validated scientific claims.
        </p>
      </div>
    </section>
  );
}
