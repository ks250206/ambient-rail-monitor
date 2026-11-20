import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export async function publishAgentReports(work: string, artifacts: string): Promise<string[]> {
  const published: string[] = [];
  for (const name of ['report.html', 'report.pptx']) {
    const source = await open(
      path.join(work, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!source) continue;

    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !stat.size) {
        throw new Error(`Expected a nonempty regular workspace file: ${name}`);
      }

      const temporary = path.join(artifacts, `.publish-${randomUUID()}`);
      try {
        await pipeline(
          source.createReadStream(),
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        );
        await rename(temporary, path.join(artifacts, name));
      } finally {
        await rm(temporary, { force: true });
      }
      published.push(name);
    } finally {
      await source.close();
    }
  }
  if (!published.length) throw new Error('Missing report.html or report.pptx in the job workspace');
  return published;
}
