import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { failedEvidence } from './conditions.ts';
import { verifyDataset } from './datasets.ts';
import {
  canRetry,
  remainingBudget,
  resolveExecution,
  retryDelay,
  type FailureKind,
} from './execution-policy.ts';
import { readyTask, taskSpec, type StageRunner } from './graph.ts';
import { prepareTaskInputs, verifyOutput } from './task-files.ts';
import { buildStagePrompt, expandTemplate, type PromptVariables } from './prompts.ts';
import { ExecutionFailure, runCommand } from './process-runner.ts';
import { publishAgentReports } from './publish-reports.ts';
import type {
  ClaimPaths,
  JobStage,
  LlmConfig,
  ProjectSpec,
  WorkerEventType,
  WorkflowEvent,
  WorkflowJob,
} from './types.ts';

interface Runtime {
  signal: AbortSignal;
  emit(
    type: WorkerEventType,
    task: string | null,
    message: string,
    more?: Record<string, unknown>,
  ): Promise<WorkflowEvent>;
  reload(): Promise<WorkflowJob>;
  runAI(
    task: JobStage,
    work: string,
    prompt: string,
    llm: LlmConfig,
    timeout: number,
    kind: FailureKind,
    signal: AbortSignal,
    engine: 'worker' | 'codex' | 'claude',
  ): Promise<string>;
  runDemo(
    task: JobStage,
    paths: ClaimPaths,
    timeout: number,
    kind: FailureKind,
    signal: AbortSignal,
  ): Promise<void>;
  mode: 'demo' | 'codex' | 'claude';
  apiOrigin?: string;
}

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
  'ComSpec',
  'VIRTUAL_ENV',
]);

function filteredProcessEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      SAFE_ENV_KEYS.has(key) ||
      key.startsWith('LC_') ||
      key.startsWith('PYTHON') ||
      key.startsWith('RAILFLOW_') ||
      key.startsWith('TEST_')
    ) {
      result[key] = value;
    }
  }
  return result;
}

function isBlockedHttpHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === '0.0.0.0' ||
    lower === '::' ||
    lower === 'metadata.google.internal' ||
    lower === 'metadata'
  )
    return true;
  if (
    lower.startsWith('169.254.') ||
    lower.startsWith('fe80:') ||
    lower.startsWith('::ffff:169.254.')
  )
    return true;
  return false;
}

function expandSafeUrl(template: string, variables: PromptVariables, apiOrigin?: string): string {
  const baseUrl = new URL(template);
  const encodedVariables = Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, encodeURIComponent(value)]),
  ) as PromptVariables;
  const expanded = expandTemplate(template, encodedVariables);
  const resolved = new URL(expanded);
  if (
    !['http:', 'https:'].includes(resolved.protocol) ||
    resolved.username ||
    resolved.password ||
    resolved.origin !== baseUrl.origin
  )
    throw new ExecutionFailure(
      'execution_error',
      'テンプレート展開後のHTTP URLが元のオリジンまたはプロトコル制約に違反しています。',
    );
  if (isBlockedHttpHost(resolved.hostname))
    throw new ExecutionFailure(
      'execution_error',
      'リンクローカルまたはメタデータURLには接続できません。',
    );
  if (apiOrigin && resolved.origin === apiOrigin)
    throw new ExecutionFailure(
      'execution_error',
      'HTTPステージからRailflow自身のコントロールAPIには接続できません。',
    );
  return resolved.toString();
}

async function delay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function runTyped(
  runner: Exclude<StageRunner, { kind: 'ai' }>,
  work: string,
  variables: PromptVariables,
  timeoutMs: number,
  timeoutKind: FailureKind,
  signal: AbortSignal,
  emit: (line: string) => Promise<void>,
  apiOrigin?: string,
) {
  const env: NodeJS.ProcessEnv = {
    ...filteredProcessEnv(),
    RAILFLOW_INPUT_DIR: variables['input.directory'],
    RAILFLOW_INPUT_MANIFEST: variables['input.manifest'],
    RAILFLOW_INPUT_ITEM: variables['input.item'],
    RAILFLOW_UPSTREAM_MANIFEST: variables['upstream.manifest'],
    RAILFLOW_TASK_ID: variables['task.id'],
    RAILFLOW_JOB_ID: variables['job.id'],
    RAILFLOW_ATTEMPT: variables.attempt,
  };
  if (runner.kind === 'human') {
    writeFileSync(
      path.join(work, '_railflow/review.md'),
      'Review the task instructions and upstream files before approving this attempt.\n',
    );
    return '入力資料と指示を確認して承認してください。';
  }
  if (runner.kind === 'http') {
    const timeout = Number.isFinite(timeoutMs)
      ? AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
      : undefined;
    const requestSignal = timeout ? AbortSignal.any([signal, timeout]) : signal;
    try {
      const targetUrl = expandSafeUrl(runner.url, variables, apiOrigin);
      const headers: Record<string, string> = {
        ...(runner.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(runner.idempotencyKey
          ? { 'Idempotency-Key': `${variables['job.id']}/${variables['task.id']}` }
          : {}),
      };
      const response = await fetch(targetUrl, {
        method: runner.method,
        signal: requestSignal,
        redirect: 'error',
        headers,
        ...(runner.method === 'POST' ? { body: expandTemplate(runner.body, variables) } : {}),
      });
      if (response.status !== runner.successStatus) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}（期待 ${runner.successStatus}）`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) {
            await response.body.cancel();
            throw new Error('HTTPレスポンスの上限は2 MiBです。');
          }
          chunks.push(chunk);
        }
      const output = path.join(work, runner.output);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, Buffer.concat(chunks));
      return `HTTP ${response.status} · ${size} bytes → ${runner.output}`;
    } catch (error) {
      if (timeout?.aborted && !signal.aborted)
        throw new ExecutionFailure(timeoutKind, 'HTTPの応答待ちが時間上限に達しました。');
      throw error;
    }
  }
  let program: string;
  let args = runner.args.map((arg) => expandTemplate(arg, variables));
  if (runner.kind === 'python') {
    const file = path.join(work, '_railflow/task.py');
    writeFileSync(file, runner.code);
    program = process.env.RAILFLOW_PYTHON || 'python3';
    args = [file, ...args];
  } else program = runner.program;
  let lines = 0;
  await runCommand(program, args, {
    cwd: work,
    env,
    replaceEnv: true,
    signal,
    timeoutMs,
    timeoutKind,
    onLine: (line) => {
      if (lines++ < 100) return emit(line.slice(0, 1000));
    },
  });
  return `${runner.kind === 'python' ? 'Python' : program} の処理が終了しました。`;
}

/** A single job lease owns a bounded set of independent task attempts. */
export async function executeGraph(
  job: WorkflowJob,
  paths: ClaimPaths,
  project: ProjectSpec,
  runtime: Runtime,
): Promise<void> {
  mkdirSync(paths.work, { recursive: true });
  mkdirSync(paths.artifacts, { recursive: true });
  const budget = new AbortController();
  const signal = AbortSignal.any([runtime.signal, budget.signal]);
  const claimTime = Date.parse(
    job.events.findLast((event) => event.type === 'job.claimed')?.at ?? new Date().toISOString(),
  );
  const jobLeft = remainingBudget(
    project.jobTimeoutMs ?? 0,
    (job.activeMs ?? 0) + Math.max(0, Date.now() - claimTime),
  );
  const deadline = Number.isFinite(jobLeft) ? performance.now() + jobLeft : Infinity;
  const timer = Number.isFinite(jobLeft)
    ? setTimeout(() => budget.abort(), Math.max(1, jobLeft))
    : undefined;
  const active = new Map<string, Promise<void>>();
  const startedAt = new Map<string, number>();
  let taskError: unknown;
  const emit = runtime.emit.bind(runtime);
  const interrupted = () => {
    if (signal.aborted)
      throw new ExecutionFailure(
        budget.signal.aborted ? 'job_timeout' : 'interrupted',
        '実行を中断しました。',
      );
  };

  const runTask = async (task: JobStage) => {
    const spec = taskSpec(project, task);
    const policy = resolveExecution(project.execution, spec.execution);
    const final = task.key === project.graph!.publishStage;
    const runner = spec.runner ?? { kind: 'ai', engine: 'worker' };
    let reason =
      job.events.findLast((event) => event.type === 'stage.failed' && event.stage === task.key)
        ?.message ?? '';
    const scopeBudget = () => {
      const stage = remainingBudget(policy.stageTimeoutMs, task.activeMs ?? 0);
      const job = deadline - performance.now();
      return {
        left: Math.min(stage, job),
        kind: (job <= stage ? 'job_timeout' : 'stage_timeout') as FailureKind,
      };
    };
    if (task.status === 'retry' && (task.retryAt || task.retryRemainingMs !== undefined)) {
      if (task.retryRemainingMs !== undefined) {
        task.retryAt = (
          await emit('stage.retry.resumed', task.key, '保存した待機時間から再開')
        ).retryAt;
        task.retryRemainingMs = undefined;
      }
      const wait = Math.max(0, Date.parse(task.retryAt!) - Date.now());
      const budgetLeft = scopeBudget();
      if (wait >= budgetLeft.left) {
        if (budgetLeft.kind === 'job_timeout')
          throw new ExecutionFailure('job_timeout', 'リトライ待機の時間予算がありません。');
        await emit('stage.failed', task.key, 'リトライ待機が工程の時間上限を超えるため停止', {
          failureKind: 'stage_timeout',
        }).catch(() => undefined);
        task.status = 'failed';
        return;
      }
      const start = performance.now();
      await delay(wait, signal);
      interrupted();
      const elapsedMs = Math.round(performance.now() - start);
      await emit('stage.retry.ready', task.key, 'リトライ待機が終了', { elapsedMs });
      task.activeMs = (task.activeMs ?? 0) + elapsedMs;
    }
    while (true) {
      interrupted();
      const budgetLeft = scopeBudget();
      if (budgetLeft.left <= 0) {
        if (budgetLeft.kind === 'job_timeout')
          throw new ExecutionFailure('job_timeout', 'ジョブ全体の時間上限に達しました。');
        task.status = 'failed';
        return;
      }
      const left = budgetLeft.left;
      const envCap = Number(process.env.RAILFLOW_AGENT_TIMEOUT_MS);
      const limit = Math.min(
        left,
        remainingBudget(policy.attemptTimeoutMs, 0),
        envCap > 0 && Number.isFinite(envCap) ? envCap : Infinity,
      );
      const kind: FailureKind =
        left <= limit
          ? deadline - performance.now() <= left
            ? 'job_timeout'
            : 'stage_timeout'
          : 'timeout';
      const start = performance.now();
      startedAt.set(task.key, start);
      const elapsed = () => Math.round(performance.now() - start);
      const remaining = () => {
        interrupted();
        if (elapsed() >= limit) throw new ExecutionFailure(kind, '工程の時間上限に達しました。');
        return limit - elapsed();
      };
      task.attempts++;
      const relative = `.attempts/${task.key}/${task.attempts}`;
      const work = path.join(paths.work, relative);
      const variables: PromptVariables = {
        'project.name': project.name,
        'job.id': job.id,
        'dataset.name': job.file,
        'input.directory': paths.inputDir!,
        'input.manifest': paths.manifest!,
        'input.files': JSON.stringify(job.dataset!.files.slice(0, 20).map((file) => file.path)),
        'input.count': String(job.dataset!.files.length),
        'input.item': task.item?.path ?? '',
        'upstream.manifest': path.join(work, '_railflow/inputs.json'),
        workspace: work,
        'stage.key': spec.key,
        'stage.name': spec.label,
        'task.id': task.key,
        attempt: String(task.attempts),
        'retry.reason': reason,
      };
      let prompt = '';
      let promptError: Error | undefined;
      try {
        prompt = buildStagePrompt(project, spec, variables, final);
      } catch (error) {
        promptError = error instanceof Error ? error : new Error(String(error));
      }
      const llm = {
        model: spec.llm.model || project.llm.model,
        effort: spec.llm.effort || project.llm.effort,
      };
      await emit('stage.started', task.key, `${task.label}: 試行 ${task.attempts}`, {
        attempt: task.attempts,
        workspace: relative,
        deadlineAt: Number.isFinite(limit) ? new Date(Date.now() + limit).toISOString() : undefined,
        stageConfig: { instruction: spec.instruction, llm, prompt },
      });
      task.status = 'running';
      task.workspace = relative;
      const reports = path.join(paths.work, '.reports', task.key + '-' + task.attempts);
      try {
        if (promptError) throw new ExecutionFailure('execution_error', promptError.message);
        mkdirSync(path.dirname(work), { recursive: true });
        mkdirSync(work);
        const inputs = prepareTaskInputs(job, task, paths.work, work);
        writeFileSync(path.join(work, '_railflow/instructions.md'), prompt);
        const check = async (scope: 'input' | 'output' | 'stage' | 'final') => {
          const event = await emit(
            'gate.evaluated',
            task.key,
            `${scope}: 契約・受け入れ条件を検証`,
            { gate: { scope } },
          );
          if (event.gate?.result.status !== 'pass')
            throw new ExecutionFailure(
              'acceptance_failed',
              event.gate ? failedEvidence(event.gate.result) : '判定が返りませんでした。',
            );
        };
        await check('input');
        remaining();
        let summary = '';
        const allowDemoExec = process.env.RAILFLOW_ALLOW_LOCAL_EXEC === '1';
        if (runner.kind === 'ai') {
          if (runtime.mode === 'demo' && runner.engine === 'worker') {
            if (final) await runtime.runDemo(task, { ...paths, work }, remaining(), kind, signal);
            else {
              await delay(Math.min(150, remaining()), signal);
              writeFileSync(path.join(work, 'summary.txt'), `Demo: ${task.label}`);
            }
            summary = 'デモ処理を完了しました。';
          } else {
            if (runtime.mode === 'demo' && !allowDemoExec)
              throw new ExecutionFailure(
                'execution_error',
                'demo モードでは外部 AI エンジンを実行できません（RAILFLOW_ALLOW_LOCAL_EXEC=1 で許可）。',
              );
            summary = await runtime.runAI(
              task,
              work,
              prompt,
              llm,
              remaining(),
              kind,
              signal,
              runner.engine,
            );
          }
        } else {
          if (runtime.mode === 'demo' && runner.kind !== 'human' && !allowDemoExec)
            throw new ExecutionFailure(
              'execution_error',
              'demo モードではローカルコマンド・Python・HTTP ステージを実行できません（RAILFLOW_ALLOW_LOCAL_EXEC=1 で許可）。',
            );
          summary = await runTyped(
            runner,
            work,
            variables,
            remaining(),
            kind,
            signal,
            (line) => emit('agent.event', task.key, line).then(() => undefined),
            runtime.apiOrigin,
          );
        }
        remaining();
        if (!inputs.verify() || !verifyDataset(paths.inputDir!, job.dataset!))
          throw new ExecutionFailure('acceptance_failed', '実行中に入力が変更されました。');
        await emit('stage.executed', task.key, '処理が終了しました。');
        await check('output');
        await check('stage');
        if (final) await check('final');
        if (final) {
          mkdirSync(reports, { recursive: true });
          try {
            await publishAgentReports(work, reports);
          } catch (error) {
            throw new ExecutionFailure('acceptance_failed', (error as Error).message);
          }
        }
        remaining();
        const elapsedMs = elapsed();
        const review =
          runner.kind === 'human' ||
          spec.gate?.requireReview ||
          (final && project.finalGate?.requireReview) ||
          (final && job.needsReview && task.approvedAttempt !== task.attempts);
        const event = await emit(
          review ? 'review.required' : 'stage.succeeded',
          task.key,
          review ? 'このタスクの確認・承認を待っています。' : '契約と受け入れ条件を満たしました。',
          { elapsedMs, summary: summary.slice(0, 1200), workspace: relative },
        );
        task.status = review ? 'review' : 'success';
        task.output = event.output;
        task.activeMs = (task.activeMs ?? 0) + elapsedMs;
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        const failureKind = error instanceof ExecutionFailure ? error.kind : 'execution_error';
        reason = error instanceof Error ? error.message : String(error);
        const elapsedMs = elapsed();
        await emit('stage.failed', task.key, reason.slice(0, 600), {
          failureKind,
          elapsedMs,
          workspace: relative,
        });
        task.activeMs = (task.activeMs ?? 0) + elapsedMs;
        task.status = 'failed';
        if (canRetry(policy, failureKind, (task.retryCount ?? 0) + 1)) {
          const wait = retryDelay(policy, (task.retryCount ?? 0) + 1);
          const budgetLeft = scopeBudget();
          if (wait >= budgetLeft.left) {
            if (budgetLeft.kind === 'job_timeout')
              throw new ExecutionFailure('job_timeout', 'リトライ待機の時間予算がありません。');
            return;
          }
          await emit('stage.retry', task.key, `${wait} ms後に再試行`, {
            retryAt: new Date(Date.now() + wait).toISOString(),
          });
          task.retryCount = (task.retryCount ?? 0) + 1;
          task.status = 'retry';
          const startWait = performance.now();
          await delay(wait, signal);
          interrupted();
          const waited = Math.round(performance.now() - startWait);
          await emit('stage.retry.ready', task.key, 'リトライ待機が終了', { elapsedMs: waited });
          task.activeMs += waited;
        } else if (
          policy.onFailure === 'review' &&
          ['execution_error', 'timeout', 'acceptance_failed'].includes(failureKind)
        ) {
          const event = await emit(
            'review.required',
            task.key,
            '失敗出力を確認し、採用する場合だけ例外承認してください。',
            { failureKind, workspace: relative },
          );
          task.status = 'review';
          task.output = event.output;
          return;
        } else return;
      } finally {
        rmSync(reports, { recursive: true, force: true });
      }
    }
  };

  try {
    while (true) {
      interrupted();
      const loadingActive = new Set(active.keys());
      let latest: WorkflowJob;
      try {
        latest = await runtime.reload();
      } catch {
        interrupted();
        await delay(200, signal);
        continue;
      }
      if (latest.status === 'pausing' || latest.status === 'cancelling') {
        budget.abort();
        await Promise.allSettled(active.values());
        return;
      }
      if (latest.status !== 'running')
        throw new ExecutionFailure('interrupted', 'ジョブの実行状態が変更されました。');
      job.artifacts = latest.artifacts;
      for (let i = 0; i < job.stages.length; i++) {
        const task = job.stages[i];
        if (!active.has(task.key) && !loadingActive.has(task.key)) {
          const updated = latest.stages.find((item) => item.key === task.key);
          if (updated) job.stages[i] = updated;
        }
      }
      const available = job.stages.filter((task) => !active.has(task.key) && readyTask(job, task));
      for (const task of available.slice(0, project.graph!.maxParallelTasks - active.size)) {
        const promise = runTask(task)
          .catch((error: unknown) => {
            taskError ??= error;
          })
          .finally(() => active.delete(task.key));
        active.set(task.key, promise);
      }
      interrupted();
      if (taskError) throw taskError;
      if (!active.size) {
        if (job.stages.every((task) => task.status === 'success')) {
          const final = job.stages.find((task) => task.key === project.graph!.publishStage)!;
          if (
            !final.output ||
            !verifyOutput(path.join(paths.work, final.workspace!), final.output, {
              excludeInternal: true,
            })
          )
            throw new Error('公開直前に出力が変更されています。');
          const names = await publishAgentReports(
            path.join(paths.work, final.workspace!),
            paths.artifacts,
          );
          interrupted();
          for (const name of names) {
            if (job.artifacts.some((item) => item.name === name)) continue;
            const created = await emit('artifact.created', final.key, `成果物 ${name} を公開`, {
              artifact: { name },
            });
            if (created.artifact && !job.artifacts.some((item) => item.name === name))
              job.artifacts.push(created.artifact);
          }
          await emit('job.completed', null, '全タスクの契約・承認と公開が完了');
          return;
        }
        if (job.stages.some((task) => task.status === 'failed')) {
          await emit(
            'job.failed',
            null,
            '失敗したタスクがあります。独立したタスクの合格結果は保持しました。',
          );
          return;
        }
        if (job.stages.some((task) => task.status === 'review')) {
          try {
            await emit('job.waiting', null, 'レビュー待ち。実行枠を解放しました。');
          } catch (error) {
            if (error && typeof error === 'object' && 'status' in error && error.status === 409)
              continue;
            throw error;
          }
          return;
        }
        throw new Error('依存関係を解決できません。');
      }
      await Promise.race([...active.values(), delay(200, signal)]);
    }
  } catch (error) {
    const timedOut =
      budget.signal.aborted || (error instanceof ExecutionFailure && error.kind === 'job_timeout');
    budget.abort();
    await Promise.allSettled(active.values());
    if (runtime.signal.aborted) throw error;
    const kind: FailureKind = timedOut
      ? 'job_timeout'
      : error instanceof ExecutionFailure
        ? error.kind
        : 'execution_error';
    for (const task of job.stages.filter((item) => item.status === 'running')) {
      await emit('stage.failed', task.key, 'ジョブ全体の停止でタスクを終了', {
        failureKind: kind,
        elapsedMs: Math.round(performance.now() - (startedAt.get(task.key) ?? performance.now())),
      }).catch(() => undefined);
    }
    await emit('job.failed', null, error instanceof Error ? error.message : String(error), {
      failureKind: kind,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
