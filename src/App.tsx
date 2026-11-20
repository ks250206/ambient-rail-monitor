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
import { FolderOpen, SlidersHorizontal, Upload } from 'lucide-react';
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
  const selectedStage =
    selectedJob?.stages.find((stage) => stage.key === chosenStage)?.key ??
    pickDefaultStage(selectedJob);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const activeHash = useSyncExternalStore(subscribeHash, () => window.location.hash || '#board');
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
        <div className="monitor-hero">
          <div aria-hidden="true" className="hero-arches" />
          <div className="page-width relative py-7 sm:py-10">
            <div className="hero-copy">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-eyebrow">
                  {state.project.name}（{state.project.stages.length}工程）
                </span>
                <a
                  href={pageHref('/workflow', selectedProjectId)}
                  className="inline-flex items-center gap-1 rounded border border-line bg-white px-2 py-0.5 text-[11px] font-semibold text-science-blue hover:bg-bg-2"
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  定義・工程・LLM を編集
                </a>
              </div>
              <h1
                lang="en"
                className="font-en mt-1 text-4xl font-bold leading-tight text-science-blue sm:text-5xl"
              >
                Ambient workflows
              </h1>
              <p className="mt-2 max-w-xl text-base leading-7">
                {state.project.purpose ||
                  'ファイル投入から解析、検証、成果物の生成まで、ジョブごとの実行状況を確認できます。'}
              </p>
              <p className="mt-2 inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span className="inline-flex items-center gap-1">
                  <FolderOpen className="h-3.5 w-3.5 text-eyebrow" />
                  Inbox: <code className="font-mono text-ink">{state.project.inboxDir}</code>
                </span>
                <span>
                  Artifacts:{' '}
                  <code className="font-mono text-ink">{state.project.artifactsDir}</code>
                </span>
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="monitor-button"
                >
                  ファイル投入
                </button>
                <button
                  type="button"
                  onClick={(event) => enqueue.mutate(reviewDemo || event.shiftKey)}
                  title="Shift + Click で人間のレビュー承認ゲートを有効にして実行"
                  lang="en"
                  className="monitor-button font-en"
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
            </div>
          </div>
        </div>

        <SectionNavigation activeHash={activeHash} projectId={selectedProjectId} />

        <div className="page-width pb-10">
          {/* KPI Metrics */}
          {query.isError && (
            <p role="alert" className="py-2 text-st-red-dark">
              ジョブの取得に失敗しました。ジョブボードから再読み込みできます。
            </p>
          )}
          <MetricsGrid jobs={state.jobs} loading={query.isPending} />

          {/* 01 / Kanban Job Board (First!) */}
          <KanbanSection
            jobs={state.jobs}
            selectedJobId={selectedJobId}
            nowMs={nowMs}
            onSelectJob={selectJob}
            onRefresh={() => void query.refetch()}
          />

          {/* 02 / Unified Execution History & Tabbed Summary/Logs */}
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

          {/* 03 / Trace Explorer */}
          <TraceSection job={selectedJob} nowMs={nowMs} onSelectStage={handleSelectStage} />

          {/* 04 / Recent Events & Artifacts */}
          <BottomGrid job={selectedJob} />

          <footer className="mt-10 flex flex-wrap justify-between gap-3 border-t-2 border-science-blue pt-4 text-sm text-ink-muted">
            <span lang="en" className="font-en font-semibold text-science-blue">
              Institute of Science Tokyo
            </span>
            <span>
              実行履歴のエージェント　
              {agentNames || '記録なし'}
            </span>
          </footer>
        </div>
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
