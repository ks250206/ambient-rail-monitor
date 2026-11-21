import { createClient, type BytesResponse, type RailflowHttpClient } from '../client/http.ts';
import { createOperations, paginate } from '../client/operations.ts';
import { readTextWindow } from '../client/output.ts';
import { createReviewOperations } from '../client/review.ts';
import {
  RailflowError,
  type BinaryInfo,
  type ClientOptions,
  type ListPage,
  type RailflowErrorData,
  type TextWindow,
} from '../client/types.ts';
import pkg from '../package.json' with { type: 'json' };
import { inputHandlers } from './handlers/inputs.ts';
import { jobHandlers } from './handlers/jobs.ts';
import { projectHandlers } from './handlers/projects.ts';
import { reviewHandlers } from './handlers/review.ts';
import {
  INVALID_PARAMS,
  McpProtocolError,
  type McpRequestContext,
  type McpServerHandlers,
} from './protocol.ts';
import { createResourceHandlers } from './resources.ts';
import { toolSchemas, validateToolArgs, type ToolArgs, type ToolName } from './schemas.ts';

export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
const MAX_SKIP_BYTES = 1024 * 1024;
const TOOLS_PER_PAGE = 8;

interface PageParams {
  offset?: number;
  limit?: number;
}

interface WindowParams {
  offsetBytes?: number;
  maxBytes?: number;
}

type Preview = TextWindow | BinaryInfo;
type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: RailflowErrorData };

export interface ToolHandlerContext {
  client: RailflowHttpClient;
  ops: ReturnType<typeof createOperations>;
  review: ReturnType<typeof createReviewOperations>;
  signal: AbortSignal;
  uploadRoot?: string;
  sessionUploadIds: Set<string>;
  page: typeof boundedPage;
  window: typeof boundedWindow;
}

type ToolHandlers = {
  [N in ToolName]: (args: ToolArgs<N>, context: ToolHandlerContext) => unknown;
};

const handlers: ToolHandlers = {
  ...projectHandlers,
  ...jobHandlers,
  ...inputHandlers,
  ...reviewHandlers,
};

const hints = {
  read: [true, false, true, false],
  add: [false, false, false, false],
  mutate: [false, true, false, false],
  idempotent: [false, true, true, false],
  external: [false, true, false, true],
  save: [false, false, true, false],
  commit: [false, false, true, true],
} as const;

const metadata: Record<
  ToolName,
  readonly [hint: keyof typeof hints, description: string, cli?: string]
> = {
  railflow_health: [
    'read',
    'Check whether the Railflow API is reachable and measure request latency.',
  ],
  railflow_projects_list: [
    'read',
    'List project IDs, names, and revision timestamps.',
    'railflow projects list',
  ],
  railflow_project_get: [
    'read',
    'Get a project and its complete workflow definition.',
    'railflow projects get PROJECT_ID',
  ],
  railflow_project_create: [
    'add',
    'Create a project, optionally from a portable workflow template.',
  ],
  railflow_workflow_set: [
    'external',
    'Update a workflow only if its revision timestamp still matches.',
  ],
  railflow_project_delete: ['mutate', 'Delete the specified project after explicit confirmation.'],
  railflow_templates_list: [
    'read',
    'List the identities of built-in and saved workflow templates.',
    'railflow templates list',
  ],
  railflow_template_export: [
    'read',
    'Export a portable workflow template from a project.',
    'railflow templates export PROJECT_ID --out FILE',
  ],
  railflow_template_validate: [
    'read',
    'Validate a portable template and inspect its execution details.',
    'railflow templates validate --file FILE',
  ],
  railflow_template_save: ['save', 'Save a numbered revision of a project workflow as a template.'],
  railflow_template_delete: [
    'idempotent',
    'Delete a saved template by its exact name, revision, and hash after confirmation.',
  ],
  railflow_inputs_list: [
    'read',
    'List detected input files and directories for a project.',
    'railflow inputs list PROJECT_ID',
  ],
  railflow_input_check: [
    'read',
    'Evaluate an input candidate against a condition or the project input condition.',
  ],
  railflow_dataset_submit: [
    'external',
    'Upload files or directories selected by relative paths within the configured upload root.',
  ],
  railflow_upload_commit: ['commit', 'Retry committing an upload created by this MCP session.'],
  railflow_demo_create: ['add', 'Queue a demo job for the selected project.'],
  railflow_queue_get: ['read', 'Read global queue settings, active job count, and worker status.'],
  railflow_queue_set: ['idempotent', 'Replace global queue settings with the supplied limits.'],
  railflow_jobs_list: [
    'read',
    'List job summaries, optionally filtered by project and status.',
    'railflow jobs list',
  ],
  railflow_job_get: [
    'read',
    'Get a job summary and a page of stage summaries.',
    'railflow jobs get JOB_ID',
  ],
  railflow_job_wait: [
    'read',
    'Wait for a job to finish or need attention, returning its latest observed state at the deadline.',
  ],
  railflow_job_logs: [
    'read',
    'Read a bounded UTF-8 window from a job log.',
    'railflow jobs logs JOB_ID --out FILE',
  ],
  railflow_job_pause: ['mutate', 'Request that a job pause.'],
  railflow_job_resume: ['external', 'Resume a paused job.'],
  railflow_job_cancel: ['mutate', 'Cancel a job after explicit confirmation.'],
  railflow_job_priority: ['mutate', 'Set a job priority from -100 to 100.'],
  railflow_rerun_preview: [
    'read',
    'Show which tasks would run again and which would reuse completed outputs.',
  ],
  railflow_rerun_execute: [
    'external',
    'Create a new job that reruns the selected task and its downstream tasks.',
  ],
  railflow_review_list: [
    'read',
    'Inspect the current review target, receipt, failure kind, summary, and files.',
    'railflow review list JOB_ID --stage STAGE',
  ],
  railflow_review_read: [
    'read',
    'Read a bounded preview of a file from the exact review attempt.',
    'railflow review read JOB_ID --stage STAGE --attempt N --sequence N --path REL --out FILE',
  ],
  railflow_review_approve: [
    'external',
    'Approve the exact review attempt using its receipt. Hosts should display jobId / stageKey / attempt / failureKind / exception and confirm with the user.',
  ],
  railflow_provenance_get: [
    'read',
    'Get job provenance metadata and aggregate metrics.',
    'railflow jobs provenance JOB_ID --out FILE',
  ],
  railflow_artifacts_list: [
    'read',
    'List published artifact names and byte sizes for a job.',
    'railflow artifacts list JOB_ID',
  ],
  railflow_artifact_read: [
    'read',
    'Read a bounded preview of a published artifact by filename.',
    'railflow artifacts get JOB_ID --name NAME --out FILE',
  ],
};

export const toolCatalog = (Object.keys(toolSchemas) as ToolName[]).map((name) => {
  const [hint, description] = metadata[name];
  const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = hints[hint];
  return {
    name,
    description,
    ...toolSchemas[name],
    annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
  };
});

function limit(message: string): never {
  throw new RailflowError({ kind: 'limit', message });
}

function fits(data: unknown) {
  return Buffer.byteLength(JSON.stringify({ ok: true, data })) <= MAX_TOOL_RESULT_BYTES;
}

function boundedPage<T, R = ListPage<T>>(
  items: readonly T[],
  { offset = 0, limit: requested = 25 }: PageParams,
  project?: (page: ListPage<T>) => R,
): R | ListPage<T> {
  const wrap = (page: ListPage<T>) => (project ? project(page) : page);
  const initial = paginate(items, offset, requested);
  const full = wrap(initial);
  if (fits(full)) return full;

  let low = 1;
  let high = initial.items.length - 1;
  let best: R | ListPage<T> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const data = wrap(paginate(items, offset, count));
    if (fits(data)) {
      best = data;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  // Avoid returning a non-advancing offset when a single item is too large.
  return best ?? limit('An item or the surrounding data exceeds the 32 KiB MCP result limit.');
}

async function boundedWindow<T>(
  { offsetBytes = 0, maxBytes = 4096 }: WindowParams,
  open: () => Promise<BytesResponse>,
  project: (preview: Preview) => T,
): Promise<T> {
  if (offsetBytes > MAX_SKIP_BYTES) limit('offsetBytes exceeds the 1 MiB MCP skip limit.');
  const { stream, contentType, contentLength, close } = await open();
  let preview: Preview;
  try {
    preview = await readTextWindow(stream, {
      contentType,
      contentLength,
      offsetBytes,
      maxBytes,
      maxSkipBytes: MAX_SKIP_BYTES,
    });
  } finally {
    close();
  }
  const data = project(preview);
  if (fits(data) || 'binary' in preview) return data;

  // A text window may expand when JSON escapes control characters.
  const characters = Array.from(preview.text);
  let low = 1;
  let high = characters.length - 1;
  let best: T | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const text = characters.slice(0, count).join('');
    const nextOffsetBytes = preview.offsetBytes + Buffer.byteLength(text);
    // A replacement character could represent an invalid byte sequence of a different length.
    const candidate = project({ ...preview, text, nextOffsetBytes, truncated: true });
    if (text.includes('\ufffd') || !fits(candidate)) {
      high = count - 1;
    } else {
      best = candidate;
      low = count + 1;
    }
  }
  return best ?? limit('The preview exceeds the 32 KiB MCP result limit.');
}

function cursorFor(offset: number, size: number) {
  return Buffer.from(`tools:1:${size}:${offset}`).toString('base64url');
}

function cursorOffset(cursor: string | undefined, size: number) {
  if (cursor === undefined) return 0;
  for (let offset = TOOLS_PER_PAGE; offset < size; offset += TOOLS_PER_PAGE) {
    if (cursor === cursorFor(offset, size)) return offset;
  }
  throw new McpProtocolError(INVALID_PARAMS, 'Invalid cursor');
}

function errorOutcome(error: unknown, name: ToolName): ToolOutcome {
  let data: RailflowErrorData =
    error instanceof RailflowError
      ? error.toJSON()
      : { kind: 'protocol', message: 'Could not process the Railflow response' };
  const cli = metadata[name][2];
  if (data.kind === 'limit' && cli)
    data = { ...data, message: `${data.message} Use \`${cli}\` for the full result.` };

  const outcome = { ok: false, error: data } as const;
  if (Buffer.byteLength(JSON.stringify(outcome)) <= MAX_TOOL_RESULT_BYTES) return outcome;
  return {
    ok: false,
    error: {
      kind: data.kind,
      message: 'The error details exceed the 32 KiB MCP result limit.',
      status: data.status,
      operation: data.operation,
      uploadId: data.uploadId,
      jobId: data.jobId,
    },
  };
}

interface McpHandlerOptions extends ClientOptions {
  uploadRoot?: string;
  version?: string;
}

export function createMcpHandlers({
  uploadRoot,
  version = pkg.version,
  ...options
}: McpHandlerOptions): McpServerHandlers {
  const tools =
    uploadRoot === undefined
      ? toolCatalog.filter(
          ({ name }) => name !== 'railflow_dataset_submit' && name !== 'railflow_upload_commit',
        )
      : toolCatalog;
  const names = new Set<string>(tools.map(({ name }) => name));
  const sessionUploadIds = new Set<string>();

  async function execute<N extends ToolName>(
    name: N,
    args: unknown,
    ctx: McpRequestContext,
  ): Promise<ToolOutcome> {
    try {
      const validated = validateToolArgs(name, args);
      const signal = options.signal ? AbortSignal.any([options.signal, ctx.signal]) : ctx.signal;
      const client = createClient({ ...options, signal });
      const data = await handlers[name](validated, {
        client,
        ops: createOperations(client, options.origin),
        review: createReviewOperations(client),
        signal,
        uploadRoot,
        sessionUploadIds,
        page: boundedPage,
        window: boundedWindow,
      });
      if (!fits(data)) limit('The response exceeds the 32 KiB MCP result limit.');
      return { ok: true, data };
    } catch (error) {
      return errorOutcome(error, name);
    }
  }

  return {
    serverInfo: { name: 'railflow', version },
    listTools({ cursor }) {
      const offset = cursorOffset(cursor, tools.length);
      const end = offset + TOOLS_PER_PAGE;
      return {
        tools: tools.slice(offset, end),
        ...(end < tools.length ? { nextCursor: cursorFor(end, tools.length) } : {}),
      };
    },
    async callTool({ name, arguments: args = {} }, ctx) {
      if (!names.has(name)) throw new McpProtocolError(INVALID_PARAMS, 'Unknown tool');
      const outcome = await execute(name as ToolName, args, ctx);
      return {
        ...(outcome.ok ? {} : { isError: true }),
        structuredContent: outcome,
        content: [{ type: 'text', text: JSON.stringify(outcome) }],
      };
    },
    ...createResourceHandlers(async (name, args, ctx) => {
      const result = await execute(name, args, ctx);
      if (!result.ok) throw new RailflowError(result.error);
      return result.data;
    }),
  };
}
