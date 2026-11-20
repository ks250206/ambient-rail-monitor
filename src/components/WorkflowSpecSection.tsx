import { ArrowDown, ArrowUp, Cpu, FolderOpen, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  LlmConfig,
  ProjectSpec,
  ReasoningEffort,
  WorkflowStageSpec,
} from '../../shared/types.ts';
import { clockDate } from '../utils/workflow.ts';

export interface ProjectUpdatePayload {
  name: string;
  purpose: string;
  acceptanceCriteria: string;
  llm: LlmConfig;
  stages: WorkflowStageSpec[];
}

interface WorkflowSpecSectionProps {
  project: ProjectSpec;
  saving: boolean;
  onSave: (next: ProjectUpdatePayload) => Promise<void>;
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

function cloneStages(stages: WorkflowStageSpec[]): WorkflowStageSpec[] {
  return stages.map((stage) => ({
    ...stage,
    llm: { ...stage.llm },
  }));
}

export function WorkflowSpecSection({ project, saving, onSave }: WorkflowSpecSectionProps) {
  const [name, setName] = useState(project.name);
  const [purpose, setPurpose] = useState(project.purpose);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(project.acceptanceCriteria);
  const [llm, setLlm] = useState<LlmConfig>({ ...project.llm });
  const [stages, setStages] = useState<WorkflowStageSpec[]>(() => cloneStages(project.stages));

  useEffect(() => {
    setName(project.name);
    setPurpose(project.purpose);
    setAcceptanceCriteria(project.acceptanceCriteria);
    setLlm({ ...project.llm });
    setStages(cloneStages(project.stages));
  }, [project]);

  const isDirty = useMemo(() => {
    if (
      name !== project.name ||
      purpose !== project.purpose ||
      acceptanceCriteria !== project.acceptanceCriteria ||
      llm.model !== project.llm.model ||
      llm.effort !== project.llm.effort ||
      stages.length !== project.stages.length
    ) {
      return true;
    }
    return stages.some((stage, index) => {
      const orig = project.stages[index];
      if (!orig) return true;
      return (
        stage.key !== orig.key ||
        stage.label !== orig.label ||
        stage.short !== orig.short ||
        stage.instruction !== orig.instruction ||
        stage.llm.model !== orig.llm.model ||
        stage.llm.effort !== orig.llm.effort
      );
    });
  }, [name, purpose, acceptanceCriteria, llm, stages, project]);

  const handleReset = () => {
    setName(project.name);
    setPurpose(project.purpose);
    setAcceptanceCriteria(project.acceptanceCriteria);
    setLlm({ ...project.llm });
    setStages(cloneStages(project.stages));
  };

  const handleAddStage = () => {
    if (stages.length >= 20) return;
    const nextNumber = stages.length + 1;
    setStages((prev) => [
      ...prev,
      {
        key: `stage_${nextNumber}`,
        label: `新規工程 ${nextNumber}`,
        short: `Stage ${nextNumber}`,
        instruction: '',
        llm: { model: '', effort: '' },
      },
    ]);
  };

  const handleRemoveStage = (index: number) => {
    if (stages.length <= 1) return;
    setStages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleMoveStage = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= stages.length) return;
    setStages((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(target, 0, moved);
      return copy;
    });
  };

  const updateStage = (index: number, patch: Partial<WorkflowStageSpec>) => {
    setStages((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const handleSubmit = async () => {
    await onSave({
      name,
      purpose,
      acceptanceCriteria,
      llm,
      stages,
    });
  };

  return (
    <section
      id="workflow"
      aria-label="プロジェクトのワークフロー定義と LLM・工程別カスタム指示"
      className="mt-4 scroll-mt-6 border-t-2 border-science-sub bg-white pt-4"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-ink-muted">
            選択中プロジェクトの目的・受け入れ要件・LLM
            設定・工程数と各工程の指示を保存できます。保存した内容は次回ワーカーがジョブを取得したときの実行引数とプロンプトに反映されます。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isDirty ? (
            <span className="rounded bg-st-orange-bg px-2.5 py-1 text-xs font-semibold text-st-orange-dark">
              未保存の変更があります
            </span>
          ) : (
            <span className="font-mono text-xs text-ink-muted">
              最終更新: {clockDate(project.updatedAt)}
            </span>
          )}
          <button
            type="button"
            disabled={!isDirty || saving}
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-bg-1 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            戻す
          </button>
          <button
            type="button"
            disabled={!isDirty || saving}
            onClick={() => void handleSubmit()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-science-blue px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? '保存中…' : '定義を保存'}
          </button>
        </div>
      </div>

      {/* Project Directories Banner */}
      <div className="mb-4 grid grid-cols-1 gap-2 rounded-md border border-line bg-navy-50/70 p-3 text-xs sm:grid-cols-3">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 shrink-0 text-eyebrow" />
          <div className="min-w-0">
            <span className="block text-[11px] font-bold text-ink-muted">プロジェクト ID</span>
            <code className="font-mono font-bold text-science-blue">{project.id}</code>
          </div>
        </div>
        <div className="min-w-0 sm:border-l sm:border-line sm:pl-3">
          <span className="block text-[11px] font-bold text-ink-muted">入力フォルダ（Inbox）</span>
          <code className="block truncate font-mono text-ink" title={project.inboxDir}>
            {project.inboxDir}
          </code>
        </div>
        <div className="min-w-0 sm:border-l sm:border-line sm:pl-3">
          <span className="block text-[11px] font-bold text-ink-muted">
            成果物フォルダ（Artifacts）
          </span>
          <code className="block truncate font-mono text-ink" title={project.artifactsDir}>
            {project.artifactsDir}
          </code>
        </div>
      </div>

      <datalist id="railflow-model-suggestions">
        {MODEL_SUGGESTIONS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <div className="rounded-md border border-line bg-bg-2/50 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <label className="block">
              <span className="block text-xs font-bold text-science-blue">
                プロジェクト / ワークフロー名
              </span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="例: XPS スペクトル解析ワークフロー"
                className="mt-1.5 w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-science-blue focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-bold text-science-blue">
                このワークフローが何をするか（目的・概要）
              </span>
              <textarea
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="入力データに対して何を解析・検証し、どのような成果物を出すワークフローかを記入"
                className="mt-1.5 w-full rounded-md border border-line bg-white px-3 py-2 text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-science-blue focus:outline-none"
              />
            </label>
          </div>

          <label className="flex flex-col">
            <span className="block text-xs font-bold text-science-blue">
              受け入れ要件（Acceptance Criteria）
            </span>
            <span className="mt-0.5 text-[11px] text-ink-muted">
              完了とみなすための必須条件、品質基準、禁止事項などを箇条書きで記入できます
            </span>
            <textarea
              value={acceptanceCriteria}
              onChange={(event) => setAcceptanceCriteria(event.target.value)}
              rows={7}
              maxLength={4000}
              placeholder="- 単位が明記されていない場合は推測せず記録すること&#10;- 再現可能な解析スクリプトを残すこと"
              className="mt-1.5 flex-1 rounded-md border border-line bg-white px-3 py-2 font-mono text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-science-blue focus:outline-none"
            />
          </label>
        </div>

        {/* Default LLM Model & Reasoning Effort */}
        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="inline-flex items-center gap-1.5 text-sm font-bold text-science-blue">
              <Cpu className="h-4 w-4 text-eyebrow" />
              LLM モデル・エフォート設定（プロジェクト共通）
            </h3>
            <span className="font-mono text-[11px] text-ink-muted">
              Codex: --model / -c model_reasoning_effort · Claude: --model / --effort
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block rounded-md border border-line bg-white p-3">
              <span className="block text-xs font-bold text-ink">既定モデル</span>
              <span className="mt-0.5 block text-[11px] text-ink-muted">
                空欄の場合は Codex CLI / Claude Code CLI の既定モデルを使います
              </span>
              <input
                type="text"
                list="railflow-model-suggestions"
                value={llm.model}
                onChange={(event) => setLlm((prev) => ({ ...prev, model: event.target.value }))}
                maxLength={100}
                placeholder="例: gpt-5.4 / opus / sonnet"
                className="mt-2 w-full rounded border border-line bg-bg-2/40 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-muted focus:border-science-blue focus:bg-white focus:outline-none"
              />
            </label>

            <label className="block rounded-md border border-line bg-white p-3">
              <span className="block text-xs font-bold text-ink">既定エフォート（推論強度）</span>
              <span className="mt-0.5 block text-[11px] text-ink-muted">
                各工程で未指定のときに使う推論エフォートを選択します
              </span>
              <select
                value={llm.effort}
                onChange={(event) =>
                  setLlm((prev) => ({
                    ...prev,
                    effort: event.target.value as ReasoningEffort,
                  }))
                }
                className="mt-2 w-full rounded border border-line bg-bg-2/40 px-2.5 py-1.5 text-xs text-ink focus:border-science-blue focus:bg-white focus:outline-none"
              >
                {EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Editable Stage List (variable stage count + order + custom instructions + per-stage LLM) */}
        <div className="mt-5 border-t border-line pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-science-blue">
                工程構成・カスタム指示（現在 {stages.length} 工程）
              </h3>
              <p className="mt-0.5 text-xs text-ink-muted">
                工程の追加・削除・並び替えが可能です（1〜20工程）。最終工程でレポート成果物を公開します。
              </p>
            </div>
            <button
              type="button"
              disabled={stages.length >= 20}
              onClick={handleAddStage}
              className="inline-flex items-center gap-1.5 rounded-lg border border-science-blue bg-white px-3 py-1.5 text-xs font-bold text-science-blue transition-colors hover:bg-bg-1 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus className="h-3.5 w-3.5" />
              工程を追加
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {stages.map((stage, index) => (
              <div
                key={`${stage.key}-${index}`}
                className="flex flex-col rounded-md border border-line bg-white p-3"
              >
                <div className="flex items-center justify-between gap-2 border-b border-line/70 pb-2">
                  <span className="font-mono text-xs font-bold text-eyebrow">
                    STEP {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`工程 ${index + 1} を前へ移動`}
                      disabled={index === 0}
                      onClick={() => handleMoveStage(index, -1)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-bg-2 text-ink hover:bg-bg-1 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`工程 ${index + 1} を後ろへ移動`}
                      disabled={index === stages.length - 1}
                      onClick={() => handleMoveStage(index, 1)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-bg-2 text-ink hover:bg-bg-1 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`工程 ${index + 1} を削除`}
                      disabled={stages.length <= 1}
                      onClick={() => handleRemoveStage(index)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-bg-2 text-st-red-dark hover:bg-st-red-bg disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-[10px] font-semibold text-ink-muted">工程名</span>
                    <input
                      type="text"
                      value={stage.label}
                      onChange={(event) => updateStage(index, { label: event.target.value })}
                      maxLength={80}
                      placeholder="例: ピーク解析"
                      className="mt-0.5 w-full rounded border border-line bg-bg-2/40 px-2 py-1 text-xs font-semibold text-ink focus:border-science-blue focus:bg-white focus:outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[10px] font-semibold text-ink-muted">
                      短縮名（英語）
                    </span>
                    <input
                      type="text"
                      value={stage.short}
                      onChange={(event) => updateStage(index, { short: event.target.value })}
                      maxLength={40}
                      placeholder="例: Analysis"
                      className="mt-0.5 w-full rounded border border-line bg-bg-2/40 px-2 py-1 font-en text-xs text-ink focus:border-science-blue focus:bg-white focus:outline-none"
                    />
                  </label>
                </div>

                <label className="mt-2 block">
                  <span className="block text-[10px] font-semibold text-ink-muted">
                    工程キー（半角英数・`_`・`-`）
                  </span>
                  <input
                    type="text"
                    value={stage.key}
                    onChange={(event) => updateStage(index, { key: event.target.value })}
                    maxLength={48}
                    placeholder="例: analysis"
                    className="mt-0.5 w-full rounded border border-line bg-bg-2/40 px-2 py-1 font-mono text-[11px] text-ink focus:border-science-blue focus:bg-white focus:outline-none"
                  />
                </label>

                <label className="mt-2 block">
                  <span className="block text-[10px] font-semibold text-ink-muted">
                    カスタム指示
                  </span>
                  <textarea
                    value={stage.instruction}
                    onChange={(event) => updateStage(index, { instruction: event.target.value })}
                    rows={3}
                    maxLength={2000}
                    placeholder={`${stage.label || 'この工程'} に対するカスタム指示を記入`}
                    className="mt-0.5 w-full rounded border border-line bg-bg-2/40 px-2.5 py-1.5 text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-science-blue focus:bg-white focus:outline-none"
                  />
                </label>

                <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line/70 pt-2">
                  <label className="block">
                    <span className="block text-[10px] font-semibold text-ink-muted">
                      モデル上書き
                    </span>
                    <input
                      type="text"
                      list="railflow-model-suggestions"
                      value={stage.llm.model}
                      onChange={(event) =>
                        updateStage(index, {
                          llm: { ...stage.llm, model: event.target.value },
                        })
                      }
                      maxLength={100}
                      placeholder={llm.model || '共通を継承'}
                      className="mt-0.5 w-full rounded border border-line bg-bg-2/40 px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-muted focus:border-science-blue focus:bg-white focus:outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-[10px] font-semibold text-ink-muted">
                      エフォート上書き
                    </span>
                    <select
                      value={stage.llm.effort}
                      onChange={(event) =>
                        updateStage(index, {
                          llm: { ...stage.llm, effort: event.target.value as ReasoningEffort },
                        })
                      }
                      className="mt-0.5 w-full rounded border border-line bg-bg-2/40 px-2 py-1 text-[11px] text-ink focus:border-science-blue focus:bg-white focus:outline-none"
                    >
                      <option value="">{llm.effort ? `共通 (${llm.effort})` : '共通を継承'}</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
