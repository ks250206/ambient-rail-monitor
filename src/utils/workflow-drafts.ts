import type { GraphSpec, StageRunner } from '../../shared/graph.ts';
import type { WorkflowStageSpec } from '../../shared/types.ts';

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

export function stageForSave(
  stage: StageDraft,
  mode: GraphSpec['mode'] | undefined,
  converting: boolean,
): WorkflowStageSpec {
  const { rowId: _id, otherRunners: _runners, argumentText: _text, ...spec } = stage;
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

const runnerSettings: Record<StageRunner['kind'], string> = {
  ai: 'AIエンジン指定',
  command: 'コマンドと引数',
  python: 'Pythonコードと引数',
  http: 'HTTP接続設定',
  human: '人間確認',
};

export function settingsLostOnSave(
  stages: StageDraft[],
  graph: GraphSpec | undefined,
  otherGraphs: Partial<Record<GraphSpec['mode'], GraphSpec>>,
) {
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
      if (stage.map) fields.push('ファイルごとの実行');
      if (stage.contracts?.inputs.length || stage.contracts?.outputs.length)
        fields.push('入出力契約');
    }
    if (converting && graph?.mode !== 'dag' && stage.dependsOn?.length) fields.push('DAG依存関係');
    if (fields.length) losses.push(`${stage.label || stage.key}：${fields.join('、')}`);
  }
  const graphLosses = Object.values(otherGraphs)
    .filter(
      (other) =>
        !graph ||
        graph.publishStage !== other.publishStage ||
        graph.maxParallelTasks !== other.maxParallelTasks,
    )
    .map(
      (other) =>
        `${other.mode === 'dag' ? 'DAG' : '順次接続'}の公開工程（${other.publishStage}）・並列数（${other.maxParallelTasks}）`,
    );
  if (!losses.length && !graphLosses.length) return '';
  return [`保存時に破棄する設定（対象 ${losses.length} 工程）`, ...losses, ...graphLosses].join(
    '\n',
  );
}
