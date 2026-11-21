import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { taskSpec } from './graph.ts';
import { canonical } from './reuse.ts';
import { ancestorTasks, copyOutput, verifyOutput } from './task-files.ts';
import type { JobStage, OutputManifest, WorkflowJob } from './types.ts';

interface Entry {
  version: 1;
  key: string;
  projectId: string;
  createdAt: string;
  output: OutputManifest;
  origin: { jobId: string; task: string; attempt: number };
}
export function cacheIdentity(job: WorkflowJob, task: JobStage): { key?: string; reason: string } {
  if (job.workflow?.version !== 2 || !job.dataset) return { reason: 'Workflow v2専用です。' };
  const project = job.workflow.project;
  const spec = taskSpec(project, task);
  if (!spec.cache?.enabled) return { reason: 'この工程のキャッシュは無効です。' };
  if (job.parentJobId) return { reason: '指定した工程を再実行するためキャッシュを使いません。' };
  if (task.attempts !== 1) return { reason: '再試行ではキャッシュを使いません。' };
  const runner = spec.runner ?? { kind: 'ai', engine: 'worker' };
  if (runner.kind === 'human' || runner.kind === 'http')
    return { reason: '承認・HTTP工程はキャッシュ対象外です。' };
  const runtime = task.runtime;
  if (!runtime || runtime.issues.length || !runtime.executableHash || !runtime.revision)
    return { reason: '実行環境の版と実行ファイルの特定が必要です。' };
  if (runner.kind === 'python' && !runtime.python)
    return { reason: 'Python環境を取得できません。' };
  const llm = {
    model: spec.llm.model || project.llm.model,
    effort: spec.llm.effort || project.llm.effort,
  };
  if (runner.kind === 'ai' && (!llm.model || !runtime.toolVersion || runtime.engine === 'demo'))
    return { reason: 'AIのモデル名・CLIバージョンの指定と取得が必要です。' };
  const templates = [
    project.prompt,
    spec.instruction,
    spec.acceptanceCriteria,
    ...(runner.kind === 'command' || runner.kind === 'python' ? runner.args : []),
  ];
  if (
    templates.some((text) =>
      /\{\{\s*(?:job\.id|attempt|retry\.reason|workspace|input\.directory|input\.manifest|upstream\.manifest)\s*\}\}/.test(
        text ?? '',
      ),
    )
  )
    return { reason: '実行ごとに変わる変数を使っているため再実行します。' };
  const upstream = ancestorTasks(job, task).map((key) => {
    const source = job.stages.find((item) => item.key === key)!;
    return { key, stage: source.stageKey, item: source.item, output: source.output };
  });
  const dataset = {
    name: job.dataset.name,
    kind: job.dataset.kind,
    files:
      spec.map?.isolateInput && task.item
        ? job.dataset.files.filter((file) => file.path === task.item!.path)
        : job.dataset.files,
  };
  const { recordedAt: _at, issues: _issues, ...environment } = runtime;
  const key = createHash('sha256')
    .update(
      canonical({
        cacheVersion: 1,
        runnerVersion: 1,
        projectId: project.id,
        name: project.name,
        purpose: project.purpose,
        acceptance: project.acceptanceCriteria,
        prompt: project.prompt,
        final: project.graph!.publishStage === task.key,
        finalGate: project.finalGate,
        spec,
        llm,
        task: { key: task.key, item: task.item },
        dataset,
        upstream,
        environment,
        runtimeProfile: project.runtime,
      }),
    )
    .digest('hex');
  return { key, reason: '入力・定義・実行環境を照合しました。' };
}

export class ResultCache {
  private root: string;
  private maxBytes: number;
  constructor(root: string, maxBytes = 512 * 1024 * 1024) {
    this.root = root;
    this.maxBytes = maxBytes;
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root))
      if (/^\.pending-[a-f0-9-]{36}$/.test(name))
        rmSync(path.join(root, name), { recursive: true, force: true });
  }
  restore(projectId: string, key: string, destination: string): Entry | null {
    const root = path.join(this.root, key);
    if (!existsSync(root)) return null;
    let entry: Entry;
    try {
      const metadata = path.join(root, 'entry.json');
      if (statSync(metadata).size > 2 * 1024 * 1024) throw new Error('metadata limit');
      entry = JSON.parse(readFileSync(metadata, 'utf8')) as Entry;
      if (
        entry.version !== 1 ||
        entry.key !== key ||
        entry.projectId !== projectId ||
        typeof entry.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        typeof entry.origin?.jobId !== 'string' ||
        typeof entry.origin?.task !== 'string' ||
        typeof entry.origin?.attempt !== 'number' ||
        !Array.isArray(entry.output?.files) ||
        entry.output.files.some(
          (file) =>
            file.path.startsWith('_inputs/') ||
            file.path.startsWith('_railflow/') ||
            file.path === '_inputs' ||
            file.path === '_railflow',
        ) ||
        !verifyOutput(path.join(root, 'files'), entry.output)
      )
        throw new Error('cache integrity');
    } catch {
      rmSync(root, { recursive: true, force: true });
      return null;
    }
    // A copy error fails this attempt; partially copied files never become a cache miss.
    copyOutput(path.join(root, 'files'), destination, entry.output, false, true);
    return entry;
  }
  store(job: WorkflowJob, task: JobStage, work: string): void {
    if (
      task.status !== 'success' ||
      task.completion?.mode !== 'executed' ||
      task.failureKind ||
      !task.output ||
      !task.workspace ||
      task.gates?.some((gate) => gate.result.status !== 'pass') ||
      [
        'input',
        'output',
        'stage',
        ...(job.workflow?.project.graph?.publishStage === task.key ? ['final'] : []),
      ].some(
        (scope) =>
          !task.gates?.some((gate) => gate.scope === scope && gate.result.status === 'pass'),
      )
    )
      return;
    if (
      job.events.some(
        (event) =>
          event.stage === task.key &&
          event.attempt === task.attempts &&
          event.type === 'stage.failed',
      )
    )
      return;
    const identity = cacheIdentity(job, task);
    if (!identity.key) return;
    const bytes = task.output.files.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > this.maxBytes) return;
    const destination = path.join(this.root, identity.key);
    if (existsSync(destination)) return;
    const temporary = path.join(this.root, '.pending-' + randomUUID());
    try {
      copyOutput(path.join(work, task.workspace), path.join(temporary, 'files'), task.output, true);
      const entry: Entry = {
        version: 1,
        key: identity.key,
        projectId: job.projectId,
        createdAt: new Date().toISOString(),
        output: task.output,
        origin: { jobId: job.id, task: task.key, attempt: task.attempts },
      };
      writeFileSync(path.join(temporary, 'entry.json'), JSON.stringify(entry));
      renameSync(temporary, destination);
      this.prune();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  private prune() {
    const entries: Array<{ name: string; bytes: number; at: string }> = [];
    for (const name of readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const entry = JSON.parse(
          readFileSync(path.join(this.root, name, 'entry.json'), 'utf8'),
        ) as Partial<Entry>;
        if (
          entry.version !== 1 ||
          typeof entry.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(entry.createdAt)) ||
          !Array.isArray(entry.output?.files)
        )
          throw new Error('invalid cache metadata');
        entries.push({
          name,
          bytes: entry.output.files.reduce((sum, file) => sum + file.bytes, 0),
          at: entry.createdAt,
        });
      } catch {
        rmSync(path.join(this.root, name), { recursive: true, force: true });
      }
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));
    let total = entries.reduce((sum, item) => sum + item.bytes, 0);
    while (entries.length > 256 || total > this.maxBytes) {
      const item = entries.shift()!;
      total -= item.bytes;
      rmSync(path.join(this.root, item.name), { recursive: true, force: true });
    }
  }
}
