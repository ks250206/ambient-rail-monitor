import type {
  JobStatus,
  StageKey,
  StageSpan,
  StageStatus,
  WorkflowEvent,
  WorkflowJob,
} from '../../shared/types.ts';

export type NormalizedActionStatus = 'queued' | 'running' | 'review' | 'done' | 'failed';
export type LogEventLevel = 'normal' | 'success' | 'warning' | 'error';

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  review: 'Needs review',
  done: 'Completed',
  failed: 'Failed',
};

export const ACTION_STATUS_LABELS: Record<NormalizedActionStatus, string> = {
  queued: 'Queued',
  running: 'In progress',
  review: 'Review needed',
  done: 'Success',
  failed: 'Failed',
};

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: 'Not started',
  success: 'Succeeded',
  running: 'In progress',
  retry: 'Retrying',
  failed: 'Failed',
  review: 'Human review',
};

export interface KanbanColumnDef {
  id: 'queued' | 'running' | 'review' | 'done';
  label: string;
  hint: string;
}

export const KANBAN_COLUMNS: KanbanColumnDef[] = [
  { id: 'queued', label: 'Queued', hint: '待機中のジョブはありません' },
  { id: 'running', label: 'Running', hint: '実行中のジョブはありません' },
  { id: 'review', label: 'Review / blocked', hint: '要対応のジョブはありません' },
  { id: 'done', label: 'Completed', hint: '完了したジョブはありません' },
];

export function dateMs(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

export function elapsed(startIso: string | null | undefined, endMs = Date.now()): string {
  if (!startIso) return '—';
  const sec = Math.max(0, Math.floor((endMs - dateMs(startIso)) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function axisTime(sec: number): string {
  if (sec >= 3600) return `${(sec / 3600).toFixed(sec % 3600 === 0 ? 0 : 1)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}

export function clock(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—';
}

export function clockDate(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString('ja-JP', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

export function bytes(count: number): string {
  if (count > 1_000_000) return `${(count / 1_000_000).toFixed(1)} MB`;
  if (count > 1_000) return `${(count / 1_000).toFixed(1)} KB`;
  return `${count} B`;
}

export function actionSeconds(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  if (hours) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

export function actionDuration(
  startIso: string | null | undefined,
  endIso?: string | null,
  nowMs = Date.now(),
): string {
  if (!startIso) return '—';
  const end = endIso ? dateMs(endIso) : nowMs;
  return actionSeconds((end - dateMs(startIso)) / 1000);
}

export function normalizeActionStatus(status: JobStatus | StageStatus): NormalizedActionStatus {
  if (status === 'success' || status === 'done') return 'done';
  if (status === 'pending' || status === 'queued') return 'queued';
  if (status === 'retry' || status === 'running') return 'running';
  if (status === 'review') return 'review';
  return 'failed';
}

export function actionEventLevel(event: WorkflowEvent): LogEventLevel {
  if (event.type === 'stage.failed' || event.type === 'job.failed') return 'error';
  if (event.type === 'stage.retry' || event.type === 'review.required') return 'warning';
  if (
    event.type === 'stage.succeeded' ||
    event.type === 'job.completed' ||
    event.type === 'artifact.created' ||
    event.type === 'review.approved'
  ) {
    return 'success';
  }
  return 'normal';
}

export function actionMatchesSearch(event: WorkflowEvent, query: string): boolean {
  if (!query) return true;
  return `${event.message || ''} ${event.details || ''} ${event.type} ${event.stage || ''}`
    .toLowerCase()
    .includes(query);
}

export function getSpans(job: WorkflowJob): StageSpan[] {
  const spans: StageSpan[] = [];
  for (const event of job.events) {
    if (event.type === 'stage.started' && event.stage) {
      spans.push({
        stage: event.stage,
        start: dateMs(event.at),
        end: null,
        status: 'running',
        attempt: spans.filter((span) => span.stage === event.stage).length + 1,
        events: [],
      });
    }
    if ((event.type === 'stage.succeeded' || event.type === 'stage.failed') && event.stage) {
      const span = [...spans]
        .reverse()
        .find((item) => item.stage === event.stage && item.end === null);
      if (span) {
        span.end = dateMs(event.at);
        span.status = event.type === 'stage.failed' ? 'failed' : 'success';
      }
    }
    if (event.type === 'agent.event' && event.stage) {
      const span = [...spans]
        .reverse()
        .find((item) => item.stage === event.stage && item.end === null);
      if (span) span.events.push(event);
    }
  }
  return spans;
}

export interface AttemptGroup {
  number: number;
  events: WorkflowEvent[];
  start: string;
  end: string | null;
}

export function groupStageAttempts(events: WorkflowEvent[]): AttemptGroup[] {
  const groups: AttemptGroup[] = [];
  let current: AttemptGroup | null = null;
  for (const event of events) {
    if (event.type === 'stage.started' || !current) {
      current = {
        number: groups.length + 1,
        events: [],
        start: event.at,
        end: null,
      };
      groups.push(current);
    }
    current.events.push(event);
    if (event.type === 'stage.succeeded' || event.type === 'stage.failed') {
      current.end = event.at;
    }
  }
  return groups;
}

export function pickDefaultStage(job: WorkflowJob | null): StageKey {
  if (!job) return 'ingest';
  return (
    job.stages.find(
      (stage) =>
        stage.status === 'running' ||
        stage.status === 'review' ||
        stage.status === 'retry' ||
        stage.status === 'failed',
    )?.key ||
    job.stages.find((stage) => stage.status === 'success')?.key ||
    'ingest'
  );
}
