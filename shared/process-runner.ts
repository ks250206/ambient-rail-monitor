import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { FailureKind } from './execution-policy.ts';

export class ExecutionFailure extends Error {
  kind: FailureKind;
  /** False for deterministic failures that would fail identically on every retry. */
  retryable: boolean;
  constructor(kind: FailureKind, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = options.retryable ?? true;
  }
}

/** Retrying cannot help: the same prompt or the same altered input fails again. */
export function isDeterministicFailure(error: unknown): boolean {
  return error instanceof ExecutionFailure && !error.retryable;
}

/** Grace between TERM and KILL of the CLI process group (supervisor side). */
export const DEFAULT_PROCESS_GRACE_MS = 500;
/** Extra time before the runner force-kills a supervisor that did not exit after TERM. */
export const PROCESS_KILL_FALLBACK_MS = 1500;

/** Own the process group so a timed-out attempt cannot keep writing during a retry. */
export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    timeoutKind: FailureKind;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string, signal: AbortSignal) => Promise<void> | void;
    graceMs?: number;
  },
): Promise<void> {
  if (options.signal?.aborted)
    throw new ExecutionFailure('interrupted', 'ワーカーが停止されました。');
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./process-supervisor.ts', import.meta.url)), command, ...args],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        RAILFLOW_SUPERVISOR_GRACE_MS: String(options.graceMs ?? DEFAULT_PROCESS_GRACE_MS),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let failure: ExecutionFailure | undefined;
  let stderr = '';
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const telemetry = new AbortController();
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid || closed) return;
    try {
      child.kill(signal);
    } catch {
      /* The supervisor has already exited. */
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
    if (closed) return;
    child.stdin.end();
    killTree('SIGTERM');
    killTimer ??= setTimeout(
      () => killTree('SIGKILL'),
      (options.graceMs ?? DEFAULT_PROCESS_GRACE_MS) + PROCESS_KILL_FALLBACK_MS,
    );
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
    child.stdin.end();
    if (killTimer) clearTimeout(killTimer);
    killTree('SIGKILL');
    closed = true;
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
