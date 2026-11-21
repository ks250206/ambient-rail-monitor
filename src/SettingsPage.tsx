import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ProjectSpec } from '../shared/types.ts';
import {
  ApiError,
  jsonRequest,
  queryClient,
  request,
  useConnection,
  useProjects,
  useToast,
} from './api.ts';
import { ProjectCreate, ProjectManagement } from './components/ProjectManagement.tsx';
import { ProjectList } from './components/ProjectList.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import { confirmDialog } from './components/DialogHost.tsx';
import {
  type WorkflowUpdatePayload,
  WorkflowSpecSection,
} from './components/WorkflowSpecSection.tsx';
import { pickText, useI18n, type Locale } from './i18n.ts';
import { navigateWithTransition } from './utils/navigation.ts';
import {
  pageHref,
  persistProjectId,
  readInitialProjectId,
  rememberProjectId,
} from './utils/workflow.ts';

type ProjectResponse = { projects: ProjectSpec[]; project: ProjectSpec };

export const settingsTitles = {
  list: { ja: 'プロジェクト一覧', en: 'Projects' },
  new: { ja: '新規プロジェクト', en: 'New project' },
  projects: { ja: 'プロジェクト', en: 'Project' },
  workflow: { ja: 'ワークフロー', en: 'Workflow' },
} as const;

export function getSettingsTitle(view: keyof typeof settingsTitles, locale: Locale): string {
  return pickText(locale, settingsTitles[view].ja, settingsTitles[view].en);
}

export function SettingsPage({ view }: { view: keyof typeof settingsTitles }) {
  const { locale, pick } = useI18n();
  const connection = useConnection();
  const [requestedId, setRequestedId] = useState(readInitialProjectId);
  const projectsQuery = useProjects();
  const projects = projectsQuery.data?.projects ?? [];
  const project =
    projects.find((item) => item.id === requestedId) ??
    (view === 'workflow' && !new URLSearchParams(window.location.search).has('project')
      ? projects[0]
      : undefined);
  const { toast, showToast } = useToast();
  const [workflowDirty, setWorkflowDirty] = useState(false);

  useEffect(() => {
    document.title = `${getSettingsTitle(view, locale)} — RAILFLOW | Science Tokyo`;
  }, [view, locale]);

  useEffect(() => {
    if (!workflowDirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [workflowDirty]);

  const select = async (value: string) => {
    if (view === 'list') {
      rememberProjectId(value);
      navigateWithTransition(pageHref('/projects', value));
      return;
    }
    if (workflowDirty && value !== project?.id) {
      const ok = await confirmDialog({
        title: pick('未保存の変更を破棄しますか？', 'Discard unsaved changes?'),
        message: pick(
          '未保存のワークフロー定義を破棄してプロジェクトを切り替えますか？',
          'Switch projects and discard your unsaved workflow edits?',
        ),
        confirmLabel: pick('破棄して切り替え', 'Discard & switch'),
        cancelLabel: pick('編集に戻る', 'Keep editing'),
        tone: 'danger',
      });
      if (!ok) return;
    }
    setRequestedId(value);
    persistProjectId(value);
  };

  return (
    <div className="min-h-screen bg-white text-ink">
      <AppHeader
        currentPage={view}
        projects={projects}
        selectedProjectId={project?.id ?? requestedId}
        onSelectProject={(value) => void select(value)}
        connection={connection}
      />
      <main className="workflow-page page-width">
        <div className="workflow-title">
          <h1>{getSettingsTitle(view, locale)}</h1>
          {view === 'list' ? (
            <a href="/projects?new=1">
              <Plus size={16} />
              {pick('新規プロジェクト', 'New project')}
            </a>
          ) : (
            project &&
            view !== 'new' && (
              <a href={pageHref(view === 'projects' ? '/workflow' : '/jobs', project.id)}>
                {view === 'projects'
                  ? pick('ワークフローへ', 'Workflow')
                  : pick('ジョブ一覧へ', 'Jobs')}{' '}
                <ArrowRight size={16} />
              </a>
            )
          )}
        </div>
        {view === 'list' && projectsQuery.data && <ProjectList projects={projects} />}
        {view === 'new' && (
          <ProjectCreate
            showToast={showToast}
            onCancel={() => navigateWithTransition('/projects')}
            onSelect={(id) => {
              rememberProjectId(id);
              navigateWithTransition(pageHref('/projects', id), { replace: true });
            }}
          />
        )}
        {view === 'projects' && project && (
          <div key={project.id} className="panel-enter">
            <ProjectManagement
              project={project}
              projects={projects}
              onDeleted={() => navigateWithTransition('/projects', { replace: true })}
              showToast={showToast}
            />
          </div>
        )}
        {view === 'workflow' && project && (
          <div key={project.id} className="panel-enter">
            <WorkflowEditor
              project={project}
              showToast={showToast}
              onDirtyChange={setWorkflowDirty}
            />
          </div>
        )}
        {(view === 'projects' || view === 'workflow') && !project && projectsQuery.isSuccess && (
          <p role="status">
            {pick(
              '指定されたプロジェクトが見つかりません。',
              'The requested project was not found.',
            )}{' '}
            <a href="/projects" className="text-science-blue underline">
              {pick('プロジェクト一覧へ戻る', 'Back to projects')}
            </a>
          </p>
        )}
        {projectsQuery.isError && (
          <p role="alert">
            {pick('プロジェクトを取得できませんでした。', 'Failed to load projects.')}{' '}
            <button onClick={() => void projectsQuery.refetch()}>
              {pick('再読み込み', 'Reload')}
            </button>
          </p>
        )}
        {projectsQuery.isPending && <p role="status">{pick('読み込み中…', 'Loading…')}</p>}
      </main>
      {toast && (
        <div
          role="status"
          className={`wf-toast ${toast.error ? 'bg-st-red-dark' : 'bg-science-blue'}`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function WorkflowEditor({
  project,
  onDirtyChange,
  showToast,
}: {
  project: ProjectSpec;
  onDirtyChange: (dirty: boolean) => void;
  showToast: (text: string, error?: boolean) => void;
}) {
  const { pick } = useI18n();
  const save = useMutation({
    mutationFn: (payload: WorkflowUpdatePayload & { expectedUpdatedAt: string }) =>
      request<ProjectResponse>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        jsonRequest('PUT', { ...payload, graph: payload.graph ?? null }),
      ),
    onSuccess: ({ projects }) => {
      queryClient.setQueryData(['projects'], { projects });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  function saveWorkflow(
    payload: WorkflowUpdatePayload,
    expectedUpdatedAt: string,
    onSaved: (saved: ProjectSpec) => void,
  ) {
    save.mutate(
      { ...payload, expectedUpdatedAt },
      {
        onSuccess: ({ project: saved }) => {
          onSaved(saved);
          showToast(
            pick(
              `「${saved.name}」の定義を保存しました。`,
              `Saved workflow definition for "${saved.name}".`,
            ),
          );
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409)
            void queryClient.invalidateQueries({ queryKey: ['projects'] });
          showToast(err.message, true);
        },
      },
    );
  }
  return (
    <WorkflowSpecSection
      project={project}
      saving={save.isPending}
      onDirtyChange={onDirtyChange}
      onSave={saveWorkflow}
    />
  );
}
