import { expect, it } from 'vite-plus/test';
import { droppedFiles, selectFiles } from '../src/utils/dataset-upload.ts';

function file(name: string, relative = '') {
  const value = new File(['x'], name);
  Object.defineProperty(value, 'webkitRelativePath', { value: relative });
  return value;
}

it('preserves webkitRelativePath when browser entry APIs are unavailable', async () => {
  const input = file('sample.csv', 'set/sub/sample.csv');
  const transfer = {
    items: [{ kind: 'file', webkitGetAsEntry: () => null }],
    files: [input],
  } as unknown as DataTransfer;
  const selected = await droppedFiles(transfer);
  expect(selected.name).toBe('set');
  expect(selected.kind).toBe('directory');
  expect(selected.files[0].path).toBe('sub/sample.csv');
});

it('drains every directory-reader batch and preserves duplicate basenames', async () => {
  const entry = (name: string): FileSystemFileEntry =>
    ({
      name,
      isFile: true,
      isDirectory: false,
      file: (accept: (file: File) => void) => accept(file(name)),
    }) as FileSystemFileEntry;
  const directory = (name: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry =>
    ({
      name,
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let index = 0;
        return {
          readEntries: (accept: (entries: FileSystemEntry[]) => void) =>
            accept(batches[index++] ?? []),
        };
      },
    }) as FileSystemDirectoryEntry;
  const root = directory('set', [
    [directory('A', [[entry('sample.csv')]])],
    [directory('B', [[entry('sample.csv')]])],
  ]);
  const selected = await droppedFiles({
    items: [{ kind: 'file', webkitGetAsEntry: () => root }],
    files: [],
  } as unknown as DataTransfer);
  expect(selected.files.map((item) => item.path)).toEqual(['A/sample.csv', 'B/sample.csv']);
  expect(() => selectFiles([file('same.csv'), file('SAME.csv')])).toThrow('同じ相対パス');
});
