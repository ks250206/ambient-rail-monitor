import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ProjectSpec } from '../../shared/types.ts';
import type { WorkflowTemplate } from '../../shared/templates.ts';
import { executionDetails } from '../../shared/template-preview.ts';
import { jsonRequest, queryClient, request } from '../api.ts';

type Catalog = { builtins: WorkflowTemplate[]; saved: WorkflowTemplate[] };

function sameTemplate(a: WorkflowTemplate, b: WorkflowTemplate) {
  return (
    a.template.name === b.template.name &&
    a.template.revision === b.template.revision &&
    a.template.hash === b.template.hash
  );
}

function hasExecutableSteps(template: WorkflowTemplate): boolean {
  return (
    Boolean(template.definition.runtime?.python) ||
    template.definition.stages.some((stage) =>
      ['command', 'python', 'http'].includes(stage.runner?.kind ?? 'ai'),
    )
  );
}

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
  const [isExternal, setIsExternal] = useState(false);
  const [confirmedExec, setConfirmedExec] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  const [deletingKey, setDeletingKey] = useState('');
  const generation = useRef(0);
  const select = async (value: unknown, external = false) => {
    const ticket = ++generation.current;
    setSelected(null);
    setIsExternal(false);
    setConfirmedExec(false);
    onChange(null);
    setError('');
    onBlocked(true);
    let blocked = false;
    try {
      if (value === null) return;
      const result = await request<{ template: WorkflowTemplate }>(
        '/api/templates/validate',
        jsonRequest('POST', { template: value }),
      );
      if (ticket !== generation.current) return;
      const needsConfirm = external && hasExecutableSteps(result.template);
      setSelected(result.template);
      setIsExternal(external);
      setConfirmedExec(!needsConfirm);
      onChange(result.template);
      blocked = needsConfirm;
    } catch (err) {
      if (ticket === generation.current) {
        blocked = true;
        setError((err as Error).message);
      }
    } finally {
      if (ticket === generation.current) onBlocked(blocked);
    }
  };
  const upload = async (file?: File) => {
    const ticket = ++generation.current;
    setSelected(null);
    setIsExternal(false);
    setConfirmedExec(false);
    onChange(null);
    setError('');
    onBlocked(true);
    let failed = false;
    try {
      if (!file) return;
      if (file.size > 4_000_000) throw new Error('テンプレートは4 MB以内にしてください。');
      const text = await file.text();
      if (ticket !== generation.current) return;
      await select(JSON.parse(text), true);
      return;
    } catch (err) {
      if (ticket === generation.current) {
        failed = true;
        setError((err as Error).message);
      }
    } finally {
      if (ticket === generation.current && failed) onBlocked(true);
      else if (ticket === generation.current && !file) onBlocked(false);
    }
  };
  const removeSaved = async (item: WorkflowTemplate) => {
    const key = `${item.template.name}:${item.template.revision}:${item.template.hash}`;
    if (confirmDelete !== key || deletingKey) return;
    const selectionTicket = generation.current;
    setDeletingKey(key);
    setError('');
    try {
      await request('/api/templates', jsonRequest('DELETE', item.template));
      setConfirmDelete('');
      if (generation.current === selectionTicket && selected && sameTemplate(selected, item))
        void select(null);
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingKey('');
    }
  };
  const options = [...(catalog.data?.builtins ?? []), ...(catalog.data?.saved ?? [])];
  const needsExecConfirm = Boolean(selected && isExternal && hasExecutableSteps(selected));
  return (
    <section className="wf-template" aria-label="テンプレートから作成">
      <h3>テンプレートから作成</h3>
      <label>
        保存済み・組み込みテンプレート
        <select
          value={selected ? options.findIndex((item) => sameTemplate(item, selected)) : ''}
          onChange={(e) =>
            void select(e.target.value === '' ? null : options[Number(e.target.value)], false)
          }
        >
          <option value="">使用しない / JSONを選択</option>
          {selected && !options.some((item) => sameTemplate(item, selected)) && (
            <option value={-1}>読み込んだJSON: {selected.template.name}</option>
          )}
          {options.map((item, index) => (
            <option
              key={`${item.template.name}-${item.template.revision}-${item.template.hash}-${index}`}
              value={index}
            >
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
      {!!catalog.data?.saved.length && (
        <details className="wf-disclosure">
          <summary>保存済みテンプレートを管理（{catalog.data.saved.length} / 30件）</summary>
          <ul className="upload-file-list">
            {catalog.data.saved.map((item) => {
              const key = `${item.template.name}:${item.template.revision}:${item.template.hash}`;
              return (
                <li key={key}>
                  <span>
                    {item.template.name} · 版 {item.template.revision} (
                    {item.template.hash.slice(0, 8)})
                  </span>
                  {confirmDelete === key && (
                    <span role="status">
                      「{item.template.name}」（版 {item.template.revision}）を削除しますか？
                    </span>
                  )}
                  <button
                    type="button"
                    className="wf-secondary"
                    disabled={Boolean(deletingKey)}
                    onClick={() => setConfirmDelete(confirmDelete === key ? '' : key)}
                  >
                    {confirmDelete === key ? '取り消す' : '削除'}
                  </button>
                  {confirmDelete === key && (
                    <button
                      type="button"
                      className="wf-secondary"
                      disabled={Boolean(deletingKey)}
                      onClick={() => void removeSaved(item)}
                    >
                      {deletingKey === key ? '削除中…' : '削除を確定'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
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
            環境の版: {selected.definition.runtime?.revision || '指定なし'} · Python:{' '}
            {selected.definition.runtime?.python || 'ワーカー既定'} · 内容hash:{' '}
            {selected.template.hash.slice(0, 12)}
          </p>
          {hasExecutableSteps(selected) && (
            <details open={isExternal} className="wf-disclosure">
              <summary>実行コマンド・Pythonコード・HTTP接続先と送信内容の詳細</summary>
              {selected.definition.runtime?.python && (
                <p className="wf-help">
                  環境プローブ・実行用 Python: <code>{selected.definition.runtime.python}</code>
                </p>
              )}
              {executionDetails(selected.definition.stages).map((detail) => (
                <div key={detail.key}>
                  <strong>
                    {detail.label} ({detail.key}) · {detail.kind}
                  </strong>
                  {detail.fields.map((field) => (
                    <div key={field.label}>
                      <span className="wf-help">{field.label}</span>
                      <pre className="prompt-preview">{field.value}</pre>
                    </div>
                  ))}
                </div>
              ))}
            </details>
          )}
          {needsExecConfirm && (
            <label className="wf-check">
              <input
                type="checkbox"
                checked={confirmedExec}
                onChange={(e) => {
                  setConfirmedExec(e.target.checked);
                  onBlocked(!e.target.checked);
                }}
              />
              外部テンプレート内のコマンド・Python・HTTP・実行ファイル設定を確認し、ローカル実行を許可する
            </label>
          )}
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
        {name.trim() && revision.trim() && (
          <a
            className="wf-secondary"
            href={`/api/projects/${project.id}/template?revision=${encodeURIComponent(revision.trim())}&name=${encodeURIComponent(name.trim())}`}
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
