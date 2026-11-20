import { useQuery, useMutation } from '@tanstack/react-query';
import {
  request,
  jsonRequest,
  queryClient,
  useProjects,
  useToast,
  useConnection,
  useClock,
} from './api.ts';
import { ArrowRight, Upload } from 'lucide-react';
import { type ChangeEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { AppStateResponse, ProjectSpec, StageKey, WorkflowJob } from '../shared/types.ts';
import { ActionsSection } from './components/ActionsSection.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import { BottomGrid } from './components/BottomGrid.tsx';
import { KanbanSection } from './components/KanbanSection.tsx';
import { MetricsGrid } from './components/MetricsGrid.tsx';
import { SectionNavigation } from './components/SectionNavigation.tsx';
import { TraceSection } from './components/TraceSection.tsx';
import {
  pageHref,
  persistProjectId,
  pickDefaultStage,
  readInitialProjectId,
} from './utils/workflow.ts';

function subscribeHash(notify: () => void) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

export function App() {
  const [requestedId, setRequestedId] = useState(readInitialProjectId);
  const projects = useProjects();
  const connection = useConnection();
  const list = projects.data?.projects ?? [];
  const project = list.find((item) => item.id === requestedId) ?? list[0];
  const select = (id: string) => {
    persistProjectId(id);
    setRequestedId(id);
  };

  return (
    <>
      <AppHeader
        currentPage="monitor"
        projects={list}
        selectedProjectId={project?.id ?? requestedId}
        onSelectProject={select}
        connection={projects.isError ? 'reconnecting' : connection}
      />
      {project ? (
        <Monitor key={project.id} project={project} />
      ) : (
        <p role="status" className="page-width py-6">
          {projects.isError ? 'プロジェクトを取得できませんでした。' : '読み込み中…'}
        </p>
      )}
    </>
  );
}

function Monitor({ project }: { project: ProjectSpec }) {
  const selectedProjectId = project.id;
  const queryKey = ['monitor', project.id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<AppStateResponse>(`/api/state?project=${encodeURIComponent(project.id)}`, { signal }),
  });
  const state = query.data ?? { jobs: [], project };
  const [chosenJob, setChosenJob] = useState<string | null>(null);
  const [chosenStage, setChosenStage] = useState<StageKey | null>(null);
  const selectedJob = state.jobs.find((job) => job.id === chosenJob) ?? state.jobs[0] ?? null;
  const selectedJobId = selectedJob?.id ?? null;
  // Keep the open job and its comparison stable when a newer run arrives over SSE.
  if (chosenJob === null && selectedJobId) setChosenJob(selectedJobId);
  const selectedStage =
    selectedJob?.stages.find((stage) => stage.key === chosenStage)?.key ??
    pickDefaultStage(selectedJob);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const activeHash = useSyncExternalStore(subscribeHash, () => window.location.hash || '#workflow');
  const nowMs = useClock();
  const { toast, showToast } = useToast();
  const [reviewDemo, setReviewDemo] = useState(false);
  const [dragVisible, setDragVisible] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const selectJob = (id: string) => {
    setChosenJob(id);
    setChosenStage(null);
    setShowAllLogs(false);
  };
  const onError = (err: Error) => showToast(err.message, true);
  const enqueue = useMutation({
    mutationFn: (input: File | boolean) =>
      input instanceof File
        ? request<{ job: WorkflowJob }>(
            `/api/upload?filename=${encodeURIComponent(input.name)}&project=${encodeURIComponent(project.id)}`,
            { method: 'POST', body: input },
          )
        : request<{ job: WorkflowJob }>(
            '/api/demo',
            jsonRequest('POST', { projectId: project.id, review: input }),
          ),
    onSuccess: ({ job }) => {
      selectJob(job.id);
      showToast(`${job.file} を ${project.name} に追加しました。`);
      return queryClient.invalidateQueries({ queryKey });
    },
    onError,
  });
  const approve = useMutation({
    mutationFn: (jobId: string) => request(`/api/jobs/${jobId}/approve`, jsonRequest('POST', {})),
    onSuccess: () => {
      showToast('レビューを承認しました。');
      return queryClient.invalidateQueries({ queryKey });
    },
    onError,
  });

  const agentNames = useMemo(() => {
    const names = state.jobs.flatMap((job) => (job.agent ? [job.agent] : []));
    return [...new Set(names)].join(' / ');
  }, [state.jobs]);

  const handleSelectStage = (stage: StageKey) => {
    setChosenJob(selectedJobId);
    setChosenStage(stage);
    setShowAllLogs(false);
  };
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) enqueue.mutate(file);
    event.target.value = '';
  };

  return (
    <div
      id="overview"
      className="min-h-screen bg-white text-ink"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          dragDepth.current++;
          setDragVisible(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragVisible(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragVisible(false);
        const file = e.dataTransfer.files[0];
        if (file) enqueue.mutate(file);
      }}
    >
      <main>
        <header className="page-width py-8 sm:py-12">
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
        <section className="page-width pb-10" aria-labelledby="workflow-title">
          <div id="workflow" className="scroll-mt-6 py-6 sm:py-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="workflow-title" className="section-heading">
                ワークフロー
              </h2>
              <a
                href={pageHref('/workflow', selectedProjectId)}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-science-blue hover:underline"
              >
                定義を編集 <ArrowRight size={15} />
              </a>
            </div>
            <ol aria-label="ワークフローの工程順" className="workflow-sequence">
              {project.stages.map((stage, index) => (
                <li key={stage.key}>
                  <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  {stage.label}
                </li>
              ))}
            </ol>
          </div>
          {query.isError && (
            <p role="alert" className="py-2 text-st-red-dark">
              ジョブの取得に失敗しました。ジョブボードから再読み込みできます。
            </p>
          )}

          <KanbanSection
            jobs={state.jobs}
            selectedJobId={selectedJobId}
            nowMs={nowMs}
            onSelectJob={(id) => {
              selectJob(id);
              if (window.location.hash === '#job-detail')
                document.getElementById('job-detail')?.scrollIntoView();
              else window.location.hash = 'job-detail';
              document.getElementById('job-detail')?.focus({ preventScroll: true });
            }}
            onRefresh={() => void query.refetch()}
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="wf-primary"
              >
                ファイル投入
              </button>
              <button
                type="button"
                onClick={(event) => enqueue.mutate(reviewDemo || event.shiftKey)}
                title="Shift + Click で人間のレビュー承認ゲートを有効にして実行"
                lang="en"
                className="wf-secondary font-en"
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
                onChange={handleFileChange}
                hidden
              />
            </div>
            <details className="mb-4 text-sm text-ink-muted">
              <summary className="w-fit cursor-pointer py-2">ジョブの集計</summary>
              <MetricsGrid jobs={state.jobs} loading={query.isPending} />
            </details>
          </KanbanSection>

          <ActionsSection
            jobs={state.jobs}
            selectedJob={selectedJob}
            selectedStage={selectedStage}
            showAllLogs={showAllLogs}
            project={state.project}
            nowMs={nowMs}
            onSelectJob={selectJob}
            onSelectStage={handleSelectStage}
            onShowAllLogs={() => setShowAllLogs(true)}
            onApproveReview={(jobId) => approve.mutate(jobId)}
          />

          <TraceSection job={selectedJob} nowMs={nowMs} onSelectStage={handleSelectStage} />

          <BottomGrid key={selectedJobId} job={selectedJob} jobs={state.jobs} />
        </section>

        <footer className="page-width mb-10 mt-4 flex flex-wrap justify-between gap-3 border-t-2 border-science-blue pt-4 text-sm text-ink-muted">
          <span lang="en" className="font-en font-semibold text-science-blue">
            Institute of Science Tokyo
          </span>
          <span>
            実行履歴のエージェント　
            {agentNames || '記録なし'}
          </span>
        </footer>
      </main>

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

      {/* Drag & Drop Overlay */}
      {dragVisible && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-science-blue/85 backdrop-blur-xs">
          <div className="flex h-[58vh] w-[66vw] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-navy-200 bg-white/10 text-white">
            <Upload className="h-12 w-12 text-white" />
            <strong className="mt-3 text-2xl font-bold">
              {state.project.name} へ解析データをドロップ
            </strong>
            <small className="font-en mt-2 text-sm text-navy-200">
              CSV · TSV · JSON · TXT · DAT → {state.project.inboxDir}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
