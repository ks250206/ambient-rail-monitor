import { realpath, stat } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { resolveConfig } from '../client/config.ts';
import { createMcpHandlers } from './catalog.ts';
import { usage } from './schemas.ts';
import { runStdioServer } from './stdio.ts';

export interface RunMcpOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  output?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
  version?: string;
}

const options = {
  server: { type: 'string' },
  'request-timeout-ms': { type: 'string' },
  'upload-root': { type: 'string' },
} as const;

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options }).values;
  } catch (error) {
    return usage(error instanceof Error ? error.message : 'Invalid MCP options');
  }
}

async function resolveUploadRoot(input: string) {
  try {
    if (input) {
      const root = await realpath(input);
      if ((await stat(root)).isDirectory()) return root;
    }
  } catch {
    // A missing or inaccessible path is reported as a startup usage error.
  }
  return usage('The upload root must be an existing directory');
}

export async function runMcp({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  signal,
  version,
}: RunMcpOptions = {}): Promise<void> {
  const values = parseOptions(argv);
  const timeout = values['request-timeout-ms'];
  if (timeout !== undefined && (!timeout || /[^0-9]/.test(timeout)))
    usage('--request-timeout-ms must be a positive integer');
  // MCP tools receive their project explicitly and do not use the CLI project default.
  const config = resolveConfig(
    {
      server: values.server,
      requestTimeoutMs: timeout === undefined ? undefined : Number(timeout),
    },
    { RAILFLOW_SERVER: env.RAILFLOW_SERVER },
  );
  const root = values['upload-root'];
  const uploadRoot = root === undefined ? undefined : await resolveUploadRoot(root);
  const handlers = createMcpHandlers({ ...config, signal, version, uploadRoot });
  await runStdioServer({ input, output, stderr, signal, handlers });
}
