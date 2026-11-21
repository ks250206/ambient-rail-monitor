// @vitest-environment happy-dom
import { act, createElement as h, useState } from 'react';
import { expect, it, vi } from 'vite-plus/test';
import { AppHeader } from '../src/components/AppHeader.tsx';
import { CustomSelect } from '../src/components/CustomSelect.tsx';
import { alertDialog, confirmDialog, promptDialog } from '../src/components/DialogHost.tsx';
import { getLocale, setLocale } from '../src/i18n.ts';
import { JobsPage } from '../src/JobsPage.tsx';
import { LandingPage } from '../src/LandingPage.tsx';
import { installPageTransitions, navigateWithTransition } from '../src/utils/navigation.ts';
import { button, chooseSelect, client, enter, job, project, render } from './ui-fixture.ts';

const click = (el: HTMLElement) => act(async () => el.click());
const keyDown = (target: EventTarget, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

it('CustomSelect supports click, keyboard navigation, disabled skipping, typeahead, and groups', async () => {
  const onChange = vi.fn();
  function Harness() {
    const [val, setVal] = useState('alpha');
    return h(CustomSelect, {
      ariaLabel: 'Fruit picker',
      value: val,
      onChange: (next) => {
        setVal(next);
        onChange(next);
      },
      groups: [
        {
          label: 'Group A',
          options: [
            { value: 'alpha', label: 'Apple' },
            { value: 'blocked', label: 'Apricot', disabled: true },
          ],
        },
        {
          label: 'Group B',
          options: [
            { value: 'beta', label: 'Banana' },
            { value: 'gamma', label: 'Cherry' },
          ],
        },
      ],
    });
  }
  await render(h(Harness));
  const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  expect(trigger.textContent).toContain('Apple');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  // Open via ArrowDown, skip disabled option, commit via Enter
  await keyDown(trigger, 'ArrowDown');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('[role="group"]')).toHaveLength(2);
  await keyDown(trigger, 'ArrowDown');
  await keyDown(trigger, 'Enter');
  expect(onChange).toHaveBeenLastCalledWith('beta');
  expect(trigger.dataset.value).toBe('beta');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  // Typeahead + Escape closes without committing
  await keyDown(trigger, 'c');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await keyDown(document, 'Escape');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.dataset.value).toBe('beta');

  // Direct click selection
  await chooseSelect(trigger, 'gamma');
  expect(onChange).toHaveBeenLastCalledWith('gamma');
  expect(trigger.textContent).toContain('Cherry');

  // Reselecting the already-selected option closes menu without firing onChange
  const callsBefore = onChange.mock.calls.length;
  await chooseSelect(trigger, 'gamma');
  expect(onChange).toHaveBeenCalledTimes(callsBefore);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  await keyDown(trigger, 'Enter');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await keyDown(trigger, 'Enter');
  expect(onChange).toHaveBeenCalledTimes(callsBefore);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('DialogHost resolves confirmDialog, alertDialog, and promptDialog with validation and Escape', async () => {
  await render(h('div', null, 'host'));

  // confirmDialog: cancel then confirm
  let confirmResult: boolean | undefined;
  await act(async () => {
    void confirmDialog({
      title: '確認',
      message: '続行しますか？',
      detail: '詳細情報',
      tone: 'danger',
    }).then((res) => {
      confirmResult = res;
    });
  });
  const confirmEl = document.querySelector('[role="alertdialog"]');
  expect(confirmEl?.textContent).toContain('詳細情報');
  await click(button('キャンセル'));
  expect(confirmResult).toBe(false);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();

  await act(async () => {
    void confirmDialog({ title: '実行確認', message: '本当に実行？', confirmLabel: 'はい' }).then(
      (res) => {
        confirmResult = res;
      },
    );
  });
  await click(button('はい'));
  expect(confirmResult).toBe(true);

  // alertDialog
  let alerted = false;
  await act(async () => {
    void alertDialog({ title: '通知', message: '完了しました', okLabel: '了解' }).then(() => {
      alerted = true;
    });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('完了しました');
  await click(button('了解'));
  expect(alerted).toBe(true);

  // promptDialog with validation
  let promptResult: string | null | undefined;
  await act(async () => {
    void promptDialog({
      title: '名前を入力',
      defaultValue: '',
      confirmLabel: '決定',
      validate: (v) => (v.trim() ? null : '必須項目です'),
    }).then((res) => {
      promptResult = res;
    });
  });
  await click(button('決定'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('必須項目です');
  expect(promptResult).toBeUndefined();
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await enter(input, 'sample-run');
  await click(button('決定'));
  expect(promptResult).toBe('sample-run');

  // promptDialog cancelled via Escape
  let escaped: string | null | undefined;
  await act(async () => {
    void promptDialog({ title: 'メモ' }).then((res) => {
      escaped = res;
    });
  });
  await keyDown(document, 'Escape');
  expect(escaped).toBeNull();
});

it('toggles JA/EN via AppHeader, persists locale, updates <html lang>, and translates pages', async () => {
  client.setQueryData(['projects'], [project]);
  client.setQueryData(['monitor', project.id], { project, jobs: [job('review')] });
  await render(
    h(
      'div',
      null,
      h(AppHeader, {
        currentPage: 'jobs',
        projects: [project],
        selectedProjectId: project.id,
        onSelectProject: vi.fn(),
        connection: 'online',
      }),
      h(JobsPage, { project }),
      h(LandingPage),
    ),
  );
  expect(document.documentElement.lang).toBe('ja');
  expect(document.body.textContent).toContain('データをまとめて投入');
  expect(document.body.textContent).toContain('要承認');

  await click(button('EN'));
  expect(getLocale()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(window.localStorage.getItem('railflow:locale')).toBe('en');
  expect(document.body.textContent).toContain('Submit dataset');
  expect(document.body.textContent).toContain('Needs approval');
  expect(document.body.textContent).toContain('Open projects');

  await click(button('JA'));
  expect(getLocale()).toBe('ja');
  expect(document.documentElement.lang).toBe('ja');
  expect(document.body.textContent).toContain('データをまとめて投入');
});

it('navigateWithTransition recovers if navigation does not unload and ignores /api/ links', () => {
  vi.useFakeTimers();
  const assign = vi.fn();
  const originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: originalLocation.href,
      origin: originalLocation.origin,
      pathname: originalLocation.pathname,
      search: originalLocation.search,
      assign,
      replace: vi.fn(),
    },
  });
  document.documentElement.classList.remove('is-navigating');
  setLocale('ja');

  navigateWithTransition('/jobs');
  expect(document.documentElement.classList.contains('is-navigating')).toBe(true);
  expect(assign).not.toHaveBeenCalled();

  vi.advanceTimersByTime(160);
  expect(assign).toHaveBeenCalledWith('/jobs');

  // If the page does not unload (e.g. beforeunload cancelled), visibility is restored
  vi.advanceTimersByTime(1000);
  expect(document.documentElement.classList.contains('is-navigating')).toBe(false);

  // Clicking an /api/ link does not trigger exit transition
  installPageTransitions();
  const apiLink = document.createElement('a');
  apiLink.href = `${originalLocation.origin}/api/jobs/run_1/logs`;
  document.body.appendChild(apiLink);
  const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  apiLink.dispatchEvent(clickEvent);
  expect(clickEvent.defaultPrevented).toBe(false);
  expect(document.documentElement.classList.contains('is-navigating')).toBe(false);

  document.documentElement.classList.remove('is-navigating');
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.useRealTimers();
});
