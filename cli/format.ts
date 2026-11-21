import { createReadStream } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { BytesResponse, RailflowHttpClient } from '../client/http.ts';
import type { createOperations } from '../client/operations.ts';
import { readTailLines, writeStreamToFile } from '../client/output.ts';
import { RailflowError, type RailflowErrorData } from '../client/types.ts';

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usage(message: string): never {
  throw new RailflowError({ kind: 'usage', message });
}

export function checkInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RailflowError({ kind: 'interrupted', message: 'Interrupted' });
}

export function integer(raw: string, label: string, min = 1): number {
  const value = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < min)
    usage(`${label} must be an integer of at least ${min}`);
  return value;
}

type Flags = Record<string, string | boolean | undefined>;

export interface CommandContext {
  args: string[];
  client: RailflowHttpClient;
  ops: ReturnType<typeof createOperations>;
  signal?: AbortSignal;
  projectId?: string;
  project(): string;
  explicitProject(): string;
  enabled(name: string): boolean;
  option(name: string): string | undefined;
  required(name: string): string;
  confirm(): void;
  readJson(path: string): Promise<unknown>;
  output: ReturnType<typeof createOutput>;
}

export interface Command {
  usage: string;
  options: readonly string[];
  positionals: number | 'project' | 'paths';
  run(context: CommandContext): Promise<number | void>;
}

export function command(
  usage: string,
  options: Command['options'],
  positionals: Command['positionals'],
  run: Command['run'],
): Command {
  return { usage, options, positionals, run };
}

export function commandOptions(flags: Flags) {
  function option(name: string): string | undefined {
    const value = flags[name];
    if (typeof value !== 'string') return undefined;
    if (!value.trim()) usage(`--${name} requires a non-empty value`);
    return value;
  }
  return {
    option,
    required(name: string) {
      return option(name) ?? usage(`--${name} is required`);
    },
    enabled: (name: string) => flags[name] === true,
    confirm() {
      if (flags.yes !== true) usage('This command requires --yes to confirm');
    },
  };
}

async function readBounded(
  chunks: AsyncIterable<Buffer | string>,
  tooLarge: () => never,
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BUFFERED_BYTES) tooLarge();
    buffers.push(bytes);
  }
  return Buffer.concat(buffers, size);
}

export async function readLocalJson(path: string, stdin: Readable, signal?: AbortSignal) {
  checkInterrupted(signal);
  const source = path === '-' ? stdin : createReadStream(path, { signal });
  const stop = () =>
    source.destroy(new RailflowError({ kind: 'interrupted', message: 'Interrupted' }));
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const bytes = await readBounded(source, () => usage('JSON input exceeds 16 MiB'));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    checkInterrupted(signal);
    usage(`Cannot read JSON from ${path === '-' ? 'stdin' : path}: ${messageOf(error)}`);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

function errorExit(data: RailflowErrorData): number {
  switch (data.kind) {
    case 'usage':
      return 2;
    case 'transport':
      return 3;
    case 'http':
      return data.status === 409 ? 5 : data.status === 422 ? 6 : 4;
    case 'protocol':
    case 'limit':
      return 4;
    case 'timeout':
      return 9;
    case 'outcome_unknown':
      return 10;
    case 'interrupted':
      return 130;
  }
}

function writeChunk(sink: Writable, chunk: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function binaryMime(contentType: string) {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mime === 'image/svg+xml') return false;
  return (
    /^(image|audio|video|font)\//.test(mime) ||
    /^application\/(?:vnd\.openxmlformats[.-]|(?:pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|msword|vnd\.ms-excel|vnd\.ms-powerpoint)$)/.test(
      mime,
    )
  );
}

function binary(): never {
  return usage('Binary output requires --out FILE');
}

function verifyText(text: string): void {
  if (text.includes('\0')) binary();
}

async function* verifiedText(response: BytesResponse): AsyncIterable<string> {
  if (binaryMime(response.contentType)) binary();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  function decode(chunk?: Buffer | Uint8Array | string) {
    let text: string;
    try {
      text = decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, {
        stream: chunk !== undefined,
      });
    } catch {
      return binary();
    }
    verifyText(text);
    return text;
  }
  // Check the opening bytes before sending any text from a mislabeled response.
  let opening = '';
  let checked = false;
  for await (const chunk of response.stream) {
    const text = decode(chunk);
    if (checked) {
      yield text;
    } else {
      opening += text;
      if (opening.length >= 4096) {
        yield opening;
        opening = '';
        checked = true;
      }
    }
  }
  yield opening + decode();
}

export async function saveStream(stream: Readable, path: string) {
  try {
    return await writeStreamToFile(stream, path);
  } catch (error) {
    if (error instanceof RailflowError) throw error;
    if (error instanceof Error && 'path' in error) usage(`Cannot write ${path}: ${error.message}`);
    throw error;
  }
}

export function createOutput(
  stdout: Writable,
  stderr: Writable,
  json: boolean,
  isTTY: boolean,
  signal?: AbortSignal,
) {
  function print(value: unknown) {
    stdout.write(JSON.stringify(value, null, json ? undefined : 2) + '\n');
  }

  async function withResponse<T>(response: BytesResponse, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof RailflowError) throw error;
      checkInterrupted(signal);
      if (error instanceof Error && response.stream.errored === error)
        throw new RailflowError({ kind: 'transport', message: messageOf(error) });
      throw error;
    } finally {
      response.close();
    }
  }

  return {
    json,
    isTTY,
    print,
    text(text: string) {
      stdout.write(text);
    },
    diagnostic(message: string) {
      stderr.write(message + '\n');
    },
    error(error: unknown) {
      const data =
        error instanceof RailflowError
          ? error.data
          : {
              kind: 'internal' as const,
              message: messageOf(error),
            };
      if (json) {
        stderr.write(JSON.stringify({ error: data }) + '\n');
      } else {
        const context = [
          'operation' in data && data.operation,
          'status' in data && data.status !== undefined && `HTTP ${data.status}`,
          'uploadId' in data && data.uploadId && `uploadId=${data.uploadId}`,
          'jobId' in data && data.jobId && `jobId=${data.jobId}`,
        ]
          .filter(Boolean)
          .join(' · ');
        stderr.write(`railflow: ${data.message}${context ? ` (${context})` : ''}\n`);
        if (data.kind === 'http' && data.status === 409) {
          const area = data.operation?.split('.')[0];
          if (area === 'projects') stderr.write('Re-fetch the project with projects get.\n');
          if (area === 'review') stderr.write('Re-fetch the review with review list.\n');
          if (area === 'jobs' || area === 'rerun')
            stderr.write('Re-fetch the job with jobs get.\n');
          if (area === 'templates') stderr.write('Re-fetch the templates with templates list.\n');
        }
        if ('result' in data && data.result)
          stderr.write(JSON.stringify(data.result, null, 2) + '\n');
      }
      return data.kind === 'internal' ? 1 : errorExit(data);
    },
    async tail(response: BytesResponse, count: number) {
      await withResponse(response, async () => {
        if (isTTY && !json && binaryMime(response.contentType)) binary();
        const text = await readTailLines(response.stream, count);
        if (json) print({ text });
        else if (text) {
          if (isTTY) verifyText(text);
          stdout.write(text + '\n');
        }
      });
    },
    async stream(response: BytesResponse, destination?: string) {
      await withResponse(response, async () => {
        if (destination) {
          print(await saveStream(response.stream, destination));
        } else if (json) {
          const bytes = await readBounded(verifiedText(response), () => {
            throw new RailflowError({
              kind: 'limit',
              message: 'JSON output exceeds 16 MiB. Use --out FILE.',
            });
          });
          print({ text: bytes.toString('utf8') });
        } else {
          const chunks = isTTY ? verifiedText(response) : response.stream;
          for await (const chunk of chunks) await writeChunk(stdout, chunk);
        }
      });
    },
  };
}
