#!/usr/bin/env node
import { runCli } from './cli/main.ts';
import { runMcp } from './mcp/main.ts';

const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGINT', abort);
process.on('SIGTERM', abort);

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    signal: controller.signal,
    runMcp: (argv, env) => runMcp({ argv, env, signal: controller.signal }),
  });
} finally {
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
}
