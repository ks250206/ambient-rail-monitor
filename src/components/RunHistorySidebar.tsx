import { ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { actionDuration, clockDate, jobMatchesSearch } from '../utils/workflow.ts';
import { StatusIcon } from './StatusBadge.tsx';

type RunFilter = 'all' | 'running' | 'done' | 'review';
const FILTER_TABS: Array<{ id: RunFilter; ja: string; en: string }> = [
  { id: 'all', ja: 'すべて', en: 'All' },
  { id: 'running', ja: '実行中', en: 'Active' },
  { id: 'done', ja: '成功', en: 'Success' },
  { id: 'review', ja: '要確認', en: 'Issues' },
];

const RUNS_PER_PAGE = 7;

interface RunHistorySidebarProps {
  jobs: WorkflowJob[];
  selectedJobId: string | null;
  nowMs: number;
  onSelectJob: (id: string) => void;
}

export function RunHistorySidebar({
  jobs,
  selectedJobId,
  nowMs,
  onSelectJob,
}: RunHistorySidebarProps) {
  const { pick } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [runSearch, setRunSearch] = useState('');
  const [page, setPage] = useState<number | null>(null);
  const filteredJobs = useMemo(() => {
    const query = runSearch.trim().toLowerCase();
    return jobs.filter((job) => {
      const statusMatch =
        runFilter === 'all' ||
        (runFilter === 'running'
          ? job.status === 'queued' || job.status === 'running'
          : runFilter === 'review'
            ? job.status === 'review' || job.status === 'failed'
            : job.status === runFilter);
      return statusMatch && (!query || jobMatchesSearch(job, query));
    });
  }, [jobs, runFilter, runSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / RUNS_PER_PAGE));
  const selectedIndex = filteredJobs.findIndex((job) => job.id === selectedJobId);
  const selectedPage = Math.floor(Math.max(0, selectedIndex) / RUNS_PER_PAGE);
  const clampedPage = Math.min(page ?? selectedPage, totalPages - 1);
  const pageJobs = filteredJobs.slice(
    clampedPage * RUNS_PER_PAGE,
    (clampedPage + 1) * RUNS_PER_PAGE,
  );

  const heading = (
    <>
      <span className="text-sm font-bold text-science-blue">
        {pick('ジョブの実行履歴', 'Run history')}
      </span>
      <span className="rounded-full bg-bg-1 px-2 py-0.5 font-mono text-xs font-bold text-science-blue">
        {jobs.length}
      </span>
    </>
  );

  return (
    <aside aria-label={pick('ジョブの実行履歴', 'Run history')} className="run-history-sidebar">
      <h2 className="run-history-heading items-center gap-2 px-3.5 py-4">{heading}</h2>
      <button
        type="button"
        ref={toggleRef}
        className="run-history-toggle min-h-12 w-full items-center gap-2 px-3.5 py-3 text-left"
        aria-controls="run-history-body"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {heading}
        <ChevronDown
          aria-hidden="true"
          className={`ml-auto size-4 text-science-blue ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        id="run-history-body"
        className="run-history-body min-h-0 flex-1 flex-col"
        data-expanded={expanded}
      >
        <div className="border-b border-line px-3.5 pb-3">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-2.5 focus-within:border-eyebrow focus-within:ring-2 focus-within:ring-navy-100">
            <Search className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <input
              type="search"
              value={runSearch}
              onChange={(event) => {
                setRunSearch(event.target.value);
                setPage(0);
              }}
              placeholder={pick('ジョブやファイル名を検索…', 'Search runs or files…')}
              aria-label={pick('ジョブを検索', 'Search runs')}
              className="w-full min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-muted"
            />
          </label>

          <div
            className="mt-2.5 flex flex-wrap gap-1"
            role="group"
            aria-label={pick('実行状態で絞り込み', 'Filter run status')}
          >
            {FILTER_TABS.map((tab) => {
              const active = runFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setRunFilter(tab.id);
                    setPage(0);
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-science-blue text-white shadow-2xs'
                      : 'bg-white text-ink-muted hover:bg-bg-1 hover:text-science-blue'
                  }`}
                >
                  {pick(tab.ja, tab.en)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="run-history-list min-h-0 flex-1 overflow-y-auto">
          {pageJobs.length === 0 ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 p-6 text-center">
              <Search className="h-6 w-6 text-eyebrow" />
              <strong className="text-xs font-semibold text-science-blue">
                {pick('該当するジョブがありません', 'No matching runs')}
              </strong>
              <p className="text-xs text-ink-muted">
                {jobs.length
                  ? pick('別の状態や検索語を試してください。', 'Try another status or search term.')
                  : pick(
                      'ジョブ一覧からファイルを投入できます。',
                      'Submit files from the Jobs page.',
                    )}
              </p>
            </div>
          ) : (
            pageJobs.map((job) => {
              const done = job.stages.filter((stage) => stage.status === 'success').length;
              const isSelected = selectedJobId === job.id;
              const summaryLabel =
                job.status === 'done'
                  ? pick('完了', 'Completed')
                  : job.status === 'review'
                    ? pick('要承認', 'Attention required')
                    : job.status === 'failed'
                      ? pick('実行失敗', 'Execution failed')
                      : job.status === 'running'
                        ? pick('処理中', 'Processing')
                        : job.status === 'paused'
                          ? pick('一時停止中', 'Paused')
                          : job.status === 'cancelled'
                            ? pick('中止', 'Cancelled')
                            : pick('ワーカー待機中', 'Waiting for worker');
              const resultTone =
                job.status === 'done'
                  ? 'text-st-green-dark'
                  : job.status === 'running'
                    ? 'text-eyebrow'
                    : job.status === 'review'
                      ? 'text-st-orange-dark'
                      : job.status === 'failed'
                        ? 'text-st-red-dark'
                        : 'text-ink-muted';

              return (
                <button
                  key={job.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    if (expanded) {
                      setExpanded(false);
                      toggleRef.current?.focus({ preventScroll: true });
                    }
                    onSelectJob(job.id);
                  }}
                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 border-b border-line px-3.5 py-3 text-left transition-colors ${
                    isSelected
                      ? 'border-l-[3px] border-l-science-blue bg-white pl-3'
                      : 'hover:bg-bg-1/70'
                  }`}
                >
                  <span className="pt-0.5">
                    <StatusIcon status={job.status} size="sm" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="break-all text-xs font-bold text-ink">{job.file}</strong>
                    <span className="truncate text-xs text-ink-muted">
                      {(job.agent || pick('未割当', 'unassigned')).toUpperCase()}
                    </span>
                    <span className="truncate font-mono text-xs text-ink-muted">
                      {job.id} · {clockDate(job.createdAt)}
                    </span>
                  </span>
                  <span className="col-start-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
                    <span className={`text-xs font-bold ${resultTone}`}>{summaryLabel}</span>
                    <span className="font-mono text-xs text-ink">
                      {job.startedAt
                        ? actionDuration(job.startedAt, job.finishedAt, nowMs)
                        : pick('待機', 'Queued')}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {pick(
                        `${done}/${job.stages.length} 工程`,
                        `${done}/${job.stages.length} steps`,
                      )}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line bg-bg-1/70 px-3.5 py-2.5 text-xs text-ink-muted">
          <span>
            {filteredJobs.length
              ? pick(
                  `${clampedPage * RUNS_PER_PAGE + 1}–${Math.min(
                    (clampedPage + 1) * RUNS_PER_PAGE,
                    filteredJobs.length,
                  )} / ${filteredJobs.length}件`,
                  `${clampedPage * RUNS_PER_PAGE + 1}–${Math.min(
                    (clampedPage + 1) * RUNS_PER_PAGE,
                    filteredJobs.length,
                  )} of ${filteredJobs.length}`,
                )
              : pick('0件', '0 runs')}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={pick('前のページ', 'Previous page')}
              disabled={clampedPage === 0}
              onClick={() => setPage(clampedPage - 1)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white text-science-blue hover:bg-bg-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={pick('次のページ', 'Next page')}
              disabled={clampedPage + 1 >= totalPages}
              onClick={() => setPage(clampedPage + 1)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white text-science-blue hover:bg-bg-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
