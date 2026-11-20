import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, it } from 'vite-plus/test';

import type { AppStateResponse, WorkflowJob } from '../shared/types.ts';

it.skipIf(process.platform === 'win32')(
  'passes workflow model/effort flags, captures LLM stage summaries, and publishes workspace reports',
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'railflow-worker-'));
    const argvLog = path.join(home, 'codex-args.jsonl');
    // Stand in for the CLI. Records invoked flags, writes LLM summaries, and emits publish reports.
    writeFileSync(
      path.join(home, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv.at(-1) || '';
const stageMatch = prompt.match(/running stage "([^"]+)"/);
const stage = stageMatch ? stageMatch[1] : 'unknown';
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ stage, args: process.argv.slice(2, -1) }) + '\\n');
if (stage === 'ingest') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'LLM応答フォールバック: 141行のCSVを検証済み' } }));
}
if (stage === 'publish') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Optional renderer unavailable' } }));
  fs.writeFileSync('summary_publish.txt', 'LLM要約: report.html と report.pptx を出力し、全受け入れ要件を確認しました。');
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

      const specRes = await fetch(`${api}/api/workflow`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'XPS 解析',
          purpose: 'テスト用ワークフロー',
          acceptanceCriteria: '- report.html を出力すること',
          llm: { model: 'gpt-5.4', effort: 'high' },
          stageLlm: {
            ingest: { model: 'gpt-5.3-codex', effort: 'low' },
            preprocess: { model: '', effort: '' },
            analysis: { model: '', effort: 'max' },
            validate: { model: '', effort: '' },
            visualize: { model: '', effort: '' },
            publish: { model: '', effort: '' },
          },
          stageInstructions: {
            ingest: '',
            preprocess: '',
            analysis: '',
            validate: '',
            visualize: '',
            publish: '',
          },
        }),
      });
      expect(specRes.status).toBe(200);

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
        expect(result.events).toContainEqual(
          expect.objectContaining({
            type: 'agent.event',
            stage: 'publish',
            message: 'item.completed · error: Optional renderer unavailable',
          }),
        );

        // Verify explicit LLM summary file takes precedence, and agent_message works as fallback.
        expect(result.stages.find((stage) => stage.key === 'publish')?.summary).toBe(
          'LLM要約: report.html と report.pptx を出力し、全受け入れ要件を確認しました。',
        );
        expect(result.stages.find((stage) => stage.key === 'ingest')?.summary).toBe(
          'LLM応答フォールバック: 141行のCSVを検証済み',
        );

        // Verify model and effort CLI flags passed to Codex per stage.
        const invocations = readFileSync(argvLog, 'utf8')
          .trim()
          .split('\n')
          .map((row) => JSON.parse(row) as { stage: string; args: string[] });
        const ingestCall = invocations.find((entry) => entry.stage === 'ingest');
        expect(ingestCall?.args).toContain('--model');
        expect(ingestCall?.args).toContain('gpt-5.3-codex');
        expect(ingestCall?.args).toContain('model_reasoning_effort="low"');

        const analysisCall = invocations.find((entry) => entry.stage === 'analysis');
        expect(analysisCall?.args).toContain('gpt-5.4');
        expect(analysisCall?.args).toContain('model_reasoning_effort="xhigh"');

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
