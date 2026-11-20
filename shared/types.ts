export type StageKey = 'ingest' | 'preprocess' | 'analysis' | 'validate' | 'visualize' | 'publish';

export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'retry' | 'review';

export type JobStatus = 'queued' | 'running' | 'review' | 'done' | 'failed';

export type EventType =
  | 'job.created'
  | 'job.claimed'
  | 'stage.started'
  | 'stage.progress'
  | 'stage.succeeded'
  | 'stage.failed'
  | 'stage.retry'
  | 'review.required'
  | 'review.approved'
  | 'artifact.created'
  | 'job.completed'
  | 'job.failed'
  | 'agent.event';

export type WorkerEventType = Exclude<EventType, 'job.created' | 'job.claimed' | 'review.approved'>;

export interface StageDefinition {
  key: StageKey;
  label: string;
  short: string;
}

export interface JobStage extends StageDefinition {
  status: StageStatus;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ArtifactInfo {
  name: string;
  uri: string;
  bytes: number;
}

export interface WorkflowEvent {
  type: EventType;
  jobId: string;
  at: string;
  sequence: number;
  stage?: StageKey | null;
  message?: string;
  details?: string;
  artifact?: ArtifactInfo;
  file?: string;
  bytes?: number;
  hash?: string;
  demo?: boolean;
  needsReview?: boolean;
  agent?: string;
  worker?: string;
}

export interface WorkflowJob {
  id: string;
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
}

export interface AppStateResponse {
  jobs: WorkflowJob[];
  events: WorkflowEvent[];
  stages: StageDefinition[];
  updatedAt: string;
}

export interface ClaimPaths {
  input: string;
  work: string;
  artifacts: string;
}

export interface ClaimResponse {
  job: WorkflowJob | null;
  paths?: ClaimPaths;
}

export interface StageSpan {
  stage: StageKey;
  start: number;
  end: number | null;
  status: 'running' | 'success' | 'failed';
  attempt: number;
  events: WorkflowEvent[];
}
