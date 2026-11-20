import { chmodSync, copyFileSync, constants, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validRelativePath } from './conditions.ts';

/** Only accepted checkpoints are copied; failed attempt outputs remain isolated. */
export function prepareAttempt(root: string, relative: string, previous?: string): string {
  if (!validRelativePath(relative)) throw new Error('Invalid attempt workspace');
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(target); // Never overwrite an existing attempt after an interrupted run.
  if (!previous) return target;
  let count = 0;
  let bytes = 0;
  const copy = (folder: string, output: string, depth: number) => {
    if (depth > 12 || lstatSync(folder).isSymbolicLink())
      throw new Error('Unsafe checkpoint directory');
    for (const name of readdirSync(folder)) {
      if (folder === root && name === '.attempts') continue;
      if (!validRelativePath(name)) throw new Error(`Unsafe checkpoint path: ${name}`);
      const source = path.join(folder, name);
      const dest = path.join(output, name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`Checkpoint contains a link: ${name}`);
      if (stat.isDirectory()) {
        mkdirSync(dest);
        copy(source, dest, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1) {
        if (++count > 5000 || (bytes += stat.size) > 1024 * 1024 * 1024)
          throw new Error('Checkpoint exceeds output limits');
        copyFileSync(source, dest, constants.COPYFILE_EXCL);
        chmodSync(dest, 0o600 | (stat.mode & 0o100));
      } else throw new Error(`Unsafe checkpoint file: ${name}`);
    }
  };
  copy(previous, target, 1);
  return target;
}
