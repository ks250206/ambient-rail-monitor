import { useMutation } from '@tanstack/react-query';
import { RefreshCw, Search, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

import type { ProjectSpec, WorkflowJob } from '../shared/types.ts';
import { jsonRequest, request, useProjectJobs } from './api.ts';
import { KanbanSection } from './components/KanbanSection.tsx';
import { MetricsGrid } from './components/MetricsGrid.tsx';
import { jobMatchesSearch, monitorJobHref } from './utils/workflow.ts';

export function JobsPage({ project }: { project: ProjectSpec }) {
  const query = useProjectJobs(project.id);
  const jobs = query.data?.jobs ?? [];
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );
  const normalizedQuery = search.trim().toLowerCase();
  const matchingJobs = normalizedQuery
    ? jobs.filter((job) => jobMatchesSearch(job, normalizedQuery))
    : jobs;
  const searchRef = useRef<HTMLInputElement>(null);

  function updateSearch(value: string) {
    setSearch(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('q', value);
    else url.searchParams.delete('q');
    window.history.replaceState(null, '', url);
  }

  const [reviewDemo, setReviewDemo] = useState(false);
  const [dragVisible, setDragVisible] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const enqueue = useMutation({
    mutationFn: (input: File | boolean) =>
      input instanceof File
        ? request<{ job: WorkflowJob }>(
            `/api/upload?${new URLSearchParams({ filename: input.name, project: project.id })}`,
            { method: 'POST', body: input },
          )
        : request<{ job: WorkflowJob }>(
            '/api/demo',
            jsonRequest('POST', { projectId: project.id, review: input }),
          ),
  });

  function submit(input: File | boolean) {
    if (enqueue.isPending) return;
    enqueue.mutate(input, {
      onSuccess: ({ job }) => window.location.assign(monitorJobHref(project.id, job.id)),
    });
  }

  return (
    <main
      className="min-h-screen bg-white text-ink"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current++;
          setDragVisible(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragVisible(false);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragVisible(false);
        const file = event.dataTransfer.files[0];
        if (file) submit(file);
      }}
    >
      <div className="page-width @container py-8 sm:py-12">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b-2 border-science-blue pb-5">
          <h1 className="text-3xl font-bold tracking-tight text-science-blue sm:text-4xl">
            ジョブ一覧
          </h1>
          <button type="button" onClick={() => void query.refetch()} className="wf-secondary">
            <RefreshCw size={15} aria-hidden="true" />
            更新
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={enqueue.isPending}
            className="wf-primary disabled:opacity-50"
          >
            ファイル投入
          </button>
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
            デモをレビューで一時停止
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,.json,.dat"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) submit(file);
              event.target.value = '';
            }}
            hidden
          />
        </div>
        {enqueue.isError && (
          <p role="alert" className="py-2 text-st-red-dark">
            {enqueue.error.message}
          </p>
        )}
        <details className="mb-4 mt-2 text-sm text-ink-muted">
          <summary className="w-fit cursor-pointer py-2">ジョブの集計</summary>
          <MetricsGrid jobs={jobs} loading={query.isPending} />
        </details>
        {query.isError && (
          <p role="alert" className="py-2 text-st-red-dark">
            ジョブを取得できませんでした。「更新」から再読み込みできます。
          </p>
        )}
        {query.isPending && (
          <p role="status" className="py-2 text-sm">
            読み込み中…
          </p>
        )}
        <div
          role="search"
          aria-label="ジョブ一覧の検索"
          className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2"
        >
          <label className="flex min-h-10 w-full max-w-md items-center gap-2 rounded border border-navy-400 bg-white px-3 focus-within:border-science-blue focus-within:ring-1 focus-within:ring-science-blue">
            <Search size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
            <input
              ref={searchRef}
              type="search"
              aria-label="ジョブを検索"
              placeholder="ファイル名・ジョブID・担当ワーカーなどで検索"
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
              検索をクリア
            </button>
          )}
        </div>
        <p role="status" className="text-sm text-ink-muted">
          {normalizedQuery && query.data && (
            <span className="mb-3 block">
              {matchingJobs.length
                ? `${jobs.length}件中 ${matchingJobs.length}件が一致`
                : '一致するジョブはありません。'}
            </span>
          )}
        </p>
        {query.data && (!normalizedQuery || matchingJobs.length > 0) && (
          <KanbanSection jobs={matchingJobs} />
        )}
      </div>

      {dragVisible && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-science-blue/85 text-center text-white">
          <div className="flex max-w-[90vw] flex-col items-center gap-3 rounded-md border-2 border-dashed border-navy-200 p-8">
            <Upload size={40} aria-hidden="true" />
            <strong className="break-all text-2xl">{project.name} へ解析データをドロップ</strong>
            <small>CSV · TSV · JSON · TXT · DAT</small>
          </div>
        </div>
      )}
    </main>
  );
}
