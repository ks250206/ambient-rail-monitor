import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  inventory,
  requireRelativePath,
  safeFile,
  snapshotDataset,
  verifyDataset,
  type Inventory,
} from './datasets.ts';
import { matchesPattern, type ConditionResult } from './conditions.ts';
import { validateJson, type FileContract } from './contracts.ts';
import type { OutputManifest, WorkflowJob, JobStage } from './types.ts';

export function isolateMapInput(job: WorkflowJob, task: JobStage, input: string, work: string) {
  const list = inventory(input);
  list.files = list.files.filter((file) => file.path === task.item!.path);
  list.bytes = list.files.reduce((sum, file) => sum + file.bytes, 0);
  if (list.files.length !== 1) throw new Error('map入力が見つかりません。');
  const directory = path.join(work, '_railflow/dataset');
  const manifest = snapshotDataset(list, directory, job.file, 'directory', 'isolated-map');
  const manifestPath = path.join(work, '_railflow/dataset.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { directory, manifestPath, verify: () => verifyDataset(directory, manifest) };
}

export function verifyMapInput(job: WorkflowJob, task: JobStage, work: string): boolean {
  if (!task.item || !job.dataset) return false;
  const files = job.dataset.files.filter((file) => file.path === task.item!.path);
  return verifyDataset(path.join(work, '_railflow/dataset'), {
    ...job.dataset,
    kind: 'directory',
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  });
}

export function ownOutputs(root: string): Inventory {
  const list = inventory(root, undefined, true);
  const files = list.files.filter(
    (file) => !file.path.startsWith('_inputs/') && !file.path.startsWith('_railflow/'),
  );
  return {
    ...list,
    files,
    bytes: files.reduce((n, file) => n + file.bytes, 0),
    signature: JSON.stringify(files),
  };
}

export function checkContracts(list: Inventory, contracts: FileContract[]): ConditionResult {
  const children: ConditionResult[] = contracts.map((contract) => {
    const files = list.files.filter((file) => matchesPattern(file.path, contract.pattern));
    const errors: string[] = [];
    if (files.length < contract.minFiles || files.length > contract.maxFiles)
      errors.push(`必要数 ${contract.minFiles}〜${contract.maxFiles}、実際 ${files.length}`);
    if (contract.schema)
      for (const file of files) {
        try {
          if (file.bytes > 2 * 1024 * 1024) throw new Error('JSON検証の上限は2 MiBです');
          const data: unknown = JSON.parse(readFileSync(safeFile(list.root, file.path), 'utf8'));
          errors.push(
            ...validateJson(data, contract.schema).map((error) => `${file.path}: ${error}`),
          );
        } catch (error) {
          errors.push(`${file.path}: ${(error as Error).message}`);
        }
      }
    return {
      status: errors.length ? 'fail' : 'pass',
      label: contract.pattern,
      message: errors.slice(0, 20).join('; ') || `${files.length}件が契約を満たしました`,
    };
  });
  return {
    status: children.some((child) => child.status !== 'pass') ? 'fail' : 'pass',
    label: 'ファイル契約',
    message: children.length ? '件数・JSONの型を検証' : '追加の契約なし',
    children,
  };
}

export function checkInputContracts(
  datasetRoot: string,
  work: string,
  task: JobStage,
  contracts: FileContract[],
): ConditionResult {
  const dataset = inventory(datasetRoot);
  if (task.item) dataset.files = dataset.files.filter((file) => file.path === task.item!.path);
  const children = contracts.map((contract) => {
    let list = dataset;
    if (contract.source === 'upstream') {
      list = inventory(work, undefined, true);
      list.files = list.files
        .filter((file) => file.path.startsWith('_inputs/'))
        .map((file) => ({ ...file, path: file.path.slice('_inputs/'.length) }));
      list.root = path.join(work, '_inputs');
    }
    const result = checkContracts(list, [contract]);
    return { ...result, label: `${contract.source ?? 'dataset'} / ${contract.pattern}` };
  });
  return {
    status: children.some((child) => child.status !== 'pass') ? 'fail' : 'pass',
    label: '入力契約',
    message: '登録済みデータと依存工程の出力を検証',
    children,
  };
}

function hashFile(root: string, file: { path: string; bytes: number }) {
  const fd = openSync(
    safeFile(root, file.path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes)
      throw new Error('出力が変更されました。');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    let size = 0;
    for (
      let n = readSync(fd, buffer, 0, buffer.length, null);
      n;
      n = readSync(fd, buffer, 0, buffer.length, null)
    ) {
      size += n;
      if (size > file.bytes) throw new Error('ハッシュ検証中に出力が変更されました。');
      hash.update(buffer.subarray(0, n));
    }
    const after = fstatSync(fd);
    if (size !== file.bytes || after.mtimeMs !== before.mtimeMs)
      throw new Error('ハッシュ検証中に出力が変更されました。');
    return {
      path: file.path,
      bytes: file.bytes,
      hash: hash.digest('hex'),
      executable: !!(before.mode & 0o100),
    };
  } finally {
    closeSync(fd);
  }
}

export function outputManifest(list: Inventory, contracts: FileContract[] = []): OutputManifest {
  const files = list.files
    .filter(
      (file) =>
        !contracts.length ||
        contracts.some((contract) => matchesPattern(file.path, contract.pattern)),
    )
    .map((file) => hashFile(list.root, file));
  return { files, hash: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export function verifyOutput(
  root: string,
  expected: OutputManifest,
  options: { excludeInternal?: boolean } = {},
): boolean {
  try {
    const actual = options.excludeInternal ? ownOutputs(root) : inventory(root, undefined, true);
    if (actual.files.length !== expected.files.length) return false;
    const expectedSorted = [...expected.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (
      !actual.files.every(
        (file, index) =>
          file.path === expectedSorted[index]?.path && file.bytes === expectedSorted[index]?.bytes,
      )
    )
      return false;
    const files = expected.files.map((file) => hashFile(root, file));
    return createHash('sha256').update(JSON.stringify(files)).digest('hex') === expected.hash;
  } catch {
    return false;
  }
}

export function copyOutput(
  root: string,
  destination: string,
  manifest: OutputManifest,
  readOnly = false,
  excludeInternal = false,
): void {
  if (!verifyOutput(root, manifest, { excludeInternal: true }))
    throw new Error('合格済み出力のハッシュが変わっています。');
  const existed = existsSync(destination);
  if (!existed) mkdirSync(destination, { recursive: true });
  const copied: string[] = [];
  try {
    for (const file of manifest.files) {
      requireRelativePath(file.path);
      if (
        excludeInternal &&
        (file.path === '_inputs' ||
          file.path === '_railflow' ||
          file.path.startsWith('_inputs/') ||
          file.path.startsWith('_railflow/'))
      )
        throw new Error('内部ディレクトリへの出力コピーは許可されません。');
      const target = path.join(destination, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(safeFile(root, file.path), target, constants.COPYFILE_EXCL);
      copied.push(target);
      chmodSync(target, (readOnly ? 0o400 : 0o600) | (file.executable ? 0o100 : 0));
    }
    if (!verifyOutput(destination, manifest, { excludeInternal }))
      throw new Error('コピー中に出力が変わりました。');
  } catch (error) {
    if (!existed) {
      rmSync(destination, { recursive: true, force: true });
    } else {
      for (const target of copied) rmSync(target, { force: true });
    }
    throw error;
  }
}

export function prepareTaskInputs(job: WorkflowJob, task: JobStage, root: string, work: string) {
  const upstream = ancestorTasks(job, task).map((key) => {
    const source = job.stages.find((item) => item.key === key)!;
    if (source.status !== 'success' || !source.output || !source.workspace)
      throw new Error(`依存工程が未承認です: ${key}`);
    const relative = '_inputs/' + key;
    copyOutput(path.join(root, source.workspace), path.join(work, relative), source.output, true);
    return {
      task: key,
      stage: source.stageKey,
      item: source.item,
      directory: relative,
      manifest: source.output,
    };
  });
  mkdirSync(path.join(work, '_railflow'), { recursive: true });
  const manifest = { version: 1, item: task.item ?? null, upstream };
  const manifestPath = path.join(work, '_railflow', 'inputs.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    manifestPath,
    verify: () =>
      upstream.every((source) => verifyOutput(path.join(work, source.directory), source.manifest)),
  };
}

export function verifyTaskInputs(job: WorkflowJob, task: JobStage, work: string): boolean {
  return ancestorTasks(job, task).every((key) => {
    const source = job.stages.find((item) => item.key === key)!;
    return !!source?.output && verifyOutput(path.join(work, '_inputs', key), source.output);
  });
}

export function ancestorTasks(job: WorkflowJob, task: JobStage): string[] {
  const ancestors = new Set<string>();
  const visit = (key: string) => {
    if (ancestors.has(key)) return;
    ancestors.add(key);
    for (const parent of job.stages.find((item) => item.key === key)?.dependsOn ?? [])
      visit(parent);
  };
  for (const key of task.dependsOn ?? []) visit(key);
  return [...ancestors].sort();
}
