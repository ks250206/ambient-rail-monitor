import {
  stageForSave,
  supportsCache,
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
import { DEFAULT_RUNTIME, packageRecord, packageRowsError } from '../../shared/reuse.ts';
import { RuntimeFields, type PackageRow } from './RuntimeFields.tsx';
import { ContractFields } from './ContractFields.tsx';
import { StageRunnerFields } from './StageRunnerFields.tsx';
import { DryRunPanel } from './DryRunPanel.tsx';
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
import { useI18n } from '../i18n.ts';
import { ConditionBuilder, ConditionEvidence } from './ConditionBuilder.tsx';
import { CustomSelect } from './CustomSelect.tsx';
import { confirmDialog } from './DialogHost.tsx';
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

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; ja: string; en: string }> = [
  { value: '', ja: '指定なし（CLI 既定）', en: 'Unset (CLI default)' },
  { value: 'low', ja: 'low（軽量・高速）', en: 'low (lightweight & fast)' },
  { value: 'medium', ja: 'medium（標準）', en: 'medium (balanced)' },
  { value: 'high', ja: 'high（深い推論）', en: 'high (deep reasoning)' },
  { value: 'xhigh', ja: 'xhigh（高精度推論）', en: 'xhigh (extended reasoning)' },
  {
    value: 'max',
    ja: 'max（最大 ※Codex は xhigh にマップ）',
    en: 'max (maximum; maps to xhigh on Codex)',
  },
];

const CONTRACT_FIELD_LABELS_EN: Record<keyof typeof contractFieldLabels, string> = {
  source: 'Source',
  pattern: 'Pattern',
  minFiles: 'Min files',
  maxFiles: 'Max files',
  schema: 'JSON schema',
};

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

function editablePackages(project: ProjectSpec): PackageRow[] {
  return Object.entries(project.runtime?.packages ?? {}).map(([name, version], id) => ({
    name,
    version,
    id,
  }));
}

export function WorkflowSpecSection({
  project,
  saving,
  onSave,
  onDirtyChange,
}: WorkflowSpecSectionProps) {
  const { locale, pick } = useI18n();
  const [graph, setGraph] = useState(project.graph);
  const [otherGraphs, setOtherGraphs] = useState<Partial<Record<GraphSpec['mode'], GraphSpec>>>({});
  const [automation, setAutomation] = useState(() => projectAutomation({}, project));
  const [packageRows, setPackageRows] = useState(() => editablePackages(project));
  const packageError = packageRowsError(packageRows);
  const runtime = {
    ...(automation.runtime ?? DEFAULT_RUNTIME),
    packages: packageRecord(packageRows),
  };
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
  const discarded = settingsLostOnSave(stages, graph, otherGraphs, runtime, locale);
  const payload: WorkflowUpdatePayload = {
    ...automation,
    runtime: graph ? runtime : DEFAULT_RUNTIME,
    graph,
    acceptanceCriteria,
    llm,
    stages: stages.map((item) => stageForSave(item, graph?.mode, converting)),
  };
  const dirty =
    Boolean(packageError || discarded) ||
    JSON.stringify(graph) !== JSON.stringify(baseline.graph) ||
    acceptanceCriteria !== baseline.acceptanceCriteria ||
    JSON.stringify(llm) !== JSON.stringify(baseline.llm) ||
    JSON.stringify(payload.stages) !== JSON.stringify(baseline.stages) ||
    JSON.stringify({ ...automation, runtime }) !== JSON.stringify(projectAutomation({}, baseline));
  const externalUpdate = project.updatedAt > baseline.updatedAt;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  let validation = '';
  let problemStage: StageDraft | undefined;
  let target = 'workflow-defaults';
  let fieldName = pick('プロジェクト設定', 'Project settings');
  let promptPreview = '';
  try {
    if (graph && packageError) {
      target = 'runtime-packages';
      fieldName = pick('Pythonパッケージ', 'Python packages');
      throw new Error(packageError);
    }
    const parsedAutomation = projectAutomation(payload);
    target = 'workflow-prompt';
    fieldName = pick('共通プロンプト', 'Shared prompt');
    validateTemplate(automation.prompt ?? '');
    for (const [i, item] of payload.stages.entries()) {
      problemStage = stages[i];
      target = 'stage-gate';
      fieldName = pick('工程の受け入れ条件', 'Stage acceptance gate');
      stageAutomation({ gate: item.gate, acceptanceCriteria: item.acceptanceCriteria });
      target = 'stage-policy';
      fieldName = pick('リトライ・タイムアウト', 'Retry & timeout');
      stageAutomation({ execution: item.execution });
      target = 'stage-runner';
      fieldName = pick('実行設定', 'Runner');
      parseStageGraph({ runner: item.runner });
      target = 'stage-map';
      fieldName = pick('ファイルごとの実行', 'Per-file execution');
      if (item.map) parseStageGraph({ map: item.map });
      target = 'stage-dependencies';
      fieldName = pick('依存工程', 'Dependencies');
      if (item.dependsOn) parseStageGraph({ dependsOn: item.dependsOn });
      parseContracts(item.contracts?.inputs, 'inputs');
      parseContracts(item.contracts?.outputs, 'outputs');
      target = 'stage-instruction';
      fieldName = pick('カスタム指示', 'Custom instruction');
      validateTemplate(item.instruction);
      target = 'stage-acceptance';
      fieldName = pick('受け入れ要件', 'Acceptance criteria');
      validateTemplate(item.acceptanceCriteria ?? '');
      target = 'stage-runner';
      fieldName = pick('実行設定', 'Runner');
      if (item.runner?.kind === 'command' || item.runner?.kind === 'python')
        for (const arg of item.runner.args) validateTemplate(arg);
      if (item.runner?.kind === 'http') {
        validateTemplate(item.runner.url);
        validateTemplate(item.runner.body);
      }
    }
    problemStage = undefined;
    target = 'graph-settings';
    fieldName = pick('工程の接続・並列実行', 'Stage wiring & parallelism');
    parseGraph(graph, payload.stages);
    if (
      payload.stages.some((item) => item.cache?.enabled) &&
      (!graph || !parsedAutomation.runtime?.revision)
    )
      throw new Error(
        pick(
          'キャッシュにはWorkflow v2と実行環境の版が必要です。',
          'Caching requires Workflow v2 and a runtime revision.',
        ),
      );
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
      fieldName =
        locale === 'en'
          ? `${error.scope === 'inputs' ? 'Input contract' : 'Output contract'} ${error.index + 1} · ${CONTRACT_FIELD_LABELS_EN[error.field]}`
          : `${error.scope === 'inputs' ? '入力契約' : '出力契約'} ${error.index + 1}・${contractFieldLabels[error.field]}`;
    } else if (error instanceof GraphStageError) {
      problemStage = stages.findLast((row) => row.key === error.key);
      target = { key: 'stage-key', dependencies: 'stage-dependencies', runner: 'stage-runner' }[
        error.field
      ];
      fieldName = {
        key: pick('工程キー', 'Stage key'),
        dependencies: pick('依存工程', 'Dependencies'),
        runner: pick('実行設定', 'Runner'),
      }[error.field];
    }
    validation = [problemStage?.label || problemStage?.key, fieldName, (error as Error).message]
      .filter(Boolean)
      .join(locale === 'en' ? ' / ' : ' ／ ');
  }
  function focusProblem() {
    if (problemStage) flushSync(() => setActive(problemStage.rowId));
    const element = document.getElementById(target) ?? document.getElementById('stage-settings');
    const control = element?.matches('input,textarea,button[role="combobox"],summary')
      ? element
      : (element?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        element?.querySelector<HTMLElement>('input, button[role="combobox"], textarea, summary'));
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
    setPackageRows(editablePackages(version));
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
        label: pick(`新規工程 ${n}`, `New stage ${n}`),
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

  async function handleSave() {
    if (discarded) {
      const ok = await confirmDialog({
        title: pick('互換性のない設定を破棄して保存', 'Discard incompatible settings & save'),
        message: pick(
          '現在の設定では使用できない下書きが破棄されます。この内容で保存しますか？',
          'Draft settings incompatible with the selected mode will be discarded. Save with these changes?',
        ),
        detail: discarded,
        confirmLabel: pick('破棄して保存', 'Discard & save'),
        cancelLabel: pick('キャンセル', 'Cancel'),
        tone: 'danger',
      });
      if (!ok) return;
    }
    onSave(payload, project.updatedAt, loadVersion);
  }

  return (
    <section aria-label={pick('ワークフロー設定', 'Workflow configuration')}>
      <div className="wf-project">
        <div>
          <h2>{project.name}</h2>
          <p>{project.purpose}</p>
        </div>
        <div className="wf-save">
          <span role="status">
            {dirty
              ? pick('未保存の変更', 'Unsaved changes')
              : pick(
                  `最終更新 ${clockDate(project.updatedAt)}`,
                  `Last updated ${clockDate(project.updatedAt)}`,
                )}
          </span>
          {dirty && (
            <button
              className="wf-secondary"
              disabled={saving || testing}
              onClick={() => loadVersion(project)}
            >
              <RotateCcw size={14} />
              {externalUpdate
                ? pick('下書きを破棄して最新版を読み込む', 'Discard draft & load latest')
                : pick('戻す', 'Revert')}
            </button>
          )}
          <button
            className="wf-primary"
            disabled={!dirty || saving || testing || Boolean(validation)}
            onClick={() => void handleSave()}
          >
            <Save size={15} />
            {saving
              ? pick('保存中…', 'Saving…')
              : externalUpdate
                ? pick('下書きで上書き保存', 'Overwrite with draft')
                : pick('定義を保存', 'Save workflow')}
          </button>
        </div>
      </div>
      {dirty && discarded && <p className="condition-error whitespace-pre-line">{discarded}</p>}
      {externalUpdate && dirty && !saving && (
        <p className="condition-error" role="alert">
          {pick(
            '外部で更新されました。下書きを保持しています。最新版を読み込むか、現在の下書きで最新のワークフロー定義を上書きできます。',
            'Updated externally. Your draft is preserved. Load the latest version or overwrite it with your current draft.',
          )}
        </p>
      )}
      {validation && (
        <p className="condition-error" role="alert">
          <button type="button" className="text-left underline" onClick={focusProblem}>
            {validation}
            {pick('（設定箇所へ）', ' (Jump to field)')}
          </button>
        </p>
      )}
      <p className="wf-help">
        {pick(
          '保存した定義は、新しく登録されるジョブに適用されます。登録済みジョブは登録時の入力・設定を固定して実行します。',
          'Saved definitions apply to newly queued jobs. Already-registered jobs run with their frozen snapshot.',
        )}
      </p>
      <fieldset id="workflow-defaults" disabled={saving || testing} className="min-w-0">
        <details open className="wf-disclosure">
          <summary>
            {pick('基本設定', 'General')} <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <label className="wf-wide">
              {pick(
                'プロジェクト全体の受け入れ要件（エージェントへの指示）',
                'Project acceptance criteria (agent guidance)',
              )}
              <textarea
                rows={4}
                value={acceptanceCriteria}
                onChange={(e) => setAcceptance(e.target.value)}
                maxLength={4000}
              />
            </label>
            <label className="wf-wide">
              {pick('共通プロンプト', 'Shared prompt')}
              <textarea
                rows={4}
                maxLength={8000}
                id="workflow-prompt"
                value={automation.prompt ?? ''}
                onChange={(e) => setAutomation({ ...automation, prompt: e.target.value })}
                placeholder={pick(
                  '各測定ファイルの関係を確認し、比較結果をまとめてください。',
                  'Inspect relationships across measurement files and summarize comparisons.',
                )}
              />
            </label>
            <ModelFields value={llm} onChange={setLlm} />
          </div>
        </details>
        <details open className="wf-disclosure">
          <summary>
            {pick('入力と起動条件', 'Inputs & trigger conditions')} <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <label>
              {pick('監視フォルダでの入力単位', 'Watch folder input unit')}
              <CustomSelect<'auto' | 'file' | 'directory'>
                value={automation.input!.mode}
                onChange={(mode) =>
                  setAutomation({
                    ...automation,
                    input: {
                      ...automation.input!,
                      mode,
                    },
                  })
                }
                options={[
                  {
                    value: 'auto',
                    label: pick('ファイル / 直下のフォルダごと', 'Each file or top-level folder'),
                  },
                  { value: 'file', label: pick('単一ファイルのみ', 'Single files only') },
                  { value: 'directory', label: pick('直下のフォルダごと', 'Top-level folders') },
                ]}
              />
            </label>
            <label>
              {pick('監視入力の安定待ち（秒）', 'Watch input settle delay (sec)')}
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
            {pick(
              'フォルダの中身をサブフォルダごと1つのジョブにまとめます。手動投入は全ファイルの転送完了を安定状態として扱います。',
              'Each dropped folder (including subfolders) becomes one job. Manual uploads are treated as settled once transfer completes.',
            )}
          </p>
          <ConditionBuilder
            label={pick('起動条件', 'Trigger condition')}
            scope="trigger"
            value={automation.input!.condition}
            onChange={(condition) => {
              setAutomation({ ...automation, input: { ...automation.input!, condition } });
              setTestResult(null);
            }}
          />
          {monitor.isPending ? (
            <p role="status">
              {pick('テストする監視入力を読み込み中…', 'Loading inbox candidates for testing…')}
            </p>
          ) : monitor.isError ? (
            <div className="condition-toolbar">
              <p role="alert" className="condition-error">
                {pick('監視入力を取得できませんでした。', 'Failed to fetch inbox candidates.')}
              </p>
              <button
                type="button"
                className="wf-secondary"
                disabled={monitor.isFetching}
                onClick={() => void monitor.refetch()}
              >
                {monitor.isFetching
                  ? pick('再取得中…', 'Retrying…')
                  : pick('監視入力の取得を再試行', 'Retry fetching candidates')}
              </button>
            </div>
          ) : availableCandidates.length === 0 ? (
            <p role="status" className="wf-help">
              {locale === 'en' ? (
                <>
                  No inbox candidates to test. Place files or folders in{' '}
                  <code>{project.inboxDir}</code>.
                </>
              ) : (
                <>
                  テストできる監視入力がありません。監視フォルダ <code>{project.inboxDir}</code>{' '}
                  にファイルまたはフォルダを置いてください。
                </>
              )}
            </p>
          ) : (
            <div className="condition-toolbar">
              <label>
                {pick('テストする監視入力', 'Candidate to test')}
                <CustomSelect
                  value={activeCandidate}
                  onChange={(value) => {
                    setCandidate(value);
                    setTestResult(null);
                  }}
                  options={[
                    { value: '', label: pick('入力を選択…', 'Select input…') },
                    ...availableCandidates.map((item) => ({
                      value: JSON.stringify({ name: item.name, origin: item.origin }),
                      label:
                        locale === 'en'
                          ? `${item.origin === 'legacy' ? 'Legacy inbox / ' : ''}${item.name} (${item.fileCount} files)`
                          : `${item.origin === 'legacy' ? '旧 inbox / ' : ''}${item.name}（${item.fileCount}ファイル）`,
                    })),
                  ]}
                />
              </label>
              <button
                className="wf-secondary"
                type="button"
                disabled={!activeCandidate || testing || Boolean(triggerValidation)}
                onClick={() => void testInput()}
              >
                {testing
                  ? pick('判定中…', 'Evaluating…')
                  : pick('未保存の条件をテスト', 'Test unsaved condition')}
              </button>
            </div>
          )}
          <p className="wf-help">
            {pick(
              'テストは監視中の現在の内容で条件だけを判定します。ジョブは作成しません。',
              'Testing only evaluates conditions against the current inbox contents without creating a job.',
            )}
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
          enabled={Boolean(graph)}
          rows={packageRows}
          onRows={setPackageRows}
          packageError={packageError}
        />
        <details className="wf-disclosure">
          <summary>
            {pick('実行の既定値・ジョブ全体の上限', 'Execution defaults & job limits')}{' '}
            <ChevronDown size={17} />
          </summary>
          <div className="wf-fields">
            <QueueNumberField
              field="maxConcurrentJobs"
              label={pick('このプロジェクトの同時ジョブ数', 'Project concurrent jobs')}
              value={automation.queue!.maxConcurrentJobs}
              onChange={(maxConcurrentJobs) =>
                setAutomation({ ...automation, queue: { ...automation.queue!, maxConcurrentJobs } })
              }
            />
            <QueueNumberField
              field="priority"
              label={pick('新規ジョブの優先度', 'New job priority')}
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
              {pick('ジョブ全体の実行上限（秒・0は無制限）', 'Job total timeout (sec, 0 = none)')}
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
            {pick('最終成果物の受け入れ条件', 'Final deliverable gate')} <ChevronDown size={17} />
          </summary>
          <p className="wf-help">
            {pick(
              '最後の工程の実行後に判定します。工程の条件と両方を満たしてから公開します。',
              'Evaluated after the final stage finishes. Both stage and final gates must pass before publishing.',
            )}
          </p>
          <ConditionBuilder
            label={pick('最終成果物の自動判定', 'Final automated gate')}
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
            {pick('公開前に人間のレビューを必須にする', 'Require human review before publishing')}
          </label>
        </details>
        <details open className="wf-disclosure">
          <summary id="graph-settings">
            {pick('工程の接続・並列実行', 'Stage wiring & parallelism')}
          </summary>
          <div className="wf-fields">
            <label>
              {pick('実行モデル', 'Execution model')}
              <CustomSelect<GraphSpec['mode'] | 'legacy'>
                value={graph?.mode ?? 'legacy'}
                onChange={(mode) => switchMode(mode)}
                options={[
                  { value: 'legacy', label: pick('従来の順次実行', 'Legacy sequential') },
                  {
                    value: 'sequential',
                    label: pick('Workflow v2 · 順次接続', 'Workflow v2 · Sequential'),
                  },
                  {
                    value: 'dag',
                    label: pick(
                      'Workflow v2 · 依存関係で接続（DAG）',
                      'Workflow v2 · Dependency graph (DAG)',
                    ),
                  },
                ]}
              />
            </label>
            {graph && (
              <>
                <label>
                  {pick('同時実行するタスク数', 'Max parallel tasks')}
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
                  {pick('公開工程', 'Publish stage')}
                  <CustomSelect
                    value={graph.publishStage}
                    onChange={(publishStage) => setGraph({ ...graph, publishStage })}
                    options={stages
                      .filter((item) => !item.map && item.runner?.kind !== 'human')
                      .map((item) => ({ value: item.key, label: item.label || item.key }))}
                  />
                </label>
              </>
            )}
          </div>
          <p className="wf-help">
            {pick(
              'v2では工程の種類・ファイルごとの実行・入出力契約を使えます。DAGでは並べ替えは表示順だけを変えます。公開工程は全工程の結果を受け取るように接続してください。',
              'Workflow v2 unlocks runners, per-file map, and I/O contracts. In DAG mode, stage ordering affects display only; wire the publish stage so it receives upstream outputs.',
            )}
          </p>
        </details>
        {graph && (
          <DryRunPanel
            key={project.id}
            projectId={project.id}
            draft={payload}
            valid={!validation}
            jobs={monitor.data?.jobs ?? []}
          />
        )}
        {graph && <WorkflowGraph project={{ ...project, ...payload }} />}
        <div className="wf-section-title">
          <h2>
            {pick('工程', 'Stages')} <span>{stages.length}</span>
          </h2>
          <button className="wf-secondary" onClick={add} disabled={stages.length >= 50}>
            <Plus size={15} />
            {pick('工程を追加', 'Add stage')}
          </button>
        </div>
        <div className="wf-editor">
          <nav className="wf-stage-list" aria-label={pick('編集する工程', 'Stage to edit')}>
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
            {pick('編集する工程', 'Stage to edit')}
            <CustomSelect
              ariaLabel={pick('編集する工程', 'Stage to edit')}
              value={String(stage.rowId)}
              onChange={(val) => setActive(Number(val))}
              options={stages.map((item, i) => ({
                value: String(item.rowId),
                label: `${i + 1}. ${item.label || item.key}`,
              }))}
            />
          </label>
          <div id="stage-settings" className="wf-stage-detail panel-enter" key={stage.rowId}>
            <div className="wf-detail-title">
              <h3>{stage.label || pick('工程の編集', 'Edit stage')}</h3>
              <div className="wf-order">
                <button
                  aria-label={pick('工程を前へ移動', 'Move stage up')}
                  title={pick('前へ移動', 'Move up')}
                  disabled={index === 0}
                  onClick={() => move(-1)}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  aria-label={pick('工程を後ろへ移動', 'Move stage down')}
                  title={pick('後ろへ移動', 'Move down')}
                  disabled={index === stages.length - 1}
                  onClick={() => move(1)}
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  aria-label={pick('工程を削除', 'Delete stage')}
                  title={pick('工程を削除', 'Delete stage')}
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
                  onChange={(runner) => update(runnerChange(stage, runner))}
                />
                {graph.mode === 'dag' && (
                  <fieldset id="stage-dependencies" className="wf-disclosure">
                    <legend>
                      {pick(
                        'この工程の開始前に合格が必要な工程',
                        'Stages that must pass before this stage starts',
                      )}
                    </legend>
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
                  {pick('開始条件: ', 'Starts when: ')}
                  {dependencies({ stages, graph }, stage).join(locale === 'en' ? ' + ' : ' ＋ ') ||
                    pick('入力がそろったら開始', 'Starts as soon as inputs are ready')}
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
                  {pick(
                    '入力ファイルごとに独立して実行（map）',
                    'Run independently per input file (map)',
                  )}
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
                        {pick(
                          'このファイルだけを入力に渡す（ファイル単位の差分解析）',
                          'Pass only this file as input (isolated per-file analysis)',
                        )}
                      </span>
                    </label>
                    <label>
                      {pick('対象パターン', 'File pattern')}
                      <input
                        value={stage.map.pattern}
                        onChange={(event) =>
                          update({ map: { ...stage.map!, pattern: event.target.value } })
                        }
                      />
                    </label>
                    <label>
                      {pick('対象の最大件数', 'Max items')}
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
                  <summary>{pick('実行前の入力契約', 'Pre-run input contracts')}</summary>
                  <ContractFields
                    input
                    value={stage.contracts?.inputs ?? []}
                    onChange={(inputs) =>
                      update({ contracts: { inputs, outputs: stage.contracts?.outputs ?? [] } })
                    }
                  />
                </details>
                <details className="wf-disclosure">
                  <summary>
                    {pick('出力の契約・JSONの型', 'Output contracts & JSON schema')}
                  </summary>
                  <ContractFields
                    value={stage.contracts?.outputs ?? []}
                    onChange={(outputs) =>
                      update({ contracts: { inputs: stage.contracts?.inputs ?? [], outputs } })
                    }
                  />
                </details>
              </>
            )}
            <fieldset className="wf-cache" disabled={!supportsCache(graph?.mode, stage.runner)}>
              <legend>{pick('結果の再利用', 'Result caching')}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={
                    supportsCache(graph?.mode, stage.runner) && Boolean(stage.cache?.enabled)
                  }
                  onChange={(e) =>
                    update({
                      cache: { enabled: e.target.checked, revision: stage.cache?.revision ?? '' },
                    })
                  }
                />{' '}
                {pick(
                  '入力・定義・環境が一致する合格済み出力をキャッシュする',
                  'Cache passed outputs matching inputs, definition, and runtime',
                )}
              </label>
              <p className="wf-help">
                {pick(
                  '時刻・外部サービス・ジョブIDに依存しない処理に使います。環境の版を指定してください。入力契約・出力判定・必要な人間の承認は毎回確認します。',
                  'Use for deterministic stages independent of clock, external APIs, or job IDs. Specify a runtime revision. Input contracts, output gates, and required reviews still run.',
                )}
              </p>
              {supportsCache(graph?.mode, stage.runner) && stage.cache?.enabled && (
                <label>
                  {pick('キャッシュの版', 'Cache revision')}
                  <input
                    maxLength={120}
                    value={stage.cache.revision}
                    onChange={(e) =>
                      update({ cache: { ...stage.cache!, revision: e.target.value } })
                    }
                    placeholder={pick(
                      '変更すると既存結果を再利用しません',
                      'Bump to invalidate cached results',
                    )}
                  />
                </label>
              )}
            </fieldset>
            <div className="wf-fields">
              <label>
                {pick('工程名', 'Stage name')}
                <input
                  value={stage.label}
                  maxLength={80}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
              <label>
                {pick('短縮名', 'Short name')}
                <input
                  value={stage.short}
                  maxLength={40}
                  onChange={(e) => update({ short: e.target.value })}
                />
              </label>
              <label className="wf-wide">
                {pick('カスタム指示', 'Custom instruction')}
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
                {pick('この工程の受け入れ条件', 'Stage acceptance gate')} <ChevronDown size={16} />
              </summary>
              <div className="wf-fields">
                <label className="wf-wide">
                  {pick(
                    '受け入れ要件（エージェントへの指示）',
                    'Acceptance criteria (agent guidance)',
                  )}
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
                label={pick('工程の自動判定', 'Automated stage gate')}
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
                {pick(
                  'この工程が合格しても、人間の承認を待つ',
                  'Wait for human approval even when this stage passes',
                )}
              </label>
            </details>
            <details className="wf-disclosure">
              <summary id="stage-policy">
                {pick('この工程のリトライ・タイムアウト', 'Stage retry & timeout')}{' '}
                <ChevronDown size={16} />
              </summary>
              <ExecutionPolicyFields
                value={stage.execution ?? {}}
                inherited={automation.execution}
                onChange={(execution) => update({ execution })}
              />
            </details>
            <details className="wf-disclosure">
              <summary>
                {pick('プロンプト変数・送信内容のプレビュー', 'Prompt variables & preview')}{' '}
                <ChevronDown size={16} />
              </summary>
              <p className="wf-help">
                {pick(
                  '共通プロンプト・カスタム指示・工程の受け入れ要件に使用できます。以下は例のデータセットと初回実行で展開した内容です。',
                  'Available in shared prompts, custom instructions, and stage acceptance criteria. Below is expanded with a sample dataset on attempt 1.',
                )}
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
                {pick('工程キー・モデル設定', 'Stage key & model')} <ChevronDown size={16} />
              </summary>
              <div className="wf-fields">
                <label className="wf-wide">
                  {pick('工程キー', 'Stage key')}
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
  const { pick } = useI18n();
  const fallback = inherited
    ? pick('プロジェクト設定を継承', 'Inherit project setting')
    : pick('CLI の既定値', 'CLI default');
  return (
    <>
      <label>
        {inherited ? pick('モデル上書き', 'Model override') : pick('既定モデル', 'Default model')}
        <input
          list="railflow-model-suggestions"
          value={value.model}
          placeholder={fallback}
          maxLength={100}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </label>
      <label>
        {pick('推論強度', 'Reasoning effort')}
        <CustomSelect<ReasoningEffort>
          value={value.effort}
          onChange={(effort) => onChange({ ...value, effort })}
          options={EFFORT_OPTIONS.map((option) => ({
            value: option.value,
            label: option.value ? pick(option.ja, option.en) : fallback,
          }))}
        />
      </label>
    </>
  );
}
