import { useMutation } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';

import type { ProjectSpec } from '../shared/types.ts';
import { jsonRequest, queryClient, request, useProjects, useToast } from './api.ts';
import { ProjectManagement } from './components/ProjectManagement.tsx';
import { ProjectTabs } from './components/ProjectTabs.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import {
  type WorkflowUpdatePayload,
  WorkflowSpecSection,
} from './components/WorkflowSpecSection.tsx';
import { pageHref, persistProjectId, readInitialProjectId } from './utils/workflow.ts';

type ProjectResponse = { projects: ProjectSpec[]; project: ProjectSpec };

export function SettingsPage({ page }: { page: 'projects' | 'workflow' }) {
  const managing = page === 'projects';
  const [requestedId, setRequestedId] = useState(readInitialProjectId);
  const projectsQuery = useProjects();
  const projects = projectsQuery.data?.projects ?? [];
  const project = projects.find((item) => item.id === requestedId) ?? projects[0];
  const { toast, showToast } = useToast();
  const select = (value: string) => {
    setRequestedId(value);
    persistProjectId(value);
  };
  return (
    <div className="min-h-screen bg-white text-ink">
      <AppHeader
        currentPage={page}
        projects={projects}
        selectedProjectId={project?.id ?? requestedId}
        onSelectProject={select}
        connection={
          projectsQuery.isError ? 'reconnecting' : projectsQuery.isPending ? 'connecting' : 'online'
        }
      />
      <main className="workflow-page page-width">
        <div className="workflow-title">
          <h1>{managing ? 'プロジェクト' : 'ワークフロー'}</h1>
          {project && (
            <a href={pageHref(managing ? '/workflow' : '/', project.id)}>
              {managing ? 'ワークフローへ' : '実行モニターへ'} <ArrowRight size={16} />
            </a>
          )}
        </div>
        {project &&
          (managing ? (
            <ProjectTabs projects={projects} onSelect={select}>
              <ProjectManagement
                key={project.id}
                project={project}
                projects={projects}
                onSelect={select}
                showToast={showToast}
              />
            </ProjectTabs>
          ) : (
            <WorkflowEditor key={project.id} project={project} showToast={showToast} />
          ))}
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
  const [revision, setRevision] = useState(0);
  const save = useMutation({
    mutationFn: (payload: WorkflowUpdatePayload) =>
      request<ProjectResponse>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        jsonRequest('PUT', payload),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
  function saveWorkflow(payload: WorkflowUpdatePayload) {
    save.mutate(payload, {
      onSuccess: ({ project: saved }) => {
        setRevision((prev) => prev + 1);
        showToast(`「${saved.name}」の定義を保存しました。`);
      },
      onError: (err) => showToast(err.message, true),
    });
  }
  return (
    <WorkflowSpecSection
      key={revision}
      project={project}
      saving={save.isPending}
      onSave={saveWorkflow}
    />
  );
}
