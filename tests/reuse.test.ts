import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { ClaimResponse, ProjectSpec, WorkflowJob } from '../shared/types.ts';
import type { WorkflowTemplate } from '../shared/templates.ts';
import { canonical } from '../shared/reuse.ts';
import { cacheIdentity } from '../shared/result-cache.ts';
import { UsageAccumulator, priceUsage, usageSummary } from '../shared/usage.ts';
import { cliPrelude, workflowFixture } from './workflow-fixture.ts';

const graph = { mode: 'dag', maxParallelTasks: 2, publishStage: 'publish' };
const command = (code: string) => ({
  kind: 'command' as const,
  program: process.execPath,
  args: ['-e', `const fs=require('node:fs'),path=require('node:path');${code}`],
});
const rate = {
  engine: 'codex',
  model: 'test-model',
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 2,
  output: 3,
} as const;
const cached = {
  id: 'cache',
  name: 'Cache',
  graph,
  runtime: { revision: 'env-v1' },
  execution: { maxRetries: 0 },
  stages: [
    {
      key: 'publish',
      dependsOn: [],
      cache: { enabled: true, revision: '1' },
      runner: command(
        "fs.appendFileSync(path.join(process.env.TEST_HOME,'calls'),'run\\n');fs.writeFileSync('report.html','accepted');",
      ),
    },
  ],
};
async function upload(
  f: Awaited<ReturnType<typeof workflowFixture>>,
  projectId: string,
  content: Record<string, string> = { 'data.csv': '1,2\n3,4\n' },
) {
  const session = await f.json<{ id: string }>('/api/uploads', {
    projectId,
    name: 'dataset',
    kind: 'directory',
    files: Object.entries(content).map(([path, text]) => ({
      path,
      bytes: Buffer.byteLength(text),
    })),
  });
  for (const [name, text] of Object.entries(content))
    expect(
      (
        await fetch(`${f.url}/api/uploads/${session.id}/files?path=${encodeURIComponent(name)}`, {
          method: 'PUT',
          body: text,
        })
      ).ok,
    ).toBe(true);
  return (await f.json<{ job: WorkflowJob }>(`/api/uploads/${session.id}/commit`)).job;
}
async function approve(f: Awaited<ReturnType<typeof workflowFixture>>, job: WorkflowJob) {
  const task = job.stages.find((task) => task.status === 'review')!;
  await f.json(`/api/jobs/${job.id}/approve`, {
    stage: task.key,
    attempt: task.attempts,
    reviewSequence: task.reviewSequence,
  });
  return f.until(job.id, 'done');
}

it('round-trips versioned templates without storage paths and keeps catalog, clones and job definitions independent', async () => {
  const f = await workflowFixture();
  try {
    const { project } = await f.json<{ project: ProjectSpec }>('/api/projects', {
      ...cached,
      pricing: [rate],
      runtime: { revision: 'env-v1', expected: { node: process.versions.node } },
    });
    const template = (await (
      await fetch(f.url + '/api/projects/cache/template?revision=2')
    ).json()) as WorkflowTemplate;
    expect(template.template.revision).toBe('2');
    for (const key of ['id', 'inboxDir', 'artifactsDir', 'createdAt', 'updatedAt'])
      expect(template.definition).not.toHaveProperty(key);
    await f.json('/api/templates/validate', { template });
    expect(existsSync(path.join(f.home, 'projects/preview'))).toBe(false);
    await f.json('/api/templates', { projectId: 'cache', revision: '2' });
    const { project: copy } = await f.json<{ project: ProjectSpec }>('/api/projects', {
      name: 'Clone',
      id: 'clone',
      template,
    });
    expect(copy.templateOrigin).toEqual(template.template);
    expect(copy.stages).toEqual(project.stages);
    expect(copy.runtime).toEqual(project.runtime);
    expect(copy.pricing).toEqual(project.pricing);
    const job = await upload(f, 'clone');
    const { project: edited } = await f.json<{ project: ProjectSpec }>(
      '/api/projects/clone',
      { name: 'Changed' },
      'PUT',
    );
    expect(edited.runtime).toEqual(copy.runtime);
    expect(edited.pricing).toEqual(copy.pricing);
    expect((await f.job(job.id)).workflow!.project.name).toBe('Clone');
    const catalog = (await (await fetch(f.url + '/api/templates')).json()) as {
      saved: WorkflowTemplate[];
      builtins: WorkflowTemplate[];
    };
    expect(catalog.saved[0].definition.name).toBe('Cache');
    expect(catalog.builtins).toHaveLength(2);
    const invalid = structuredClone(template) as unknown as {
      definition: Record<string, unknown>;
      template: { hash: string };
    };
    invalid.definition.purpose = { invalid: true };
    invalid.template.hash = createHash('sha256')
      .update(canonical(invalid.definition))
      .digest('hex');
    expect((await f.response('/api/templates/validate', { template: invalid })).status).toBe(400);
    for (const template of catalog.builtins) await f.json('/api/templates/validate', { template });
    expect(
      (
        await f.response('/api/templates/validate', {
          template: { ...template, formatVersion: 99 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.response('/api/templates/validate', {
          template: { ...template, definition: { ...template.definition, purpose: 'tampered' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.response('/api/projects', {
          ...cached,
          id: 'unsafe',
          stages: [{ key: 'publish', cache: { enabled: true }, runner: { kind: 'human' } }],
        })
      ).status,
    ).toBe(400);
    await f.json('/api/templates', template.template, 'DELETE');
    expect((await (await fetch(f.url + '/api/templates')).json()).saved).toEqual([]);
  } finally {
    await f.close();
  }
});

it('restores verified results across server restart, bypasses selected reruns and recomputes corrupt entries', async () => {
  let f = await workflowFixture();
  try {
    await f.json('/api/projects', cached);
    const first = await upload(f, 'cache');
    expect(
      (await f.json<{ job: WorkflowJob | null }>('/api/jobs/claim', { protocol: 2 })).job,
    ).toBeNull();
    f.worker('process.exit(99)');
    const original = await f.until(first.id, 'done');
    expect(original.stages[0].completion?.mode).toBe('executed');
    await f.close(true);
    f = await workflowFixture(f.home);
    f.worker('process.exit(99)');
    const second = await f.until((await upload(f, 'cache')).id, 'done');
    expect(second.stages[0].completion).toMatchObject({
      mode: 'cached',
      jobId: first.id,
      task: 'publish',
      attempt: 1,
    });
    expect(second.stages[0].gates?.map((gate) => gate.scope)).toEqual([
      'input',
      'output',
      'stage',
      'final',
    ]);
    expect(readFileSync(path.join(f.home, 'calls'), 'utf8')).toBe('run\n');
    const { job: rerun } = await f.json<{ job: WorkflowJob }>(`/api/jobs/${second.id}/rerun`, {
      task: 'publish',
    });
    expect((await f.until(rerun.id, 'done')).stages[0].cache?.reason).toContain('再実行');
    const file = path.join(f.home, 'data/cache', second.stages[0].cache!.key!, 'files/report.html');
    chmodSync(file, 0o600);
    writeFileSync(file, 'corrupt');
    const third = await f.until((await upload(f, 'cache')).id, 'done');
    expect(third.stages[0].completion?.mode).toBe('executed');
    expect(await (await fetch(f.url + third.artifacts[0].uri)).text()).toBe('accepted');
    expect(readFileSync(path.join(f.home, 'calls'), 'utf8')).toBe('run\nrun\nrun\n');
    // Same contents, changed execute permission: output integrity includes file mode.
    chmodSync(file, 0o700);
    const fourth = await f.until((await upload(f, 'cache')).id, 'done');
    expect(fourth.stages[0].completion?.mode).toBe('executed');
    const stable = cacheIdentity(second, second.stages[0]).key;
    const variants = [structuredClone(second), structuredClone(second), structuredClone(second)];
    variants[0].workflow!.project.stages[0].instruction = 'changed';
    variants[1].stages[0].runtime!.revision = 'env-v2';
    variants[2].workflow!.project.stages[0].runner = command(
      "fs.writeFileSync('report.html','changed');",
    );
    for (const variant of variants)
      expect(cacheIdentity(variant, variant.stages[0]).key).not.toBe(stable);
    const volatile = structuredClone(second);
    volatile.workflow!.project.prompt = '{{job.id}}';
    expect(cacheIdentity(volatile, volatile.stages[0]).key).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('requires a fresh human approval on cache hits and never caches exception-approved failures', async () => {
  const f = await workflowFixture();
  try {
    const stage = { ...cached.stages[0], gate: { requireReview: true, condition: null } };
    await f.json('/api/projects', { ...cached, stages: [stage] });
    f.worker('process.exit(99)');
    const first = await f.until((await upload(f, 'cache')).id, 'review');
    await approve(f, first);
    const second = await f.until((await upload(f, 'cache')).id, 'review');
    expect(second.stages[0].completion?.mode).toBe('cached');
    expect(second.artifacts).toEqual([]);
    expect(second.stages[0].approvedAttempt).toBeUndefined();
    await approve(f, second);
    await f.json('/api/projects', {
      ...cached,
      id: 'exception',
      execution: { maxRetries: 0, onFailure: 'review' },
      stages: [
        {
          ...cached.stages[0],
          runner: command("fs.writeFileSync('report.html','partial');process.exit(1);"),
        },
      ],
    });
    const failed = await f.until((await upload(f, 'exception')).id, 'review');
    await approve(f, failed);
    const again = await f.until((await upload(f, 'exception')).id, 'review');
    expect(again.stages[0].completion?.mode).toBe('executed');
    expect(again.stages[0].failureKind).toBe('execution_error');
  } finally {
    await f.close();
  }
});

it('runs the CSV template incrementally with one isolated file per map task and invalidates shared-dataset tasks', async () => {
  const f = await workflowFixture();
  try {
    const catalog = (await (await fetch(f.url + '/api/templates')).json()) as {
      builtins: WorkflowTemplate[];
    };
    const { project } = await f.json<{ project: ProjectSpec }>('/api/projects', {
      name: 'Batch',
      id: 'batch',
      template: catalog.builtins[0],
    });
    f.worker('process.exit(99)');
    const first = await f.until(
      (await upload(f, 'batch', { 'A/data.csv': 'x\n1\n', 'B/data.csv': 'x\n2\n' })).id,
      'done',
    );
    const second = await f.until(
      (await upload(f, 'batch', { 'A/data.csv': 'x\n1\n', 'B/data.csv': 'x\n2\n3\n' })).id,
      'done',
    );
    expect(
      second.stages
        .filter((task) => task.completion?.mode === 'cached')
        .map((task) => task.item?.path),
    ).toEqual(['A/data.csv']);
    for (const task of second.stages.filter((task) => task.item)) {
      const manifest = JSON.parse(
        readFileSync(
          path.join(
            f.home,
            'projects/batch/work',
            second.id,
            task.workspace!,
            '_railflow/dataset.json',
          ),
          'utf8',
        ),
      );
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([task.item!.path]);
    }
    expect(second.stages.at(-1)?.completion?.mode).toBe('executed');
    const sharedA = structuredClone(first),
      sharedB = structuredClone(second);
    sharedA.workflow!.project.stages[0].map!.isolateInput = false;
    sharedB.workflow!.project.stages[0].map!.isolateInput = false;
    expect(cacheIdentity(sharedA, sharedA.stages[0]).key).not.toBe(
      cacheIdentity(sharedB, sharedB.stages[0]).key,
    );
    expect(project.runtime?.revision).toBe('csv-stdlib-v1');
  } finally {
    await f.close();
  }
});

it('fails environment requirements before running code and preserves the failed observation', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      ...cached,
      runtime: { revision: 'env-v1', expected: { node: '0.0.0' } },
    });
    f.worker('process.exit(99)');
    const job = await f.until((await upload(f, 'cache')).id, 'failed');
    expect(job.stages[0].failureKind).toBe('acceptance_failed');
    expect(job.stages[0].runtime?.issues[0]).toContain('node: 要求 0.0.0');
    expect(existsSync(path.join(f.home, 'calls'))).toBe(false);
    expect(job.artifacts).toEqual([]);
  } finally {
    await f.close();
  }
});

it('fences isolated-map jobs from older workers even when caching and environment requirements are disabled', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'scope',
      name: 'Scope',
      graph,
      stages: [
        { key: 'map', map: { pattern: '**/*.csv', isolateInput: true }, dependsOn: [] },
        { key: 'publish', dependsOn: ['map'] },
      ],
    });
    const job = await upload(f, 'scope');
    expect((await f.json<ClaimResponse>('/api/jobs/claim', { protocol: 2 })).job).toBeNull();
    expect((await f.json<ClaimResponse>('/api/jobs/claim', { protocol: 3 })).job?.id).toBe(job.id);
  } finally {
    await f.close();
  }
});

it.skipIf(process.platform === 'win32')(
  'fingerprints the executable actually selected by PATH and invalidates changed tools',
  async () => {
    const f = await workflowFixture();
    try {
      const a = path.join(f.home, 'first'),
        b = path.join(f.home, 'second');
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(path.join(a, 'probe-tool'), 'not executable', { mode: 0o600 });
      const executable = path.join(b, 'probe-tool');
      const code = (text: string) =>
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync('report.html',${JSON.stringify(text)});\n`;
      writeFileSync(executable, code('first'), { mode: 0o700 });
      await f.json('/api/projects', {
        ...cached,
        stages: [
          { ...cached.stages[0], runner: { kind: 'command', program: 'probe-tool', args: [] } },
        ],
      });
      f.worker('process.exit(99)', { PATH: [a, b, process.env.PATH].join(path.delimiter) });
      const first = await f.until((await upload(f, 'cache')).id, 'done');
      expect(first.stages[0].runtime?.program).toBe(executable);
      writeFileSync(executable, code('second'));
      const second = await f.until((await upload(f, 'cache')).id, 'done');
      expect(second.stages[0].completion?.mode).toBe('executed');
      expect(second.stages[0].runtime?.executableHash).not.toBe(
        first.stages[0].runtime?.executableHash,
      );
      expect(await (await fetch(f.url + second.artifacts[0].uri)).text()).toBe('second');
    } finally {
      await f.close();
    }
  },
);

it('records usage from failed attempts and exports frozen pricing and provenance without lease credentials', async () => {
  const f = await workflowFixture();
  try {
    await f.json('/api/projects', {
      id: 'usage',
      name: 'Usage',
      llm: { model: 'test-model' },
      execution: { maxRetries: 1, retryDelayMs: 1 },
      pricing: [rate],
      stages: [{ key: 'publish' }],
    });
    const job = await upload(f, 'usage');
    f.worker(
      cliPrelude +
        `\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:800,output_tokens:50}}));const marker=path.join(process.env.TEST_HOME,'used');if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');process.exitCode=1;}else fs.writeFileSync('report.html','done');`,
    );
    const done = await f.until(job.id, 'done');
    const metrics = usageSummary(done);
    expect(metrics.aiAttempts).toBe(2);
    expect(metrics.unknownAttempts).toBe(0);
    expect(metrics.input).toBe(400);
    expect(metrics.cacheRead).toBe(1600);
    expect(metrics.output).toBe(100);
    expect(metrics.estimatedCostUsd).toBeCloseTo(0.00086, 8);
    const resumed = structuredClone(done);
    resumed.agent = 'demo';
    resumed.events.push({
      type: 'job.claimed',
      jobId: done.id,
      projectId: done.projectId,
      sequence: done.events.at(-1)!.sequence + 1,
      at: new Date().toISOString(),
      agent: 'demo',
    });
    expect(usageSummary(resumed).estimatedCostUsd).toBe(metrics.estimatedCostUsd);
    expect(usageSummary(resumed).aiAttempts).toBe(2);

    await f.json('/api/projects/usage', { pricing: [{ ...rate, input: 100 }] }, 'PUT');
    const raw = await (await fetch(f.url + `/api/jobs/${job.id}/provenance`)).text();
    const exported = JSON.parse(raw);
    expect(exported.complete).toBe(true);
    expect(exported.metrics.estimatedCostUsd).toBeCloseTo(0.00086, 8);
    expect(exported.job.workflow.project.pricing[0].input).toBe(1);
    expect(raw).not.toContain('leaseToken');
    expect(raw).not.toContain('TEST_HOME');
  } finally {
    await f.close();
  }
});

it('distinguishes unknown, zero, partial and per-model CLI usage without counting streamed assistant copies', () => {
  const unknown = new UsageAccumulator('claude', 'alias');
  expect(priceUsage(unknown.record, []).estimatedCostUsd).toBeNull();
  unknown.accept({
    type: 'assistant',
    message: { usage: { input_tokens: 100, output_tokens: 50 } },
  });
  expect(unknown.record.models).toEqual([]);
  unknown.accept({
    type: 'result',
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  });
  expect(unknown.record.complete).toBe(false);
  expect(unknown.record.scope).toBe('main_loop');
  unknown.accept({
    type: 'result',
    modelUsage: {},
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  });
  expect(unknown.record.scope).toBe('main_loop');
  expect(unknown.record.complete).toBe(false);
  expect(unknown.record.reportedCostUsd).toBe(0);
  const terminal = {
    type: 'result',
    total_cost_usd: 0.25,
    modelUsage: {
      actual: {
        inputTokens: 200,
        outputTokens: 50,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 10,
      },
    },
  };
  unknown.accept(terminal);
  unknown.accept(terminal);
  expect(unknown.record.models).toEqual([
    { model: 'actual', input: 200, output: 50, cacheRead: 100, cacheWrite: 10 },
  ]);
  expect(unknown.record.complete).toBe(true);
  expect(
    priceUsage(unknown.record, [{ ...rate, engine: 'claude', model: 'actual' }]).estimatedCostUsd,
  ).toBeCloseTo(0.00038, 8);
  expect(canonical({ b: 2, a: { y: 2, x: 1 } })).toBe(canonical({ a: { x: 1, y: 2 }, b: 2 }));
});
