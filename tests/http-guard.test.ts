import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vite-plus/test';
import { expandJsonBody, executeGraph } from '../shared/graph-runtime.ts';
import {
  BlockedHttpTarget,
  assertAllowedUrl,
  canonicalAddress,
  guardedLookup,
  guardedRequest,
  isForbiddenAddress,
  isSelfAddress,
  selfTargetFor,
} from '../shared/http-guard.ts';
import type { PromptVariables } from '../shared/prompts.ts';
import type { ProjectSpec, WorkflowJob } from '../shared/types.ts';

it('blocks link-local and metadata addresses in every IPv4/IPv6 spelling', () => {
  for (const address of [
    '169.254.169.254',
    '0.0.0.0',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    // WHATWG URL normalises [::ffff:169.254.169.254] to this hex form.
    new URL('http://[::ffff:169.254.169.254]/').hostname,
    '::ffff:169.254.169.254',
    '::169.254.169.254',
    '64:ff9b::a9fe:a9fe',
  ])
    expect(isForbiddenAddress(address), address).toBe(true);
  for (const address of ['127.0.0.1', '::1', '8.8.8.8', '2001:db8::1', '10.0.0.1'])
    expect(isForbiddenAddress(address), address).toBe(false);
  expect(canonicalAddress('[::ffff:a9fe:a9fe]')).toEqual({
    address: '169.254.169.254',
    family: 'ipv4',
  });
  expect(() => assertAllowedUrl(new URL('http://[::ffff:169.254.169.254]/latest'))).toThrow(
    BlockedHttpTarget,
  );
  expect(() => assertAllowedUrl(new URL('http://2852039166/'))).toThrow(BlockedHttpTarget);
});

it('refuses loopback aliases of the control API port but allows other local services', () => {
  const self = selfTargetFor('http://127.0.0.1:4173')!;
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:7f00:1'])
    expect(isSelfAddress(address, 4173, self), address).toBe(true);
  expect(isSelfAddress('127.0.0.1', 8080, self)).toBe(false);
  for (const url of ['http://localhost:4173/api', 'http://[::1]:4173/', 'http://127.1:4173/'])
    expect(() => assertAllowedUrl(new URL(url), self), url).toThrow(BlockedHttpTarget);
  expect(() => assertAllowedUrl(new URL('http://localhost:8080/'), self)).not.toThrow();
});

it('checks every DNS answer at connect time', async () => {
  const resolveTo =
    (...addresses: string[]) =>
    (
      _host: string,
      _options: unknown,
      callback: (error: null, list: { address: string; family: number }[]) => void,
    ) =>
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
  const run = (lookup: ReturnType<typeof guardedLookup>, all = false) =>
    new Promise<unknown>((resolve, reject) =>
      lookup('metadata.example', { all } as never, (error: unknown, address: unknown) =>
        error ? reject(error) : resolve(address),
      ),
    );
  await expect(run(guardedLookup(80, undefined, resolveTo('169.254.169.254')))).rejects.toThrow(
    BlockedHttpTarget,
  );
  // One forbidden answer among several refuses the whole name (no fallback to it).
  await expect(
    run(guardedLookup(80, undefined, resolveTo('93.184.216.34', 'fd00:ec2::254')), true),
  ).rejects.toThrow(BlockedHttpTarget);
  const self = selfTargetFor('http://127.0.0.1:4173');
  await expect(run(guardedLookup(4173, self, resolveTo('127.0.0.1')))).rejects.toThrow(
    'コントロールAPI',
  );
  await expect(run(guardedLookup(80, self, resolveTo('93.184.216.34')))).resolves.toBe(
    '93.184.216.34',
  );
});

it('sends HTTP stage requests without following redirects and with a size cap', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      return res.end();
    }
    if (req.url === '/large') {
      res.writeHead(200);
      return res.end(Buffer.alloc(2048));
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;
  const options = {
    headers: {},
    signal: AbortSignal.timeout(5000),
    maxBytes: 1024,
    self: selfTargetFor('http://127.0.0.1:1'),
  };
  try {
    const echoed = await guardedRequest(new URL(base + '/echo'), {
      ...options,
      method: 'POST',
      body: '{"a":1}',
      expectStatus: 201,
    });
    expect(String(echoed.body)).toBe('{"a":1}');
    await expect(
      guardedRequest(new URL(base + '/redirect'), { ...options, method: 'GET', expectStatus: 200 }),
    ).rejects.toThrow('HTTP 302');
    await expect(
      guardedRequest(new URL(base + '/large'), { ...options, method: 'GET', expectStatus: 200 }),
    ).rejects.toThrow('上限');
    await expect(
      guardedRequest(new URL(base + '/echo'), {
        ...options,
        method: 'GET',
        expectStatus: 201,
        self: selfTargetFor(`http://127.0.0.1:${port}`),
      }),
    ).rejects.toThrow(BlockedHttpTarget);
  } finally {
    server.close();
  }
});

it('JSON-escapes body variables so a filename cannot inject fields', () => {
  const variables = {
    'dataset.name': 'x", "admin": true, "y": "\\\n',
    'input.count': '3',
  } as unknown as PromptVariables;
  const body = expandJsonBody('{"name":"{{dataset.name}}","count":{{input.count}}}', variables);
  expect(JSON.parse(body)).toEqual({ name: 'x", "admin": true, "y": "\\\n', count: 3 });
  // A variable placed outside a string literal cannot smuggle structure either.
  expect(() =>
    expandJsonBody('{"n":{{dataset.name}}}', {
      'dataset.name': '1, "admin": true',
    } as unknown as PromptVariables),
  ).toThrow('有効なJSON');
  expect(expandJsonBody('', variables)).toBe('');
});

function budgetFixture(stageTimeoutMs: number, activeMs: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'railflow-budget-'));
  const project = {
    name: 'budget',
    llm: {},
    execution: { maxRetries: 0, stageTimeoutMs },
    graph: { mode: 'dag', maxParallelTasks: 2, publishStage: 'a' },
    stages: [
      {
        key: 'a',
        label: 'A',
        instruction: '',
        llm: {},
        runner: { kind: 'command', program: 'true', args: [] },
      },
    ],
  } as unknown as ProjectSpec;
  const server = { status: 'pending', failureKind: undefined as string | undefined };
  const snapshot = () =>
    ({
      id: 'run_00000000',
      status: 'running',
      file: 'x',
      artifacts: [],
      activeMs: 0,
      dataset: { files: [] },
      events: [{ type: 'job.claimed', at: new Date().toISOString() }],
      stages: [
        {
          key: 'a',
          label: 'A',
          status: server.status,
          failureKind: server.failureKind,
          attempts: 1,
          activeMs,
          dependsOn: [],
        },
      ],
    }) as unknown as WorkflowJob;
  return {
    dir,
    project,
    server,
    snapshot,
    paths: { work: dir, artifacts: path.join(dir, 'artifacts'), inputDir: dir, manifest: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

it('records an exhausted stage budget on the server instead of spinning', async () => {
  const fx = budgetFixture(1000, 1200);
  const emitted: { type: string; failureKind?: unknown }[] = [];
  let reloads = 0;
  try {
    await executeGraph(fx.snapshot(), fx.paths as never, fx.project, {
      signal: AbortSignal.timeout(5000),
      mode: 'codex',
      emit: async (type, _task, _message, more) => {
        emitted.push({ type, failureKind: more?.failureKind });
        if (type === 'stage.failed') {
          fx.server.status = 'failed';
          fx.server.failureKind = String(more?.failureKind);
        }
        return {} as never;
      },
      reload: async () => {
        reloads++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return fx.snapshot();
      },
      runAI: async () => '',
      runDemo: async () => {},
      // The budget is exhausted before any stage reaches the cache lookup.
      cache: async () => ({}) as never,
    });
    expect(emitted).toEqual([
      { type: 'stage.failed', failureKind: 'stage_timeout' },
      { type: 'job.failed', failureKind: undefined },
    ]);
    expect(reloads).toBeLessThan(5);
  } finally {
    fx.cleanup();
  }
});

it('fails the job when the budget failure cannot be recorded', async () => {
  const fx = budgetFixture(1000, 1200);
  const emitted: string[] = [];
  let reloads = 0;
  try {
    await executeGraph(fx.snapshot(), fx.paths as never, fx.project, {
      signal: AbortSignal.timeout(5000),
      mode: 'codex',
      emit: async (type) => {
        emitted.push(type);
        if (type === 'stage.failed') throw new Error('409 conflict');
        return {} as never;
      },
      reload: async () => {
        reloads++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return fx.snapshot();
      },
      runAI: async () => '',
      runDemo: async () => {},
      // The budget is exhausted before any stage reaches the cache lookup.
      cache: async () => ({}) as never,
    });
    expect(emitted).toEqual(['stage.failed', 'job.failed']);
    expect(reloads).toBeLessThan(5);
  } finally {
    fx.cleanup();
  }
});
