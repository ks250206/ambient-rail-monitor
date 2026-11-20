import { validRelativePath } from '../../shared/conditions.ts';
import { INPUT_LIMITS } from '../../shared/input-limits.ts';

export interface UploadFile {
  file: File;
  path: string;
}
export interface UploadSelection {
  name: string;
  kind: 'file' | 'directory';
  files: UploadFile[];
}

export function validateSelection(selection: UploadSelection): UploadSelection {
  if (!selection.files.length || selection.files.length > INPUT_LIMITS.files)
    throw new Error('1〜1000ファイルを選択してください。空のフォルダは投入できません。');
  const paths = new Set<string>();
  let bytes = 0;
  for (const { file, path } of selection.files) {
    if (!validRelativePath(path) || path.split('/').length > INPUT_LIMITS.depth)
      throw new Error(`相対パスを使用できません: ${path}`);
    const normalized = path.normalize('NFC').toLowerCase();
    if (paths.has(normalized)) throw new Error(`同じ相対パスが複数あります: ${path}`);
    paths.add(normalized);
    bytes += file.size;
    if (file.size > INPUT_LIMITS.fileBytes || bytes > INPUT_LIMITS.totalBytes)
      throw new Error('1ファイル20MB、合計200MB以内で投入してください。');
  }
  return { ...selection, files: selection.files.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

export function selectFiles(files: File[], directory = false): UploadSelection {
  const folder = directory ? files[0]?.webkitRelativePath.split('/')[0] : undefined;
  return validateSelection({
    name: folder || (files.length === 1 ? files[0].name : 'データセット'),
    kind: directory || files.length !== 1 ? 'directory' : 'file',
    files: files.map((file) => ({
      file,
      path:
        directory && file.webkitRelativePath
          ? file.webkitRelativePath.split('/').slice(1).join('/')
          : file.name,
    })),
  });
}

/** Capture entries synchronously, then drain every directory-reader batch. */
export async function droppedFiles(transfer: DataTransfer): Promise<UploadSelection> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.());
  const fallback = [...transfer.files];
  if (!entries.length || entries.some((entry) => !entry)) {
    if (entries.some((entry) => entry?.isDirectory))
      throw new Error(
        'このブラウザではドロップしたフォルダをすべて読み取れません。「フォルダを選ぶ」を使用してください。',
      );
    if (fallback.some((file) => file.webkitRelativePath)) {
      const root = fallback[0]?.webkitRelativePath.split('/')[0];
      if (root && fallback.every((file) => file.webkitRelativePath.startsWith(root + '/')))
        return selectFiles(fallback, true);
      return validateSelection({
        name: 'データセット',
        kind: 'directory',
        files: fallback.map((file) => ({ file, path: file.webkitRelativePath || file.name })),
      });
    }
    return selectFiles(fallback);
  }
  const files: UploadFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string, depth: number): Promise<void> => {
    if (depth > INPUT_LIMITS.depth) throw new Error('フォルダの階層が深すぎます。');
    const relative = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push({ file, path: relative });
      if (files.length > INPUT_LIMITS.files) throw new Error('入力は1000ファイルまでです。');
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, relative + '/', depth + 1);
      }
    }
  };
  for (const entry of entries) await walk(entry!, '', 0);
  const singleFolder = entries.length === 1 && entries[0]!.isDirectory;
  return validateSelection({
    name: entries.length === 1 ? entries[0]!.name : 'データセット',
    kind:
      singleFolder || files.length !== 1 || entries.some((entry) => entry!.isDirectory)
        ? 'directory'
        : 'file',
    files: singleFolder
      ? files.map((item) => ({ ...item, path: item.path.split('/').slice(1).join('/') }))
      : files,
  });
}
