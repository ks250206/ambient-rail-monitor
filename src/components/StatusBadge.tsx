import { AlertCircle, Check, Circle, Loader2, X } from 'lucide-react';

import type { JobStatus, StageStatus } from '../../shared/types.ts';
import {
  ACTION_STATUS_LABELS,
  normalizeActionStatus,
  STATUS_LABELS,
  type NormalizedActionStatus,
} from '../utils/workflow.ts';

interface StatusIconProps {
  status: JobStatus | StageStatus;
  size?: 'sm' | 'md';
}

const ICON_TONE: Record<NormalizedActionStatus, string> = {
  done: 'border-st-green bg-st-green-bg text-st-green-dark',
  running: 'border-navy-700 bg-navy-100 text-science-blue',
  review: 'border-st-orange bg-st-orange-bg text-st-orange-dark',
  failed: 'border-st-red bg-st-red-bg text-st-red-dark',
  queued: 'border-navy-300 bg-bg-2 text-ink-muted',
};

export function StatusIcon({ status, size = 'md' }: StatusIconProps) {
  const state = normalizeActionStatus(status);
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const iconSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full border ${dim} ${ICON_TONE[state]}`}
      aria-label={ACTION_STATUS_LABELS[state]}
      title={ACTION_STATUS_LABELS[state]}
    >
      {state === 'done' && <Check className={iconSize} strokeWidth={2.75} />}
      {state === 'running' && <Loader2 className={`${iconSize} animate-spin`} strokeWidth={2.5} />}
      {state === 'review' && <AlertCircle className={iconSize} strokeWidth={2.5} />}
      {state === 'failed' && <X className={iconSize} strokeWidth={2.75} />}
      {state === 'queued' && <Circle className={iconSize} strokeWidth={2.25} />}
    </span>
  );
}

interface StatusPillProps {
  status: JobStatus | StageStatus;
  label?: string;
}

const PILL_TONE: Record<NormalizedActionStatus, string> = {
  done: 'border-st-green/40 bg-st-green-bg text-st-green-dark',
  running: 'border-navy-700/35 bg-navy-100 text-science-blue',
  review: 'border-st-orange/45 bg-st-orange-bg text-st-orange-dark',
  failed: 'border-st-red/40 bg-st-red-bg text-st-red-dark',
  queued: 'border-line bg-bg-2 text-ink-muted',
};

export function StatusPill({ status, label }: StatusPillProps) {
  const state = normalizeActionStatus(status);
  const text =
    label ||
    (status in STATUS_LABELS ? STATUS_LABELS[status as JobStatus] : ACTION_STATUS_LABELS[state]);

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold ${PILL_TONE[state]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === 'done'
            ? 'bg-st-green'
            : state === 'running'
              ? 'bg-navy-700 animate-st-pulse'
              : state === 'review'
                ? 'bg-st-orange'
                : state === 'failed'
                  ? 'bg-st-red'
                  : 'bg-ink-muted'
        }`}
      />
      {text}
    </span>
  );
}
