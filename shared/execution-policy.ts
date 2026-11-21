export type FailureKind =
  | 'execution_error'
  | 'timeout'
  | 'acceptance_failed'
  | 'stage_timeout'
  | 'job_timeout'
  | 'interrupted';

export type RetryableFailure = Extract<
  FailureKind,
  'execution_error' | 'timeout' | 'acceptance_failed'
>;

export interface ExecutionPolicy {
  /** Additional attempts, excluding the initial execution. */
  maxRetries: number;
  attemptTimeoutMs: number;
  stageTimeoutMs: number;
  retryDelayMs: number;
  backoff: 'fixed' | 'exponential';
  retryOn: RetryableFailure[];
  onFailure: 'stop' | 'review';
}

export const DEFAULT_EXECUTION: ExecutionPolicy = {
  maxRetries: 1,
  attemptTimeoutMs: 25 * 60_000,
  stageTimeoutMs: 0,
  retryDelayMs: 500,
  backoff: 'fixed',
  retryOn: ['execution_error', 'timeout', 'acceptance_failed'],
  onFailure: 'stop',
};

export const MAX_BUDGET_MS = 7 * 24 * 60 * 60_000;
export const RETRY_LABELS: Record<RetryableFailure, string> = {
  execution_error: 'エージェント実行エラー',
  timeout: '1回の実行タイムアウト',
  acceptance_failed: '受け入れ条件の不合格',
};

export function boundedInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name}: 0〜${max} の整数を指定してください。`);
  }
  return value;
}

export function parseExecution(value: unknown, partial = false): Partial<ExecutionPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('実行設定はオブジェクトで指定してください。');
  }
  const raw = value as Record<string, unknown>;
  const result: Partial<ExecutionPolicy> = partial ? {} : structuredClone(DEFAULT_EXECUTION);
  const limits = {
    maxRetries: 10,
    attemptTimeoutMs: MAX_BUDGET_MS,
    stageTimeoutMs: MAX_BUDGET_MS,
    retryDelayMs: 3_600_000,
  } as const;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULT_EXECUTION, key)) throw new Error(`不明な実行設定: ${key}`);
  }
  for (const [key, max] of Object.entries(limits)) {
    if (raw[key] !== undefined)
      result[key as keyof typeof limits] = boundedInteger(raw[key], key, max);
  }
  if (raw.backoff !== undefined) {
    if (raw.backoff !== 'fixed' && raw.backoff !== 'exponential')
      throw new Error('不明なリトライ間隔です。');
    result.backoff = raw.backoff;
  }
  if (raw.onFailure !== undefined) {
    if (raw.onFailure !== 'stop' && raw.onFailure !== 'review')
      throw new Error('不明な失敗時の処理です。');
    result.onFailure = raw.onFailure;
  }
  if (raw.retryOn !== undefined) {
    if (
      !Array.isArray(raw.retryOn) ||
      raw.retryOn.some((kind) => typeof kind !== 'string' || !Object.hasOwn(RETRY_LABELS, kind))
    ) {
      throw new Error('不明なリトライ対象です。');
    }
    result.retryOn = [...new Set(raw.retryOn)] as RetryableFailure[];
  }
  return result;
}

export function resolveExecution(
  project?: Partial<ExecutionPolicy>,
  stage?: Partial<ExecutionPolicy>,
): ExecutionPolicy {
  return { ...DEFAULT_EXECUTION, ...project, ...stage };
}

export function retryDelay(policy: ExecutionPolicy, completedAttempts: number): number {
  return Math.min(
    3_600_000,
    policy.retryDelayMs *
      (policy.backoff === 'exponential' ? 2 ** Math.max(0, completedAttempts - 1) : 1),
  );
}

export function canRetry(
  policy: ExecutionPolicy,
  kind: FailureKind,
  completedAttempts: number,
): boolean {
  return (
    completedAttempts <= policy.maxRetries && policy.retryOn.includes(kind as RetryableFailure)
  );
}

export function remainingBudget(limit: number, used: number): number {
  return limit === 0 ? Infinity : Math.max(0, limit - used);
}
