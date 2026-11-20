import { ArrowRight, FolderPlus, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import type { AppStateResponse, ProjectSpec } from '../shared/types.ts';
import { AppHeader } from './components/AppHeader.tsx';
import {
  type ProjectUpdatePayload,
  WorkflowSpecSection,
} from './components/WorkflowSpecSection.tsx';
import { pageHref, persistProjectId, readInitialProjectId } from './utils/workflow.ts';

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

export function WorkflowPage() {
  const [projects, setProjects] = useState<ProjectSpec[]>([]);
  const [project, setProject] = useState<ProjectSpec>(EMPTY_PROJECT);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => readInitialProjectId());
  const [connection, setConnection] = useState<'connecting' | 'online' | 'reconnecting'>(
    'connecting',
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
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

  const loadState = useCallback(async (projectId: string) => {
    try {
      const response = await fetch(`/api/state?project=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const next = (await response.json()) as AppStateResponse;
      setProjects(next.projects);
      setProject(next.project);
      setSelectedProjectId(next.project.id);
      persistProjectId(next.project.id);
      setConnection('online');
    } catch {
      setConnection('reconnecting');
    }
  }, []);

  useEffect(() => {
    void loadState(selectedProjectId);
  }, [loadState, selectedProjectId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    persistProjectId(projectId);
  }, []);

  const handleSave = useCallback(
    async (next: ProjectUpdatePayload) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        });
        const answer = (await res.json()) as {
          project?: ProjectSpec;
          projects?: ProjectSpec[];
          error?: string;
        };
        if (!res.ok || !answer.project) throw new Error(answer.error || '保存に失敗しました');
        setProject(answer.project);
        if (answer.projects) setProjects(answer.projects);
        showToast(`プロジェクト「${answer.project.name}」の定義を保存しました`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '保存に失敗しました', true);
      } finally {
        setSaving(false);
      }
    },
    [project.id, showToast],
  );

  const handleCreateProject = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = newProjectName.trim();
    if (!trimmedName) return;
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          id: newProjectId.trim() || undefined,
        }),
      });
      const answer = (await res.json()) as {
        project?: ProjectSpec;
        projects?: ProjectSpec[];
        error?: string;
      };
      if (!res.ok || !answer.project) throw new Error(answer.error || '作成に失敗しました');
      setNewProjectName('');
      setNewProjectId('');
      if (answer.projects) setProjects(answer.projects);
      setProject(answer.project);
      setSelectedProjectId(answer.project.id);
      persistProjectId(answer.project.id);
      showToast(
        `プロジェクト「${answer.project.name}」（${answer.project.inboxDir}）を作成しました`,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : '作成に失敗しました', true);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteProject = async (target: ProjectSpec) => {
    if (projects.length <= 1) return;
    if (
      !window.confirm(
        `プロジェクト「${target.name} (${target.id})」を一覧から削除しますか？\n（フォルダ内の既存ファイルは削除されません）`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      const answer = (await res.json()) as { projects?: ProjectSpec[]; error?: string };
      if (!res.ok || !answer.projects) throw new Error(answer.error || '削除に失敗しました');
      setProjects(answer.projects);
      const fallback = answer.projects[0];
      if (fallback) {
        setProject(fallback);
        setSelectedProjectId(fallback.id);
        persistProjectId(fallback.id);
      }
      showToast(`プロジェクト「${target.name}」を削除しました`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '削除に失敗しました', true);
    }
  };

  return (
    <div className="min-h-screen bg-white text-ink">
      <AppHeader
        currentPage="workflow"
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        connection={connection}
        nowMs={nowMs}
      />

      <main className="page-width py-6 pb-12">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-eyebrow">
              STEP 1 · プロジェクト・ワークフロー設定
            </p>
            <h1 className="mt-1 text-2xl font-bold text-science-blue sm:text-3xl">
              ワークフロー定義・カスタム指示
            </h1>
          </div>

          <a href={pageHref('/', selectedProjectId)} className="monitor-button gap-2 text-sm">
            <span>実行モニターへ進む</span>
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        {/* Multi-project selector & creator */}
        <section
          aria-label="プロジェクト一覧と新規作成"
          className="mb-6 rounded-md border border-line bg-bg-2/60 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-science-blue">
                プロジェクト一覧（{projects.length}）
              </h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                プロジェクトごとに独立したワークフロー工程・`inbox`・`artifacts`
                ディレクトリを持ちます。
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {projects.map((item) => {
              const active = item.id === project.id;
              return (
                <div
                  key={item.id}
                  className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    active
                      ? 'border-science-blue bg-science-blue text-white'
                      : 'border-line bg-white text-ink hover:border-eyebrow'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectProject(item.id)}
                    className="inline-flex items-center gap-1.5 text-left font-bold"
                  >
                    <span>{item.name}</span>
                    <span
                      className={`font-mono text-[10px] ${
                        active ? 'text-navy-200' : 'text-ink-muted'
                      }`}
                    >
                      {item.id} · {item.stages.length}工程
                    </span>
                  </button>
                  {projects.length > 1 && (
                    <button
                      type="button"
                      aria-label={`${item.name} を削除`}
                      onClick={() => void handleDeleteProject(item)}
                      className={`ml-1 rounded p-0.5 ${
                        active
                          ? 'text-navy-200 hover:bg-white/15 hover:text-white'
                          : 'text-ink-muted hover:bg-st-red-bg hover:text-st-red-dark'
                      }`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <form
            onSubmit={(event) => void handleCreateProject(event)}
            className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3.5"
          >
            <label className="min-w-[200px] flex-1">
              <span className="block text-[11px] font-bold text-ink">新規プロジェクト名</span>
              <input
                type="text"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                maxLength={120}
                placeholder="例: XRD 回折解析プロジェクト"
                required
                className="mt-1 w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-science-blue focus:outline-none"
              />
            </label>
            <label className="w-48">
              <span className="block text-[11px] font-bold text-ink">
                ディレクトリ ID（任意・半角英数）
              </span>
              <input
                type="text"
                value={newProjectId}
                onChange={(event) => setNewProjectId(event.target.value)}
                maxLength={48}
                placeholder="例: xrd-lab"
                className="mt-1 w-full rounded-md border border-line bg-white px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-muted focus:border-science-blue focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={creating || !newProjectName.trim()}
              className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-science-blue px-3.5 text-xs font-bold text-white hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              {creating ? '作成中…' : 'プロジェクトを追加'}
            </button>
          </form>
        </section>

        <WorkflowSpecSection project={project} saving={saving} onSave={handleSave} />

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
