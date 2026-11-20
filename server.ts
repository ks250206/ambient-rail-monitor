import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
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
  ReasoningEffort,
  StageDefinition,
  StageKey,
  WorkerEventType,
  WorkflowEvent,
  WorkflowJob,
  WorkflowSpec,
} from './shared/types.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.RAILFLOW_HOME ? path.resolve(process.env.RAILFLOW_HOME) : ROOT;
const DIST = path.join(ROOT, 'dist');
const INBOX = path.join(HOME, 'inbox');
const DATA = path.join(HOME, 'data');
const ARTIFACTS = path.join(HOME, 'artifacts');
const WORK = path.join(HOME, 'work');
const EVENTS = path.join(DATA, 'events.jsonl');
const WORKFLOW_FILE = path.join(DATA, 'workflow-spec.json');
const MAX_UPLOAD = 20 * 1024 * 1024;

for (const dir of [INBOX, DATA, ARTIFACTS, WORK]) {
  mkdirSync(dir, { recursive: true });
}

const STAGES: StageDefinition[] = [
  { key: 'ingest', label: '取込・形式検証', short: 'Ingest' },
  { key: 'preprocess', label: '前処理・校正', short: 'Preprocess' },
  { key: 'analysis', label: 'データ解析', short: 'Analysis' },
  { key: 'validate', label: '科学的妥当性確認', short: 'Validation' },
  { key: 'visualize', label: '図表・可視化', short: 'Visualization' },
  { key: 'publish', label: 'HTML / PPTX生成', short: 'Publish' },
];

const VALID_EFFORTS = new Set<ReasoningEffort>(['', 'low', 'medium', 'high', 'xhigh', 'max']);

function emptyLlmConfig(): LlmConfig {
  return { model: '', effort: '' };
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

const DEFAULT_WORKFLOW: Omit<WorkflowSpec, 'updatedAt'> = {
  title: '科学データ解析ワークフロー',
  purpose:
    '投入された実験データ（CSV / TSV / JSON / TXT / DAT）を6工程で自動処理し、各段階の検証記録と再現可能な HTML / PPTX レポートを生成します。',
  acceptanceCriteria: [
    '- 入力データの列名・単位・欠損値と異常値を記録すること（不明な単位や条件は推測しない）',
    '- 変換・解析の処理手順とスクリプトをジョブの作業ディレクトリに保存すること',
    '- 記述的クイックルックと物理的に検証されたピーク帰属を明確に区別すること',
    '- 最終成果物として自己完結した report.html（任意で report.pptx）を生成すること',
  ].join('\n'),
  llm: emptyLlmConfig(),
  stageLlm: {
    ingest: emptyLlmConfig(),
    preprocess: emptyLlmConfig(),
    analysis: emptyLlmConfig(),
    validate: emptyLlmConfig(),
    visualize: emptyLlmConfig(),
    publish: emptyLlmConfig(),
  },
  stageInstructions: {
    ingest: '列構成・行数・区切り形式・欠損や外れ値の有無を確認し、01_ingest.md に整理する。',
    preprocess: '実施した前処理と前提条件をすべて 02_preprocess.md に記録する。',
    analysis: '再現可能なスクリプトで定量解析を行い、中間データと 03_analysis.md を保存する。',
    validate: '単位・フィット品質・限界や未解決の確認事項を 04_validation.md に明記する。',
    visualize: '単位とキャプションを付けた図を作成し、05_visualization.md にまとめる。',
    publish: '手法・図表・結果概要・限界を含む report.html（任意で report.pptx）を作成する。',
  },
};

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

function normalizeWorkflowSpec(raw: unknown): WorkflowSpec {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawInstructions =
    input.stageInstructions && typeof input.stageInstructions === 'object'
      ? (input.stageInstructions as Record<string, unknown>)
      : {};
  const rawStageLlm =
    input.stageLlm && typeof input.stageLlm === 'object'
      ? (input.stageLlm as Record<string, unknown>)
      : {};

  const stageInstructions = Object.fromEntries(
    STAGES.map((stage) => {
      const value = rawInstructions[stage.key];
      const text =
        typeof value === 'string'
          ? value.slice(0, 2000)
          : DEFAULT_WORKFLOW.stageInstructions[stage.key];
      return [stage.key, text];
    }),
  ) as Record<StageKey, string>;

  const stageLlm = Object.fromEntries(
    STAGES.map((stage) => [stage.key, normalizeLlmConfig(rawStageLlm[stage.key])]),
  ) as Record<StageKey, LlmConfig>;

  return {
    title:
      typeof input.title === 'string' && input.title.trim()
        ? input.title.trim().slice(0, 120)
        : DEFAULT_WORKFLOW.title,
    purpose:
      typeof input.purpose === 'string' ? input.purpose.slice(0, 2000) : DEFAULT_WORKFLOW.purpose,
    acceptanceCriteria:
      typeof input.acceptanceCriteria === 'string'
        ? input.acceptanceCriteria.slice(0, 4000)
        : DEFAULT_WORKFLOW.acceptanceCriteria,
    llm: normalizeLlmConfig(input.llm),
    stageLlm,
    stageInstructions,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  };
}

function loadWorkflowSpec(): WorkflowSpec {
  if (existsSync(WORKFLOW_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(WORKFLOW_FILE, 'utf8')) as unknown;
      return normalizeWorkflowSpec(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to read workflow spec, using default:', message);
    }
  }
  return {
    ...DEFAULT_WORKFLOW,
    llm: { ...DEFAULT_WORKFLOW.llm },
    stageLlm: Object.fromEntries(
      STAGES.map((stage) => [stage.key, { ...DEFAULT_WORKFLOW.stageLlm[stage.key] }]),
    ) as Record<StageKey, LlmConfig>,
    stageInstructions: { ...DEFAULT_WORKFLOW.stageInstructions },
    updatedAt: new Date().toISOString(),
  };
}

let workflowSpec: WorkflowSpec = loadWorkflowSpec();

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

function isStageKey(value: unknown): value is StageKey {
  return typeof value === 'string' && STAGES.some((stage) => stage.key === value);
}

function isWorkerEventType(value: unknown): value is WorkerEventType {
  return typeof value === 'string' && WORKER_EVENT_TYPES.has(value as WorkerEventType);
}

function rebuild(event: WorkflowEvent): void {
  allEvents.push(event);
  eventSerial = Math.max(eventSerial, Number(event.sequence) || 0);
  if (event.type === 'job.created') {
    if (jobs.has(event.jobId)) return;
    jobs.set(event.jobId, {
      id: event.jobId,
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
      stages: STAGES.map((stage) => ({
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
  broadcastUpdate({ sequence: event.sequence });
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

function enqueue(
  file: string,
  options: { demo?: boolean; needsReview?: boolean } = {},
): WorkflowJob {
  const { demo = false, needsReview = false } = options;
  const basename = cleanName(file);
  const absolute = path.join(INBOX, basename);
  const bytes = readFileSync(absolute);
  const hash = createHash('sha256').update(bytes).digest('hex');

  const existing = Array.from(jobs.values()).find(
    (job) => job.file === basename && job.hash === hash,
  );
  if (existing) return existing;

  const id = `run_${randomUUID().slice(0, 8)}`;
  appendEvent({
    type: 'job.created',
    jobId: id,
    file: basename,
    bytes: bytes.length,
    hash,
    demo,
    needsReview,
  });
  mkdirSync(path.join(WORK, id), { recursive: true });
  mkdirSync(path.join(ARTIFACTS, id), { recursive: true });
  const created = jobs.get(id);
  if (!created) throw new Error(`Failed to register job ${id}`);
  return created;
}

function scanInbox(): void {
  let names: string[] = [];
  try {
    names = readdirSync(INBOX);
  } catch {
    return;
  }

  for (const name of names) {
    if (!/\.(csv|tsv|json|txt|dat)$/i.test(name)) continue;
    try {
      const st = statSync(path.join(INBOX, name));
      if (!st.isFile() || st.size > MAX_UPLOAD) continue;
      const signature = `${st.size}:${st.mtimeMs}`;
      const previous = observed.get(name);
      if (previous?.signature === signature) {
        if (
          !previous.ingested &&
          Date.now() - previous.seenAt > 1200 &&
          Date.now() - st.mtimeMs > 700
        ) {
          observed.set(name, { signature, seenAt: previous.seenAt, ingested: true });
          enqueue(name);
        }
      } else {
        observed.set(name, { signature, seenAt: Date.now(), ingested: false });
      }
    } catch {
      // File may still be written or removed concurrently.
    }
  }
}

try {
  const watcher = watch(INBOX, { persistent: false }, () => {
    const timer = setTimeout(scanInbox, 350);
    timer.unref();
  });
  watcher.on('error', (err) => console.warn('Inbox watcher:', err.message));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn('FS watch unavailable; using polling fallback:', message);
}

setInterval(scanInbox, 1000).unref();
scanInbox();

function makeSample(review = false): WorkflowJob {
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
  writeFileSync(path.join(INBOX, name), rows.join('\n'));
  return enqueue(name, { demo: true, needsReview: review });
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
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
};

interface DemoRequestBody {
  review?: boolean;
}

interface ClaimRequestBody {
  agent?: string;
  worker?: string;
}

interface EventRequestBody {
  type?: unknown;
  stage?: unknown;
  message?: unknown;
  summary?: unknown;
  details?: unknown;
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
      return deliverJSON(res, {
        jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        events: allEvents.slice(-300),
        stages: STAGES,
        workflow: workflowSpec,
        updatedAt: new Date().toISOString(),
      });
    }

    if (pathname === '/api/workflow' && req.method === 'GET') {
      return deliverJSON(res, { workflow: workflowSpec });
    }

    if (pathname === '/api/workflow' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 100_000)).toString('utf8') || '{}') as unknown;
      workflowSpec = normalizeWorkflowSpec({
        ...(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}),
        updatedAt: new Date().toISOString(),
      });
      writeFileSync(WORKFLOW_FILE, `${JSON.stringify(workflowSpec, null, 2)}\n`, 'utf8');
      broadcastUpdate({ workflowUpdatedAt: workflowSpec.updatedAt });
      return deliverJSON(res, { workflow: workflowSpec });
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
      return deliverJSON(res, { job: makeSample(Boolean(body.review)) }, 201);
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      const name = cleanName(url.searchParams.get('filename'));
      if (!/\.(csv|tsv|txt|json|dat)$/i.test(name)) {
        return deliverJSON(res, { error: 'Supported extensions: csv,tsv,txt,json,dat' }, 400);
      }
      const body = await readBody(req, MAX_UPLOAD);
      if (!body.length) {
        return deliverJSON(res, { error: 'Empty file' }, 400);
      }
      const safe = `${path.parse(name).name.slice(0, 70)}_${randomUUID().slice(0, 5)}${path.extname(name)}`;
      writeFileSync(path.join(INBOX, safe), body, { flag: 'wx' });
      return deliverJSON(res, { job: enqueue(safe) }, 201);
    }

    if (pathname === '/api/jobs/claim' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as ClaimRequestBody;
      const job = [...jobs.values()]
        .filter((item) => item.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return deliverJSON(res, { job: null });

      appendEvent({
        type: 'job.claimed',
        jobId: job.id,
        agent: String(body.agent || 'demo').slice(0, 30),
        worker: String(body.worker || os.hostname()).slice(0, 80),
      });
      return deliverJSON(res, {
        job: jobs.get(job.id),
        paths: {
          input: path.join(INBOX, job.file),
          work: path.join(WORK, job.id),
          artifacts: path.join(ARTIFACTS, job.id),
        },
        workflow: workflowSpec,
      });
    }

    const logMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/logs$/);
    if (logMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const job = jobs.get(logMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      const output = `${[
        `Railflow run ${job.id}`,
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
      if (input.stage !== undefined && input.stage !== null && !isStageKey(input.stage)) {
        return deliverJSON(res, { error: 'Unsupported stage' }, 400);
      }

      let artifact: ArtifactInfo | undefined;
      if (input.type === 'artifact.created') {
        const artifactName = asString(input.artifact?.name);
        const artifactPath = path.join(ARTIFACTS, job.id, artifactName);
        if (
          !artifactName ||
          artifactName !== path.basename(artifactName) ||
          !existsSync(artifactPath)
        ) {
          return deliverJSON(res, { error: 'Artifact not found' }, 400);
        }
        artifact = {
          name: artifactName,
          uri: `/artifacts/${job.id}/${encodeURIComponent(artifactName)}`,
          bytes: statSync(artifactPath).size,
        };
      }

      const rawSummary = asString(input.summary).trim();
      const rawDetails = asString(input.details);
      appendEvent({
        type: input.type,
        jobId: job.id,
        stage: isStageKey(input.stage) ? input.stage : null,
        message: asString(input.message).slice(0, 600),
        summary: rawSummary ? rawSummary.slice(0, 1200) : undefined,
        artifact,
        details: rawDetails ? rawDetails.slice(0, 1300) : undefined,
      });
      return deliverJSON(res, { ok: true });
    }

    const reviewMatch = pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/approve$/);
    if (reviewMatch && req.method === 'POST') {
      const job = jobs.get(reviewMatch[1]);
      if (!job) return deliverJSON(res, { error: 'Job not found' }, 404);
      if (job.status !== 'review') return deliverJSON(res, { error: 'Not in review' }, 409);
      appendEvent({
        type: 'review.approved',
        jobId: job.id,
        stage: 'validate',
        message: '人間がレビューを承認',
      });
      return deliverJSON(res, { ok: true });
    }

    if (pathname.startsWith('/artifacts/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const match = pathname.match(/^\/artifacts\/(run_[a-f0-9]{8})\/([^/]+)$/);
      if (!match || !jobs.has(match[1])) {
        return deliverJSON(res, { error: 'Not found' }, 404);
      }
      const artifact = match[2];
      if (artifact !== path.basename(artifact)) {
        return deliverJSON(res, { error: 'Invalid path' }, 400);
      }
      const file = path.join(ARTIFACTS, match[1], artifact);
      return serveFile(
        res,
        file,
        MIME_TYPES[path.extname(file)] || 'application/octet-stream',
        req.method,
        true,
      );
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const segment =
        pathname === '/'
          ? 'index.html'
          : pathname === '/workflow' || pathname === '/workflow/'
            ? 'workflow.html'
            : pathname.slice(1);
      if (segment.includes('..') || segment.startsWith('.')) {
        return deliverJSON(res, { error: 'Invalid path' }, 400);
      }
      const file = path.resolve(DIST, segment);
      if (!file.startsWith(DIST + path.sep)) {
        return deliverJSON(res, { error: 'Invalid path' }, 400);
      }
      if (!existsSync(file) && (segment === 'index.html' || segment === 'workflow.html')) {
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
