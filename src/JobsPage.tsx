import { QueuePanel } from './components/QueuePanel.tsx';
import { useMutation } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useRef, useState } from 'react';

import type { ProjectSpec, WorkflowJob } from '../shared/types.ts';
import { jsonRequest, request, useProjectJobs } from './api.ts';
import { KanbanSection } from './components/KanbanSection.tsx';
import { DatasetUpload } from './components/DatasetUpload.tsx';
import { ConditionEvidence } from './components/ConditionBuilder.tsx';
import { MetricsGrid } from './components/MetricsGrid.tsx';
import { useI18n } from './i18n.ts';
import { navigateWithTransition } from './utils/navigation.ts';
import { jobMatchesSearch, monitorJobHref, needsApproval } from './utils/workflow.ts';

export function JobsPage({ project }: { project: ProjectSpec }) {
  const { pick } = useI18n();
  const query = useProjectJobs(project.id);
  const jobs = query.data?.jobs ?? [];
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );
  const normalizedQuery = search.trim().toLowerCase();
  const matchingJobs = normalizedQuery
    ? jobs.filter((job) => jobMatchesSearch(job, normalizedQuery))
    : jobs;
  const showBoard = Boolean(query.data) && (!normalizedQuery || matchingJobs.length > 0);
  const searchRef = useRef<HTMLInputElement>(null);

  function updateSearch(value: string) {
    setSearch(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('q', value);
    else url.searchParams.delete('q');
    window.history.replaceState(null, '', url);
  }

  const [reviewDemo, setReviewDemo] = useState(false);
  const enqueue = useMutation({
    mutationFn: (review: boolean) =>
      request<{ job: WorkflowJob }>(
        '/api/demo',
        jsonRequest('POST', { projectId: project.id, review }),
      ),
  });

  function submit(input: boolean) {
    if (enqueue.isPending) return;
    enqueue.mutate(input, {
      onSuccess: ({ job }) => navigateWithTransition(monitorJobHref(project.id, job.id)),
    });
  }

  const approvalCount = matchingJobs.filter(needsApproval).length;

  return (
    <main className="min-h-screen bg-white text-ink">
      <div className="page-width @container py-8 sm:py-12">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b-2 border-science-blue pb-5">
          <h1 className="text-3xl font-bold tracking-tight text-science-blue sm:text-4xl">
            {pick('ジョブ一覧', 'Jobs')}
          </h1>
          <div className="flex flex-wrap items-center gap-4">
            {showBoard && (
              <a
                href="#column-review"
                className="text-sm font-semibold text-science-blue underline"
              >
                {pick(`要承認の列へ（${approvalCount}件）`, `Jump to approvals (${approvalCount})`)}
              </a>
            )}
            <button type="button" onClick={() => void query.refetch()} className="wf-secondary">
              <RefreshCw size={15} aria-hidden="true" />
              {pick('更新', 'Refresh')}
            </button>
          </div>
        </div>
        {query.data?.queue && <QueuePanel queue={query.data.queue} />}
        <DatasetUpload
          projectId={project.id}
          onCreated={(job) => navigateWithTransition(monitorJobHref(project.id, job.id))}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={(event) => submit(reviewDemo || event.shiftKey)}
            disabled={enqueue.isPending}
            lang="en"
            className="wf-secondary font-en disabled:opacity-50"
          >
            Demo run
          </button>
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={reviewDemo}
              onChange={(event) => setReviewDemo(event.target.checked)}
              className="size-4 accent-science-blue"
            />
            {pick('デモをレビューで一時停止', 'Pause demo for human review')}
          </label>
        </div>
        {enqueue.isError && (
          <p role="alert" className="py-2 text-st-red-dark">
            {enqueue.error.message}
          </p>
        )}
        {!!query.data?.candidates?.length && (
          <details className="input-candidates">
            <summary>
              {pick(
                `監視フォルダの入力状況（${query.data.candidates.length}件）`,
                `Watched inbox inputs (${query.data.candidates.length})`,
              )}
            </summary>
            <p className="wf-help">
              {pick(
                `${project.inboxDir} を監視しています。準備が整わない入力は理由とともにここに表示します。`,
                `Watching ${project.inboxDir}. Inputs waiting on conditions or needing attention are listed here.`,
              )}
            </p>
            {query.data.candidates.map((item, i) => (
              <div className="input-candidate" key={`${item.name}-${i}`}>
                <strong>{item.name}</strong>
                <span>
                  {pick(`${item.fileCount} ファイル`, `${item.fileCount} files`)} ·{' '}
                  {item.status === 'registered'
                    ? pick('登録済み', 'Registered')
                    : item.status === 'error'
                      ? pick('確認が必要', 'Needs attention')
                      : pick('条件待ち', 'Waiting on conditions')}
                </span>
                <p>{item.message}</p>
                {item.result && (
                  <details>
                    <summary>{pick('判定の内訳', 'Evaluation details')}</summary>
                    <ConditionEvidence result={item.result} />
                  </details>
                )}
              </div>
            ))}
          </details>
        )}
        <details className="mb-4 mt-2 text-sm text-ink-muted">
          <summary className="w-fit cursor-pointer py-2">
            {pick('ジョブの集計', 'Job summary')}
          </summary>
          <MetricsGrid jobs={jobs} loading={query.isPending} />
        </details>
        {query.isError && (
          <p role="alert" className="py-2 text-st-red-dark">
            {pick(
              'ジョブを取得できませんでした。「更新」から再読み込みできます。',
              'Failed to load jobs. Click Refresh to try again.',
            )}
          </p>
        )}
        {query.isPending && (
          <p role="status" className="py-2 text-sm">
            {pick('読み込み中…', 'Loading…')}
          </p>
        )}
        <div
          role="search"
          aria-label={pick('ジョブ一覧の検索', 'Search jobs')}
          className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2"
        >
          <label className="flex min-h-10 w-full max-w-md items-center gap-2 rounded border border-navy-400 bg-white px-3 focus-within:border-science-blue focus-within:ring-1 focus-within:ring-science-blue">
            <Search size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
            <input
              ref={searchRef}
              type="search"
              aria-label={pick('ジョブを検索', 'Search jobs')}
              placeholder={pick(
                'ファイル名・ジョブID・担当ワーカーなどで検索',
                'Search by filename, job ID, worker…',
              )}
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              className="min-w-0 flex-1 py-2 text-sm outline-none placeholder:text-ink-muted"
            />
          </label>
          {search && (
            <button
              type="button"
              className="text-sm font-semibold text-science-blue hover:underline"
              onClick={() => {
                updateSearch('');
                searchRef.current?.focus();
              }}
            >
              {pick('検索をクリア', 'Clear search')}
            </button>
          )}
        </div>
        <p role="status" className="text-sm text-ink-muted">
          {normalizedQuery && query.data && (
            <span className="mb-3 block">
              {matchingJobs.length
                ? pick(
                    `${jobs.length}件中 ${matchingJobs.length}件が一致`,
                    `${matchingJobs.length} of ${jobs.length} jobs matched`,
                  )
                : pick('一致するジョブはありません。', 'No matching jobs found.')}
            </span>
          )}
        </p>
        {showBoard && <KanbanSection jobs={matchingJobs} />}
      </div>
    </main>
  );
}
