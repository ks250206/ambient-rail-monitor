import type { Condition, ConditionResult } from '../shared/conditions.ts';
import { parsePriority, parseQueue, type QueueSettings } from '../shared/queue.ts';
import { executionDetails } from '../shared/template-preview.ts';
import type { PortableWorkflow, WorkflowTemplate } from '../shared/templates.ts';
import type {
  AppStateResponse,
  ArtifactInfo,
  InputCandidate,
  JobStage,
  JobStatus,
  ProjectSpec,
  WorkflowJob,
} from '../shared/types.ts';
import type { usageSummary } from '../shared/usage.ts';
import { DEFAULT_SERVER, parseServerOrigin } from './config.ts';
import type { RailflowHttpClient } from './http.ts';
import {
  RailflowError,
  type JobHead,
  type ListPage,
  type ProjectHead,
  type StageHead,
} from './types.ts';

type QueueState = NonNullable<AppStateResponse['queue']>;
type SequencedJob = WorkflowJob & { lastSequence: number };
type StreamOptions = Parameters<RailflowHttpClient['openBytes']>[1];
type ProjectDefinition = Partial<PortableWorkflow>;
type RerunPlan = { rerun: string[]; reuse: string[] };
interface TemplatePreview {
  stages: number;
  graph?: ProjectSpec['graph'];
  runtime?: ProjectSpec['runtime'];
  kinds: Array<NonNullable<ProjectSpec['stages'][number]['runner']>['kind'] | 'ai'>;
}
interface Provenance {
  format: 'railflow.provenance';
  formatVersion: 1;
  exportedAt: string;
  complete: boolean;
  asOfSequence: number;
  job: WorkflowJob;
  metrics: ReturnType<typeof usageSummary>;
}

function protocol(message: string): never {
  throw new RailflowError({ kind: 'protocol', message });
}

function missing(message: string): never {
  throw new RailflowError({ kind: 'http', status: 404, message });
}

function usage(message: string): never {
  throw new RailflowError({ kind: 'usage', message });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) protocol(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) protocol(`Expected an array for ${label}`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  const items = array(value, label);
  if (!items.every((item) => typeof item === 'string')) protocol(`Invalid ${label}`);
  return items;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function projectOf(value: unknown, expectedId?: string): ProjectSpec {
  const project = record(value, 'project');
  if (
    typeof project.id !== 'string' ||
    typeof project.name !== 'string' ||
    typeof project.updatedAt !== 'string' ||
    !Array.isArray(project.stages)
  )
    protocol('Invalid project');
  if (expectedId !== undefined && project.id !== expectedId) protocol('Unexpected project ID');
  return project as unknown as ProjectSpec;
}

function projectList(value: unknown): ProjectSpec[] {
  return array(record(value, 'response').projects, 'projects').map((project) => projectOf(project));
}

function artifactOf(value: unknown): ArtifactInfo {
  const artifact = record(value, 'artifact');
  if (
    typeof artifact.name !== 'string' ||
    typeof artifact.uri !== 'string' ||
    !count(artifact.bytes)
  )
    protocol('Invalid artifact');
  return artifact as unknown as ArtifactInfo;
}

const jobStatuses = new Set<JobStatus>([
  'queued',
  'running',
  'review',
  'done',
  'failed',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
]);

function jobOf(value: unknown, expectedId?: string): WorkflowJob & { lastSequence?: number } {
  const job = record(value, 'job');
  if (
    typeof job.id !== 'string' ||
    typeof job.projectId !== 'string' ||
    typeof job.file !== 'string' ||
    typeof job.createdAt !== 'string' ||
    !jobStatuses.has(job.status as JobStatus)
  )
    protocol('Invalid job');
  if (expectedId !== undefined && job.id !== expectedId) protocol('Unexpected job ID');
  for (const value of array(job.stages, 'stages')) {
    const stage = record(value, 'stage');
    if (
      typeof stage.key !== 'string' ||
      typeof stage.label !== 'string' ||
      !count(stage.attempts) ||
      !['pending', 'running', 'success', 'failed', 'retry', 'review'].includes(String(stage.status))
    )
      protocol('Invalid job stage');
  }
  array(job.artifacts, 'artifacts').forEach(artifactOf);
  const events = array(job.events, 'events');
  if (
    (job.lastSequence !== undefined && !count(job.lastSequence)) ||
    (events.length > 0 && !count(record(events.at(-1), 'event').sequence))
  )
    protocol('Invalid last job sequence');
  return job as unknown as WorkflowJob & { lastSequence?: number };
}

export function jobFromResponse(value: unknown, expectedId?: string) {
  return jobOf(record(value, 'response').job, expectedId);
}

function templateOf(value: unknown): WorkflowTemplate {
  const raw = record(value, 'template');
  const identity = record(raw.template, 'template identity');
  const definition = record(raw.definition, 'template definition');
  if (
    raw.format !== 'ambient-rail-monitor.workflow' ||
    raw.formatVersion !== 1 ||
    typeof identity.name !== 'string' ||
    typeof identity.revision !== 'string' ||
    typeof identity.hash !== 'string'
  )
    protocol('Invalid workflow template');
  array(definition.stages, 'template stages');
  return raw as unknown as WorkflowTemplate;
}

function settingsOf(value: unknown, local = false): QueueSettings {
  try {
    return parseQueue(value);
  } catch (error) {
    if (local) usage((error as Error).message);
    return protocol('Invalid queue settings');
  }
}

function queueOf(value: unknown): QueueState {
  const queue = record(value, 'response').queue;
  const raw = record(queue, 'queue');
  settingsOf(raw);
  if (!count(raw.active)) protocol('Invalid active queue count');
  for (const value of array(raw.workers, 'workers')) {
    const worker = record(value, 'worker');
    if (
      typeof worker.id !== 'string' ||
      typeof worker.lastHeartbeatAt !== 'string' ||
      !count(worker.active)
    )
      protocol('Invalid worker');
  }
  return raw as unknown as QueueState;
}

function ok(value: unknown): { ok: true } {
  if (record(value, 'response').ok !== true) protocol('Expected a successful response');
  return { ok: true };
}

const projectRoute = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const jobRoute = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;

export function createOperations(
  client: RailflowHttpClient,
  options: { origin?: URL | string } | URL | string = {},
) {
  const origin = parseServerOrigin(
    String(
      typeof options === 'string' || options instanceof URL
        ? options
        : (options.origin ?? DEFAULT_SERVER),
    ),
  ).origin;
  const listProjects = () =>
    client.json('GET', '/api/projects', undefined, {
      operation: 'projects.list',
      validate: projectList,
    });

  const readProject = (projectId: string, operation: string) =>
    client.json('GET', projectRoute(projectId), undefined, {
      operation,
      validate: (value) => projectOf(record(value, 'response').project, projectId),
    });

  const getProject = (projectId: string) => readProject(projectId, 'projects.get');

  const updateProject = (
    projectId: string,
    definition: ProjectDefinition,
    expectedUpdatedAt: string,
  ) => {
    if (!expectedUpdatedAt?.trim()) usage('An expected project revision is required');
    return client.json(
      'PUT',
      projectRoute(projectId),
      { ...definition, expectedUpdatedAt },
      {
        operation: 'projects.update',
        validate: (value) => projectOf(record(value, 'response').project, projectId),
      },
    );
  };

  const readJob = (jobId: string, operation: string) =>
    client.json('GET', jobRoute(jobId), undefined, {
      operation,
      jobId,
      validate(value): SequencedJob {
        const job = jobFromResponse(value, jobId);
        return { ...job, lastSequence: sequenceOf(job) };
      },
    });

  function openJobBytes(route: string, operation: string, jobId: string, opts?: StreamOptions) {
    const context = { ...opts, operation, jobId };
    return client.openBytes(route, context);
  }

  function control(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'priority', body = {}) {
    return client.json('POST', `${jobRoute(jobId)}/${action}`, body, {
      operation: `jobs.${action}`,
      jobId,
      validate: (value) => jobFromResponse(value, jobId),
    });
  }

  function readState<T>(
    operation: string,
    projectId: string | undefined,
    select: (state: Record<string, unknown>) => T,
  ) {
    const route =
      projectId === undefined
        ? '/api/state'
        : `/api/state?project=${encodeURIComponent(projectId)}`;
    return client.json('GET', route, undefined, {
      operation,
      validate: (value) => {
        const state = record(value, 'state');
        if (
          projectId !== undefined &&
          (state.project as { id?: unknown } | null | undefined)?.id !== projectId
        )
          missing(`Project not found: ${projectId}`);
        return select(state);
      },
    });
  }

  return {
    async health() {
      const started = performance.now();
      await client.json('GET', '/api/projects', undefined, {
        operation: 'health',
        validate: (value) => array(record(value, 'response').projects, 'projects'),
      });
      return { origin, latencyMs: performance.now() - started, reachable: true as const };
    },
    listProjects,
    getProject,
    createProject(input: { name: string; id?: string; template?: WorkflowTemplate }) {
      return client.json('POST', '/api/projects', input, {
        operation: 'projects.create',
        validate: (value) => projectOf(record(value, 'response').project),
      });
    },
    updateProject,
    async deleteProject(projectId: string) {
      const response = await client.json('DELETE', projectRoute(projectId), undefined, {
        operation: 'projects.delete',
        validate: ok,
      });
      return { ...response, projectId };
    },
    getWorkflow: getProject,
    setWorkflow: updateProject,
    listTemplates() {
      return client.json('GET', '/api/templates', undefined, {
        operation: 'templates.list',
        validate(value) {
          const raw = record(value, 'response');
          return {
            builtins: array(raw.builtins, 'built-in templates').map(templateOf),
            saved: array(raw.saved, 'saved templates').map(templateOf),
          };
        },
      });
    },
    exportTemplate(
      projectId: string,
      { name, revision }: { name?: string; revision?: string } = {},
    ) {
      const params = new URLSearchParams();
      if (name !== undefined) params.set('name', name);
      if (revision !== undefined) params.set('revision', revision);
      const query = params.size ? `?${params}` : '';
      return client.json('GET', `${projectRoute(projectId)}/template${query}`, undefined, {
        operation: 'templates.export',
        validate: templateOf,
      });
    },
    validateTemplate(template: unknown) {
      return client.json(
        'POST',
        '/api/templates/validate',
        { template },
        {
          operation: 'templates.validate',
          mutating: false,
          validate(value) {
            const raw = record(value, 'response');
            const validated = templateOf(raw.template);
            const preview = record(raw.preview, 'template preview');
            if (!count(preview.stages)) protocol('Invalid template stage count');
            strings(preview.kinds, 'template stage kinds');
            return {
              template: validated,
              preview: preview as unknown as TemplatePreview,
              executionDetails: executionDetails(validated.definition.stages),
            };
          },
        },
      );
    },
    saveTemplate(projectId: string, name: string, revision: string) {
      return client.json(
        'POST',
        '/api/templates',
        { projectId, name, revision },
        {
          operation: 'templates.save',
          validate: (value) => ({ template: templateOf(record(value, 'response').template) }),
        },
      );
    },
    deleteTemplate({ name, revision, hash }: WorkflowTemplate['template']) {
      return client.json(
        'DELETE',
        '/api/templates',
        { name, revision, hash },
        {
          operation: 'templates.delete',
          validate: ok,
        },
      );
    },
    listInputs(projectId: string) {
      return readState(
        'inputs.list',
        projectId,
        (state) => array(state.candidates ?? [], 'candidates') as InputCandidate[],
      );
    },
    async checkInput(
      projectId: string,
      {
        name,
        origin,
        condition,
      }: {
        name: string;
        origin?: 'project' | 'legacy';
        condition?: Condition | null;
      },
    ) {
      const operation = 'inputs.check';
      const resolved =
        condition === undefined
          ? ((await readProject(projectId, operation)).input?.condition ?? null)
          : condition;
      return client.json(
        'POST',
        `${projectRoute(projectId)}/check-input`,
        { name, origin, condition: resolved },
        {
          operation,
          mutating: false,
          validate(value) {
            const result = record(record(value, 'response').result, 'condition result');
            if (
              (result.status !== 'pass' && result.status !== 'fail' && result.status !== 'error') ||
              typeof result.label !== 'string' ||
              typeof result.message !== 'string'
            )
              protocol('Invalid condition result');
            return result as unknown as ConditionResult;
          },
        },
      );
    },
    createDemoJob(projectId: string, review?: boolean) {
      return client.json(
        'POST',
        '/api/demo',
        { projectId, review },
        {
          operation: 'demo.create',
          validate(value) {
            const job = jobFromResponse(value);
            if (job.projectId !== projectId) protocol('Unexpected demo project ID');
            return job;
          },
        },
      );
    },
    getQueue: () => readState('queue.get', undefined, queueOf),
    async setQueue(settings: QueueSettings) {
      const body = settingsOf(settings, true);
      return client.json('PUT', '/api/queue', body, {
        operation: 'queue.set',
        validate: (value) => settingsOf(record(value, 'response').queue),
      });
    },
    listJobs({ projectId, status }: { projectId?: string; status?: JobStatus } = {}) {
      return readState('jobs.list', projectId, (state) =>
        array(state.jobs, 'jobs')
          .map((job) => jobOf(job))
          .filter((job) => status === undefined || status === job.status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    },
    getJob: (jobId: string) => readJob(jobId, 'jobs.get'),
    openJobLogs: (jobId: string, opts?: StreamOptions) =>
      openJobBytes(`${jobRoute(jobId)}/logs`, 'jobs.logs', jobId, opts),
    pauseJob: (jobId: string) => control(jobId, 'pause'),
    resumeJob: (jobId: string) => control(jobId, 'resume'),
    cancelJob: (jobId: string) => control(jobId, 'cancel'),
    async setJobPriority(jobId: string, priority: number) {
      let parsed: number;
      try {
        parsed = parsePriority(priority);
      } catch (error) {
        usage((error as Error).message);
      }
      return control(jobId, 'priority', { priority: parsed });
    },
    previewRerun(jobId: string, task: string) {
      return client.json(
        'POST',
        `${jobRoute(jobId)}/rerun`,
        { task, preview: true },
        {
          operation: 'rerun.preview',
          jobId,
          mutating: false,
          validate(value): RerunPlan {
            const raw = record(value, 'response');
            return {
              rerun: strings(raw.rerun, 'rerun tasks'),
              reuse: strings(raw.reuse, 'reused tasks'),
            };
          },
        },
      );
    },
    executeRerun(jobId: string, task: string) {
      return client.json(
        'POST',
        `${jobRoute(jobId)}/rerun`,
        { task, preview: false },
        {
          operation: 'rerun.execute',
          jobId,
          mutating: true,
          validate(value) {
            const job = jobFromResponse(value);
            const plan: RerunPlan = { rerun: [], reuse: [] };
            // The server returns only the new job. Its stage completion records identify reuse.
            for (const stage of job.stages) {
              (stage.completion?.mode === 'reused' ? plan.reuse : plan.rerun).push(stage.key);
            }
            return { job, ...plan };
          },
        },
      );
    },
    openProvenance: (jobId: string) =>
      openJobBytes(`${jobRoute(jobId)}/provenance`, 'provenance.get', jobId),
    getProvenance(jobId: string) {
      return client.json('GET', `${jobRoute(jobId)}/provenance`, undefined, {
        operation: 'provenance.get',
        jobId,
        validate(value): Provenance {
          const raw = record(value, 'provenance');
          if (
            raw.format !== 'railflow.provenance' ||
            raw.formatVersion !== 1 ||
            typeof raw.exportedAt !== 'string' ||
            typeof raw.complete !== 'boolean' ||
            !count(raw.asOfSequence)
          )
            protocol('Invalid provenance');
          jobOf(raw.job, jobId);
          record(raw.metrics, 'provenance metrics');
          return raw as unknown as Provenance;
        },
      });
    },
    async listArtifacts(jobId: string) {
      return (await readJob(jobId, 'artifacts.list')).artifacts;
    },
    async openArtifact(jobId: string, name: string) {
      const operation = 'artifacts.open';
      if (
        !name ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        Array.from(name).some((ch) => {
          const code = ch.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        })
      )
        usage('Artifact name must be a single filename');
      const job = await readJob(jobId, operation);
      if (!job.artifacts.some((artifact) => artifact.name === name))
        missing(`Artifact not found: ${name}`);
      if (!/^[a-z0-9_-]+$/.test(job.projectId) || !/^run_[a-f0-9]{8}$/.test(job.id))
        protocol('Invalid artifact project or job ID');
      const route = [job.projectId, job.id, name].map(encodeURIComponent).join('/');
      return openJobBytes(`/artifacts/${route}`, operation, jobId);
    },
  };
}

export function toProjectHead({ id, name, updatedAt }: ProjectSpec): ProjectHead {
  return { id, name, updatedAt };
}

function sequenceOf(job: WorkflowJob & { lastSequence?: number }) {
  return job.lastSequence ?? job.events.at(-1)?.sequence ?? 0;
}

export function toJobHead(job: WorkflowJob & { lastSequence?: number }): JobHead {
  const { id, projectId, file, status, createdAt, parentJobId } = job;
  return { id, projectId, file, status, createdAt, parentJobId, lastSequence: sequenceOf(job) };
}

export function toStageHead({
  key,
  label,
  status,
  attempts,
  reviewSequence,
  failureKind,
}: JobStage): StageHead {
  return { key, label, status, attempts, reviewSequence, failureKind };
}

export function paginate<T>(items: readonly T[], offset: number, limit: number): ListPage<T> {
  if (!count(offset) || !count(limit) || limit === 0)
    usage('Pagination requires a non-negative integer offset and a positive integer limit');
  const page = items.slice(offset, offset + limit);
  const end = offset + page.length;
  return { items: page, total: items.length, nextOffset: end < items.length ? end : null };
}
