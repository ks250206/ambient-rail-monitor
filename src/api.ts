import { QueryClient, useQuery } from '@tanstack/react-query';
import { useState, useRef, useSyncExternalStore } from 'react';

import type { ProjectSpec } from '../shared/types.ts';

export const queryClient = new QueryClient();
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result as T;
}

export function jsonRequest(method: string, data: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => request<{ projects: ProjectSpec[] }>('/api/projects', { signal }),
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
    if (!change.sequence) void queryClient.invalidateQueries({ queryKey: ['projects'] });
    // A removed project may have been the one currently selected.
    void queryClient.invalidateQueries({
      queryKey: ['monitor', change.projectId ?? change.deletedProjectId],
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
