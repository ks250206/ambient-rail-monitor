import { Cpu, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  LlmConfig,
  ReasoningEffort,
  StageDefinition,
  StageKey,
  WorkflowSpec,
} from '../../shared/types.ts';
import { clockDate } from '../utils/workflow.ts';

interface WorkflowSpecSectionProps {
  workflow: WorkflowSpec;
  stages: StageDefinition[];
  saving: boolean;
  onSave: (next: Omit<WorkflowSpec, 'updatedAt'>) => Promise<void>;
}

const FALLBACK_STAGES: StageDefinition[] = [
  { key: 'ingest', label: '取込・形式検証', short: 'Ingest' },
  { key: 'preprocess', label: '前処理・校正', short: 'Preprocess' },
  { key: 'analysis', label: 'データ解析', short: 'Analysis' },
  { key: 'validate', label: '科学的妥当性確認', short: 'Validation' },
  { key: 'visualize', label: '図表・可視化', short: 'Visualization' },
  { key: 'publish', label: 'HTML / PPTX生成', short: 'Publish' },
];

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: '', label: '指定なし（CLI 既定 / 共通を継承）' },
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

export function WorkflowSpecSection({
  workflow,
  stages,
  saving,
  onSave,
}: WorkflowSpecSectionProps) {
  const stageList = stages.length > 0 ? stages : FALLBACK_STAGES;

  const [title, setTitle] = useState(workflow.title);
  const [purpose, setPurpose] = useState(workflow.purpose);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(workflow.acceptanceCriteria);
  const [llm, setLlm] = useState<LlmConfig>(workflow.llm);
  const [stageLlm, setStageLlm] = useState<Record<StageKey, LlmConfig>>(workflow.stageLlm);
  const [stageInstructions, setStageInstructions] = useState<Record<StageKey, string>>(
    workflow.stageInstructions,
  );

  useEffect(() => {
    setTitle(workflow.title);
    setPurpose(workflow.purpose);
    setAcceptanceCriteria(workflow.acceptanceCriteria);
    setLlm(workflow.llm);
    setStageLlm(workflow.stageLlm);
    setStageInstructions(workflow.stageInstructions);
  }, [workflow]);

  const isDirty = useMemo(() => {
    if (
      title !== workflow.title ||
      purpose !== workflow.purpose ||
      acceptanceCriteria !== workflow.acceptanceCriteria ||
      llm.model !== workflow.llm.model ||
      llm.effort !== workflow.llm.effort
    ) {
      return true;
    }
    return stageList.some((stage) => {
      const currInst = stageInstructions[stage.key] || '';
      const origInst = workflow.stageInstructions[stage.key] || '';
      const currLlm = stageLlm[stage.key] || { model: '', effort: '' };
      const origLlm = workflow.stageLlm[stage.key] || { model: '', effort: '' };
      return (
        currInst !== origInst ||
        currLlm.model !== origLlm.model ||
        currLlm.effort !== origLlm.effort
      );
    });
  }, [title, purpose, acceptanceCriteria, llm, stageLlm, stageInstructions, workflow, stageList]);

  const handleReset = () => {
    setTitle(workflow.title);
    setPurpose(workflow.purpose);
    setAcceptanceCriteria(workflow.acceptanceCriteria);
    setLlm(workflow.llm);
    setStageLlm(workflow.stageLlm);
    setStageInstructions(workflow.stageInstructions);
  };

  const handleSubmit = async () => {
    await onSave({
      title,
      purpose,
      acceptanceCriteria,
      llm,
      stageLlm,
      stageInstructions,
    });
  };

  return (
    <section
      id="workflow"
      aria-label="ワークフロー定義と LLM・工程別カスタム指示"
      className="mt-8 scroll-mt-6 border-t-2 border-science-sub bg-white pt-4"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="section-heading">ワークフロー定義・LLM 設定・カスタム指示</h2>
          <p className="mt-1 text-xs text-ink-muted">
            このワークフローの目的・受け入れ要件・使用するモデルとエフォート・各工程のカスタム指示を保存できます。次回ワーカーがジョブを取得したときの実行引数とプロンプトに反映されます。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isDirty ? (
            <span className="rounded bg-st-orange-bg px-2.5 py-1 text-xs font-semibold text-st-orange-dark">
              未保存の変更があります
            </span>
          ) : (
            <span className="font-mono text-xs text-ink-muted">
              最終更新: {clockDate(workflow.updatedAt)}
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

      <datalist id="railflow-model-suggestions">
        {MODEL_SUGGESTIONS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <div className="rounded-md border border-line bg-bg-2/50 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <label className="block">
              <span className="block text-xs font-bold text-science-blue">ワークフロー名</span>
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
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
              LLM モデル・エフォート設定（共通デフォルト）
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
                    {option.value === '' ? '指定なし（CLI 既定）' : option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Per-Stage Custom Instructions + Optional Model/Effort Overrides */}
        <div className="mt-5 border-t border-line pt-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold text-science-blue">
              各工程のカスタム指示・個別 LLM 上書き
            </h3>
            <span className="text-xs text-ink-muted">
              各ステージのエージェント実行時に追加プロンプトと個別モデル/エフォート（任意）を渡します
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {stageList.map((stage, index) => {
              const currentLlm = stageLlm[stage.key] || { model: '', effort: '' };
              return (
                <div
                  key={stage.key}
                  className="flex flex-col rounded-md border border-line bg-white p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-ink">
                      <span className="mr-1.5 font-mono text-eyebrow">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      {stage.label}
                    </span>
                    <span className="font-en text-[11px] font-semibold text-ink-muted">
                      {stage.short}
                    </span>
                  </div>

                  <label className="mt-2 block">
                    <span className="sr-only">{stage.label} のカスタム指示</span>
                    <textarea
                      value={stageInstructions[stage.key] || ''}
                      onChange={(event) =>
                        setStageInstructions((prev) => ({
                          ...prev,
                          [stage.key]: event.target.value,
                        }))
                      }
                      rows={3}
                      maxLength={2000}
                      placeholder={`${stage.label} 工程に対するカスタム指示を記入`}
                      className="w-full rounded border border-line bg-bg-2/40 px-2.5 py-2 text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-science-blue focus:bg-white focus:outline-none"
                    />
                  </label>

                  <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line/70 pt-2">
                    <label className="block">
                      <span className="block text-[10px] font-semibold text-ink-muted">
                        モデル上書き（任意）
                      </span>
                      <input
                        type="text"
                        list="railflow-model-suggestions"
                        value={currentLlm.model}
                        onChange={(event) =>
                          setStageLlm((prev) => ({
                            ...prev,
                            [stage.key]: { ...currentLlm, model: event.target.value },
                          }))
                        }
                        maxLength={100}
                        placeholder={llm.model || '共通を継承'}
                        className="mt-1 w-full rounded border border-line bg-bg-2/40 px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-muted focus:border-science-blue focus:bg-white focus:outline-none"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-[10px] font-semibold text-ink-muted">
                        エフォート上書き
                      </span>
                      <select
                        value={currentLlm.effort}
                        onChange={(event) =>
                          setStageLlm((prev) => ({
                            ...prev,
                            [stage.key]: {
                              ...currentLlm,
                              effort: event.target.value as ReasoningEffort,
                            },
                          }))
                        }
                        className="mt-1 w-full rounded border border-line bg-bg-2/40 px-2 py-1 text-[11px] text-ink focus:border-science-blue focus:bg-white focus:outline-none"
                      >
                        <option value="">
                          {llm.effort ? `共通 (${llm.effort})` : '共通を継承'}
                        </option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="xhigh">xhigh</option>
                        <option value="max">max</option>
                      </select>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
