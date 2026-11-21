import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vite-plus/test';
import { createClient, type RailflowHttpClient } from '../client/http.ts';
import { RailflowError } from '../client/types.ts';
import { collectSelection, publicManifest, retryCommit, submitDataset } from '../client/upload.ts';
import { INPUT_LIMITS } from '../shared/input-limits.ts';

const uploadId = '01234567-89ab-cdef-0123-456789abcdef';
const commitRoute = `/api/uploads/${uploadId}/commit`;
const deleteRoute = `/api/uploads/${uploadId}`;
const job = { id: 'job-1', projectId: 'test' };

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'railflow-client-upload-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents = 'x'): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function sparse(relative: string, bytes: number): string {
  const file = write(relative, '');
  truncateSync(file, bytes);
  return file;
}

it('collects a single file and exposes only manifest fields', async () => {
  const file = write('folder/sample.csv', '1,2');
  const selection = await collectSelection([file]);
  expect(selection).toMatchObject({
    name: 'sample.csv',
    kind: 'file',
    totalBytes: 3,
    files: [{ path: 'sample.csv', bytes: 3, localPath: file, size: 3 }],
  });
  expect(publicManifest(selection)).toEqual({
    name: 'sample.csv',
    kind: 'file',
    files: [{ path: 'sample.csv', bytes: 3 }],
  });
  expect((await collectSelection([file], { name: '' })).name).toBe('sample.csv');
});

it('collects a directory using paths relative to that directory', async () => {
  write('dataset/z.csv');
  write('dataset/sub/a.csv', '42');
  mkdirSync(join(root, 'dataset/empty'));
  expect(publicManifest(await collectSelection([join(root, 'dataset')]))).toEqual({
    name: 'dataset',
    kind: 'directory',
    files: [
      { path: 'sub/a.csv', bytes: 2 },
      { path: 'z.csv', bytes: 1 },
    ],
  });
});

it('uses each argument basename for mixed inputs and sorts manifest paths', async () => {
  write('a/x/run.csv');
  const separate = write('b/run.csv', '42');
  const inputs = [separate, join(root, 'a')];
  expect(publicManifest(await collectSelection(inputs))).toEqual({
    name: 'dataset',
    kind: 'directory',
    files: [
      { path: 'a/x/run.csv', bytes: 1 },
      { path: 'run.csv', bytes: 2 },
    ],
  });
  expect((await collectSelection(inputs, { name: 'Mixed' })).name).toBe('Mixed');
});

it('rejects case-insensitive and NFC-equivalent duplicate file paths', async () => {
  await expect(
    collectSelection([write('one/Run.csv'), write('two/run.csv')]),
  ).rejects.toMatchObject({
    kind: 'usage',
    message: expect.stringMatching(/duplicate/i),
  });
  await expect(
    collectSelection([write('one/é.csv'), write('two/e\u0301.csv')]),
  ).rejects.toMatchObject({ kind: 'usage', message: expect.stringMatching(/duplicate/i) });
});

it('rejects normalized file/directory prefix collisions in either argument order', async () => {
  const dir = dirname(write('one/a/b'));
  const file = write('two/A');
  for (const inputs of [
    [dir, file],
    [file, dir],
  ]) {
    await expect(collectSelection(inputs)).rejects.toMatchObject({
      kind: 'usage',
      message: expect.stringMatching(/conflict/i),
    });
  }
});

it('rejects empty selections and empty directory trees', async () => {
  mkdirSync(join(root, 'empty/nested'), { recursive: true });
  await expect(collectSelection([])).rejects.toMatchObject({ kind: 'usage' });
  await expect(collectSelection([join(root, 'empty')])).rejects.toMatchObject({ kind: 'usage' });
});

it.skipIf(process.platform === 'win32')(
  'rejects a basename that the server will not accept in a manifest',
  async () => {
    await expect(collectSelection([write('invalid?.csv')])).rejects.toMatchObject({
      kind: 'usage',
    });
  },
);

it('accepts depth 12 and rejects depth 13', async () => {
  const prefix = 'a/'.repeat(INPUT_LIMITS.depth - 1);
  write(`tree/${prefix}ok.csv`);
  const tree = join(root, 'tree');
  expect(publicManifest(await collectSelection([tree])).files).toEqual([
    { path: `${prefix}ok.csv`, bytes: 1 },
  ]);
  write(`tree/${prefix}b/too-deep.csv`);
  await expect(collectSelection([tree])).rejects.toMatchObject({ kind: 'limit' });
});

it('accepts 1000 files and rejects the 1001st file', async () => {
  for (let index = 0; index < INPUT_LIMITS.files; index++) write(`many/${index}`, '');
  const many = join(root, 'many');
  expect((await collectSelection([many])).files).toHaveLength(INPUT_LIMITS.files);
  write('many/extra');
  await expect(collectSelection([many])).rejects.toMatchObject({ kind: 'limit' });
});

it('accepts 20 MiB for one file and rejects one byte more', async () => {
  const file = sparse('large.bin', INPUT_LIMITS.fileBytes);
  expect((await collectSelection([file])).totalBytes).toBe(INPUT_LIMITS.fileBytes);
  truncateSync(file, INPUT_LIMITS.fileBytes + 1);
  await expect(collectSelection([file])).rejects.toMatchObject({ kind: 'limit' });
});

it('accepts 200 MiB total and rejects one byte more', async () => {
  for (let bytes = 0; bytes < INPUT_LIMITS.totalBytes; bytes += INPUT_LIMITS.fileBytes) {
    sparse(`large/${bytes}.bin`, INPUT_LIMITS.fileBytes);
  }
  const large = join(root, 'large');
  expect((await collectSelection([large])).totalBytes).toBe(INPUT_LIMITS.totalBytes);
  write('large/extra');
  await expect(collectSelection([large])).rejects.toMatchObject({ kind: 'limit' });
});

it.skipIf(process.platform === 'win32')(
  'rejects symlink targets and symlinks inside CLI directory selections',
  async () => {
    const file = write('real/file.csv');
    symlinkSync(file, join(root, 'file-link.csv'));
    symlinkSync(dirname(file), join(root, 'dir-link'), 'dir');
    symlinkSync(file, join(root, 'real', 'nested-link.csv'));
    for (const relative of ['file-link.csv', 'dir-link', 'real']) {
      await expect(collectSelection([join(root, relative)])).rejects.toMatchObject({
        kind: 'usage',
      });
    }
  },
);

it('rejects hardlinked files', async () => {
  const file = write('file.csv');
  linkSync(file, join(root, 'second.csv'));
  await expect(collectSelection([file])).rejects.toMatchObject({ kind: 'usage' });
});

it.skipIf(process.platform === 'win32')('rejects a FIFO without trying to read it', async () => {
  const fifo = join(root, 'pipe');
  execFileSync('mkfifo', [fifo]);
  await expect(collectSelection([fifo])).rejects.toMatchObject({ kind: 'usage' });
});

it('allows a nested relative input inside the upload root', async () => {
  write('allowed/nested/input.csv');
  const allowedRoot = join(root, 'allowed');
  expect(publicManifest(await collectSelection(['nested/input.csv'], { allowedRoot }))).toEqual({
    name: 'input.csv',
    kind: 'file',
    files: [{ path: 'input.csv', bytes: 1 }],
  });
});

it('rejects traversal, absolute, malformed, and missing scoped inputs', async () => {
  const absolute = write('input.csv');
  write('allowed/inside.csv');
  const allowedRoot = join(root, 'allowed');
  for (const invalid of ['../input.csv', absolute, 'inside.csv\0', './inside.csv', 'missing']) {
    await expect(collectSelection([invalid], { allowedRoot })).rejects.toMatchObject({
      kind: 'usage',
    });
  }
});

it('rejects nonexistent and non-directory upload roots', async () => {
  for (const allowedRoot of [join(root, 'missing'), write('ordinary.csv')]) {
    await expect(collectSelection(['input.csv'], { allowedRoot })).rejects.toMatchObject({
      kind: 'usage',
    });
  }
});

it.skipIf(process.platform === 'win32')(
  'canonicalizes the upload root and rejects symlinks below it',
  async () => {
    const outside = write('outside/input.csv');
    write('allowed/inside/input.csv');
    const allowedRoot = join(root, 'allowed');
    const rootAlias = join(root, 'root-alias');
    symlinkSync(allowedRoot, rootAlias, 'dir');
    symlinkSync(outside, join(allowedRoot, 'outside-file.csv'));
    symlinkSync(dirname(outside), join(allowedRoot, 'outside-dir'), 'dir');
    symlinkSync(join(allowedRoot, 'inside'), join(allowedRoot, 'inside-alias'), 'dir');
    expect(
      (await collectSelection(['inside/input.csv'], { allowedRoot: rootAlias })).files,
    ).toHaveLength(1);
    for (const relative of [
      'outside-file.csv',
      'outside-dir/input.csv',
      'inside-alias/input.csv',
    ]) {
      await expect(collectSelection([relative], { allowedRoot })).rejects.toMatchObject({
        kind: 'usage',
      });
    }
  },
);

interface UploadRequest {
  method: string | undefined;
  route: string | undefined;
  body: string;
}
type Respond = (
  request: UploadRequest,
  req: IncomingMessage,
  res: ServerResponse,
) => boolean | void;

function sendJson(res: ServerResponse, body: object, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function serve(respond?: Respond) {
  const requests: UploadRequest[] = [];
  const server = createServer((req, res) => {
    const request = { method: req.method, route: req.url, body: '' };
    requests.push(request);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      request.body = Buffer.concat(chunks).toString();
      if (respond?.(request, req, res)) return;
      if (request.route === '/api/uploads') sendJson(res, { id: uploadId }, 201);
      else if (request.route === commitRoute) sendJson(res, { job });
      else sendJson(res, { ok: true });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const client = createClient({
    origin: new URL(`http://127.0.0.1:${address.port}`),
    requestTimeoutMs: 2_000,
  });
  return {
    client,
    requests,
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it.skipIf(process.platform === 'win32')(
  'uploads a CLI file through a symlinked parent directory',
  async () => {
    const file = write('real/input.csv', 'payload');
    const parentAlias = join(root, 'alias');
    symlinkSync(dirname(file), parentAlias, 'dir');
    const selection = await collectSelection([join(parentAlias, 'input.csv')]);
    expect(selection.files).toMatchObject([{ path: 'input.csv', localPath: file }]);
    const { client, requests, close } = await serve();
    try {
      await expect(submitDataset(client, 'test', selection)).resolves.toEqual({ uploadId, job });
      expect(requests[1]).toMatchObject({ method: 'PUT', body: 'payload' });
    } finally {
      await close();
    }
  },
);

it('creates one upload, sends encoded file paths in order, reports progress, and commits', async () => {
  write('tree/a & #+.csv', 'payload');
  write('tree/b-empty.csv', '');
  const selection = await collectSelection([join(root, 'tree')], { name: 'Fixture' });
  const progress: [number, number, string][] = [];
  const { client, requests, close } = await serve();
  try {
    await expect(
      submitDataset(client, 'test', selection, {
        onProgress: (done, total, file) => progress.push([done, total, file]),
      }),
    ).resolves.toEqual({ uploadId, job });
    expect(requests).toEqual([
      {
        method: 'POST',
        route: '/api/uploads',
        body: JSON.stringify({ projectId: 'test', ...publicManifest(selection) }),
      },
      { method: 'PUT', route: `${deleteRoute}/files?path=a%20%26%20%23%2B.csv`, body: 'payload' },
      { method: 'PUT', route: `${deleteRoute}/files?path=b-empty.csv`, body: '' },
      { method: 'POST', route: commitRoute, body: '{}' },
    ]);
    expect(progress).toEqual([
      [1, 2, 'a & #+.csv'],
      [2, 2, 'b-empty.csv'],
    ]);
  } finally {
    await close();
  }
});

it.each(['modified', 'touched', 'replaced', 'removed', 'hardlinked'] as const)(
  'cleans up before PUT when the selected file was %s',
  async (change) => {
    const path = write('input.csv');
    const selection = await collectSelection([path]);
    if (change === 'modified') writeFileSync(path, 'longer contents');
    if (change === 'touched') utimesSync(path, 1, 1);
    if (change === 'replaced') {
      renameSync(path, join(root, 'old.csv'));
      write('input.csv');
    }
    if (change === 'removed') rmSync(path);
    if (change === 'hardlinked') linkSync(path, join(root, 'second.csv'));
    const { client, requests, close } = await serve();
    try {
      await expect(submitDataset(client, 'test', selection)).rejects.toMatchObject({
        kind: 'usage',
        message: 'File changed during upload: input.csv',
        uploadId,
      });
      expect(requests.map(({ method, route }) => [method, route])).toEqual([
        ['POST', '/api/uploads'],
        ['DELETE', deleteRoute],
      ]);
    } finally {
      await close();
    }
  },
);

it.each(['size', 'mtime'] as const)('detects a change in %s while reading', async (field) => {
  const file = sparse('input.csv', 512 * 1024);
  const selection = await collectSelection([file]);
  const { client, requests, close } = await serve();
  const changingClient: RailflowHttpClient = {
    ...client,
    async putBytes<T>(
      route: string,
      body: Buffer | AsyncIterable<Buffer>,
      opts?: Parameters<RailflowHttpClient['putBytes']>[2],
    ) {
      async function* changingBody() {
        let changed = false;
        for await (const chunk of body as AsyncIterable<Buffer>) {
          if (!changed) {
            changed = true;
            if (field === 'size') truncateSync(file, 1);
            else utimesSync(file, 1, 1);
          }
          yield chunk;
        }
      }
      return client.putBytes<T>(route, changingBody(), opts);
    },
  };
  try {
    await expect(submitDataset(changingClient, 'test', selection)).rejects.toMatchObject({
      kind: 'usage',
      message: 'File changed during upload: input.csv',
      uploadId,
    });
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', route: deleteRoute });
    expect(requests.some(({ route }) => route === commitRoute)).toBe(false);
  } finally {
    await close();
  }
});

it('deletes the upload after a failed PUT and preserves the PUT error if cleanup fails', async () => {
  const selection = await collectSelection([write('one.csv'), write('two.csv')]);
  const { client, requests, close } = await serve(({ method }, _req, res) => {
    if (method === 'PUT') sendJson(res, { error: 'PUT rejected' }, 409);
    else if (method === 'DELETE') sendJson(res, { error: 'Cleanup rejected' }, 500);
    else return false;
    return true;
  });
  try {
    await expect(submitDataset(client, 'test', selection)).rejects.toMatchObject({
      kind: 'http',
      status: 409,
      message: 'PUT rejected',
      uploadId,
    });
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'PUT', 'DELETE']);
    expect(requests.at(-1)?.route).toBe(deleteRoute);
  } finally {
    await close();
  }
});

it('cleans up with a fresh request after cancellation before commit', async () => {
  const selection = await collectSelection([write('input.csv')]);
  const controller = new AbortController();
  const { client, requests, close } = await serve(({ method }, _req, res) => {
    if (method !== 'PUT') return false;
    controller.abort();
    sendJson(res, { ok: true });
    return true;
  });
  try {
    await expect(
      submitDataset(client, 'test', selection, { signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: 'interrupted',
      uploadId,
    });
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'PUT', 'DELETE']);
    expect(requests.at(-1)?.route).toBe(deleteRoute);
  } finally {
    await close();
  }
});

it('cleans up when progress cancels submission after the final PUT', async () => {
  const selection = await collectSelection([write('input.csv')]);
  const controller = new AbortController();
  const { client, requests, close } = await serve();
  try {
    await expect(
      submitDataset(client, 'test', selection, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ kind: 'interrupted', uploadId });
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'PUT', 'DELETE']);
  } finally {
    await close();
  }
});

it('reconciles a dropped commit response by retrying the same upload ID', async () => {
  const selection = await collectSelection([write('input.csv')]);
  let reconciled = false;
  const { client, requests, close } = await serve(({ route }, req) => {
    if (route !== commitRoute || reconciled) return false;
    reconciled = true;
    req.socket.destroy();
    return true;
  });
  try {
    await expect(submitDataset(client, 'test', selection)).rejects.toMatchObject({
      kind: 'outcome_unknown',
      operation: 'upload.commit',
      uploadId,
    });
    await expect(retryCommit(client, uploadId)).resolves.toEqual({ uploadId, job });
    expect(requests.map(({ method, route }) => [method, route])).toEqual([
      ['POST', '/api/uploads'],
      ['PUT', `${deleteRoute}/files?path=input.csv`],
      ['POST', commitRoute],
      ['POST', commitRoute],
    ]);
  } finally {
    await close();
  }
});

it('rejects an invalid retry ID before sending any HTTP requests', async () => {
  const { client, requests, close } = await serve();
  try {
    for (const invalid of ['not-a-uuid', uploadId.toUpperCase(), `${uploadId}/files`]) {
      await expect(retryCommit(client, invalid)).rejects.toBeInstanceOf(RailflowError);
      await expect(retryCommit(client, invalid)).rejects.toMatchObject({ kind: 'usage' });
    }
    expect(requests).toEqual([]);
  } finally {
    await close();
  }
});
