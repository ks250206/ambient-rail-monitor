import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ProjectSpec } from '../../shared/types.ts';
import type { WorkflowTemplate } from '../../shared/templates.ts';
import { jsonRequest, queryClient, request } from '../api.ts';

type Catalog = { builtins: WorkflowTemplate[]; saved: WorkflowTemplate[] };
export function TemplatePicker({
  onChange,
  onBlocked,
}: {
  onChange: (template: WorkflowTemplate | null) => void;
  onBlocked: (blocked: boolean) => void;
}) {
  const catalog = useQuery({
    queryKey: ['templates'],
    queryFn: () => request<Catalog>('/api/templates'),
  });
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const select = async (value: unknown) => {
    const ticket = ++generation.current;
    setSelected(null);
    onChange(null);
    setError('');
    onBlocked(true);
    let failed = false;
    try {
      if (value === null) return;
      const result = await request<{ template: WorkflowTemplate }>(
        '/api/templates/validate',
        jsonRequest('POST', { template: value }),
      );
      if (ticket !== generation.current) return;
      setSelected(result.template);
      onChange(result.template);
    } catch (err) {
      if (ticket === generation.current) {
        failed = true;
        setError((err as Error).message);
      }
    } finally {
      if (ticket === generation.current) onBlocked(failed);
    }
  };
  const upload = async (file?: File) => {
    const ticket = ++generation.current;
    setSelected(null);
    onChange(null);
    setError('');
    onBlocked(true);
    let failed = false;
    try {
      if (!file) return;
      if (file.size > 4_000_000) throw new Error('テンプレートは4 MB以内にしてください。');
      const text = await file.text();
      if (ticket !== generation.current) return;
      await select(JSON.parse(text));
    } catch (err) {
      if (ticket === generation.current) {
        failed = true;
        setError((err as Error).message);
      }
    } finally {
      if (ticket === generation.current) onBlocked(failed);
    }
  };
  const options = [...(catalog.data?.builtins ?? []), ...(catalog.data?.saved ?? [])];
  return (
    <section className="wf-template" aria-label="テンプレートから作成">
      <h3>テンプレートから作成</h3>
      <label>
        保存済み・組み込みテンプレート
        <select
          value={
            selected
              ? options.findIndex(
                  (item) =>
                    item.template.hash === selected.template.hash &&
                    item.template.revision === selected.template.revision,
                )
              : ''
          }
          onChange={(e) =>
            void select(e.target.value === '' ? null : options[Number(e.target.value)])
          }
        >
          <option value="">使用しない / JSONを選択</option>
          {selected &&
            !options.some(
              (item) =>
                item.template.hash === selected.template.hash &&
                item.template.revision === selected.template.revision,
            ) && <option value={-1}>読み込んだJSON: {selected.template.name}</option>}
          {options.map((item, index) => (
            <option key={index} value={index}>
              {item.template.name} · {item.template.revision}
            </option>
          ))}
        </select>
      </label>
      <label>
        テンプレートJSON
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      {error && (
        <p role="alert" className="condition-error">
          {error}
        </p>
      )}
      {catalog.isError && (
        <p role="alert">
          保存済みテンプレートを取得できません。
          <button type="button" onClick={() => void catalog.refetch()}>
            再試行
          </button>
        </p>
      )}
      <button type="button" className="wf-secondary" onClick={() => void select(null)}>
        テンプレートを解除して白紙から作成
      </button>
      {selected && (
        <div role="status" className="wf-template-preview">
          <strong>
            {selected.template.name} · 版 {selected.template.revision}
          </strong>
          <p>
            {selected.definition.stages.length} 工程 ·{' '}
            {selected.definition.graph?.mode ?? '従来の逐次実行'} ·{' '}
            {[
              ...new Set(selected.definition.stages.map((stage) => stage.runner?.kind ?? 'ai')),
            ].join(' / ')}
          </p>
          <p>{selected.definition.purpose}</p>
          <p className="wf-help">
            環境の版: {selected.definition.runtime?.revision || '指定なし'} · 内容hash:{' '}
            {selected.template.hash.slice(0, 12)}
          </p>
          <p className="wf-help">
            下の名前で新しいプロジェクトを作成します。テンプレートの元のプロジェクトは変更されません。
          </p>
        </div>
      )}
    </section>
  );
}

export function TemplateExport({ project }: { project: ProjectSpec }) {
  const [revision, setRevision] = useState('1');
  const [name, setName] = useState(project.name);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    setStatus('');
    try {
      await request(
        '/api/templates',
        jsonRequest('POST', { projectId: project.id, name, revision }),
      );
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      setStatus('保存済みテンプレートに追加しました。新規プロジェクト作成画面で選択できます。');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="wf-template" aria-label="定義の再利用">
      <h3>保存済み定義を再利用</h3>
      {project.templateOrigin && (
        <p>
          作成元: {project.templateOrigin.name} · {project.templateOrigin.revision} ·{' '}
          {project.templateOrigin.hash.slice(0, 12)}
        </p>
      )}
      <div className="wf-fields">
        <label>
          テンプレート名
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          テンプレートの版
          <input value={revision} maxLength={80} onChange={(e) => setRevision(e.target.value)} />
        </label>
      </div>
      <div className="wf-template-actions">
        <button
          type="button"
          className="wf-secondary"
          disabled={pending || !name.trim() || !revision.trim()}
          onClick={() => void save()}
        >
          テンプレートとして保存
        </button>
        {revision.trim() && (
          <a
            className="wf-secondary"
            href={`/api/projects/${project.id}/template?revision=${encodeURIComponent(revision)}&name=${encodeURIComponent(name)}`}
            download
          >
            保存済み定義をJSONで書き出す
          </a>
        )}
      </div>
      <p className="wf-help">
        入力データ・実行履歴・保存先は含みません。新しい版を保存しても既存ジョブの定義は変わりません。
      </p>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
