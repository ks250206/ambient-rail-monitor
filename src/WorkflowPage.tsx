import { useMutation } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { ProjectSpec } from '../shared/types.ts';
import { jsonRequest, queryClient, request, useProjects, useToast } from './api.ts';
import { AppHeader } from './components/AppHeader.tsx';
import {
  type ProjectUpdatePayload,
  WorkflowSpecSection,
} from './components/WorkflowSpecSection.tsx';
import { pageHref, persistProjectId, readInitialProjectId } from './utils/workflow.ts';

type ProjectResponse = { projects: ProjectSpec[]; project: ProjectSpec };

export function WorkflowPage() {
  const [requestedId, setRequestedId] = useState(readInitialProjectId);
  const [revision, setRevision] = useState<Record<string, number>>({});
  const projectsQuery = useProjects();
  const projects = projectsQuery.data?.projects ?? [];
  const project = projects.find((item) => item.id === requestedId) ?? projects[0];
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const { toast, showToast } = useToast();
  const select = (value: string) => {
    setRequestedId(value);
    persistProjectId(value);
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['projects'] });
  const onError = (err: Error) => showToast(err.message, true);
  const save = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ProjectUpdatePayload }) =>
      request<ProjectResponse>(
        `/api/projects/${encodeURIComponent(id)}`,
        jsonRequest('PUT', payload),
      ),
    onSuccess: async ({ project: saved }) => {
      await refresh();
      setRevision((prev) => ({ ...prev, [saved.id]: (prev[saved.id] ?? 0) + 1 }));
      showToast(`「${saved.name}」を保存しました。`);
    },
    onError,
  });
  const create = useMutation({
    mutationFn: () =>
      request<ProjectResponse>(
        '/api/projects',
        jsonRequest('POST', { name: name.trim(), id: id.trim() || undefined }),
      ),
    onSuccess: async ({ project: created }) => {
      await refresh();
      select(created.id);
      setName('');
      setId('');
      showToast(`「${created.name}」を作成しました。`);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      request<{ projects: ProjectSpec[] }>(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async ({ projects: remaining }, removedId) => {
      await refresh();
      if (readInitialProjectId() === removedId && remaining[0]) select(remaining[0].id);
      showToast('プロジェクトを削除しました。');
    },
    onError,
  });

  return (
    <div className="min-h-screen bg-white text-ink">
      <AppHeader
        currentPage="workflow"
        projects={projects}
        selectedProjectId={project?.id ?? requestedId}
        onSelectProject={select}
        connection={
          projectsQuery.isError ? 'reconnecting' : projectsQuery.isPending ? 'connecting' : 'online'
        }
      />
      <main className="workflow-page page-width">
        <div className="workflow-title">
          <h1>ワークフロー定義</h1>
          {project && (
            <a href={pageHref('/', project.id)}>
              実行モニターへ <ArrowRight size={16} />
            </a>
          )}
        </div>
        {project && (
          <WorkflowSpecSection
            key={project.id + '/' + (revision[project.id] ?? 0)}
            project={project}
            saving={save.isPending}
            onSave={(payload) => save.mutate({ id: project.id, payload })}
          />
        )}
        {projectsQuery.isError && (
          <p role="alert">
            プロジェクトを取得できませんでした。{' '}
            <button onClick={() => void projectsQuery.refetch()}>再読み込み</button>
          </p>
        )}
        {projectsQuery.isPending && <p role="status">読み込み中…</p>}
        <details className="wf-disclosure wf-management">
          <summary>
            プロジェクト管理 <ChevronDown size={17} />
          </summary>
          <form
            className="wf-fields"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label>
              新規プロジェクト名
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
              />
            </label>
            <label>
              ディレクトリ ID（任意）
              <input value={id} onChange={(e) => setId(e.target.value)} maxLength={48} />
            </label>
            <button className="wf-secondary" disabled={create.isPending || !name.trim()}>
              プロジェクトを追加
            </button>
          </form>
          {project && projects.length > 1 && (
            <button
              className="wf-delete"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `「${project.name}」を一覧から削除しますか？ 保存済みのファイルは残ります。`,
                  )
                )
                  remove.mutate(project.id);
              }}
            >
              <Trash2 size={14} /> 選択中のプロジェクトを削除
            </button>
          )}
        </details>
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
