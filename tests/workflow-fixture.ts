import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect } from 'vite-plus/test';
import type { AppStateResponse, WorkflowJob } from '../shared/types.ts';

export async function workflowFixture(existingHome?: string, env: Record<string, string> = {}) {
  const home = existingHome ?? mkdtempSync(path.join(os.tmpdir(), 'railflow-policy-'));
  const server = spawn(process.execPath, ['server.ts'], {
    env: { ...process.env, RAILFLOW_HOME: home, HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  server.stderr.on('data', (chunk: Buffer) => {
    diagnostic += String(chunk);
  });
  const serverExit = once(server, 'exit');
  const lines = createInterface({ input: server.stdout });
  const [line] = await once(lines, 'line');
  const url = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)![0];
  const workers: Array<{ close: () => Promise<void> }> = [];
  async function response(route: string, body: unknown = {}, method = 'POST') {
    return fetch(url + route, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function json<T>(route: string, body: unknown = {}, method = 'POST'): Promise<T> {
    const res = await response(route, body, method);
    const value = await res.json();
    expect(res.ok, JSON.stringify(value) + diagnostic).toBe(true);
    return value as T;
  }
  async function state(): Promise<AppStateResponse> {
    return (await fetch(url + '/api/state')).json() as Promise<AppStateResponse>;
  }
  async function job(id: string) {
    return (await state()).jobs.find((item) => item.id === id)!;
  }
  async function until(id: string, status: WorkflowJob['status']) {
    await expect
      .poll(async () => (await job(id)).status, { timeout: 9000, interval: 60 })
      .toBe(status);
    return job(id);
  }
  function worker(script: string) {
    writeFileSync(path.join(home, 'codex'), '#!/usr/bin/env node\n' + script, { mode: 0o755 });
    const child = spawn(process.execPath, ['worker.ts', '--mode=codex'], {
      env: {
        ...process.env,
        PATH: home + path.delimiter + process.env.PATH,
        RAILFLOW_URL: url,
        TEST_HOME: home,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic += String(chunk);
    });
    const exit = once(child, 'exit');
    let closed = false;
    const handle = {
      kill: () => child.kill('SIGKILL'),
      close: async () => {
        if (closed) return;
        closed = true;
        child.kill();
        await exit;
      },
    };
    workers.push(handle);
    return handle;
  }
  return {
    home,
    url,
    response,
    json,
    state,
    job,
    until,
    worker,
    close: async (keep = false) => {
      for (const child of workers) await child.close();
      lines.close();
      server.kill();
      await serverExit;
      if (!keep) rmSync(home, { recursive: true, force: true });
    },
  };
}

export const cliPrelude = `const fs = require('node:fs');
const path = require('node:path');
const prompt = process.argv.at(-1);
const stage = prompt.match(/running stage "([^"]+)"/)[1];
const attempt = Number(prompt.match(/ATTEMPT: (\\d+)/)[1]);
fs.appendFileSync(path.join(process.env.TEST_HOME, 'calls.jsonl'), JSON.stringify({stage, attempt, prompt, cwd: process.cwd()}) + '\\n');
`;
