import { useMutation } from '@tanstack/react-query';
import { Save, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { TemplatePicker, TemplateExport } from './Templates.tsx';
import type { WorkflowTemplate } from '../../shared/templates.ts';
import type { ProjectSpec } from '../../shared/types.ts';
import { jsonRequest, queryClient, request } from '../api.ts';

interface ProjectNavigationProps {
  onSelect: (id: string) => void;
  showToast: (text: string, error?: boolean) => void;
}

interface ProjectManagementProps {
  onDeleted: () => void;
  showToast: ProjectNavigationProps['showToast'];
  project: ProjectSpec;
  projects: ProjectSpec[];
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

type ProjectInfo = Pick<ProjectSpec, 'name' | 'purpose'>;

function ProjectFields({
  value,
  onChange,
}: {
  value: ProjectInfo;
  onChange: (patch: Partial<ProjectInfo>) => void;
}) {
  return (
    <>
      <label className="wf-wide">
        プロジェクト名
        <input
          required
          maxLength={120}
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <label className="wf-wide">
        説明
        <textarea
          rows={5}
          maxLength={2000}
          value={value.purpose}
          onChange={(e) => onChange({ purpose: e.target.value })}
        />
      </label>
    </>
  );
}

export function ProjectCreate({
  onSelect,
  onCancel,
  showToast,
}: ProjectNavigationProps & { onCancel: () => void }) {
  const [draft, setDraft] = useState(newProject);
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [templateBlocked, setTemplateBlocked] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      request<ProjectResponse>(
        '/api/projects',
        jsonRequest('POST', {
          template: template ?? undefined,
          name: draft.name.trim(),
          purpose: draft.purpose,
          id: draft.id.trim() || undefined,
        }),
      ),
    onSuccess: updateProjectCache,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending || templateBlocked || !draft.name.trim()) return;
    create.mutate(undefined, {
      onSuccess: ({ project }) => {
        onSelect(project.id);
        showToast(`「${project.name}」を作成しました。`);
      },
    });
  }
  return (
    <form onSubmit={submit} aria-label="新規プロジェクト" className="max-w-3xl">
      <TemplatePicker
        onBlocked={setTemplateBlocked}
        onChange={(next) => {
          setTemplate(next);
          if (next)
            setDraft((draft) => ({
              ...draft,
              name: next.template.name,
              purpose: next.definition.purpose,
            }));
        }}
      />
      <fieldset disabled={create.isPending} className="wf-fields">
        <ProjectFields
          value={draft}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />
        <label className="wf-wide">
          ディレクトリ ID（任意）
          <input
            maxLength={48}
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
        </label>
      </fieldset>
      {create.error && (
        <p role="alert" className="mb-3 text-sm text-st-red-dark">
          {create.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="wf-primary"
          disabled={create.isPending || templateBlocked || !draft.name.trim()}
        >
          <Save size={15} />
          作成
        </button>
        <button
          type="button"
          className="wf-secondary"
          disabled={create.isPending}
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}

export function ProjectManagement({
  project,
  projects,
  onDeleted,
  showToast,
}: ProjectManagementProps) {
  const [edits, setEdits] = useState<Partial<ProjectInfo>>({});
  const current = { ...project, ...edits };
  const projectUrl = `/api/projects/${encodeURIComponent(project.id)}`;
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

  const pending = save.isPending || remove.isPending;
  const changed = current.name.trim() !== project.name || current.purpose !== project.purpose;
  const error = save.error || remove.error;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !current.name.trim() || !changed) return;
    remove.reset();
    save.mutate(undefined, {
      onSuccess: ({ project: saved }) => {
        setEdits({});
        showToast(`「${saved.name}」を保存しました。`);
      },
    });
  }
  function deleteProject() {
    if (pending || projects.length <= 1) return;
    if (
      !window.confirm(`「${project.name}」を一覧から削除しますか？ 保存済みのファイルは残ります。`)
    )
      return;
    save.reset();
    remove.mutate(undefined, {
      onSuccess: onDeleted,
    });
  }

  return (
    <section aria-labelledby="project-info-heading">
      <div className="wf-project">
        <h2 id="project-info-heading">プロジェクト情報</h2>
      </div>
      <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <form onSubmit={submit} aria-labelledby="project-info-heading" className="min-w-0">
          <fieldset disabled={pending} className="wf-fields">
            <ProjectFields
              value={current}
              onChange={(patch) => setEdits((prev) => ({ ...prev, ...patch }))}
            />
          </fieldset>
          {error && (
            <p role="alert" className="mb-3 text-sm text-st-red-dark">
              {error.message}
            </p>
          )}
          <button
            type="submit"
            className="wf-primary"
            disabled={pending || !current.name.trim() || !changed}
          >
            <Save size={15} />
            変更を保存
          </button>
        </form>
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
      </div>
      <TemplateExport project={project} />
    </section>
  );
}
