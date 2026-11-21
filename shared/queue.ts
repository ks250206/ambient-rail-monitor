export interface QueueSettings {
  maxConcurrentJobs: number;
  maxJobsPerWorker: number;
  maxRecoveries: number;
}

export const DEFAULT_QUEUE: QueueSettings = {
  maxConcurrentJobs: 4,
  maxJobsPerWorker: 2,
  maxRecoveries: 3,
};

export const QUEUE_LIMITS = {
  maxConcurrentJobs: { min: 1, max: 32 },
  maxJobsPerWorker: { min: 1, max: 16 },
  maxRecoveries: { min: 0, max: 20 },
  priority: { min: -100, max: 100 },
} as const;
export type QueueField = keyof typeof QUEUE_LIMITS;

export function queueRange(field: QueueField): string {
  const { min, max } = QUEUE_LIMITS[field];
  return `${min}〜${max}`;
}

export function validQueueValue(field: QueueField, value: unknown): value is number {
  const { min, max } = QUEUE_LIMITS[field];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseQueueValue(field: QueueField, value: unknown, label: string): number {
  if (!validQueueValue(field, value))
    throw new Error(`${label}は${queueRange(field)}の整数にしてください。`);
  return value;
}

export function parseQueue(value: unknown): QueueSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('キュー設定が不正です。');
  const raw = value as Record<string, unknown>;
  return {
    maxConcurrentJobs: parseQueueValue('maxConcurrentJobs', raw.maxConcurrentJobs, '同時ジョブ数'),
    maxJobsPerWorker: parseQueueValue(
      'maxJobsPerWorker',
      raw.maxJobsPerWorker,
      'ワーカーあたりのジョブ数',
    ),
    maxRecoveries: parseQueueValue('maxRecoveries', raw.maxRecoveries, '自動復旧回数'),
  };
}

export function parsePriority(value: unknown): number {
  return parseQueueValue('priority', value, '優先度');
}
