import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { useState } from 'react';

import type { ProjectSpec } from '../shared/types.ts';
import { jsonRequest, queryClient, request, useConnection, useProjects, useToast } from './api.ts';
import { ProjectCreate, ProjectManagement } from './components/ProjectManagement.tsx';
import { ProjectList } from './components/ProjectList.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import {
  type WorkflowUpdatePayload,
  WorkflowSpecSection,
} from './components/WorkflowSpecSection.tsx';
import {
  pageHref,
  persistProjectId,
  readInitialProjectId,
  rememberProjectId,
} from './utils/workflow.ts';

type ProjectResponse = { projects: ProjectSpec[]; project: ProjectSpec };

export const settingsTitles = {
  list: 'プロジェクト一覧',
  new: '新規プロジェクト',
  projects: 'プロジェクト',
  workflow: 'ワークフロー',
};

export function SettingsPage({ view }: { view: keyof typeof settingsTitles }) {
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
  const select = (value: string) => {
    if (view === 'list') {
      rememberProjectId(value);
      window.location.assign(pageHref('/projects', value));
      return;
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
        onSelectProject={select}
        connection={connection}
      />
      <main className="workflow-page page-width">
        <div className="workflow-title">
          <h1>{settingsTitles[view]}</h1>
          {view === 'list' ? (
            <a href="/projects?new=1">
              <Plus size={16} />
              新規プロジェクト
            </a>
          ) : (
            project &&
            view !== 'new' && (
              <a href={pageHref(view === 'projects' ? '/workflow' : '/jobs', project.id)}>
                {view === 'projects' ? 'ワークフローへ' : 'ジョブ一覧へ'} <ArrowRight size={16} />
              </a>
            )
          )}
        </div>
        {view === 'list' && projectsQuery.data && <ProjectList projects={projects} />}
        {view === 'new' && (
          <ProjectCreate
            showToast={showToast}
            onCancel={() => window.location.assign('/projects')}
            onSelect={(id) => {
              rememberProjectId(id);
              window.location.replace(pageHref('/projects', id));
            }}
          />
        )}
        {view === 'projects' && project && (
          <ProjectManagement
            key={project.id}
            project={project}
            projects={projects}
            onDeleted={() => window.location.replace('/projects')}
            showToast={showToast}
          />
        )}
        {view === 'workflow' && project && (
          <WorkflowEditor key={project.id} project={project} showToast={showToast} />
        )}
        {(view === 'projects' || view === 'workflow') && !project && projectsQuery.isSuccess && (
          <p role="status">
            指定されたプロジェクトが見つかりません。{' '}
            <a href="/projects" className="text-science-blue underline">
              プロジェクト一覧へ戻る
            </a>
          </p>
        )}
        {projectsQuery.isError && (
          <p role="alert">
            プロジェクトを取得できませんでした。{' '}
            <button onClick={() => void projectsQuery.refetch()}>再読み込み</button>
          </p>
        )}
        {projectsQuery.isPending && <p role="status">読み込み中…</p>}
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
  showToast,
}: {
  project: ProjectSpec;
  showToast: (text: string, error?: boolean) => void;
}) {
  const save = useMutation({
    mutationFn: (payload: WorkflowUpdatePayload) =>
      request<ProjectResponse>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        jsonRequest('PUT', payload),
      ),
    onSuccess: ({ projects }) => {
      queryClient.setQueryData(['projects'], { projects });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  function saveWorkflow(payload: WorkflowUpdatePayload) {
    save.mutate(payload, {
      onSuccess: ({ project: saved }) => {
        showToast(`「${saved.name}」の定義を保存しました。`);
      },
      onError: (err) => showToast(err.message, true),
    });
  }
  return <WorkflowSpecSection project={project} saving={save.isPending} onSave={saveWorkflow} />;
}
