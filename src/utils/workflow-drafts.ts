import type { GraphSpec, StageRunner } from '../../shared/graph.ts';
import type { RuntimeProfile } from '../../shared/reuse.ts';
import type { WorkflowStageSpec } from '../../shared/types.ts';
import type { Locale } from '../i18n.ts';

export interface StageDraft extends WorkflowStageSpec {
  rowId: number;
  otherRunners?: Partial<Record<StageRunner['kind'], StageRunner>>;
  argumentText?: Partial<Record<'command' | 'python', string>>;
}

export function currentRunner(stage: StageDraft) {
  const runner = stage.runner;
  if (runner?.kind !== 'command' && runner?.kind !== 'python') return runner;
  const text = stage.argumentText?.[runner.kind];
  if (text === undefined) return runner;
  const lines = text.replace(/\n+$/, '');
  return { ...runner, args: lines ? lines.split('\n') : [] };
}

export function supportsCache(mode: GraphSpec['mode'] | undefined, runner?: StageRunner) {
  return Boolean(mode) && runner?.kind !== 'human' && runner?.kind !== 'http';
}

export function stageForSave(
  stage: StageDraft,
  mode: GraphSpec['mode'] | undefined,
  converting: boolean,
): WorkflowStageSpec {
  const { rowId: _id, otherRunners: _runners, argumentText: _text, ...spec } = stage;
  if (!supportsCache(mode, spec.runner) && (spec.cache?.enabled || spec.cache?.revision))
    spec.cache = { enabled: false, revision: '' };
  if (!mode && converting)
    return { ...spec, runner: undefined, dependsOn: undefined, map: null, contracts: undefined };
  return {
    ...spec,
    runner: currentRunner(stage),
    dependsOn: mode === 'sequential' && converting ? undefined : spec.dependsOn,
  };
}

export function runnerChange(stage: StageDraft, next: StageRunner): Partial<StageDraft> {
  const current = currentRunner(stage) ?? { kind: 'ai', engine: 'worker' };
  if (current.kind === next.kind) return { runner: next };
  const alternatives = { ...stage.otherRunners };
  const runner = alternatives[next.kind] ?? next;
  delete alternatives[next.kind];
  if (current.kind !== 'ai' || current.engine !== 'worker') alternatives[current.kind] = current;
  return { runner, otherRunners: alternatives };
}

const runnerSettingsJa: Record<StageRunner['kind'], string> = {
  ai: 'AIエンジン指定',
  command: 'コマンドと引数',
  python: 'Pythonコードと引数',
  http: 'HTTP接続設定',
  human: '人間確認',
};

const runnerSettingsEn: Record<StageRunner['kind'], string> = {
  ai: 'AI engine setting',
  command: 'Command & arguments',
  python: 'Python code & arguments',
  http: 'HTTP request config',
  human: 'Human checkpoint',
};

export function settingsLostOnSave(
  stages: StageDraft[],
  graph: GraphSpec | undefined,
  otherGraphs: Partial<Record<GraphSpec['mode'], GraphSpec>>,
  runtime: RuntimeProfile,
  locale: Locale = 'ja',
) {
  const isEn = locale === 'en';
  const runnerSettings = isEn ? runnerSettingsEn : runnerSettingsJa;
  const sep = isEn ? ', ' : '、';
  const colon = isEn ? ': ' : '：';
  const losses: string[] = [];
  const converting = Object.keys(otherGraphs).length > 0;
  for (const stage of stages) {
    const fields = Object.values(stage.otherRunners ?? {}).map(
      (runner) => runnerSettings[runner.kind],
    );
    if (!graph && converting) {
      const runner = currentRunner(stage);
      if (runner && (runner.kind !== 'ai' || runner.engine !== 'worker'))
        fields.push(runnerSettings[runner.kind]);
      if (stage.map) fields.push(isEn ? 'Per-file map' : 'ファイルごとの実行');
      if (stage.contracts?.inputs.length || stage.contracts?.outputs.length)
        fields.push(isEn ? 'I/O contracts' : '入出力契約');
    }
    if (converting && graph?.mode !== 'dag' && stage.dependsOn?.length)
      fields.push(isEn ? 'DAG dependencies' : 'DAG依存関係');
    if (
      !supportsCache(graph?.mode, stage.runner) &&
      (stage.cache?.enabled || stage.cache?.revision)
    )
      fields.push(
        stage.cache.revision
          ? isEn
            ? `Result cache (rev ${stage.cache.revision})`
            : `結果キャッシュ（版 ${stage.cache.revision}）`
          : isEn
            ? 'Result cache'
            : '結果キャッシュ',
      );
    if (fields.length) losses.push(`${stage.label || stage.key}${colon}${fields.join(sep)}`);
  }
  const graphLosses = Object.values(otherGraphs)
    .filter(
      (other) =>
        !graph ||
        graph.publishStage !== other.publishStage ||
        graph.maxParallelTasks !== other.maxParallelTasks,
    )
    .map((other) =>
      isEn
        ? `${other.mode === 'dag' ? 'DAG' : 'Sequential'} publish stage (${other.publishStage}) & parallelism (${other.maxParallelTasks})`
        : `${other.mode === 'dag' ? 'DAG' : '順次接続'}の公開工程（${other.publishStage}）・並列数（${other.maxParallelTasks}）`,
    );
  if (!graph) {
    const fields = [
      runtime.revision && (isEn ? 'Runtime revision' : '環境の版'),
      runtime.python && (isEn ? 'Python executable' : 'Python実行ファイル'),
      Object.values(runtime.expected).some(Boolean) &&
        (isEn ? 'Required versions' : '要求バージョン'),
      Object.keys(runtime.packages).length > 0 && (isEn ? 'Pinned packages' : '固定パッケージ'),
    ].filter(Boolean);
    if (fields.length)
      graphLosses.push(
        `${isEn ? 'Project runtime' : 'プロジェクトの実行環境'}${colon}${fields.join(sep)}`,
      );
  }
  if (!losses.length && !graphLosses.length) return '';
  const header = isEn
    ? `Settings discarded on save (${losses.length} stage(s) affected)`
    : `保存時に破棄する設定（対象 ${losses.length} 工程）`;
  return [header, ...losses, ...graphLosses].join('\n');
}
