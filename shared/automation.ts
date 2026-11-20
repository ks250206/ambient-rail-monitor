import { parseRuntime, parsePricing, parseCache } from './reuse.ts';
import { parseCondition } from './conditions.ts';
import { parsePriority, parseQueueValue } from './queue.ts';
import {
  boundedInteger,
  MAX_BUDGET_MS,
  parseExecution,
  resolveExecution,
} from './execution-policy.ts';
import type { GateSpec, InputSpec, ProjectSpec, WorkflowStageSpec } from './types.ts';

export const DEFAULT_INPUT: InputSpec = { mode: 'auto', settleMs: 1500, condition: null };
export const EMPTY_GATE: GateSpec = { condition: null, requireReview: false };

export function parseGate(value: unknown): GateSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('受け入れ条件の形式が不正です。');
  const raw = value as Record<string, unknown>;
  if (raw.requireReview !== undefined && typeof raw.requireReview !== 'boolean')
    throw new Error('レビュー設定は真偽値で指定してください。');
  return {
    condition: parseCondition(raw.condition, 'gate'),
    requireReview: raw.requireReview === true,
  };
}

export function parseInput(value: unknown): InputSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('入力設定の形式が不正です。');
  const raw = value as Record<string, unknown>;
  const mode = raw.mode ?? DEFAULT_INPUT.mode;
  if (mode !== 'auto' && mode !== 'file' && mode !== 'directory')
    throw new Error('不明な入力単位です。');
  return {
    mode,
    settleMs:
      raw.settleMs === undefined
        ? DEFAULT_INPUT.settleMs
        : boundedInteger(raw.settleMs, '変更が止まるまで待つ時間', 86400_000),
    condition: parseCondition(raw.condition, 'trigger'),
  };
}

export function projectAutomation(
  raw: Record<string, unknown>,
  existing?: ProjectSpec,
): Pick<
  ProjectSpec,
  'input' | 'execution' | 'jobTimeoutMs' | 'finalGate' | 'prompt' | 'queue' | 'runtime' | 'pricing'
> {
  const queue =
    raw.queue === undefined
      ? (existing?.queue ?? { maxConcurrentJobs: 4, priority: 0 })
      : raw.queue;
  if (!queue || typeof queue !== 'object' || Array.isArray(queue))
    throw new Error('プロジェクトのキュー設定が不正です。');
  const values = queue as Record<string, unknown>;
  const maxConcurrentJobs = parseQueueValue(
    'maxConcurrentJobs',
    values.maxConcurrentJobs,
    'プロジェクトの同時実行数',
  );
  return {
    runtime:
      raw.runtime === undefined
        ? structuredClone(existing?.runtime ?? parseRuntime(undefined))
        : parseRuntime(raw.runtime),
    pricing:
      raw.pricing === undefined
        ? structuredClone(existing?.pricing ?? [])
        : parsePricing(raw.pricing),
    queue: { maxConcurrentJobs, priority: parsePriority(values.priority) },
    input:
      raw.input === undefined
        ? structuredClone(existing?.input ?? DEFAULT_INPUT)
        : parseInput(raw.input),
    execution:
      raw.execution === undefined
        ? structuredClone(existing?.execution ?? resolveExecution())
        : resolveExecution(parseExecution(raw.execution)),
    jobTimeoutMs:
      raw.jobTimeoutMs === undefined
        ? (existing?.jobTimeoutMs ?? 0)
        : boundedInteger(raw.jobTimeoutMs, 'ジョブ全体の上限', MAX_BUDGET_MS),
    finalGate:
      raw.finalGate === undefined
        ? structuredClone(existing?.finalGate ?? EMPTY_GATE)
        : parseGate(raw.finalGate),
    prompt:
      raw.prompt === undefined
        ? (existing?.prompt ?? '')
        : readText(raw.prompt, '共通プロンプト', 8000),
  };
}

export function stageAutomation(
  raw: Record<string, unknown>,
): Pick<WorkflowStageSpec, 'acceptanceCriteria' | 'gate' | 'execution' | 'cache'> {
  return {
    cache: parseCache(raw.cache),
    acceptanceCriteria:
      raw.acceptanceCriteria === undefined
        ? ''
        : readText(raw.acceptanceCriteria, '工程の受け入れ要件', 4000),
    gate: raw.gate === undefined ? structuredClone(EMPTY_GATE) : parseGate(raw.gate),
    execution: raw.execution === undefined ? {} : parseExecution(raw.execution, true),
  };
}

function readText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`${name} は${max}文字以内で入力してください。`);
  return value;
}
