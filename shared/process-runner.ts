import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { FailureKind } from './execution-policy.ts';

export class ExecutionFailure extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Own the process group so a timed-out attempt cannot keep writing during a retry. */
export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    timeoutKind: FailureKind;
    signal?: AbortSignal;
    onLine?: (line: string, signal: AbortSignal) => Promise<void> | void;
    graceMs?: number;
  },
): Promise<void> {
  if (options.signal?.aborted)
    throw new ExecutionFailure('interrupted', 'ワーカーが停止されました。');
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure: ExecutionFailure | undefined;
  let stderr = '';
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const telemetry = new AbortController();
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill(signal));
      } else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
    }
  };
  const stop = (kind: FailureKind) => {
    failure ??= new ExecutionFailure(
      kind,
      kind === 'interrupted'
        ? 'ワーカーが停止されました。'
        : `実行時間の上限に達しました (${kind})。`,
    );
    telemetry.abort();
    killTree('SIGTERM');
    killTimer ??= setTimeout(() => killTree('SIGKILL'), options.graceMs ?? 1000);
  };
  const onAbort = () => stop('interrupted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = Number.isFinite(options.timeoutMs)
    ? setTimeout(() => stop(options.timeoutKind), Math.max(1, options.timeoutMs))
    : undefined;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + String(chunk)).slice(-3000);
  });
  const reader = readline.createInterface({ input: child.stdout });
  const events = new Set<Promise<void>>();
  reader.on('line', (line) => {
    if (!options.onLine || telemetry.signal.aborted) return;
    let result: Promise<void> | void;
    try {
      result = options.onLine(line, telemetry.signal);
    } catch {
      return;
    } // Malformed CLI telemetry must not crash the worker.
    if (result) {
      const pending = result
        .catch(() => {
          /* Log failures do not strand the child. */
        })
        .finally(() => events.delete(pending));
      events.add(pending);
    }
  });
  // Also reap background descendants when the parent exits normally.
  child.on('exit', () => killTree('SIGKILL'));
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    killTree('SIGKILL');
    reader.close();
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(events),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
          telemetry.abort();
          resolve();
        }, 1000);
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
    telemetry.abort();
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
  // A process that handles TERM and exits zero still exceeded its deadline.
  if (failure) throw failure;
  if (code !== 0)
    throw new ExecutionFailure(
      'execution_error',
      `${command} exited ${String(code)}: ${stderr.slice(-450)}`,
    );
}
