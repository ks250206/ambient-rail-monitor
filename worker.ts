import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { executeGraph } from './shared/graph-runtime.ts';
import { prepareAttempt } from './shared/attempt-workspace.ts';
import { failedEvidence } from './shared/conditions.ts';
import { verifyDataset } from './shared/datasets.ts';
import {
  canRetry,
  remainingBudget,
  resolveExecution,
  retryDelay,
} from './shared/execution-policy.ts';
import type { ExecutionPolicy, FailureKind } from './shared/execution-policy.ts';
import { buildStagePrompt } from './shared/prompts.ts';
import { ExecutionFailure, isDeterministicFailure, runCommand } from './shared/process-runner.ts';
import { LeaseGuard } from './shared/lease-guard.ts';
import { publishAgentReports } from './shared/publish-reports.ts';
import type {
  ClaimPaths,
  ClaimResponse,
  JobStage,
  LlmConfig,
  ProjectSpec,
  StageKey,
  WorkerEventType,
  WorkflowJob,
  WorkflowEvent,
} from './shared/types.ts';

type WorkerMode = 'demo' | 'codex' | 'claude';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const rawMode = (process.argv.find((arg) => arg.startsWith('--mode=')) || '--mode=demo').split(
  '=',
)[1];
if (rawMode !== 'demo' && rawMode !== 'codex' && rawMode !== 'claude') {
  console.error('Valid modes: demo, codex, claude');
  process.exit(2);
}
const MODE: WorkerMode = rawMode;

const PROJECT_FILTER =
  (process.argv.find((arg) => arg.startsWith('--project=')) || '').split('=')[1] ||
  process.env.RAILFLOW_PROJECT ||
  '';

const API = (process.env.RAILFLOW_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const WORKER_ID = `${os.hostname()}-${process.pid}`;
const concurrency = Number(
  (process.argv.find((arg) => arg.startsWith('--concurrency=')) ?? '--concurrency=1').split('=')[1],
);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  throw new Error('concurrency must be 1–16');
interface JobContext {
  token: string;
  signal: AbortSignal;
}

const STAGE_NOTE_FILES: Record<string, string> = {
  ingest: '01_ingest.md',
  preprocess: '02_preprocess.md',
  analysis: '03_analysis.md',
  validate: '04_validation.md',
  visualize: '05_visualization.md',
};

const shutdown = new AbortController();
const sleep = (ms: number, signal = shutdown.signal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    shutdown.abort();
  });
}

async function req<T>(route: string, data: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as T;
  if (!res.ok)
    throw Object.assign(new Error(`${res.status}: ${JSON.stringify(json)}`), {
      status: res.status,
    });
  return json;
}

async function emit(
  ctx: JobContext,
  job: WorkflowJob,
  type: WorkerEventType,
  stage: StageKey | null,
  message: string,
  more: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<WorkflowEvent> {
  const data = {
    type,
    requestId: randomUUID(),
    leaseToken: ctx.token,
    stage,
    message,
    attempt: job.stages.find((item) => item.key === stage)?.attempts,
    ...more,
  };
  const send = () => req<{ event: WorkflowEvent }>(`/api/jobs/${job.id}/events`, data, signal);
  const result = await send().catch(async (error: unknown) => {
    if (signal?.aborted || ctx.signal.aborted) throw error;
    // The server may have committed the event before its response was lost.
    // A stable request ID makes this second delivery read the original result.
    return send();
  });
  return result.event;
}

interface ParsedAgentEvent {
  message: string;
  details?: string;
}

interface RawCliEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  event?: { type?: string };
  item?: {
    type?: string;
    command?: string;
    message?: string;
    aggregated_output?: string;
    output?: string;
    exit_code?: number;
    text?: string;
    name?: string;
  };
  message?: {
    content?: Array<{ type?: string; name?: string; text?: string }>;
  };
}

function parseAgentEvent(evt: RawCliEvent): string | ParsedAgentEvent | null {
  const item = evt.item || {};
  const typ = evt.type || evt.event?.type || 'event';

  if (typ === 'item.completed' && item.type === 'error') {
    const diagnostic =
      item.message?.trim() || item.text?.trim() || 'No diagnostic supplied by Codex';
    return {
      message: `item.completed · error: ${diagnostic.slice(0, 170)}`,
      details: diagnostic.length > 170 ? diagnostic.slice(0, 1300) : undefined,
    };
  }

  if (typ === 'item.completed' && item.type === 'command_execution') {
    const command = String(item.command || '').slice(0, 170);
    const output = String(item.aggregated_output || item.output || '').slice(-1300);
    return {
      message: `command_execution: ${command} (${item.exit_code === undefined ? 'finished' : `exit ${item.exit_code}`})`,
      details: output,
    };
  }

  if (typ === 'item.started' || typ === 'item.completed' || typ === 'item.updated') {
    const verb =
      item.type === 'command_execution'
        ? `${item.type}: ${String(item.command || '').slice(0, 170)}`
        : item.type === 'agent_message'
          ? `agent_message: ${String(item.text || '').slice(0, 170)}`
          : `${item.type || typ}: ${String(item.name || item.message || '').slice(0, 90)}`;
    if (verb.startsWith('agent_message') && typ === 'item.updated') return null;
    return `${typ} · ${verb}`;
  }

  if (typ === 'turn.failed' || typ === 'error') {
    return `${typ}: ${JSON.stringify(evt).slice(0, 180)}`;
  }

  if (typ === 'assistant' || typ === 'tool_use' || typ === 'tool_result') {
    const snippet = evt.message?.content?.[0]?.name || evt.message?.content?.[0]?.text || '';
    return `${typ}: ${String(snippet).slice(0, 170)}`;
  }

  if (typ === 'system' && evt.subtype === 'init') return 'Claude session initialized';
  if (typ === 'result') return `result: ${evt.is_error ? 'error' : 'ok'}`;
  return null;
}

function extractAgentMessageText(evt: RawCliEvent): string | null {
  if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && evt.item.text) {
    return evt.item.text.trim();
  }
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    const textParts = evt.message.content
      .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('\n');
  }
  if (evt.type === 'result' && typeof evt.result === 'string' && evt.result.trim()) {
    return evt.result.trim();
  }
  return null;
}

function resolveStageConfig(stageKey: StageKey, project?: ProjectSpec) {
  const stageSpec = project?.stages.find((item) => item.key === stageKey);
  const llm: LlmConfig = {
    model: stageSpec?.llm?.model?.trim() || project?.llm?.model?.trim() || '',
    effort: stageSpec?.llm?.effort || project?.llm?.effort || '',
  };
  return {
    instruction: stageSpec?.instruction?.trim() || '',
    llm,
  };
}

function formatLlmTag(llm: LlmConfig): string {
  const parts: string[] = [];
  if (llm.model) parts.push(`model=${llm.model}`);
  if (llm.effort) parts.push(`effort=${llm.effort}`);
  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

function summaryFileName(stage: StageKey): string {
  return `summary_${stage}.txt`;
}

interface QuickStats {
  headers: string[];
  rowCount: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  peakX: number;
  peakY: number;
}

function inspectInputQuickStats(inputPath: string): QuickStats | null {
  try {
    const text = readFileSync(inputPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return null;
    const delimiter = inputPath.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const headers = lines[0].split(delimiter).map((cell) => cell.trim());
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    let peakX = 0;
    let peakY = Number.NEGATIVE_INFINITY;
    let rowCount = 0;

    for (const line of lines.slice(1)) {
      const cells = line.split(delimiter);
      if (cells.length < 2) continue;
      const x = Number(cells[0]);
      const y = Number(cells[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      rowCount += 1;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
      if (y > peakY) {
        peakY = y;
        peakX = x;
      }
    }

    if (rowCount === 0) return null;
    return { headers, rowCount, xMin, xMax, yMin, yMax, peakX, peakY };
  } catch {
    return null;
  }
}

function buildDemoStageSummary(
  stage: JobStage,
  job: WorkflowJob,
  stats: QuickStats | null,
  reports: string[],
  customInstruction: string,
  llm: LlmConfig,
  isFinalStage: boolean,
): string {
  const columns = stats?.headers.slice(0, 2).join(', ') || '不明な列構成';
  const base = (() => {
    switch (stage.key) {
      case 'ingest':
        return stats
          ? `${job.file} から ${stats.rowCount} 行の数値レコードを読み込み、列（${columns}）と形式の整合性を確認しました。`
          : `${job.file} を取り込み、入力形式を確認しました。`;
      case 'preprocess':
        return stats
          ? `有限値チェックを完了。X 範囲 ${stats.xMin.toFixed(2)}–${stats.xMax.toFixed(2)}、Y 範囲 ${stats.yMin.toFixed(2)}–${stats.yMax.toFixed(2)} を確認しました。`
          : '数値範囲と欠損値のチェックを完了しました。';
      case 'analysis':
        return stats
          ? `再試行後に記述統計を算出。最大強度 ${stats.peakY.toFixed(1)}（X = ${stats.peakX.toFixed(2)}）を検出しました（クイックルック）。`
          : '記述的なクイックルック解析を完了しました。';
      case 'validate':
        return '記述的クイックルックであり、バックグラウンド除去・校正・ピーク帰属は未実施であることを確認しました。';
      case 'visualize':
        return 'Science Tokyo 配色（#435ea5）を用いた概観プロットの描画データを準備しました。';
      case 'publish':
        return reports.length
          ? `成果物（${reports.join(', ')}）を生成しました。`
          : 'レポートの下書きを準備しました。';
      default:
        return isFinalStage && reports.length
          ? `${stage.label} を完了し、成果物（${reports.join(', ')}）を生成しました。`
          : `${stage.label}（${stage.short}）の処理を完了しました。`;
    }
  })();

  const notes: string[] = [];
  if (customInstruction.trim()) notes.push('カスタム指示を参照');
  if (llm.model || llm.effort) notes.push(`指定LLM${formatLlmTag(llm)} ※デモは模擬実行`);
  return notes.length > 0 ? `${base}（${notes.join(' / ')}）` : base;
}

function extractAgentStageSummary(
  stage: JobStage,
  paths: ClaimPaths,
  reports: string[],
  lastAgentMessage: string,
  isFinalStage: boolean,
): string {
  const explicitSummaryPath = path.join(paths.work, summaryFileName(stage.key));
  if (existsSync(explicitSummaryPath)) {
    const content = readFileSync(explicitSummaryPath, 'utf8').trim();
    if (content) {
      return content.slice(0, 1200);
    }
  }

  if (lastAgentMessage.trim()) {
    return lastAgentMessage.trim().slice(0, 1200);
  }

  if (isFinalStage && reports.length > 0) {
    return `成果物（${reports.join(', ')}）を生成しました。`;
  }
  const noteName = STAGE_NOTE_FILES[stage.key];
  if (noteName) {
    const notePath = path.join(paths.work, noteName);
    if (existsSync(notePath)) {
      const content = readFileSync(notePath, 'utf8');
      const lines = content
        .split(/\r?\n/)
        .map((line) =>
          line
            .replace(/^#+\s*/, '')
            .replace(/^[-*]\s*/, '')
            .trim(),
        )
        .filter((line) => line.length > 0);
      if (lines.length > 0) {
        return `${noteName}: ${lines.slice(0, 3).join(' / ').slice(0, 400)}`;
      }
    }
  }
  return `${stage.label} 工程を完了しました。`;
}

async function runAgent(
  ctx: JobContext,
  job: WorkflowJob,
  stage: JobStage,
  work: string,
  prompt: string,
  llm: LlmConfig,
  timeoutMs: number,
  timeoutKind: FailureKind,
  signal = ctx.signal,
  engine: 'worker' | 'codex' | 'claude' = 'worker',
): Promise<string> {
  const mode = engine === 'worker' ? MODE : engine;
  const command = mode === 'codex' ? 'codex' : 'claude';
  const args =
    mode === 'codex'
      ? [
          'exec',
          '--json',
          '--sandbox',
          'workspace-write',
          ...(llm.model ? ['--model', llm.model] : []),
          ...(llm.effort
            ? ['-c', `model_reasoning_effort="${llm.effort === 'max' ? 'xhigh' : llm.effort}"`]
            : []),
          prompt,
        ]
      : [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          ...(llm.model ? ['--model', llm.model] : []),
          ...(llm.effort ? ['--effort', llm.effort] : []),
          prompt,
        ];
  let lastAgentMessage = '';
  let eventCount = 0;
  let pendingLogs = 0;
  let reportedFailure = false;
  await runCommand(command, args, {
    cwd: work,
    timeoutMs,
    timeoutKind,
    signal,
    onLine: (line, signal) => {
      let event: RawCliEvent;
      try {
        event = JSON.parse(line) as RawCliEvent;
      } catch {
        return;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;
      if (
        event.type === 'turn.failed' ||
        event.type === 'error' ||
        (event.type === 'result' && event.is_error)
      )
        reportedFailure = true;
      const message = extractAgentMessageText(event);
      if (message) lastAgentMessage = message;
      const parsed = parseAgentEvent(event);
      if (parsed && eventCount++ < 160 && pendingLogs < 8) {
        pendingLogs++;
        return emit(
          ctx,
          job,
          'agent.event',
          stage.key,
          typeof parsed === 'string' ? parsed : parsed.message,
          typeof parsed === 'string' ? {} : { details: parsed.details },
          signal,
        )
          .then(() => undefined)
          .finally(() => {
            pendingLogs--;
          });
      }
    },
  });
  if (reportedFailure)
    throw new ExecutionFailure(
      'execution_error',
      `${command} が実行失敗を報告しました。ログを確認してください。`,
    );
  return lastAgentMessage;
}

async function generateDemoReport(
  ctx: JobContext,
  job: WorkflowJob,
  paths: ClaimPaths,
  timeoutMs: number,
  timeoutKind: FailureKind,
  signal = ctx.signal,
): Promise<void> {
  await runCommand(
    process.env.RAILFLOW_PYTHON || 'python3',
    [
      path.join(ROOT, 'scripts', 'generate_report.py'),
      paths.manifest || paths.input,
      paths.work,
      job.id,
      ...(paths.manifest && paths.inputDir ? [paths.inputDir] : []),
    ],
    {
      cwd: paths.work,
      timeoutMs,
      timeoutKind,
      signal,
    },
  );
}

async function publishReports(
  ctx: JobContext,
  job: WorkflowJob,
  stage: JobStage,
  source: string,
  artifacts: string,
) {
  const reports = await publishAgentReports(source, artifacts);
  for (const name of reports) {
    if (job.artifacts.some((item) => item.name === name)) continue;
    const event = await emit(ctx, job, 'artifact.created', stage.key, `成果物 ${name} を保存`, {
      artifact: { name },
    });
    if (event.artifact && !job.artifacts.some((item) => item.name === name)) {
      job.artifacts.push(event.artifact);
    }
  }
  return reports;
}

function archiveDraftReports(work: string) {
  const existing = ['report.html', 'report.pptx'].filter((name) =>
    existsSync(path.join(work, name)),
  );
  if (!existing.length) return;
  const draft = mkdtempSync(path.join(work, 'draft-'));
  for (const name of existing) renameSync(path.join(work, name), path.join(draft, name));
}

function availableBudget(
  job: WorkflowJob,
  stage: JobStage,
  policy: ExecutionPolicy,
  project?: ProjectSpec,
) {
  const stageLeft = remainingBudget(policy.stageTimeoutMs, stage.activeMs ?? 0);
  const jobLeft = remainingBudget(
    project?.jobTimeoutMs ?? 0,
    job.stages.reduce((sum, item) => sum + (item.activeMs ?? 0), 0),
  );
  return {
    left: Math.min(stageLeft, jobLeft),
    kind: (jobLeft <= stageLeft ? 'job_timeout' : 'stage_timeout') as FailureKind,
  };
}

async function processJob(
  ctx: JobContext,
  job: WorkflowJob,
  paths: ClaimPaths,
  project?: ProjectSpec,
): Promise<void> {
  mkdirSync(paths.work, { recursive: true });
  mkdirSync(paths.artifacts, { recursive: true });
  console.log(`[${MODE}] claimed ${job.projectId}/${job.id} (${job.file})`);
  const quickStats =
    MODE === 'demo' && (job.dataset?.files.length ?? 1) === 1
      ? inspectInputQuickStats(paths.input)
      : null;
  const reviewStageKey =
    job.stages.find((stage) => stage.key === 'validate')?.key ||
    (job.stages.length > 1 ? job.stages.at(-2)?.key : job.stages[0]?.key);
  const retryDemoStageKey =
    job.stages.find((stage) => stage.key === 'analysis')?.key ||
    (job.stages.length >= 3 ? job.stages[1].key : null);
  let previous: string | undefined = job.workflow ? undefined : paths.work;

  for (let index = 0; index < job.stages.length; index++) {
    const stage = job.stages[index];
    if (ctx.signal.aborted) throw new ExecutionFailure('interrupted', '実行が中断されました。');
    const final = index === job.stages.length - 1;
    if (stage.status === 'success') {
      previous = stage.workspace ? path.join(paths.work, stage.workspace) : previous;
      if (final) {
        const legacyPending = path.join(
          path.dirname(path.dirname(paths.work)),
          'artifacts',
          `${job.id}.pending`,
        );
        const source = previous ?? (existsSync(legacyPending) ? legacyPending : paths.work);
        const available = ['report.html', 'report.pptx'].filter((name) =>
          existsSync(path.join(source, name)),
        );
        const missing = available.some((name) => !job.artifacts.some((item) => item.name === name));
        if (!job.artifacts.length || missing) {
          await publishReports(ctx, job, stage, source, paths.artifacts);
          rmSync(legacyPending, { recursive: true, force: true });
        }
      }
      continue;
    }
    const config = resolveStageConfig(stage.key, project);
    const spec = project?.stages.find((item) => item.key === stage.key) ?? {
      key: stage.key,
      label: stage.label,
      short: stage.short,
      ...config,
    };
    const policy = resolveExecution(project?.execution, spec.execution);
    let reason =
      [...job.events]
        .reverse()
        .find((event) => event.stage === stage.key && event.type === 'stage.failed')?.message ?? '';
    let accepted = false;

    if (stage.status === 'retry' && (stage.retryAt || stage.retryRemainingMs !== undefined)) {
      if (stage.retryRemainingMs !== undefined) {
        const resumed = await emit(
          ctx,
          job,
          'stage.retry.resumed',
          stage.key,
          '中断したリトライ待機を再開',
        );
        stage.retryAt = resumed.retryAt;
        stage.retryRemainingMs = undefined;
      }
      const delay = Math.max(0, Date.parse(stage.retryAt!) - Date.now());
      const aggregate = availableBudget(job, stage, policy, project);
      if (delay >= aggregate.left) {
        await emit(ctx, job, 'job.failed', stage.key, 'リトライ待機の時間予算が不足しています。', {
          failureKind: aggregate.kind,
        });
        return;
      }
      const waitStarted = performance.now();
      await sleep(delay, ctx.signal);
      if (ctx.signal.aborted) throw new ExecutionFailure('interrupted', '実行が中断されました。');
      const elapsedMs = Math.round(performance.now() - waitStarted);
      await emit(ctx, job, 'stage.retry.ready', stage.key, '保存されたリトライ待機を終了', {
        elapsedMs,
      });
      stage.activeMs = (stage.activeMs ?? 0) + elapsedMs;
    }
    while (!accepted) {
      const aggregate = availableBudget(job, stage, policy, project);
      if (aggregate.left <= 0) {
        await emit(
          ctx,
          job,
          'job.failed',
          stage.key,
          '工程またはジョブ全体の時間上限に達したため停止',
          {
            failureKind: aggregate.kind,
          },
        );
        return;
      }
      const attemptLimit = remainingBudget(policy.attemptTimeoutMs, 0);
      const envCap = Number(process.env.RAILFLOW_AGENT_TIMEOUT_MS);
      const limit = Math.min(
        attemptLimit,
        Number.isFinite(envCap) && envCap > 0 ? envCap : Infinity,
        aggregate.left,
      );
      const timeoutKind: FailureKind =
        aggregate.left <=
        Math.min(attemptLimit, Number.isFinite(envCap) && envCap > 0 ? envCap : Infinity)
          ? aggregate.kind
          : 'timeout';
      const started = performance.now();
      const elapsed = () => Math.max(0, Math.round(performance.now() - started));
      const remaining = () => {
        if (ctx.signal.aborted) throw new ExecutionFailure('interrupted', '実行が中断されました。');
        if (elapsed() >= limit)
          throw new ExecutionFailure(timeoutKind, `実行時間の上限に達しました (${timeoutKind})。`);
        return limit - elapsed();
      };
      stage.attempts++;
      const relative = `.attempts/${stage.key}/${stage.attempts}`;
      const work = path.join(paths.work, relative);
      const attemptPaths = { ...paths, work };
      let prompt = '';
      let promptError: Error | undefined;
      try {
        prompt = buildStagePrompt(
          project,
          spec,
          {
            'project.name': project?.name ?? job.projectId,
            'job.id': job.id,
            'dataset.name': job.file,
            'input.directory': paths.inputDir ?? path.dirname(paths.input),
            'input.files': JSON.stringify(
              job.dataset?.files.slice(0, 20).map((file) => file.path) ?? [
                path.basename(paths.input),
              ],
            ),
            'input.count': String(job.dataset?.files.length ?? 1),
            'input.manifest': paths.manifest ?? '(legacy single input: ' + paths.input + ')',
            workspace: work,
            'stage.key': stage.key,
            'stage.name': stage.label,
            attempt: String(stage.attempts),
            'retry.reason': reason,
            'task.id': stage.key,
            'input.item': '',
            'upstream.manifest': '',
          },
          final,
        );
      } catch (error) {
        promptError = error instanceof Error ? error : new Error(String(error));
      }
      await emit(
        ctx,
        job,
        'stage.started',
        stage.key,
        `${stage.key}: ${stage.attempts}回目の処理を開始${formatLlmTag(config.llm)}`,
        {
          workspace: relative,
          deadlineAt: Number.isFinite(limit)
            ? new Date(Date.now() + limit).toISOString()
            : undefined,
          stageConfig: {
            ...config,
            execution: policy,
            acceptanceCriteria: spec.acceptanceCriteria,
            gate: spec.gate,
            prompt,
          },
        },
      );
      const reportStaging = path.join(paths.work, '.reports', `${stage.key}-${stage.attempts}`);
      try {
        if (promptError)
          throw new ExecutionFailure('execution_error', promptError.message, { retryable: false });
        prepareAttempt(paths.work, relative, previous);
        if (final) archiveDraftReports(work);
        if (job.dataset && !verifyDataset(paths.inputDir!, job.dataset))
          throw new ExecutionFailure('execution_error', '登録時の入力データが変更されています。', {
            retryable: false,
          });
        let lastMessage = '';
        if (MODE === 'demo') {
          const duration = stage.key === retryDemoStageKey ? 2100 : 1100;
          await sleep(Math.min(duration, remaining()), ctx.signal);
          remaining();
          if (job.demo && stage.key === retryDemoStageKey && stage.attempts === 1)
            throw new Error('模擬エラー: ピーク検出の初期条件が収束せず');
          if (final) await generateDemoReport(ctx, job, attemptPaths, remaining(), timeoutKind);
        } else
          lastMessage = await runAgent(
            ctx,
            job,
            stage,
            work,
            prompt,
            config.llm,
            remaining(),
            timeoutKind,
          );
        remaining();
        // The snapshot stays altered, so every retry would fail the pre-run check.
        if (job.dataset && !verifyDataset(paths.inputDir!, job.dataset))
          throw new ExecutionFailure(
            'execution_error',
            'エージェントが入力スナップショットを変更しました。',
            { retryable: false },
          );
        await emit(
          ctx,
          job,
          'stage.executed',
          stage.key,
          'エージェントの実行が終了。受け入れ条件を確認します。',
        );
        for (const scope of final ? (['stage', 'final'] as const) : (['stage'] as const)) {
          const checked = await emit(
            ctx,
            job,
            'gate.evaluated',
            stage.key,
            scope === 'stage' ? '工程の受け入れ条件を判定' : '最終成果物の受け入れ条件を判定',
            { gate: { scope } },
          );
          if (checked.gate && checked.gate.result.status !== 'pass')
            throw new ExecutionFailure('acceptance_failed', failedEvidence(checked.gate.result));
        }
        let reports: string[] = [];
        if (final) {
          mkdirSync(reportStaging, { recursive: true });
          try {
            reports = await publishAgentReports(work, reportStaging);
          } catch (error) {
            throw new ExecutionFailure('acceptance_failed', (error as Error).message);
          }
        }
        remaining();
        const summary =
          MODE === 'demo'
            ? buildDemoStageSummary(
                stage,
                job,
                quickStats,
                reports,
                config.instruction,
                config.llm,
                final,
              )
            : extractAgentStageSummary(stage, attemptPaths, reports, lastMessage, final);
        const elapsedMs = elapsed();
        const review =
          spec.gate?.requireReview ||
          (final && project?.finalGate?.requireReview) ||
          (stage.key === reviewStageKey &&
            job.needsReview &&
            stage.approvedAttempt !== stage.attempts &&
            (job.workflow || !job.reviewApproved));
        if (review) {
          await emit(
            ctx,
            job,
            'review.required',
            stage.key,
            'レビュー待ち：この工程の結果を確認してください。',
            { summary, elapsedMs, workspace: relative },
          );
          return;
        }
        await emit(
          ctx,
          job,
          'stage.succeeded',
          stage.key,
          `${stage.key}: 受け入れ条件を満たして完了`,
          {
            summary,
            elapsedMs,
            workspace: relative,
          },
        );
        stage.activeMs = (stage.activeMs ?? 0) + elapsedMs;
        stage.status = 'success';
        stage.workspace = relative;
        accepted = true;
        previous = work;
        if (final) await publishReports(ctx, job, stage, reportStaging, paths.artifacts);
      } catch (error) {
        // Publication failures occur after acceptance and must never rerun the agent.
        if (accepted || ctx.signal.aborted) throw error;
        const kind = error instanceof ExecutionFailure ? error.kind : 'execution_error';
        reason = error instanceof Error ? error.message : String(error);
        const elapsedMs = elapsed();
        const deterministic = isDeterministicFailure(error);
        await emit(ctx, job, 'stage.failed', stage.key, `${stage.key}: ${reason.slice(0, 540)}`, {
          failureKind: kind,
          elapsedMs,
          workspace: relative,
        });
        stage.activeMs = (stage.activeMs ?? 0) + elapsedMs;
        if (
          !deterministic &&
          canRetry(policy, kind, (stage.retryCount ?? 0) + 1) &&
          !ctx.signal.aborted
        ) {
          const delay = retryDelay(policy, (stage.retryCount ?? 0) + 1);
          const left = availableBudget(job, stage, policy, project);
          if (delay >= left.left) {
            await emit(
              ctx,
              job,
              'job.failed',
              stage.key,
              '次のリトライ待機時間を確保できないため停止',
              {
                failureKind: left.kind,
              },
            );
            return;
          }
          const retryAt = new Date(Date.now() + delay).toISOString();
          await emit(
            ctx,
            job,
            'stage.retry',
            stage.key,
            `${delay / 1000} 秒後に再試行 (${(stage.retryCount ?? 0) + 1}/${policy.maxRetries} 回)`,
            { retryAt },
          );
          stage.retryCount = (stage.retryCount ?? 0) + 1;
          const waitStart = performance.now();
          await sleep(delay, ctx.signal);
          if (ctx.signal.aborted)
            throw new ExecutionFailure('interrupted', '実行が中断されました。');
          const waited = Math.round(performance.now() - waitStart);
          await emit(ctx, job, 'stage.retry.ready', stage.key, 'リトライ待機が終了', {
            elapsedMs: waited,
          });
          stage.activeMs += waited;
          if (ctx.signal.aborted)
            throw new ExecutionFailure('interrupted', '実行が中断されました。');
        } else if (
          !deterministic &&
          policy.onFailure === 'review' &&
          !['stage_timeout', 'job_timeout', 'interrupted'].includes(kind)
        ) {
          await emit(
            ctx,
            job,
            'review.required',
            stage.key,
            '失敗の確認待ち：この試行の出力を採用する場合のみ例外承認してください。',
            { workspace: relative, failureKind: kind, summary: reason.slice(0, 1200) },
          );
          return;
        } else {
          await emit(
            ctx,
            job,
            'job.failed',
            stage.key,
            deterministic
              ? `${stage.key}: 再試行しても同じ結果になるため停止（${kind}）`
              : `${stage.key}: ${kind} のため停止（試行 ${stage.attempts} 回）`,
            { failureKind: kind },
          );
          return;
        }
      } finally {
        rmSync(reportStaging, { recursive: true, force: true });
      }
    }
    if (!accepted) {
      await emit(ctx, job, 'job.failed', stage.key, '保存されたリトライ上限に達しています。');
      return;
    }
  }
  await emit(ctx, job, 'job.completed', null, 'すべての工程・受け入れ条件・成果物の公開が完了');
}

console.log(
  `Railflow pull worker: ${MODE} (${WORKER_ID})${PROJECT_FILTER ? ` [project=${PROJECT_FILTER}]` : ''} -> ${API}`,
);
async function workLoop() {
  while (!stopping) {
    try {
      const claimSentAt = Date.now();
      const response = await req<ClaimResponse>('/api/jobs/claim', {
        agent: MODE,
        worker: WORKER_ID,
        capacity: concurrency,
        protocol: 2,
        ...(PROJECT_FILTER ? { projectId: PROJECT_FILTER } : {}),
      });
      if (!response.job || !response.paths || !response.lease) {
        await sleep(1000);
        continue;
      }
      const { job, paths, project, lease } = response;
      const control = new AbortController();
      const signal = AbortSignal.any([shutdown.signal, control.signal]);
      const ctx: JobContext = { token: lease.token, signal };
      const guard = new LeaseGuard({
        sentAt: claimSentAt,
        ttlMs: lease.ttlMs ?? lease.heartbeatMs * 4,
        heartbeatMs: lease.heartbeatMs,
        onStop: () => control.abort(),
      });
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy || signal.aborted) return;
        heartbeatBusy = true;
        const sentAt = Date.now();
        void req<{ action: string; ttlMs?: number }>(
          `/api/jobs/${job.id}/heartbeat`,
          { leaseToken: lease.token },
          AbortSignal.timeout(Math.max(100, lease.heartbeatMs)),
        )
          .then((result) => {
            if (result.action !== 'continue') control.abort();
            else guard.renewed(sentAt, result.ttlMs);
          })
          // Authoritative rejection, or no time left to renew before expiry, fails closed.
          .catch((error: unknown) => guard.failed((error as { status?: number })?.status))
          .finally(() => {
            heartbeatBusy = false;
          });
      }, lease.heartbeatMs);
      try {
        if (job.workflow?.version === 2 && project?.graph)
          await executeGraph(job, paths, project, {
            signal,
            mode: MODE,
            apiOrigin: new URL(API).origin,
            emit: (type, task, message, more) => emit(ctx, job, type, task, message, more),
            reload: async () => {
              const result = await fetch(`${API}/api/jobs/${job.id}`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
              });
              if (!result.ok) throw new Error('ジョブの実行状態を取得できません。');
              return ((await result.json()) as { job: WorkflowJob }).job;
            },
            runAI: (task, work, prompt, llm, timeout, kind, taskSignal, engine) =>
              runAgent(ctx, job, task, work, prompt, llm, timeout, kind, taskSignal, engine),
            runDemo: (_task, attemptPaths, timeout, kind, taskSignal) =>
              generateDemoReport(ctx, job, attemptPaths, timeout, kind, taskSignal),
          });
        else await processJob(ctx, job, paths, project);
      } catch (err) {
        if (!signal.aborted) {
          await emit(
            ctx,
            job,
            'job.failed',
            null,
            err instanceof Error ? err.message : String(err),
            {
              failureKind: err instanceof ExecutionFailure ? err.kind : 'execution_error',
            },
          ).catch(() => undefined);
        }
      } finally {
        clearInterval(heartbeat);
        guard.dispose();
        // Also releases a claim interrupted between stage transitions. Terminal events
        // already release atomically; a resulting 409 is expected in that case.
        // A planned shutdown (SIGINT/SIGTERM) does not spend the job's recovery budget.
        const reason = control.signal.aborted
          ? 'control'
          : shutdown.signal.aborted
            ? 'shutdown'
            : 'interrupted';
        await req(`/api/jobs/${job.id}/release`, { leaseToken: lease.token, reason }).catch(
          () => undefined,
        );
        rmSync(paths.artifacts, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Worker error:', err instanceof Error ? err.message : String(err));
      await sleep(3000);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => workLoop()));
