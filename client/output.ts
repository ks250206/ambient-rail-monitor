import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RailflowError, type BinaryInfo, type TextWindow } from './types.ts';

const MIB = 1024 * 1024;
const SNIFF_BYTES = 4096;
const MAX_WINDOW_BYTES = 65536;

interface WindowOptions {
  contentType: string;
  contentLength: number | null;
  offsetBytes?: number;
  maxBytes?: number;
  maxSkipBytes?: number;
}

function integer(value: number, label: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RailflowError({
      kind: 'usage',
      message: `${label} must be an integer from ${min} to ${max}`,
    });
}

function continuation(byte: number) {
  return (byte & 0xc0) === 0x80;
}

function completePrefix(bytes: Buffer): Buffer {
  if (bytes.length === 0 || bytes[bytes.length - 1] < 0x80) return bytes;
  let lead = bytes.length - 1;
  while (lead > 0 && continuation(bytes[lead]) && bytes.length - lead < 4) lead--;
  const byte = bytes[lead];
  const width =
    byte >= 0xf0 && byte <= 0xf4
      ? 4
      : byte >= 0xe0 && byte <= 0xef
        ? 3
        : byte >= 0xc2 && byte <= 0xdf
          ? 2
          : 1;
  return bytes.length - lead < width ? bytes.subarray(0, lead) : bytes;
}

function byteChunk(chunk: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === 'string'
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export async function readTextWindow(
  stream: Readable,
  {
    contentType,
    contentLength,
    offsetBytes = 0,
    maxBytes = SNIFF_BYTES,
    maxSkipBytes = MIB,
  }: WindowOptions,
): Promise<TextWindow | BinaryInfo> {
  try {
    integer(offsetBytes, 'offsetBytes', 0);
    integer(maxSkipBytes, 'maxSkipBytes', 0);
    integer(maxBytes, 'maxBytes', 1, MAX_WINDOW_BYTES);
    if (offsetBytes > maxSkipBytes)
      throw new RailflowError({
        kind: 'limit',
        message: `Text offset exceeds the ${maxSkipBytes}-byte skip limit`,
      });

    const mime = contentType.split(';', 1)[0].trim().toLowerCase();
    const binary: BinaryInfo = { binary: true, mimeType: contentType, bytes: contentLength };
    if (
      /^(image|audio|video|font)\//.test(mime) ||
      /^application\/(?:vnd\.openxmlformats(?:-|\.)|(?:pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|msword|vnd\.ms-excel|vnd\.ms-powerpoint)$)/.test(
        mime,
      )
    )
      return binary;
    const declaredText =
      mime.startsWith('text/') ||
      /(?:^application\/|\+)(?:json|xml)$/.test(mime) ||
      mime === 'application/javascript';
    const sniff = declaredText ? undefined : new TextDecoder('utf-8', { fatal: true });
    let sniffRemaining = sniff ? SNIFF_BYTES : 0;
    const window = Buffer.allocUnsafe(maxBytes + 1);
    let skipped = 0;
    let start = offsetBytes;
    let aligned = offsetBytes === 0;
    let collected = 0;

    for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
      const bytes = byteChunk(chunk);
      if (sniff && sniffRemaining > 0) {
        const sample = bytes.subarray(0, sniffRemaining);
        if (sample.includes(0)) return binary;
        try {
          sniff.decode(sample, { stream: true });
        } catch {
          return binary;
        }
        sniffRemaining -= sample.length;
      }
      if (collected < window.length) {
        let index = Math.min(offsetBytes - skipped, bytes.length);
        skipped += index;
        if (!aligned && skipped === offsetBytes) {
          const before = index;
          while (index < bytes.length && continuation(bytes[index])) index++;
          start += index - before;
          aligned = index < bytes.length;
        }
        collected += bytes.copy(
          window,
          collected,
          index,
          index + Math.min(bytes.length - index, window.length - collected),
        );
      }
      if (collected === window.length && sniffRemaining === 0) break;
    }

    if (sniff && sniffRemaining > 0) {
      try {
        sniff.decode();
      } catch {
        return binary;
      }
    }
    const truncated = collected > maxBytes;
    const bytes = window.subarray(0, Math.min(collected, maxBytes));
    const prefix = truncated ? completePrefix(bytes) : bytes;
    if (truncated && prefix.length === 0)
      throw new RailflowError({
        kind: 'limit',
        message: 'maxBytes is too small to fit the next UTF-8 character',
      });
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix);
    } catch {
      return binary;
    }
    return {
      text,
      offsetBytes: start,
      nextOffsetBytes: truncated ? start + prefix.length : null,
      truncated,
    };
  } finally {
    stream.destroy();
  }
}

export async function readTailLines(
  stream: Readable,
  lines: number,
  maxLineBytes = 65536,
): Promise<string> {
  try {
    integer(lines, 'lines', 1);
    integer(maxLineBytes, 'maxLineBytes', 1, MIB);
    const line = Buffer.allocUnsafe(maxLineBytes);
    // Bound both retained text and overhead from large numbers of short or empty lines.
    const capacity = Math.min(lines, MIB / 32);
    const ring: Array<{ text: string; cost: number }> = [];
    let head = 0;
    let count = 0;
    let cost = 0;
    let length = 0;
    let clipped = false;

    function finishLine() {
      const end = !clipped && length > 0 && line[length - 1] === 13 ? length - 1 : length;
      const text = completePrefix(line.subarray(0, end)).toString('utf8');
      const entry = { text, cost: text.length * 2 + 32 };
      while (count > 0 && (count === capacity || cost + entry.cost > MIB)) {
        cost -= ring[head].cost;
        // Release evicted strings even if this slot is not immediately reused.
        ring[head] = { text: '', cost: 0 };
        head = (head + 1) % capacity;
        count--;
      }
      ring[(head + count) % capacity] = entry;
      count++;
      cost += entry.cost;
      length = 0;
      clipped = false;
    }

    for await (const chunk of stream) {
      const bytes = byteChunk(chunk);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline;
        const copied = bytes.copy(
          line,
          length,
          start,
          Math.min(end, start + maxLineBytes - length),
        );
        length += copied;
        clipped ||= copied < end - start;
        if (newline === -1) break;
        finishLine();
        start = newline + 1;
      }
    }
    if (length > 0 || clipped) finishLine();
    return Array.from({ length: count }, (_, index) => ring[(head + index) % capacity].text).join(
      '\n',
    );
  } finally {
    stream.destroy();
  }
}

function isFsError(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function writeStreamToFile(
  stream: Readable,
  destination: string,
): Promise<{ path: string; bytes: number }> {
  const target = resolve(destination);
  const temporary = join(dirname(target), `.railflow-${randomUUID()}.tmp`);
  const exists = () =>
    new RailflowError({ kind: 'usage', message: `Destination already exists: ${destination}` });
  // The source can fail while the asynchronous destination check is in flight.
  const observeError = () => {};
  stream.on('error', observeError);
  let created = false;

  try {
    try {
      await lstat(target);
      throw exists();
    } catch (error) {
      if (!isFsError(error, 'ENOENT')) throw error;
    }
    if (stream.errored) throw stream.errored;
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true });
    output.once('open', () => {
      created = true;
    });
    await pipeline(stream, output);
    try {
      await link(temporary, target);
    } catch (error) {
      if (isFsError(error, 'EEXIST')) throw exists();
      throw error;
    }
    return { path: destination, bytes: output.bytesWritten };
  } finally {
    stream.destroy();
    stream.off('error', observeError);
    if (created) await unlink(temporary).catch(() => {});
  }
}
