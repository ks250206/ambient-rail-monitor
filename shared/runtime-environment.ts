import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from './process-runner.ts';
import { parseRuntime, runtimeIssues, type RuntimeSnapshot } from './reuse.ts';
import type { ProjectSpec, WorkflowStageSpec } from './types.ts';

const identities = new Map<string, { stamp: string; hash: string }>();
async function executable(program: string, signal: AbortSignal, work: string) {
  const choices =
    program.includes('/') || program.includes('\\')
      ? [program]
      : (process.env.PATH ?? '')
          .split(path.delimiter)
          .flatMap((dir) =>
            process.platform === 'win32'
              ? (process.env.PATHEXT ?? '.EXE;.CMD')
                  .split(';')
                  .map((ext) => path.join(dir, program + ext.toLowerCase()))
              : [path.join(dir, program)],
          );
  const file = choices
    .map((candidate) => path.resolve(work, candidate))
    .find((candidate) => {
      try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!file) return { program, hash: null };
  const resolved = realpathSync(file);
  const before = statSync(resolved);
  const stamp = `${before.size}/${before.mtimeMs}/${before.ctimeMs}`;
  const saved = identities.get(resolved);
  if (saved?.stamp === stamp) return { program: resolved, hash: saved.hash };
  if (before.size > 512 * 1024 * 1024) return { program: resolved, hash: null };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolved, { signal })) hash.update(chunk);
  const after = statSync(resolved);
  if (`${after.size}/${after.mtimeMs}/${after.ctimeMs}` !== stamp)
    return { program: resolved, hash: null };
  const value = hash.digest('hex');
  identities.set(resolved, { stamp, hash: value });
  return { program: resolved, hash: value };
}

export async function inspectRuntime(
  project: ProjectSpec,
  stage: WorkflowStageSpec,
  mode: string,
  work: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<RuntimeSnapshot> {
  const deadline = performance.now() + timeoutMs;
  const profile = parseRuntime(project.runtime);
  const runner = stage.runner ?? { kind: 'ai', engine: 'worker' };
  const engine =
    runner.kind === 'ai' ? (runner.engine === 'worker' ? mode : runner.engine) : runner.kind;
  const python = profile.python || process.env.RAILFLOW_PYTHON || 'python3';
  const program =
    runner.kind === 'python'
      ? python
      : runner.kind === 'command'
        ? runner.program
        : ['codex', 'claude'].includes(engine)
          ? engine
          : process.execPath;
  const identity = await executable(program, signal, work);
  const result: RuntimeSnapshot = {
    version: 1,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    engine,
    program: identity.program,
    executableHash: identity.hash,
    toolVersion: identity.program === realpathSync(process.execPath) ? process.versions.node : null,
    python: null,
    packages: {},
    revision: profile.revision,
    issues: [],
  };
  const probe = async (command: string, args: string[]) => {
    let text = '';
    await runCommand(command, args, {
      cwd: work,
      signal,
      timeoutMs: Math.max(1, Math.min(5000, deadline - performance.now())),
      timeoutKind: 'timeout',
      onLine: (line) => {
        if (text.length < 128_000) text += line + '\n';
      },
    });
    return text.trim();
  };
  if (['codex', 'claude'].includes(engine)) {
    try {
      result.toolVersion =
        (await probe(program, ['--version'])).match(
          /\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/,
        )?.[0] ?? null;
    } catch {
      result.toolVersion = null;
    }
  }
  if (
    runner.kind === 'python' ||
    profile.python ||
    profile.expected.python ||
    Object.keys(profile.packages).length
  ) {
    try {
      const raw = JSON.parse(
        await probe(python, [
          '-c',
          'import json, platform, importlib.metadata as m\nprint(json.dumps({"version": platform.python_version(), "packages": {d.metadata["Name"].lower().replace("_", "-").replace(".", "-"): d.version for d in m.distributions() if d.metadata["Name"]}}))',
        ]),
      ) as { version: string; packages: Record<string, string> };
      result.python = raw.version;
      result.packages = raw.packages;
      if (runner.kind === 'python') result.toolVersion = raw.version;
    } catch {
      result.python = null;
    }
  }
  result.issues = runtimeIssues(profile, result);
  return result;
}

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('実行環境の記録が不正です。');
  const raw = value as Record<string, unknown>;
  const text = (key: string, max = 512) => {
    const value = raw[key];
    if (typeof value !== 'string' || value.length > max)
      throw new Error('実行環境の文字列が不正です。');
    return value;
  };
  const nullable = (key: string, max: number) => (raw[key] === null ? null : text(key, max));
  if (
    raw.version !== 1 ||
    !raw.packages ||
    typeof raw.packages !== 'object' ||
    Array.isArray(raw.packages) ||
    Object.keys(raw.packages).length > 3000
  )
    throw new Error('実行環境の形式が不正です。');
  const packages: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw.packages)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) ||
      typeof version !== 'string' ||
      version.length > 100
    )
      throw new Error('パッケージの記録が不正です。');
    Object.defineProperty(packages, name, { value: version, enumerable: true });
  }
  const executableHash = nullable('executableHash', 64);
  if (executableHash !== null && !/^[a-f0-9]{64}$/.test(executableHash))
    throw new Error('実行ファイルhashが不正です。');
  const recordedAt = text('recordedAt', 40);
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('環境の記録日時が不正です。');
  return {
    version: 1,
    recordedAt,
    platform: text('platform', 30),
    arch: text('arch', 30),
    node: text('node', 80),
    engine: text('engine', 30),
    program: text('program'),
    executableHash,
    toolVersion: nullable('toolVersion', 80),
    python: nullable('python', 80),
    packages,
    revision: text('revision', 120),
    issues: [],
  };
}
