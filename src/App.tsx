import { Plus, Upload } from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AppStateResponse, StageKey, WorkflowJob } from '../shared/types.ts';
import { ActionsSection } from './components/ActionsSection.tsx';
import { BottomGrid } from './components/BottomGrid.tsx';
import { KanbanSection } from './components/KanbanSection.tsx';
import { MetricsGrid } from './components/MetricsGrid.tsx';
import { RailwayAndInspector } from './components/RailwayAndInspector.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TraceSection } from './components/TraceSection.tsx';
import { clock, pickDefaultStage } from './utils/workflow.ts';

interface ToastState {
  text: string;
  error: boolean;
}

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
  const [state, setState] = useState<AppStateResponse>({
    jobs: [],
    events: [],
    stages: [],
    updatedAt: '',
  });
  const [initialLoading, setInitialLoading] = useState(true);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'reconnecting'>(
    'connecting',
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<StageKey>('ingest');
  const [showAllLogs, setShowAllLogs] = useState(false);
  const [activeHash, setActiveHash] = useState<string>(() => window.location.hash || '#overview');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dragVisible, setDragVisible] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3900);
  }, []);

  const refresh = useCallback(async () => {
    if (loadingRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status}`);
      const next = (await response.json()) as AppStateResponse;
      setState(next);
      setConnection('online');
      setInitialLoading(false);
      setSelectedJobId((prev) => {
        if (prev && next.jobs.some((job) => job.id === prev)) return prev;
        const firstJob = next.jobs[0] || null;
        if (firstJob) {
          setSelectedStage(pickDefaultStage(firstJob));
        }
        return firstJob?.id || null;
      });
    } catch {
      setConnection('reconnecting');
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
    void refresh();
    const source = new EventSource('/api/stream');
    source.onmessage = () => {
      void refresh();
    };
    source.onerror = () => {
      setConnection('reconnecting');
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
      setActiveHash(window.location.hash || '#overview');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const uploadFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const result = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        });
        const answer = (await result.json()) as { job?: WorkflowJob; error?: string };
        if (!result.ok || !answer.job) throw new Error(answer.error || 'Upload failed');
        setSelectedJobId(answer.job.id);
        setSelectedStage('ingest');
        setShowAllLogs(false);
        showToast(`${file.name} を投入しました`);
        await refresh();
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

  const activeAgents = useMemo(() => {
    const agents = new Set(state.jobs.map((job) => (job.agent || '').toLowerCase()));
    return {
      codex: agents.has('codex'),
      claude: agents.has('claude'),
      demo: agents.has('demo') || state.jobs.length === 0,
    };
  }, [state.jobs]);

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
      try {
        const answer = await postJson<{ job: WorkflowJob }>('/api/demo', { review });
        setSelectedJobId(answer.job.id);
        setSelectedStage('ingest');
        setShowAllLogs(false);
        showToast(
          review ? 'デモジョブを追加しました（レビュー承認あり）' : 'デモジョブを追加しました',
        );
        await refresh();
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
    <div className="flex min-h-screen bg-white text-ink">
      <Sidebar activeHash={activeHash} onNavigate={setActiveHash} activeAgents={activeAgents} />

      <main id="overview" className="min-w-0 flex-1 bg-white">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-white/95 px-4 backdrop-blur-xs sm:px-8">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span className="font-en font-bold text-science-blue lg:hidden">RAILFLOW</span>
            <span className="lg:hidden">/</span>
            <span className="font-en hidden sm:inline">Workspaces</span>
            <span className="hidden sm:inline">/</span>
            <span className="font-en">Science Tokyo</span>
            <span>/</span>
            <strong className="font-en font-semibold text-science-blue">Overview</strong>
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            <span
              className={`h-2 w-2 rounded-full ${
                connection === 'online' ? 'bg-st-green' : 'bg-st-orange animate-st-pulse'
              }`}
            />
            <span className="font-medium text-ink">
              {connection === 'online'
                ? 'Local server online'
                : connection === 'connecting'
                  ? 'Connecting'
                  : 'Reconnecting…'}
            </span>
            <span className="hidden h-3.5 w-px bg-line sm:inline-block" />
            <span className="hidden font-mono text-ink-muted tabular-nums sm:inline">
              {clock(new Date(nowMs).toISOString())}
            </span>
          </div>
        </header>

        <div className="mx-auto max-w-[1620px] px-4 py-6 sm:px-8 sm:py-7">
          {/* Hero Header Card with Science Tokyo Arch Graphic Element (anchored to 3+ edges) */}
          <div className="relative overflow-hidden rounded-xl border border-line bg-white shadow-2xs">
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 1200 180"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect width="1200" height="180" fill="#ffffff" />
              <polygon points="0,0 1200,0 1200,10 0,24" fill="#1c3177" />
              <polygon points="880,180 1200,82 1200,180" fill="#f2f4f9" />
              <polygon points="1010,180 1200,132 1200,180" fill="#7f96c2" />
            </svg>

            <div className="relative flex flex-col justify-between gap-5 px-5 pb-6 pt-8 sm:flex-row sm:items-center sm:px-7">
              <div className="max-w-2xl">
                <p className="font-en text-[11px] font-bold tracking-[0.15em] text-eyebrow uppercase">
                  Institute of Science Tokyo · Monitoring / Research Automation
                </p>
                <h1 className="font-en mt-1.5 text-2xl font-bold tracking-tight text-science-blue sm:text-3xl">
                  Ambient workflows
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                  ファイル投入から解析、科学的検証、成果物生成まで。すべての工程をひとつの実行履歴で追跡します。
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-science-blue bg-white px-4 py-2.5 text-xs font-bold text-science-blue transition-colors hover:bg-bg-2"
                >
                  <Upload className="h-4 w-4" />
                  ファイル投入
                </button>
                <button
                  type="button"
                  onClick={(event) => void handleDemoRun(event.shiftKey)}
                  title="Shift + Click で人間のレビュー承認ゲートを有効にして実行"
                  className="inline-flex items-center gap-2 rounded-lg bg-science-blue px-4 py-2.5 text-xs font-bold text-white shadow-xs transition-colors hover:bg-navy-800"
                >
                  <Plus className="h-4 w-4" />
                  Demo run
                </button>
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

          {/* KPI Metrics */}
          <MetricsGrid jobs={state.jobs} loading={initialLoading} />

          {/* 01 / Actions / Runs */}
          <ActionsSection
            jobs={state.jobs}
            selectedJob={selectedJob}
            selectedStage={selectedStage}
            showAllLogs={showAllLogs}
            nowMs={nowMs}
            onSelectJob={handleSelectJob}
            onSelectStage={handleSelectStage}
            onShowAllLogs={() => setShowAllLogs(true)}
            onApproveReview={(jobId) => void handleApproveReview(jobId)}
          />

          {/* 02 / Kanban Board */}
          <KanbanSection
            jobs={state.jobs}
            selectedJobId={selectedJobId}
            nowMs={nowMs}
            onSelectJob={handleSelectJob}
            onRefresh={() => void refresh()}
          />

          {/* 03 / Execution Railway + Step Inspector */}
          <RailwayAndInspector
            job={selectedJob}
            selectedStage={selectedStage}
            nowMs={nowMs}
            onSelectStage={handleSelectStage}
            onApproveReview={(jobId) => void handleApproveReview(jobId)}
          />

          {/* 04 / Trace Explorer */}
          <TraceSection job={selectedJob} nowMs={nowMs} onSelectStage={handleSelectStage} />

          {/* 05 / Recent Events & 06 / Artifacts */}
          <BottomGrid job={selectedJob} />

          {/* Footer */}
          <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[11px] text-ink-muted">
            <span className="font-en font-semibold text-science-blue">
              Science Tokyo · RAILFLOW / AMBIENT EXECUTION MONITOR
            </span>
            <span>Observe the work. Keep the agent independent.</span>
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
            <strong className="mt-3 text-2xl font-bold">解析データをドロップ</strong>
            <small className="font-en mt-2 text-sm text-navy-200">
              CSV · TSV · JSON · TXT · DAT
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
