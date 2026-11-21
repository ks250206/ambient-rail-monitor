#!/usr/bin/env node
import { RailflowError } from './client/types.ts';
import { runMcp } from './mcp/main.ts';

const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGINT', abort);
process.on('SIGTERM', abort);

try {
  await runMcp({
    argv: process.argv.slice(2),
    env: process.env,
    signal: controller.signal,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`railflow-mcp: ${message}\n`);
  process.exitCode = error instanceof RailflowError && error.kind === 'usage' ? 2 : 1;
} finally {
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
}
