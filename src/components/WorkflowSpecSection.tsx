import { ArrowDown, ArrowUp, ChevronDown, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import type {
  LlmConfig,
  ProjectSpec,
  ReasoningEffort,
  WorkflowStageSpec,
} from '../../shared/types.ts';
import { clockDate } from '../utils/workflow.ts';

export interface WorkflowUpdatePayload {
  acceptanceCriteria: string;
  llm: LlmConfig;
  stages: WorkflowStageSpec[];
}

interface WorkflowSpecSectionProps {
  project: ProjectSpec;
  saving: boolean;
  onSave: (next: WorkflowUpdatePayload) => void;
}

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: '', label: '指定なし（CLI 既定）' },
  { value: 'low', label: 'low（軽量・高速）' },
  { value: 'medium', label: 'medium（標準）' },
  { value: 'high', label: 'high（深い推論）' },
  { value: 'xhigh', label: 'xhigh（高精度推論）' },
  { value: 'max', label: 'max（最大 ※Codex は xhigh にマップ）' },
];

const MODEL_SUGGESTIONS = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'o3',
  'opus',
  'sonnet',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];

function editableStages(stages: WorkflowStageSpec[]) {
  return stages.map((stage, rowId) => ({ ...stage, rowId }));
}

export function WorkflowSpecSection({ project, saving, onSave }: WorkflowSpecSectionProps) {
  const [acceptanceCriteria, setAcceptance] = useState(project.acceptanceCriteria);
  const [llm, setLlm] = useState(project.llm);
  const [stages, setStages] = useState(() => editableStages(project.stages));
  const nextId = useRef(stages.length);
  const [active, setActive] = useState(0);
  const index = Math.max(
    0,
    stages.findIndex((s) => s.rowId === active),
  );
  const stage = stages[index];
  const payload = {
    acceptanceCriteria,
    llm,
    stages: stages.map(({ rowId: _id, ...spec }) => spec),
  };
  const dirty =
    acceptanceCriteria !== project.acceptanceCriteria ||
    JSON.stringify(llm) !== JSON.stringify(project.llm) ||
    JSON.stringify(payload.stages) !== JSON.stringify(project.stages);
  function reset() {
    setAcceptance(project.acceptanceCriteria);
    setLlm(project.llm);
    setStages(editableStages(project.stages));
    setActive(0);
  }
  function update(patch: Partial<WorkflowStageSpec>) {
    setStages((prev) =>
      prev.map((item) => (item.rowId === stage.rowId ? { ...item, ...patch } : item)),
    );
  }
  function add() {
    const rowId = nextId.current++;
    let n = rowId + 1;
    while (stages.some((s) => s.key === `stage_${n}`)) n++;
    setStages([
      ...stages,
      {
        rowId,
        key: `stage_${n}`,
        label: `新規工程 ${n}`,
        short: `Stage ${n}`,
        instruction: '',
        llm: { model: '', effort: '' },
      },
    ]);
    setActive(rowId);
  }
  function move(delta: number) {
    const items = [...stages];
    items.splice(index, 1);
    items.splice(index + delta, 0, stage);
    setStages(items);
  }
  function remove() {
    const items = stages.filter((item) => item.rowId !== stage.rowId);
    setStages(items);
    setActive(items[Math.min(index, items.length - 1)].rowId);
  }
  return (
    <section aria-label="ワークフロー設定">
      <div className="wf-project">
        <div>
          <h2>{project.name}</h2>
          <p>{project.purpose}</p>
        </div>
        <div className="wf-save">
          <span role="status">
            {dirty ? '未保存の変更' : `最終更新 ${clockDate(project.updatedAt)}`}
          </span>
          {dirty && (
            <button className="wf-secondary" disabled={saving} onClick={reset}>
              <RotateCcw size={14} />
              戻す
            </button>
          )}
          <button
            className="wf-primary"
            disabled={!dirty || saving}
            onClick={() => onSave(payload)}
          >
            <Save size={15} />
            {saving ? '保存中…' : '定義を保存'}
          </button>
        </div>
      </div>
      <fieldset disabled={saving} className="min-w-0">
        <details open className="wf-disclosure">
          <summary>
            基本設定 <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <label className="wf-wide">
              受け入れ要件
              <textarea
                rows={4}
                value={acceptanceCriteria}
                onChange={(e) => setAcceptance(e.target.value)}
                maxLength={4000}
              />
            </label>
            <ModelFields value={llm} onChange={setLlm} />
          </div>
        </details>
        <div className="wf-section-title">
          <h2>
            工程 <span>{stages.length}</span>
          </h2>
          <button className="wf-secondary" onClick={add} disabled={stages.length >= 20}>
            <Plus size={15} />
            工程を追加
          </button>
        </div>
        <div className="wf-editor">
          <nav className="wf-stage-list" aria-label="編集する工程">
            {stages.map((item, i) => (
              <button
                type="button"
                key={item.rowId}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => setActive(item.rowId)}
              >
                <span>{String(i + 1).padStart(2, '0')}</span>
                {item.label || item.key}
              </button>
            ))}
          </nav>
          <label className="wf-mobile-select">
            編集する工程
            <select
              aria-label="編集する工程"
              value={stage.rowId}
              onChange={(e) => setActive(Number(e.target.value))}
            >
              {stages.map((item, i) => (
                <option key={item.rowId} value={item.rowId}>
                  {i + 1}. {item.label || item.key}
                </option>
              ))}
            </select>
          </label>
          <div className="wf-stage-detail" key={stage.rowId}>
            <div className="wf-detail-title">
              <h3>{stage.label || '工程の編集'}</h3>
              <div className="wf-order">
                <button
                  aria-label="工程を前へ移動"
                  title="前へ移動"
                  disabled={index === 0}
                  onClick={() => move(-1)}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  aria-label="工程を後ろへ移動"
                  title="後ろへ移動"
                  disabled={index === stages.length - 1}
                  onClick={() => move(1)}
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  aria-label="工程を削除"
                  title="工程を削除"
                  disabled={stages.length <= 1}
                  onClick={remove}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <div className="wf-fields">
              <label>
                工程名
                <input
                  value={stage.label}
                  maxLength={80}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
              <label>
                短縮名
                <input
                  value={stage.short}
                  maxLength={40}
                  onChange={(e) => update({ short: e.target.value })}
                />
              </label>
              <label className="wf-wide">
                カスタム指示
                <textarea
                  rows={4}
                  maxLength={2000}
                  value={stage.instruction}
                  onChange={(e) => update({ instruction: e.target.value })}
                />
              </label>
            </div>
            <details open className="wf-disclosure">
              <summary>
                工程キー・モデル設定 <ChevronDown size={16} />
              </summary>
              <div className="wf-fields">
                <label className="wf-wide">
                  工程キー
                  <input
                    value={stage.key}
                    maxLength={48}
                    onChange={(e) => update({ key: e.target.value })}
                  />
                </label>
                <ModelFields value={stage.llm} inherited onChange={(llm) => update({ llm })} />
              </div>
            </details>
          </div>
        </div>
      </fieldset>
      <datalist id="railflow-model-suggestions">
        {MODEL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </section>
  );
}

function ModelFields({
  value,
  onChange,
  inherited = false,
}: {
  value: LlmConfig;
  onChange: (llm: LlmConfig) => void;
  inherited?: boolean;
}) {
  const fallback = inherited ? 'プロジェクト設定を継承' : 'CLI の既定値';
  return (
    <>
      <label>
        {inherited ? 'モデル上書き' : '既定モデル'}
        <input
          list="railflow-model-suggestions"
          value={value.model}
          placeholder={fallback}
          maxLength={100}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </label>
      <label>
        推論強度
        <select
          value={value.effort}
          onChange={(e) => onChange({ ...value, effort: e.target.value as ReasoningEffort })}
        >
          {EFFORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value ? option.label : fallback}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
