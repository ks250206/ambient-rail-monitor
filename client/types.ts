import type { ConditionResult } from '../shared/conditions.ts';
import type { DatasetFile, JobStage, ProjectSpec, WorkflowJob } from '../shared/types.ts';

export interface ClientOptions {
  origin: URL;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}

export type RailflowErrorKind =
  | 'usage'
  | 'transport'
  | 'timeout'
  | 'http'
  | 'protocol'
  | 'limit'
  | 'interrupted'
  | 'outcome_unknown';

export interface RailflowErrorData {
  kind: RailflowErrorKind;
  message: string;
  status?: number;
  result?: ConditionResult;
  operation?: string;
  uploadId?: string;
  jobId?: string;
}

export class RailflowError extends Error {
  readonly data: RailflowErrorData;

  constructor(data: RailflowErrorData) {
    super(data.message);
    this.name = 'RailflowError';
    this.data = data;
  }

  get kind() {
    return this.data.kind;
  }
  get status() {
    return this.data.status;
  }
  get result() {
    return this.data.result;
  }
  get operation() {
    return this.data.operation;
  }
  get uploadId() {
    return this.data.uploadId;
  }
  get jobId() {
    return this.data.jobId;
  }

  toJSON(): RailflowErrorData {
    return { ...this.data };
  }
}

export interface ReviewRef {
  jobId: string;
  stageKey: string;
  attempt: number;
  reviewSequence: number;
}

export interface ResolvedConfig {
  origin: URL;
  projectId?: string;
  requestTimeoutMs: number;
}

export type ProjectHead = Pick<ProjectSpec, 'id' | 'name' | 'updatedAt'>;

export interface JobHead extends Pick<
  WorkflowJob,
  'id' | 'projectId' | 'file' | 'status' | 'createdAt' | 'parentJobId'
> {
  lastSequence: number;
}

export type StageHead = Pick<
  JobStage,
  'key' | 'label' | 'status' | 'attempts' | 'reviewSequence' | 'failureKind'
>;

export type FileHead = Pick<DatasetFile, 'path' | 'bytes'>;

export interface TextWindow {
  text: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  truncated: boolean;
}

export interface BinaryInfo {
  binary: true;
  mimeType: string;
  bytes: number | null;
}

export interface ListPage<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}
