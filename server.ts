import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ArtifactInfo,
  EventType,
  LlmConfig,
  ProjectSpec,
  ReasoningEffort,
  StageDefinition,
  WorkerEventType,
  WorkflowEvent,
  WorkflowJob,
  WorkflowStageSpec,
} from './shared/types.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.RAILFLOW_HOME ? path.resolve(process.env.RAILFLOW_HOME) : ROOT;
const DIST = path.join(ROOT, 'dist');
const LEGACY_INBOX = path.join(HOME, 'inbox');
const DATA = path.join(HOME, 'data');
const LEGACY_ARTIFACTS = path.join(HOME, 'artifacts');
const LEGACY_WORK = path.join(HOME, 'work');
const PROJECTS_ROOT = path.join(HOME, 'projects');
const EVENTS = path.join(DATA, 'events.jsonl');
const PROJECTS_FILE = path.join(DATA, 'projects.json');
const LEGACY_WORKFLOW_FILE = path.join(DATA, 'workflow-spec.json');
const MAX_UPLOAD = 20 * 1024 * 1024;
const DEFAULT_PROJECT_ID = 'default';

for (const dir of [LEGACY_INBOX, DATA, LEGACY_ARTIFACTS, LEGACY_WORK, PROJECTS_ROOT]) {
  mkdirSync(dir, { recursive: true });
}

const VALID_EFFORTS = new Set<ReasoningEffort>(['', 'low', 'medium', 'high', 'xhigh', 'max']);

function emptyLlmConfig(): LlmConfig {
  return { model: '', effort: '' };
}

function defaultStages(): WorkflowStageSpec[] {
  return [
    {
      key: 'ingest',
      label: '取込・形式検証',
      short: 'Ingest',
      instruction:
        '列構成・行数・区切り形式・欠損や外れ値の有無を確認し、01_ingest.md に整理する。',
      llm: emptyLlmConfig(),
    },
    {
      key: 'preprocess',
      label: '前処理・校正',
      short: 'Preprocess',
      instruction: '実施した前処理と前提条件をすべて 02_preprocess.md に記録する。',
      llm: emptyLlmConfig(),
    },
    {
      key: 'analysis',
      label: 'データ解析',
      short: 'Analysis',
      instruction: '再現可能なスクリプトで定量解析を行い、中間データと 03_analysis.md を保存する。',
      llm: emptyLlmConfig(),
    },
    {
      key: 'validate',
      label: '科学的妥当性確認',
      short: 'Validation',
      instruction: '単位・フィット品質・限界や未解決の確認事項を 04_validation.md に明記する。',
      llm: emptyLlmConfig(),
    },
    {
      key: 'visualize',
      label: '図表・可視化',
      short: 'Visualization',
      instruction: '単位とキャプションを付けた図を作成し、05_visualization.md にまとめる。',
      llm: emptyLlmConfig(),
    },
    {
      key: 'publish',
      label: 'HTML / PPTX生成',
      short: 'Publish',
      instruction: '手法・図表・結果概要・限界を含む report.html（任意で report.pptx）を作成する。',
      llm: emptyLlmConfig(),
    },
  ];
}

const DEFAULT_PURPOSE =
  '投入された実験データ（CSV / TSV / JSON / TXT / DAT）を定義した工程で自動処理し、各段階の検証記録と再現可能な HTML / PPTX レポートを生成します。';

const DEFAULT_ACCEPTANCE = [
  '- 入力データの列名・単位・欠損値と異常値を記録すること（不明な単位や条件は推測しない）',
  '- 変換・解析の処理手順とスクリプトをジョブの作業ディレクトリに保存すること',
  '- 記述的クイックルックと物理的に検証されたピーク帰属を明確に区別すること',
  '- 最終成果物として自己完結した report.html（任意で report.pptx）を生成すること',
].join('\n');

const WORKER_EVENT_TYPES = new Set<WorkerEventType>([
  'stage.started',
  'stage.progress',
  'stage.succeeded',
  'stage.failed',
  'stage.retry',
  'review.required',
  'artifact.created',
  'job.completed',
  'job.failed',
  'agent.event',
]);

interface ObservedFile {
  signature: string;
  seenAt: number;
  ingested: boolean;
}

const projects = new Map<string, ProjectSpec>();
const inboxWatchers = new Map<string, FSWatcher>();
const jobs = new Map<string, WorkflowJob>();
const allEvents: WorkflowEvent[] = [];
const subscribers = new Set<ServerResponse>();
const observed = new Map<string, ObservedFile>();
let eventSerial = 0;

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function slugifyId(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function normalizeLlmConfig(raw: unknown): LlmConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawModel = typeof input.model === 'string' ? input.model.trim() : '';
  const model = rawModel.replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 100);
  const rawEffort = typeof input.effort === 'string' ? input.effort.trim().toLowerCase() : '';
  const effort: ReasoningEffort = VALID_EFFORTS.has(rawEffort as ReasoningEffort)
    ? (rawEffort as ReasoningEffort)
    : '';
  return { model, effort };
}

function normalizeStages(raw: unknown, fallback: WorkflowStageSpec[]): WorkflowStageSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallback.map((stage) => ({ ...stage, llm: { ...stage.llm } }));
  }

  const seen = new Set<string>();
  const normalized: WorkflowStageSpec[] = [];

  for (const [index, entry] of raw.slice(0, 20).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const label =
      typeof item.label === 'string' && item.label.trim()
        ? item.label.trim().slice(0, 80)
        : `工程 ${index + 1}`;
    const short =
      typeof item.short === 'string' && item.short.trim()
        ? item.short.trim().slice(0, 40)
        : label.slice(0, 24);
    let baseKey = slugifyId(
      typeof item.key === 'string' && item.key.trim() ? item.key : short,
      `stage_${index + 1}`,
    );
    let key = baseKey;
    let suffix = 2;
    while (seen.has(key)) {
      key = `${baseKey}_${suffix}`;
      suffix += 1;
    }
    seen.add(key);

    normalized.push({
      key,
      label,
      short,
      instruction: typeof item.instruction === 'string' ? item.instruction.slice(0, 2000) : '',
      llm: normalizeLlmConfig(item.llm),
    });
  }

  return normalized.length > 0
    ? normalized
    : fallback.map((stage) => ({ ...stage, llm: { ...stage.llm } }));
}

function projectInboxPath(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId, 'inbox');
}

function projectArtifactsPath(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId, 'artifacts');
}

function projectWorkPath(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId, 'work');
}

function ensureProjectDirs(projectId: string): void {
  for (const dir of [
    projectInboxPath(projectId),
    projectArtifactsPath(projectId),
    projectWorkPath(projectId),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function toDisplayRelative(absPath: string): string {
  return path.relative(HOME, absPath).replaceAll('\\', '/');
}

function buildProjectSpec(
  id: string,
  raw: Record<string, unknown>,
  existing?: ProjectSpec,
): ProjectSpec {
  const now = new Date().toISOString();
  const baseStages = existing?.stages ?? defaultStages();
  const stages = normalizeStages(raw.stages, baseStages);
  ensureProjectDirs(id);

  return {
    id,
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, 120)
        : typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim().slice(0, 120)
          : existing?.name || '科学データ解析ワークフロー',
    purpose:
      typeof raw.purpose === 'string'
        ? raw.purpose.slice(0, 2000)
        : (existing?.purpose ?? DEFAULT_PURPOSE),
    acceptanceCriteria:
      typeof raw.acceptanceCriteria === 'string'
        ? raw.acceptanceCriteria.slice(0, 4000)
        : (existing?.acceptanceCriteria ?? DEFAULT_ACCEPTANCE),
    llm: raw.llm !== undefined ? normalizeLlmConfig(raw.llm) : (existing?.llm ?? emptyLlmConfig()),
    stages,
    inboxDir: toDisplayRelative(projectInboxPath(id)),
    artifactsDir: toDisplayRelative(projectArtifactsPath(id)),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : existing?.createdAt || now,
    updatedAt: now,
  };
}

function saveProjects(): void {
  writeFileSync(PROJECTS_FILE, `${JSON.stringify([...projects.values()], null, 2)}\n`, 'utf8');
}

function loadProjects(): void {
  projects.clear();

  if (existsSync(PROJECTS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry || typeof entry !== 'object') continue;
          const item = entry as Record<string, unknown>;
          const id = slugifyId(asString(item.id), DEFAULT_PROJECT_ID);
          if (projects.has(id)) continue;
          const spec = buildProjectSpec(id, item);
          if (typeof item.updatedAt === 'string') spec.updatedAt = item.updatedAt;
          projects.set(id, spec);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to read projects.json, using default:', message);
    }
  } else if (existsSync(LEGACY_WORKFLOW_FILE)) {
    // Migrate previous single workflow-spec.json into the default project.
    try {
      const legacy = JSON.parse(readFileSync(LEGACY_WORKFLOW_FILE, 'utf8')) as Record<
        string,
        unknown
      >;
      const base = defaultStages();
      const rawInst =
        legacy.stageInstructions && typeof legacy.stageInstructions === 'object'
          ? (legacy.stageInstructions as Record<string, unknown>)
          : {};
      const rawStageLlm =
        legacy.stageLlm && typeof legacy.stageLlm === 'object'
          ? (legacy.stageLlm as Record<string, unknown>)
          : {};
      const migratedStages = base.map((stage) => ({
        ...stage,
        instruction:
          typeof rawInst[stage.key] === 'string'
            ? (rawInst[stage.key] as string).slice(0, 2000)
            : stage.instruction,
        llm: normalizeLlmConfig(rawStageLlm[stage.key]),
      }));
      const spec = buildProjectSpec(DEFAULT_PROJECT_ID, {
        ...legacy,
        stages: migratedStages,
      });
      projects.set(DEFAULT_PROJECT_ID, spec);
      saveProjects();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to migrate workflow-spec.json:', message);
    }
  }

  if (projects.size === 0) {
    const spec = buildProjectSpec(DEFAULT_PROJECT_ID, {
      name: '科学データ解析ワークフロー',
    });
    projects.set(DEFAULT_PROJECT_ID, spec);
    saveProjects();
  }
}

loadProjects();

function getDefaultProject(): ProjectSpec {
  const first = projects.get(DEFAULT_PROJECT_ID) ?? projects.values().next().value;
  if (!first) {
    const created = buildProjectSpec(DEFAULT_PROJECT_ID, {});
    projects.set(DEFAULT_PROJECT_ID, created);
    return created;
  }
  return first;
}

function getProjectOrDefault(projectId: string | null | undefined): ProjectSpec {
  if (projectId && projects.has(projectId)) {
    return projects.get(projectId)!;
  }
  return getDefaultProject();
}

function broadcastUpdate(payloadObject: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(payloadObject)}\n\n`;
  for (const subscriber of subscribers) {
    try {
      subscriber.write(payload);
    } catch {
      subscribers.delete(subscriber);
    }
  }
}

function isWorkerEventType(value: unknown): value is WorkerEventType {
  return typeof value === 'string' && WORKER_EVENT_TYPES.has(value as WorkerEventType);
}

function resolveJobStageDefs(event: WorkflowEvent): StageDefinition[] {
  if (Array.isArray(event.stages) && event.stages.length > 0) {
    return event.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      short: stage.short,
    }));
  }
  return defaultStages().map(({ key, label, short }) => ({ key, label, short }));
}

function rebuild(event: WorkflowEvent): void {
  allEvents.push(event);
  eventSerial = Math.max(eventSerial, Number(event.sequence) || 0);
  if (event.type === 'job.created') {
    if (jobs.has(event.jobId)) return;
    const projectId = event.projectId || DEFAULT_PROJECT_ID;
    const stageDefs = resolveJobStageDefs(event);
    jobs.set(event.jobId, {
      id: event.jobId,
      projectId,
      file: event.file ?? 'unknown.csv',
      bytes: event.bytes ?? 0,
      hash: event.hash ?? '',
      createdAt: event.at,
      demo: Boolean(event.demo),
      needsReview: Boolean(event.needsReview),
      status: 'queued',
      agent: null,
      worker: null,
      startedAt: null,
      finishedAt: null,
      stages: stageDefs.map((stage) => ({
        ...stage,
        status: 'pending',
        attempts: 0,
        startedAt: null,
        endedAt: null,
        summary: null,
      })),
      artifacts: [],
      events: [event],
      reviewApproved: false,
      lastMessage: '新しいファイルを検出',
    });
    return;
  }

  const job = jobs.get(event.jobId);
  if (!job) return;
  job.events.push(event);
  if (event.message) job.lastMessage = event.message;
  const step = job.stages.find((stage) => stage.key === event.stage);

  switch (event.type) {
    case 'job.claimed':
      job.status = 'running';
      job.startedAt ||= event.at;
      job.agent = event.agent || 'demo';
      job.worker = event.worker ?? null;
      break;
    case 'stage.started':
      if (step) {
        step.status = 'running';
        step.attempts += 1;
        step.startedAt = event.at;
        step.endedAt = null;
      }
      break;
    case 'stage.progress':
      if (step && event.summary) {
        step.summary = event.summary;
      }
      break;
    case 'stage.succeeded':
      if (step) {
        step.status = 'success';
        step.endedAt = event.at;
        if (event.summary) {
          step.summary = event.summary;
        } else if (event.message && !step.summary) {
          step.summary = event.message;
        }
      }
      break;
    case 'stage.failed':
      if (step) {
        step.status = 'failed';
        step.endedAt = event.at;
        if (event.summary) {
          step.summary = event.summary;
        } else if (event.message) {
          step.summary = event.message;
        }
      }
      break;
    case 'stage.retry':
      if (step) {
        step.status = 'retry';
      }
      break;
    case 'review.required':
      job.status = 'review';
      if (step) {
        step.status = 'review';
        if (event.summary) {
          step.summary = event.summary;
        } else if (event.message && !step.summary) {
          step.summary = event.message;
        }
      }
      break;
    case 'review.approved':
      job.reviewApproved = true;
      job.status = 'queued';
      if (step) {
        step.status = 'success';
        if (event.summary) step.summary = event.summary;
      } else {
        const reviewStage = job.stages.find((stage) => stage.status === 'review');
        if (reviewStage) reviewStage.status = 'success';
      }
      break;
    case 'artifact.created':
      if (event.artifact && !job.artifacts.some((item) => item.name === event.artifact?.name)) {
        job.artifacts.push(event.artifact);
      }
      break;
    case 'job.completed':
      job.status = 'done';
      job.finishedAt = event.at;
      break;
    case 'job.failed':
      job.status = 'failed';
      job.finishedAt = event.at;
      break;
    default:
      break;
  }
}

if (existsSync(EVENTS)) {
  for (const line of readFileSync(EVENTS, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      rebuild(JSON.parse(line) as WorkflowEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Skipping broken event:', message);
    }
  }
}

type NewEventPayload = Omit<WorkflowEvent, 'at' | 'sequence'> & { type: EventType };

function appendEvent(data: NewEventPayload): WorkflowEvent {
  const event: WorkflowEvent = {
    ...data,
    at: new Date().toISOString(),
    sequence: ++eventSerial,
  };
  appendFileSync(EVENTS, `${JSON.stringify(event)}\n`);
  rebuild(event);
  broadcastUpdate({ sequence: event.sequence, projectId: event.projectId });
  return event;
}

function cleanName(value: string | null | undefined): string {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1);
  return (normalized || 'data.csv')
    .replace(/[^\p{L}\p{N}_.()\- ]/gu, '_')
    .slice(0, 110)
    .replace(/^\.+/, '_');
}

function deliverJSON(res: ServerResponse, data: unknown, code = 200): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, limit = 100_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
      } else {
        parts.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function jobWorkspace(job: WorkflowJob): string {
  const legacy = path.join(LEGACY_WORK, job.id);
  if (!job.events[0].projectId && existsSync(legacy)) return legacy;
  return path.join(projectWorkPath(job.projectId), job.id);
}

function inputSnapshot(id: string, file: string): string {
  return path.join(DATA, 'inputs', id, file);
}

function saveInput(id: string, file: string, bytes: Buffer): string {
  const dest = inputSnapshot(id, file);
  mkdirSync(path.dirname(dest), { recursive: true });
  const temp = dest + '.' + randomUUID();
  try {
    writeFileSync(temp, bytes, { flag: 'wx' });
    renameSync(temp, dest);
  } finally {
    rmSync(temp, { force: true });
  }
  return dest;
}

function findJobInputFile(job: WorkflowJob): string | null {
  const snapshot = inputSnapshot(job.id, job.file);
  if (existsSync(snapshot)) return snapshot;
  // Older events have no snapshot. Only recover bytes matching the original input.
  const roots = [jobWorkspace(job), projectInboxPath(job.projectId), LEGACY_INBOX];
  for (const root of roots) {
    const file = path.join(root, job.file);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') === job.hash) {
      return saveInput(job.id, job.file, bytes);
    }
  }
  return null;
}

function findJobArtifactFile(job: WorkflowJob, artifactName: string): string {
  const projectFile = path.join(projectArtifactsPath(job.projectId), job.id, artifactName);
  if (existsSync(projectFile)) return projectFile;
  return path.join(LEGACY_ARTIFACTS, job.id, artifactName);
}

function enqueue(
  file: string,
  options: { projectId?: string; inboxRoot?: string; demo?: boolean; needsReview?: boolean } = {},
): WorkflowJob {
  const project = getProjectOrDefault(options.projectId);
  const basename = cleanName(file);
  const inboxDir = options.inboxRoot || projectInboxPath(project.id);
  const absolute = path.join(inboxDir, basename);
  const bytes = readFileSync(absolute);
  const hash = createHash('sha256').update(bytes).digest('hex');

  const existing = Array.from(jobs.values()).find(
    (job) => job.projectId === project.id && job.file === basename && job.hash === hash,
  );
  if (existing) return existing;

  let id: string;
  do {
    id = `run_${randomUUID().slice(0, 8)}`;
  } while (jobs.has(id));
  const stageDefs: StageDefinition[] = project.stages.map(({ key, label, short }) => ({
    key,
    label,
    short,
  }));
  saveInput(id, basename, bytes);
  appendEvent({
    type: 'job.created',
    jobId: id,
    projectId: project.id,
    file: basename,
    bytes: bytes.length,
    hash,
    demo: Boolean(options.demo),
    needsReview: Boolean(options.needsReview),
    stages: stageDefs,
  });
  mkdirSync(path.join(projectWorkPath(project.id), id), { recursive: true });
  mkdirSync(path.join(projectArtifactsPath(project.id), id), { recursive: true });
  const created = jobs.get(id);
  if (!created) throw new Error(`Failed to register job ${id}`);
  return created;
}

function scanInboxDir(dir: string, projectId: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!/\.(csv|tsv|json|txt|dat)$/i.test(name)) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (!st.isFile() || st.size > MAX_UPLOAD) continue;
      const obsKey = `${dir}::${name}`;
      const signature = `${st.size}:${st.mtimeMs}`;
      const previous = observed.get(obsKey);
      if (previous?.signature === signature) {
        if (
          !previous.ingested &&
          Date.now() - previous.seenAt > 1200 &&
          Date.now() - st.mtimeMs > 700
        ) {
          observed.set(obsKey, { signature, seenAt: previous.seenAt, ingested: true });
          enqueue(name, { projectId, inboxRoot: dir });
        }
      } else {
        observed.set(obsKey, { signature, seenAt: Date.now(), ingested: false });
      }
    } catch {
      // File may still be written or removed concurrently.
    }
  }
}

function scanAllInboxes(): void {
  for (const project of projects.values()) {
    scanInboxDir(projectInboxPath(project.id), project.id);
  }
  scanInboxDir(LEGACY_INBOX, getDefaultProject().id);
}

function ensureInboxWatcher(dir: string): void {
  if (inboxWatchers.has(dir)) return;
  try {
    const watcher = watch(dir, { persistent: false }, () => {
      const timer = setTimeout(scanAllInboxes, 350);
      timer.unref();
    });
    watcher.on('error', (err) => console.warn(`Inbox watcher (${dir}):`, err.message));
    inboxWatchers.set(dir, watcher);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`FS watch unavailable (${dir}); using polling fallback:`, message);
  }
}

function syncInboxWatchers(): void {
  for (const project of projects.values()) {
    ensureProjectDirs(project.id);
    ensureInboxWatcher(projectInboxPath(project.id));
  }
  ensureInboxWatcher(LEGACY_INBOX);
}

syncInboxWatchers();
setInterval(scanAllInboxes, 1000).unref();
scanAllInboxes();

function makeSample(projectId?: string, review = false): WorkflowJob {
  const project = getProjectOrDefault(projectId);
  ensureProjectDirs(project.id);
  const id = randomUUID().slice(0, 6);
  const name = `LiMg_XPS_${id}.csv`;
  const rows = ['BindingEnergy_eV,Intensity_a_u'];
  for (let i = 0; i <= 140; i += 1) {
    const x = 50 + i * 0.08;
    const y =
      140 +
      650 * Math.exp(-(((x - 54.1) / 0.48) ** 2)) +
      370 * Math.exp(-(((x - 56.4) / 0.7) ** 2)) +
      Math.sin(i * 1.7) * 9;
    rows.push(`${x.toFixed(3)},${y.toFixed(2)}`);
  }
  const inboxDir = projectInboxPath(project.id);
  writeFileSync(path.join(inboxDir, name), rows.join('\n'));
  return enqueue(name, {
    projectId: project.id,
    inboxRoot: inboxDir,
    demo: true,
    needsReview: review,
  });
}

function serveFile(
  res: ServerResponse,
  filepath: string,
  contentType: string,
  method = 'GET',
  artifact = false,
): void {
  if (!existsSync(filepath) || !statSync(filepath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };

  if (artifact) {
    headers['content-security-policy'] =
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'";
  } else if (contentType.startsWith('text/html')) {
    headers['content-security-policy'] =
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  }

  res.writeHead(200, headers);
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filepath).pipe(res);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
};

interface DemoRequestBody {
  projectId?: string;
  review?: boolean;
}

interface ClaimRequestBody {
  agent?: string;
  worker?: string;
  projectId?: string;
}

interface EventRequestBody {
  type?: unknown;
  stage?: unknown;
  message?: unknown;
  summary?: unknown;
  details?: unknown;
  stageConfig?: { instruction?: unknown; llm?: unknown };
  artifact?: { name?: unknown };
}

const server = http.createServer(async (req, res) => {
  let url: URL;
  let pathname: string;
  try {
    url = new URL(req.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return deliverJSON(res, { error: 'Invalid URL' }, 400);
  }

  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      const requestedProjectId = url.searchParams.get('project');
      const activeProject = getProjectOrDefault(requestedProjectId);
      const allSortedJobs = [...jobs.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const filteredJobs = requestedProjectId
        ? allSortedJobs.filter((job) => job.projectId === activeProject.id)
        : allSortedJobs;
      const jobIds = new Set(filteredJobs.map((job) => job.id));
      const filteredEvents = requestedProjectId
        ? allEvents.filter((event) => jobIds.has(event.jobId)).slice(-300)
        : allEvents.slice(-300);

      return deliverJSON(res, {
        projects: [...projects.values()],
        project: activeProject,
        jobs: filteredJobs,
        events: filteredEvents,
        stages: activeProject.stages.map(({ key, label, short }) => ({ key, label, short })),
        updatedAt: new Date().toISOString(),
      });
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      return deliverJSON(res, { projects: [...projects.values()] });
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      const raw = JSON.parse((await readBody(req, 100_000)).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      const rawName = asString(raw.name || raw.title).trim();
      if (!rawName) {
        return deliverJSON(res, { error: 'Project name is required' }, 400);
      }
      const requestedId = asString(raw.id).trim();
      const baseId = slugifyId(requestedId || rawName, `project-${randomUUID().slice(0, 6)}`);
      let id = baseId;
      let suffix = 2;
      while (projects.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      const created = buildProjectSpec(id, { ...raw, name: rawName });
      projects.set(id, created);
      saveProjects();
      syncInboxWatchers();
      broadcastUpdate({ projectId: id, projectUpdatedAt: created.updatedAt });
      return deliverJSON(res, { project: created, projects: [...projects.values()] }, 201);
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([a-z0-9_-]+)$/);
    if (projectMatch && req.method === 'GET') {
      const project = projects.get(projectMatch[1]);
      if (!project) return deliverJSON(res, { error: 'Project not found' }, 404);
      return deliverJSON(res, { project });
    }

    if (projectMatch && req.method === 'PUT') {
      const projectId = projectMatch[1];
      const raw = JSON.parse((await readBody(req, 100_000)).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      const existing = projects.get(projectId);
      if (!existing) return deliverJSON(res, { error: 'Project not found' }, 404);
      const updated = buildProjectSpec(projectId, raw, existing);
      projects.set(projectId, updated);
      saveProjects();
      broadcastUpdate({ projectId, projectUpdatedAt: updated.updatedAt });
      return deliverJSON(res, { project: updated, projects: [...projects.values()] });
    }

    if (projectMatch && req.method === 'DELETE') {
      const projectId = projectMatch[1];
      if (!projects.has(projectId)) return deliverJSON(res, { error: 'Project not found' }, 404);
      if (projects.size <= 1) {
        return deliverJSON(res, { error: 'At least one project must remain' }, 400);
      }
      if (
        [...jobs.values()].some(
          (job) => job.projectId === projectId && job.status !== 'done' && job.status !== 'failed',
        )
      ) {
        return deliverJSON(
          res,
          { error: '未完了のジョブがあるプロジェクトは削除できません。' },
          409,
        );
      }
      const dir = projectInboxPath(projectId);
      inboxWatchers.get(dir)?.close();
      inboxWatchers.delete(dir);
      projects.delete(projectId);
      saveProjects();
      broadcastUpdate({ deletedProjectId: projectId });
      return deliverJSON(res, { ok: true, projects: [...projects.values()] });
    }

    // Legacy single-workflow endpoints mapped to requested or default project.
    if (pathname === '/api/workflow' && req.method === 'GET') {
      const project = getProjectOrDefault(url.searchParams.get('project'));
      return deliverJSON(res, { project });
    }

    if (pathname === '/api/workflow' && req.method === 'PUT') {
      const target = getProjectOrDefault(url.searchParams.get('project'));
      const raw = JSON.parse((await readBody(req, 100_000)).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      const updated = buildProjectSpec(target.id, raw, target);
      projects.set(target.id, updated);
      saveProjects();
      broadcastUpdate({ projectId: target.id, projectUpdatedAt: updated.updatedAt });
      return deliverJSON(res, { project: updated });
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      subscribers.add(res);
      const keep = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          // Handled on close.
        }
      }, 12_000);
      req.on('close', () => {
        clearInterval(keep);
        subscribers.delete(res);
      });
      return;
    }

    if (pathname === '/api/demo' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as DemoRequestBody;
      if (body.projectId && !projects.has(body.projectId))
        return deliverJSON(res, { error: 'Project not found' }, 404);
      return deliverJSON(res, { job: makeSample(body.projectId, Boolean(body.review)) }, 201);
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      const requestedId = url.searchParams.get('project');
      const project = requestedId ? projects.get(requestedId) : getDefaultProject();
      if (!project) return deliverJSON(res, { error: 'Project not found' }, 404);
      const name = cleanName(url.searchParams.get('filename'));
      if (!/\.(csv|tsv|txt|json|dat)$/i.test(name)) {
        return deliverJSON(res, { error: 'Supported extensions: csv,tsv,txt,json,dat' }, 400);
      }
      const body = await readBody(req, MAX_UPLOAD);
      if (!projects.has(project.id)) return deliverJSON(res, { error: 'Project not found' }, 404);
      if (!body.length) {
        return deliverJSON(res, { error: 'Empty file' }, 400);
      }
      const safe = `${path.parse(name).name.slice(0, 70)}_${randomUUID().slice(0, 5)}${path.extname(name)}`;
      const inboxDir = projectInboxPath(project.id);
      writeFileSync(path.join(inboxDir, safe), body, { flag: 'wx' });
      return deliverJSON(
        res,
        { job: enqueue(safe, { projectId: project.id, inboxRoot: inboxDir }) },
        201,
      );
    }

    if (pathname === '/api/jobs/claim' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as ClaimRequestBody;
      const requestedProject =
        typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
      const job = [...jobs.values()]
        .filter(
          (item) =>
            item.status === 'queued' && (!requestedProject || item.projectId === requestedProject),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return deliverJSON(res, { job: null });

      const project = projects.get(job.projectId);
      const input = project && findJobInputFile(job);
      if (!project || !input) {
        const message = project
          ? '登録時の入力ファイルを復元できません。'
          : 'ジョブのプロジェクトが見つかりません。';
        appendEvent({ type: 'job.failed', projectId: job.projectId, jobId: job.id, message });
        return deliverJSON(res, { job: null });
      }
      ensureProjectDirs(project.id);
      appendEvent({
        type: 'job.claimed',
        jobId: job.id,
        projectId: job.projectId,
        agent: String(body.agent || 'demo').slice(0, 30),
        worker: String(body.worker || os.hostname()).slice(0, 80),
      });
      return deliverJSON(res, {
        job: jobs.get(job.id),
        paths: {
          input,
          work: jobWorkspace(job),
          artifacts: path.join(projectArtifactsPath(job.projectId), job.id),
        },
        project,
      });
    }

    const logMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/logs$/);
    if (logMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const job = jobs.get(logMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      const output = `${[
        `Railflow run ${job.id}`,
        `Project: ${job.projectId}`,
        `File: ${job.file}`,
        `Status: ${job.status}`,
        `Agent: ${job.agent || 'unassigned'}`,
        `Created: ${job.createdAt}`,
        '',
        ...job.events.map(
          (event) =>
            `[${event.at}] ${event.type}${event.stage ? ` [${event.stage}]` : ''} ${event.message || ''}${
              event.summary ? `\n  Summary: ${event.summary}` : ''
            }${event.details ? `\n  ${event.details.replace(/\n/g, '\n  ')}` : ''}`,
        ),
      ].join('\n')}\n`;
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${job.id}.log"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? '' : output);
      return;
    }

    const eventMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/events$/);
    if (eventMatch && req.method === 'POST') {
      const job = jobs.get(eventMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      const input = JSON.parse(
        (await readBody(req, 100_000)).toString('utf8') || '{}',
      ) as EventRequestBody;
      if (!isWorkerEventType(input.type)) {
        return deliverJSON(res, { error: 'Unsupported event' }, 400);
      }
      const stageKey = typeof input.stage === 'string' && input.stage.trim() ? input.stage : null;
      if (stageKey && !job.stages.some((stage) => stage.key === stageKey)) {
        return deliverJSON(res, { error: 'Unsupported stage' }, 400);
      }

      let artifact: ArtifactInfo | undefined;
      if (input.type === 'artifact.created') {
        const artifactName = asString(input.artifact?.name);
        const artifactPath = findJobArtifactFile(job, artifactName);
        if (
          !artifactName ||
          artifactName !== path.basename(artifactName) ||
          !existsSync(artifactPath)
        ) {
          return deliverJSON(res, { error: 'Artifact not found' }, 400);
        }
        artifact = {
          name: artifactName,
          uri: `/artifacts/${encodeURIComponent(job.projectId)}/${job.id}/${encodeURIComponent(artifactName)}`,
          bytes: statSync(artifactPath).size,
        };
      }

      const rawSummary = asString(input.summary).trim();
      const rawDetails = asString(input.details);
      appendEvent({
        type: input.type,
        jobId: job.id,
        projectId: job.projectId,
        stage: stageKey,
        message: asString(input.message).slice(0, 600),
        summary: rawSummary ? rawSummary.slice(0, 1200) : undefined,
        artifact,
        stageConfig:
          input.type === 'stage.started' && input.stageConfig
            ? {
                instruction: asString(input.stageConfig.instruction).slice(0, 2000),
                llm: normalizeLlmConfig(input.stageConfig.llm),
              }
            : undefined,
        details: rawDetails ? rawDetails.slice(0, 1300) : undefined,
      });
      return deliverJSON(res, { ok: true });
    }

    const reviewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/approve$/);
    if (reviewMatch && req.method === 'POST') {
      const job = jobs.get(reviewMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      if (job.status !== 'review') return deliverJSON(res, { error: 'Not in review' }, 409);
      const reviewStage = job.stages.find((stage) => stage.status === 'review')?.key ?? null;
      appendEvent({
        type: 'review.approved',
        jobId: job.id,
        projectId: job.projectId,
        stage: reviewStage,
        message: '人間がレビューを承認',
      });
      return deliverJSON(res, { ok: true });
    }

    if (pathname.startsWith('/artifacts/') && (req.method === 'GET' || req.method === 'HEAD')) {
      // Support both project-scoped /artifacts/:projectId/:jobId/:file and legacy /artifacts/:jobId/:file
      const scopedMatch = pathname.match(
        /^\/artifacts\/([a-z0-9_-]+)\/(run_[a-f0-9]{8})\/([^/]+)$/,
      );
      const legacyMatch = pathname.match(/^\/artifacts\/(run_[a-f0-9]{8})\/([^/]+)$/);
      const jobId = scopedMatch ? scopedMatch[2] : legacyMatch ? legacyMatch[1] : null;
      const artifact = scopedMatch ? scopedMatch[3] : legacyMatch ? legacyMatch[2] : null;
      if (!jobId || !artifact) {
        return deliverJSON(res, { error: 'Not found' }, 404);
      }
      const job = jobs.get(jobId);
      if (!job) {
        return deliverJSON(res, { error: 'Not found' }, 404);
      }
      if (scopedMatch && scopedMatch[1] !== job.projectId) {
        return deliverJSON(res, { error: 'Not found' }, 404);
      }
      if (artifact !== path.basename(artifact)) {
        return deliverJSON(res, { error: 'Invalid path' }, 400);
      }
      const file = findJobArtifactFile(job, artifact);
      return serveFile(
        res,
        file,
        MIME_TYPES[path.extname(file)] || 'application/octet-stream',
        req.method,
        true,
      );
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const route = pathname.replace(/\/$/, '');
      const segment =
        route === ''
          ? 'index.html'
          : ['/projects', '/workflow', '/jobs'].includes(route)
            ? route.slice(1) + '.html'
            : pathname.slice(1);
      if (segment.includes('..') || segment.startsWith('.')) {
        return deliverJSON(res, { error: 'Invalid path' }, 400);
      }
      const file = path.resolve(DIST, segment);
      if (!file.startsWith(DIST + path.sep)) {
        return deliverJSON(res, { error: 'Invalid path' }, 400);
      }
      if (
        !existsSync(file) &&
        ['index.html', 'workflow.html', 'projects.html', 'jobs.html'].includes(segment)
      ) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Frontend build not found in dist/. Run "pnpm run build" or use "pnpm run dev".');
        return;
      }
      return serveFile(
        res,
        file,
        MIME_TYPES[path.extname(file)] || 'application/octet-stream',
        req.method,
        false,
      );
    }

    deliverJSON(res, { error: 'Unknown route' }, 404);
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      deliverJSON(res, { error: message }, 500);
    }
  }
});

const PORT = Number(process.env.PORT || 4173);
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`Railflow monitor listening on http://127.0.0.1:${port}`);
});
