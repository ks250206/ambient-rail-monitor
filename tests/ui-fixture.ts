import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vite-plus/test';
import type { JobStatus, ProjectSpec, WorkflowJob } from '../shared/types.ts';

export const project: ProjectSpec = {
  id: 'test',
  name: '測定',
  purpose: '',
  acceptanceCriteria: '',
  llm: { model: '', effort: '' },
  stages: [],
  inboxDir: 'inbox',
  artifactsDir: 'artifacts',
  createdAt: '',
  updatedAt: '',
};

export function job(status: JobStatus, id: string = status): WorkflowJob {
  return {
    id,
    projectId: project.id,
    file: '測定.csv',
    status,
    bytes: 0,
    hash: '',
    createdAt: '',
    demo: false,
    needsReview: false,
    agent: null,
    worker: null,
    startedAt: null,
    finishedAt: null,
    stages: [],
    artifacts: [],
    events: [],
    reviewApproved: false,
    lastMessage: '',
  };
}

let root: Root;
export let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export function render(element: ReactElement) {
  return act(async () => root.render(h(QueryClientProvider, { client }, element)));
}
export function button(label: string) {
  const result = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  );
  if (!result) throw new Error('Missing button: ' + label);
  return result;
}
export function enter(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  text: string,
) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, text);
    input.dispatchEvent(
      new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });
}
