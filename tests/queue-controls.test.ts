// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { expect, it, vi } from 'vite-plus/test';
import { button, client, enter, job, project, render } from './ui-fixture.ts';
import { DEFAULT_QUEUE, parsePriority, parseQueue } from '../shared/queue.ts';
import { JobsPage } from '../src/JobsPage.tsx';
import { JobControls } from '../src/components/JobControls.tsx';
import { QueuePanel } from '../src/components/QueuePanel.tsx';

it('identifies the job and irreversible consequence and sends cancel only after confirmation', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await render(h(JobControls, { job: job('running', 'run_01') }));
  await act(async () => button('ジョブを中止').click());
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toMatch(/測定\.csv.*run_01.*再開できません/);
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button('やめる').click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button('ジョブを中止').click());
  await act(async () => button('ジョブを中止する').click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    '/api/jobs/run_01/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
});

it.each([
  ['maxConcurrentJobs', '全体の同時ジョブ数', 1, 32],
  ['maxJobsPerWorker', 'ワーカーあたりの同時ジョブ数', 1, 16],
  ['maxRecoveries', 'ジョブの自動復旧回数', 0, 20],
  ['priority', '優先度', -100, 100],
] as const)(
  '%s shows the API bounds and associates invalid values with a field error',
  async (field, label, min, max) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    await render(
      field === 'priority'
        ? h(JobControls, { job: job('queued') })
        : h(QueuePanel, { queue: { ...DEFAULT_QUEUE, active: 0, workers: [] } }),
    );
    const fieldLabel = Array.from(document.querySelectorAll('label')).find((item) =>
      item.textContent?.includes(label),
    )!;
    const range = `${min}〜${max}`;
    expect(fieldLabel.textContent).toContain(range);
    const input = fieldLabel.querySelector('input')!;
    const save = button(field === 'priority' ? '優先度を保存' : 'キュー設定を保存');
    const parse = (value: number) =>
      field === 'priority'
        ? parsePriority(value)
        : parseQueue({ ...DEFAULT_QUEUE, [field]: value });
    for (const invalid of [String(min - 1), String(max + 1), '1.2', '']) {
      await enter(input, invalid);
      expect(save.disabled).toBe(true);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(
        document.getElementById(input.getAttribute('aria-describedby')!)?.textContent,
      ).toContain(range);
      save.click();
      expect(() => parse(invalid === '' ? NaN : Number(invalid))).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    for (const valid of [min, max]) {
      await enter(input, String(valid));
      expect(() => parse(valid)).not.toThrow();
      expect(input.hasAttribute('aria-describedby')).toBe(false);
      expect(save.disabled).toBe(false);
    }
    await act(async () => save.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ [field]: max });
  },
);

it('groups terminal outcomes once, exposes their full counts and links to approvals', async () => {
  const jobs = [
    job('review'),
    job('queued'),
    job('running'),
    job('done'),
    job('failed'),
    job('cancelled'),
    job('done', 'another-success'),
    job('cancelled', 'second-cancel'),
    job('failed', 'second-failure'),
  ];
  client.setQueryData(['monitor', project.id], { project, jobs });
  await render(h(JobsPage, { project }));
  const review = document.querySelector('section[aria-labelledby="column-review"]')!;
  expect(review.querySelectorAll('li')).toHaveLength(1);
  expect(review.textContent).toContain('review');
  expect(document.querySelector('a[href="#column-review"]')?.textContent).toContain('要承認');
  const reviewCount = Array.from(document.querySelectorAll('dt')).find(
    (term) => term.textContent === '要承認',
  );
  expect(reviewCount?.nextElementSibling?.textContent).toBe('1');
  const finished = document.querySelector('section[aria-labelledby="column-done"]')!;
  expect(finished.querySelector('h2')?.textContent).toBe('終了');
  for (const label of ['成功', '失敗', '中止'])
    expect(finished.textContent).toContain(label + ' 2件');
  expect(finished.querySelectorAll('li')).toHaveLength(5);
  await act(async () => button('残り1件を表示').click());
  expect(finished.querySelectorAll('li')).toHaveLength(6);
});
