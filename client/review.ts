import { validRelativePath } from '../shared/conditions.ts';
import type { BytesResponse, RailflowHttpClient } from './http.ts';
import { RailflowError, type FileHead, type ReviewRef } from './types.ts';

export interface ReviewInspection {
  ref: ReviewRef;
  receipt: string | null;
  failureKind: string | null;
  summary: string | null;
  files: FileHead[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFileHead(value: unknown): value is FileHead {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    validRelativePath(value.path) &&
    nonNegativeInteger(value.bytes)
  );
}

function assertReviewRef(ref: ReviewRef, operation: string): void {
  if (
    !ref ||
    !nonEmptyString(ref.jobId) ||
    !nonEmptyString(ref.stageKey) ||
    !nonNegativeInteger(ref.attempt) ||
    ref.attempt === 0 ||
    !nonNegativeInteger(ref.reviewSequence) ||
    ref.reviewSequence === 0
  )
    throw new RailflowError({
      kind: 'usage',
      operation,
      message: 'Invalid exact review reference',
    });
}

export function createReviewOperations(client: RailflowHttpClient) {
  async function inspectReview(
    jobId: string,
    stageKey: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ReviewInspection> {
    const context = { operation: 'review.inspect', jobId };
    if (!nonEmptyString(jobId) || !nonEmptyString(stageKey))
      throw new RailflowError({ ...context, kind: 'usage', message: 'Job and stage are required' });
    return client.json(
      'GET',
      `/api/jobs/${encodeURIComponent(jobId)}/review?task=${encodeURIComponent(stageKey)}`,
      undefined,
      {
        ...context,
        signal,
        validate(value) {
          const {
            stageKey: actualStage,
            attempt,
            reviewSequence,
            files,
            failureKind,
            summary,
            receipt = null,
          } = isRecord(value) ? value : {};
          if (actualStage !== stageKey)
            throw new RailflowError({
              ...context,
              kind: 'protocol',
              message: 'Review response did not match the requested stage',
            });
          if (
            !nonNegativeInteger(attempt) ||
            !nonNegativeInteger(reviewSequence) ||
            (receipt !== null &&
              (!nonEmptyString(receipt) || attempt === 0 || reviewSequence === 0)) ||
            (failureKind !== null && !nonEmptyString(failureKind)) ||
            (summary !== null && typeof summary !== 'string') ||
            !Array.isArray(files) ||
            !files.every(isFileHead)
          )
            throw new RailflowError({
              ...context,
              kind: 'protocol',
              message: 'Invalid review inspection response',
            });
          return {
            ref: { jobId, stageKey, attempt, reviewSequence },
            receipt,
            failureKind,
            summary,
            files: files.map(({ path, bytes }) => ({ path, bytes })),
          };
        },
      },
    );
  }

  async function openReviewFile(
    ref: ReviewRef,
    relPath: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<BytesResponse> {
    const operation = 'review.open_file';
    assertReviewRef(ref, operation);
    const { jobId, stageKey, attempt, reviewSequence } = ref;
    if (typeof relPath !== 'string' || !validRelativePath(relPath))
      throw new RailflowError({
        kind: 'usage',
        operation,
        jobId,
        message: 'Invalid relative review file path',
      });
    const current = await inspectReview(jobId, stageKey, { signal });
    if (current.ref.attempt !== attempt || current.ref.reviewSequence !== reviewSequence)
      throw new RailflowError({
        kind: 'http',
        status: 409,
        operation,
        jobId,
        message: 'The review target has changed',
      });
    return client.openBytes(
      `/api/jobs/${encodeURIComponent(jobId)}/review/file?task=${encodeURIComponent(stageKey)}&sequence=${reviewSequence}&path=${encodeURIComponent(relPath)}`,
      { operation, signal },
    );
  }

  async function approveExact(
    ref: ReviewRef,
    receipt: string,
    exception: boolean,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<{ ok: true; ref: ReviewRef; exception: boolean }> {
    const operation = 'review.approve_exact';
    assertReviewRef(ref, operation);
    const { jobId, stageKey, attempt, reviewSequence } = ref;
    if (!nonEmptyString(receipt) || typeof exception !== 'boolean')
      throw new RailflowError({
        kind: 'usage',
        operation,
        jobId,
        message: 'A review receipt and boolean exception flag are required',
      });
    return client.json(
      'POST',
      `/api/jobs/${encodeURIComponent(jobId)}/approve-exact`,
      { stage: stageKey, attempt, reviewSequence, receipt, exception },
      {
        signal,
        operation,
        jobId,
        mutating: true,
        validate(value) {
          if (
            !isRecord(value) ||
            value.ok !== true ||
            value.stageKey !== stageKey ||
            value.attempt !== attempt ||
            value.reviewSequence !== reviewSequence ||
            value.exception !== exception
          )
            throw new RailflowError({
              kind: 'protocol',
              operation,
              jobId,
              message: 'Approval response did not match the requested review target',
            });
          return { ok: true, ref: { jobId, stageKey, attempt, reviewSequence }, exception };
        },
      },
    );
  }

  return { inspectReview, openReviewFile, approveExact };
}
