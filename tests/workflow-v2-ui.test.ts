// @vitest-environment happy-dom
import { act, createElement as h, useState } from 'react';
import { expect, it, vi } from 'vite-plus/test';
import type { JobStage, ProjectSpec, WorkflowStageSpec } from '../shared/types.ts';
import {
  WorkflowSpecSection,
  type WorkflowUpdatePayload,
} from '../src/components/WorkflowSpecSection.tsx';
import { ActionsSection } from '../src/components/ActionsSection.tsx';
import { JobsPage } from '../src/JobsPage.tsx';
import { button, client, enter, job, project, render } from './ui-fixture.ts';

function spec(key: string, patch: Partial<WorkflowStageSpec> = {}): WorkflowStageSpec {
  return { key, label: key, short: key, llm: project.llm, instruction: '', ...patch };
}
function workflow(stages: WorkflowStageSpec[]): ProjectSpec {
  return {
    ...project,
    updatedAt: '2026-01-01T00:00:00Z',
    stages,
    graph: { mode: 'dag', maxParallelTasks: 3, publishStage: stages.at(-1)!.key },
  };
}
function field(label: string) {
  const target = [...document.querySelectorAll('label')]
    .find((item) => item.firstChild?.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
      'input,textarea,button[role="combobox"]',
    );
  if (!target) throw new Error('Field not found: ' + label);
  return target;
}
async function editor(definition: ProjectSpec) {
  const save =
    vi.fn<
      (value: WorkflowUpdatePayload, timestamp: string, done: (p: ProjectSpec) => void) => void
    >();
  client.setQueryData(['monitor', project.id], { candidates: [] });
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
const click = (el: HTMLElement) => act(async () => el.click());

it.each(['command', 'python'] as const)(
  'retains the newline and saves both %s arguments',
  async (kind) => {
    const runner =
      kind === 'command'
        ? { kind, program: 'test', args: [] }
        : { kind, code: 'print(1)', args: [] };
    const save = await editor(workflow([spec('main', { runner })]));
    const args = field('引数（1行で1つ）');
    await enter(args, 'one\n');
    expect(args.value).toBe('one\n');
    await enter(args, args.value + 'two');
    await click(button('定義を保存'));
    expect(save.mock.calls[0][0].stages[0].runner).toMatchObject({ args: ['one', 'two'] });
  },
);

it('restores runner and mode drafts across stages and confirms the precise loss on legacy save', async () => {
  const first = spec('prep', {
    runner: { kind: 'python', code: 'original', args: [] },
    dependsOn: [],
    map: { pattern: '*.csv', maxItems: 4 },
    contracts: { inputs: [], outputs: [{ pattern: '*.json', minFiles: 1, maxFiles: 3 }] },
  });
  const save = await editor(
    workflow([
      first,
      spec('independent', { dependsOn: [] }),
      spec('publish', { dependsOn: ['prep', 'independent'] }),
    ]),
  );
  await enter(field('Pythonコード'), 'edited code');
  await enter(field('工程の種類'), 'command');
  await enter(field('実行プログラム'), 'my-tool');
  await enter(field('引数（1行で1つ）'), 'arg1\narg2');
  await enter(field('実行モデル'), 'sequential');
  await enter(field('同時実行するタスク数'), '7');
  await enter(field('実行モデル'), 'legacy');
  await enter(field('編集する工程'), '1');
  await enter(field('編集する工程'), '0');
  await enter(field('実行モデル'), 'dag');
  expect(field('同時実行するタスク数').value).toBe('3');
  expect(field('実行プログラム').value).toBe('my-tool');
  await enter(field('工程の種類'), 'python');
  expect(field('Pythonコード').value).toBe('edited code');
  await enter(field('実行モデル'), 'sequential');
  expect(field('同時実行するタスク数').value).toBe('7');
  await enter(field('実行モデル'), 'dag');
  await click(button('定義を保存'));
  await click(button('破棄して保存'));
  expect(save.mock.calls[0][0].stages[1].dependsOn).toEqual([]);
  expect(save.mock.calls[0][0].stages[2].dependsOn).toEqual(['prep', 'independent']);
  await enter(field('実行モデル'), 'legacy');
  await click(button('定義を保存'));
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toMatch(
    /対象 2 工程[\s\S]*コマンドと引数[\s\S]*Pythonコード[\s\S]*入出力契約[\s\S]*DAG依存関係/,
  );
  await click(button('キャンセル'));
  expect(save).toHaveBeenCalledTimes(1);
  await click(button('定義を保存'));
  await click(button('破棄して保存'));
  expect(save.mock.lastCall![0].stages[0]).toMatchObject({
    runner: undefined,
    contracts: undefined,
    map: null,
  });
});

it('shows nested imported constraints and jumps to the offending contract on another stage', async () => {
  const rule = {
    pattern: 'result.json',
    minFiles: 1,
    maxFiles: 1,
    schema: {
      type: 'array' as const,
      maxItems: 8,
      items: { type: 'number' as const, minimum: 2, maximum: 9 },
    },
  };
  await editor(
    workflow([
      spec('prep'),
      spec('publish', {
        dependsOn: ['prep'],
        contracts: { inputs: [], outputs: [rule, { ...rule, maxFiles: 0 }] },
      }),
    ]),
  );
  const issue = document.querySelector<HTMLButtonElement>('.condition-error button')!;
  expect(issue.textContent).toContain('publish ／ 出力契約 2・最大件数');
  await click(issue);
  expect(document.activeElement).toBe(document.querySelector('#contract-outputs-1-maxFiles input'));
  expect(document.activeElement?.closest('details')?.open).toBe(true);
  const summary = [...document.querySelectorAll('details')].find(
    (x) => x.querySelector(':scope > summary')?.textContent === '契約 1 の全制約',
  )!;
  expect(summary.textContent).toMatch(/最多 8要素[\s\S]*\$\[\*\][\s\S]*最小値 2[\s\S]*最大値 9/);
  await enter(document.activeElement as HTMLInputElement, '2');
  expect(button('定義を保存').disabled).toBe(false);
});

function task(key: string, status: JobStage['status'], path?: string): JobStage {
  return {
    key,
    label: key,
    short: key,
    status,
    stageKey: path ? 'scan' : key,
    item: path ? { path, hash: 'h' } : undefined,
    attempts: 1,
    startedAt: null,
    endedAt: null,
    summary: null,
  };
}
function parallelJob() {
  const definition = workflow([spec('scan'), spec('publish', { dependsOn: ['scan'] })]);
  const waiting: JobStage = {
    ...task('scan_b', 'review', 'b.csv'),
    workspace: 'attempt-2',
    attempts: 2,
    reviewSequence: 17,
    failureKind: 'acceptance_failed',
    summary: '閾値を下回りました',
  };
  return {
    ...job('running'),
    stages: [task('scan_a', 'running', 'a.csv'), waiting, task('publish', 'pending')],
    workflow: { version: 2 as const, hash: 'h', project: definition },
  };
}
it('opens the selected review evidence before approving its exact attempt; graph and task picker focus details', async () => {
  const run = parallelJob();
  const approve = vi.fn();
  function Monitor() {
    const [selected, setSelected] = useState(run.stages[0].key);
    return h(ActionsSection, {
      selectedJob: run,
      project: run.workflow.project,
      selectedStage: selected,
      onSelectStage: setSelected,
      showAllLogs: false,
      onShowAllLogs: vi.fn(),
      onApproveReview: approve,
      nowMs: 0,
    });
  }
  client.setQueryData(['monitor', project.id], { jobs: [run] });
  const key = ['review-outputs', run.id, 'scan_b', 17];
  client.setQueryData(key, { reviewSequence: 16, files: [{ path: 'old.txt', bytes: 1 }] });
  await render(h(Monitor));
  await click(button('「scan_b」の出力を確認'));
  expect(approve).not.toHaveBeenCalled();
  expect(document.activeElement?.textContent).toBe('scan_b');
  expect(button('この試行の出力を例外承認して続行').disabled).toBe(true);
  expect(document.querySelector('.review-outputs a')).toBeNull();
  await act(async () => {
    client.setQueryData(key, {
      stageKey: 'scan_b',
      attempt: 2,
      receipt: 'b'.repeat(64),
      failureKind: 'acceptance_failed',
      summary: '閾値を下回りました',
      reviewSequence: 17,
      files: [{ path: 'new.txt', bytes: 1 }],
    });
    await new Promise((r) => setTimeout(r, 5));
  });
  const review = document.querySelector('.review-outputs')!;
  expect(review.textContent).toMatch(/scan_b・試行 2[\s\S]*b.csv[\s\S]*閾値を下回りました/);
  const link = new URL(review.querySelector('a')!.href);
  expect(Object.fromEntries(link.searchParams)).toEqual({
    path: 'new.txt',
    task: 'scan_b',
    sequence: '17',
  });
  await click(button('この試行の出力を例外承認して続行'));
  expect(approve).toHaveBeenCalledWith({
    mode: 'exact',
    jobId: run.id,
    stage: 'scan_b',
    attempt: 2,
    reviewSequence: 17,
    receipt: 'b'.repeat(64),
    exception: true,
  });
  await enter(document.querySelector<HTMLElement>('.graph-node [role="combobox"]')!, 'scan_a');
  expect(document.activeElement?.textContent).toBe('scan_a');
  const picker = document.querySelector<HTMLElement>(
    '[role="combobox"][aria-label="表示するタスク"]',
  )!;
  await click(picker);
  expect(
    document
      .querySelector('[role="group"][aria-label="scan"]')
      ?.querySelectorAll('[role="option"]'),
  ).toHaveLength(2);
  await click(
    document.querySelector<HTMLButtonElement>('[role="option"][data-option-value="scan_b"]')!,
  );
  expect(document.activeElement?.textContent).toBe('scan_b');
});

it('counts a running job with gated tasks once under approvals and keeps its running card', async () => {
  const run = parallelJob();
  run.stages.push({ ...run.stages[1], key: 'another' });
  client.setQueryData(['monitor', project.id], {
    project,
    jobs: [run, job('running', 'no-review')],
  });
  await render(h(JobsPage, { project }));
  expect(
    document.querySelector('[aria-labelledby=column-running]')?.querySelectorAll('li'),
  ).toHaveLength(2);
  expect(
    document.querySelector('[aria-labelledby=column-review]')?.querySelectorAll('li'),
  ).toHaveLength(1);
  expect(document.querySelector('a[href="#column-review"]')?.textContent).toContain('1件');
  expect(
    [...document.querySelectorAll('dt')].find((x) => x.textContent === '要承認')?.nextElementSibling
      ?.textContent,
  ).toBe('1');
});

it.each([
  ['numpy', 'numpy'],
  ['a.b', 'a-b'],
])('keeps both editable package rows for %s and %s until corrected', async (first, duplicate) => {
  const definition = workflow([spec('main')]);
  definition.runtime = { revision: 'env', python: '', expected: {}, packages: { [first]: '1' } };
  const save = await editor(definition);
  await click(button('パッケージを追加'));
  const name = (i: number) =>
    document.querySelector<HTMLInputElement>(`[aria-label="パッケージ名 ${i}"]`)!;
  const version = (i: number) =>
    document.querySelector<HTMLInputElement>(`[aria-label="固定バージョン ${i}"]`)!;
  await enter(version(2), '2');
  await enter(name(2), duplicate);
  expect(name(1).value).toBe(first);
  expect(name(2)?.value).toBe(duplicate);
  expect(version(2).value).toBe('2');
  expect(button('パッケージを追加').disabled).toBe(true);
  expect(button('定義を保存').disabled).toBe(true);
  await click(button('パッケージを追加'));
  expect(name(3)).toBeNull();
  await enter(name(2), 'Package.1');
  expect(button('パッケージを追加').disabled).toBe(false);
  await click(button('定義を保存'));
  expect(save.mock.lastCall![0].runtime?.packages).toEqual({ [first]: '1', 'Package.1': '2' });
  await click(button('パッケージを追加'));
  expect(name(3).value).toBe('package-2');
  await click(button('戻す'));
  expect(name(2)).toBeNull();
});

it.each(['human', 'http'])(
  'keeps runtime and cache drafts until a confirmed incompatible %s or legacy save',
  async (kind) => {
    const definition = workflow([
      spec('prep', { cache: { enabled: true, revision: 'cache-1' } }),
      spec('publish', { dependsOn: ['prep'] }),
    ]);
    definition.runtime = {
      revision: 'env',
      python: 'python3',
      expected: { node: '22' },
      packages: { numpy: '2' },
    };
    const save = await editor(definition);
    await enter(field('環境の版'), 'env-2');
    await enter(field('キャッシュの版'), 'cache-2');
    await enter(field('工程の種類'), kind);
    await click(button('定義を保存'));
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toMatch(
      /対象 1 工程[\s\S]*prep：.*キャッシュ/,
    );
    await click(button('キャンセル'));
    expect(save).not.toHaveBeenCalled();
    await click(button('定義を保存'));
    await click(button('破棄して保存'));
    expect(save.mock.lastCall![0].stages[0].cache?.enabled).toBeFalsy();
    expect(save.mock.lastCall![0].stages[0].cache?.revision).toBeFalsy();
    expect(save.mock.lastCall![0].runtime?.revision).toBe('env-2');
    await enter(field('工程の種類'), 'ai');
    expect(field('キャッシュの版').value).toBe('cache-2');
    await enter(field('実行モデル'), 'legacy');
    await enter(field('実行モデル'), 'sequential');
    expect(field('環境の版').value).toBe('env-2');
    expect(field('キャッシュの版').value).toBe('cache-2');
    await enter(field('実行モデル'), 'legacy');
    await click(button('定義を保存'));
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toMatch(
      /キャッシュ[\s\S]*実行環境/,
    );
    await click(button('キャンセル'));
    expect(save).toHaveBeenCalledTimes(1);
    await click(button('定義を保存'));
    await click(button('破棄して保存'));
    const saved = save.mock.lastCall![0];
    expect(saved.graph).toBeUndefined();
    expect(saved.runtime).toEqual({ revision: '', python: '', expected: {}, packages: {} });
    expect(saved.stages[0].cache?.enabled).toBeFalsy();
    expect(saved.stages[0].cache?.revision).toBeFalsy();
  },
);
