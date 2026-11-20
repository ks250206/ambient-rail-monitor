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
let timer: ReturnType<typeof setTimeout> | undefined;
const kill = (signal: NodeJS.Signals) => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const task = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      task.on('error', () => child.kill(signal));
    } else process.kill(-child.pid, signal);
  } catch {
    /* The process group has already exited. */
  }
};
const stop = () => {
  if (timer) return;
  kill('SIGTERM');
  timer = setTimeout(
    () => kill('SIGKILL'),
    Math.max(0, Number(process.env.RAILFLOW_SUPERVISOR_GRACE_MS) || 500),
  );
};
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  kill('SIGKILL');
  if (timer) clearTimeout(timer);
  process.stdin.destroy();
  process.exit(code ?? 1);
});
