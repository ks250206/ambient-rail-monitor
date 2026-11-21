import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type RequestId = string | number;
type ResponseId = RequestId | null;
type Reply = { jsonrpc: '2.0'; id: ResponseId } & (
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReply(line: string): Reply {
  const message: unknown = JSON.parse(line);
  if (
    !isObject(message) ||
    message.jsonrpc !== '2.0' ||
    !(message.id === null || typeof message.id === 'string' || Number.isFinite(message.id)) ||
    Object.keys(message).length !== 3 ||
    Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')
  ) {
    throw new Error('Expected a JSON-RPC 2.0 response');
  }
  if (
    'error' in message &&
    (!isObject(message.error) ||
      !Number.isInteger(message.error.code) ||
      typeof message.error.message !== 'string')
  ) {
    throw new Error('Expected a JSON-RPC error with an integer code and string message');
  }
  return message as Reply;
}

interface PendingReply {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

interface Closed {
  exitCode: number | null;
  stderr: string;
}

export class McpWireClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<Closed>;
  private readonly timeoutMs: number;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly pending = new Map<ResponseId, PendingReply>();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private partial = Buffer.alloc(0);
  private failure?: Error;
  private receivedClose = false;
  private closing?: Promise<Closed>;
  readonly stdoutLines: string[] = [];

  constructor(entryPath: string, args: string[] = [], timeoutMs = 12_000) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(process.execPath, [entryPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.readStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.stderrChunks.push(chunk));
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.closed = new Promise((resolve) => {
      this.child.once('close', (exitCode, signal) => {
        this.receivedClose = true;
        if (this.partial.length) this.fail(new Error('Unterminated JSON-RPC line on MCP stdout'));
        if (this.pending.size) {
          this.fail(new Error(`MCP exited with pending requests (${signal ?? exitCode})`));
        }
        resolve({ exitCode, stderr: this.stderr });
      });
    });
  }

  get stdout() {
    return Buffer.concat(this.stdoutChunks);
  }

  get stderr() {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }

  get exited() {
    return this.receivedClose;
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
  }

  private readStdout(chunk: Buffer) {
    this.stdoutChunks.push(chunk);
    const bytes = Buffer.concat([this.partial, chunk]);
    let start = 0;
    for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, start)) {
      try {
        const line = this.decoder.decode(bytes.subarray(start, newline));
        this.stdoutLines.push(line);
        const reply = parseReply(line);
        const pending = this.pending.get(reply.id);
        if (!pending) throw new Error(`Unexpected response ID ${JSON.stringify(reply.id)}`);
        pending.resolve(reply);
      } catch (error) {
        this.fail(
          new Error(`Invalid MCP stdout line: ${bytes.subarray(start, newline).toString()}`, {
            cause: error,
          }),
        );
      }
      start = newline + 1;
    }
    this.partial = bytes.subarray(start);
  }

  sendRaw(data: string | Buffer) {
    this.child.stdin.write(data);
  }

  waitForResponse(id: ResponseId, timeoutMs = this.timeoutMs): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (this.exited) return reject(new Error(`MCP exited before response ${id}\n${this.stderr}`));
      if (this.pending.has(id)) return reject(new Error(`Already awaiting response ${id}`));

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response ${id}\n${this.stderr}`));
      }, timeoutMs);
      const clear = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve(reply) {
          clear();
          resolve(reply);
        },
        reject(error) {
          clear();
          reject(error);
        },
      });
    });
  }

  request(id: RequestId, method: string, params?: object, timeoutMs = this.timeoutMs) {
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    const reply = this.waitForResponse(id, timeoutMs);
    this.sendRaw(frame);
    return reply;
  }

  notify(method: string, params?: object) {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(version = '2025-11-25'): Promise<unknown> {
    const reply = await this.request('initialize', 'initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'railflow-wire-test', version: '1.0.0' },
    });
    if ('error' in reply) throw new Error(`MCP initialize failed: ${JSON.stringify(reply.error)}`);
    this.notify('notifications/initialized');
    return reply.result;
  }

  close(): Promise<Closed> {
    return (this.closing ??= this.closeChild());
  }

  private async closeChild(): Promise<Closed> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), this.timeoutMs);
    try {
      const outcome = await this.closed;
      if (this.failure) throw this.failure;
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }
}
