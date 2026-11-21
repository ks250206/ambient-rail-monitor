import { constants, type BigIntStats, type ReadStream } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validRelativePath } from '../shared/conditions.ts';
import { INPUT_LIMITS } from '../shared/input-limits.ts';
import type { WorkflowJob } from '../shared/types.ts';
import type { RailflowHttpClient } from './http.ts';
import { RailflowError } from './types.ts';

export interface UploadPolicy {
  allowedRoot?: string;
  name?: string;
}

export interface CollectedFile {
  path: string;
  bytes: number;
  // Local file identity is used to verify the source before and after reading.
  localPath: string;
  dev: bigint | number;
  ino: bigint | number;
  mtimeNs: bigint;
  size: number;
}

export interface UploadSelection {
  name: string;
  kind: 'file' | 'directory';
  files: CollectedFile[];
  totalBytes: number;
}

interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, file: string) => void;
}

const UPLOAD_ID = /^[a-f0-9-]{36}$/;
const FILE_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export function publicManifest({ name, kind, files }: UploadSelection) {
  return { name, kind, files: files.map(({ path, bytes }) => ({ path, bytes })) };
}

function usage(message: string): RailflowError {
  return new RailflowError({ kind: 'usage', message });
}

async function inspect(localPath: string, label: string): Promise<BigIntStats> {
  const stat = await lstat(localPath, { bigint: true }).catch(() => {
    throw usage(`Cannot inspect input: ${label}`);
  });
  if (stat.isSymbolicLink()) throw usage(`Symbolic links cannot be uploaded: ${label}`);
  return stat;
}

async function inspectPath(root: string, parts: string[], label: string) {
  let localPath = root;
  for (const part of parts.slice(0, -1)) {
    localPath = join(localPath, part);
    if (!(await inspect(localPath, label)).isDirectory()) {
      throw usage(`Input has a non-directory path component: ${label}`);
    }
  }
  localPath = join(localPath, parts.at(-1) ?? '');
  return { localPath, stat: await inspect(localPath, label) };
}

async function inspectLocalInput(input: string) {
  const absolutePath = resolve(input);
  const leaf = basename(absolutePath);
  const parent = await realpath(dirname(absolutePath)).catch(() => {
    throw usage(`Cannot resolve input parent: ${leaf}`);
  });
  const localPath = join(parent, leaf);
  return { localPath, stat: await inspect(localPath, leaf) };
}

async function canonicalUploadRoot(input: string): Promise<string> {
  if (!input) throw usage('Upload root must be an existing directory');
  const root = await realpath(input).catch(() => {
    throw usage('Upload root must be an existing directory');
  });
  if (!(await inspect(root, 'upload root')).isDirectory()) {
    throw usage('Upload root must be an existing directory');
  }
  return root;
}

async function verifyContainment(root: string, localPath: string, label: string): Promise<void> {
  const resolved = await realpath(localPath).catch(() => {
    throw usage(`Cannot resolve input: ${label}`);
  });
  const within = relative(root, resolved);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw usage(`Input must be inside the upload root: ${label}`);
  }
}

export async function collectSelection(
  inputPaths: string[],
  policy?: UploadPolicy,
): Promise<UploadSelection> {
  if (!inputPaths.length) throw usage('Select at least one input file or directory');
  const allowedRoot =
    policy?.allowedRoot === undefined ? undefined : await canonicalUploadRoot(policy.allowedRoot);
  const files: CollectedFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  let kind: UploadSelection['kind'] = 'directory';
  let name = policy?.name || 'dataset';

  async function visit(localPath: string, path: string, stat: BigIntStats): Promise<void> {
    if (!validRelativePath(path)) throw usage(`Invalid relative path: ${path}`);
    if (path.split('/').length > INPUT_LIMITS.depth) {
      throw new RailflowError({ kind: 'limit', message: `Input path is too deep: ${path}` });
    }
    if (allowedRoot) await verifyContainment(allowedRoot, localPath, path);
    if (stat.isDirectory()) {
      await visitChildren(localPath, path);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw usage(`Input must be a regular file with one link: ${path}`);
    }
    const bytes = Number(stat.size);
    if (
      files.length >= INPUT_LIMITS.files ||
      bytes > INPUT_LIMITS.fileBytes ||
      totalBytes + bytes > INPUT_LIMITS.totalBytes
    ) {
      throw new RailflowError({
        kind: 'limit',
        message: 'Input exceeds the limit of 1,000 files, 20 MiB per file, or 200 MiB total',
      });
    }
    const portable = path.normalize('NFC').toLowerCase();
    if (paths.has(portable)) throw usage(`Duplicate relative path: ${path}`);
    paths.add(portable);
    totalBytes += bytes;
    files.push({
      path,
      bytes,
      localPath,
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      size: bytes,
    });
  }

  async function visitChildren(localPath: string, prefix: string): Promise<void> {
    const children = await readdir(localPath).catch(() => {
      throw usage(`Cannot list input directory: ${prefix || basename(localPath)}`);
    });
    for (const child of children) {
      const childPath = join(localPath, child);
      const path = prefix ? `${prefix}/${child}` : child;
      await visit(childPath, path, await inspect(childPath, path));
    }
  }

  for (const input of inputPaths) {
    if (!input || input.includes('\0')) throw usage('Invalid input path');
    if (allowedRoot && !validRelativePath(input)) {
      throw usage('Upload paths must be safe paths relative to the upload root');
    }
    const { localPath, stat } = allowedRoot
      ? await inspectPath(allowedRoot, input.split('/'), input)
      : await inspectLocalInput(input);
    if (inputPaths.length === 1) {
      name = policy?.name || basename(localPath);
      if (stat.isDirectory()) {
        if (allowedRoot) await verifyContainment(allowedRoot, localPath, input);
        await visitChildren(localPath, '');
        continue;
      }
      kind = 'file';
    }
    await visit(localPath, basename(localPath), stat);
  }

  if (!files.length) throw usage('The selected dataset contains no files');
  for (const file of paths) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      if (paths.has(prefix)) throw usage(`File and directory paths conflict: ${prefix}`);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { name, kind, files, totalBytes };
}

function matchesFile(stat: BigIntStats, file: CollectedFile): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1n &&
    stat.dev === BigInt(file.dev) &&
    stat.ino === BigInt(file.ino) &&
    stat.size === BigInt(file.size) &&
    stat.mtimeNs === file.mtimeNs
  );
}

async function putFile(
  client: RailflowHttpClient,
  uploadId: string,
  file: CollectedFile,
  signal?: AbortSignal,
): Promise<void> {
  const changed = () =>
    new RailflowError({
      kind: 'usage',
      message: `File changed during upload: ${file.path}`,
      uploadId,
    });
  let handle: FileHandle;
  try {
    const stat = await inspect(file.localPath, file.path);
    if (!matchesFile(stat, file)) throw changed();
    handle = await open(file.localPath, FILE_OPEN_FLAGS);
  } catch {
    throw changed();
  }

  let stream: ReadStream | undefined;
  let uploaded = false;
  try {
    async function verifyOpenFile() {
      const stat = await handle.stat({ bigint: true }).catch(() => {
        throw changed();
      });
      if (!matchesFile(stat, file)) throw changed();
    }
    await verifyOpenFile();
    if (constants.O_NOFOLLOW === undefined) {
      const stat = await inspect(file.localPath, file.path).catch(() => {
        throw changed();
      });
      if (!matchesFile(stat, file)) throw changed();
    }

    const source = handle.createReadStream({ autoClose: false });
    stream = source;
    let verified = false;
    let readFailure: unknown;
    async function* body() {
      try {
        let bytesRead = 0;
        let lastChunk: Buffer | undefined;
        for await (const chunk of source as AsyncIterable<Buffer>) {
          bytesRead += chunk.length;
          if (bytesRead > file.bytes) throw changed();
          // Keep the request incomplete until the read and identity checks succeed.
          if (bytesRead === file.bytes) lastChunk = chunk;
          else yield chunk;
        }
        if (bytesRead !== file.bytes) throw changed();
        await verifyOpenFile();
        verified = true;
        if (lastChunk) yield lastChunk;
      } catch (error) {
        readFailure = error;
        throw error;
      }
    }
    await client
      .putBytes(`/api/uploads/${uploadId}/files?path=${encodeURIComponent(file.path)}`, body(), {
        contentLength: file.bytes,
        operation: 'upload.file',
        signal,
        uploadId,
      })
      .catch((error: unknown) => {
        // A failed body may close the socket before HTTP reports the source error.
        throw readFailure ?? error;
      });
    if (!verified) throw changed();
    uploaded = true;
  } finally {
    stream?.destroy();
    await handle.close().catch((error: unknown) => {
      if (uploaded) throw error;
    });
  }
}

export async function submitDataset(
  client: RailflowHttpClient,
  projectId: string,
  selection: UploadSelection,
  { signal, onProgress }: UploadOptions = {},
): Promise<{ uploadId: string; job: WorkflowJob }> {
  const { id: uploadId } = await client.json<{ id: string }>(
    'POST',
    '/api/uploads',
    { projectId, ...publicManifest(selection) },
    {
      operation: 'upload.create',
      signal,
      validate(data) {
        if (
          data &&
          typeof data === 'object' &&
          'id' in data &&
          typeof data.id === 'string' &&
          UPLOAD_ID.test(data.id)
        ) {
          return { id: data.id };
        }
        throw new RailflowError({
          kind: 'protocol',
          message: 'Server did not return a valid upload ID',
          operation: 'upload.create',
        });
      },
    },
  );

  function checkAbort() {
    if (signal?.aborted) {
      throw new RailflowError({ kind: 'interrupted', message: 'Upload interrupted', uploadId });
    }
  }

  try {
    for (const [index, file] of selection.files.entries()) {
      checkAbort();
      await putFile(client, uploadId, file, signal);
      onProgress?.(index + 1, selection.files.length, file.path);
    }
    checkAbort();
  } catch (error) {
    try {
      await client.json('DELETE', `/api/uploads/${uploadId}`, undefined, {
        operation: 'upload.delete',
        timeoutMs: 3_000,
        uploadId,
      });
    } catch {
      // The session expires on the server if cleanup fails.
    }
    throw error;
  }

  return retryCommit(client, uploadId, { signal });
}

export async function retryCommit(
  client: RailflowHttpClient,
  uploadId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ uploadId: string; job: WorkflowJob }> {
  if (!UPLOAD_ID.test(uploadId)) throw usage('Invalid upload ID');
  const { job } = await client.json<{ job: WorkflowJob }>(
    'POST',
    `/api/uploads/${uploadId}/commit`,
    undefined,
    { operation: 'upload.commit', uploadId, mutating: true, signal },
  );
  return { uploadId, job };
}
