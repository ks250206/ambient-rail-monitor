import { useMutation } from '@tanstack/react-query';
import {
  request,
  jsonRequest,
  queryClient,
  useProjects,
  useProjectJobs,
  useToast,
  useConnection,
  useClock,
} from './api.ts';
import { useMemo, useState, useSyncExternalStore } from 'react';

import type { ProjectSpec, StageKey } from '../shared/types.ts';
import { ActionsSection } from './components/ActionsSection.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import { BottomGrid } from './components/BottomGrid.tsx';
import { JobsPage } from './JobsPage.tsx';
import { RunHistorySidebar } from './components/RunHistorySidebar.tsx';
import { SectionNavigation } from './components/SectionNavigation.tsx';
import { TraceSection } from './components/TraceSection.tsx';
import {
  pageHref,
  persistProjectId,
  pickDefaultStage,
  readInitialProjectId,
} from './utils/workflow.ts';

function subscribeLocation(notify: () => void) {
  window.addEventListener('hashchange', notify);
  window.addEventListener('popstate', notify);
  return () => {
    window.removeEventListener('hashchange', notify);
    window.removeEventListener('popstate', notify);
  };
}

export function App({ page }: { page: 'monitor' | 'jobs' }) {
  const [requestedId, setRequestedId] = useState(readInitialProjectId);
  const projects = useProjects();
  const connection = useConnection();
  const list = projects.data?.projects ?? [];
  const project =
    list.find((item) => item.id === requestedId) ??
    (new URLSearchParams(window.location.search).has('project') ? undefined : list[0]);
  const select = (id: string) => {
    persistProjectId(id);
    setRequestedId(id);
  };

  return (
    <>
      <AppHeader
        currentPage={page}
        projects={list}
        selectedProjectId={project?.id ?? requestedId}
        onSelectProject={select}
        connection={projects.isError ? 'reconnecting' : connection}
      />
      {project ? (
        page === 'jobs' ? (
          <JobsPage key={project.id} project={project} />
        ) : (
          <Monitor key={project.id} project={project} />
        )
      ) : (
        <p role="status" className="page-width py-6">
          {projects.isError ? (
            'プロジェクトを取得できませんでした。'
          ) : projects.isPending ? (
            '読み込み中…'
          ) : (
            <>
              指定されたプロジェクトが見つかりません。{' '}
              <a href="/projects" className="text-science-blue underline">
                プロジェクト一覧へ戻る
              </a>
            </>
          )}
        </p>
      )}
    </>
  );
}

function Monitor({ project }: { project: ProjectSpec }) {
  const query = useProjectJobs(project.id);
  const state = query.data ?? { jobs: [], project };
  const href = useSyncExternalStore(subscribeLocation, () => window.location.href);
  const url = new URL(href);
  const requestedJob = url.searchParams.get('job');
  const [defaultJobId, setDefaultJobId] = useState<string | null>(null);
  const [chosenStage, setChosenStage] = useState<StageKey | null>(null);
  const selectedJob =
    state.jobs.find((job) => job.id === (requestedJob ?? defaultJobId)) ??
    (requestedJob ? null : (state.jobs[0] ?? null));
  const selectedJobId = selectedJob?.id ?? null;
  // Keep the open job and its comparison stable when a newer run arrives over SSE.
  if (!defaultJobId && selectedJobId) setDefaultJobId(selectedJobId);
  const selectedStage =
    selectedJob?.stages.find((stage) => stage.key === chosenStage)?.key ??
    pickDefaultStage(selectedJob);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const activeHash = url.hash || '#actions';
  const nowMs = useClock();
  const { toast, showToast } = useToast();
  const selectJob = (id: string) => {
    const next = new URL(window.location.href);
    next.searchParams.set('job', id);
    window.history.replaceState(null, '', next);
    setChosenStage(null);
    setShowAllLogs(false);
    window.dispatchEvent(new Event('popstate'));
  };
  const approve = useMutation({
    mutationFn: (jobId: string) => request(`/api/jobs/${jobId}/approve`, jsonRequest('POST', {})),
    onSuccess: () => {
      showToast('レビューを承認しました。');
      return queryClient.invalidateQueries({ queryKey: ['monitor', project.id] });
    },
    onError: (err) => showToast(err.message, true),
  });

  const agentNames = useMemo(() => {
    const names = state.jobs.flatMap((job) => (job.agent ? [job.agent] : []));
    return [...new Set(names)].join(' / ');
  }, [state.jobs]);

  const handleSelectStage = (stage: StageKey) => {
    setChosenStage(stage);
    setShowAllLogs(false);
  };
  return (
    <div id="overview" className="min-h-screen bg-white text-ink">
      <div className="monitor-layout">
        <RunHistorySidebar
          jobs={state.jobs}
          selectedJobId={selectedJobId}
          nowMs={nowMs}
          onSelectJob={selectJob}
        />
        <main className="@container min-w-0">
          <header className="py-8 sm:py-10">
            <h1 className="max-w-5xl break-words text-3xl font-bold leading-tight text-science-blue sm:text-4xl">
              {project.name}
            </h1>
            {project.purpose && (
              <p className="mt-3 max-w-3xl whitespace-pre-line break-words text-sm leading-7 text-ink-muted sm:text-base">
                {project.purpose}
              </p>
            )}
          </header>
          <SectionNavigation activeHash={activeHash === '#job-detail' ? '#actions' : activeHash} />
          <div className="pb-10">
            {query.isError && (
              <p role="alert" className="pt-4 text-st-red-dark">
                ジョブの取得に失敗しました。{' '}
                <button type="button" className="underline" onClick={() => void query.refetch()}>
                  再読み込み
                </button>
              </p>
            )}
            {query.isSuccess && !selectedJob && (
              <p role="status" className="pt-4 text-sm">
                {requestedJob
                  ? '指定されたジョブが見つかりません。'
                  : 'このプロジェクトにはまだジョブがありません。'}{' '}
                <a className="text-science-blue underline" href={pageHref('/jobs', project.id)}>
                  ジョブ一覧へ
                </a>
              </p>
            )}
            <ActionsSection
              selectedJob={selectedJob}
              selectedStage={selectedStage}
              showAllLogs={showAllLogs}
              project={state.project}
              nowMs={nowMs}
              onSelectStage={handleSelectStage}
              onShowAllLogs={() => setShowAllLogs(true)}
              onApproveReview={(jobId) => approve.mutate(jobId)}
            />

            <TraceSection job={selectedJob} nowMs={nowMs} onSelectStage={handleSelectStage} />

            <BottomGrid key={selectedJobId} job={selectedJob} jobs={state.jobs} />
          </div>

          <footer className="mb-10 mt-4 flex flex-wrap justify-between gap-3 border-t-2 border-science-blue pt-4 text-sm text-ink-muted">
            <span lang="en" className="font-en font-semibold text-science-blue">
              Institute of Science Tokyo
            </span>
            <span>
              実行履歴のエージェント　
              {agentNames || '記録なし'}
            </span>
          </footer>
        </main>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border px-4 py-3 text-xs font-medium shadow-lg ${
            toast.error
              ? 'border-st-red bg-st-red-bg text-st-red-dark'
              : 'border-science-blue bg-science-blue text-white'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
