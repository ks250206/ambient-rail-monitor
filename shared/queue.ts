import { boundedInteger } from './execution-policy.ts';

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

export function parseQueue(value: unknown): QueueSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('キュー設定が不正です。');
  const raw = value as Record<string, unknown>;
  const maxConcurrentJobs = boundedInteger(raw.maxConcurrentJobs, '同時ジョブ数', 32);
  const maxJobsPerWorker = boundedInteger(raw.maxJobsPerWorker, 'ワーカーあたりのジョブ数', 16);
  if (maxConcurrentJobs < 1 || maxJobsPerWorker < 1)
    throw new Error('同時実行数は1以上にしてください。');
  return {
    maxConcurrentJobs,
    maxJobsPerWorker,
    maxRecoveries: boundedInteger(raw.maxRecoveries, '自動復旧回数', 20),
  };
}

export function parsePriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -100 || value > 100)
    throw new Error('優先度は-100〜100の整数にしてください。');
  return value;
}
