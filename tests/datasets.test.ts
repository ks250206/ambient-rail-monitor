import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import { checkCondition, inventory, snapshotDataset, verifyDataset } from '../shared/datasets.ts';
import type { ClaimResponse, ProjectSpec, WorkflowJob } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

it('keeps snapshots complete, hashed and isolated from files outside the selected dataset', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'railflow-snapshot-'));
  try {
    const input = path.join(root, 'in');
    mkdirSync(input);
    writeFileSync(path.join(input, 'sample.csv'), 'x,y\n1,2');
    writeFileSync(path.join(input, 'sibling.json'), '{"ok":true}');
    const selected = inventory(input, 'sample.csv');
    expect(
      checkCondition(selected, 'sample.csv', 0, {
        op: 'json.value',
        path: 'sibling.json',
        field: 'ok',
        compare: 'eq',
        value: true,
      }).status,
    ).toBe('error');
    const output = path.join(root, 'snapshot');
    const manifest = snapshotDataset(selected, output, 'sample.csv', 'file', 'test', 'sample.csv');
    expect(verifyDataset(output, manifest)).toBe(true);
    expect(verifyDataset(output, { ...manifest, files: [] })).toBe(false);
    expect(verifyDataset(output, { ...manifest, bytes: 12345 })).toBe(false);
    writeFileSync(path.join(output, 'extra.txt'), 'untracked');
    expect(verifyDataset(output, manifest)).toBe(false);
    rmSync(path.join(output, 'extra.txt'));
    chmodSync(path.join(output, 'sample.csv'), 0o600);
    writeFileSync(path.join(output, 'sample.csv'), 'modified');
    expect(verifyDataset(output, manifest)).toBe(false);
    const changing = inventory(input);
    writeFileSync(path.join(input, 'sample.csv'), 'changed while copying');
    expect(() =>
      snapshotDataset(changing, path.join(root, 'failed'), 'set', 'directory', 'test'),
    ).toThrow();
    expect(existsSync(path.join(root, 'failed'))).toBe(false);
    expect(readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
    if (process.platform !== 'win32') {
      symlinkSync(path.join(input, 'sample.csv'), path.join(input, 'linked.csv'));
      expect(() => inventory(input)).toThrow('シンボリックリンク');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('commits multipart datasets only after every transfer, preserves duplicate basenames and checks triggers', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'batch',
      name: 'Batch',
      input: {
        mode: 'directory',
        condition: { op: 'file.count', pattern: '**/*.csv', compare: 'gte', value: 2 },
      },
    });
    const files = [
      { path: 'A/sample.csv', bytes: 1 },
      { path: 'B/sample.csv', bytes: 1 },
    ];
    const upload = await f.json<{ id: string }>('/api/uploads', {
      projectId: 'batch',
      name: '測定セット',
      kind: 'directory',
      files,
    });
    expect(
      (
        await fetch(`${f.url}/api/uploads/${upload.id}/files?path=A%2Fsample.csv`, {
          method: 'PUT',
          body: 'A',
        })
      ).status,
    ).toBe(200);
    expect((await f.response(`/api/uploads/${upload.id}/commit`)).status).toBe(409);
    expect((await f.state()).jobs).toHaveLength(0);
    expect(
      (
        await fetch(`${f.url}/api/uploads/${upload.id}/files?path=B%2Fsample.csv`, {
          method: 'PUT',
          body: 'B',
        })
      ).status,
    ).toBe(200);
    const { job } = await f.json<{ job: WorkflowJob }>(`/api/uploads/${upload.id}/commit`);
    expect(job.dataset?.files.map((item) => item.path)).toEqual(['A/sample.csv', 'B/sample.csv']);
    expect((await f.json<{ job: WorkflowJob }>(`/api/uploads/${upload.id}/commit`)).job.id).toBe(
      job.id,
    );
    const claim = await f.json<ClaimResponse>('/api/jobs/claim');
    expect(readFileSync(path.join(claim.paths!.inputDir!, 'A/sample.csv'), 'utf8')).toBe('A');
    expect(readFileSync(path.join(claim.paths!.inputDir!, 'B/sample.csv'), 'utf8')).toBe('B');
    for (const invalid of [
      [{ path: '../escape', bytes: 1 }],
      [
        { path: 'a', bytes: 1 },
        { path: 'A', bytes: 1 },
      ],
      [
        { path: 'a', bytes: 1 },
        { path: 'a/b', bytes: 1 },
      ],
    ]) {
      expect(
        (
          await f.response('/api/uploads', {
            projectId: 'batch',
            name: 'Bad',
            kind: 'directory',
            files: invalid,
          })
        ).status,
      ).toBe(400);
    }
    const rejected = await f.json<{ id: string }>('/api/uploads', {
      projectId: 'batch',
      name: 'Incomplete set',
      kind: 'directory',
      files: [{ path: 'only.csv', bytes: 1 }],
    });
    await fetch(`${f.url}/api/uploads/${rejected.id}/files?path=only.csv`, {
      method: 'PUT',
      body: 'x',
    });
    const response = await f.response(`/api/uploads/${rejected.id}/commit`);
    expect(response.status).toBe(422);
    expect((await response.json()).result.status).toBe('fail');
    expect((await f.state()).jobs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('waits for directory readiness, freezes settings, and deduplicates unchanged datasets across restart', async () => {
  let f = await workflowFixture();
  try {
    const { project } = await f.json<{ project: ProjectSpec }>('/api/projects', {
      id: 'watch',
      name: 'Watch',
      prompt: 'original prompt',
      execution: { maxRetries: 0 },
      input: {
        mode: 'directory',
        settleMs: 100,
        condition: {
          op: 'all',
          children: [
            { op: 'file.count', pattern: '**/*.csv', compare: 'eq', value: 2 },
            { op: 'file.exists', pattern: '.ready' },
          ],
        },
      },
    });
    const input = path.join(f.home, project.inboxDir, 'experiment');
    for (const name of ['A', 'B']) {
      mkdirSync(path.join(input, name), { recursive: true });
      writeFileSync(path.join(input, name, 'sample.csv'), name);
    }
    await expect
      .poll(
        async () =>
          (await (await fetch(f.url + '/api/state?project=watch')).json()).candidates?.[0]?.result
            ?.status,
        { timeout: 5000 },
      )
      .toBe('fail');
    expect((await f.state()).jobs).toHaveLength(0);
    writeFileSync(path.join(input, '.ready'), '');
    await expect.poll(async () => (await f.state()).jobs.length, { timeout: 5000 }).toBe(1);
    const original = (await f.state()).jobs[0];
    await f.json(
      '/api/projects/watch',
      { prompt: 'new prompt', execution: { maxRetries: 9 } },
      'PUT',
    );
    const home = f.home;
    await f.close(true);
    f = await workflowFixture(home);
    await expect
      .poll(
        async () =>
          (await (await fetch(f.url + '/api/state?project=watch')).json()).candidates?.[0]?.status,
        { timeout: 5000 },
      )
      .toBe('registered');
    expect((await f.state()).jobs).toHaveLength(1);
    const claim = await f.json<ClaimResponse>('/api/jobs/claim');
    expect(claim.job?.id).toBe(original.id);
    expect(claim.project?.prompt).toBe('original prompt');
    expect(claim.project?.execution?.maxRetries).toBe(0);
    writeFileSync(path.join(input, 'A/sample.csv'), 'new original bytes');
    expect(readFileSync(path.join(claim.paths!.inputDir!, 'A/sample.csv'), 'utf8')).toBe('A');
    expect(verifyDataset(claim.paths!.inputDir!, claim.job!.dataset!)).toBe(true);
  } finally {
    await f.close();
  }
});
