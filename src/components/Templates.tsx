import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ProjectSpec } from '../../shared/types.ts';
import type { WorkflowTemplate } from '../../shared/templates.ts';
import { executionDetails } from '../../shared/template-preview.ts';
import { jsonRequest, queryClient, request } from '../api.ts';
import { useI18n } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';

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
  const { pick } = useI18n();
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
      if (file.size > 4_000_000)
        throw new Error(
          pick('テンプレートは4 MB以内にしてください。', 'Templates must be 4 MB or smaller.'),
        );
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
  const selectedIndex = selected ? options.findIndex((item) => sameTemplate(item, selected)) : -2;
  const selectValue = selected ? String(selectedIndex) : '';
  const selectOptions = [
    { value: '', label: pick('使用しない / JSONを選択', 'None / Upload JSON') },
    ...(selected && selectedIndex === -1
      ? [
          {
            value: '-1',
            label: pick(
              `読み込んだJSON: ${selected.template.name}`,
              `Loaded JSON: ${selected.template.name}`,
            ),
          },
        ]
      : []),
    ...options.map((item, index) => ({
      value: String(index),
      label: `${item.template.name} · ${item.template.revision}`,
    })),
  ];
  return (
    <section
      className="wf-template"
      aria-label={pick('テンプレートから作成', 'Create from template')}
    >
      <h3>{pick('テンプレートから作成', 'Create from template')}</h3>
      <label>
        {pick('保存済み・組み込みテンプレート', 'Saved & built-in templates')}
        <CustomSelect
          ariaLabel={pick('保存済み・組み込みテンプレート', 'Saved & built-in templates')}
          value={selectValue}
          options={selectOptions}
          onChange={(next) => {
            if (next === '-1') return;
            void select(next === '' ? null : options[Number(next)], false);
          }}
        />
      </label>
      <label>
        {pick('テンプレートJSON', 'Template JSON')}
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
          {pick('保存済みテンプレートを取得できません。', 'Failed to load saved templates.')}
          <button type="button" onClick={() => void catalog.refetch()}>
            {pick('再試行', 'Retry')}
          </button>
        </p>
      )}
      {!!catalog.data?.saved.length && (
        <details className="wf-disclosure">
          <summary>
            {pick(
              `保存済みテンプレートを管理（${catalog.data.saved.length} / 30件）`,
              `Manage saved templates (${catalog.data.saved.length} / 30)`,
            )}
          </summary>
          <ul className="upload-file-list">
            {catalog.data.saved.map((item) => {
              const key = `${item.template.name}:${item.template.revision}:${item.template.hash}`;
              return (
                <li key={key}>
                  <span>
                    {item.template.name} · {pick('版 ', 'Rev ')}
                    {item.template.revision} ({item.template.hash.slice(0, 8)})
                  </span>
                  {confirmDelete === key && (
                    <span role="status">
                      {pick(
                        `「${item.template.name}」（版 ${item.template.revision}）を削除しますか？`,
                        `Delete "${item.template.name}" (rev ${item.template.revision})?`,
                      )}
                    </span>
                  )}
                  <button
                    type="button"
                    className="wf-secondary"
                    disabled={Boolean(deletingKey)}
                    onClick={() => setConfirmDelete(confirmDelete === key ? '' : key)}
                  >
                    {confirmDelete === key ? pick('取り消す', 'Cancel') : pick('削除', 'Delete')}
                  </button>
                  {confirmDelete === key && (
                    <button
                      type="button"
                      className="wf-secondary"
                      disabled={Boolean(deletingKey)}
                      onClick={() => void removeSaved(item)}
                    >
                      {deletingKey === key
                        ? pick('削除中…', 'Deleting…')
                        : pick('削除を確定', 'Confirm delete')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <button type="button" className="wf-secondary" onClick={() => void select(null)}>
        {pick('テンプレートを解除して白紙から作成', 'Clear template and start blank')}
      </button>
      {selected && (
        <div role="status" className="wf-template-preview">
          <strong>
            {selected.template.name} · {pick('版 ', 'Rev ')}
            {selected.template.revision}
          </strong>
          <p>
            {pick(
              `${selected.definition.stages.length} 工程`,
              `${selected.definition.stages.length} stages`,
            )}{' '}
            · {selected.definition.graph?.mode ?? pick('従来の逐次実行', 'Legacy sequential')} ·{' '}
            {[
              ...new Set(selected.definition.stages.map((stage) => stage.runner?.kind ?? 'ai')),
            ].join(' / ')}
          </p>
          <p>{selected.definition.purpose}</p>
          <p className="wf-help">
            {pick('環境の版: ', 'Env revision: ')}
            {selected.definition.runtime?.revision || pick('指定なし', 'Not set')} · Python:{' '}
            {selected.definition.runtime?.python || pick('ワーカー既定', 'Worker default')} ·{' '}
            {pick('内容hash: ', 'Hash: ')}
            {selected.template.hash.slice(0, 12)}
          </p>
          {hasExecutableSteps(selected) && (
            <details open={isExternal} className="wf-disclosure">
              <summary>
                {pick(
                  '実行コマンド・Pythonコード・HTTP接続先と送信内容の詳細',
                  'Inspect commands, Python code, and HTTP targets/payloads',
                )}
              </summary>
              {selected.definition.runtime?.python && (
                <p className="wf-help">
                  {pick('環境プローブ・実行用 Python: ', 'Runtime probe & execution Python: ')}
                  <code>{selected.definition.runtime.python}</code>
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
              {pick(
                '外部テンプレート内のコマンド・Python・HTTP・実行ファイル設定を確認し、ローカル実行を許可する',
                'I have reviewed the commands, Python code, HTTP requests, and executable paths in this external template and allow local execution',
              )}
            </label>
          )}
          <p className="wf-help">
            {pick(
              '下の名前で新しいプロジェクトを作成します。テンプレートの元のプロジェクトは変更されません。',
              'Creates a new project with the name below. The original template project is not modified.',
            )}
          </p>
        </div>
      )}
    </section>
  );
}

export function TemplateExport({ project }: { project: ProjectSpec }) {
  const { pick } = useI18n();
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
      setStatus(
        pick(
          '保存済みテンプレートに追加しました。新規プロジェクト作成画面で選択できます。',
          'Saved to template catalog. Available when creating a new project.',
        ),
      );
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="wf-template" aria-label={pick('定義の再利用', 'Reuse workflow definition')}>
      <h3>{pick('保存済み定義を再利用', 'Reuse saved definition')}</h3>
      {project.templateOrigin && (
        <p>
          {pick('作成元: ', 'Created from: ')}
          {project.templateOrigin.name} · {project.templateOrigin.revision} ·{' '}
          {project.templateOrigin.hash.slice(0, 12)}
        </p>
      )}
      <div className="wf-fields">
        <label>
          {pick('テンプレート名', 'Template name')}
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {pick('テンプレートの版', 'Template revision')}
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
          {pick('テンプレートとして保存', 'Save as template')}
        </button>
        {name.trim() && revision.trim() && (
          <a
            className="wf-secondary"
            href={`/api/projects/${project.id}/template?revision=${encodeURIComponent(revision.trim())}&name=${encodeURIComponent(name.trim())}`}
            download
          >
            {pick('保存済み定義をJSONで書き出す', 'Export saved definition as JSON')}
          </a>
        )}
      </div>
      <p className="wf-help">
        {pick(
          '入力データ・実行履歴・保存先は含みません。新しい版を保存しても既存ジョブの定義は変わりません。',
          'Excludes input data, run history, and local paths. Saving a new revision does not change existing jobs.',
        )}
      </p>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
