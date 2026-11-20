import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppStateResponse, StageDefinition, WorkflowSpec } from '../shared/types.ts';
import { AppHeader } from './components/AppHeader.tsx';
import { WorkflowSpecSection } from './components/WorkflowSpecSection.tsx';

interface ToastState {
  text: string;
  error: boolean;
}

const EMPTY_WORKFLOW: WorkflowSpec = {
  title: '科学データ解析ワークフロー',
  purpose: '',
  acceptanceCriteria: '',
  llm: { model: '', effort: '' },
  stageLlm: {
    ingest: { model: '', effort: '' },
    preprocess: { model: '', effort: '' },
    analysis: { model: '', effort: '' },
    validate: { model: '', effort: '' },
    visualize: { model: '', effort: '' },
    publish: { model: '', effort: '' },
  },
  stageInstructions: {
    ingest: '',
    preprocess: '',
    analysis: '',
    validate: '',
    visualize: '',
    publish: '',
  },
  updatedAt: '',
};

export function WorkflowPage() {
  const [workflow, setWorkflow] = useState<WorkflowSpec>(EMPTY_WORKFLOW);
  const [stages, setStages] = useState<StageDefinition[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'reconnecting'>(
    'connecting',
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3900);
  }, []);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status}`);
      const next = (await response.json()) as AppStateResponse;
      setWorkflow(next.workflow);
      setStages(next.stages);
      setConnection('online');
    } catch {
      setConnection('reconnecting');
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  const handleSave = useCallback(
    async (next: Omit<WorkflowSpec, 'updatedAt'>) => {
      setSaving(true);
      try {
        const res = await fetch('/api/workflow', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        });
        const answer = (await res.json()) as { workflow?: WorkflowSpec; error?: string };
        if (!res.ok || !answer.workflow) throw new Error(answer.error || '保存に失敗しました');
        setWorkflow(answer.workflow);
        showToast('ワークフロー定義・LLM 設定・カスタム指示を保存しました');
      } catch (err) {
        showToast(err instanceof Error ? err.message : '保存に失敗しました', true);
      } finally {
        setSaving(false);
      }
    },
    [showToast],
  );

  return (
    <div className="min-h-screen bg-white text-ink">
      <AppHeader currentPage="workflow" connection={connection} nowMs={nowMs} />

      <main className="page-width py-6 pb-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-eyebrow">STEP 1 · ワークフロー設定</p>
            <h1 className="mt-1 text-2xl font-bold text-science-blue sm:text-3xl">
              ワークフロー定義・カスタム指示
            </h1>
          </div>

          <a href="/" className="monitor-button gap-2 text-sm">
            <span>実行モニターへ進む</span>
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <WorkflowSpecSection
          workflow={workflow}
          stages={stages}
          saving={saving}
          onSave={handleSave}
        />

        <footer className="mt-10 flex flex-wrap justify-between gap-3 border-t-2 border-science-blue pt-4 text-sm text-ink-muted">
          <span lang="en" className="font-en font-semibold text-science-blue">
            Institute of Science Tokyo
          </span>
          <span>保存した設定は次回ワーカーのジョブ取得時に適用されます</span>
        </footer>
      </main>

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
