// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { expect, it, vi } from 'vite-plus/test';
import { QC_MAX_BYTES, type QcV1 } from '../shared/qc.ts';
import type { JobStage, WorkflowJob } from '../shared/types.ts';
import { approveReviewedOutput, type InspectedOutput } from '../src/api.ts';
import { StageExecutionDetails } from '../src/components/ExecutionDetails.tsx';
import { setLocale } from '../src/i18n.ts';
import { qcFixture } from './qc-fixture.ts';
import { button, client, enter, job, project, render } from './ui-fixture.ts';

const stage: JobStage = {
  key: 'qc',
  label: 'QC',
  short: 'QC',
  attempts: 2,
  reviewSequence: 12,
  status: 'review',
  workspace: 'attempt',
  startedAt: null,
  endedAt: null,
  summary: null,
};
const run: WorkflowJob = {
  ...job('review', 'current'),
  stages: [stage],
  workflow: { version: 2, project, hash: 'abc' },
};
const receipt = 'a'.repeat(64);
const raw = JSON.stringify(qcFixture());
const inspection: InspectedOutput = {
  stageKey: 'qc',
  attempt: 2,
  reviewSequence: 12,
  failureKind: null,
  receipt,
  summary: null,
  fileHashes: { 'qc.json': 'd'.repeat(64) },
  files: [{ path: 'qc.json', bytes: raw.length }],
};
const key = ['review-outputs', run.id, stage.key, 12];
const result = (id: string, qc: unknown) =>
  Response.json({ baselineJobId: id, stageKey: 'qc', outputHash: 'b'.repeat(64), qc });
function show(
  data = inspection,
  approval = approveReviewedOutput,
  target = run,
  recordedFiles = data.files,
) {
  setLocale('en');
  client.setQueryData(key, {
    ...data,
    fileHashes: Object.fromEntries(data.files.map((file) => [file.path, 'd'.repeat(64)])),
  });
  client.setQueryData(['monitor', project.id], {
    jobs: ['A', 'B'].map((id) => ({
      ...run,
      id,
      status: 'done',
      stages: [{ ...stage, status: 'success' }],
    })),
  });
  return render(
    h(StageExecutionDetails, {
      job: target,
      stage: {
        ...stage,
        output: {
          hash: 'c'.repeat(64),
          files: recordedFiles.map((file) => ({
            ...file,
            hash: 'd'.repeat(64),
            executable: false,
          })),
        },
      },
      nowMs: 0,
      approving: false,
      onApprove: approval,
    }),
  );
}
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });
const choose = (id: string) =>
  enter(document.querySelector<HTMLElement>('[aria-label="Baseline job"]')!, id);
const click = (label: string) => act(async () => button(label).click());
const approveLabel = 'Approve stage & continue';
const exceptionLabel = 'Exception-approve this output & continue';

it('keeps the latest selected baseline and posts the inspected attempt with the original exception decision', async () => {
  let release!: (r: Response) => void;
  const late = new Promise<Response>((r) => {
    release = r;
  });
  const qc = qcFixture();
  const base = {
    ...qc,
    threshold: 0.2,
    value: 0.25,
    passed: false,
    predictedSha256: '1'.repeat(64),
    residuals: qc.residuals.map((p) => ({ ...p, residual: p.residual / 2 })).reverse(),
  };
  const fetcher = vi.fn((url: string) => {
    if (url.includes('/review/file?')) return Promise.resolve(new Response(raw));
    if (url.includes('baselineJobId=A')) return late;
    if (url.includes('baselineJobId=B')) return Promise.resolve(result('B', base));
    return Promise.resolve(Response.json({ ok: true }));
  });
  vi.stubGlobal('fetch', fetcher);
  await show({ ...inspection, failureKind: 'acceptance_failed', summary: 'Output gate failed' });
  await settle();
  expect(document.body.textContent).toContain('Sample S-01');
  expect(document.body.textContent).toContain('Automated QC · Pass');
  expect(document.body.textContent).toContain('Output gate failed');
  expect(document.body.innerHTML).not.toContain(receipt);
  expect(document.querySelector('polyline')).toBeNull();
  await choose('A');
  await choose('B');
  await settle();
  await act(async () => release(result('A', qc)));
  expect(document.body.textContent).toContain('+0.25 mV');
  expect(document.body.textContent).toContain('≤ 0.2 mV');
  expect(document.body.textContent).toContain('Automated QC · Fail');
  const lines = [...document.querySelectorAll('polyline')];
  expect(lines).toHaveLength(2);
  const ordinates = (line: Element) =>
    line
      .getAttribute('points')!
      .split(' ')
      .map((p) => Number(p.split(',')[1]));
  expect(ordinates(lines[0])).toEqual([12, 132, 132, 12]);
  expect(ordinates(lines[1])).toEqual([42, 102, 102, 42]);
  await click(exceptionLabel);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/jobs/current/approve-exact',
    expect.objectContaining({
      body: JSON.stringify({
        stage: 'qc',
        attempt: 2,
        reviewSequence: 12,
        receipt,
        exception: true,
      }),
    }),
  );
});

it.each([
  [{ sampleId: 'other' }, 'Sample'],
  [{ observedSha256: 'b'.repeat(64) }, 'Observed data hash'],
  [{ unit: 'V' }, 'Unit'],
  [{ residuals: qcFixture().residuals.slice(1) }, 'Point ID set'],
  [{ validatorVersion: 'unknown' }, 'validatorVersion'],
  [{ formatVersion: 2 }, 'formatVersion'],
])('suppresses incompatible comparisons for %j', async (patch, reason) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/review/file?')
        ? new Response(raw)
        : result('B', { ...qcFixture(), ...(patch as Partial<QcV1>) }),
    ),
  );
  await show();
  await settle();
  await choose('B');
  await settle();
  expect(document.body.textContent).toContain(reason);
  expect(document.querySelector('polyline')).toBeNull();
  expect(document.body.textContent).not.toContain('RMSE difference');
  expect(button(approveLabel).disabled).toBe(false);
});

it.each([undefined, 'A'.repeat(64), 'b'.repeat(63)])(
  'rejects an invalid baseline outputHash (%s)',
  async (outputHash) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/review/file?')
          ? new Response(raw)
          : Response.json({ baselineJobId: 'B', stageKey: 'qc', outputHash, qc: qcFixture() }),
      ),
    );
    await show();
    await settle();
    await choose('B');
    await settle();
    expect(document.body.textContent).toContain('Invalid baseline outputHash');
    expect(document.querySelector('polyline')).toBeNull();
    expect(button(approveLabel).disabled).toBe(false);
  },
);

it('holds approval during initial QC and reinspection, then allows manual review of a 422', async () => {
  let answerQc!: (response: Response) => void;
  const approve = vi.fn(approveReviewedOutput);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/review/file?'))
        return new Promise<Response>((resolve) => {
          answerQc = resolve;
        });
      if (url.includes('/review?')) return Response.json(inspection);
      return Response.json({ jobs: [] });
    }),
  );
  await show(inspection, approve);
  expect(button(approveLabel).disabled).toBe(true);
  await click(approveLabel);
  expect(approve).not.toHaveBeenCalled();
  await act(async () => answerQc(Response.json({ error: 'Changed' }, { status: 409 })));
  await settle();
  expect(button(approveLabel).disabled).toBe(true);
  await click('Reload outputs');
  await settle();
  expect(document.body.textContent).toContain('Loading current QC');
  expect(button(approveLabel).disabled).toBe(true);
  await click(approveLabel);
  expect(approve).not.toHaveBeenCalled();
  await act(async () =>
    answerQc(Response.json({ error: 'Recorded QC is too large' }, { status: 422 })),
  );
  await settle();
  expect(document.body.textContent).toContain('Recorded QC is too large');
  expect(button(approveLabel).disabled).toBe(false);
});

it.each([
  ['nested/qc.json', raw.length, raw, 'no root qc.json'],
  ['qc.json', QC_MAX_BYTES + 1, raw, 'exceeds 2 MiB'],
  ['qc.json', 1, '{', 'Cannot read current QC'],
])(
  'preserves file access and manual review for %s, %s bytes',
  async (path, bytes, contents, message) => {
    const fetcher = vi.fn(async () =>
      bytes > QC_MAX_BYTES
        ? Response.json({ error: 'Recorded qc.json exceeds 2 MiB' }, { status: 422 })
        : new Response(contents),
    );
    vi.stubGlobal('fetch', fetcher);
    await show({ ...inspection, files: [{ path, bytes }] });
    await settle();
    expect(document.body.textContent).toContain(message);
    expect(document.querySelector('.review-outputs a')?.textContent).toBe(path);
    expect(button(approveLabel).disabled).toBe(false);
    if (path !== 'qc.json') expect(fetcher).not.toHaveBeenCalled();
    else expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['deleted', []],
  ['enlarged', [{ path: 'qc.json', bytes: QC_MAX_BYTES + 1 }]],
] as const)(
  'checks the recorded QC before enabling approval when the inventory shows it was %s',
  async (_change, liveFiles) => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: 'The recorded QC output has changed.' }, { status: 409 }),
    );
    vi.stubGlobal('fetch', fetcher);
    const approval = vi.fn(approveReviewedOutput);
    await show({ ...inspection, files: [...liveFiles] }, approval, run, inspection.files);
    await settle();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/jobs/current/review/file?task=qc&sequence=12&path=qc.json&sha256=' + 'd'.repeat(64),
      expect.anything(),
    );
    expect(button('Reload outputs')).toBeTruthy();
    expect(button(approveLabel).disabled).toBe(true);
    await click(approveLabel);
    expect(approval).not.toHaveBeenCalled();
  },
);

it.each(['http-conflict', 'growing-stream'])(
  'requires a fresh inspection when current bytes changed (%s)',
  async (reason) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reason === 'http-conflict'
          ? Response.json({ error: 'Output changed' }, { status: 409 })
          : new Response(raw + 'x'),
      ),
    );
    await show();
    await settle();
    expect(button(approveLabel).disabled).toBe(true);
    expect(button('Reload outputs')).toBeTruthy();
    expect(document.querySelector('polyline')).toBeNull();
  },
);

it('requires re-inspection and a new click after a stale receipt, with no fallback', async () => {
  const nextReceipt = 'b'.repeat(64);
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.includes('/review?')) return Response.json({ ...inspection, receipt: nextReceipt });
      if (url.includes('/review/file?')) return new Response(raw);
      return Response.json({ error: 'Receipt expired' }, { status: 409 });
    }),
  );
  await show();
  await settle();
  await click(approveLabel);
  await settle();
  expect(button(approveLabel).disabled).toBe(true);
  await click('Reload outputs');
  await settle();
  const posts = () => calls.filter(([, init]) => init?.method === 'POST');
  expect(posts()).toHaveLength(1);
  await click(approveLabel);
  expect(posts().map(([url, init]) => [url, JSON.parse(init?.body as string)])).toEqual(
    [receipt, nextReceipt].map((r) => [
      '/api/jobs/current/approve-exact',
      { stage: 'qc', attempt: 2, reviewSequence: 12, receipt: r, exception: false },
    ]),
  );
});

it('limits receipt-free approvals to legacy jobs', async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const data = { ...inspection, receipt: null, files: [] };
  await show(data);
  expect(button(approveLabel).disabled).toBe(true);
  await show(data, approveReviewedOutput, { ...run, workflow: undefined });
  await click(approveLabel);
  expect(fetcher).toHaveBeenCalledWith(
    '/api/jobs/current/approve',
    expect.objectContaining({
      body: JSON.stringify({ stage: 'qc', attempt: 2, reviewSequence: 12 }),
    }),
  );
});
