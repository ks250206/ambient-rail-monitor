import type { Readable, Writable } from 'node:stream';
import {
  createMcpSession,
  errorResponse,
  INVALID_REQUEST,
  INTERNAL_ERROR,
  PARSE_ERROR,
  type JsonRpcResponse,
  type McpServerHandlers,
} from './protocol.ts';

export const MAX_FRAME_BYTES = 1024 * 1024;

interface StdioOptions {
  input: Readable;
  output: Writable;
  stderr?: Writable;
  handlers: McpServerHandlers;
  maxFrameBytes?: number;
  maxConcurrent?: number;
  signal?: AbortSignal;
}

export async function runStdioServer({
  input,
  output,
  stderr = process.stderr,
  handlers,
  maxFrameBytes = MAX_FRAME_BYTES,
  maxConcurrent,
  signal,
}: StdioOptions): Promise<void> {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new RangeError('maxFrameBytes must be a positive integer');
  }
  const done = Promise.withResolvers<void>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let partial = Buffer.alloc(0);
  let length = 0;
  let stopped = false;
  let outputFailed = false;
  let queue = Promise.resolve();
  let queued = 0;
  let releaseWrite: (() => void) | undefined;

  const onDiagnostic =
    handlers.onDiagnostic ??
    ((message: string) => {
      stderr.write(message + '\n');
    });
  const session = createMcpSession({ ...handlers, onDiagnostic }, send, { maxConcurrent });

  function stop() {
    if (!stopped) {
      stopped = true;
      session.close();
      input.off('readable', readAvailable);
      input.destroy();
    }
    if (queued === 0) done.resolve();
  }

  function stopOutput() {
    outputFailed = true;
    stop();
    releaseWrite?.();
  }

  function writeLine(line: string): Promise<void> {
    return new Promise((resolve) => {
      if (outputFailed || !output.writable) {
        stopOutput();
        resolve();
        return;
      }
      function release() {
        output.off('drain', onDrain);
        releaseWrite = undefined;
        resolve();
      }
      let flushed = false;
      let drained = false;
      function onDrain() {
        drained = true;
        if (flushed) release();
      }
      releaseWrite = release;
      try {
        drained = output.write(line, (error) => {
          // Node emits 'error' after invoking the failing write callback.
          if (error) return;
          flushed = true;
          if (drained) release();
        });
        if (!drained) output.once('drain', onDrain);
      } catch {
        stopOutput();
      }
    });
  }

  function send(response: JsonRpcResponse) {
    if (stopped) return;
    let line: string;
    try {
      line = JSON.stringify(response) + '\n';
    } catch {
      onDiagnostic('MCP response serialization failed');
      line = JSON.stringify(errorResponse(response.id, INTERNAL_ERROR, 'Internal error')) + '\n';
    }
    queued++;
    queue = queue
      .then(() => writeLine(line))
      .then(() => {
        queued--;
        if (queued !== 0) return;
        if (stopped) done.resolve();
        else readAvailable();
      });
  }

  function consumeLine(bytes: Buffer) {
    let message: unknown;
    try {
      const line = decoder.decode(bytes);
      if (line.trim().length === 0) return;
      message = JSON.parse(line);
    } catch {
      send(errorResponse(null, PARSE_ERROR, 'Parse error'));
      return;
    }
    void session.handleMessage(message).catch(stop);
  }

  function consume(chunk: Buffer) {
    for (let start = 0; start < chunk.length && !stopped;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const size = length + end - start;
      // A terminal CR may be the first byte of a split CRLF delimiter.
      const lastByte = end > start ? chunk[end - 1] : partial[length - 1];
      const payloadBytes = lastByte === 13 ? size - 1 : size;
      if (payloadBytes > maxFrameBytes) {
        send(errorResponse(null, INVALID_REQUEST, 'Frame exceeds maximum size'));
        stop();
        return;
      }
      if (length === 0 && newline >= 0) {
        consumeLine(chunk.subarray(start, end));
      } else {
        if (size > partial.length) {
          const grown = Buffer.allocUnsafe(
            Math.min(maxFrameBytes + 1, Math.max(size, partial.length * 2)),
          );
          partial.copy(grown, 0, 0, length);
          partial = grown;
        }
        chunk.copy(partial, length, start, end);
        length = size;
        if (newline >= 0) {
          consumeLine(partial.subarray(0, length));
          length = 0;
        }
      }
      start = end + 1;
    }
  }

  function readAvailable() {
    // Limit how much input can generate replies before the writer drains.
    while (!stopped && queued === 0 && input.readableLength > 0) {
      const chunk: unknown = input.read(Math.min(16 * 1024, input.readableLength));
      if (chunk === null) break;
      if (!Buffer.isBuffer(chunk)) {
        stop();
        return;
      }
      consume(chunk);
    }
    if (!stopped && input.readableLength === 0) input.read(0);
  }

  output.on('error', stopOutput);
  output.on('close', stopOutput);
  output.on('finish', stopOutput);
  input.on('error', stop);
  input.on('end', stop);
  input.on('close', stop);
  input.on('readable', readAvailable);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted || input.destroyed || input.readableEnded || !output.writable) stop();
    await done.promise;
  } finally {
    input.off('error', stop);
    input.off('end', stop);
    input.off('close', stop);
    output.off('error', stopOutput);
    output.off('close', stopOutput);
    output.off('finish', stopOutput);
    signal?.removeEventListener('abort', stop);
  }
}
