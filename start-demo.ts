import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, ['server.ts'], { cwd: root, stdio: 'inherit' });
const worker = spawn(process.execPath, ['worker.ts', '--mode=demo'], {
  cwd: root,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.kill(signal);
    worker.kill(signal);
    process.exit(0);
  });
}

server.on('exit', () => worker.kill());
worker.on('exit', () => server.kill());
