import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { DryRunResult, WorkflowJob } from '../shared/types.ts';
import { workflowFixture } from './workflow-fixture.ts';

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
const route = '/api/projects/default/dry-run';
const graph = { mode: 'dag', maxParallelTasks: 7, publishStage: 'publish' };
const draft = {
  graph,
  stages: [
    {
      key: 'scan',
      dependsOn: [],
      map: { pattern: '**/*.csv', maxItems: 2 },
      gate: { requireReview: true },
    },
    { key: 'other', dependsOn: [], execution: { onFailure: 'review' } },
    { key: 'inspect', runner: { kind: 'human' }, dependsOn: ['scan'] },
    { key: 'publish', dependsOn: ['other', 'inspect'] },
  ],
  finalGate: { requireReview: true },
  runtime: {
    revision: 'lab-2',
    python: '/opt/lab/python',
    expected: { node: '26' },
    packages: { numpy: '2' },
  },
};

async function upload(f: Fixture) {
  const entries = [
    ['A/data.csv', '1'],
    ['B/data.csv', '2'],
    ['meta.json', '{"ok":true}'],
    ['bad.json', 'bad'],
  ];
  const upload = await f.json<{ id: string }>('/api/uploads', {
    projectId: 'default',
    kind: 'directory',
    name: 'run-input',
    files: entries.map(([path, contents]) => ({ path, bytes: Buffer.byteLength(contents) })),
  });
  for (const [file, body] of entries) {
    const res = await fetch(
      f.url + `/api/uploads/${upload.id}/files?path=${encodeURIComponent(file)}`,
      { method: 'PUT', body },
    );
    expect(res.status).toBe(200);
  }
  return (await f.json<{ job: WorkflowJob }>(`/api/uploads/${upload.id}/commit`)).job;
}

// Include the SQLite journal, exported events, definitions, manifests, and all job directories.
function homeContents(home: string) {
  const entries = readdirSync(home, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    entries.map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(home, file),
        entry.isDirectory()
          ? 'directory'
          : createHash('sha256').update(readFileSync(file)).digest('hex'),
      ];
    }),
  );
}

it('plans an unsaved v2 draft on v1 input exactly as registration does, without changing the home or jobs', async () => {
  const f = await workflowFixture();
  try {
    const source = await upload(f);
    expect(source.workflow?.version).toBe(1);
    const before = homeContents(f.home);
    const body = { sourceJobId: source.id, draft };
    const result = await f.json<DryRunResult>(route, body);
    expect(result).toMatchObject({
      sourceJobId: source.id,
      datasetHash: source.hash,
      taskCount: 5,
      maxParallelTasks: 7,
      publishStage: 'publish',
      runtimeRequirements: draft.runtime,
      trigger: { status: 'pass' },
    });
    const mapped = result.tasks.filter((task) => task.stageKey === 'scan');
    expect(mapped.map((task) => task.item?.path)).toEqual(['A/data.csv', 'B/data.csv']);
    expect(mapped[0].key).not.toBe(mapped[1].key);
    expect(result.reviewTaskKeys).toEqual([
      ...mapped.map((task) => task.key),
      'inspect',
      'publish',
    ]);
    expect(result.tasks.find((task) => task.key === 'inspect')?.dependsOn).toEqual(
      mapped.map((task) => task.key).sort(),
    );
    expect(await f.json(route, body)).toEqual(result);
    for (const [map, count] of [
      [{ pattern: '*.missing', maxItems: 2 }, 0],
      [{ pattern: '**/*.csv', maxItems: 1 }, 2],
    ] as const) {
      const res = await f.response(route, {
        ...body,
        draft: { ...draft, stages: [{ ...draft.stages[0], map }, ...draft.stages.slice(1)] },
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toContain(`現在${count}件`);
    }
    expect((await f.state()).jobs.map((job) => job.id)).toEqual([source.id]);
    expect(homeContents(f.home)).toEqual(before);
    await f.json('/api/projects/default', draft, 'PUT');
    const registered = await upload(f);
    expect(registered.workflow?.plan).toEqual(result.tasks);
    expect(registered.workflow?.project.graph?.publishStage).toBe(result.publishStage);
    expect(registered.hash).toBe(result.datasetHash);
    // Omitting graph from a legacy editor payload must not inherit this saved v2 graph.
    expect((await f.response(route, { ...body, draft: { stages: draft.stages } })).status).toBe(
      400,
    );
  } finally {
    await f.close();
  }
});

it('evaluates file conditions and completed transfers against verified bytes and returns the plan for every trigger verdict', async () => {
  const f = await workflowFixture();
  try {
    const source = await upload(f);
    const before = homeContents(f.home);
    const json = { op: 'json.value', field: 'ok', compare: 'eq', value: true };
    for (const [condition, status] of [
      [
        {
          op: 'all',
          children: [
            { op: 'quiet', seconds: 86400 },
            { ...json, path: 'meta.json' },
            { op: 'file.contains', path: 'B/data.csv', text: '2' },
          ],
        },
        'pass',
      ],
      [{ op: 'file.exists', pattern: '*.absent' }, 'fail'],
      [{ ...json, path: 'bad.json' }, 'error'],
      [{ ...json, path: 'missing.json' }, 'error'],
    ] as const) {
      const result = await f.json<DryRunResult>(route, {
        sourceJobId: source.id,
        draft: { ...draft, input: { condition } },
      });
      expect(result.trigger.status).toBe(status);
      expect(result.trigger.evidence).toMatchObject({
        condition,
        result: { status, message: result.trigger.message },
      });
      expect(result.taskCount).toBe(5);
    }
    expect(homeContents(f.home)).toEqual(before);
  } finally {
    await f.close();
  }
});

it('returns unknown for a nested quiet predicate on watched input even when another branch could pass', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects/default', { input: { mode: 'file', settleMs: 0 } }, 'PUT');
    const file = path.join(f.home, 'projects/default/inbox/watch.csv');
    writeFileSync(file, 'frozen');
    await expect.poll(async () => (await f.state()).jobs.length, { timeout: 5000 }).toBe(1);
    const source = (await f.state()).jobs[0];
    rmSync(file);
    const run = (condition: unknown) =>
      f.json<DryRunResult>(route, {
        sourceJobId: source.id,
        draft: {
          graph,
          stages: [{ key: 'publish' }],
          input: { condition },
        },
      });
    const frozen = { op: 'file.contains', path: 'watch.csv', text: 'frozen' };
    expect((await run(frozen)).trigger.status).toBe('pass');
    const result = await run({
      op: 'any',
      children: [frozen, { op: 'not', child: { op: 'quiet', seconds: 0 } }],
    });
    expect(result.trigger.status).toBe('unknown');
    expect(result.taskCount).toBe(1);
  } finally {
    await f.close();
  }
});

it('isolates projects and distinguishes invalid drafts, missing manifests, and damaged snapshots', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-legacy-input-'));
  mkdirSync(path.join(home, 'data'));
  writeFileSync(
    path.join(home, 'data/events.jsonl'),
    JSON.stringify({
      sequence: 1,
      type: 'job.created',
      jobId: 'run_11111111',
      projectId: 'default',
      file: 'old.csv',
      at: '2020-01-01T00:00:00Z',
    }) + '\n',
  );
  const f = await workflowFixture(home);
  try {
    await f.json('/api/projects', { id: 'other', name: 'Other' });
    const source = await upload(f);
    const body = { sourceJobId: source.id, draft };
    const before = homeContents(home);
    // A missing project must be rejected even before parsing malformed JSON.
    const missing = await fetch(f.url + '/api/projects/missing-project/dry-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(missing.status).toBe(404);
    const unsupported = await fetch(f.url + route);
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('Allow')).toBe('POST');
    for (const sourceJobId of ['', '  '])
      expect((await f.response(route, { ...body, sourceJobId })).status).toBe(400);
    expect((await f.response('/api/projects/other/dry-run', body)).status).toBe(404);
    expect((await f.response(route, { ...body, sourceJobId: 'missing' })).status).toBe(404);
    expect((await f.response(route, { ...body, sourceJobId: 'run_11111111' })).status).toBe(422);
    for (const invalid of [
      null,
      [],
      {},
      { ...draft, graph: null },
      { ...draft, stages: [{ key: 'publish', dependsOn: ['missing'] }] },
    ]) {
      expect((await f.response(route, { ...body, draft: invalid })).status).toBe(400);
    }
    expect(homeContents(home)).toEqual(before);
    const manifest = path.join(home, 'data/manifests', source.id + '.json');
    const saved = readFileSync(manifest);
    rmSync(manifest);
    expect((await f.response(route, body)).status).toBe(422);
    writeFileSync(manifest, JSON.stringify({ ...source.dataset, name: 'altered' }));
    expect((await f.response(route, body)).status).toBe(409);
    // Valid JSON padded with whitespace would otherwise match the journal manifest.
    writeFileSync(manifest, saved.toString().padEnd(10_000_001, ' '));
    expect((await f.response(route, body)).status).toBe(409);
    writeFileSync(manifest, saved);
    const input = path.join(home, 'data/inputs', source.id, 'B/data.csv');
    chmodSync(input, 0o600);
    writeFileSync(input, 'X');
    const changed = homeContents(home);
    expect((await f.response(route, body)).status).toBe(409);
    expect(homeContents(home)).toEqual(changed);
    rmSync(input);
    expect((await f.response(route, body)).status).toBe(409);
    rmSync(path.join(home, 'data/inputs', source.id), { recursive: true });
    expect((await f.response(route, body)).status).toBe(409);
  } finally {
    await f.close();
  }
});
