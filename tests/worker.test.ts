import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, it } from 'vite-plus/test';

import type { AppStateResponse, WorkflowJob } from '../shared/types.ts';

it.skipIf(process.platform === 'win32')(
  'runs custom-stage project workflow, passes model/effort flags, captures LLM summaries, and publishes project artifacts',
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-worker-'));
    const argvLog = path.join(home, 'codex-args.jsonl');
    // Stand in for the CLI. Records invoked flags, writes LLM summaries, and emits final reports.
    writeFileSync(
      path.join(home, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv.at(-1) || '';
const stageMatch = prompt.match(/running stage "([^"]+)"/);
const stage = stageMatch ? stageMatch[1] : 'unknown';
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ stage, args: process.argv.slice(2, -1) }) + '\\n');
if (stage === 'inspect') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'LLM応答フォールバック: 141行のCSVを検証済み' } }));
}
if (stage === 'deliver') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Optional renderer unavailable' } }));
  fs.writeFileSync('summary_deliver.txt', 'LLM要約: report.html と report.pptx を出力し、全受け入れ要件を確認しました。');
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

      const createProjRes = await fetch(`${api}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'custom-xps',
          name: 'カスタム XPS 解析',
          purpose: '3工程のカスタムワークフロー',
          acceptanceCriteria: '- report.html を出力すること',
          llm: { model: 'gpt-5.4', effort: 'high' },
          stages: [
            {
              key: 'inspect',
              label: '入力検品',
              short: 'Inspect',
              instruction: '列と欠損を確認',
              llm: { model: 'gpt-5.3-codex', effort: 'low' },
            },
            {
              key: 'quantify',
              label: '定量解析',
              short: 'Quantify',
              instruction: '最大ピークを算出',
              llm: { model: '', effort: 'max' },
            },
            {
              key: 'deliver',
              label: '成果物公開',
              short: 'Deliver',
              instruction: 'report.html を出力',
              llm: { model: '', effort: '' },
            },
          ],
        }),
      });
      expect(createProjRes.status).toBe(201);

      const created = await fetch(`${api}/api/demo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'custom-xps' }),
      });
      const { job } = (await created.json()) as { job: WorkflowJob };
      expect(job.projectId).toBe('custom-xps');
      expect(job.stages).toHaveLength(3);

      const worker = spawn(
        process.execPath,
        ['worker.ts', '--mode=codex', '--project=custom-xps'],
        {
          env: { ...env, RAILFLOW_URL: api, PATH: home + path.delimiter + process.env.PATH },
          stdio: 'ignore',
        },
      );
      const workerExit = once(worker, 'exit');
      try {
        const getJob = async () => {
          const state = (await (
            await fetch(`${api}/api/state?project=custom-xps`)
          ).json()) as AppStateResponse;
          return state.jobs.find((item) => item.id === job.id)!;
        };
        await expect
          .poll(async () => (await getJob()).status, { timeout: 12000 })
          .toMatch(/^(done|failed)$/);
        const result = await getJob();
        expect(result.status).toBe('done');
        expect(result.events).toContainEqual(
          expect.objectContaining({
            type: 'agent.event',
            stage: 'deliver',
            message: 'item.completed · error: Optional renderer unavailable',
          }),
        );

        // Verify explicit LLM summary file takes precedence, and agent_message works as fallback.
        expect(result.stages.find((stage) => stage.key === 'deliver')?.summary).toBe(
          'LLM要約: report.html と report.pptx を出力し、全受け入れ要件を確認しました。',
        );
        expect(result.stages.find((stage) => stage.key === 'inspect')?.summary).toBe(
          'LLM応答フォールバック: 141行のCSVを検証済み',
        );

        // Verify model and effort CLI flags passed to Codex for each custom stage.
        const invocations = readFileSync(argvLog, 'utf8')
          .trim()
          .split('\n')
          .map((row) => JSON.parse(row) as { stage: string; args: string[] });
        expect(invocations.map((entry) => entry.stage)).toEqual(['inspect', 'quantify', 'deliver']);

        const inspectCall = invocations.find((entry) => entry.stage === 'inspect');
        expect(inspectCall?.args).toContain('--model');
        expect(inspectCall?.args).toContain('gpt-5.3-codex');
        expect(inspectCall?.args).toContain('model_reasoning_effort="low"');

        const quantifyCall = invocations.find((entry) => entry.stage === 'quantify');
        expect(quantifyCall?.args).toContain('gpt-5.4');
        expect(quantifyCall?.args).toContain('model_reasoning_effort="xhigh"');

        expect(result.stages.find((stage) => stage.key === 'deliver')?.attempts).toBe(1);
        expect(result.artifacts.map((artifact) => artifact.name).sort()).toEqual([
          'report.html',
          'report.pptx',
        ]);
        expect(result.artifacts[0].uri).toMatch(/^\/artifacts\/custom-xps\/run_/);
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
