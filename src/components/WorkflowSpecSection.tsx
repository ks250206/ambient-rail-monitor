import {
  stageForSave,
  runnerChange,
  settingsLostOnSave,
  type StageDraft,
} from '../utils/workflow-drafts.ts';
import {
  parseGraph,
  parseStageGraph,
  dependencies,
  GraphStageError,
  type GraphSpec,
} from '../../shared/graph.ts';
import { ContractFieldError, contractFieldLabels, parseContracts } from '../../shared/contracts.ts';
import { flushSync } from 'react-dom';
import { RuntimeFields } from './RuntimeFields.tsx';
import { ContractFields } from './ContractFields.tsx';
import { StageRunnerFields } from './StageRunnerFields.tsx';
import { WorkflowGraph } from './WorkflowGraph.tsx';
import { ArrowDown, ArrowUp, ChevronDown, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  LlmConfig,
  ProjectSpec,
  ReasoningEffort,
  WorkflowStageSpec,
} from '../../shared/types.ts';
import { projectAutomation, stageAutomation, EMPTY_GATE } from '../../shared/automation.ts';
import { parseCondition } from '../../shared/conditions.ts';
import { resolveExecution } from '../../shared/execution-policy.ts';
import {
  buildStagePrompt,
  previewVariables,
  PROMPT_VARIABLES,
  validateTemplate,
} from '../../shared/prompts.ts';
import type { ConditionResult } from '../../shared/conditions.ts';
import { jsonRequest, request, useProjectJobs } from '../api.ts';
import { ConditionBuilder, ConditionEvidence } from './ConditionBuilder.tsx';
import { ExecutionPolicyFields } from './ExecutionPolicyFields.tsx';
import { QueueNumberField } from './QueueNumberField.tsx';
import { NumberValue } from './NumberValue.tsx';
import { clockDate } from '../utils/workflow.ts';

export type WorkflowUpdatePayload = Pick<
  ProjectSpec,
  | 'acceptanceCriteria'
  | 'llm'
  | 'stages'
  | 'input'
  | 'execution'
  | 'jobTimeoutMs'
  | 'finalGate'
  | 'prompt'
  | 'queue'
  | 'graph'
  | 'runtime'
  | 'pricing'
>;

interface WorkflowSpecSectionProps {
  project: ProjectSpec;
  saving: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (
    next: WorkflowUpdatePayload,
    expectedUpdatedAt: string,
    onSaved: (saved: ProjectSpec) => void,
  ) => void;
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

function editableStages(stages: WorkflowStageSpec[]): StageDraft[] {
  return stages.map((stage, rowId) => ({ ...stage, rowId }));
}

export function WorkflowSpecSection({
  project,
  saving,
  onSave,
  onDirtyChange,
}: WorkflowSpecSectionProps) {
  const [graph, setGraph] = useState(project.graph);
  const [otherGraphs, setOtherGraphs] = useState<Partial<Record<GraphSpec['mode'], GraphSpec>>>({});
  const [automation, setAutomation] = useState(() => projectAutomation({}, project));
  const [packageError, setPackageError] = useState('');
  const monitor = useProjectJobs(project.id);
  const [candidate, setCandidate] = useState('');
  const [testResult, setTestResult] = useState<ConditionResult | null>(null);
  const [testError, setTestError] = useState('');
  const [testing, setTesting] = useState(false);
  const [acceptanceCriteria, setAcceptance] = useState(project.acceptanceCriteria);
  const [llm, setLlm] = useState(project.llm);
  const [stages, setStages] = useState(() => editableStages(project.stages));
  const nextId = useRef(stages.length);
  const [active, setActive] = useState(0);
  const [baseline, setBaseline] = useState(project);
  const index = Math.max(
    0,
    stages.findIndex((s) => s.rowId === active),
  );
  const stage = stages[index];
  const availableCandidates = monitor.data?.candidates ?? [];
  const activeCandidate = availableCandidates.some(
    (item) => JSON.stringify({ name: item.name, origin: item.origin }) === candidate,
  )
    ? candidate
    : '';
  let triggerValidation = '';
  try {
    parseCondition(automation.input?.condition ?? null, 'trigger');
  } catch (error) {
    triggerValidation = (error as Error).message;
  }
  const converting = Object.keys(otherGraphs).length > 0;
  const discarded = settingsLostOnSave(stages, graph, otherGraphs);
  const payload: WorkflowUpdatePayload = {
    ...automation,
    graph,
    acceptanceCriteria,
    llm,
    stages: stages.map((item) => stageForSave(item, graph?.mode, converting)),
  };
  const dirty =
    Boolean(discarded) ||
    JSON.stringify(graph) !== JSON.stringify(baseline.graph) ||
    acceptanceCriteria !== baseline.acceptanceCriteria ||
    JSON.stringify(llm) !== JSON.stringify(baseline.llm) ||
    JSON.stringify(payload.stages) !== JSON.stringify(baseline.stages) ||
    JSON.stringify(automation) !== JSON.stringify(projectAutomation({}, baseline));
  const externalUpdate = project.updatedAt > baseline.updatedAt;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  let validation = '';
  let problemStage: StageDraft | undefined;
  let target = 'workflow-defaults';
  let fieldName = 'プロジェクト設定';
  let promptPreview = '';
  try {
    if (packageError) throw new Error(packageError);
    const parsedAutomation = projectAutomation(payload);
    target = 'workflow-prompt';
    fieldName = '共通プロンプト';
    validateTemplate(automation.prompt ?? '');
    for (const [i, item] of payload.stages.entries()) {
      problemStage = stages[i];
      target = 'stage-gate';
      fieldName = '工程の受け入れ条件';
      stageAutomation({ gate: item.gate, acceptanceCriteria: item.acceptanceCriteria });
      target = 'stage-policy';
      fieldName = 'リトライ・タイムアウト';
      stageAutomation({ execution: item.execution });
      target = 'stage-runner';
      fieldName = '実行設定';
      parseStageGraph({ runner: item.runner });
      target = 'stage-map';
      fieldName = 'ファイルごとの実行';
      if (item.map) parseStageGraph({ map: item.map });
      target = 'stage-dependencies';
      fieldName = '依存工程';
      if (item.dependsOn) parseStageGraph({ dependsOn: item.dependsOn });
      parseContracts(item.contracts?.inputs, 'inputs');
      parseContracts(item.contracts?.outputs, 'outputs');
      target = 'stage-instruction';
      fieldName = 'カスタム指示';
      validateTemplate(item.instruction);
      target = 'stage-acceptance';
      fieldName = '受け入れ要件';
      validateTemplate(item.acceptanceCriteria ?? '');
      target = 'stage-runner';
      fieldName = '実行設定';
      if (item.runner?.kind === 'command' || item.runner?.kind === 'python')
        for (const arg of item.runner.args) validateTemplate(arg);
      if (item.runner?.kind === 'http') {
        validateTemplate(item.runner.url);
        validateTemplate(item.runner.body);
      }
    }
    problemStage = undefined;
    target = 'graph-settings';
    fieldName = '工程の接続・並列実行';
    parseGraph(graph, payload.stages);
    if (
      payload.stages.some((item) => item.cache?.enabled) &&
      (!graph || !parsedAutomation.runtime?.revision)
    )
      throw new Error('キャッシュにはWorkflow v2と実行環境の版が必要です。');
    if (
      !graph &&
      (parsedAutomation.runtime?.revision ||
        parsedAutomation.runtime?.python ||
        Object.keys(parsedAutomation.runtime?.expected ?? {}).length ||
        Object.keys(parsedAutomation.runtime?.packages ?? {}).length)
    )
      throw new Error('実行環境の固定にはWorkflow v2が必要です。');
    const draftProject = { ...project, ...payload };
    promptPreview = buildStagePrompt(
      draftProject,
      stage,
      previewVariables(draftProject, stage),
      graph ? stage.key === graph.publishStage : index === stages.length - 1,
    );
  } catch (error) {
    if (error instanceof ContractFieldError) {
      target = `contract-${error.scope}-${error.index}-${error.field}`;
      fieldName = `${error.scope === 'inputs' ? '入力契約' : '出力契約'} ${error.index + 1}・${contractFieldLabels[error.field]}`;
    } else if (error instanceof GraphStageError) {
      problemStage = stages.findLast((row) => row.key === error.key);
      target = { key: 'stage-key', dependencies: 'stage-dependencies', runner: 'stage-runner' }[
        error.field
      ];
      fieldName = { key: '工程キー', dependencies: '依存工程', runner: '実行設定' }[error.field];
    }
    validation = [problemStage?.label || problemStage?.key, fieldName, (error as Error).message]
      .filter(Boolean)
      .join(' ／ ');
  }
  function focusProblem() {
    if (problemStage) flushSync(() => setActive(problemStage.rowId));
    const element = document.getElementById(target) ?? document.getElementById('stage-settings');
    const control = element?.matches('input,textarea,select,summary')
      ? element
      : (element?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        element?.querySelector<HTMLElement>('input, select, textarea, summary'));
    if (control) {
      for (let parent = control.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
      (control as HTMLElement).focus();
    }
  }
  async function testInput() {
    setTesting(true);
    setTestError('');
    setTestResult(null);
    try {
      const result = await request<{ result: ConditionResult }>(
        `/api/projects/${project.id}/check-input`,
        jsonRequest('POST', {
          ...JSON.parse(activeCandidate),
          condition: automation.input?.condition,
        }),
      );
      setTestResult(result.result);
    } catch (error) {
      setTestError((error as Error).message);
    } finally {
      setTesting(false);
    }
  }
  function loadVersion(version: ProjectSpec) {
    setBaseline(version);
    setGraph(version.graph);
    setOtherGraphs({});
    setAutomation(projectAutomation({}, version));
    setTestResult(null);
    setTestError('');
    setAcceptance(version.acceptanceCriteria);
    setLlm(version.llm);
    // Keep the selected stage and its focused controls mounted across a refresh.
    let nextRow = Math.max(...stages.map((item) => item.rowId)) + 1;
    const rows = version.stages.map((spec) => ({
      ...spec,
      rowId: stages.find((item) => item.key === spec.key)?.rowId ?? nextRow++,
    }));
    setStages(rows);
    setActive(rows.find((item) => item.key === stage.key)?.rowId ?? rows[0].rowId);
  }
  if (externalUpdate && !dirty) loadVersion(project);
  function replacePublishStage(oldKey: string, newKey: string) {
    if (graph?.publishStage === oldKey) setGraph({ ...graph, publishStage: newKey });
    setOtherGraphs((previous) => {
      const next = { ...previous };
      for (const saved of Object.values(previous))
        if (saved.publishStage === oldKey) next[saved.mode] = { ...saved, publishStage: newKey };
      return next;
    });
  }
  function update(patch: Partial<StageDraft>) {
    const oldKey = stage.key;
    const renaming = patch.key !== undefined;
    const newKey = patch.key;
    setStages((prev) =>
      prev.map((item) => {
        const next = item.rowId === stage.rowId ? { ...item, ...patch } : item;
        return {
          ...next,
          dependsOn:
            renaming && next.dependsOn
              ? next.dependsOn.map((key) => (key === oldKey ? newKey! : key))
              : next.dependsOn,
        };
      }),
    );
    if (newKey !== undefined) replacePublishStage(oldKey, newKey);
  }
  function switchMode(mode: GraphSpec['mode'] | 'legacy') {
    const drafts = { ...otherGraphs };
    if (graph) drafts[graph.mode] = graph;
    if (mode === 'legacy') {
      setGraph(undefined);
    } else {
      setGraph(
        drafts[mode] ?? {
          mode,
          maxParallelTasks: graph?.maxParallelTasks ?? 2,
          publishStage: graph?.publishStage ?? stages.at(-1)!.key,
        },
      );
      delete drafts[mode];
      if (mode === 'dag')
        setStages((rows) =>
          rows.map((row, i) => ({
            ...row,
            dependsOn: row.dependsOn ?? (i ? [rows[i - 1].key] : []),
          })),
        );
    }
    setOtherGraphs(drafts);
  }
  function add() {
    const rowId = Math.max(nextId.current, ...stages.map((item) => item.rowId + 1));
    nextId.current = rowId + 1;
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
        dependsOn: graph?.mode === 'dag' ? [stages.at(-1)!.key] : undefined,
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
    setStages(
      items.map((item) => ({
        ...item,
        dependsOn: item.dependsOn?.filter((key) => key !== stage.key),
      })),
    );
    replacePublishStage(stage.key, items.at(-1)!.key);
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
            <button
              className="wf-secondary"
              disabled={saving || testing}
              onClick={() => loadVersion(project)}
            >
              <RotateCcw size={14} />
              {externalUpdate ? '下書きを破棄して最新版を読み込む' : '戻す'}
            </button>
          )}
          <button
            className="wf-primary"
            disabled={!dirty || saving || testing || Boolean(validation)}
            onClick={() => {
              if (!discarded || window.confirm(discarded + '\nこの内容で保存しますか？'))
                onSave(payload, project.updatedAt, loadVersion);
            }}
          >
            <Save size={15} />
            {saving ? '保存中…' : externalUpdate ? '下書きで上書き保存' : '定義を保存'}
          </button>
        </div>
      </div>
      {dirty && discarded && <p className="condition-error whitespace-pre-line">{discarded}</p>}
      {externalUpdate && dirty && !saving && (
        <p className="condition-error" role="alert">
          外部で更新されました。下書きを保持しています。最新版を読み込むか、現在の下書きで最新のワークフロー定義を上書きできます。
        </p>
      )}
      {validation && (
        <p className="condition-error" role="alert">
          <button type="button" className="text-left underline" onClick={focusProblem}>
            {validation}（設定箇所へ）
          </button>
        </p>
      )}
      <p className="wf-help">
        保存した定義は、新しく登録されるジョブに適用されます。登録済みジョブは登録時の入力・設定を固定して実行します。
      </p>
      <fieldset id="workflow-defaults" disabled={saving || testing} className="min-w-0">
        <details open className="wf-disclosure">
          <summary>
            基本設定 <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <label className="wf-wide">
              プロジェクト全体の受け入れ要件（エージェントへの指示）
              <textarea
                rows={4}
                value={acceptanceCriteria}
                onChange={(e) => setAcceptance(e.target.value)}
                maxLength={4000}
              />
            </label>
            <label className="wf-wide">
              共通プロンプト
              <textarea
                rows={4}
                maxLength={8000}
                id="workflow-prompt"
                value={automation.prompt ?? ''}
                onChange={(e) => setAutomation({ ...automation, prompt: e.target.value })}
                placeholder="各測定ファイルの関係を確認し、比較結果をまとめてください。"
              />
            </label>
            <ModelFields value={llm} onChange={setLlm} />
          </div>
        </details>
        <details open className="wf-disclosure">
          <summary>
            入力と起動条件 <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <label>
              監視フォルダでの入力単位
              <select
                value={automation.input!.mode}
                onChange={(e) =>
                  setAutomation({
                    ...automation,
                    input: {
                      ...automation.input!,
                      mode: e.target.value as 'auto' | 'file' | 'directory',
                    },
                  })
                }
              >
                <option value="auto">ファイル / 直下のフォルダごと</option>
                <option value="file">単一ファイルのみ</option>
                <option value="directory">直下のフォルダごと</option>
              </select>
            </label>
            <label>
              監視入力の安定待ち（秒）
              <NumberValue
                value={automation.input!.settleMs}
                scale={1000}
                onChange={(settleMs) =>
                  setAutomation({
                    ...automation,
                    input: {
                      ...automation.input!,
                      settleMs,
                    },
                  })
                }
              />
            </label>
          </div>
          <p className="wf-help">
            フォルダの中身をサブフォルダごと1つのジョブにまとめます。手動投入は全ファイルの転送完了を安定状態として扱います。
          </p>
          <ConditionBuilder
            label="起動条件"
            scope="trigger"
            value={automation.input!.condition}
            onChange={(condition) => {
              setAutomation({ ...automation, input: { ...automation.input!, condition } });
              setTestResult(null);
            }}
          />
          {monitor.isPending ? (
            <p role="status">テストする監視入力を読み込み中…</p>
          ) : monitor.isError ? (
            <div className="condition-toolbar">
              <p role="alert" className="condition-error">
                監視入力を取得できませんでした。
              </p>
              <button
                type="button"
                className="wf-secondary"
                disabled={monitor.isFetching}
                onClick={() => void monitor.refetch()}
              >
                {monitor.isFetching ? '再取得中…' : '監視入力の取得を再試行'}
              </button>
            </div>
          ) : availableCandidates.length === 0 ? (
            <p role="status" className="wf-help">
              テストできる監視入力がありません。監視フォルダ <code>{project.inboxDir}</code>{' '}
              にファイルまたはフォルダを置いてください。
            </p>
          ) : (
            <div className="condition-toolbar">
              <label>
                テストする監視入力
                <select
                  value={activeCandidate}
                  onChange={(e) => {
                    setCandidate(e.target.value);
                    setTestResult(null);
                  }}
                >
                  <option value="">入力を選択…</option>
                  {availableCandidates.map((item, i) => (
                    <option
                      key={`${item.name}-${i}`}
                      value={JSON.stringify({ name: item.name, origin: item.origin })}
                    >
                      {item.origin === 'legacy' ? '旧 inbox / ' : ''}
                      {item.name}（{item.fileCount}ファイル）
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="wf-secondary"
                type="button"
                disabled={!activeCandidate || testing || Boolean(triggerValidation)}
                onClick={() => void testInput()}
              >
                {testing ? '判定中…' : '未保存の条件をテスト'}
              </button>
            </div>
          )}
          <p className="wf-help">
            テストは監視中の現在の内容で条件だけを判定します。ジョブは作成しません。
          </p>
          {testResult && <ConditionEvidence result={testResult} />}
          {testError && (
            <p className="condition-error" role="alert">
              {testError}
            </p>
          )}
        </details>
        <RuntimeFields
          value={automation.runtime}
          pricing={automation.pricing}
          onRuntime={(runtime) => setAutomation({ ...automation, runtime })}
          onPricing={(pricing) => setAutomation({ ...automation, pricing })}
          onPackageError={setPackageError}
        />
        <details className="wf-disclosure">
          <summary>
            実行の既定値・ジョブ全体の上限 <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <QueueNumberField
              field="maxConcurrentJobs"
              label="このプロジェクトの同時ジョブ数"
              value={automation.queue!.maxConcurrentJobs}
              onChange={(maxConcurrentJobs) =>
                setAutomation({ ...automation, queue: { ...automation.queue!, maxConcurrentJobs } })
              }
            />
            <QueueNumberField
              field="priority"
              label="新規ジョブの優先度"
              value={automation.queue!.priority}
              onChange={(priority) =>
                setAutomation({ ...automation, queue: { ...automation.queue!, priority } })
              }
            />
          </div>
          <ExecutionPolicyFields
            value={automation.execution!}
            onChange={(execution) =>
              setAutomation({ ...automation, execution: resolveExecution(execution) })
            }
          />
          <div className="wf-fields">
            <label>
              ジョブ全体の実行上限（秒・0は無制限）
              <NumberValue
                value={automation.jobTimeoutMs ?? 0}
                scale={1000}
                onChange={(jobTimeoutMs) =>
                  setAutomation({
                    ...automation,
                    jobTimeoutMs,
                  })
                }
              />
            </label>
          </div>
        </details>
        <details className="wf-disclosure">
          <summary>
            最終成果物の受け入れ条件 <ChevronDown size={17} />
          </summary>
          <p className="wf-help">
            最後の工程の実行後に判定します。工程の条件と両方を満たしてから公開します。
          </p>
          <ConditionBuilder
            label="最終成果物の自動判定"
            scope="gate"
            value={automation.finalGate!.condition}
            onChange={(condition) =>
              setAutomation({ ...automation, finalGate: { ...automation.finalGate!, condition } })
            }
          />
          <label className="wf-check">
            <input
              type="checkbox"
              checked={automation.finalGate!.requireReview}
              onChange={(e) =>
                setAutomation({
                  ...automation,
                  finalGate: { ...automation.finalGate!, requireReview: e.target.checked },
                })
              }
            />
            公開前に人間のレビューを必須にする
          </label>
        </details>
        <details open className="wf-disclosure">
          <summary id="graph-settings">工程の接続・並列実行</summary>
          <div className="wf-fields">
            <label>
              実行モデル
              <select
                value={graph?.mode ?? 'legacy'}
                onChange={(event) => switchMode(event.target.value as GraphSpec['mode'] | 'legacy')}
              >
                <option value="legacy">従来の順次実行</option>
                <option value="sequential">Workflow v2 · 順次接続</option>
                <option value="dag">Workflow v2 · 依存関係で接続（DAG）</option>
              </select>
            </label>
            {graph && (
              <>
                <label>
                  同時実行するタスク数
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={graph.maxParallelTasks}
                    onChange={(event) =>
                      setGraph({ ...graph, maxParallelTasks: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  公開工程
                  <select
                    value={graph.publishStage}
                    onChange={(event) => setGraph({ ...graph, publishStage: event.target.value })}
                  >
                    {stages
                      .filter((item) => !item.map && item.runner?.kind !== 'human')
                      .map((item) => (
                        <option value={item.key} key={item.rowId}>
                          {item.label}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <p className="wf-help">
            v2では工程の種類・ファイルごとの実行・入出力契約を使えます。DAGでは並べ替えは表示順だけを変えます。公開工程は全工程の結果を受け取るように接続してください。
          </p>
        </details>
        {graph && <WorkflowGraph project={{ ...project, ...payload }} />}
        <div className="wf-section-title">
          <h2>
            工程 <span>{stages.length}</span>
          </h2>
          <button className="wf-secondary" onClick={add} disabled={stages.length >= 50}>
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
          <div id="stage-settings" className="wf-stage-detail" key={stage.rowId}>
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
            {graph && (
              <>
                <StageRunnerFields
                  value={stage.runner}
                  disableHuman={graph.publishStage === stage.key}
                  argumentText={
                    stage.runner?.kind === 'python' || stage.runner?.kind === 'command'
                      ? stage.argumentText?.[stage.runner.kind]
                      : undefined
                  }
                  onArgumentsChange={(text) => {
                    const kind = stage.runner?.kind;
                    if (kind === 'command' || kind === 'python')
                      update({ argumentText: { ...stage.argumentText, [kind]: text } });
                  }}
                  onChange={(runner) =>
                    update({
                      ...runnerChange(stage, runner),
                      cache: ['human', 'http'].includes(runner.kind)
                        ? { enabled: false, revision: '' }
                        : stage.cache,
                    })
                  }
                />
                {graph.mode === 'dag' && (
                  <fieldset id="stage-dependencies" className="wf-disclosure">
                    <legend>この工程の開始前に合格が必要な工程</legend>
                    <div className="dependency-options">
                      {stages
                        .filter((item) => item.key !== stage.key)
                        .map((item) => (
                          <label className="wf-check" key={item.rowId}>
                            <input
                              type="checkbox"
                              checked={stage.dependsOn?.includes(item.key) ?? false}
                              onChange={(event) =>
                                update({
                                  dependsOn: event.target.checked
                                    ? [...(stage.dependsOn ?? []), item.key]
                                    : stage.dependsOn?.filter((key) => key !== item.key),
                                })
                              }
                            />
                            {item.label}
                          </label>
                        ))}
                    </div>
                  </fieldset>
                )}
                <p className="wf-help">
                  開始条件:{' '}
                  {dependencies({ stages, graph }, stage).join(' ＋ ') || '入力がそろったら開始'}
                </p>
                <label className="wf-check">
                  <input
                    type="checkbox"
                    disabled={graph.publishStage === stage.key}
                    id="stage-map"
                    checked={!!stage.map}
                    onChange={(event) =>
                      update({
                        map: event.target.checked ? { pattern: '**/*.csv', maxItems: 100 } : null,
                      })
                    }
                  />
                  入力ファイルごとに独立して実行（map）
                </label>
                {stage.map && (
                  <div className="wf-fields">
                    <label className="wf-wide">
                      <span>
                        <input
                          type="checkbox"
                          checked={stage.map.isolateInput ?? false}
                          onChange={(event) =>
                            update({ map: { ...stage.map!, isolateInput: event.target.checked } })
                          }
                        />{' '}
                        このファイルだけを入力に渡す（ファイル単位の差分解析）
                      </span>
                    </label>
                    <label>
                      対象パターン
                      <input
                        value={stage.map.pattern}
                        onChange={(event) =>
                          update({ map: { ...stage.map!, pattern: event.target.value } })
                        }
                      />
                    </label>
                    <label>
                      対象の最大件数
                      <input
                        type="number"
                        min={1}
                        max={128}
                        value={stage.map.maxItems}
                        onChange={(event) =>
                          update({ map: { ...stage.map!, maxItems: Number(event.target.value) } })
                        }
                      />
                    </label>
                  </div>
                )}
                <details className="wf-disclosure">
                  <summary>実行前の入力契約</summary>
                  <ContractFields
                    input
                    value={stage.contracts?.inputs ?? []}
                    onChange={(inputs) =>
                      update({ contracts: { inputs, outputs: stage.contracts?.outputs ?? [] } })
                    }
                  />
                </details>
                <details className="wf-disclosure">
                  <summary>出力の契約・JSONの型</summary>
                  <ContractFields
                    value={stage.contracts?.outputs ?? []}
                    onChange={(outputs) =>
                      update({ contracts: { inputs: stage.contracts?.inputs ?? [], outputs } })
                    }
                  />
                </details>
              </>
            )}
            <fieldset className="wf-cache">
              <legend>結果の再利用</legend>
              <label>
                <input
                  type="checkbox"
                  checked={stage.cache?.enabled ?? false}
                  disabled={
                    !stage.cache?.enabled &&
                    (!graph || ['human', 'http'].includes(stage.runner?.kind ?? 'ai'))
                  }
                  onChange={(e) =>
                    update({
                      cache: { enabled: e.target.checked, revision: stage.cache?.revision ?? '' },
                    })
                  }
                />{' '}
                入力・定義・環境が一致する合格済み出力をキャッシュする
              </label>
              <p className="wf-help">
                時刻・外部サービス・ジョブIDに依存しない処理に使います。環境の版を指定してください。入力契約・出力判定・必要な人間の承認は毎回確認します。
              </p>
              {stage.cache?.enabled && (
                <label>
                  キャッシュの版
                  <input
                    maxLength={120}
                    value={stage.cache.revision}
                    onChange={(e) =>
                      update({ cache: { ...stage.cache!, revision: e.target.value } })
                    }
                    placeholder="変更すると既存結果を再利用しません"
                  />
                </label>
              )}
            </fieldset>
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
                  maxLength={8000}
                  id="stage-instruction"
                  value={stage.instruction}
                  onChange={(e) => update({ instruction: e.target.value })}
                />
              </label>
            </div>
            <details open className="wf-disclosure">
              <summary id="stage-gate">
                この工程の受け入れ条件 <ChevronDown size={16} />
              </summary>
              <div className="wf-fields">
                <label className="wf-wide">
                  受け入れ要件（エージェントへの指示）
                  <textarea
                    rows={3}
                    maxLength={4000}
                    id="stage-acceptance"
                    value={stage.acceptanceCriteria ?? ''}
                    onChange={(e) => update({ acceptanceCriteria: e.target.value })}
                  />
                </label>
              </div>
              <ConditionBuilder
                label="工程の自動判定"
                scope="gate"
                value={stage.gate?.condition ?? null}
                onChange={(condition) =>
                  update({ gate: { ...(stage.gate ?? EMPTY_GATE), condition } })
                }
              />
              <label className="wf-check">
                <input
                  type="checkbox"
                  checked={stage.gate?.requireReview ?? false}
                  onChange={(e) =>
                    update({
                      gate: { ...(stage.gate ?? EMPTY_GATE), requireReview: e.target.checked },
                    })
                  }
                />
                この工程が合格しても、人間の承認を待つ
              </label>
            </details>
            <details className="wf-disclosure">
              <summary id="stage-policy">
                この工程のリトライ・タイムアウト <ChevronDown size={16} />
              </summary>
              <ExecutionPolicyFields
                value={stage.execution ?? {}}
                inherited={automation.execution}
                onChange={(execution) => update({ execution })}
              />
            </details>
            <details className="wf-disclosure">
              <summary>
                プロンプト変数・送信内容のプレビュー <ChevronDown size={16} />
              </summary>
              <p className="wf-help">
                共通プロンプト・カスタム指示・工程の受け入れ要件に使用できます。以下は例のデータセットと初回実行で展開した内容です。
              </p>
              <div className="prompt-variables">
                {PROMPT_VARIABLES.map((name) => (
                  <code key={name}>{'{{' + name + '}}'}</code>
                ))}
              </div>
              <pre className="prompt-preview">{promptPreview || validation}</pre>
            </details>
            <details open className="wf-disclosure">
              <summary>
                工程キー・モデル設定 <ChevronDown size={16} />
              </summary>
              <div className="wf-fields">
                <label className="wf-wide">
                  工程キー
                  <input
                    id="stage-key"
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
