import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, it } from 'vite-plus/test';

import type { AppStateResponse, WorkflowJob } from '../shared/types.ts';

it.skipIf(process.platform === 'win32')(
  'publishes reports written only in the Codex workspace',
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-worker-'));
    // Stand in for the CLI. Its publish stage writes two deliverables and an intermediate HTML file.
    writeFileSync(
      path.join(home, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.at(-1).includes('stage "publish"')) {
  fs.writeFileSync('report.html', '<h1>Workflow report</h1>');
  fs.writeFileSync('report.pptx', Buffer.from([80, 75, 3, 4]));
  fs.writeFileSync('report_template.html', 'intermediate');
}
`,
      { mode: 0o755 },
    );
    const env = { ...process.env, RAILFLOW_HOME: home, HOST: '127.0.0.1', PORT: '0' };
    const server = spawn(process.execPath, ['server.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const serverExit = once(server, 'exit');
    const lines = createInterface({ input: server.stdout });

    try {
      const [line] = await once(lines, 'line');
      const api = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      expect(api).toBeTruthy();
      const created = await fetch(`${api}/api/demo`, { method: 'POST', body: '{}' });
      const { job } = (await created.json()) as { job: WorkflowJob };
      const worker = spawn(process.execPath, ['worker.ts', '--mode=codex'], {
        env: { ...env, RAILFLOW_URL: api, PATH: home + path.delimiter + process.env.PATH },
        stdio: 'ignore',
      });
      const workerExit = once(worker, 'exit');
      try {
        const getJob = async () => {
          const state = (await (await fetch(`${api}/api/state`)).json()) as AppStateResponse;
          return state.jobs.find((item) => item.id === job.id)!;
        };
        await expect
          .poll(async () => (await getJob()).status, { timeout: 12000 })
          .toMatch(/^(done|failed)$/);
        const result = await getJob();
        expect(result.status).toBe('done');
        expect(result.stages.find((stage) => stage.key === 'publish')?.attempts).toBe(1);
        expect(result.artifacts.map((artifact) => artifact.name).sort()).toEqual([
          'report.html',
          'report.pptx',
        ]);
        const [html, slides] = await Promise.all(
          result.artifacts.map((artifact) => fetch(api + artifact.uri)),
        );
        expect(await html.text()).toBe('<h1>Workflow report</h1>');
        expect(new Uint8Array(await slides.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
      } finally {
        worker.kill();
        await workerExit;
      }
    } finally {
      lines.close();
      server.kill();
      await serverExit;
      rmSync(home, { recursive: true, force: true });
    }
  },
);
