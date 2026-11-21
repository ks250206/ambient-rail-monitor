import type { PriceRate } from './reuse.ts';
import type { WorkflowJob } from './types.ts';

export interface ModelUsage {
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export interface UsageRecord {
  engine: 'codex' | 'claude';
  source: 'codex.turn' | 'claude.result' | 'unavailable';
  scope: 'run' | 'main_loop' | 'unknown';
  complete: boolean;
  models: ModelUsage[];
  reportedCostUsd: number | null;
  estimatedCostUsd?: number | null;
}
const count = (n: unknown): number | null =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1e12 ? n : null;
const money = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Consume terminal summaries only: assistant chunks repeat usage during streaming. */
export class UsageAccumulator {
  record: UsageRecord;
  private model: string;
  /** Once any turn fails or reports unusable usage, the run total can never be complete. */
  private incomplete = false;
  constructor(engine: 'codex' | 'claude', model: string) {
    this.model = model;
    this.record = {
      engine,
      source: 'unavailable',
      scope: 'unknown',
      complete: false,
      models: [],
      reportedCostUsd: null,
    };
  }
  accept(value: unknown) {
    const event = object(value);
    if (!event) return;
    if (
      this.record.engine === 'codex' &&
      (event.type === 'turn.failed' || event.type === 'error')
    ) {
      this.incomplete = true;
      this.record = { ...this.record, complete: false };
      return;
    }
    if (this.record.engine === 'codex' && event.type === 'turn.completed') {
      const raw = object(event.usage);
      if (!raw) {
        this.incomplete = true;
        this.record = { ...this.record, complete: false };
        return;
      }
      const input = count(raw.input_tokens),
        output = count(raw.output_tokens),
        cacheRead = count(raw.cached_input_tokens ?? 0),
        cacheWrite = count(raw.cache_write_input_tokens ?? 0);
      if (
        input === null ||
        output === null ||
        cacheRead === null ||
        cacheWrite === null ||
        input < cacheRead + cacheWrite
      ) {
        this.incomplete = true;
        this.record = { ...this.record, complete: false };
        return;
      }
      const previous = this.record.models[0];
      this.record = {
        engine: 'codex',
        source: 'codex.turn',
        scope: 'run',
        complete: !this.incomplete,
        reportedCostUsd: null,
        models: [
          {
            model: this.model,
            input: (previous?.input ?? 0) + input - cacheRead - cacheWrite,
            cacheRead: (previous?.cacheRead ?? 0) + cacheRead,
            cacheWrite: (previous?.cacheWrite ?? 0) + cacheWrite,
            output: (previous?.output ?? 0) + output,
          },
        ],
      };
    }
    if (this.record.engine === 'claude' && event.type === 'result') {
      const modelUsage = object(event.modelUsage);
      let models: ModelUsage[] = [];
      if (modelUsage && Object.keys(modelUsage).length <= 50) {
        let valid = true;
        for (const [model, value] of Object.entries(modelUsage)) {
          const raw = object(value);
          if (!raw || model.length > 120) {
            valid = false;
            break;
          }
          const input = count(raw.inputTokens),
            output = count(raw.outputTokens),
            cacheRead = count(raw.cacheReadInputTokens ?? 0),
            cacheWrite = count(raw.cacheCreationInputTokens ?? 0);
          if (input === null || output === null || cacheRead === null || cacheWrite === null) {
            valid = false;
            break;
          }
          models.push({ model, input, output, cacheRead, cacheWrite });
        }
        if (!valid) models = [];
      }
      const wholeRun = models.length > 0;
      if (!models.length) {
        const raw = object(event.usage);
        if (raw) {
          const input = count(raw.input_tokens),
            output = count(raw.output_tokens),
            cacheRead = count(raw.cache_read_input_tokens ?? 0),
            cacheWrite = count(raw.cache_creation_input_tokens ?? 0);
          if (input !== null && output !== null && cacheRead !== null && cacheWrite !== null)
            models.push({ model: this.model, input, output, cacheRead, cacheWrite });
        }
      }
      this.record = {
        engine: 'claude',
        source: 'claude.result',
        scope: wholeRun ? 'run' : models.length ? 'main_loop' : 'unknown',
        complete: wholeRun,
        models,
        reportedCostUsd: money(event.total_cost_usd),
      };
    }
  }
}

export function priceUsage(value: unknown, pricing: PriceRate[]): UsageRecord {
  const raw = object(value);
  if (
    !raw ||
    !['codex', 'claude'].includes(String(raw.engine)) ||
    !['codex.turn', 'claude.result', 'unavailable'].includes(String(raw.source)) ||
    !['run', 'main_loop', 'unknown'].includes(String(raw.scope)) ||
    typeof raw.complete !== 'boolean' ||
    !Array.isArray(raw.models) ||
    raw.models.length > 50
  )
    throw new Error('使用量の形式が不正です。');
  const models: ModelUsage[] = raw.models.map((item) => {
    const row = object(item);
    if (!row || typeof row.model !== 'string' || row.model.length > 120)
      throw new Error('使用量のモデル名が不正です。');
    const input = count(row.input),
      output = count(row.output),
      cacheRead = count(row.cacheRead),
      cacheWrite = count(row.cacheWrite);
    if (input === null || output === null || cacheRead === null || cacheWrite === null)
      throw new Error('token数が不正です。');
    return { model: row.model, input, output, cacheRead, cacheWrite };
  });
  let estimatedCostUsd: number | null = models.length ? 0 : null;
  for (const row of models) {
    const rate = pricing.find((rate) => rate.engine === raw.engine && rate.model === row.model);
    if (!rate) {
      estimatedCostUsd = null;
      break;
    }
    estimatedCostUsd! +=
      (row.input * rate.input +
        row.cacheRead * rate.cacheRead +
        row.cacheWrite * rate.cacheWrite +
        row.output * rate.output) /
      1_000_000;
  }
  return {
    engine: raw.engine as UsageRecord['engine'],
    source: raw.source as UsageRecord['source'],
    scope: raw.scope as UsageRecord['scope'],
    complete: raw.complete,
    models,
    reportedCostUsd: money(raw.reportedCostUsd),
    estimatedCostUsd,
  };
}

export function usageSummary(job: WorkflowJob) {
  const attempts = job.events.filter((event) => event.type === 'stage.started');
  let aiAttempts = 0,
    unknownAttempts = 0,
    partialAttempts = 0,
    unpricedAttempts = 0,
    pricedAttempts = 0,
    reportedAttempts = 0;
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    estimatedCostUsd = 0,
    reportedCostUsd = 0;
  for (let i = 0; i < attempts.length; i++) {
    const start = attempts[i];
    const nextSameStage = attempts
      .slice(i + 1)
      .find((event) => event.stage === start.stage)?.sequence;
    const events =
      start.attempt !== undefined
        ? job.events.filter(
            (event) => event.stage === start.stage && event.attempt === start.attempt,
          )
        : job.events.filter(
            (event) =>
              event.stage === start.stage &&
              event.sequence >= start.sequence &&
              (nextSameStage === undefined || event.sequence < nextSameStage),
          );
    if (events.some((event) => event.type === 'stage.cache' && event.cache?.hit)) continue;
    const task = job.stages.find((task) => task.key === start.stage);
    const spec = job.workflow?.project.stages.find(
      (stage) => stage.key === (task?.stageKey ?? task?.key),
    );
    const runtime = events.find((event) => event.runtime)?.runtime;
    const usage = events.findLast((event) => event.type === 'stage.usage')?.usage;
    if (
      !usage &&
      events.some(
        (event) =>
          event.type === 'gate.evaluated' &&
          event.gate?.scope === 'input' &&
          event.gate.result.status !== 'pass',
      )
    )
      continue;
    const claimed = job.events.findLast(
      (event) => event.type === 'job.claimed' && event.sequence < start.sequence,
    );
    const engine = runtime?.engine ?? usage?.engine ?? claimed?.agent;
    if ((spec?.runner?.kind ?? 'ai') !== 'ai' || engine === 'demo' || runtime?.issues.length)
      continue;
    aiAttempts++;
    if (!usage?.models.length) unknownAttempts++;
    else {
      if (!usage.complete) partialAttempts++;
      for (const row of usage.models) {
        input += row.input;
        output += row.output;
        cacheRead += row.cacheRead;
        cacheWrite += row.cacheWrite;
      }
    }
    if (usage?.estimatedCostUsd != null) {
      estimatedCostUsd += usage.estimatedCostUsd;
      pricedAttempts++;
    } else unpricedAttempts++;
    if (usage?.reportedCostUsd != null) {
      reportedCostUsd += usage.reportedCostUsd;
      reportedAttempts++;
    }
  }
  return {
    aiAttempts,
    unknownAttempts,
    partialAttempts,
    unpricedAttempts,
    pricedAttempts,
    reportedAttempts,
    input,
    output,
    cacheRead,
    cacheWrite,
    estimatedCostUsd: pricedAttempts ? estimatedCostUsd : null,
    reportedCostUsd: reportedAttempts ? reportedCostUsd : null,
    cacheHits: job.events.filter((event) => event.type === 'stage.cache' && event.cache?.hit)
      .length,
    reusedTasks: job.stages.filter((task) => task.completion?.mode === 'reused').length,
    activeMs: job.activeMs ?? null,
  };
}
