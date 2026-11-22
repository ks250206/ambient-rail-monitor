import { QueryClient, useQuery } from '@tanstack/react-query';
import { useState, useRef, useSyncExternalStore } from 'react';

import type { AppStateResponse, ProjectSpec } from '../shared/types.ts';
import type { ReviewInspection } from '../client/review.ts';
import { QC_FILENAME, QC_MAX_BYTES, parseQcV1Bytes } from '../shared/qc.ts';
import type { ConditionResult } from '../shared/conditions.ts';

export class ApiError extends Error {
  status: number;
  result?: ConditionResult;
  constructor(message: string, status: number, result?: ConditionResult) {
    super(message);
    this.status = status;
    this.result = result;
  }
}

export const queryClient = new QueryClient();
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.error || `HTTP ${response.status}`, response.status, result.result);
  return result as T;
}

export function jsonRequest(method: string, data: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

export type InspectedOutput = Omit<ReviewInspection, 'ref'> &
  Omit<ReviewInspection['ref'], 'jobId'>;

export type ReviewApproval = {
  jobId: string;
  stage: string;
  attempt: number;
  reviewSequence?: number;
} & (
  | { mode: 'exact'; receipt: string; reviewSequence: number; exception: boolean }
  | { mode: 'legacy' }
);

export function approveReviewedOutput({ jobId, mode, ...body }: ReviewApproval) {
  return request(
    `/api/jobs/${jobId}/${mode === 'exact' ? 'approve-exact' : 'approve'}`,
    jsonRequest('POST', body),
  );
}

export async function fetchReviewQc(
  jobId: string,
  task: string,
  sequence: number,
  size: number,
  signal: AbortSignal,
) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid qc.json size');
  const params = new URLSearchParams({ task, sequence: String(sequence), path: QC_FILENAME });
  const response = await fetch(`/api/jobs/${jobId}/review/file?${params}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const message =
      typeof result?.error === 'string' && result.error ? result.error : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  if (size > QC_MAX_BYTES) {
    await response.body?.cancel();
    throw new ApiError('qc.json exceeds 2 MiB', 422);
  }
  if (!response.body) throw new Error('Missing qc.json data');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > size) {
        await reader.cancel();
        throw new ApiError('qc.json size changed', 409);
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) throw new ApiError('qc.json size changed', 409);
  return parseQcV1Bytes(bytes);
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => request<{ projects: ProjectSpec[] }>('/api/projects', { signal }),
  });
}

export function useProjectJobs(projectId: string) {
  return useQuery({
    queryKey: ['monitor', projectId],
    queryFn: ({ signal }) =>
      request<AppStateResponse>(`/api/state?project=${encodeURIComponent(projectId)}`, { signal }),
  });
}

type Connection = 'connecting' | 'online' | 'reconnecting';
let connection: Connection = 'connecting';
function subscribeStream(notify: () => void) {
  const source = new EventSource('/api/stream');
  source.onopen = () => {
    connection = 'online';
    notify();
    void queryClient.invalidateQueries({ queryKey: ['monitor'] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  source.onmessage = (event) => {
    const change = JSON.parse(event.data);
    if (!change.sequence && !change.inputsUpdated && !change.queueUpdated)
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    const targetProject = change.projectId ?? change.deletedProjectId;
    // Queue settings and lease claims/releases (queueUpdated) affect every monitor view.
    void queryClient.invalidateQueries({
      queryKey: change.queueUpdated || !targetProject ? ['monitor'] : ['monitor', targetProject],
    });
  };
  source.onerror = () => {
    connection = 'reconnecting';
    notify();
  };
  return () => {
    source.close();
    connection = 'connecting';
  };
}
export function useConnection() {
  return useSyncExternalStore(subscribeStream, () => connection);
}

let now = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: number | undefined;
function subscribeClock(notify: () => void) {
  clockListeners.add(notify);
  if (clockListeners.size === 1) {
    now = Date.now();
    clockTimer = window.setInterval(() => {
      now = Date.now();
      for (const listener of clockListeners) listener();
    }, 1000);
  }
  return () => {
    clockListeners.delete(notify);
    if (!clockListeners.size) clearInterval(clockTimer);
  };
}
export function useClock() {
  return useSyncExternalStore(subscribeClock, () => now);
}

export function useToast() {
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  function showToast(text: string, error = false) {
    clearTimeout(timer.current);
    setToast({ text, error });
    timer.current = window.setTimeout(() => setToast(null), 3900);
  }
  return { toast, showToast };
}
