import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { evaluateCondition, referencedPaths, validRelativePath } from './conditions.ts';
import type { Condition, ConditionFacts, ConditionResult } from './conditions.ts';
import type { DatasetManifest, DryRunResult } from './types.ts';
import { INPUT_LIMITS } from './input-limits.ts';
export { INPUT_LIMITS } from './input-limits.ts';

const TEXT_LIMIT = 2 * 1024 * 1024;
export interface InventoryFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}
export interface Inventory {
  root: string;
  files: InventoryFile[];
  bytes: number;
  signature: string;
}

export function requireRelativePath(value: string): string {
  if (!validRelativePath(value)) throw new Error(`無効な相対パス: ${value}`);
  return value;
}

export function inventory(root: string, single?: string, output = false): Inventory {
  const limits = output
    ? { ...INPUT_LIMITS, files: 5000, fileBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 }
    : INPUT_LIMITS;
  const files: InventoryFile[] = [];
  let bytes = 0;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error('通常のディレクトリを指定してください。');
  const visit = (relative: string, depth: number) => {
    if (depth > limits.depth) throw new Error('フォルダの階層が深すぎます。');
    requireRelativePath(relative);
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`シンボリックリンクは取り込めません: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path.join(root, relative)))
        visit(`${relative}/${name}`, depth + 1);
    } else if (stat.isFile() && stat.nlink === 1) {
      bytes += stat.size;
      if (files.length >= limits.files || stat.size > limits.fileBytes || bytes > limits.totalBytes)
        throw new Error(
          output
            ? '判定対象の出力が上限を超えています（5000ファイル・合計1GB）。'
            : '入力の上限は1000ファイル、1ファイル20MB、合計200MBです。',
        );
      files.push({ path: relative, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } else throw new Error(`通常の単一リンクファイルではありません: ${relative}`);
  };
  if (single) visit(single, 1);
  else for (const name of readdirSync(root)) visit(name, 1);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, files, bytes, signature: JSON.stringify(files) };
}

/** Reject symlinks at every component, even when a predicate names a missing file. */
export function safeFile(root: string, relative: string): string {
  requireRelativePath(relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`リンクを参照できません: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.join(root, relative);
      throw error;
    }
  }
  return current;
}

export function conditionFacts(
  list: Inventory,
  name: string,
  quietMs: number,
  condition: Condition | null,
): ConditionFacts {
  const texts: ConditionFacts['texts'] = Object.create(null);
  for (const relative of referencedPaths(condition)) {
    try {
      if (!list.files.some((file) => file.path === relative))
        throw new Error(`入力・出力の一覧にありません: ${relative}`);
      const filename = safeFile(list.root, relative);
      const fd = openSync(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > TEXT_LIMIT)
          throw new Error(`テキスト判定は2MB以下の通常ファイルが対象です: ${relative}`);
        // Bound the read even if another process is growing the file.
        const buffer = Buffer.alloc(TEXT_LIMIT + 1);
        let size = 0;
        while (size < buffer.length) {
          const n = readSync(fd, buffer, size, buffer.length - size, null);
          if (!n) break;
          size += n;
        }
        if (size > TEXT_LIMIT)
          throw new Error(`テキスト判定のサイズ上限を超えています: ${relative}`);
        texts[relative] = { text: buffer.subarray(0, size).toString('utf8') };
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      texts[relative] = {
        error:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `ファイルが見つかりません: ${relative}`
            : (error as Error).message,
      };
    }
  }
  return { name, files: list.files, quietMs, texts };
}

export function checkCondition(
  list: Inventory,
  name: string,
  quietMs: number,
  condition: Condition | null,
): ConditionResult {
  return evaluateCondition(condition, conditionFacts(list, name, quietMs, condition));
}

/** Copy and hash the same bytes, then confirm that the whole input set stayed stable. */
export function snapshotDataset(
  list: Inventory,
  destination: string,
  name: string,
  kind: 'file' | 'directory',
  source: string,
  single?: string,
): DatasetManifest {
  const temporary = destination + '.tmp-' + randomUUID();
  mkdirSync(temporary, { recursive: true });
  const files: DatasetManifest['files'] = [];
  try {
    for (const file of list.files) {
      const target = path.join(temporary, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const input = openSync(
        safeFile(list.root, file.path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let out: number | undefined;
      try {
        out = openSync(target, 'wx', 0o400);
        const stat = fstatSync(input);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== file.bytes ||
          stat.mtimeMs !== file.mtimeMs
        )
          throw new Error('入力が変更されました。転送完了後に再試行してください。');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(256 * 1024);
        let size = 0;
        while (true) {
          const n = readSync(input, buffer, 0, buffer.length, null);
          if (!n) break;
          size += n;
          if (size > INPUT_LIMITS.fileBytes)
            throw new Error('入力ファイルがサイズ上限を超えました。');
          hash.update(buffer.subarray(0, n));
          let offset = 0;
          while (offset < n) offset += writeSync(out, buffer, offset, n - offset);
        }
        const after = fstatSync(input);
        if (size !== file.bytes || after.size !== file.bytes || after.mtimeMs !== file.mtimeMs)
          throw new Error('コピー中に入力が変更されました。');
        files.push({ path: file.path, bytes: size, hash: hash.digest('hex') });
      } finally {
        closeSync(input);
        if (out !== undefined) closeSync(out);
      }
    }
    if (inventory(list.root, single).signature !== list.signature)
      throw new Error('コピー中にデータセットが変更されました。');
    if (!files.length) throw new Error('空のデータセットは投入できません。');
    const hash =
      kind === 'file' && files.length === 1
        ? files[0].hash
        : createHash('sha256').update(JSON.stringify(files)).digest('hex');
    renameSync(temporary, destination);
    return { version: 1, name, kind, files, hash, bytes: list.bytes, source };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyDataset(root: string, manifest: DatasetManifest): boolean {
  return readVerifiedTexts(root, manifest, []) !== null;
}

// Predicate evidence must come from the same bytes that passed hash verification.
function readVerifiedTexts(
  root: string,
  manifest: DatasetManifest,
  paths: string[],
): ConditionFacts['texts'] | null {
  const texts: ConditionFacts['texts'] = Object.create(null);
  try {
    const list = inventory(root);
    if (
      manifest.version !== 1 ||
      !manifest.files.length ||
      list.files.length !== manifest.files.length ||
      list.bytes !== manifest.bytes
    )
      return null;
    const hash =
      manifest.kind === 'file' && manifest.files.length === 1
        ? manifest.files[0].hash
        : createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
    if (
      hash !== manifest.hash ||
      !list.files.every((file, index) => file.path === manifest.files[index].path)
    )
      return null;
    const valid = manifest.files.every((file) => {
      const filename = safeFile(root, file.path);
      const fd = openSync(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes) return false;
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(256 * 1024);
        const referenced = paths.includes(file.path);
        const content = referenced && file.bytes <= TEXT_LIMIT ? Buffer.alloc(file.bytes) : null;
        let size = 0;
        while (true) {
          const n = readSync(fd, buffer, 0, buffer.length, null);
          if (!n) break;
          size += n;
          if (size > file.bytes) return false;
          const chunk = buffer.subarray(0, n);
          digest.update(chunk);
          content?.set(chunk, size - n);
        }
        if (referenced) {
          texts[file.path] = content
            ? { text: content.toString('utf8') }
            : {
                error: `テキスト判定は2MB以下の通常ファイルが対象です: ${file.path}`,
                code: 'text_too_large',
              };
        }
        const after = fstatSync(fd);
        return (
          size === file.bytes &&
          after.size === file.bytes &&
          after.mtimeMs === before.mtimeMs &&
          digest.digest('hex') === file.hash
        );
      } finally {
        closeSync(fd);
      }
    });
    return valid ? texts : null;
  } catch {
    return null;
  }
}

function includesQuiet(condition: Condition | null): boolean {
  if (condition?.op === 'all' || condition?.op === 'any')
    return condition.children.some(includesQuiet);
  if (condition?.op === 'not') return includesQuiet(condition.child);
  return condition?.op === 'quiet';
}

/** Null means the snapshot failed verification, independently of the trigger verdict. */
export function checkFrozenTrigger(
  root: string,
  manifest: DatasetManifest,
  condition: Condition | null,
): DryRunResult['trigger'] | null {
  const manual = isManualInput(manifest.source);
  const unknown = !manual && includesQuiet(condition);
  const texts = readVerifiedTexts(root, manifest, unknown ? [] : referencedPaths(condition));
  if (!texts) return null;
  if (unknown)
    return { status: 'unknown', message: '監視時の無変更時間は固定入力から復元できません。' };
  const result = evaluateCondition(condition, {
    name: manifest.name,
    files: manifest.files,
    quietMs: manual ? Infinity : 0,
    texts,
  });
  return { status: result.status, message: result.message, evidence: { condition, result } };
}

export function isManualInput(source: string): boolean {
  return source.startsWith('upload:') || source.startsWith('demo:');
}
