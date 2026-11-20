import { FolderOpen, SlidersHorizontal, Upload } from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

interface ToastState {
  text: string;
  error: boolean;
}

const EMPTY_PROJECT: ProjectSpec = {
  id: 'default',
  name: '科学データ解析ワークフロー',
  purpose: '',
  acceptanceCriteria: '',
  llm: { model: '', effort: '' },
  stages: [],
  inboxDir: 'projects/default/inbox',
  artifactsDir: 'projects/default/artifacts',
  createdAt: '',
  updatedAt: '',
};

async function postJson<T>(route: string, payload: unknown): Promise<T> {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const answer = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(answer.error || 'Request failed');
  return answer;
}

export function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => readInitialProjectId());
  const [state, setState] = useState<AppStateResponse>({
    projects: [],
    project: EMPTY_PROJECT,
    jobs: [],
    events: [],
    stages: [],
    updatedAt: '',
  });
  const [initialLoading, setInitialLoading] = useState(true);
  const [stateAvailable, setStateAvailable] = useState(false);
  const [streamConnection, setStreamConnection] = useState<
    'connecting' | 'online' | 'reconnecting'
  >('connecting');
  const connection =
    streamConnection === 'online' && !initialLoading && !stateAvailable
      ? 'reconnecting'
      : streamConnection;
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<StageKey>('ingest');
  const [showAllLogs, setShowAllLogs] = useState(false);
  const [activeHash, setActiveHash] = useState<string>(() => window.location.hash || '#board');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [reviewDemo, setReviewDemo] = useState(false);
  const [dragVisible, setDragVisible] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const selectedProjectRef = useRef(selectedProjectId);
  const toastTimerRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  selectedProjectRef.current = selectedProjectId;

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3900);
  }, []);

  const refresh = useCallback(async (projectOverride?: string) => {
    if (loadingRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    loadingRef.current = true;
    const targetProject = projectOverride || selectedProjectRef.current;
    try {
      const response = await fetch(`/api/state?project=${encodeURIComponent(targetProject)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const next = (await response.json()) as AppStateResponse;
      setState(next);
      setStateAvailable(true);
      setInitialLoading(false);
      if (next.project.id !== selectedProjectRef.current) {
        setSelectedProjectId(next.project.id);
      }
      persistProjectId(next.project.id);
      setSelectedJobId((prev) => {
        if (prev && next.jobs.some((job) => job.id === prev)) return prev;
        const firstJob = next.jobs[0] || null;
        if (firstJob) {
          setSelectedStage(pickDefaultStage(firstJob));
        }
        return firstJob?.id || null;
      });
    } catch {
      setStateAvailable(false);
      setInitialLoading(false);
    } finally {
      loadingRef.current = false;
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        queueMicrotask(() => {
          void refresh();
        });
      }
    }
  }, []);

  useEffect(() => {
    void refresh(selectedProjectId);
  }, [refresh, selectedProjectId]);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.onopen = () => {
      setStreamConnection('online');
      void refresh();
    };
    source.onmessage = () => {
      void refresh();
    };
    source.onerror = () => {
      setStreamConnection('reconnecting');
    };
    return () => {
      source.close();
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setActiveHash(window.location.hash || '#board');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const uploadFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const projectId = selectedProjectRef.current;
      try {
        const result = await fetch(
          `/api/upload?filename=${encodeURIComponent(file.name)}&project=${encodeURIComponent(projectId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          },
        );
        const answer = (await result.json()) as { job?: WorkflowJob; error?: string };
        if (!result.ok || !answer.job) throw new Error(answer.error || 'Upload failed');
        setSelectedJobId(answer.job.id);
        setSelectedStage(answer.job.stages[0]?.key || 'ingest');
        setShowAllLogs(false);
        showToast(`${file.name} を ${projectId} へ投入しました`);
        await refresh(projectId);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Upload failed', true);
      }
    },
    [refresh, showToast],
  );

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragVisible(true);
      }
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current -= 1;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setDragVisible(false);
      }
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
      }
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragVisible(false);
      void uploadFile(event.dataTransfer?.files[0]);
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [uploadFile]);

  const selectedJob = useMemo(
    () => state.jobs.find((job) => job.id === selectedJobId) || null,
    [state.jobs, selectedJobId],
  );

  const agentNames = useMemo(() => {
    const names = state.jobs.flatMap((job) => (job.agent ? [job.agent] : []));
    return [...new Set(names)].join(' / ');
  }, [state.jobs]);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setSelectedJobId(null);
    setShowAllLogs(false);
    persistProjectId(projectId);
  }, []);

  const handleSelectJob = useCallback(
    (jobId: string) => {
      setSelectedJobId(jobId);
      setShowAllLogs(false);
      const found = state.jobs.find((job) => job.id === jobId) || null;
      setSelectedStage(pickDefaultStage(found));
    },
    [state.jobs],
  );

  const handleSelectStage = useCallback((stage: StageKey) => {
    setSelectedStage(stage);
    setShowAllLogs(false);
  }, []);

  const handleDemoRun = useCallback(
    async (review: boolean) => {
      const projectId = selectedProjectRef.current;
      try {
        const answer = await postJson<{ job: WorkflowJob }>('/api/demo', {
          projectId,
          review,
        });
        setSelectedJobId(answer.job.id);
        setSelectedStage(answer.job.stages[0]?.key || 'ingest');
        setShowAllLogs(false);
        showToast(
          review ? 'デモジョブを追加しました（レビュー承認あり）' : 'デモジョブを追加しました',
        );
        await refresh(projectId);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Request failed', true);
      }
    },
    [refresh, showToast],
  );

  const handleApproveReview = useCallback(
    async (jobId: string) => {
      try {
        await postJson(`/api/jobs/${jobId}/approve`, {});
        showToast('レビューを承認しました。Workerの次回claimで再開します。');
        await refresh();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Approval failed', true);
      }
    },
    [refresh, showToast],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void uploadFile(event.target.files?.[0]);
    event.target.value = '';
  };

  return (
    <div id="overview" className="min-h-screen bg-white text-ink">
      <AppHeader
        currentPage="monitor"
        projects={state.projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        connection={connection}
        nowMs={nowMs}
      />

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
                  onClick={(event) => void handleDemoRun(reviewDemo || event.shiftKey)}
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
          <MetricsGrid jobs={state.jobs} loading={initialLoading} />

          {/* 01 / Kanban Job Board (First!) */}
          <KanbanSection
            jobs={state.jobs}
            selectedJobId={selectedJobId}
            nowMs={nowMs}
            onSelectJob={handleSelectJob}
            onRefresh={() => void refresh()}
          />

          {/* 02 / Unified Execution History & Tabbed Summary/Logs */}
          <ActionsSection
            jobs={state.jobs}
            selectedJob={selectedJob}
            selectedStage={selectedStage}
            showAllLogs={showAllLogs}
            project={state.project}
            nowMs={nowMs}
            onSelectJob={handleSelectJob}
            onSelectStage={handleSelectStage}
            onShowAllLogs={() => setShowAllLogs(true)}
            onApproveReview={(jobId) => void handleApproveReview(jobId)}
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
