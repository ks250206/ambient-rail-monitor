import { spawn } from 'node:child_process';

// This small guardian outlives a SIGKILL of the worker. Its stdin pipe closes when
// the parent disappears; that is independent of application heartbeat timers.
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'inherit', 'inherit'],
});
const rawGrace = Number(process.env.RAILFLOW_SUPERVISOR_GRACE_MS);
const graceMs = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : 500;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let exited = false;
let winTaskKilled = false;
const kill = (signal: NodeJS.Signals) => {
  if (!child.pid || exited) return;
  try {
    if (process.platform === 'win32') {
      if (winTaskKilled) return;
      winTaskKilled = true;
      const task = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      task.on('error', () => {
        try {
          child.kill(signal);
        } catch {
          /* Process already exited. */
        }
      });
    } else process.kill(-child.pid, signal);
  } catch {
    /* The process group has already exited. */
  }
};
const stop = () => {
  if (stopping || exited) return;
  stopping = true;
  kill('SIGTERM');
  timer = setTimeout(() => kill('SIGKILL'), graceMs);
};
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', (error) => {
  exited = true;
  if (timer) clearTimeout(timer);
  console.error(error.message);
  process.stdin.destroy();
  process.exit(1);
});
child.on('exit', (code) => {
  kill('SIGKILL');
  exited = true;
  if (timer) clearTimeout(timer);
  process.stdin.destroy();
  process.exit(code ?? 1);
});
