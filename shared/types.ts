import type { Condition, ConditionResult } from './conditions.ts';
import type { ExecutionPolicy, FailureKind } from './execution-policy.ts';
import type { QueueSettings } from './queue.ts';
import type { CachePolicy, RuntimeProfile, RuntimeSnapshot, PriceRate } from './reuse.ts';
import type { UsageRecord } from './usage.ts';
import type { StageGraph, GraphSpec, PlannedTask } from './graph.ts';

export type StageKey = string;

export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'retry' | 'review';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled';

export type ReasoningEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmConfig {
  model: string;
  effort: ReasoningEffort;
}

export type EventType =
  | 'job.created'
  | 'job.claimed'
  | 'job.pause.requested'
  | 'job.cancel.requested'
  | 'job.paused'
  | 'job.cancelled'
  | 'job.resumed'
  | 'job.recovered'
  | 'job.priority'
  | 'stage.interrupted'
  | 'stage.started'
  | 'stage.executed'
  | 'stage.environment'
  | 'stage.usage'
  | 'stage.cache'
  | 'gate.evaluated'
  | 'stage.progress'
  | 'stage.succeeded'
  | 'stage.failed'
  | 'stage.retry'
  | 'stage.retry.ready'
  | 'stage.retry.paused'
  | 'stage.retry.resumed'
  | 'job.waiting'
  | 'stage.reused'
  | 'review.required'
  | 'review.approved'
  | 'artifact.created'
  | 'job.completed'
  | 'job.failed'
  | 'agent.event';

export type WorkerEventType = Exclude<
  EventType,
  | 'job.created'
  | 'job.claimed'
  | 'review.approved'
  | 'job.pause.requested'
  | 'job.cancel.requested'
  | 'job.paused'
  | 'job.cancelled'
  | 'job.resumed'
  | 'job.recovered'
  | 'job.priority'
  | 'stage.interrupted'
  | 'stage.retry.paused'
  | 'stage.reused'
  | 'stage.cache'
>;

export interface StageDefinition {
  key: StageKey;
  label: string;
  short: string;
}

export interface WorkflowStageSpec extends StageDefinition, StageGraph {
  cache?: CachePolicy;
  instruction: string;
  llm: LlmConfig;
  acceptanceCriteria?: string;
  gate?: GateSpec;
  execution?: Partial<ExecutionPolicy>;
}

export interface GateSpec {
  condition: Condition | null;
  requireReview: boolean;
}

export interface InputSpec {
  mode: 'auto' | 'file' | 'directory';
  settleMs: number;
  condition: Condition | null;
}

export interface DatasetFile {
  path: string;
  bytes: number;
  hash: string;
}

export interface DatasetManifest {
  version: 1;
  name: string;
  kind: 'file' | 'directory';
  files: DatasetFile[];
  hash: string;
  bytes: number;
  source: string;
}

export interface WorkflowSnapshot {
  version: 1 | 2;
  hash: string;
  project: ProjectSpec;
  plan?: PlannedTask[];
}

export interface GateEvaluation {
  scope: 'stage' | 'final' | 'input' | 'output';
  result: ConditionResult;
}

export interface InputCandidate {
  origin: 'project' | 'legacy';
  name: string;
  kind: 'file' | 'directory';
  fileCount: number;
  bytes: number;
  status: 'waiting' | 'registered' | 'error';
  message: string;
  result?: ConditionResult;
}

export interface ProjectSpec {
  id: string;
  name: string;
  purpose: string;
  acceptanceCriteria: string;
  llm: LlmConfig;
  stages: WorkflowStageSpec[];
  inboxDir: string;
  artifactsDir: string;
  createdAt: string;
  updatedAt: string;
  input?: InputSpec;
  execution?: ExecutionPolicy;
  jobTimeoutMs?: number;
  finalGate?: GateSpec;
  prompt?: string;
  queue?: { maxConcurrentJobs: number; priority: number };
  graph?: GraphSpec;
  runtime?: RuntimeProfile;
  pricing?: PriceRate[];
  templateOrigin?: { name: string; revision: string; hash: string };
}

export interface JobStage extends StageDefinition {
  stageKey?: string;
  dependsOn?: string[];
  item?: { path: string; hash: string };
  output?: OutputManifest;
  runtime?: RuntimeSnapshot;
  cache?: { hit: boolean; reason: string; key?: string };
  completion?: {
    mode: 'executed' | 'reused' | 'cached';
    jobId?: string;
    task?: string;
    attempt?: number;
  };
  status: StageStatus;
  attempts: number;
  retryCount?: number;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  activeMs?: number;
  workspace?: string;
  gates?: GateEvaluation[];
  approvedAttempt?: number;
  reviewSequence?: number;
  failureKind?: FailureKind;
  retryAt?: string;
  retryRemainingMs?: number;
  deadlineAt?: string;
}

export interface ArtifactInfo {
  name: string;
  uri: string;
  bytes: number;
}

export interface OutputManifest {
  hash: string;
  files: Array<DatasetFile & { executable: boolean }>;
}

export interface WorkflowEvent {
  type: EventType;
  jobId: string;
  projectId?: string;
  at: string;
  sequence: number;
  stage?: StageKey | null;
  message?: string;
  summary?: string;
  details?: string;
  stageConfig?: {
    instruction: string;
    llm: LlmConfig;
    acceptanceCriteria?: string;
    execution?: ExecutionPolicy;
    gate?: GateSpec;
    prompt?: string;
  };
  artifact?: ArtifactInfo;
  file?: string;
  bytes?: number;
  hash?: string;
  demo?: boolean;
  needsReview?: boolean;
  stages?: StageDefinition[];
  agent?: string;
  worker?: string;
  dataset?: DatasetManifest;
  workflow?: WorkflowSnapshot;
  priority?: number;
  recoveryCount?: number;
  attempt?: number;
  elapsedMs?: number;
  workspace?: string;
  gate?: GateEvaluation;
  failureKind?: FailureKind;
  retryAt?: string;
  retryRemainingMs?: number;
  deadlineAt?: string;
  reviewSequence?: number;
  output?: OutputManifest;
  completion?: JobStage['completion'];
  parentJobId?: string;
  jobElapsedMs?: number;
  runtime?: RuntimeSnapshot;
  usage?: UsageRecord;
  cache?: JobStage['cache'];
}

export interface WorkflowJob {
  id: string;
  projectId: string;
  file: string;
  bytes: number;
  hash: string;
  createdAt: string;
  demo: boolean;
  needsReview: boolean;
  status: JobStatus;
  agent: string | null;
  worker: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stages: JobStage[];
  artifacts: ArtifactInfo[];
  events: WorkflowEvent[];
  reviewApproved: boolean;
  lastMessage: string;
  priority?: number;
  recoveryCount?: number;
  parentJobId?: string;
  activeMs?: number;
  dataset?: DatasetManifest;
  workflow?: WorkflowSnapshot;
}

export interface AppStateResponse {
  projects: ProjectSpec[];
  project: ProjectSpec;
  jobs: WorkflowJob[];
  events: WorkflowEvent[];
  stages: StageDefinition[];
  updatedAt: string;
  candidates?: InputCandidate[];
  queue?: QueueSettings & {
    active: number;
    workers: Array<{ id: string; active: number; lastHeartbeatAt: string }>;
  };
}

export interface ClaimPaths {
  input: string;
  work: string;
  artifacts: string;
  inputDir?: string;
  manifest?: string;
}

export interface ClaimResponse {
  job: WorkflowJob | null;
  paths?: ClaimPaths;
  project?: ProjectSpec;
  lease?: { token: string; expiresAt: string; heartbeatMs: number; ttlMs: number };
}

export interface StageSpan {
  stage: StageKey;
  start: number;
  end: number | null;
  status: 'running' | 'success' | 'failed';
  attempt: number;
  events: WorkflowEvent[];
}
