import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  List,
  RotateCw,
  Search,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import { flushSync } from 'react-dom';
import { useMemo, useRef, useState } from 'react';

import type { ProjectSpec, StageKey, WorkflowJob, JobStage } from '../../shared/types.ts';
import {
  actionDuration,
  actionEventLevel,
  actionMatchesSearch,
  actionSeconds,
  clock,
  clockDate,
  dateMs,
  elapsed,
  getSpans,
  groupStageAttempts,
  pageHref,
  STAGE_STATUS_LABELS,
  STATUS_LABELS,
} from '../utils/workflow.ts';
import { DatasetDetails, StageExecutionDetails } from './ExecutionDetails.tsx';
import { WorkflowGraph } from './WorkflowGraph.tsx';
import { RerunControls } from './RerunControls.tsx';
import { JobControls } from './JobControls.tsx';
import { ConditionEvidence } from './ConditionBuilder.tsx';
import { StatusIcon, StatusPill } from './StatusBadge.tsx';

type StepDetailTab = 'summary' | 'logs';

interface ActionsSectionProps {
  selectedJob: WorkflowJob | null;
  selectedStage: StageKey;
  showAllLogs: boolean;
  project: ProjectSpec;
  nowMs: number;
  approving?: boolean;
  onSelectStage: (stage: StageKey) => void;
  onShowAllLogs: () => void;
  onApproveReview: (jobId: string, stage: JobStage) => void;
}

export function ActionsSection({
  selectedJob,
  selectedStage,
  showAllLogs,
  project,
  nowMs,
  approving = false,
  onSelectStage,
  onShowAllLogs,
  onApproveReview,
}: ActionsSectionProps) {
  const [detailTab, setDetailTab] = useState<StepDetailTab>('summary');
  const [logSearch, setLogSearch] = useState('');
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [expandedAttempts, setExpandedAttempts] = useState<Record<string, boolean>>({});

  const spans = useMemo(() => (selectedJob ? getSpans(selectedJob) : []), [selectedJob]);

  const activeStageSeconds = useMemo(
    () =>
      spans.reduce(
        (total, span) => total + Math.max(0, ((span.end || nowMs) - span.start) / 1000),
        0,
      ),
    [spans, nowMs],
  );

  const logQuery = logSearch.trim().toLowerCase();

  const stageHistory = useMemo(() => {
    if (!selectedJob) return [];
    return showAllLogs
      ? selectedJob.events
      : selectedJob.events.filter((event) => event.stage === selectedStage);
  }, [selectedJob, showAllLogs, selectedStage]);

  const filteredEvents = useMemo(
    () => stageHistory.filter((event) => actionMatchesSearch(event, logQuery)),
    [stageHistory, logQuery],
  );

  const attemptGroups = useMemo(() => {
    if (showAllLogs) return [];
    return groupStageAttempts(stageHistory);
  }, [showAllLogs, stageHistory]);

  const toggleAttempt = (key: string, currentExpanded: boolean) => {
    setExpandedAttempts((prev) => ({ ...prev, [key]: !currentExpanded }));
  };

  const completedStages = selectedJob
    ? selectedJob.stages.filter((stage) => stage.status === 'success').length
    : 0;
  const totalStages = Math.max(1, selectedJob?.stages.length || 1);

  const activeStage =
    selectedJob?.stages.find((stage) => stage.key === selectedStage) ||
    selectedJob?.stages[0] ||
    null;

  const activeStageEvents = useMemo(() => {
    if (!selectedJob || !activeStage) return [];
    return selectedJob.events.filter((event) => event.stage === activeStage.key);
  }, [selectedJob, activeStage]);

  const activeStageSpans = useMemo(() => {
    if (!activeStage) return [];
    return spans.filter((span) => span.stage === activeStage.key);
  }, [spans, activeStage]);

  const activeStageFallbackMessage = useMemo(() => {
    const relevant = activeStageEvents.filter((event) =>
      [
        'stage.failed',
        'stage.progress',
        'stage.retry',
        'stage.succeeded',
        'stage.started',
        'review.required',
        'agent.event',
      ].includes(event.type),
    );
    return relevant.at(-1)?.message || null;
  }, [activeStageEvents]);

  const executedConfig = activeStageEvents.findLast(
    (event) => event.type === 'stage.started',
  )?.stageConfig;
  const customStageInstruction = executedConfig?.instruction ?? '';
  const effectiveStageLlm = executedConfig?.llm;

  const reviewStage =
    activeStage?.status === 'review'
      ? activeStage
      : selectedJob?.stages.find((stage) => stage.status === 'review');
  const activeTab: StepDetailTab = showAllLogs ? 'logs' : detailTab;

  const detailHeading = useRef<HTMLHeadingElement>(null);
  function selectTask(key: string) {
    flushSync(() => {
      onSelectStage(key);
      setDetailTab('summary');
    });
    detailHeading.current?.focus();
  }
  const stageNumbers = useMemo(
    () => new Map(selectedJob?.stages.map((task, i) => [task.key, i + 1])),
    [selectedJob?.stages],
  );
  const attemptCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const span of spans) counts.set(span.stage, (counts.get(span.stage) ?? 0) + 1);
    return counts;
  }, [spans]);
  const taskGroups = useMemo(() => {
    const groups = new Map<string, JobStage[]>();
    for (const task of selectedJob?.stages ?? []) {
      const key = task.stageKey ?? task.key;
      const group = groups.get(key);
      if (group) group.push(task);
      else groups.set(key, [task]);
    }
    return [...groups].map(([key, tasks]) => ({
      key,
      tasks,
      label:
        selectedJob?.workflow?.project.stages.find((spec) => spec.key === key)?.label ??
        tasks[0].label,
    }));
  }, [selectedJob]);
  return (
    <section
      id="actions"
      aria-labelledby="job-detail-title"
      className="mt-8 scroll-mt-6 border-t-2 border-science-sub pt-4"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="job-detail-title" className="section-heading">
          ジョブ詳細
        </h3>
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-white">
        <div
          id="job-detail"
          tabIndex={-1}
          aria-label="選択中のジョブ"
          className="flex min-w-0 scroll-mt-6 flex-col"
        >
          {/* Run Header */}
          <div className="border-b border-line bg-white px-5 py-4">
            {!selectedJob ? (
              <div className="flex min-h-[120px] items-center justify-center text-xs text-ink-muted">
                実行履歴からジョブを選択すると、工程ごとの Summary と Logs を確認できます。
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-eyebrow">{project.name}</span>
                  <span className="font-mono text-ink-muted">{selectedJob.id}</span>
                </div>

                <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-bold text-science-blue">
                      {selectedJob.file}
                    </h3>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                      <StatusIcon status={selectedJob.status} size="sm" />
                      <span className="font-semibold text-ink">
                        {STATUS_LABELS[selectedJob.status]}
                      </span>
                      <span>·</span>
                      <span>{selectedJob.demo ? 'Manual demo' : 'File detected'}</span>
                      <span>·</span>
                      <span>{clockDate(selectedJob.createdAt)}</span>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {reviewStage && ['running', 'review'].includes(selectedJob.status) && (
                      <button
                        type="button"
                        onClick={() => selectTask(reviewStage.key)}
                        className="wf-primary"
                      >
                        「{reviewStage.label}」の出力を確認
                      </button>
                    )}
                    {selectedJob.artifacts.length > 0 && (
                      <a
                        href="#artifacts"
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-semibold text-science-blue transition-colors hover:bg-bg-1"
                      >
                        成果物を見る（{selectedJob.artifacts.length}）
                      </a>
                    )}
                    <a
                      href="#trace"
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-semibold text-eyebrow transition-colors hover:bg-bg-1 hover:text-science-blue"
                    >
                      トレース
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>

                <JobControls key={selectedJob.id} job={selectedJob} />
                <DatasetDetails job={selectedJob} />
                <WorkflowGraph
                  project={selectedJob.workflow?.project ?? project}
                  job={selectedJob}
                  onSelect={selectTask}
                />
                <RerunControls
                  key={`${selectedJob.id}-${activeStage?.key ?? selectedStage}`}
                  job={selectedJob}
                  task={activeStage?.key ?? selectedStage}
                />
                {/* Compact Run Facts */}
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3.5 sm:grid-cols-4">
                  <div>
                    <span className="font-en text-xs font-bold tracking-[0.1em] text-eyebrow uppercase">
                      Progress
                    </span>
                    <div className="mt-0.5 text-sm font-bold text-science-blue tabular-nums">
                      {completedStages}
                      <span className="font-normal text-ink-muted">
                        {' '}
                        / {selectedJob.stages.length}
                      </span>{' '}
                      <span className="text-xs font-medium text-ink-muted">
                        {selectedJob.status === 'running' ? 'Running' : 'steps'}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-11/12 overflow-hidden rounded-full bg-bg-1">
                      <div
                        className="h-full rounded-full bg-science-blue transition-all"
                        style={{
                          width: `${(completedStages / totalStages) * 100}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="sm:border-l sm:border-line sm:pl-3">
                    <span className="font-en text-xs font-bold tracking-[0.1em] text-eyebrow uppercase">
                      Run time
                    </span>
                    <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
                      {selectedJob.startedAt
                        ? actionDuration(selectedJob.startedAt, selectedJob.finishedAt, nowMs)
                        : '—'}
                    </div>
                    <p className="text-xs text-ink-muted">
                      {actionSeconds(activeStageSeconds)} stage active
                    </p>
                  </div>

                  <div className="sm:border-l sm:border-line sm:pl-3">
                    <span className="font-en text-xs font-bold tracking-[0.1em] text-eyebrow uppercase">
                      Queue wait
                    </span>
                    <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
                      {selectedJob.startedAt
                        ? actionDuration(selectedJob.createdAt, selectedJob.startedAt, nowMs)
                        : actionDuration(selectedJob.createdAt, null, nowMs)}
                    </div>
                    <p className="text-xs text-ink-muted">from file event</p>
                  </div>

                  <div className="sm:border-l sm:border-line sm:pl-3">
                    <span className="font-en text-xs font-bold tracking-[0.1em] text-eyebrow uppercase">
                      Runner
                    </span>
                    <div className="mt-0.5 truncate font-en text-sm font-bold text-science-blue">
                      {(selectedJob.agent || 'unassigned').toUpperCase()}
                    </div>
                    <p
                      className="truncate text-xs text-ink-muted"
                      title={selectedJob.worker || 'Not claimed'}
                    >
                      {selectedJob.worker || 'Not claimed'}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Actions-style Vertical Steps + Stacked Summary/Logs Area */}
          <div className="grid flex-1 grid-cols-1 @3xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.6fr)]">
            {/* Vertical Steps Tabs */}
            <div className="flex min-w-0 flex-col border-b border-line bg-bg-2/40 @3xl:border-b-0 @3xl:border-r">
              <div className="flex items-center justify-between border-b border-line bg-bg-1/70 px-3.5 py-2.5 text-xs font-bold tracking-[0.12em] text-eyebrow uppercase">
                <span className="font-en">Jobs &amp; Steps</span>
                <span className="font-mono tracking-normal text-ink-muted">
                  {selectedJob ? `${selectedJob.stages.length} steps` : ''}
                </span>
              </div>

              {!selectedJob ? (
                <div className="flex flex-1 items-center justify-center p-6 text-xs text-ink-muted">
                  ジョブを選択してください。
                </div>
              ) : (
                <div className="flex-1 divide-y divide-line/60">
                  <label className="block p-3 @3xl:hidden">
                    表示するタスク
                    <select
                      className="w-full"
                      value={showAllLogs ? '' : selectedStage}
                      onChange={(e) => selectTask(e.target.value)}
                    >
                      <option value="" disabled>
                        タスクを選択…
                      </option>
                      {taskGroups.map((group) => (
                        <optgroup key={group.key} label={group.label}>
                          {group.tasks.map((task) => (
                            <option key={task.key} value={task.key}>
                              {task.status === 'review' ? '要承認 · ' : ''}
                              {task.item?.path ?? task.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <div className="hidden @3xl:block">
                    {taskGroups.map((group) => {
                      const rows = group.tasks.map((stage) => {
                        const retryCount = attemptCounts.get(stage.key) ?? 0;
                        const active = selectedStage === stage.key && !showAllLogs;
                        const previewSummary = stage.summary || null;

                        return (
                          <button
                            key={stage.key}
                            type="button"
                            aria-pressed={active}
                            onClick={() => selectTask(stage.key)}
                            className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                              active
                                ? 'border-l-[3px] border-l-science-blue bg-white pl-2.5'
                                : 'hover:bg-bg-1/70'
                            }`}
                          >
                            <span className="pt-0.5">
                              <StatusIcon status={stage.status} size="sm" />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="flex items-baseline justify-between gap-2">
                                <strong className="font-en text-xs font-bold text-ink">
                                  <span className="mr-1 font-mono text-[11px] font-semibold text-eyebrow">
                                    {String(stageNumbers.get(stage.key)).padStart(2, '0')}
                                  </span>
                                  {stage.short}
                                </strong>
                                <span className="shrink-0 font-mono text-[11px] text-ink-muted tabular-nums">
                                  {stage.startedAt
                                    ? actionDuration(stage.startedAt, stage.endedAt, nowMs)
                                    : '—'}
                                </span>
                              </span>
                              <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                                <span className="truncate">{stage.label}</span>
                                {retryCount > 1 && (
                                  <span
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded bg-st-orange-bg px-1 py-0.5 font-mono text-[10px] font-semibold text-st-orange-dark"
                                    title={`${retryCount} attempts`}
                                  >
                                    <RotateCw className="h-2.5 w-2.5" />
                                    {retryCount}
                                  </span>
                                )}
                              </span>
                              {previewSummary && (
                                <span className="mt-0.5 line-clamp-1 text-[11px] text-ink">
                                  {previewSummary}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      });
                      return group.tasks.some((task) => task.item) ? (
                        <details key={group.key} className="wf-disclosure">
                          <summary>
                            {group.label}（{group.tasks.length}ファイル）
                          </summary>
                          {rows}
                        </details>
                      ) : (
                        rows
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    aria-pressed={showAllLogs}
                    onClick={onShowAllLogs}
                    className={`flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold transition-colors ${
                      showAllLogs
                        ? 'border-l-[3px] border-l-science-blue bg-white pl-3 text-science-blue'
                        : 'text-ink hover:bg-bg-1/70'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <List className="h-3.5 w-3.5 text-eyebrow" />
                      All run events
                    </span>
                    <span className="rounded bg-bg-1 px-1.5 py-0.5 font-mono text-xs text-science-blue">
                      {selectedJob.events.length}
                    </span>
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2 border-t border-line bg-bg-2 px-3 py-2 text-xs text-ink-muted">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-science-sub" />
                <span>Worker events, not inferred agent progress</span>
              </div>
            </div>

            {/* Right column: Single unified grid area switching between Summary and Logs */}
            <div className="flex min-w-0 flex-col bg-white text-ink">
              {/* Unified header with Summary / Logs tabs */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bg-1 px-3.5 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  {selectedJob && !showAllLogs && activeStage ? (
                    <div
                      role="tablist"
                      aria-label="Summary と Logs の切り替え"
                      className="inline-flex rounded-md border border-line bg-white p-0.5"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'summary'}
                        onClick={() => setDetailTab('summary')}
                        className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-en text-xs font-bold transition-colors ${
                          activeTab === 'summary'
                            ? 'bg-science-blue text-white'
                            : 'text-ink-muted hover:text-science-blue'
                        }`}
                      >
                        <FileText className="h-3.5 w-3.5" />
                        <span>Summary</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'logs'}
                        onClick={() => setDetailTab('logs')}
                        className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-en text-xs font-bold transition-colors ${
                          activeTab === 'logs'
                            ? 'bg-science-blue text-white'
                            : 'text-ink-muted hover:text-science-blue'
                        }`}
                      >
                        <Terminal className="h-3.5 w-3.5" />
                        <span>Logs</span>
                        <span
                          className={`rounded px-1 font-mono text-[10px] ${
                            activeTab === 'logs'
                              ? 'bg-white/20 text-white'
                              : 'bg-bg-1 text-science-blue'
                          }`}
                        >
                          {stageHistory.length}
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <Terminal className="h-3.5 w-3.5 shrink-0 text-science-blue" />
                      <strong className="truncate font-en text-sm font-semibold text-science-blue">
                        {selectedJob ? 'All run logs' : 'Summary & Logs'}
                      </strong>
                    </div>
                  )}
                </div>

                {selectedJob ? (
                  <a
                    href={`/api/jobs/${encodeURIComponent(selectedJob.id)}/logs`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-science-blue bg-white px-2.5 py-1 text-xs font-semibold text-science-blue transition-colors hover:bg-bg-2"
                    title="Download this run's logs"
                  >
                    <Download className="h-3 w-3" />
                    Logs
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted">
                    <Download className="h-3 w-3" />
                    Logs
                  </span>
                )}
              </div>

              {/* Stacked panel body */}
              {activeTab === 'summary' && selectedJob && activeStage ? (
                <div className="flex min-h-[340px] flex-1 flex-col justify-between p-4">
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h3
                          ref={detailHeading}
                          tabIndex={-1}
                          className="text-sm font-bold text-science-blue"
                        >
                          {activeStage.label}
                        </h3>
                        <span className="font-mono text-xs text-ink-muted">
                          {activeStage.short} / {activeStage.key}
                        </span>
                      </div>
                      <StatusPill
                        status={activeStage.status}
                        label={STAGE_STATUS_LABELS[activeStage.status]}
                      />
                    </div>

                    {/* Result Summary Box */}
                    <div className="mt-3 rounded-md border border-line bg-navy-50/70 p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-eyebrow">
                          <FileText className="h-3.5 w-3.5" />
                          <span>結果の概要</span>
                        </div>
                        {effectiveStageLlm &&
                          (effectiveStageLlm.model || effectiveStageLlm.effort) && (
                            <span className="rounded border border-line bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-science-blue">
                              LLM: {effectiveStageLlm.model || 'CLI既定'}
                              {effectiveStageLlm.effort
                                ? ` · effort=${effectiveStageLlm.effort}`
                                : ''}
                            </span>
                          )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink">
                        {activeStage.summary ||
                          activeStageFallbackMessage ||
                          'この工程はまだ開始していません。完了すると LLM が要約した結果の概要がここに表示されます。'}
                      </p>
                    </div>

                    {/* Compact Step Execution Facts */}
                    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      <div className="rounded border border-line bg-bg-2/50 px-2.5 py-2">
                        <dt className="text-[11px] text-ink-muted">試行回数</dt>
                        <dd className="mt-0.5 font-mono text-xs font-bold text-ink">
                          {activeStage.attempts}
                        </dd>
                      </div>
                      <div className="rounded border border-line bg-bg-2/50 px-2.5 py-2">
                        <dt className="text-[11px] text-ink-muted">経過時間</dt>
                        <dd className="mt-0.5 font-mono text-xs font-bold text-ink tabular-nums">
                          {activeStage.startedAt
                            ? elapsed(
                                activeStage.startedAt,
                                activeStage.endedAt ? dateMs(activeStage.endedAt) : nowMs,
                              )
                            : '—'}
                        </dd>
                      </div>
                      <div className="rounded border border-line bg-bg-2/50 px-2.5 py-2">
                        <dt className="text-[11px] text-ink-muted">開始時刻</dt>
                        <dd className="mt-0.5 font-mono text-xs font-bold text-ink tabular-nums">
                          {clock(activeStage.startedAt)}
                        </dd>
                      </div>
                      <div className="rounded border border-line bg-bg-2/50 px-2.5 py-2">
                        <dt className="text-[11px] text-ink-muted">失敗試行</dt>
                        <dd className="mt-0.5 font-mono text-xs font-bold text-ink">
                          {activeStageSpans.filter((span) => span.status === 'failed').length}
                        </dd>
                      </div>
                      <div className="rounded border border-line bg-bg-2/50 px-2.5 py-2">
                        <dt className="text-[11px] text-ink-muted">エージェント出力</dt>
                        <dd className="mt-0.5 font-mono text-xs font-bold text-ink">
                          {activeStageEvents.filter((event) => event.type === 'agent.event').length}
                        </dd>
                      </div>
                    </dl>

                    <StageExecutionDetails
                      job={selectedJob}
                      stage={activeStage}
                      nowMs={nowMs}
                      approving={approving}
                      onApprove={() => onApproveReview(selectedJob.id, activeStage)}
                    />
                    {/* Custom instruction preview */}
                    {customStageInstruction && (
                      <div className="mt-3 flex items-start justify-between gap-3 rounded-md border border-dashed border-science-sub bg-bg-2/40 px-3 py-2.5">
                        <div className="min-w-0">
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-science-blue">
                            <SlidersHorizontal className="h-3 w-3" />
                            この工程のカスタム指示
                          </span>
                          <p className="mt-0.5 whitespace-pre-wrap text-xs text-ink-muted">
                            {customStageInstruction}
                          </p>
                        </div>
                        <a
                          href={pageHref('/workflow', project.id)}
                          className="shrink-0 text-xs font-semibold text-eyebrow underline hover:text-science-blue"
                        >
                          定義ページで編集
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-line pt-2.5 text-xs text-ink-muted">
                    <span>詳細ログは「Logs」タブから確認できます</span>
                    <button
                      type="button"
                      onClick={() => setDetailTab('logs')}
                      className="font-en font-semibold text-eyebrow underline hover:text-science-blue"
                    >
                      Logs ({stageHistory.length})
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bg-2 px-3.5 py-2 text-xs text-ink-muted">
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={showTimestamps}
                        onChange={(event) => setShowTimestamps(event.target.checked)}
                        className="h-3.5 w-3.5 accent-science-blue"
                      />
                      <span>Timestamps</span>
                    </label>

                    <label className="flex min-h-8 w-48 max-w-full items-center gap-1.5 rounded-md border border-ink-muted bg-white px-2 focus-within:outline-2 focus-within:outline-science-blue">
                      <Search className="h-3 w-3 text-ink-muted" />
                      <input
                        type="search"
                        value={logSearch}
                        onChange={(event) => setLogSearch(event.target.value)}
                        placeholder="Filter log lines"
                        aria-label="Filter step logs"
                        className="w-full min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-muted"
                      />
                    </label>
                  </div>

                  <div
                    role="region"
                    aria-label="Step log output"
                    className="max-h-[400px] min-h-[300px] flex-1 overflow-y-auto py-2.5 font-mono text-xs"
                  >
                    {!selectedJob ? (
                      <div className="px-4 py-10 text-center font-sans text-xs text-ink-muted">
                        ジョブが実行されるとログが表示されます。
                      </div>
                    ) : filteredEvents.length === 0 ? (
                      <div className="px-4 py-10 text-center font-sans text-xs text-ink-muted">
                        {logQuery
                          ? 'No log lines match your filter.'
                          : 'No log entries yet. Events will appear as the agent progresses.'}
                      </div>
                    ) : showAllLogs ? (
                      <div className="space-y-0.5">
                        {filteredEvents.map((event) => (
                          <LogLineRow
                            key={event.sequence}
                            event={event}
                            showTimestamps={showTimestamps}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-2 px-2">
                        {attemptGroups.map((group, index) => {
                          const matching = group.events.filter((event) =>
                            actionMatchesSearch(event, logQuery),
                          );
                          if (matching.length === 0) return null;
                          const key = `${selectedJob.id}:${selectedStage}:${group.number}`;
                          const defaultExpanded = index === attemptGroups.length - 1;
                          const expanded = logQuery
                            ? true
                            : key in expandedAttempts
                              ? expandedAttempts[key]
                              : defaultExpanded;
                          const failed = group.events.some(
                            (event) => event.type === 'stage.failed',
                          );

                          return (
                            <div
                              key={key}
                              className="overflow-hidden rounded-md border border-line"
                            >
                              <button
                                type="button"
                                aria-expanded={expanded}
                                onClick={() => toggleAttempt(key, expanded)}
                                className="flex w-full items-center gap-2 bg-bg-2 px-3 py-2 text-left text-xs text-ink hover:bg-bg-1"
                              >
                                {expanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 text-ink-muted" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 text-ink-muted" />
                                )}
                                <span className="font-semibold">
                                  Attempt {String(group.number).padStart(2, '0')}
                                </span>
                                {failed && (
                                  <span className="rounded bg-st-red-bg px-1.5 py-0.5 text-xs font-bold text-st-red-dark">
                                    FAILED
                                  </span>
                                )}
                                <span className="ml-auto text-xs text-ink-muted tabular-nums">
                                  {group.end ? actionDuration(group.start, group.end, nowMs) : '—'}
                                </span>
                              </button>

                              {expanded && (
                                <div className="divide-y divide-bg-1 py-1">
                                  {matching.map((event) => (
                                    <LogLineRow
                                      key={event.sequence}
                                      event={event}
                                      showTimestamps={showTimestamps}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="flex items-center justify-between gap-2 border-t border-line bg-bg-2 px-3.5 py-2 text-xs text-ink-muted">
                <span>
                  {selectedJob
                    ? `${filteredEvents.length} / ${stageHistory.length} events`
                    : 'No events'}
                </span>
                {selectedJob && (
                  <span className="inline-flex items-center gap-1.5">
                    <span>{selectedJob.agent || 'awaiting worker'}</span>
                    <span>·</span>
                    <span
                      className={`h-2 w-2 rounded-full ${
                        selectedJob.status === 'running' ? 'bg-st-green' : 'border border-navy-300'
                      }`}
                    />
                    <span>{selectedJob.status === 'running' ? 'Streaming' : 'Saved history'}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface LogLineRowProps {
  event: WorkflowJob['events'][number];
  showTimestamps: boolean;
}

function LogLineRow({ event, showTimestamps }: LogLineRowProps) {
  const level = actionEventLevel(event);
  const rowTone =
    level === 'error'
      ? 'border-l-st-red bg-st-red-bg'
      : level === 'warning'
        ? 'border-l-st-orange bg-st-orange-bg'
        : 'border-l-transparent';

  const markTone =
    level === 'error'
      ? 'text-st-red-dark'
      : level === 'warning'
        ? 'text-st-orange-dark'
        : level === 'success'
          ? 'text-st-green-dark'
          : 'text-ink-muted';

  const mark =
    level === 'error' ? '✗' : level === 'warning' ? '!' : level === 'success' ? '✓' : '›';

  return (
    <div
      className={`grid gap-2 border-l-2 px-3 py-1 text-xs leading-relaxed text-ink ${rowTone} ${
        showTimestamps ? 'grid-cols-[8ch_14px_minmax(0,1fr)]' : 'grid-cols-[14px_minmax(0,1fr)]'
      }`}
    >
      {showTimestamps && (
        <span className="whitespace-nowrap text-xs text-ink-muted tabular-nums">
          {clock(event.at)}
        </span>
      )}
      <span className={`text-center font-bold ${markTone}`}>{mark}</span>
      <div className="min-w-0 break-words whitespace-pre-wrap">
        {event.stage && <span className="mr-1.5 text-ink-muted">[{event.stage}]</span>}
        <span className="text-ink">{event.message || event.type}</span>
        {event.summary && (
          <div className="mt-1 rounded bg-navy-50 px-2 py-1 font-sans text-xs text-science-blue">
            概要: {event.summary}
          </div>
        )}
        {event.gate && <ConditionEvidence result={event.gate.result} />}
        {event.details && (
          <pre className="mt-1.5 border-l-2 border-line pl-2.5 text-xs whitespace-pre-wrap text-ink-muted">
            {event.details}
          </pre>
        )}
      </div>
    </div>
  );
}
