import { useMutation } from '@tanstack/react-query';
import { FolderPlus, Save, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { ProjectSpec } from '../../shared/types.ts';
import { jsonRequest, queryClient, request } from '../api.ts';

interface ProjectManagementProps {
  project: ProjectSpec;
  projects: ProjectSpec[];
  onSelect: (id: string) => void;
  showToast: (text: string, error?: boolean) => void;
}

interface ProjectResponse {
  project: ProjectSpec;
}

const newProject = { name: '', purpose: '', id: '' };

function refreshProjects() {
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
}

function updateProjectCache({ project }: ProjectResponse) {
  queryClient.setQueryData<{ projects: ProjectSpec[] }>(['projects'], (previous) => {
    if (!previous) return previous;
    const existing = previous.projects.find((item) => item.id === project.id);
    if (!existing) return { projects: [...previous.projects, project] };
    if (existing.updatedAt > project.updatedAt) return previous;
    return { projects: previous.projects.map((item) => (item.id === project.id ? project : item)) };
  });
  refreshProjects();
}

export function ProjectManagement({
  project,
  projects,
  onSelect,
  showToast,
}: ProjectManagementProps) {
  const [creating, setCreating] = useState(false);
  const [edits, setEdits] = useState<Partial<Pick<ProjectSpec, 'name' | 'purpose'>>>({});
  const [draft, setDraft] = useState(newProject);
  const current = creating ? draft : { ...project, ...edits };
  const projectUrl = `/api/projects/${encodeURIComponent(project.id)}`;
  const create = useMutation({
    mutationFn: () =>
      request<ProjectResponse>(
        '/api/projects',
        jsonRequest('POST', {
          name: draft.name.trim(),
          purpose: draft.purpose,
          id: draft.id.trim() || undefined,
        }),
      ),
    onSuccess: updateProjectCache,
  });
  const save = useMutation({
    mutationFn: () =>
      request<ProjectResponse>(
        projectUrl,
        jsonRequest('PUT', {
          ...edits,
          name: edits.name?.trim(),
        }),
      ),
    onSuccess: updateProjectCache,
  });
  const remove = useMutation({
    mutationFn: () => request<{ projects: ProjectSpec[] }>(projectUrl, { method: 'DELETE' }),
    onSuccess: refreshProjects,
  });

  const pending = create.isPending || save.isPending || remove.isPending;
  const changed = current.name.trim() !== project.name || current.purpose !== project.purpose;
  const error = creating ? create.error : save.error || remove.error;

  function update(field: 'name' | 'purpose', value: string) {
    if (creating) setDraft((prev) => ({ ...prev, [field]: value }));
    else setEdits((prev) => ({ ...prev, [field]: value }));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !current.name.trim()) return;
    // Per-call callbacks belong to this mounted form. Changing the header selection
    // leaves the server update intact without navigating the user back to its result.
    if (creating) {
      create.mutate(undefined, {
        onSuccess: ({ project: added }) => {
          setCreating(false);
          setDraft(newProject);
          onSelect(added.id);
          showToast(`「${added.name}」を作成しました。`);
        },
      });
    } else if (changed) {
      remove.reset();
      save.mutate(undefined, {
        onSuccess: ({ project: saved }) => {
          setEdits({});
          showToast(`「${saved.name}」を保存しました。`);
        },
      });
    }
  }
  function deleteProject() {
    if (pending || projects.length <= 1) return;
    if (
      !window.confirm(`「${project.name}」を一覧から削除しますか？ 保存済みのファイルは残ります。`)
    )
      return;
    save.reset();
    remove.mutate(undefined, {
      onSuccess: ({ projects: remaining }) => {
        if (remaining[0]) onSelect(remaining[0].id);
        showToast(`「${project.name}」を削除しました。`);
      },
    });
  }

  return (
    <section aria-labelledby="project-info-heading">
      <div className="wf-project">
        <h2 id="project-info-heading">{creating ? '新規プロジェクト' : 'プロジェクト情報'}</h2>
        {!creating && (
          <button
            type="button"
            className="wf-secondary"
            disabled={pending}
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            <FolderPlus size={16} />
            新規プロジェクト
          </button>
        )}
      </div>
      <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <form onSubmit={submit} aria-labelledby="project-info-heading" className="min-w-0">
          <fieldset disabled={pending} className="wf-fields">
            <label className="wf-wide">
              プロジェクト名
              <input
                required
                maxLength={120}
                value={current.name}
                onChange={(e) => update('name', e.target.value)}
              />
            </label>
            <label className="wf-wide">
              説明
              <textarea
                rows={5}
                maxLength={2000}
                value={current.purpose}
                onChange={(e) => update('purpose', e.target.value)}
              />
            </label>
            {creating && (
              <label className="wf-wide">
                ディレクトリ ID（任意）
                <input
                  maxLength={48}
                  value={draft.id}
                  onChange={(e) => setDraft((prev) => ({ ...prev, id: e.target.value }))}
                />
              </label>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="mb-3 text-sm text-st-red-dark">
              {error.message}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="wf-primary"
              disabled={pending || !current.name.trim() || (!creating && !changed)}
            >
              <Save size={15} />
              {creating ? '作成' : '変更を保存'}
            </button>
            {creating && (
              <button
                type="button"
                className="wf-secondary"
                disabled={pending}
                onClick={() => {
                  setCreating(false);
                  setDraft(newProject);
                }}
              >
                キャンセル
              </button>
            )}
          </div>
        </form>
        {!creating && (
          <aside
            aria-label="保存先"
            className="min-w-0 border-t border-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
          >
            <h3 className="mb-4 text-sm font-bold text-science-blue">保存先</h3>
            <dl className="grid gap-3 text-sm">
              {(
                [
                  ['プロジェクト ID', project.id],
                  ['入力フォルダ', project.inboxDir],
                  ['成果物フォルダ', project.artifactsDir],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-ink-muted">{label}</dt>
                  <dd className="mt-1 break-all font-mono">{value}</dd>
                </div>
              ))}
            </dl>
            {projects.length > 1 && (
              <button
                type="button"
                className="wf-delete mt-5"
                disabled={pending}
                onClick={deleteProject}
              >
                <Trash2 size={14} />
                プロジェクトを削除
              </button>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
