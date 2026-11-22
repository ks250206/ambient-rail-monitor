// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { expect, it, vi } from 'vite-plus/test';
import { evaluateCondition, type Condition, type ConditionFacts } from '../shared/conditions.ts';
import type { DryRunResult, ProjectSpec } from '../shared/types.ts';
import { WorkflowSpecSection } from '../src/components/WorkflowSpecSection.tsx';
import { setLocale } from '../src/i18n.ts';
import { button, client, enter, job, project, render } from './ui-fixture.ts';

const definition: ProjectSpec = {
  ...project,
  stages: [{ key: 'report', short: 'Report', label: 'Report', instruction: '', llm: project.llm }],
  graph: { mode: 'dag', publishStage: 'report', maxParallelTasks: 4 },
};
function source(id: string) {
  return {
    ...job('queued', id),
    dataset: {
      version: 1,
      name: 'frozen',
      kind: 'file',
      source: 'upload:test',
      bytes: 1,
      files: [{ path: 'data.csv', hash: 'h', bytes: 1 }],
      hash: 'h',
    },
  };
}
async function editor() {
  const save = vi.fn();
  client.setQueryData(['monitor', project.id], {
    jobs: [
      source('A'),
      source('B'),
      job('done', 'legacy'),
      { ...source('foreign'), projectId: 'other' },
    ],
    candidates: [],
  });
  await render(
    h(WorkflowSpecSection, {
      project: definition,
      saving: false,
      onDirtyChange: vi.fn(),
      onSave: save,
    }),
  );
  return save;
}
const facts: ConditionFacts = {
  name: 'run-A',
  quietMs: Infinity,
  files: [
    { path: 'summary.json', bytes: 12 },
    { path: 'bad.json', bytes: 1 },
  ],
  texts: { 'summary.json': { text: '{"score":42}' }, 'bad.json': { text: '{' } },
};

function evaluated(condition: Condition | null): DryRunResult['trigger'] {
  const result = evaluateCondition(condition, facts);
  return { status: result.status, message: result.message, evidence: { condition, result } };
}

function plan(
  sourceJobId: string,
  datasetHash: string,
  trigger: DryRunResult['trigger'],
): DryRunResult {
  return {
    sourceJobId,
    datasetHash,
    taskCount: 2,
    maxParallelTasks: 4,
    publishStage: 'report',
    reviewTaskKeys: ['scan_a'],
    tasks: [
      {
        key: 'scan_a',
        stageKey: 'scan',
        short: 'Scan',
        label: 'Scan / A/data.csv',
        dependsOn: [],
        item: { path: 'A/data.csv', hash: 'a' },
      },
      {
        key: 'report',
        stageKey: 'report',
        short: 'Report',
        label: 'Report',
        dependsOn: ['scan_a'],
      },
    ],
    runtimeRequirements: {
      revision: 'lab-env',
      python: '/venv/python',
      expected: { node: '26' },
      packages: { numpy: '2' },
    },
    trigger,
  };
}
const click = (el: HTMLElement) => act(async () => el.click());
const selectSource = (id: string) =>
  enter(document.querySelector<HTMLElement>('[role="combobox"][aria-label="入力元のジョブ"]')!, id);
const contents = () => document.querySelector('[aria-label="Dry Run の結果"]')?.textContent;
async function settle(callback: () => void) {
  await act(async () => {
    callback();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

it('sends the actual unsaved save payload for an explicitly selected input and discards obsolete requests, results, and errors', async () => {
  const pending: Array<(res: Response) => void> = [];
  const fetcher = vi.fn(
    (_url: string, _options: RequestInit) =>
      new Promise<Response>((resolve) => pending.push(resolve)),
  );
  vi.stubGlobal('fetch', fetcher);
  const save = await editor();
  expect(button('実行計画を確認').disabled).toBe(true);
  const select = document.querySelector<HTMLElement>(
    '[role="combobox"][aria-label="入力元のジョブ"]',
  )!;
  await click(select);
  expect(
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
      (item) => item.dataset.optionValue,
    ),
  ).toEqual(['A', 'B']);
  await click(document.querySelector<HTMLElement>('[data-option-value="A"]')!);
  const prompt = document.querySelector<HTMLTextAreaElement>('#workflow-prompt')!;
  await enter(prompt, 'unsaved instructions');
  await click(button('実行計画を確認'));
  expect(save).not.toHaveBeenCalled();
  await click(button('定義を保存'));
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/projects/test/dry-run');
  expect(init.method).toBe('POST');
  if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
  const sent = JSON.parse(init.body);
  expect(sent.draft.prompt).toBe('unsaved instructions');
  expect(sent).toEqual({
    sourceJobId: 'A',
    draft: JSON.parse(JSON.stringify(save.mock.calls[0][0])),
  });
  expect(init.signal?.aborted).toBe(false);
  await selectSource('B');
  expect(init.signal?.aborted).toBe(true);
  await click(button('実行計画を確認'));
  await settle(() =>
    pending[1](
      Response.json(
        plan('B', 'new-hash', evaluated({ op: 'file.exists', pattern: 'missing.csv' })),
      ),
    ),
  );
  expect(contents()).toContain('new-hash');
  await settle(() => pending[0](Response.json(plan('A', 'obsolete-hash', evaluated(null)))));
  expect(contents()).toContain('new-hash');
  expect(contents()).not.toContain('obsolete-hash');
  await enter(prompt, 'another draft');
  expect(contents()).toBeUndefined();
  await click(button('実行計画を確認'));
  await enter(prompt, 'final draft');
  expect(fetcher.mock.calls[2][1].signal?.aborted).toBe(true);
  await enter(prompt, 'another draft');
  await settle(() => pending[2](Response.json({ error: 'obsolete-error' }, { status: 409 })));
  expect(contents()).toBeUndefined();
  expect(document.body.textContent).not.toContain('obsolete-error');
  expect(button('実行計画を確認').disabled).toBe(false);
  await click(button('実行計画を確認'));
  await settle(() => pending[3](Response.json({ error: 'snapshot changed' }, { status: 409 })));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('snapshot changed');
  await selectSource('A');
  expect(document.body.textContent).not.toContain('snapshot changed');
});

it('explains how to enable the preview for an invalid draft with a selected source', async () => {
  await editor();
  const prompt = document.querySelector<HTMLTextAreaElement>('#workflow-prompt')!;
  await enter(prompt, '{{unknown_variable}}');
  expect(button('実行計画を確認').getAttribute('aria-describedby')).toBeNull();
  await selectSource('A');
  const preview = button('実行計画を確認');
  expect(preview.disabled).toBe(true);
  const guide = document.getElementById(preview.getAttribute('aria-describedby')!);
  expect(guide?.textContent).toContain('下書きのエラーを修正');
  await act(async () => setLocale('en'));
  expect(guide?.textContent).toContain('Fix the errors in the draft');
  await enter(prompt, 'valid prompt');
  expect(button('Preview task plan').disabled).toBe(false);
  expect(guide?.isConnected).toBe(false);
});

const score: Condition = {
  op: 'json.value',
  path: 'summary.json',
  field: 'score',
  compare: 'gte',
  value: 50,
};
it.each([
  [evaluated(null), 'Trigger passed', ['No additional trigger condition']],
  [
    evaluated({ op: 'file.exists', pattern: '*.csv' }),
    'Trigger not met',
    ['Files matching *.csv: 0'],
  ],
  [evaluated(score), 'Trigger not met', ['summary.json', 'score', 'expected ≥ 50', 'observed 42']],
  [
    evaluated({ ...score, path: 'bad.json' }),
    'Trigger evaluation error',
    ['bad.json is not valid JSON'],
  ],
  [
    evaluated({ ...score, path: 'missing.json' }),
    'Trigger evaluation error',
    ['File not found: missing.json'],
  ],
  [
    evaluated({ op: 'any', children: [score, { ...score, field: 'absent' }] }),
    'Trigger evaluation error',
    ['At least one', 'observed 42', 'JSON field not found: summary.json · absent'],
  ],
  [
    { status: 'unknown', message: '監視時の無変更時間は固定入力から復元できません。' },
    'Trigger unknown',
    ['quiet time was not recorded'],
  ],
] satisfies [DryRunResult['trigger'], string, string[]][])(
  'localizes the reason for $1 using frozen evidence',
  async (trigger, title, reasons) => {
    setLocale('en');
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await editor();
    await enter(document.querySelector<HTMLElement>('[aria-label="Source job"]')!, 'A');
    await click(button('Preview task plan'));
    await settle(() => finish(Response.json(plan('A', 'digest', trigger))));
    const result = document.querySelector('[aria-label="Dry run result"]')?.textContent;
    for (const label of [
      title,
      ...reasons,
      'Parallel limit 4',
      'Publish stage report',
      'Map items: 1',
      'A/data.csv',
      'Depends on · scan_a',
      'Review candidate',
      'lab-env',
      '/venv/python',
      'numpy == 2',
      'node = 26',
      'checked at runtime',
    ]) {
      expect(result).toContain(label);
    }
    const reason = document.querySelector('.condition-evidence')!;
    expect(reason.textContent).not.toMatch(/[ぁ-んァ-ヶ一-龠]/u);
    await act(async () => setLocale('ja'));
    expect(reason.textContent).toContain(trigger.message);
  },
);
