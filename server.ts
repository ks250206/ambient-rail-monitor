import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  type FSWatcher,
  mkdirSync,
  lstatSync,
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

import { DEFAULT_INPUT, projectAutomation, stageAutomation } from './shared/automation.ts';
import { failedEvidence, parseCondition, validRelativePath } from './shared/conditions.ts';
import type { ConditionResult } from './shared/conditions.ts';
import {
  checkCondition,
  INPUT_LIMITS,
  inventory,
  safeFile,
  snapshotDataset,
  verifyDataset,
} from './shared/datasets.ts';
import type { Inventory } from './shared/datasets.ts';
import {
  boundedInteger,
  canRetry,
  MAX_BUDGET_MS,
  resolveExecution,
} from './shared/execution-policy.ts';
import type { FailureKind } from './shared/execution-policy.ts';
import { validateTemplate } from './shared/prompts.ts';

import type {
  ArtifactInfo,
  InputCandidate,
  EventType,
  LlmConfig,
  ProjectSpec,
  ReasoningEffort,
  StageDefinition,
  WorkerEventType,
  WorkflowEvent,
  WorkflowJob,
  WorkflowStageSpec,
  WorkflowSnapshot,
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
  'stage.executed',
  'gate.evaluated',
  'stage.progress',
  'stage.succeeded',
  'stage.failed',
  'stage.retry',
  'stage.retry.ready',
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
const inputCandidates = new Map<string, InputCandidate[]>();
interface UploadSession {
  id: string;
  projectId: string;
  name: string;
  kind: 'file' | 'directory';
  files: Array<{ path: string; bytes: number }>;
  received: Set<string>;
  busy: Set<string>;
  expiresAt: number;
  jobId?: string;
}
const uploads = new Map<string, UploadSession>();
const UPLOADS = path.join(DATA, 'uploads');
mkdirSync(UPLOADS, { recursive: true });
// Uncommitted transfers never enter a watched inbox and can be discarded on restart.
for (const name of readdirSync(UPLOADS))
  rmSync(path.join(UPLOADS, name), { recursive: true, force: true });
setInterval(() => {
  for (const [id, upload] of uploads) {
    if (upload.expiresAt < Date.now() && upload.busy.size === 0) {
      rmSync(path.join(UPLOADS, id), { recursive: true, force: true });
      uploads.delete(id);
    }
  }
}, 60_000).unref();
let eventSerial = 0;

class HttpError extends Error {
  status: number;
  result?: ConditionResult;
  constructor(status: number, message: string, result?: ConditionResult) {
    super(message);
    this.status = status;
    this.result = result;
  }
}

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
  if (raw === undefined) {
    return fallback.map((stage) => ({ ...stage, llm: { ...stage.llm } }));
  }

  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20)
    throw new Error('工程は1〜20件で指定してください。');
  const seen = new Set<string>();
  const normalized: WorkflowStageSpec[] = [];

  for (const [index, entry] of raw.slice(0, 20).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('工程の形式が不正です。');
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
      instruction: typeof item.instruction === 'string' ? item.instruction.slice(0, 8000) : '',
      llm: normalizeLlmConfig(item.llm),
      ...stageAutomation(item),
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
  let stages: WorkflowStageSpec[];
  let automation: ReturnType<typeof projectAutomation>;
  try {
    stages = normalizeStages(raw.stages, baseStages);
    automation = projectAutomation(raw, existing);
    validateTemplate(automation.prompt ?? '');
    for (const stage of stages) {
      validateTemplate(stage.instruction);
      validateTemplate(stage.acceptanceCriteria ?? '');
    }
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
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
    ...automation,
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
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            throw new Error('工程の形式が不正です。');
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

function validate<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
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
      lastMessage: event.dataset
        ? `${event.dataset.files.length} ファイルを登録`
        : '新しいファイルを検出',
      dataset: event.dataset,
      workflow: event.workflow,
    });
    return;
  }

  const job = jobs.get(event.jobId);
  if (!job) return;
  job.events.push(event);
  if (event.message) job.lastMessage = event.message;
  const step = job.stages.find((stage) => stage.key === event.stage);
  if (step && event.elapsedMs !== undefined) step.activeMs = (step.activeMs ?? 0) + event.elapsedMs;
  if (step && event.workspace) step.workspace = event.workspace;
  if (step && event.failureKind) step.failureKind = event.failureKind;

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
        step.gates = [];
        step.failureKind = undefined;
        step.retryAt = undefined;
        step.reviewSequence = undefined;
        step.deadlineAt = event.deadlineAt;
      }
      break;
    case 'gate.evaluated':
      if (step && event.gate)
        step.gates = [
          ...(step.gates ?? []).filter((gate) => gate.scope !== event.gate!.scope),
          event.gate,
        ];
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
        step.retryAt = event.retryAt;
      }
      break;
    case 'stage.retry.ready':
      if (step) step.retryAt = undefined;
      break;
    case 'review.required':
      job.status = 'review';
      if (step) {
        step.status = 'review';
        step.endedAt ||= event.at;
        step.reviewSequence = event.sequence;
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
        step.approvedAttempt = step.attempts;
        step.reviewSequence = undefined;
        step.endedAt ||= event.at;
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
      for (const active of job.stages) {
        if (active.status === 'running' || active.status === 'retry') {
          active.status = 'failed';
          active.endedAt = event.at;
          active.failureKind = event.failureKind ?? active.failureKind;
        }
      }
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
    let rejected = false;
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        parts.length = 0;
        reject(new HttpError(413, 'Payload too large'));
      } else {
        parts.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, '転送が中断されました。')));
  });
}

async function readJSON(req: IncomingMessage, limit = 100_000): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'JSON オブジェクトを指定してください。');
  return value as Record<string, unknown>;
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
  if (job.dataset) {
    const root = path.join(DATA, 'inputs', job.id);
    return verifyDataset(root, job.dataset) ? path.join(root, job.dataset.files[0].path) : null;
  }
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
  return enqueueInventory(
    project,
    inventory(inboxDir, basename),
    basename,
    'file',
    `${inboxDir === LEGACY_INBOX ? 'legacy' : 'project'}:file:${basename}`,
    {
      ...options,
      single: basename,
      quietMs: Infinity,
      bypassTrigger: Boolean(options.demo),
    },
  );
}

function enqueueInventory(
  project: ProjectSpec,
  list: Inventory,
  name: string,
  kind: 'file' | 'directory',
  source: string,
  options: {
    single?: string;
    demo?: boolean;
    needsReview?: boolean;
    quietMs: number;
    bypassTrigger?: boolean;
  },
): WorkflowJob {
  let id: string;
  do {
    id = `run_${randomUUID().slice(0, 8)}`;
  } while (jobs.has(id));
  const inputDir = path.join(DATA, 'inputs', id);
  mkdirSync(path.dirname(inputDir), { recursive: true });
  const dataset = snapshotDataset(list, inputDir, name, kind, source, options.single);
  try {
    if (!options.bypassTrigger) {
      const result = checkCondition(
        inventory(inputDir),
        name,
        options.quietMs,
        project.input?.condition ?? null,
      );
      if (result.status !== 'pass')
        throw new HttpError(
          422,
          '起動条件を満たしていません。投入内容または条件を確認してください。',
          result,
        );
    }
    const existing = [...jobs.values()].find(
      (job) =>
        job.projectId === project.id &&
        (job.dataset ? job.dataset.source === source : job.file === name) &&
        job.hash === dataset.hash,
    );
    if (existing) {
      rmSync(inputDir, { recursive: true, force: true });
      return existing;
    }
  } catch (error) {
    rmSync(inputDir, { recursive: true, force: true });
    throw error;
  }
  const definition = structuredClone(project);
  const workflow: WorkflowSnapshot = {
    version: 1,
    hash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    project: definition,
  };
  const stageDefs: StageDefinition[] = project.stages.map(({ key, label, short }) => ({
    key,
    label,
    short,
  }));
  mkdirSync(path.join(DATA, 'manifests'), { recursive: true });
  writeFileSync(
    path.join(DATA, 'manifests', `${id}.json`),
    JSON.stringify(dataset, null, 2) + '\n',
  );
  appendEvent({
    type: 'job.created',
    jobId: id,
    projectId: project.id,
    file: name,
    bytes: dataset.bytes,
    hash: dataset.hash,
    dataset,
    workflow,
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

function scanInboxDir(dir: string, project: ProjectSpec): InputCandidate[] {
  const candidates: InputCandidate[] = [];
  const config = project.input ?? DEFAULT_INPUT;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return candidates;
  }
  const currentKeys = new Set<string>();
  for (const name of names) {
    const obsKey = `${dir}::${name}`;
    currentKeys.add(obsKey);
    let kind: 'file' | 'directory' = 'file';
    try {
      const st = lstatSync(path.join(dir, name));
      kind = st.isDirectory() ? 'directory' : 'file';
      if (config.mode === 'file' && kind !== 'file') continue;
      if (config.mode === 'directory' && kind !== 'directory') continue;
      if (kind === 'file' && !/\.(csv|tsv|json|txt|dat)$/i.test(name)) continue;
      if (st.isSymbolicLink()) throw new Error('シンボリックリンクは取り込めません。');
      const list = kind === 'file' ? inventory(dir, name) : inventory(path.join(dir, name));
      const signature = list.signature;
      const previous = observed.get(obsKey);
      if (previous?.signature !== signature) {
        observed.set(obsKey, { signature, seenAt: Date.now(), ingested: false });
      }
      const observation = observed.get(obsKey)!;
      const candidate: InputCandidate = {
        name,
        kind,
        origin: dir === LEGACY_INBOX ? 'legacy' : 'project',
        fileCount: list.files.length,
        bytes: list.bytes,
        status: 'waiting',
        message: '転送完了を待っています。',
      };
      candidates.push(candidate);
      if (observation.ingested) {
        candidate.status = 'registered';
        candidate.message = 'この内容は登録済みです。';
        continue;
      }
      const quietMs = Math.min(
        Date.now() - observation.seenAt,
        ...list.files.map((file) => Date.now() - file.mtimeMs),
      );
      if (list.files.length === 0) {
        candidate.message = 'ファイルの追加を待っています。';
        continue;
      }
      if (quietMs < config.settleMs) {
        candidate.message = `変更が止まってから ${Math.ceil(config.settleMs / 1000)} 秒待ちます。`;
        continue;
      }
      candidate.result = checkCondition(list, name, quietMs, config.condition);
      if (candidate.result.status !== 'pass') {
        candidate.message = failedEvidence(candidate.result);
        if (candidate.result.status === 'error') candidate.status = 'error';
        continue;
      }
      enqueueInventory(
        project,
        list,
        name,
        kind,
        `${dir === LEGACY_INBOX ? 'legacy' : 'project'}:${kind}:${name}`,
        {
          single: kind === 'file' ? name : undefined,
          quietMs,
        },
      );
      observation.ingested = true;
      candidate.status = 'registered';
      candidate.message = 'この内容をジョブとして登録しました。';
    } catch (error) {
      const candidate = candidates.find((item) => item.name === name);
      if (candidate) {
        candidate.status = 'error';
        candidate.message = (error as Error).message;
      } else
        candidates.push({
          name,
          kind,
          origin: dir === LEGACY_INBOX ? 'legacy' : 'project',
          fileCount: 0,
          bytes: 0,
          status: 'error',
          message: (error as Error).message,
        });
    }
  }
  for (const key of observed.keys())
    if (key.startsWith(`${dir}::`) && !currentKeys.has(key)) observed.delete(key);
  return candidates;
}

function scanAllInboxes(): void {
  for (const project of projects.values()) {
    const candidates = scanInboxDir(projectInboxPath(project.id), project);
    if (project.id === getDefaultProject().id)
      candidates.push(...scanInboxDir(LEGACY_INBOX, project));
    if (JSON.stringify(inputCandidates.get(project.id)) !== JSON.stringify(candidates)) {
      inputCandidates.set(project.id, candidates);
      broadcastUpdate({ projectId: project.id, inputsUpdated: true });
    }
  }
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
  stageConfig?: WorkflowEvent['stageConfig'];
  artifact?: { name?: unknown };
  attempt?: unknown;
  elapsedMs?: unknown;
  workspace?: unknown;
  gate?: { scope?: unknown };
  failureKind?: unknown;
  retryAt?: unknown;
  deadlineAt?: unknown;
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
        candidates: inputCandidates.get(activeProject.id) ?? [],
      });
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      return deliverJSON(res, { projects: [...projects.values()] });
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      const raw = await readJSON(req, 4_000_000);
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
      const raw = await readJSON(req, 4_000_000);
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
      const raw = await readJSON(req, 4_000_000);
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
      const body = (await readJSON(req)) as DemoRequestBody;
      if (body.projectId && !projects.has(body.projectId))
        return deliverJSON(res, { error: 'Project not found' }, 404);
      return deliverJSON(res, { job: makeSample(body.projectId, Boolean(body.review)) }, 201);
    }

    if (pathname === '/api/uploads' && req.method === 'POST') {
      const raw = await readJSON(req, 2_000_000);
      const projectId = asString(raw.projectId);
      if (!projects.has(projectId)) throw new HttpError(404, 'Project not found');
      if ([...uploads.values()].filter((item) => !item.jobId).length >= 16)
        throw new HttpError(429, '同時転送の上限です。転送中の入力を完了・取消してください。');
      if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120)
        throw new HttpError(400, 'データセット名を120文字以内で指定してください。');
      if (raw.kind !== 'file' && raw.kind !== 'directory')
        throw new HttpError(400, '入力単位が不正です。');
      if (
        !Array.isArray(raw.files) ||
        raw.files.length < 1 ||
        raw.files.length > INPUT_LIMITS.files
      )
        throw new HttpError(400, '1〜1000ファイルを選択してください。');
      const seen = new Set<string>();
      let bytes = 0;
      const files = raw.files.map((item: unknown) => {
        if (!item || typeof item !== 'object') throw new HttpError(400, 'ファイル一覧が不正です。');
        const file = item as Record<string, unknown>;
        if (
          typeof file.path !== 'string' ||
          !validRelativePath(file.path) ||
          file.path.split('/').length > INPUT_LIMITS.depth
        )
          throw new HttpError(400, '安全な相対パスを指定してください。');
        const portable = file.path.normalize('NFC').toLowerCase();
        if (seen.has(portable))
          throw new HttpError(400, `同じ相対パスが複数あります: ${file.path}`);
        seen.add(portable);
        const size = validate(() =>
          boundedInteger(file.bytes, 'ファイルサイズ', INPUT_LIMITS.fileBytes),
        );
        bytes += size;
        return { path: file.path, bytes: size };
      });
      for (const file of seen) {
        const parts = file.split('/');
        for (let n = 1; n < parts.length; n++)
          if (seen.has(parts.slice(0, n).join('/')))
            throw new HttpError(400, 'ファイルとフォルダのパスが重複しています。');
      }
      if (bytes > INPUT_LIMITS.totalBytes || (raw.kind === 'file' && files.length !== 1))
        throw new HttpError(400, '入力の合計は200MB以内、単一ファイル入力は1件までです。');
      const id = randomUUID();
      uploads.set(id, {
        id,
        projectId,
        name: raw.name.trim(),
        kind: raw.kind,
        files,
        received: new Set(),
        busy: new Set(),
        expiresAt: Date.now() + 30 * 60_000,
      });
      mkdirSync(path.join(UPLOADS, id));
      return deliverJSON(res, { id, files: files.length }, 201);
    }

    const uploadMatch = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})(?:\/(files|commit))?$/);
    if (uploadMatch) {
      const upload = uploads.get(uploadMatch[1]);
      if (!upload) throw new HttpError(404, '転送が見つかりません。再度投入してください。');
      const root = path.join(UPLOADS, upload.id);
      upload.expiresAt = Date.now() + 30 * 60_000;
      if (req.method === 'DELETE' && !uploadMatch[2]) {
        if (upload.busy.size) throw new HttpError(409, '転送中です。');
        rmSync(root, { recursive: true, force: true });
        uploads.delete(upload.id);
        return deliverJSON(res, { ok: true });
      }
      if (req.method === 'PUT' && uploadMatch[2] === 'files') {
        const relative = url.searchParams.get('path');
        const file = upload.files.find((item) => item.path === relative);
        if (!file) throw new HttpError(400, '宣言されていないファイルです。');
        if (upload.jobId || upload.busy.has(file.path))
          throw new HttpError(409, 'このファイルの転送は処理中または確定済みです。');
        upload.busy.add(file.path);
        try {
          const body = await readBody(req, Math.max(1, file.bytes));
          if (body.length !== file.bytes)
            throw new HttpError(400, '宣言されたサイズと一致しません。');
          mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
          writeFileSync(path.join(root, file.path), body);
          upload.received.add(file.path);
          return deliverJSON(res, { received: upload.received.size, total: upload.files.length });
        } finally {
          upload.busy.delete(file.path);
        }
      }
      if (req.method === 'POST' && uploadMatch[2] === 'commit') {
        if (upload.jobId) return deliverJSON(res, { job: jobs.get(upload.jobId) });
        if (upload.busy.size || upload.received.size !== upload.files.length)
          throw new HttpError(409, 'すべてのファイルの転送完了後に確定してください。');
        const project = projects.get(upload.projectId);
        if (!project) throw new HttpError(404, 'Project not found');
        const job = enqueueInventory(
          project,
          inventory(root),
          upload.name,
          upload.kind,
          `upload:${upload.id}`,
          { quietMs: Infinity },
        );
        upload.jobId = job.id;
        rmSync(root, { recursive: true, force: true });
        return deliverJSON(res, { job }, 201);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const checkMatch = pathname.match(/^\/api\/projects\/([a-z0-9_-]+)\/check-input$/);
    if (checkMatch && req.method === 'POST') {
      const project = projects.get(checkMatch[1]);
      if (!project) throw new HttpError(404, 'Project not found');
      const raw = await readJSON(req, 200_000);
      const condition = validate(() => parseCondition(raw.condition, 'trigger'));
      const name = asString(raw.name);
      if (!validRelativePath(name) || name.includes('/'))
        throw new HttpError(400, '監視フォルダ内の入力を選択してください。');
      if (raw.origin !== undefined && raw.origin !== 'project' && raw.origin !== 'legacy')
        throw new HttpError(400, '監視入力の場所が不正です。');
      if (raw.origin === 'legacy' && project.id !== getDefaultProject().id)
        throw new HttpError(400, '旧入力は既定プロジェクトでのみ利用できます。');
      const dir = raw.origin === 'legacy' ? LEGACY_INBOX : projectInboxPath(project.id);
      const target = path.join(dir, name);
      if (!existsSync(target) || lstatSync(target).isSymbolicLink())
        throw new HttpError(404, '入力が見つかりません。');
      const list = lstatSync(target).isDirectory() ? inventory(target) : inventory(dir, name);
      const quiet = Math.max(
        0,
        Math.min(
          Date.now() - (observed.get(`${dir}::${name}`)?.seenAt ?? Date.now()),
          ...list.files.map((file) => Date.now() - file.mtimeMs),
        ),
      );
      return deliverJSON(res, { result: checkCondition(list, name, quiet, condition) });
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
      const source = `upload:${randomUUID()}`;
      const staging = path.join(UPLOADS, randomUUID());
      mkdirSync(staging);
      try {
        writeFileSync(path.join(staging, name), body, { flag: 'wx' });
        return deliverJSON(
          res,
          {
            job: enqueueInventory(project, inventory(staging), name, 'file', source, {
              quietMs: Infinity,
            }),
          },
          201,
        );
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }

    if (pathname === '/api/jobs/claim' && req.method === 'POST') {
      const body = (await readJSON(req)) as ClaimRequestBody;
      const requestedProject =
        typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
      const job = [...jobs.values()]
        .filter(
          (item) =>
            item.status === 'queued' && (!requestedProject || item.projectId === requestedProject),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return deliverJSON(res, { job: null });

      const project = job.workflow?.project ?? projects.get(job.projectId);
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
          inputDir: job.dataset ? path.join(DATA, 'inputs', job.id) : path.dirname(input),
          manifest: job.dataset ? path.join(DATA, 'manifests', `${job.id}.json`) : undefined,
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
        `Input files: ${job.dataset?.files.length ?? 1}`,
        `Workflow revision: ${job.workflow?.hash ?? 'legacy'}`,
        '',
        ...job.events.map(
          (event) =>
            `[${event.at}] ${event.type}${event.stage ? ` [${event.stage}]` : ''} ${event.message || ''}${
              event.summary ? `\n  Summary: ${event.summary}` : ''
            }${event.details ? `\n  ${event.details.replace(/\n/g, '\n  ')}` : ''}${event.gate ? `\n  Gate: ${JSON.stringify(event.gate)}` : ''}${event.failureKind ? `\n  Failure: ${event.failureKind}` : ''}${event.elapsedMs !== undefined ? `\n  Active: ${event.elapsedMs} ms` : ''}`,
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
      const input = (await readJSON(req, 512_000)) as EventRequestBody;
      if (!isWorkerEventType(input.type)) {
        return deliverJSON(res, { error: 'Unsupported event' }, 400);
      }
      const stageKey = typeof input.stage === 'string' && input.stage.trim() ? input.stage : null;
      if (stageKey && !job.stages.some((stage) => stage.key === stageKey)) {
        return deliverJSON(res, { error: 'Unsupported stage' }, 400);
      }

      const step = job.stages.find((stage) => stage.key === stageKey);
      const spec = job.workflow?.project.stages.find((stage) => stage.key === stageKey);
      const policy = resolveExecution(job.workflow?.project.execution, spec?.execution);
      const extras: Partial<WorkflowEvent> = {};
      const stageEvent =
        input.type.startsWith('stage.') ||
        input.type === 'gate.evaluated' ||
        input.type === 'review.required' ||
        input.type === 'agent.event';
      if (job.workflow) {
        if (job.status !== 'running')
          throw new HttpError(409, 'このジョブは実行中ではありません。');
        if (stageEvent && !step) throw new HttpError(400, '工程を指定してください。');
        if (step && stageEvent) {
          const attempt = input.type === 'stage.started' ? step.attempts + 1 : step.attempts;
          if (input.attempt !== attempt) throw new HttpError(409, '試行番号が一致しません。');
          extras.attempt = attempt;
          if (input.type === 'stage.started') {
            const previous = job.stages.slice(0, job.stages.indexOf(step));
            if (
              !['pending', 'retry'].includes(step.status) ||
              previous.some((item) => item.status !== 'success') ||
              attempt > policy.maxRetries + 1
            )
              throw new HttpError(409, '工程の順序またはリトライ上限が不正です。');
          } else if (input.type === 'stage.retry') {
            if (
              step.status !== 'failed' ||
              !step.failureKind ||
              !canRetry(policy, step.failureKind, step.attempts)
            )
              throw new HttpError(409, 'この失敗は再試行できません。');
          } else if (input.type === 'stage.retry.ready') {
            if (step.status !== 'retry' || !step.retryAt)
              throw new HttpError(409, 'リトライ待機中ではありません。');
          } else if (input.type === 'review.required') {
            if (!['running', 'failed'].includes(step.status))
              throw new HttpError(409, 'レビューを開始できません。');
            if (
              step.status === 'failed' &&
              (policy.onFailure !== 'review' ||
                !['execution_error', 'timeout', 'acceptance_failed'].includes(
                  step.failureKind ?? '',
                ))
            )
              throw new HttpError(409, 'この失敗は例外承認の対象ではありません。');
          } else if (step.status !== 'running')
            throw new HttpError(409, 'この工程は実行中ではありません。');
        }
        if (
          step &&
          (input.type === 'gate.evaluated' ||
            input.type === 'stage.succeeded' ||
            (input.type === 'review.required' && step.status === 'running'))
        ) {
          if (
            !job.events.some(
              (event) =>
                event.type === 'stage.executed' &&
                event.stage === step.key &&
                event.attempt === step.attempts,
            )
          )
            throw new HttpError(409, 'エージェント実行の終了が記録されていません。');
        }
        if (
          (input.type === 'stage.succeeded' ||
            (input.type === 'review.required' && step?.status === 'running')) &&
          step
        ) {
          const gates = [
            spec?.gate,
            ...(step === job.stages.at(-1) ? [job.workflow.project.finalGate] : []),
          ];
          if (input.type === 'stage.succeeded' && gates.some((gate) => gate?.requireReview))
            throw new HttpError(409, '人間の承認が必要です。');
          if (
            gates.some(
              (gate, index) =>
                gate?.condition &&
                !step.gates?.some(
                  (item) =>
                    item.scope === (index === 0 ? 'stage' : 'final') &&
                    item.result.status === 'pass',
                ),
            )
          )
            throw new HttpError(409, '受け入れ条件が合格していません。');
        }
        if (
          (input.type === 'artifact.created' || input.type === 'job.completed') &&
          job.stages.some((stage) => stage.status !== 'success')
        )
          throw new HttpError(409, '全工程の合格・承認後に公開してください。');
        if (input.type === 'job.completed' && !job.artifacts.length)
          throw new HttpError(409, '最終成果物がありません。');
      }
      if (input.workspace !== undefined) {
        const relative = asString(input.workspace);
        if (
          !step ||
          relative !==
            `.attempts/${step.key}/${input.type === 'stage.started' ? step.attempts + 1 : step.attempts}`
        )
          throw new HttpError(400, '試行の作業パスが不正です。');
        extras.workspace = relative;
      }
      if (input.elapsedMs !== undefined) {
        if (
          !['stage.succeeded', 'stage.failed', 'stage.retry.ready', 'review.required'].includes(
            input.type,
          )
        )
          throw new HttpError(400, '実行時間を記録できないイベントです。');
        extras.elapsedMs = validate(() =>
          boundedInteger(input.elapsedMs, '実行時間', MAX_BUDGET_MS + 60_000),
        );
      }
      if (input.failureKind !== undefined) {
        if (
          ![
            'execution_error',
            'timeout',
            'acceptance_failed',
            'stage_timeout',
            'job_timeout',
            'interrupted',
          ].includes(asString(input.failureKind))
        )
          throw new HttpError(400, '失敗の種類が不正です。');
        extras.failureKind = input.failureKind as FailureKind;
      }
      for (const key of ['retryAt', 'deadlineAt'] as const) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'string' || !Number.isFinite(Date.parse(input[key])))
            throw new HttpError(400, '期限が不正です。');
          extras[key] = input[key];
        }
      }
      if (input.type === 'gate.evaluated') {
        const scope = input.gate?.scope;
        if (
          !step ||
          (scope !== 'stage' && scope !== 'final') ||
          (scope === 'final' && step !== job.stages.at(-1))
        )
          throw new HttpError(400, '判定対象が不正です。');
        if (job.workflow) {
          if (!step.workspace) throw new HttpError(400, '判定する作業場所がありません。');
          const condition =
            (scope === 'stage' ? spec?.gate : job.workflow.project.finalGate)?.condition ?? null;
          let result: ConditionResult;
          try {
            result = checkCondition(
              inventory(path.join(jobWorkspace(job), step.workspace), undefined, true),
              job.file,
              0,
              condition,
            );
          } catch (error) {
            result = {
              status: 'error',
              label: '出力ファイルの検証',
              message: (error as Error).message,
            };
          }
          extras.gate = { scope, result };
        }
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
      const event = appendEvent({
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
                instruction: asString(input.stageConfig.instruction).slice(0, 8000),
                llm: normalizeLlmConfig(input.stageConfig.llm),
                acceptanceCriteria: spec?.acceptanceCriteria,
                execution: policy,
                gate: spec?.gate,
                prompt: asString(input.stageConfig.prompt).slice(0, 100_000),
              }
            : undefined,
        details: rawDetails ? rawDetails.slice(0, 1300) : undefined,
        ...extras,
      });
      return deliverJSON(res, { ok: true, event });
    }

    const previewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/review(?:\/(file))?$/);
    if (previewMatch && req.method === 'GET') {
      const job = jobs.get(previewMatch[1]);
      const stage = job?.stages.find((item) => item.status === 'review');
      if (!job || !stage?.workspace || job.status !== 'review')
        throw new HttpError(404, 'レビュー中の出力がありません。');
      const root = path.join(jobWorkspace(job), stage.workspace);
      const list = inventory(root, undefined, true);
      if (!previewMatch[2])
        return deliverJSON(res, { files: list.files, reviewSequence: stage.reviewSequence });
      if (Number(url.searchParams.get('sequence')) !== stage.reviewSequence)
        throw new HttpError(409, 'レビュー対象が更新されています。');
      const relative = url.searchParams.get('path') ?? '';
      if (!list.files.some((file) => file.path === relative))
        throw new HttpError(404, '出力が見つかりません。');
      return serveFile(
        res,
        safeFile(root, relative),
        MIME_TYPES[path.extname(relative)] ?? 'application/octet-stream',
        'GET',
        true,
      );
    }

    const reviewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/approve$/);
    if (reviewMatch && req.method === 'POST') {
      const job = jobs.get(reviewMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      if (job.status !== 'review') return deliverJSON(res, { error: 'Not in review' }, 409);
      const step = job.stages.find((stage) => stage.status === 'review');
      const body = await readJSON(req, 10_000);
      if (
        job.workflow &&
        (!step ||
          body.stage !== step.key ||
          body.attempt !== step.attempts ||
          body.reviewSequence !== step.reviewSequence)
      )
        throw new HttpError(
          409,
          'レビュー対象が更新されています。画面を更新して再確認してください。',
        );
      appendEvent({
        type: 'review.approved',
        jobId: job.id,
        projectId: job.projectId,
        stage: step?.key ?? null,
        attempt: step?.attempts,
        reviewSequence: step?.reviewSequence,
        message: step?.failureKind
          ? '人間が失敗内容を確認し、この試行の出力を例外承認'
          : '人間がこの工程・試行のレビューを承認',
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
      if (job.workflow && !job.artifacts.some((item) => item.name === artifact))
        return deliverJSON(res, { error: 'Not published' }, 404);
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
    if (!(err instanceof HttpError) && !(err instanceof SyntaxError))
      console.error('Request error:', err);
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      deliverJSON(
        res,
        {
          error: message,
          ...(err instanceof HttpError && err.result ? { result: err.result } : {}),
        },
        err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500,
      );
    }
  }
});

const PORT = Number(process.env.PORT || 4173);
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`Railflow monitor listening on http://127.0.0.1:${port}`);
});
