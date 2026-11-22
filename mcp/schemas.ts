import { RailflowError } from '../client/types.ts';
import {
  COMPARE_LABELS,
  CONDITION_LIMITS,
  parseCondition,
  validRelativePath,
  type Condition,
} from '../shared/conditions.ts';
import { parseSchema, type JsonSchema as FileSchema } from '../shared/contracts.ts';
import { MAX_BUDGET_MS, RETRY_LABELS } from '../shared/execution-policy.ts';
import { QUEUE_LIMITS } from '../shared/queue.ts';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

type Primitive = string | number | boolean | null;
interface Schema<T = unknown> {
  // The type parameter describes the checked value and has no runtime representation.
  readonly valueType?: T;
  $schema?: string;
  $ref?: string;
  $defs?: Fields;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  properties?: Fields;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  oneOf?: readonly Schema[];
  const?: Primitive;
  enum?: readonly Primitive[];
  default?: Primitive;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

type Fields = Record<string, Schema>;
type Value<S> = S extends Schema<infer T> ? T : never;
type ObjectValue<P extends Fields, Optional extends keyof P> = {
  [K in Exclude<keyof P, Optional>]: Value<P[K]>;
} & { [K in Optional]?: Value<P[K]> };

function object<P extends Fields, O extends keyof P & string = never>(
  properties: P,
  optional: readonly O[] = [],
): Schema<ObjectValue<P, O>> {
  const omitted = new Set<string>(optional);
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !omitted.has(key)),
    additionalProperties: false,
  };
}

function partialObject<P extends Fields>(properties: P) {
  return object(properties, Object.keys(properties) as (keyof P & string)[]);
}

function array<T>(items: Schema<T>, minItems?: number, maxItems?: number): Schema<T[]> {
  return { type: 'array', items, minItems, maxItems };
}

function text(maxLength?: number, pattern?: string): Schema<string> {
  return { type: 'string', maxLength, pattern };
}

function integer(
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
  fallback?: number,
): Schema<number> {
  return { type: 'integer', minimum, maximum, default: fallback };
}

function choice<const T extends readonly string[]>(...values: T): Schema<T[number]> {
  return { type: 'string', enum: values };
}

function literal<const T extends Primitive>(value: T): Schema<T> {
  return { const: value };
}

function union<const T extends readonly Schema[]>(...oneOf: T): Schema<Value<T[number]>> {
  return { oneOf };
}

function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return union(schema, literal(null));
}

function dictionary<T>(value: Schema<T>): Schema<Record<string, T>> {
  return { type: 'object', additionalProperties: value };
}

const checks = new WeakMap<Schema, (value: unknown) => unknown>();

function checked<T>(schema: Schema<T>, check: (value: T) => unknown): Schema<T> {
  checks.set(schema, (value) => check(value as T));
  return schema;
}

export function usage(message: string): never {
  throw new RailflowError({ kind: 'usage', message });
}

const string = text();
const nonBlank = text(undefined, '\\S');
const bool: Schema<boolean> = { type: 'boolean' };
const number: Schema<number> = { type: 'number' };
const count = integer();
const name = text(120, '\\S');
const revision = text(80, '\\S');
const hash = text(64, '^[a-f0-9]{64}$');
const uuid = text(36, '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$');
const jobId = text(12, '^run_[a-f0-9]{8}$');
const projectId = text(undefined, '^[a-z0-9_-]+$');
const taskKey = text(undefined, '^[a-z0-9_-]+$');
const stageKey = text(48, '^[a-z0-9][a-z0-9_-]*$');
const confirm = literal(true);
const jobStatus = choice(
  'queued',
  'running',
  'review',
  'done',
  'failed',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
);
const stageStatus = choice('pending', 'running', 'success', 'failed', 'retry', 'review');
const failureKind = choice(
  ...Object.keys(RETRY_LABELS),
  'stage_timeout',
  'job_timeout',
  'interrupted',
);
const inputOrigin = choice('project', 'legacy');
const inputKind = choice('file', 'directory');

// Export the same ID rules for resources, which use URI IDs as tool arguments.
export const isProjectId = (value: string) => matches(projectId.pattern!, value);
export const isJobId = (value: string) => matches(jobId.pattern!, value);

const basename = text(undefined, '^(?!\\.{1,2}$)[^/\\\\]+$');
const filename = checked({ ...basename }, (value) => {
  if (Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    usage('Expected a single filename without control characters');
});
const rel = checked({ ...text(512), minLength: 1 }, (value) => {
  if (!validRelativePath(value)) usage('Expected a safe relative path');
});
const glob = checked({ ...text(512), minLength: 1 }, (value) => {
  if (!validRelativePath(value, true)) usage('Expected a safe relative file pattern');
});
const inputFilename = checked({ ...basename, maxLength: 512 }, (value) => {
  if (!validRelativePath(value)) usage('Expected a safe input filename');
});

const page = { offset: integer(0, Number.MAX_SAFE_INTEGER, 0), limit: integer(1, 100, 25) };
const window = {
  offsetBytes: integer(0, Number.MAX_SAFE_INTEGER, 0),
  maxBytes: integer(1, 8192, 4096),
};
const pageKeys = ['offset', 'limit'] as const;
const windowKeys = ['offsetBytes', 'maxBytes'] as const;

const compare = choice(...Object.keys(COMPARE_LABELS));
const scalar = union(string, bool, number);
const conditionRef: Schema<Condition> = { $ref: '#/$defs/condition' };
const conditionResultRef = { $ref: '#/$defs/conditionResult' };
const condition = union(
  object({ op: choice('all', 'any'), children: array(conditionRef, 1, CONDITION_LIMITS.children) }),
  object({ op: literal('not'), child: conditionRef }),
  object({ op: literal('file.exists'), pattern: glob }),
  object({ op: choice('file.count', 'file.bytes'), pattern: glob, compare, value: count }),
  object({ op: literal('file.contains'), path: rel, text: text(2000, '\\S') }),
  object({
    op: literal('json.value'),
    path: rel,
    field: text(200, '\\S'),
    compare,
    value: union(text(2000), bool, number),
  }),
  object({ op: literal('quiet'), seconds: integer(0, 86400) }),
  object({ op: literal('name.contains'), value: name }),
);
const triggerCondition = checked(nullable(conditionRef), (value) =>
  parseCondition(value, 'trigger'),
);
const gateCondition = checked(nullable(conditionRef), (value) => parseCondition(value, 'gate'));
const conditionResult = object(
  {
    status: choice('pass', 'fail', 'error'),
    label: string,
    message: string,
    actual: scalar,
    children: array(conditionResultRef),
  },
  ['actual', 'children'],
);
const gate = object({ condition: gateCondition, requireReview: bool }, [
  'condition',
  'requireReview',
]);
const input = object(
  {
    mode: choice('auto', 'file', 'directory'),
    settleMs: integer(0, 86_400_000),
    condition: triggerCondition,
  },
  ['mode', 'settleMs', 'condition'],
);

function queueField(key: keyof typeof QUEUE_LIMITS) {
  const { min, max } = QUEUE_LIMITS[key];
  return integer(min, max);
}
const queue = object({
  maxConcurrentJobs: queueField('maxConcurrentJobs'),
  maxJobsPerWorker: queueField('maxJobsPerWorker'),
  maxRecoveries: queueField('maxRecoveries'),
});
const projectQueue = object({
  maxConcurrentJobs: queueField('maxConcurrentJobs'),
  priority: queueField('priority'),
});
const llmFields = {
  model: text(100, '^[A-Za-z0-9._:/-]*$'),
  effort: choice('', 'low', 'medium', 'high', 'xhigh', 'max'),
};
const llm = object(llmFields);
const executionFields = {
  maxRetries: integer(0, 10),
  attemptTimeoutMs: integer(0, MAX_BUDGET_MS),
  stageTimeoutMs: integer(0, MAX_BUDGET_MS),
  retryDelayMs: integer(0, 3_600_000),
  backoff: choice('fixed', 'exponential'),
  retryOn: array(choice(...Object.keys(RETRY_LABELS))),
  onFailure: choice('stop', 'review'),
};
const execution = partialObject(executionFields);
const graph = object(
  {
    mode: choice('sequential', 'dag'),
    maxParallelTasks: integer(1, 8),
    publishStage: text(48),
  },
  ['maxParallelTasks', 'publishStage'],
);
const runtime = object(
  {
    revision: text(120),
    python: text(512),
    expected: object({ node: text(80), python: text(80), codex: text(80), claude: text(80) }, [
      'node',
      'python',
      'codex',
      'claude',
    ]),
    packages: dictionary(text(80)),
  },
  ['revision', 'python', 'expected', 'packages'],
);
const price = { type: 'number', minimum: 0, maximum: 1_000_000 } satisfies Schema<number>;
const prices = array(
  object({
    engine: choice('codex', 'claude'),
    model: name,
    input: price,
    output: price,
    cacheRead: price,
    cacheWrite: price,
  }),
  0,
  30,
);
const argv = array(text(2000), 0, 64);
const runner = union(
  object({ kind: literal('ai'), engine: choice('worker', 'codex', 'claude') }, ['engine']),
  object({ kind: literal('command'), program: text(512, '\\S'), args: argv }, ['args']),
  object({ kind: literal('python'), code: text(32_000), args: argv }, ['args']),
  object(
    {
      kind: literal('http'),
      method: choice('GET', 'POST'),
      url: text(2000, '\\S'),
      body: text(32_000),
      output: rel,
      successStatus: integer(200, 299),
      idempotencyKey: bool,
    },
    ['body', 'output', 'successStatus', 'idempotencyKey'],
  ),
  object({ kind: literal('human') }),
);
const fileSchemaRef: Schema<FileSchema> = { $ref: '#/$defs/fileSchema' };
const fileSchema = object(
  {
    type: choice('object', 'array', 'string', 'number', 'integer', 'boolean', 'null'),
    properties: dictionary(fileSchemaRef),
    required: array(text(120), 0, 64),
    additionalProperties: bool,
    items: fileSchemaRef,
    enum: array(nullable(scalar), 1, 100),
    minimum: number,
    maximum: number,
    minItems: integer(0, 1_000_000),
    maxItems: integer(0, 1_000_000),
    minLength: integer(0, 1_000_000),
    maxLength: integer(0, 1_000_000),
  },
  [
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
  ],
);
const contract = object(
  {
    pattern: glob,
    minFiles: integer(0, 5000),
    maxFiles: integer(0, 5000),
    schema: checked({ ...fileSchemaRef }, parseSchema),
    source: choice('dataset', 'upstream'),
  },
  ['minFiles', 'maxFiles', 'schema', 'source'],
);
const stageFields = {
  key: stageKey,
  label: text(80, '\\S'),
  short: text(40, '\\S'),
  instruction: text(8000),
  llm,
  acceptanceCriteria: text(4000),
  gate,
  execution,
  runner,
  dependsOn: array(stageKey, 0, 50),
  map: nullable(
    object({ pattern: glob, maxItems: integer(1, 128), isolateInput: bool }, [
      'maxItems',
      'isolateInput',
    ]),
  ),
  contracts: object({ inputs: array(contract, 0, 20), outputs: array(contract, 0, 20) }, [
    'inputs',
    'outputs',
  ]),
  cache: object({ enabled: bool, revision: text(120) }, ['enabled', 'revision']),
};
const stage = object(stageFields, [
  'acceptanceCriteria',
  'gate',
  'execution',
  'runner',
  'dependsOn',
  'map',
  'contracts',
  'cache',
]);
const definitionFields = {
  name,
  purpose: text(2000),
  acceptanceCriteria: text(4000),
  llm,
  stages: array(stage, 1, 50),
  input,
  execution,
  jobTimeoutMs: integer(0, MAX_BUDGET_MS),
  finalGate: gate,
  prompt: text(8000),
  queue: projectQueue,
  graph,
  runtime,
  pricing: prices,
};
const llmPatch = partialObject(llmFields);
const workflowPatch = partialObject({
  ...definitionFields,
  llm: llmPatch,
  stages: array(partialObject({ ...stageFields, llm: llmPatch }), 0, 50),
  graph: nullable(graph),
});
const workflowOptions = [
  'input',
  'execution',
  'jobTimeoutMs',
  'finalGate',
  'prompt',
  'queue',
  'graph',
  'runtime',
  'pricing',
] as const;
const identity = object({ name, revision, hash });
const template = object({
  format: literal('ambient-rail-monitor.workflow'),
  formatVersion: literal(1),
  template: identity,
  definition: object(definitionFields, workflowOptions),
});
const project = object(
  {
    ...definitionFields,
    id: projectId,
    inboxDir: string,
    artifactsDir: string,
    createdAt: string,
    updatedAt: string,
    templateOrigin: identity,
  },
  [...workflowOptions, 'templateOrigin'],
);
const projectHead = object({ id: projectId, name: string, updatedAt: string });
const jobHead = object(
  {
    id: jobId,
    projectId,
    file: string,
    status: jobStatus,
    createdAt: string,
    parentJobId: jobId,
    lastSequence: count,
  },
  ['parentJobId'],
);
const stageHead = object(
  {
    key: taskKey,
    label: string,
    status: stageStatus,
    attempts: count,
    reviewSequence: count,
    failureKind,
  },
  ['reviewSequence', 'failureKind'],
);
const inputCandidate = object(
  {
    origin: inputOrigin,
    name: string,
    kind: inputKind,
    fileCount: count,
    bytes: count,
    status: choice('waiting', 'registered', 'error'),
    message: string,
    result: conditionResultRef,
  },
  ['result'],
);
const worker = object({ id: string, active: count, lastHeartbeatAt: string });
const reviewRefFields = {
  jobId,
  stageKey: taskKey,
  attempt: integer(1),
  reviewSequence: integer(1),
};
const reviewRef = object({ ...reviewRefFields, attempt: count, reviewSequence: count });
const fileHead = object({ path: rel, bytes: count });
const textWindow = object({
  text: string,
  offsetBytes: count,
  nextOffsetBytes: nullable(count),
  truncated: bool,
});
const preview = union(
  textWindow,
  object({ binary: literal(true), mimeType: string, bytes: nullable(count) }),
);
const metrics = object({
  aiAttempts: count,
  unknownAttempts: count,
  partialAttempts: count,
  unpricedAttempts: count,
  pricedAttempts: count,
  reportedAttempts: count,
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  estimatedCostUsd: nullable(number),
  reportedCostUsd: nullable(number),
  cacheHits: count,
  reusedTasks: count,
  activeMs: nullable(number),
});

const railflowError = object(
  {
    kind: choice(
      'usage',
      'transport',
      'timeout',
      'http',
      'protocol',
      'limit',
      'interrupted',
      'outcome_unknown',
    ),
    message: string,
    status: integer(100, 599),
    result: conditionResultRef,
    operation: string,
    uploadId: string,
    jobId: string,
  },
  ['status', 'result', 'operation', 'uploadId', 'jobId'],
);

function list<T>(items: Schema<T>) {
  return object({ items: array(items), total: count, nextOffset: nullable(count) });
}

const defs: Fields = { condition, conditionResult, fileSchema };

function withDefinitions<T>(schema: Schema<T>, definitions: readonly string[]): Schema<T> {
  return definitions.length
    ? { ...schema, $defs: Object.fromEntries(definitions.map((key) => [key, defs[key]])) }
    : schema;
}

function tool<T>(inputSchema: Schema<T>, data: Schema, definitions: readonly string[] = []) {
  return {
    inputSchema: { ...withDefinitions(inputSchema, definitions), $schema: DRAFT },
    outputSchema: {
      ...withDefinitions(
        {
          type: 'object',
          oneOf: [
            object({ ok: literal(true), data }),
            object({ ok: literal(false), error: railflowError }),
          ],
        },
        ['conditionResult', ...definitions.filter((key) => key !== 'conditionResult')],
      ),
      $schema: DRAFT,
    },
  };
}

const job = object({ job: jobHead });
const upload = object({ uploadId: uuid, job: jobHead });
const workflowDefinitions = ['condition', 'fileSchema'];
const rerun = object({ jobId, task: taskKey });
const runnerKind = choice('ai', 'command', 'python', 'http', 'human');
const executionDetail = object({
  key: stageKey,
  label: string,
  kind: choice('command', 'python', 'http'),
  fields: array(object({ label: string, value: string })),
});

export const toolSchemas = {
  railflow_health: tool(
    object({}),
    object({ origin: string, latencyMs: number, reachable: literal(true) }),
  ),
  railflow_projects_list: tool(object(page, pageKeys), list(projectHead)),
  railflow_project_get: tool(object({ projectId }), object({ project }), workflowDefinitions),
  railflow_project_create: tool(
    object({ name, id: projectId, template }, ['id', 'template']),
    object({ project: projectHead }),
    workflowDefinitions,
  ),
  railflow_workflow_set: tool(
    object({
      projectId,
      expectedUpdatedAt: nonBlank,
      definition: workflowPatch,
    }),
    object({ project: projectHead }),
    workflowDefinitions,
  ),
  railflow_project_delete: tool(object({ projectId, confirm }), object({ ok: confirm, projectId })),
  railflow_templates_list: tool(
    object(page, pageKeys),
    list(object({ source: choice('builtin', 'saved'), name, revision, hash })),
  ),
  railflow_template_export: tool(
    object({ projectId, name, revision }, ['name', 'revision']),
    object({ template }),
    workflowDefinitions,
  ),
  railflow_template_validate: tool(
    object({ template }),
    object({
      identity,
      preview: object({ stages: count, graph, runtime, kinds: array(runnerKind) }, [
        'graph',
        'runtime',
      ]),
      executionDetails: array(executionDetail),
    }),
    workflowDefinitions,
  ),
  railflow_template_save: tool(object({ projectId, name, revision }), object({ identity })),
  railflow_template_delete: tool(
    object({ name, revision, hash, confirm }),
    object({ ok: confirm }),
  ),
  railflow_inputs_list: tool(object({ projectId, ...page }, pageKeys), list(inputCandidate)),
  railflow_input_check: tool(
    object({ projectId, name: inputFilename, origin: inputOrigin, condition: triggerCondition }, [
      'origin',
      'condition',
    ]),
    object({ result: conditionResultRef }),
    ['condition'],
  ),
  railflow_dataset_submit: tool(
    object({ projectId, paths: array(rel, 1, 1000), name }, ['name']),
    upload,
  ),
  railflow_upload_commit: tool(object({ uploadId: uuid }), upload),
  railflow_demo_create: tool(object({ projectId, review: bool }, ['review']), job),
  railflow_queue_get: tool(
    object({}),
    object({ settings: queue, active: count, workers: array(worker) }),
  ),
  railflow_queue_set: tool(queue, object({ settings: queue })),
  railflow_jobs_list: tool(
    object({ projectId, status: jobStatus, ...page }, ['projectId', 'status', ...pageKeys]),
    list(jobHead),
  ),
  railflow_job_get: tool(
    object({ jobId, ...page }, pageKeys),
    object({ job: jobHead, stages: list(stageHead) }),
  ),
  railflow_job_wait: tool(
    object(
      {
        jobId,
        until: { ...choice('terminal', 'attention'), default: 'terminal' },
        timeoutMs: integer(1, 30_000, 10_000),
      },
      ['until', 'timeoutMs'],
    ),
    object({
      job: jobHead,
      reached: bool,
      reason: choice('done', 'failed', 'cancelled', 'paused', 'review', 'timeout'),
    }),
  ),
  railflow_job_logs: tool(object({ jobId, ...window }, windowKeys), textWindow),
  railflow_job_pause: tool(object({ jobId }), job),
  railflow_job_resume: tool(object({ jobId }), job),
  railflow_job_cancel: tool(object({ jobId, confirm }), job),
  railflow_job_priority: tool(object({ jobId, priority: queueField('priority') }), job),
  railflow_rerun_preview: tool(rerun, object({ rerun: array(string), reuse: array(string) })),
  railflow_rerun_execute: tool(rerun, object({ parentJobId: jobId, job: jobHead })),
  railflow_review_list: tool(
    object({ jobId, stageKey: taskKey, ...page }, pageKeys),
    object(
      {
        ref: reviewRef,
        receipt: nullable(string),
        failureKind: nullable(string),
        summary: nullable(string),
        files: list(fileHead),
        fileHashes: dictionary(hash),
      },
      ['fileHashes'],
    ),
  ),
  railflow_review_read: tool(
    object({ ...reviewRefFields, path: rel, sha256: hash, ...window }, windowKeys),
    object({ ref: reviewRef, file: fileHead, preview }),
  ),
  railflow_review_approve: tool(
    object({ ...reviewRefFields, receipt: nonBlank, exception: bool, confirm }),
    object({ ok: confirm, ref: reviewRef, exception: bool }),
  ),
  railflow_provenance_get: tool(
    object({ jobId }),
    object({
      format: literal('railflow.provenance'),
      formatVersion: literal(1),
      exportedAt: string,
      complete: bool,
      asOfSequence: count,
      job: jobHead,
      metrics,
    }),
  ),
  railflow_artifacts_list: tool(
    object({ jobId, ...page }, pageKeys),
    list(object({ name: filename, bytes: count })),
  ),
  railflow_artifact_read: tool(
    object({ jobId, name: filename, ...window }, windowKeys),
    object({ name: filename, preview }),
  ),
};

export type ToolName = keyof typeof toolSchemas;
export type ToolArgs<N extends ToolName> = Value<(typeof toolSchemas)[N]['inputSchema']>;

function matches(pattern: string, value: string): boolean {
  const match = new RegExp(pattern).exec(value);
  return (
    match !== null && (!pattern.endsWith('$') || match.index + match[0].length === value.length)
  );
}

function validate(
  schema: Schema,
  value: unknown,
  path: string,
  definitions: Fields,
  depth = 0,
): void {
  if (depth > 64) usage(`${path} is nested too deeply`);
  const invalid = () => usage(`Invalid value for ${path}`);
  if (schema.$ref)
    validate(
      definitions[schema.$ref.slice('#/$defs/'.length)],
      value,
      path,
      definitions,
      depth + 1,
    );
  if (schema.const !== undefined && schema.const !== value) invalid();
  if (schema.enum && !schema.enum.includes(value as Primitive)) invalid();
  if (schema.oneOf) {
    const accepted = schema.oneOf.some((option) => {
      try {
        validate(option, value, path, definitions, depth + 1);
        return true;
      } catch (error) {
        if (error instanceof RailflowError && error.kind === 'usage') return false;
        throw error;
      }
    });
    if (!accepted) invalid();
  }
  switch (schema.type) {
    case 'object': {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      )
        return invalid();
      const record = value as Record<string, unknown>;
      const fields = schema.properties ?? {};
      for (const key of Object.keys(record)) {
        const child = Object.hasOwn(fields, key) ? fields[key] : schema.additionalProperties;
        if (child === false) usage(`Unexpected property ${path}.${key}`);
        else if (child && typeof child === 'object')
          validate(child, record[key], `${path}.${key}`, definitions, depth + 1);
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(record, key)) usage(`Missing required property ${path}.${key}`);
      }
      break;
    }
    case 'array':
      if (
        !Array.isArray(value) ||
        value.length < (schema.minItems ?? 0) ||
        value.length > (schema.maxItems ?? Infinity)
      )
        return invalid();
      if (schema.items) {
        const item = schema.items;
        for (const [index, entry] of value.entries())
          validate(item, entry, `${path}[${index}]`, definitions, depth + 1);
      }
      break;
    case 'string':
      if (
        typeof value !== 'string' ||
        value.length < (schema.minLength ?? 0) ||
        value.length > (schema.maxLength ?? Infinity) ||
        (schema.pattern && !matches(schema.pattern, value))
      )
        invalid();
      break;
    case 'integer':
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      )
        invalid();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') invalid();
      break;
    case 'null':
      if (value !== null) invalid();
      break;
  }
  try {
    checks.get(schema)?.(value);
  } catch (error) {
    usage(`${path}: ${error instanceof Error ? error.message : 'Invalid value'}`);
  }
}

export function validateToolArgs<N extends ToolName>(name: N, args: unknown): ToolArgs<N> {
  const schema = toolSchemas[name].inputSchema;
  validate(schema, args, 'arguments', schema.$defs ?? {});
  return args as ToolArgs<N>;
}
