import { boundedInteger } from './execution-policy.ts';
import { validRelativePath } from './conditions.ts';
import { parseContracts, type FileContract } from './contracts.ts';
import type { ProjectSpec, WorkflowStageSpec, WorkflowJob, JobStage } from './types.ts';

export type StageRunner =
  | { kind: 'ai'; engine: 'worker' | 'codex' | 'claude' }
  | { kind: 'command'; program: string; args: string[] }
  | { kind: 'python'; code: string; args: string[] }
  | {
      kind: 'http';
      method: 'GET' | 'POST';
      url: string;
      body: string;
      output: string;
      successStatus: number;
      idempotencyKey: boolean;
    }
  | { kind: 'human' };

export interface GraphSpec {
  mode: 'sequential' | 'dag';
  maxParallelTasks: number;
  publishStage: string;
}
export interface StageGraph {
  runner?: StageRunner;
  dependsOn?: string[];
  map?: { pattern: string; maxItems: number; isolateInput?: boolean } | null;
  contracts?: { inputs: FileContract[]; outputs: FileContract[] };
}
export interface PlannedTask {
  key: string;
  stageKey: string;
  label: string;
  short: string;
  dependsOn: string[];
  item?: { path: string; hash: string };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('設定はオブジェクトで指定してください。');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 8000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error(`${label}は${max}文字以内の文字列にしてください。`);
  return value;
}
const strings = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`項目数は${max}件以内にしてください。`);
  return value.map((item) => text(item, '項目', 2000));
};

export function parseStageGraph(raw: Record<string, unknown>): StageGraph {
  const runner = object(raw.runner ?? { kind: 'ai', engine: 'worker' });
  let parsed: StageRunner;
  switch (runner.kind) {
    case 'ai':
      if (
        runner.engine !== undefined &&
        (typeof runner.engine !== 'string' ||
          !['worker', 'codex', 'claude'].includes(runner.engine))
      )
        throw new Error('不明なAIエンジンです。');
      parsed = { kind: 'ai', engine: (runner.engine ?? 'worker') as 'worker' | 'codex' | 'claude' };
      break;
    case 'command': {
      const program = text(runner.program, '実行プログラム', 512).trim();
      if (!program) throw new Error('実行プログラムを指定してください。');
      parsed = { kind: 'command', program, args: strings(runner.args ?? [], 64) };
      break;
    }
    case 'python':
      parsed = {
        kind: 'python',
        code: text(runner.code, 'Pythonコード', 32_000),
        args: strings(runner.args ?? [], 64),
      };
      break;
    case 'http': {
      const url = text(runner.url, 'HTTP URL', 2000);
      const parsedUrl = new URL(url);
      if (
        !['http:', 'https:'].includes(parsedUrl.protocol) ||
        parsedUrl.username ||
        parsedUrl.password
      )
        throw new Error('認証情報を含まないHTTP(S) URLを指定してください。');
      if (runner.method !== 'GET' && runner.method !== 'POST')
        throw new Error('HTTPはGETまたはPOSTです。');
      const output = text(runner.output ?? 'response.json', 'レスポンス保存先', 512);
      if (
        !validRelativePath(output) ||
        output === '_inputs' ||
        output === '_railflow' ||
        output.startsWith('_inputs/') ||
        output.startsWith('_railflow/')
      )
        throw new Error('出力先の相対パスが不正です。');
      const successStatus = boundedInteger(runner.successStatus ?? 200, 'HTTP成功ステータス', 299);
      if (successStatus < 200) throw new Error('成功ステータスは200〜299です。');
      parsed = {
        kind: 'http',
        method: runner.method,
        url,
        body: text(runner.body ?? '', 'リクエスト本文', 32_000),
        output,
        successStatus,
        idempotencyKey: runner.idempotencyKey === true,
      };
      break;
    }
    case 'human':
      parsed = { kind: 'human' };
      break;
    default:
      throw new Error('不明な工程の種類です。');
  }
  const dependsOn = raw.dependsOn === undefined ? undefined : strings(raw.dependsOn, 50);
  if (dependsOn && new Set(dependsOn).size !== dependsOn.length)
    throw new Error('依存先が重複しています。');
  let map: StageGraph['map'] = null;
  if (raw.map != null) {
    const value = object(raw.map);
    const pattern = text(value.pattern, 'ファイルパターン', 512);
    if (!validRelativePath(pattern, true)) throw new Error('mapのパターンが不正です。');
    const maxItems = boundedInteger(value.maxItems ?? 100, 'mapの最大件数', 128);
    if (!maxItems) throw new Error('mapの最大件数は1以上です。');
    if (value.isolateInput !== undefined && typeof value.isolateInput !== 'boolean')
      throw new Error('入力の分離は真偽値で指定してください。');
    map = { pattern, maxItems, isolateInput: value.isolateInput === true };
  }
  const contracts = raw.contracts === undefined ? {} : object(raw.contracts);
  return {
    runner: parsed,
    dependsOn,
    map,
    contracts: {
      inputs: parseContracts(contracts.inputs, 'inputs'),
      outputs: parseContracts(contracts.outputs, 'outputs'),
    },
  };
}

export function dependencies(
  project: Pick<ProjectSpec, 'stages' | 'graph'>,
  stage: WorkflowStageSpec,
): string[] {
  if (project.graph?.mode === 'dag') return stage.dependsOn ?? [];
  const index = project.stages.findIndex((s) => s.key === stage.key);
  return index > 0 ? [project.stages[index - 1].key] : [];
}

export class GraphStageError extends Error {
  readonly key: string;
  readonly field: 'key' | 'dependencies' | 'runner';
  constructor(key: string, field: GraphStageError['field'], message: string) {
    super(message);
    this.key = key;
    this.field = field;
  }
}

export function parseGraph(raw: unknown, stages: WorkflowStageSpec[]): GraphSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = object(raw);
  if (value.mode !== 'sequential' && value.mode !== 'dag') throw new Error('不明な実行順序です。');
  const maxParallelTasks = boundedInteger(value.maxParallelTasks ?? 2, '工程の同時実行数', 8);
  if (!maxParallelTasks) throw new Error('工程の同時実行数は1以上です。');
  const graph: GraphSpec = {
    mode: value.mode,
    maxParallelTasks,
    publishStage: text(value.publishStage ?? stages.at(-1)!.key, '公開工程', 48),
  };
  const keys = new Set(stages.map((s) => s.key));
  const invalidKey = stages.find(
    (stage, i) =>
      !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(stage.key) ||
      stage.key.includes('__') ||
      stages.slice(0, i).some((other) => other.key === stage.key),
  );
  if (invalidKey)
    throw new GraphStageError(
      invalidKey.key,
      'key',
      '工程キーは重複しない英小文字・数字・ハイフン・単一アンダースコアで指定してください。',
    );
  const project = { stages, graph };
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, parent = key) => {
    if (!keys.has(key))
      throw new GraphStageError(parent, 'dependencies', `依存工程が見つかりません: ${key}`);
    if (visiting.has(key))
      throw new GraphStageError(parent, 'dependencies', '工程の依存関係が循環しています。');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies(
      project,
      stages.find((s) => s.key === key)!,
    ))
      visit(dependency, key);
    visiting.delete(key);
    visited.add(key);
  };
  for (const stage of stages) visit(stage.key);
  const publish = stages.find((s) => s.key === graph.publishStage);
  if (!publish || publish.map || publish.runner?.kind === 'human')
    throw new Error(
      '公開工程はmap・人間確認以外の1つの工程を指定してください。人間確認は公開ゲートで設定できます。',
    );
  visited.clear();
  visit(publish.key);
  if (visited.size !== stages.length)
    throw new GraphStageError(
      publish.key,
      'dependencies',
      '公開工程が全工程の結果を受け取るように依存関係を接続してください。',
    );
  for (const stage of stages) {
    if (
      stage.runner?.kind === 'http' &&
      stage.runner.method === 'POST' &&
      !stage.runner.idempotencyKey
    )
      throw new GraphStageError(
        stage.key,
        'runner',
        'HTTP POSTをリトライする場合はIdempotency-Keyを有効にしてください。',
      );
  }
  return graph;
}

export function taskSpec(project: ProjectSpec, task: JobStage): WorkflowStageSpec {
  const spec = project.stages.find((stage) => stage.key === (task.stageKey ?? task.key));
  if (!spec) throw new Error(`工程の定義がありません: ${task.key}`);
  return spec;
}
export function readyTask(job: WorkflowJob, task: JobStage): boolean {
  return (
    ['pending', 'retry'].includes(task.status) &&
    (task.dependsOn ?? []).every(
      (key) => job.stages.find((s) => s.key === key)?.status === 'success',
    )
  );
}
export function downstream(
  tasks: Pick<PlannedTask, 'key' | 'dependsOn'>[],
  selected: string,
): Set<string> {
  const affected = new Set([selected]);
  for (let changed = true; changed;) {
    changed = false;
    for (const task of tasks)
      if (!affected.has(task.key) && task.dependsOn.some((key) => affected.has(key))) {
        affected.add(task.key);
        changed = true;
      }
  }
  return affected;
}
