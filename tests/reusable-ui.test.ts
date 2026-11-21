// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { expect, it, vi } from 'vite-plus/test';
import { TemplatePicker } from '../src/components/Templates.tsx';
import { RunMetrics } from '../src/components/RunMetrics.tsx';
import type { JobStage } from '../shared/types.ts';
import { button, client, enter, job, project, render } from './ui-fixture.ts';

it('deletes only the confirmed template revision and sends nothing on cancel', async () => {
  const versions = ['1', '2'].map((revision) => ({
    template: { name: '解析', revision, hash: revision.repeat(64) },
    definition: project,
  }));
  client.setQueryData(['templates'], { saved: versions, builtins: [] });
  const fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetchMock);
  await render(h(TemplatePicker, { onChange: vi.fn(), onBlocked: vi.fn() }));
  const row = [...document.querySelectorAll('li')][1];
  const remove = () => [...row.querySelectorAll('button')].find((el) => el.textContent === '削除')!;
  await act(async () => remove().click());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(row.textContent).toMatch(/解析.*版 2.*削除しますか/);
  await act(async () => button('取り消す').click());
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => remove().click());
  await act(async () => button('削除を確定').click());
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    '/api/templates',
    expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify(versions[1].template),
    }),
  );
});

it('compares mapped tasks by their readable labels, distinguishing missing tasks from pending outputs', async () => {
  function stage(id: number, hash?: string): JobStage {
    const path = `folder/${id}.csv`;
    return {
      key: `scan__hash${id}`,
      label: id % 2 ? '解析' : `解析 / ${path}`,
      short: '解析',
      item: { path, hash: 'input' },
      status: 'pending',
      attempts: 0,
      startedAt: null,
      endedAt: null,
      summary: null,
      output: hash ? { hash, files: [] } : undefined,
    };
  }
  const current = {
    ...job('running'),
    stages: [stage(1), stage(2, 'a'), stage(3), stage(4), stage(6, 'a'), stage(7, 'a')],
  };
  const other = {
    ...job('done'),
    stages: [stage(1, 'b'), stage(2), stage(3), stage(5), stage(6, 'a'), stage(7, 'b')],
  };
  client.setQueryData(['monitor', project.id], { jobs: [current, other] });
  await render(h(RunMetrics, { job: current }));
  await enter(document.querySelector('select')!, other.id);
  const rows = [...document.querySelectorAll('.comparison-outputs tbody tr')];
  const states = [
    '今回のみ未確定',
    '比較先のみ未確定',
    '両方未確定',
    '対象タスクなし',
    '対象タスクなし',
    '一致',
    '異なる',
  ];
  for (const [i, state] of states.entries()) {
    const path = `folder/${i + 1}.csv`;
    const row = rows.find((el) => el.querySelector('th[scope="row"]')?.textContent?.includes(path));
    expect(row?.querySelector('th')?.textContent?.split(path)).toHaveLength(2);
    expect(row?.querySelector('th')?.textContent).toContain('解析');
    expect(row?.querySelector('td')?.textContent).toContain(state);
  }
});
