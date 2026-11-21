import type { Readable, Writable } from 'node:stream';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { resolveConfig } from '../client/config.ts';
import { createClient } from '../client/http.ts';
import { createOperations } from '../client/operations.ts';
import packageInfo from '../package.json' with { type: 'json' };
import { inputCommands } from './commands/inputs.ts';
import { jobCommands } from './commands/jobs.ts';
import { projectCommands } from './commands/projects.ts';
import { reviewCommands } from './commands/review.ts';
import {
  checkInterrupted,
  commandOptions,
  createOutput,
  integer,
  readLocalJson,
  usage,
  type Command,
} from './format.ts';

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  isTTY?: boolean;
  signal?: AbortSignal;
  version?: string;
  clientFactory?: typeof createClient;
  runMcp?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<void>;
}

const commands: Record<string, Command> = {
  health: {
    usage: 'health',
    options: [],
    positionals: 0,
    async run({ ops, output }) {
      output.print(await ops.health());
    },
  },
  ...projectCommands,
  ...inputCommands,
  ...jobCommands,
  ...reviewCommands,
};

const mcpOptions = ['server', 'request-timeout-ms', 'upload-root', 'help', 'version'];
const mcpUsage = 'mcp [--upload-root DIR] [--server URL] [--request-timeout-ms N]';
const globalOptions = ['server', 'project', 'json', 'request-timeout-ms', 'help', 'version'];
const booleanOptions = new Set(['json', 'help', 'version', 'yes', 'watch', 'review', 'exception']);
const allOptions = new Set([
  ...globalOptions,
  ...mcpOptions,
  ...Object.values(commands).flatMap(({ options }) => options),
]);

const parserOptions: ParseArgsOptionsConfig = Object.fromEntries(
  [...allOptions].map((name) => [
    name,
    {
      type: booleanOptions.has(name) ? 'boolean' : 'string',
      ...(name === 'help' && { short: 'h' }),
    },
  ]),
);

function help(lines: string[]) {
  return [
    'Usage: railflow [options] <command>',
    '',
    'Commands:',
    ...lines.map((line) => `  ${line}`),
    '',
    'Global options:',
    '  --server URL  --project P  --json  --request-timeout-ms N  --help, -h  --version',
    '',
  ].join('\n');
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    isTTY = stdout === process.stdout && Boolean(process.stdout.isTTY),
    signal,
    version = packageInfo.version,
    clientFactory = createClient,
    runMcp,
  } = runtime;
  const parsed = parseArgs({
    args: argv,
    options: parserOptions,
    // Read tokens to enforce each command's option set and support signed job priorities.
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const output = createOutput(stdout, stderr, parsed.values.json === true, isTTY, signal);
  try {
    const positionals: string[] = [];
    const positionalIndices = new Set<number>();
    const optionNames = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind === 'positional') {
        positionals.push(token.value);
        positionalIndices.add(token.index);
      } else if (token.kind === 'option') {
        if (/^-[0-9]+$/.test(argv[token.index])) {
          if (!positionalIndices.has(token.index)) positionals.push(argv[token.index]);
          positionalIndices.add(token.index);
          continue;
        }
        if (!allOptions.has(token.name)) usage(`Unknown option: ${token.rawName}`);
        if (booleanOptions.has(token.name)) {
          if (token.value !== undefined) usage(`${token.rawName} takes no value`);
        } else if (
          token.value === undefined ||
          (!token.inlineValue && token.value.startsWith('-') && token.value !== '-')
        ) {
          usage(`${token.rawName} requires a value`);
        }
        optionNames.add(token.name);
      }
    }

    const first = positionals[0];
    const isMcp = first === 'mcp';
    const route = [3, 2, 1]
      .map((size) => positionals.slice(0, size).join(' '))
      .find((name) => Object.hasOwn(commands, name));
    const selected = route === undefined ? undefined : commands[route];
    const allowed = isMcp ? mcpOptions : selected && [...globalOptions, ...selected.options];
    if (allowed) {
      for (const option of optionNames) {
        if (!allowed.includes(option))
          usage(`--${option} is not valid for ${isMcp ? 'mcp' : route}`);
      }
    }

    const flags = commandOptions(parsed.values);
    const commandUsages = [...Object.values(commands).map((entry) => entry.usage), mcpUsage];
    if (flags.enabled('version')) {
      if (output.json) output.print({ version });
      else output.text(version + '\n');
      return 0;
    }
    if (flags.enabled('help')) {
      const prefix = positionals.join(' ');
      const matches = commandUsages.filter(
        (line) => line === prefix || line.startsWith(prefix + ' '),
      );
      const text = help(matches.length ? matches : commandUsages);
      if (output.json) output.print({ help: text });
      else output.text(text);
      return 0;
    }

    checkInterrupted(signal);
    if (isMcp) {
      if (positionals.length !== 1) usage(`Usage: railflow ${mcpUsage}`);
      if (!runMcp) usage('MCP is unavailable in this entry point');
      const [commandIndex] = positionalIndices;
      await runMcp(
        argv.filter((_, index) => index !== commandIndex),
        env,
      );
      return 0;
    }

    if (!selected || !route)
      usage(
        first
          ? `Unknown command: ${positionals.join(' ')}. See --help.`
          : 'A command is required. See --help.',
      );
    const definition = selected;
    const args = positionals.slice(route.split(' ').length);
    const expected = definition.positionals;
    if (
      (typeof expected === 'number' && args.length !== expected) ||
      (expected === 'project' && args.length > 1) ||
      (expected === 'paths' && args.length === 0) ||
      args.some((value) => !value.trim())
    )
      usage(`Usage: railflow ${definition.usage}`);

    const explicitProject = flags.option('project');
    const positionalProject = expected === 'project' ? args[0] : undefined;
    if (
      positionalProject !== undefined &&
      explicitProject !== undefined &&
      positionalProject !== explicitProject
    )
      usage('Positional project ID conflicts with --project');
    const specifiedProject = positionalProject ?? explicitProject;

    const timeout = flags.option('request-timeout-ms');
    const config = resolveConfig(
      {
        server: flags.option('server'),
        project: specifiedProject,
        requestTimeoutMs:
          timeout === undefined ? undefined : integer(timeout, '--request-timeout-ms'),
      },
      env,
    );
    const client = clientFactory({
      origin: config.origin,
      requestTimeoutMs: config.requestTimeoutMs,
      signal,
    });
    const ops = createOperations(client, config.origin);
    const result = await definition.run({
      ...flags,
      args,
      client,
      ops,
      output,
      signal,
      projectId: config.projectId,
      project: () =>
        config.projectId ?? usage('Specify a project ID with --project or RAILFLOW_PROJECT'),
      explicitProject: () =>
        specifiedProject ?? usage('Specify a positional project ID or use --project P'),
      readJson: (path) => readLocalJson(path, stdin, signal),
    });
    return result ?? 0;
  } catch (error) {
    return output.error(error);
  }
}
