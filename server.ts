import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fstatSync,
  type FSWatcher,
  mkdirSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
  unlinkSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INPUT, projectAutomation, stageAutomation } from './shared/automation.ts';
import { failedEvidence, parseCondition, validRelativePath } from './shared/conditions.ts';
import type { ConditionResult } from './shared/conditions.ts';
import {
  checkCondition,
  checkFrozenTrigger,
  isManualInput,
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
  retryDelay,
} from './shared/execution-policy.ts';
import type { FailureKind } from './shared/execution-policy.ts';
import { findRegisteredOnce, observeInput } from './shared/inbox-observation.ts';
import type { InboxObservation } from './shared/inbox-observation.ts';
import { validateTemplate } from './shared/prompts.ts';
import {
  object,
  parseStageGraph,
  parseGraph,
  taskSpec,
  readyTask,
  downstream,
} from './shared/graph.ts';
import { planWorkflow } from './shared/plan.ts';
import {
  checkContracts,
  checkInputContracts,
  ownOutputs,
  outputManifest,
  verifyOutput,
  copyOutput,
  verifyTaskInputs,
  verifyMapInput,
} from './shared/task-files.ts';
import {
  exportTemplate,
  parseWorkflowTemplate,
  templateOrigin,
  type WorkflowTemplate,
} from './shared/templates.ts';
import { QC_FILENAME, QC_MAX_BYTES, parseQcV1Bytes } from './shared/qc.ts';
import { STARTER_WORKFLOWS } from './shared/starter-templates.ts';
import { ResultCache, cacheIdentity } from './shared/result-cache.ts';
import { parseRuntime, runtimeIssues } from './shared/reuse.ts';
import { parseRuntimeSnapshot } from './shared/runtime-environment.ts';
import { priceUsage, usageSummary } from './shared/usage.ts';
import { Journal, type Lease } from './shared/journal.ts';
import { DEFAULT_QUEUE, parseQueue, parsePriority, type QueueSettings } from './shared/queue.ts';

import type {
  ArtifactInfo,
  DatasetManifest,
  DryRunResult,
  InputCandidate,
  EventType,
  JobStage,
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
const RECEIPT_KEY = randomBytes(32);

for (const dir of [LEGACY_INBOX, DATA, LEGACY_ARTIFACTS, LEGACY_WORK, PROJECTS_ROOT]) {
  mkdirSync(dir, { recursive: true });
}

const journal = new Journal(path.join(DATA, 'journal.sqlite'), EVENTS);
const resultCache = new ResultCache(path.join(DATA, 'cache'));
let queueSettings = journal.setting<QueueSettings>('queue') ?? DEFAULT_QUEUE;
const leaseMs = Math.max(1000, Math.min(300_000, Number(process.env.RAILFLOW_LEASE_MS) || 30_000));

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
  'stage.environment',
  'stage.usage',
  'gate.evaluated',
  'stage.progress',
  'stage.succeeded',
  'stage.failed',
  'stage.retry',
  'stage.retry.ready',
  'stage.retry.resumed',
  'job.waiting',
  'review.required',
  'artifact.created',
  'job.completed',
  'job.failed',
  'agent.event',
]);

const projects = new Map<string, ProjectSpec>();
const inboxWatchers = new Map<string, FSWatcher>();
const jobs = new Map<string, WorkflowJob>();
const allEvents: WorkflowEvent[] = [];
const subscribers = new Set<ServerResponse>();
const observed = new Map<string, InboxObservation>();
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

function normalizeStages(
  raw: unknown,
  fallback: WorkflowStageSpec[],
  strict = false,
): WorkflowStageSpec[] {
  if (raw === undefined) {
    return fallback.map((stage) => ({ ...stage, llm: { ...stage.llm } }));
  }

  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50)
    throw new Error('工程は1〜50件で指定してください。');
  const seen = new Set<string>();
  const normalized: WorkflowStageSpec[] = [];

  for (const [index, entry] of raw.slice(0, 50).entries()) {
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
    if (strict && (baseKey !== item.key || seen.has(baseKey)))
      throw new Error('工程キーの形式または重複を確認してください。');
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
      ...parseStageGraph(item),
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
  options: { strictTemplates?: boolean; prepareDirs?: boolean } = {},
): ProjectSpec {
  // A project timestamp also identifies its revision, including back-to-back saves.
  const previousTime = Date.parse(existing?.updatedAt ?? '') || 0;
  const now = new Date(Math.max(Date.now(), previousTime + 1)).toISOString();
  const baseStages = existing?.stages ?? defaultStages();
  let stages: WorkflowStageSpec[];
  let automation: ReturnType<typeof projectAutomation>;
  let graph: ProjectSpec['graph'];
  try {
    stages = normalizeStages(raw.stages, baseStages, !!(raw.graph ?? existing?.graph));
    graph = parseGraph(raw.graph === undefined ? existing?.graph : raw.graph, stages);
    if (
      !graph &&
      stages.some(
        (stage) =>
          (stage.runner?.kind ?? 'ai') !== 'ai' ||
          stage.map ||
          stage.contracts?.inputs.length ||
          stage.contracts?.outputs.length,
      )
    )
      throw new Error('工程の種類・map・入出力契約を使うにはWorkflow v2を有効にしてください。');
    automation = projectAutomation(raw, existing);
    if (stages.some((stage) => stage.cache?.enabled)) {
      if (!graph || !automation.runtime?.revision)
        throw new Error('キャッシュにはWorkflow v2と実行環境の版が必要です。');
      if (
        stages.some(
          (stage) => stage.cache?.enabled && ['human', 'http'].includes(stage.runner?.kind ?? 'ai'),
        )
      )
        throw new Error('承認・HTTP工程はキャッシュ対象外です。');
    }
    if (
      !graph &&
      (automation.runtime?.python ||
        automation.runtime?.revision ||
        Object.keys(automation.runtime?.expected ?? {}).length ||
        Object.keys(automation.runtime?.packages ?? {}).length)
    )
      throw new Error('実行環境の固定にはWorkflow v2が必要です。');
    if (options.strictTemplates !== false) {
      validateTemplate(automation.prompt ?? '');
      for (const stage of stages) {
        validateTemplate(stage.instruction);
        validateTemplate(stage.acceptanceCriteria ?? '');
        if (stage.runner?.kind === 'command' || stage.runner?.kind === 'python')
          for (const arg of stage.runner.args) validateTemplate(arg);
        if (stage.runner?.kind === 'http') {
          validateTemplate(stage.runner.url);
          validateTemplate(stage.runner.body);
        }
      }
    }
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  if (options.prepareDirs !== false) ensureProjectDirs(id);

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
    graph,
    templateOrigin: existing?.templateOrigin ?? validate(() => templateOrigin(raw.templateOrigin)),
  };
}

/**
 * Entries that could not be loaded are written back verbatim so that a later save
 * never silently drops them; their ids stay reserved until the entry is repaired.
 */
let unreadableProjectEntries: unknown[] = [];
const reservedProjectIds = new Set<string>();

function saveProjects(): void {
  writeFileSync(
    PROJECTS_FILE,
    `${JSON.stringify([...projects.values(), ...unreadableProjectEntries], null, 2)}\n`,
    'utf8',
  );
}

function loadProjects(): void {
  projects.clear();
  unreadableProjectEntries = [];
  reservedProjectIds.clear();
  const unreadable: unknown[] = [];
  const hadProjectsFile = existsSync(PROJECTS_FILE);

  if (hadProjectsFile) {
    try {
      const parsed = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          try {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
              throw new Error('工程の形式が不正です。');
            const item = entry as Record<string, unknown>;
            const id = slugifyId(asString(item.id), DEFAULT_PROJECT_ID);
            if (projects.has(id)) throw new Error(`プロジェクトIDが重複しています: ${id}`);
            const spec = buildProjectSpec(id, item, undefined, { strictTemplates: false });
            if (typeof item.updatedAt === 'string') spec.updatedAt = item.updatedAt;
            projects.set(id, spec);
          } catch (entryErr) {
            const message = entryErr instanceof Error ? entryErr.message : String(entryErr);
            console.error('Failed to load project entry from projects.json:', message);
            unreadable.push(entry);
          }
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
      const spec = buildProjectSpec(
        DEFAULT_PROJECT_ID,
        {
          ...legacy,
          stages: migratedStages,
        },
        undefined,
        { strictTemplates: false },
      );
      projects.set(DEFAULT_PROJECT_ID, spec);
      saveProjects();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to migrate workflow-spec.json:', message);
    }
  }

  if (projects.size > 0 && unreadable.length > 0) {
    // Keep an untouched copy for manual repair before any later save rewrites the file.
    try {
      copyFileSync(PROJECTS_FILE, `${PROJECTS_FILE}.corrupt-${Date.now()}`);
    } catch (backupErr) {
      console.error('Failed to back up partially unreadable projects.json:', backupErr);
    }
    unreadableProjectEntries = unreadable;
    for (const entry of unreadable) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const rawId = asString((entry as Record<string, unknown>).id);
        if (rawId.trim()) reservedProjectIds.add(slugifyId(rawId, DEFAULT_PROJECT_ID));
      }
    }
  }

  if (projects.size === 0) {
    if (hadProjectsFile && existsSync(PROJECTS_FILE)) {
      try {
        renameSync(PROJECTS_FILE, `${PROJECTS_FILE}.corrupt-${Date.now()}`);
      } catch (backupErr) {
        console.error('Failed to back up unreadable projects.json:', backupErr);
      }
    }
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
  if (event.workflow?.version === 2 && event.workflow.plan) return event.workflow.plan;
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
      priority: event.priority ?? event.workflow?.project.queue?.priority ?? 0,
      recoveryCount: 0,
      parentJobId: event.parentJobId,
      activeMs: 0,
      agent: null,
      worker: null,
      startedAt: null,
      finishedAt: null,
      stages: stageDefs.map((stage) => ({
        ...stage,
        status: 'pending',
        attempts: 0,
        retryCount: 0,
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
  if (event.jobElapsedMs !== undefined) job.activeMs = (job.activeMs ?? 0) + event.jobElapsedMs;
  const step = job.stages.find((stage) => stage.key === event.stage);
  if (step && event.elapsedMs !== undefined) step.activeMs = (step.activeMs ?? 0) + event.elapsedMs;
  if (step && event.workspace) step.workspace = event.workspace;
  if (step && event.output) step.output = event.output;
  if (step && event.completion) step.completion = event.completion;
  if (step && event.runtime) step.runtime = event.runtime;
  if (step && event.cache) step.cache = event.cache;
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
        step.runtime = undefined;
        step.cache = undefined;
        step.output = undefined;
        step.completion = undefined;
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
    case 'stage.reused':
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
        step.retryAt = undefined;
        step.retryRemainingMs = undefined;
        if (event.summary) {
          step.summary = event.summary;
        } else if (event.message) {
          step.summary = event.message;
        }
      }
      break;
    case 'stage.retry':
      if (step) {
        step.retryCount = (step.retryCount ?? 0) + 1;
        step.status = 'retry';
        step.retryAt = event.retryAt;
      }
      break;
    case 'stage.retry.paused':
      if (step) {
        step.retryRemainingMs = event.retryRemainingMs;
        step.retryAt = undefined;
      }
      break;
    case 'stage.retry.resumed':
      if (step) {
        step.retryAt = event.retryAt;
        step.retryRemainingMs = undefined;
      }
      break;
    case 'stage.retry.ready':
      if (step) {
        step.retryAt = undefined;
        step.retryRemainingMs = undefined;
      }
      break;
    case 'review.required':
      if (job.workflow?.version !== 2) job.status = 'review';
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
      if (job.status !== 'running') job.status = 'queued';
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
    case 'stage.interrupted':
      if (step) {
        step.status = 'pending';
        step.endedAt = event.at;
        step.failureKind = 'interrupted';
        step.gates = [];
        step.runtime = undefined;
        step.cache = undefined;
        step.output = undefined;
        step.completion = undefined;
        step.reviewSequence = undefined;
        step.deadlineAt = undefined;
        step.workspace = undefined;
      }
      break;
    case 'job.pause.requested':
      job.status = 'pausing';
      break;
    case 'job.cancel.requested':
      job.status = 'cancelling';
      break;
    case 'job.paused':
      job.status = 'paused';
      job.worker = null;
      break;
    case 'job.cancelled':
      job.status = 'cancelled';
      job.finishedAt = event.at;
      job.worker = null;
      break;
    case 'job.resumed':
      job.status =
        job.stages.some((item) => item.status === 'review') &&
        !(job.workflow?.version === 2 && job.stages.some((item) => readyTask(job, item)))
          ? 'review'
          : 'queued';
      break;
    case 'job.recovered':
      job.status = 'queued';
      job.worker = null;
      job.recoveryCount = event.recoveryCount ?? (job.recoveryCount ?? 0) + 1;
      break;
    case 'job.priority':
      job.priority = event.priority ?? 0;
      break;
    case 'job.waiting':
      job.status = 'review';
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

for (const event of journal.events()) rebuild(event);

type NewEventPayload = Omit<WorkflowEvent, 'at' | 'sequence'> & { type: EventType };

function appendEvent(
  data: NewEventPayload,
  lease?: Lease | null,
  request?: { id: string; token: string },
): WorkflowEvent {
  const releases =
    lease === null ||
    (lease === undefined &&
      ([
        'job.completed',
        'job.failed',
        'job.paused',
        'job.cancelled',
        'job.recovered',
        'job.waiting',
      ].includes(data.type) ||
        (data.type === 'review.required' && jobs.get(data.jobId)?.workflow?.version !== 2)));
  const activeLease = releases ? journal.lease(data.jobId) : undefined;
  const claimed =
    activeLease && jobs.get(data.jobId)?.events.findLast((event) => event.type === 'job.claimed');
  const event: WorkflowEvent = {
    ...data,
    ...(claimed
      ? {
          jobElapsedMs: Math.max(
            0,
            Math.min(Date.now(), activeLease!.expiresAt) - Date.parse(claimed.at),
          ),
        }
      : {}),
    at: new Date().toISOString(),
    sequence: ++eventSerial,
  };
  const leaseChange = releases ? null : lease;
  const hadLease = !!activeLease;
  journal.append(event, leaseChange, request);
  rebuild(event);
  // Claims and releases change the server-wide queue (active slots, workers), which
  // every project's monitor shows, so they invalidate all monitor views.
  broadcastUpdate({
    sequence: event.sequence,
    projectId: event.projectId,
    ...(leaseChange || hadLease ? { queueUpdated: true } : {}),
  });
  return event;
}

function allowsStageReview(job: WorkflowJob): boolean {
  // Approving a v2 stage can requeue the job while a sibling still awaits review.
  return (
    job.status === 'review' ||
    job.status === 'running' ||
    (job.workflow?.version === 2 && job.status === 'queued')
  );
}

function reviewInventory(job: WorkflowJob, stage: JobStage): Inventory {
  if (!stage.workspace) throw new HttpError(409, 'The review workspace is unavailable.');
  try {
    return inventory(path.join(jobWorkspace(job), stage.workspace), undefined, true);
  } catch {
    throw new HttpError(409, 'The review workspace has changed.');
  }
}

function reviewManifest(list: Inventory) {
  try {
    return outputManifest(list);
  } catch {
    throw new HttpError(409, 'The reviewed files have changed.');
  }
}

function reviewReceipt(
  jobId: string,
  stageKey: string,
  attempt: number,
  reviewSequence: number,
  failureKind: string | null,
  filesHash: string,
): string {
  return createHmac('sha256', RECEIPT_KEY)
    .update(JSON.stringify([jobId, stageKey, attempt, reviewSequence, failureKind, filesHash]))
    .digest('hex');
}

function approveReview(job: WorkflowJob, step: JobStage | undefined): void {
  if (
    job.workflow?.version === 2 &&
    (!step?.output ||
      !step.workspace ||
      !verifyOutput(path.join(jobWorkspace(job), step.workspace), step.output, {
        excludeInternal: true,
      }))
  )
    throw new HttpError(409, 'レビュー中の出力が変更されています。');
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
  if (step) {
    try {
      resultCache.store(job, step, jobWorkspace(job));
    } catch (cacheErr) {
      console.warn('Result cache store failed:', cacheErr);
    }
  }
}

function queueState() {
  const leases = journal.leases();
  const workers = [...new Set(leases.map((lease) => lease.worker))].map((id) => {
    const owned = leases.filter((lease) => lease.worker === id);
    return {
      id,
      active: owned.length,
      lastHeartbeatAt: new Date(Math.max(...owned.map((lease) => lease.heartbeatAt))).toISOString(),
    };
  });
  return { ...queueSettings, active: leases.length, workers };
}

function requireLease(job: WorkflowJob, token: unknown): Lease {
  recoverExpired();
  const lease = journal.lease(job.id);
  if (!lease || typeof token !== 'string' || token !== lease.token || lease.expiresAt <= Date.now())
    throw new HttpError(409, '実行権が失効しています。古いワーカーの更新は受け付けません。');
  return lease;
}

function cleanupPublication(job: WorkflowJob, leaseToken?: string) {
  if (!leaseToken) return;
  rmSync(path.join(jobWorkspace(job), '.publications', leaseToken), {
    recursive: true,
    force: true,
  });
}

/**
 * Return a leased job to a stable state. `planned` marks a worker that stopped on
 * purpose (SIGINT/SIGTERM) and acknowledged it: the job is requeued without spending
 * the automatic recovery budget, which only counts crashes and lease expiry.
 */
function settleLease(
  job: WorkflowJob,
  reason: string,
  cutoff = Date.now(),
  { planned = false }: { planned?: boolean } = {},
) {
  const stoppingStatus = job.status;
  const activeLease = journal.lease(job.id);
  try {
    for (const stage of job.stages) {
      if (stage.status === 'running') {
        appendEvent({
          type: 'stage.interrupted',
          jobId: job.id,
          projectId: job.projectId,
          stage: stage.key,
          attempt: stage.attempts,
          failureKind: 'interrupted',
          elapsedMs: Math.max(0, cutoff - Date.parse(stage.startedAt!)),
          message: reason + '。この試行の出力は引き継ぎません。',
        });
      } else if (stage.status === 'retry' && stage.retryAt) {
        const started = job.events.findLast(
          (event) =>
            ['stage.retry', 'stage.retry.resumed'].includes(event.type) &&
            event.stage === stage.key,
        );
        appendEvent({
          type: 'stage.retry.paused',
          retryRemainingMs: Math.max(0, Date.parse(stage.retryAt) - cutoff),
          jobId: job.id,
          projectId: job.projectId,
          stage: stage.key,
          elapsedMs: Math.max(
            0,
            Math.min(cutoff, Date.parse(stage.retryAt)) - Date.parse(started!.at),
          ),
          message: 'ワーカー停止までのリトライ待機時間を記録',
        });
      }
    }
    if (stoppingStatus === 'pausing' || stoppingStatus === 'cancelling') {
      appendEvent({
        type: stoppingStatus === 'pausing' ? 'job.paused' : 'job.cancelled',
        jobId: job.id,
        projectId: job.projectId,
        message: reason,
      });
      return;
    }
    if (!planned && (job.recoveryCount ?? 0) >= queueSettings.maxRecoveries) {
      appendEvent({
        type: 'job.failed',
        jobId: job.id,
        projectId: job.projectId,
        failureKind: 'interrupted',
        message: 'ワーカーの自動復旧回数の上限に達しました。',
      });
      return;
    }
    if (!recoverFailures(job)) return;
    appendEvent({
      type: 'job.recovered',
      jobId: job.id,
      projectId: job.projectId,
      recoveryCount: (job.recoveryCount ?? 0) + (planned ? 0 : 1),
      message: reason + '。合格済み工程を保持してキューに戻しました。',
    });
  } finally {
    cleanupPublication(job, activeLease?.token);
  }
}

function recoverFailures(job: WorkflowJob): boolean {
  // A crash after recording a real failure must not grant a free retry.
  for (const stage of job.stages.filter((item) => item.status === 'failed')) {
    const spec = job.workflow?.project.stages.find(
      (item) => item.key === (stage.stageKey ?? stage.key),
    );
    const policy = resolveExecution(job.workflow?.project.execution, spec?.execution);
    if (stage.failureKind && canRetry(policy, stage.failureKind, (stage.retryCount ?? 0) + 1)) {
      const delay = retryDelay(policy, (stage.retryCount ?? 0) + 1);
      appendEvent({
        type: 'stage.retry',
        jobId: job.id,
        projectId: job.projectId,
        stage: stage.key,
        retryAt: new Date(Date.now() + delay).toISOString(),
        message: '記録済みの失敗からリトライを予約',
      });
      // Pause the backoff timer until a worker claims the job so queued/paused time is excluded.
      appendEvent({
        type: 'stage.retry.paused',
        jobId: job.id,
        projectId: job.projectId,
        stage: stage.key,
        retryRemainingMs: delay,
        elapsedMs: 0,
        message: 'ワーカー再開までリトライ待機を保留',
      });
    } else if (
      policy.onFailure === 'review' &&
      ['execution_error', 'timeout', 'acceptance_failed'].includes(stage.failureKind ?? '')
    ) {
      let output: WorkflowEvent['output'];
      if (job.workflow?.version === 2) {
        try {
          if (!stage.workspace) throw new Error('試行の作業場所がありません。');
          output = outputManifest(ownOutputs(path.join(jobWorkspace(job), stage.workspace)));
        } catch (error) {
          appendEvent({
            type: 'job.failed',
            jobId: job.id,
            projectId: job.projectId,
            failureKind: 'acceptance_failed',
            message: '復旧時の出力を検証できません: ' + (error as Error).message,
          });
          return false;
        }
      }
      appendEvent({
        type: 'review.required',
        jobId: job.id,
        projectId: job.projectId,
        stage: stage.key,
        attempt: stage.attempts,
        output,
        ...(output ? { completion: { mode: 'executed' as const } } : {}),
        message: '失敗後にワーカーが停止しました。出力の確認が必要です。',
      });
      if (job.workflow?.version !== 2) return false;
    } else {
      if (job.workflow?.version === 2) {
        const hasOtherWork = job.stages.some(
          (item) =>
            item.status === 'pending' || item.status === 'retry' || item.status === 'review',
        );
        if (hasOtherWork) continue;
      }
      appendEvent({
        type: 'job.failed',
        jobId: job.id,
        projectId: job.projectId,
        failureKind: stage.failureKind,
        message: '記録済みの失敗が再試行条件を満たしていないため停止',
      });
      return false;
    }
  }
  return true;
}

function recoverExpired() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (!['running', 'pausing', 'cancelling'].includes(job.status)) continue;
    const lease = journal.lease(job.id);
    if (!lease || lease.expiresAt <= now)
      settleLease(job, 'ワーカーの実行権が失効', lease?.expiresAt ?? now);
  }
}
recoverExpired();
setInterval(recoverExpired, Math.min(1000, leaseMs / 4)).unref();

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

function normalizeHostName(value: string): string | null {
  try {
    return new URL(`http://${value.trim()}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Extra Host header names accepted in addition to loopback and a concrete HOST bind
 * address (e.g. a LAN IP or hostname used by remote workers when HOST=0.0.0.0).
 * Wildcards are intentionally unsupported so the DNS-rebinding guard stays explicit.
 */
const ALLOWED_HOSTS = new Set(
  (process.env.RAILFLOW_ALLOWED_HOSTS ?? '')
    .split(/[\s,]+/)
    .filter((item) => item && !item.includes('*') && !item.includes('/') && !item.includes('@'))
    .map(normalizeHostName)
    .filter((item): item is string => !!item),
);

function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const trimmed = hostHeader.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('@')) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const configured = (process.env.HOST || '127.0.0.1')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const normalized = hostname.replace(/^\[|\]$/g, '');
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    (configured !== '0.0.0.0' && configured !== '::' && normalized === configured) ||
    ALLOWED_HOSTS.has(normalized)
  );
}

function assertSafeRequest(req: IncomingMessage): void {
  if (!isAllowedHostHeader(req.headers.host)) {
    throw new HttpError(403, '許可されていない Host ヘッダです。');
  }
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '')
    .trim()
    .toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'クロスサイトからの変更リクエストは拒否されました。');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, '不正な Origin ヘッダです。');
    }
    const host = (req.headers.host || '').trim().toLowerCase();
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !host ||
      parsed.host.toLowerCase() !== host
    ) {
      throw new HttpError(403, '別オリジンからの変更リクエストは拒否されました。');
    }
  }
}

async function readJSON(req: IncomingMessage, limit = 100_000): Promise<Record<string, unknown>> {
  const mediaType = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'Content-Type: application/json を指定してください。');
  }
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

/** Hash the bytes copied to a private snapshot before any of them reach the response. */
function verifyReviewFile(
  root: string,
  relative: string,
  size: number,
  expectedHash: string,
  copy?: (chunk: Buffer, offset: number) => void,
) {
  let fd: number | undefined;
  try {
    fd = openSync(
      safeFile(root, relative),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) throw new Error();
    const buffer = Buffer.alloc(Math.min(size + 1, 256 * 1024));
    const digest = createHash('sha256');
    let offset = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      if (offset + n > size) throw new Error();
      const chunk = buffer.subarray(0, n);
      digest.update(chunk);
      copy?.(chunk, offset);
      offset += n;
    }
    if (offset !== size || digest.digest('hex') !== expectedHash) throw new Error();
  } catch {
    throw new HttpError(409, 'The reviewed file has changed.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readRecordedQcBytes(job: WorkflowJob, stage: JobStage, inspectedHash?: string | null) {
  const entry = stage.output?.files.find((file) => file.path === QC_FILENAME);
  if (!entry || !stage.workspace) throw new HttpError(404, 'No recorded QC output.');
  if (inspectedHash && entry.hash !== inspectedHash)
    throw new HttpError(409, 'The inspected QC output has changed.');
  const workspace = path.relative(HOME, jobWorkspace(job)).split(path.sep).join('/');
  const bytes = entry.bytes <= QC_MAX_BYTES ? Buffer.alloc(entry.bytes) : null;
  verifyReviewFile(
    HOME,
    workspace + '/' + stage.workspace + '/' + QC_FILENAME,
    entry.bytes,
    entry.hash,
    bytes ? (chunk, offset) => chunk.copy(bytes, offset) : undefined,
  );
  if (!bytes) throw new HttpError(422, 'qc.json exceeds 2 MiB.');
  return bytes;
}

/** Large general review outputs can exceed the QC memory limit. Stream a verified private copy. */
function serveVerifiedReview(
  res: ServerResponse,
  root: string,
  relative: string,
  size: number,
  hash: string,
  contentType: string,
) {
  const headers = {
    'content-type': contentType,
    'content-length': size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'",
  };
  if (size <= QC_MAX_BYTES) {
    const bytes = Buffer.alloc(size);
    verifyReviewFile(root, relative, size, hash, (chunk, offset) => chunk.copy(bytes, offset));
    res.writeHead(200, headers);
    res.end(bytes);
    return;
  }
  const temporary = path.join(os.tmpdir(), 'railflow-review-' + randomUUID());
  const fd = openSync(temporary, 'wx+', 0o600);
  let streamOwnsFd = false;
  try {
    // Only this descriptor can access the snapshot, including while a slow client reads it.
    unlinkSync(temporary);
    verifyReviewFile(root, relative, size, hash, (chunk) => {
      let written = 0;
      while (written < chunk.length)
        written += writeSync(fd, chunk, written, chunk.length - written);
    });
    const stream = createReadStream('', { fd, start: 0, autoClose: true });
    streamOwnsFd = true;
    res.once('close', () => stream.destroy());
    stream.once('error', (error) => res.destroy(error));
    res.writeHead(200, headers);
    stream.pipe(res);
  } finally {
    if (!streamOwnsFd) closeSync(fd);
  }
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

function verifySavedManifest(jobId: string, manifest: DatasetManifest, jobHash: string): void {
  const manifestPath = path.join(DATA, 'manifests', `${jobId}.json`);
  let saved: unknown;
  let fd: number | undefined;
  try {
    fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10_000_000)
      throw new Error('Invalid manifest file');
    saved = JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HttpError(422, 'このジョブには保存済みの入力マニフェストがありません。');
    throw new HttpError(409, '保存済みの入力マニフェストを読み取れません。');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (manifest.hash !== jobHash || !isDeepStrictEqual(saved, manifest))
    throw new HttpError(409, '入力マニフェストが登録時の記録と一致しません。');
}

function dryRun(project: ProjectSpec, body: Record<string, unknown>): DryRunResult {
  if (typeof body.sourceJobId !== 'string' || !body.sourceJobId.trim())
    throw new HttpError(400, '入力元のジョブを指定してください。');
  const job = jobs.get(body.sourceJobId);
  if (!job || job.projectId !== project.id) throw new HttpError(404, 'Job not found');
  const draft = validate(() => object(body.draft));
  if (!draft.graph) throw new HttpError(400, 'Dry Run には Workflow v2 の下書きが必要です。');
  const spec = buildProjectSpec(project.id, draft, project, { prepareDirs: false });
  const graph = spec.graph!;
  const manifest = job.dataset;
  if (!manifest) throw new HttpError(422, 'このジョブには保存済みの入力マニフェストがありません。');
  verifySavedManifest(job.id, manifest, job.hash);
  const trigger = checkFrozenTrigger(
    path.join(DATA, 'inputs', job.id),
    manifest,
    spec.input?.condition ?? null,
  );
  if (!trigger) throw new HttpError(409, '固定入力が変更または削除されています。');
  let tasks: DryRunResult['tasks'];
  try {
    tasks = planWorkflow(spec, manifest);
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
  const reviewStages = new Set(
    spec.stages
      .filter(
        (stage) =>
          stage.runner?.kind === 'human' ||
          stage.gate?.requireReview ||
          (stage.key === graph.publishStage && spec.finalGate?.requireReview),
      )
      .map((stage) => stage.key),
  );
  return {
    sourceJobId: job.id,
    datasetHash: manifest.hash,
    tasks,
    taskCount: tasks.length,
    maxParallelTasks: graph.maxParallelTasks,
    publishStage: graph.publishStage,
    reviewTaskKeys: tasks.filter((task) => reviewStages.has(task.stageKey)).map((task) => task.key),
    runtimeRequirements: spec.runtime!,
    trigger,
  };
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
    parentJobId?: string;
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
    const existing = isManualInput(source)
      ? undefined
      : [...jobs.values()].find(
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
  let plan: WorkflowSnapshot['plan'];
  try {
    plan = project.graph ? planWorkflow(project, dataset) : undefined;
  } catch (error) {
    rmSync(inputDir, { recursive: true, force: true });
    throw new HttpError(422, (error as Error).message);
  }
  const definition = structuredClone(project);
  const workflow: WorkflowSnapshot = {
    version: project.graph ? 2 : 1,
    ...(plan ? { plan } : {}),
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
    parentJobId: options.parentJobId,
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
      const observation = observeInput(observed, obsKey, list.signature);
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
      if (observation.failedRevision === project.updatedAt && observation.failedMessage) {
        candidate.status = 'error';
        candidate.message = observation.failedMessage;
        continue;
      }
      const quietMs = Math.max(
        0,
        Math.min(
          Date.now() - observation.seenAt,
          ...list.files.map((file) => Date.now() - file.mtimeMs),
        ),
      );
      if (list.files.length === 0) {
        candidate.message = 'ファイルの追加を待っています。';
        continue;
      }
      if (quietMs < config.settleMs) {
        candidate.message = `変更が止まってから ${Math.ceil(config.settleMs / 1000)} 秒待ちます。`;
        continue;
      }
      const source = `${dir === LEGACY_INBOX ? 'legacy' : 'project'}:${kind}:${name}`;
      // verifyDataset re-hashes up to 200 MB synchronously; do it once per signature,
      // not on every 1 s scan of an unchanged directory that keeps failing its trigger.
      const existingMatch =
        kind === 'directory'
          ? findRegisteredOnce(observation, () =>
              [...jobs.values()].find(
                (job) =>
                  job.projectId === project.id &&
                  job.dataset?.source === source &&
                  job.dataset.bytes === list.bytes &&
                  job.dataset.files.length === list.files.length &&
                  verifyDataset(list.root, job.dataset),
              ),
            )
          : undefined;
      if (existingMatch) {
        observation.ingested = true;
        candidate.status = 'registered';
        candidate.message = 'この内容は登録済みです。';
        continue;
      }
      candidate.result = checkCondition(list, name, quietMs, config.condition);
      if (candidate.result.status !== 'pass') {
        candidate.message = failedEvidence(candidate.result);
        if (candidate.result.status === 'error') candidate.status = 'error';
        continue;
      }
      enqueueInventory(project, list, name, kind, source, {
        single: kind === 'file' ? name : undefined,
        quietMs,
      });
      observation.ingested = true;
      observation.failedRevision = undefined;
      observation.failedMessage = undefined;
      candidate.status = 'registered';
      candidate.message = 'この内容をジョブとして登録しました。';
    } catch (error) {
      const obs = observed.get(obsKey);
      if (obs && !obs.ingested) {
        obs.failedRevision = project.updatedAt;
        obs.failedMessage = (error as Error).message;
      }
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
  const staging = path.join(UPLOADS, randomUUID());
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(path.join(staging, name), rows.join('\n'), { flag: 'wx' });
    return enqueueInventory(project, inventory(staging), name, 'file', `demo:${randomUUID()}`, {
      single: name,
      demo: true,
      needsReview: review,
      quietMs: Infinity,
      bypassTrigger: true,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
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
  capacity?: number;
  protocol?: number;
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
  leaseToken?: unknown;
  requestId?: unknown;
  runtime?: unknown;
  usage?: unknown;
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
    assertSafeRequest(req);
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
        queue: queueState(),
      });
    }

    if (pathname === '/api/templates' && req.method === 'GET') {
      const builtins = STARTER_WORKFLOWS.map((raw) =>
        exportTemplate(
          buildProjectSpec('template', raw, undefined, { prepareDirs: false }),
          raw.name,
          '1',
        ),
      );
      return deliverJSON(res, {
        builtins,
        saved: journal.setting<WorkflowTemplate[]>('templates') ?? [],
      });
    }
    if (pathname === '/api/templates/validate' && req.method === 'POST') {
      const body = await readJSON(req, 4_000_000);
      const template = validate(() => parseWorkflowTemplate(body.template));
      const project = buildProjectSpec('preview', { ...template.definition }, undefined, {
        prepareDirs: false,
      });
      return deliverJSON(res, {
        template,
        preview: {
          stages: project.stages.length,
          graph: project.graph,
          runtime: project.runtime,
          kinds: [...new Set(project.stages.map((stage) => stage.runner?.kind ?? 'ai'))],
        },
      });
    }
    if (pathname === '/api/templates' && req.method === 'POST') {
      const body = await readJSON(req);
      const project = projects.get(asString(body.projectId));
      if (!project) throw new HttpError(404, 'Project not found');
      const template = validate(() =>
        exportTemplate(project, asString(body.name) || project.name, asString(body.revision)),
      );
      const saved = journal.setting<WorkflowTemplate[]>('templates') ?? [];
      const existing = saved.find(
        (entry) =>
          entry.template.name === template.template.name &&
          entry.template.revision === template.template.revision,
      );
      if (existing && existing.template.hash !== template.template.hash)
        throw new HttpError(
          409,
          '同名・同版のテンプレートがあります。新しい版を指定してください。',
        );
      if (!existing) {
        if (saved.length >= 30) throw new HttpError(400, '保存できるテンプレートは30件です。');
        saved.push(template);
        journal.setSetting('templates', saved);
      }
      return deliverJSON(res, { template }, existing ? 200 : 201);
    }
    if (pathname === '/api/templates' && req.method === 'DELETE') {
      const body = await readJSON(req);
      const saved = journal.setting<WorkflowTemplate[]>('templates') ?? [];
      journal.setSetting(
        'templates',
        saved.filter(
          (entry) =>
            !(
              entry.template.name === body.name &&
              entry.template.revision === body.revision &&
              entry.template.hash === body.hash
            ),
        ),
      );
      return deliverJSON(res, { ok: true });
    }
    const templateMatch = pathname.match(/^\/api\/projects\/([a-z0-9_-]+)\/template$/);
    if (templateMatch && req.method === 'GET') {
      const project = projects.get(templateMatch[1]);
      if (!project) throw new HttpError(404, 'Project not found');
      const template = validate(() =>
        exportTemplate(
          project,
          url.searchParams.get('name') || project.name,
          url.searchParams.get('revision') || '1',
        ),
      );
      res.setHeader('content-disposition', `attachment; filename="${project.id}-workflow.json"`);
      return deliverJSON(res, template);
    }
    if (pathname === '/api/projects' && req.method === 'GET') {
      return deliverJSON(res, { projects: [...projects.values()] });
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      let raw = await readJSON(req, 4_000_000);
      if (raw.template !== undefined) {
        const template = validate(() => parseWorkflowTemplate(raw.template));
        raw = {
          ...template.definition,
          name: raw.name,
          purpose: raw.purpose ?? template.definition.purpose,
          id: raw.id,
          templateOrigin: template.template,
        };
      }
      const rawName = asString(raw.name || raw.title).trim();
      if (!rawName) {
        return deliverJSON(res, { error: 'Project name is required' }, 400);
      }
      const requestedId = asString(raw.id).trim();
      const baseId = slugifyId(requestedId || rawName, `project-${randomUUID().slice(0, 6)}`);
      let id = baseId;
      let suffix = 2;
      while (projects.has(id) || reservedProjectIds.has(id)) {
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
      if (raw.expectedUpdatedAt !== undefined && raw.expectedUpdatedAt !== existing.updatedAt)
        throw new HttpError(
          409,
          '保存前にプロジェクトが更新されました。最新版を確認してください。',
        );
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
          (job) =>
            job.projectId === projectId && !['done', 'failed', 'cancelled'].includes(job.status),
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
      inputCandidates.delete(projectId);
      for (const key of observed.keys()) {
        if (key.startsWith(`${dir}::`)) observed.delete(key);
      }
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
      const raw = await readJSON(req, 4_000_000);
      const target = getProjectOrDefault(url.searchParams.get('project'));
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

    const dryRunMatch = pathname.match(/^\/api\/projects\/([a-z0-9_-]+)\/dry-run$/);
    if (dryRunMatch) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'Method not allowed');
      }
      const project = projects.get(dryRunMatch[1]);
      if (!project) throw new HttpError(404, 'Project not found');
      const body = await readJSON(req, 4_000_000);
      return deliverJSON(res, dryRun(project, body));
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
      let list: Inventory;
      try {
        list = lstatSync(target).isDirectory() ? inventory(target) : inventory(dir, name);
      } catch (error) {
        return deliverJSON(res, {
          result: {
            status: 'error',
            label: '入力ファイルの検証',
            message: (error as Error).message,
          } satisfies ConditionResult,
        });
      }
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
      const uploadType = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (
        uploadType === 'text/plain' ||
        uploadType === 'application/x-www-form-urlencoded' ||
        uploadType === 'multipart/form-data'
      ) {
        throw new HttpError(415, 'Unsupported Content-Type for direct upload');
      }
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

    if (pathname === '/api/queue' && req.method === 'PUT') {
      const body = await readJSON(req);
      const settings = validate(() => parseQueue(body));
      queueSettings = settings;
      journal.setSetting('queue', settings);
      broadcastUpdate({ queueUpdated: true });
      return deliverJSON(res, { queue: queueState() });
    }

    if (pathname === '/api/jobs/claim' && req.method === 'POST') {
      const body = (await readJSON(req)) as ClaimRequestBody;
      recoverExpired();
      const requestedProject =
        typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
      const worker = String(body.worker || os.hostname()).slice(0, 80);
      const capacity =
        body.capacity === undefined
          ? queueSettings.maxJobsPerWorker
          : validate(() => boundedInteger(body.capacity, 'ワーカーの同時実行数', 16));
      if (capacity < 1)
        throw new HttpError(400, 'ワーカーの同時実行数は 1 以上で指定してください。');
      const leases = journal.leases();
      if (
        leases.length >= queueSettings.maxConcurrentJobs ||
        leases.filter((lease) => lease.worker === worker).length >=
          Math.min(capacity, queueSettings.maxJobsPerWorker)
      )
        return deliverJSON(res, { job: null });
      const job = [...jobs.values()]
        .filter(
          (item) =>
            item.status === 'queued' &&
            (item.workflow?.version !== 2 || body.protocol === 2 || body.protocol === 3) &&
            (!item.workflow?.project.runtime?.revision || body.protocol === 3) &&
            (!item.workflow?.project.stages.some((stage) => stage.cache?.enabled) ||
              body.protocol === 3) &&
            (!Object.keys(item.workflow?.project.runtime?.expected ?? {}).length ||
              body.protocol === 3) &&
            (!Object.keys(item.workflow?.project.runtime?.packages ?? {}).length ||
              body.protocol === 3) &&
            (!item.workflow?.project.runtime?.python || body.protocol === 3) &&
            (!item.workflow?.project.stages.some((stage) => stage.map?.isolateInput) ||
              body.protocol === 3) &&
            (!requestedProject || item.projectId === requestedProject) &&
            leases.filter((lease) => jobs.get(lease.jobId)?.projectId === item.projectId).length <
              (projects.get(item.projectId)?.queue?.maxConcurrentJobs ?? 4),
        )
        .sort(
          (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt),
        )[0];
      if (!job) return deliverJSON(res, { job: null });
      const project = job.workflow?.project ?? projects.get(job.projectId);
      const input = project && findJobInputFile(job);
      if (!project || !input) {
        appendEvent({
          type: 'job.failed',
          projectId: job.projectId,
          jobId: job.id,
          message: project
            ? '登録時の入力ファイルを復元できません。'
            : 'ジョブのプロジェクトが見つかりません。',
        });
        return deliverJSON(res, { job: null });
      }
      ensureProjectDirs(project.id);
      const lease: Lease = {
        jobId: job.id,
        worker,
        token: randomUUID(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + leaseMs,
      };
      appendEvent(
        {
          type: 'job.claimed',
          jobId: job.id,
          projectId: job.projectId,
          agent: String(body.agent || 'demo').slice(0, 30),
          worker,
        },
        lease,
      );
      return deliverJSON(res, {
        job,
        lease: {
          token: lease.token,
          expiresAt: new Date(lease.expiresAt).toISOString(),
          heartbeatMs: Math.floor(leaseMs / 4),
          ttlMs: leaseMs,
        },
        paths: {
          input,
          inputDir: job.dataset ? path.join(DATA, 'inputs', job.id) : path.dirname(input),
          manifest: job.dataset ? path.join(DATA, 'manifests', `${job.id}.json`) : undefined,
          work: jobWorkspace(job),
          artifacts: path.join(jobWorkspace(job), '.publications', lease.token),
        },
        project,
      });
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})$/);
    if (jobMatch && req.method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) throw new HttpError(404, 'Job not found');
      return deliverJSON(res, { job });
    }
    const provenanceMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/provenance$/);
    if (provenanceMatch && req.method === 'GET') {
      const job = jobs.get(provenanceMatch[1]);
      if (!job) throw new HttpError(404, 'Job not found');
      res.setHeader('content-disposition', `attachment; filename="${job.id}-provenance.json"`);
      return deliverJSON(res, {
        format: 'railflow.provenance',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        complete: ['done', 'failed', 'cancelled'].includes(job.status),
        asOfSequence: job.events.at(-1)?.sequence ?? 0,
        job,
        metrics: usageSummary(job),
      });
    }
    const cacheMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/cache$/);
    if (cacheMatch && req.method === 'POST') {
      const body = await readJSON(req);
      const job = jobs.get(cacheMatch[1]);
      if (!job || job.workflow?.version !== 2) throw new HttpError(404, 'v2 job not found');
      const lease = requireLease(job, body.leaseToken);
      const task = job.stages.find((task) => task.key === body.task);
      if (
        job.status !== 'running' ||
        !task ||
        task.status !== 'running' ||
        task.attempts !== body.attempt ||
        !task.workspace ||
        !task.runtime ||
        !task.gates?.some((gate) => gate.scope === 'input' && gate.result.status === 'pass')
      )
        throw new HttpError(409, '入力と環境を確認した実行中の試行が必要です。');
      const previous = job.events.findLast(
        (event) =>
          event.type === 'stage.cache' &&
          event.stage === task.key &&
          event.attempt === task.attempts,
      );
      if (previous) return deliverJSON(res, { event: previous });
      const identity = cacheIdentity(job, task);
      const work = path.join(jobWorkspace(job), task.workspace);
      if (ownOutputs(work).files.length)
        throw new HttpError(409, 'キャッシュは処理開始前にだけ検索できます。');
      const entry = identity.key ? resultCache.restore(job.projectId, identity.key, work) : null;
      requireLease(job, lease.token);
      const event = appendEvent({
        type: 'stage.cache',
        jobId: job.id,
        projectId: job.projectId,
        stage: task.key,
        attempt: task.attempts,
        cache: {
          key: identity.key,
          hit: !!entry,
          reason: entry
            ? '入力・定義・環境が一致する出力を検証して復元'
            : identity.key
              ? '一致する検証済みキャッシュがないため実行'
              : identity.reason,
        },
        completion: entry ? { mode: 'cached', ...entry.origin } : undefined,
        message: entry
          ? 'キャッシュの出力を復元（受け入れ判定は継続）'
          : 'キャッシュを使わず実行します。',
      });
      return deliverJSON(res, { event });
    }
    const rerunMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/rerun$/);
    if (rerunMatch && req.method === 'POST') {
      const body = await readJSON(req);
      const original = jobs.get(rerunMatch[1]);
      if (!original?.workflow || !original.dataset)
        throw new HttpError(400, '定義と入力を保存したジョブが必要です。');
      if (original.workflow.version !== 2)
        throw new HttpError(400, '選択工程の再実行にはWorkflow v2を有効にしたジョブが必要です。');
      if (!['done', 'failed', 'cancelled', 'paused', 'review'].includes(original.status))
        throw new HttpError(409, '実行を停止してから再実行してください。');
      const selected = original.stages.find((task) => task.key === body.task);
      if (!selected) throw new HttpError(400, '再実行するタスクを選択してください。');
      const plan = original.stages.map((task, index) => ({
        key: task.key,
        dependsOn: task.dependsOn ?? (index ? [original.stages[index - 1].key] : []),
      }));
      const affected = downstream(plan, selected.key);
      // Unfinished tasks also need execution; successful unrelated branches can be reused.
      const reusable = original.stages.filter(
        (task) => !affected.has(task.key) && task.status === 'success',
      );
      if (body.preview === true)
        return deliverJSON(res, {
          rerun: original.stages
            .filter((task) => affected.has(task.key) || task.status !== 'success')
            .map((task) => task.key),
          reuse: reusable.map((task) => task.key),
        });
      for (const task of reusable)
        if (
          !task.workspace ||
          !task.output ||
          !verifyOutput(path.join(jobWorkspace(original), task.workspace), task.output, {
            excludeInternal: true,
          })
        )
          throw new HttpError(409, '再利用元の出力が変更または削除されています。');
      if (!verifyDataset(path.join(DATA, 'inputs', original.id), original.dataset))
        throw new HttpError(409, '元の入力が変更されています。');
      const created = enqueueInventory(
        original.workflow.project,
        inventory(path.join(DATA, 'inputs', original.id)),
        original.file,
        original.dataset.kind,
        'rerun:' + randomUUID(),
        {
          quietMs: Infinity,
          bypassTrigger: true,
          parentJobId: original.id,
          demo: original.demo,
          needsReview: original.needsReview,
        },
      );
      appendEvent({
        type: 'job.paused',
        jobId: created.id,
        projectId: created.projectId,
        message: '再実行のチェックポイントを準備',
      });
      try {
        for (const task of reusable) {
          const workspace = '.reused/' + task.key;
          copyOutput(
            path.join(jobWorkspace(original), task.workspace!),
            path.join(jobWorkspace(created), workspace),
            task.output!,
          );
          appendEvent({
            type: 'stage.reused',
            jobId: created.id,
            projectId: created.projectId,
            stage: task.key,
            workspace,
            output: task.output,
            completion:
              task.completion?.mode === 'reused'
                ? task.completion
                : {
                    mode: 'reused',
                    jobId: original.id,
                    task: task.key,
                    attempt: task.attempts,
                  },
            summary: task.summary ?? undefined,
            message: '元ジョブの合格済み出力をハッシュ検証して再利用',
          });
        }
        appendEvent({
          type: 'job.resumed',
          jobId: created.id,
          projectId: created.projectId,
          message: '選択したタスクと後続を再実行します。',
        });
      } catch (error) {
        appendEvent({
          type: 'job.failed',
          jobId: created.id,
          projectId: created.projectId,
          message: (error as Error).message,
        });
        throw new HttpError(
          409,
          'チェックポイントを再利用できませんでした。元ジョブは変更されていません。',
        );
      }
      return deliverJSON(res, { job: created }, 201);
    }

    const leaseMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/(heartbeat|release)$/);
    if (leaseMatch && req.method === 'POST') {
      const body = await readJSON(req);
      const job = jobs.get(leaseMatch[1]);
      if (!job) throw new HttpError(404, 'Job not found');
      const lease = requireLease(job, body.leaseToken);
      if (leaseMatch[2] === 'release') {
        const planned = body.reason === 'shutdown';
        settleLease(
          job,
          job.status === 'pausing'
            ? '一時停止しました'
            : job.status === 'cancelling'
              ? 'キャンセルしました'
              : planned
                ? 'ワーカーが計画停止しました'
                : 'ワーカーが処理を中断',
          Date.now(),
          { planned },
        );
        return deliverJSON(res, { ok: true });
      }
      const action =
        job.status === 'pausing' ? 'pause' : job.status === 'cancelling' ? 'cancel' : 'continue';
      if (action === 'continue' && !journal.renew(job.id, lease.token, Date.now(), leaseMs))
        throw new HttpError(409, '実行権が失効しました。');
      return deliverJSON(res, { action, ttlMs: leaseMs });
    }

    const controlMatch = pathname.match(
      /^\/api\/jobs\/(run_[a-f0-9]{8})\/(pause|cancel|resume|priority)$/,
    );
    if (controlMatch && req.method === 'POST') {
      const body = await readJSON(req);
      recoverExpired();
      const job = jobs.get(controlMatch[1]);
      if (!job) throw new HttpError(404, 'Job not found');
      const action = controlMatch[2];
      const base = { jobId: job.id, projectId: job.projectId };
      if (action === 'priority') {
        if (!['queued', 'paused'].includes(job.status))
          throw new HttpError(409, '待機中のジョブだけ優先度を変更できます。');
        appendEvent({
          ...base,
          type: 'job.priority',
          priority: validate(() => parsePriority(body.priority)),
          message: 'キューの優先度を変更',
        });
      } else if (action === 'resume') {
        if (job.status !== 'paused') throw new HttpError(409, '一時停止中ではありません。');
        appendEvent({ ...base, type: 'job.resumed', message: '一時停止を解除しました。' });
        if (job.workflow?.version === 2 || !job.stages.some((stage) => stage.status === 'review')) {
          if (recoverFailures(job) && job.workflow?.version === 2)
            appendEvent({
              ...base,
              type: 'job.resumed',
              message: '残りのタスクの開始条件を確認しました。',
            });
        }
      } else {
        if (
          ['done', 'failed', 'cancelled', 'cancelling'].includes(job.status) ||
          (action === 'pause' && ['paused', 'pausing'].includes(job.status))
        )
          throw new HttpError(409, 'この状態では操作できません。');
        const active = !!journal.lease(job.id);
        appendEvent({
          ...base,
          type:
            action === 'pause'
              ? active
                ? 'job.pause.requested'
                : 'job.paused'
              : active
                ? 'job.cancel.requested'
                : 'job.cancelled',
          message: active
            ? '実行中の処理の停止を待っています。'
            : action === 'pause'
              ? '一時停止しました。'
              : 'キャンセルしました。',
        });
      }
      return deliverJSON(res, { job });
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
      const requestId =
        typeof input.requestId === 'string' && /^[a-f0-9-]{36}$/.test(input.requestId)
          ? input.requestId
          : undefined;
      const previousResponse =
        requestId && typeof input.leaseToken === 'string'
          ? journal.response(requestId, input.leaseToken)
          : undefined;
      if (previousResponse?.jobId === job.id)
        return deliverJSON(res, { ok: true, event: previousResponse });
      const lease = requireLease(job, input.leaseToken);
      if (!isWorkerEventType(input.type)) {
        return deliverJSON(res, { error: 'Unsupported event' }, 400);
      }
      const stageKey = typeof input.stage === 'string' && input.stage.trim() ? input.stage : null;
      if (stageKey && !job.stages.some((stage) => stage.key === stageKey)) {
        return deliverJSON(res, { error: 'Unsupported stage' }, 400);
      }

      const step = job.stages.find((stage) => stage.key === stageKey);
      const spec = step && job.workflow ? taskSpec(job.workflow.project, step) : undefined;
      const finalStep =
        job.workflow?.version === 2
          ? step?.key === job.workflow.project.graph?.publishStage
          : step === job.stages.at(-1);
      const policy = resolveExecution(job.workflow?.project.execution, spec?.execution);
      const extras: Partial<WorkflowEvent> = {};
      const stageEvent =
        input.type.startsWith('stage.') ||
        input.type === 'gate.evaluated' ||
        input.type === 'review.required' ||
        input.type === 'agent.event';
      if (job.status !== 'running') throw new HttpError(409, 'このジョブは実行中ではありません。');
      if (!job.workflow && step && stageEvent) {
        extras.attempt = input.type === 'stage.started' ? step.attempts + 1 : step.attempts;
      }
      if (job.workflow) {
        if (stageEvent && !step) throw new HttpError(400, '工程を指定してください。');
        if (step && stageEvent) {
          const attempt = input.type === 'stage.started' ? step.attempts + 1 : step.attempts;
          if (input.attempt !== attempt) throw new HttpError(409, '試行番号が一致しません。');
          extras.attempt = attempt;
          if (input.type === 'stage.started') {
            if (
              job.workflow.version === 2 &&
              job.stages.filter((task) => task.status === 'running').length >=
                job.workflow.project.graph!.maxParallelTasks
            )
              throw new HttpError(409, 'タスクの並列実行数の上限に達しています。');
            const previous =
              job.workflow.version === 2
                ? job.stages.filter((candidate) => step.dependsOn?.includes(candidate.key))
                : job.stages.slice(0, job.stages.indexOf(step));
            if (
              !['pending', 'retry'].includes(step.status) ||
              (step.status === 'retry' &&
                ((!!step.retryAt && Date.parse(step.retryAt) > Date.now()) ||
                  step.retryRemainingMs !== undefined)) ||
              previous.some((item) => item.status !== 'success') ||
              (step.retryCount ?? 0) > policy.maxRetries
            )
              throw new HttpError(409, '工程の順序またはリトライ上限が不正です。');
          } else if (input.type === 'stage.retry') {
            if (
              step.status !== 'failed' ||
              !step.failureKind ||
              !canRetry(policy, step.failureKind, (step.retryCount ?? 0) + 1)
            )
              throw new HttpError(409, 'この失敗は再試行できません。');
          } else if (input.type === 'stage.retry.resumed') {
            if (step.status !== 'retry' || step.retryRemainingMs === undefined)
              throw new HttpError(409, '中断されたリトライ待機がありません。');
            extras.retryAt = new Date(Date.now() + step.retryRemainingMs).toISOString();
          } else if (input.type === 'stage.retry.ready') {
            if (
              step.status !== 'retry' ||
              !step.retryAt ||
              Date.parse(step.retryAt) > Date.now() + 250
            )
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
          } else if (input.type === 'stage.failed' && step.status !== 'running') {
            // v2 workers record a task whose stage budget is already spent (e.g. after a
            // recovered crash or a retry wait that would overrun it) without starting it.
            if (
              job.workflow.version !== 2 ||
              !['pending', 'retry'].includes(step.status) ||
              input.failureKind !== 'stage_timeout' ||
              !(policy.stageTimeoutMs > 0) ||
              input.elapsedMs !== undefined ||
              input.workspace !== undefined
            )
              throw new HttpError(409, 'この工程は実行中ではありません。');
          } else if (step.status !== 'running')
            throw new HttpError(409, 'この工程は実行中ではありません。');
        }
        if (
          step &&
          ((input.type === 'gate.evaluated' && input.gate?.scope !== 'input') ||
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
          if (
            job.workflow.version === 2 &&
            ['input', 'output', ...(finalStep ? ['final'] : [])].some(
              (scope) =>
                !step.gates?.some((gate) => gate.scope === scope && gate.result.status === 'pass'),
            )
          )
            throw new HttpError(409, '入出力契約が合格していません。');
          const gates = [spec?.gate, ...(finalStep ? [job.workflow.project.finalGate] : [])];
          if (
            input.type === 'stage.succeeded' &&
            (spec?.runner?.kind === 'human' || gates.some((gate) => gate?.requireReview))
          )
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
      if (input.type === 'stage.environment') {
        if (!step || step.runtime)
          throw new HttpError(409, '環境は試行ごとに一度だけ記録できます。');
        const snapshot = validate(() => parseRuntimeSnapshot(input.runtime));
        const runner = spec?.runner ?? { kind: 'ai', engine: 'worker' };
        const engine =
          runner.kind === 'ai'
            ? runner.engine === 'worker'
              ? job.agent
              : runner.engine
            : runner.kind;
        if (snapshot.engine !== engine)
          throw new HttpError(400, '実行環境のエンジンが工程と一致しません。');
        snapshot.revision = job.workflow?.project.runtime?.revision ?? '';
        snapshot.issues = runtimeIssues(parseRuntime(job.workflow?.project.runtime), snapshot);
        extras.runtime = snapshot;
      }
      if (input.type === 'stage.usage') {
        if (
          job.events.some(
            (event) =>
              event.type === 'stage.usage' &&
              event.stage === step?.key &&
              event.attempt === step?.attempts,
          )
        )
          throw new HttpError(409, 'この試行の使用量は記録済みです。');
        extras.usage = validate(() => priceUsage(input.usage, job.workflow?.project.pricing ?? []));
      }
      if (
        job.workflow?.version === 2 &&
        step &&
        ['stage.executed', 'stage.succeeded'].includes(input.type) &&
        (((!!job.workflow.project.runtime?.revision ||
          !!job.workflow.project.runtime?.python ||
          Object.keys(job.workflow.project.runtime?.expected ?? {}).length > 0 ||
          Object.keys(job.workflow.project.runtime?.packages ?? {}).length > 0) &&
          !step.runtime) ||
          !!step.runtime?.issues.length)
      )
        throw new HttpError(409, '実行環境の要件が一致していません。');
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
        if (key === 'retryAt' && input.type === 'stage.retry.resumed') continue;
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'string' || !Number.isFinite(Date.parse(input[key])))
            throw new HttpError(400, '期限が不正です。');
          extras[key] = input[key];
        }
      }
      if (
        input.type === 'job.waiting' &&
        (job.workflow?.version !== 2 ||
          !job.stages.some((item) => item.status === 'review') ||
          job.stages.some((item) => item.status === 'running' || readyTask(job, item)))
      )
        throw new HttpError(409, '実行できる工程が残っています。');
      if (
        job.workflow?.version === 2 &&
        input.type === 'stage.executed' &&
        !step?.gates?.some((gate) => gate.scope === 'input' && gate.result.status === 'pass')
      )
        throw new HttpError(409, '入力契約を確認してから実行してください。');
      if (input.type === 'gate.evaluated') {
        const scope = input.gate?.scope;
        if (
          !step ||
          !['stage', 'final', ...(job.workflow?.version === 2 ? ['input', 'output'] : [])].includes(
            String(scope),
          ) ||
          (scope === 'final' && !finalStep)
        )
          throw new HttpError(400, '判定対象が不正です。');
        if (job.workflow) {
          if (!step.workspace) throw new HttpError(400, '判定する作業場所がありません。');
          const work = path.join(jobWorkspace(job), step.workspace);
          let result: ConditionResult;
          try {
            if (
              job.workflow.version === 2 &&
              (!verifyTaskInputs(job, step, work) ||
                (spec?.map?.isolateInput && !verifyMapInput(job, step, work)) ||
                (job.dataset && !verifyDataset(path.join(DATA, 'inputs', job.id), job.dataset)))
            )
              throw new Error('入力または依存出力が変更されています。');
            const list =
              job.workflow.version === 2 ? ownOutputs(work) : inventory(work, undefined, true);
            if (scope === 'input')
              result = checkInputContracts(
                path.join(DATA, 'inputs', job.id),
                work,
                step,
                spec?.contracts?.inputs ?? [],
              );
            else if (scope === 'output')
              result = checkContracts(list, spec?.contracts?.outputs ?? []);
            else
              result = checkCondition(
                list,
                job.file,
                0,
                (scope === 'stage' ? spec?.gate : job.workflow.project.finalGate)?.condition ??
                  null,
              );
            if (
              job.workflow.version === 2 &&
              scope === 'final' &&
              !list.files.some(
                (file) => ['report.html', 'report.pptx'].includes(file.path) && file.bytes > 0,
              )
            )
              result = {
                status: 'fail',
                label: '最終レポート',
                message: '公開工程自身の非空の report.html または report.pptx が必要です。',
                children: [result],
              };
          } catch (error) {
            result = {
              status: 'error',
              label: '入力・出力の検証',
              message: (error as Error).message,
            };
          }
          extras.gate = { scope: scope as 'input' | 'output' | 'stage' | 'final', result };
        }
      }
      if (
        job.workflow?.version === 2 &&
        step &&
        ['stage.succeeded', 'review.required'].includes(input.type)
      ) {
        if (!step.workspace) throw new HttpError(400, '作業場所がありません。');
        const list = ownOutputs(path.join(jobWorkspace(job), step.workspace));
        extras.output = outputManifest(list);
        extras.completion =
          step.completion?.mode === 'cached' ? step.completion : { mode: 'executed' };
      }

      let artifact: ArtifactInfo | undefined;
      if (input.type === 'artifact.created') {
        const artifactName = asString(input.artifact?.name);
        if (!artifactName || artifactName !== path.basename(artifactName)) {
          return deliverJSON(res, { error: 'Artifact not found' }, 400);
        }
        if (job.artifacts.some((item) => item.name === artifactName)) {
          throw new HttpError(409, 'この成果物は既に公開されています。');
        }
        const artifactPath = path.join(
          jobWorkspace(job),
          '.publications',
          lease.token,
          artifactName,
        );
        const destination = path.join(projectArtifactsPath(job.projectId), job.id, artifactName);
        mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = destination + '.' + randomUUID();
        let bytes = 0;
        let sourceFd: number | undefined;
        let outFd: number | undefined;
        try {
          try {
            sourceFd = openSync(
              artifactPath,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
          } catch {
            return deliverJSON(res, { error: 'Artifact not found' }, 400);
          }
          const st = fstatSync(sourceFd);
          if (!st.isFile() || st.nlink !== 1) {
            return deliverJSON(res, { error: 'Artifact not found' }, 400);
          }
          outFd = openSync(temporary, 'wx', 0o600);
          const buffer = Buffer.alloc(256 * 1024);
          while (true) {
            const n = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (!n) break;
            bytes += n;
            let offset = 0;
            while (offset < n) offset += writeSync(outFd, buffer, offset, n - offset);
          }
          closeSync(outFd);
          outFd = undefined;
          requireLease(job, lease.token);
          renameSync(temporary, destination);
        } finally {
          if (sourceFd !== undefined) closeSync(sourceFd);
          if (outFd !== undefined) closeSync(outFd);
          rmSync(temporary, { force: true });
        }
        artifact = {
          name: artifactName,
          uri: `/artifacts/${encodeURIComponent(job.projectId)}/${job.id}/${encodeURIComponent(artifactName)}`,
          bytes,
        };
      }

      const rawSummary = asString(input.summary).trim();
      const rawDetails = asString(input.details);
      const event = appendEvent(
        {
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
        },
        undefined,
        requestId ? { id: requestId, token: lease.token } : undefined,
      );
      if (
        ['review.required', 'job.completed', 'job.failed', 'job.cancelled'].includes(input.type)
      ) {
        cleanupPublication(job, lease.token);
      }
      if (input.type === 'stage.succeeded' && step) {
        try {
          resultCache.store(job, step, jobWorkspace(job));
        } catch (cacheErr) {
          console.warn('Result cache store failed:', cacheErr);
        }
      }
      return deliverJSON(res, { ok: true, event });
    }

    const baselineMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/qc-baseline$/);
    if (baselineMatch) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new HttpError(405, 'Method not allowed');
      }
      const query = url.searchParams;
      const baselineId = query.get('baselineJobId');
      const sequence = Number(query.get('sequence'));
      if (
        query.size !== 3 ||
        query.get('task') !== 'qc' ||
        !baselineId ||
        !Number.isSafeInteger(sequence) ||
        sequence <= 0 ||
        baselineId === baselineMatch[1]
      )
        throw new HttpError(
          400,
          'Expected task=qc, a review sequence and a distinct baselineJobId.',
        );
      const job = jobs.get(baselineMatch[1]);
      const baseline = jobs.get(baselineId);
      if (!job || !baseline || job.projectId !== baseline.projectId)
        throw new HttpError(404, 'Job not found.');
      const stage = job.stages.find((s) => s.key === 'qc');
      if (job.workflow?.version !== 2 || !stage) throw new HttpError(404, 'No QC task.');
      if (!allowsStageReview(job) || stage.status !== 'review' || stage.reviewSequence !== sequence)
        throw new HttpError(409, 'The review target has changed.');
      const qcStage = baseline.stages.find((s) => s.key === 'qc');
      if (baseline.workflow?.version !== 2 || !qcStage)
        throw new HttpError(404, 'No baseline QC task.');
      if (baseline.status !== 'done' || qcStage.status !== 'success')
        throw new HttpError(409, 'Baseline job or QC task is incomplete.');
      const raw = readRecordedQcBytes(baseline, qcStage);
      let qc;
      try {
        qc = parseQcV1Bytes(raw);
      } catch (error) {
        throw new HttpError(422, (error as Error).message);
      }
      return deliverJSON(res, {
        baselineJobId: baseline.id,
        stageKey: qcStage.key,
        outputHash: qcStage.output!.hash,
        qc,
      });
    }

    const previewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/review(?:\/(file))?$/);
    if (previewMatch && req.method === 'GET') {
      const job = jobs.get(previewMatch[1]);
      const stage = job?.stages.find(
        (item) =>
          item.status === 'review' &&
          (!url.searchParams.get('task') || item.key === url.searchParams.get('task')),
      );
      if (!job || !stage?.workspace || !allowsStageReview(job))
        throw new HttpError(404, 'レビュー中の出力がありません。');
      const root = path.join(jobWorkspace(job), stage.workspace);
      if (!previewMatch[2]) {
        const list = reviewInventory(job, stage);
        const manifest = reviewManifest(list);
        const { key: stageKey, attempts: attempt, reviewSequence } = stage;
        const failureKind = stage.failureKind ?? null;
        const receipt =
          job.workflow &&
          Number.isSafeInteger(attempt) &&
          attempt > 0 &&
          reviewSequence !== undefined &&
          Number.isSafeInteger(reviewSequence) &&
          reviewSequence > 0
            ? reviewReceipt(job.id, stageKey, attempt, reviewSequence, failureKind, manifest.hash)
            : null;
        return deliverJSON(res, {
          files: list.files,
          fileHashes: Object.fromEntries(manifest.files.map((file) => [file.path, file.hash])),
          reviewSequence,
          stageKey,
          attempt,
          failureKind,
          summary: stage.summary ?? null,
          receipt,
        });
      }
      if (Number(url.searchParams.get('sequence')) !== stage.reviewSequence)
        throw new HttpError(409, 'レビュー対象が更新されています。');
      const relative = url.searchParams.get('path') ?? '';
      const expectedHash = url.searchParams.get('sha256');
      if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash))
        throw new HttpError(400, 'Invalid file SHA-256.');
      if (
        job.workflow?.version === 2 &&
        stage.key === 'qc' &&
        relative === QC_FILENAME &&
        stage.output?.files.some((file) => file.path === QC_FILENAME)
      ) {
        const bytes = readRecordedQcBytes(job, stage, expectedHash);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
        });
        return res.end(bytes);
      }
      if (job.workflow && expectedHash === null)
        throw new HttpError(400, 'Provide the file SHA-256 from the review inspection.');
      const list = reviewInventory(job, stage);
      const file = list.files.find((item) => item.path === relative);
      if (!file) throw new HttpError(expectedHash ? 409 : 404, '出力が見つかりません。');
      const contentType =
        MIME_TYPES[path.extname(relative).toLowerCase()] ?? 'application/octet-stream';
      if (expectedHash)
        return serveVerifiedReview(res, root, relative, file.bytes, expectedHash, contentType);
      return serveFile(res, safeFile(root, relative), contentType, 'GET', true);
    }

    const exactReviewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/approve-exact$/);
    if (exactReviewMatch && req.method === 'POST') {
      const { stage, attempt, reviewSequence, receipt, exception } = await readJSON(req, 10_000);
      if (
        typeof stage !== 'string' ||
        !stage.trim() ||
        typeof attempt !== 'number' ||
        !Number.isSafeInteger(attempt) ||
        attempt <= 0 ||
        typeof reviewSequence !== 'number' ||
        !Number.isSafeInteger(reviewSequence) ||
        reviewSequence <= 0 ||
        typeof receipt !== 'string' ||
        !receipt.trim() ||
        typeof exception !== 'boolean'
      )
        throw new HttpError(400, 'Expected stage, attempt, reviewSequence, receipt and exception.');

      const job = jobs.get(exactReviewMatch[1]);
      if (!job) throw new HttpError(404, 'Job not found');
      const step = job.stages.find((item) => item.key === stage);
      if (!job.workflow || !allowsStageReview(job) || step?.status !== 'review')
        throw new HttpError(409, 'The stage is not awaiting exact review.');
      if (step.attempts !== attempt || step.reviewSequence !== reviewSequence)
        throw new HttpError(409, 'The review target has changed.');
      if (exception !== Boolean(step.failureKind))
        throw new HttpError(
          409,
          step.failureKind
            ? 'A failed stage requires exception approval.'
            : 'A normal review requires approval without an exception.',
        );
      const expected = Buffer.from(
        reviewReceipt(
          job.id,
          step.key,
          attempt,
          reviewSequence,
          step.failureKind ?? null,
          reviewManifest(reviewInventory(job, step)).hash,
        ),
      );
      const supplied = Buffer.from(receipt);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new HttpError(409, 'The review receipt is invalid or stale.');

      approveReview(job, step);
      return deliverJSON(res, {
        ok: true,
        job,
        stageKey: step.key,
        attempt,
        reviewSequence,
        exception,
      });
    }

    const reviewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/approve$/);
    if (reviewMatch && req.method === 'POST') {
      const body = await readJSON(req, 10_000);
      const job = jobs.get(reviewMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      if (!(job.status === 'review' || (job.workflow?.version === 2 && allowsStageReview(job))))
        return deliverJSON(res, { error: 'Not in review' }, 409);
      const step = job.stages.find(
        (stage) => stage.status === 'review' && (!body.stage || stage.key === body.stage),
      );
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
      approveReview(job, step);
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
        MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
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
        MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
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
