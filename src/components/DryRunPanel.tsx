import { useMutation } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { DryRunResult, WorkflowJob } from '../../shared/types.ts';
import { jsonRequest, request } from '../api.ts';
import { useI18n } from '../i18n.ts';
import { DryRunTriggerEvidence } from './DryRunTriggerEvidence.tsx';
import { CustomSelect } from './CustomSelect.tsx';
import type { WorkflowUpdatePayload } from './WorkflowSpecSection.tsx';

interface DraftProps {
  projectId: string;
  draft: WorkflowUpdatePayload;
  valid: boolean;
}

export function DryRunPanel({ jobs, ...props }: DraftProps & { jobs: WorkflowJob[] }) {
  const { pick } = useI18n();
  const [selected, select] = useState('');
  const sources = jobs.filter((job) => job.projectId === props.projectId && job.dataset);
  const sourceJobId = sources.some((job) => job.id === selected) ? selected : '';
  return (
    <details className="wf-disclosure">
      <summary>
        {pick('固定入力で Dry Run', 'Dry run with frozen input')} <ChevronDown size={17} />
      </summary>
      <p className="wf-help">
        {pick(
          '編集中の定義を選んだジョブの固定入力に当てて、投入前のタスクと承認箇所を確認できます。',
          'Preview tasks and review points for the current draft using the selected job’s frozen input.',
        )}
      </p>
      <div className="wf-fields">
        <label>
          {pick('入力元のジョブ', 'Source job')}
          <CustomSelect
            ariaLabel={pick('入力元のジョブ', 'Source job')}
            value={sourceJobId}
            onChange={select}
            disabled={!sources.length}
            placeholder={
              sources.length
                ? pick('ジョブを選択…', 'Select a job…')
                : pick('固定入力のあるジョブがありません', 'No jobs with frozen input')
            }
            options={sources.map((job) => ({ value: job.id, label: `${job.id} · ${job.file}` }))}
          />
        </label>
      </div>
      {/* A changed input or draft gets a fresh mutation observer, even after switching back. */}
      <DryRunRequest
        key={JSON.stringify([props.projectId, sourceJobId, props.draft, props.valid])}
        {...props}
        sourceJobId={sourceJobId}
      />
    </details>
  );
}

function DryRunRequest({
  projectId,
  draft,
  valid,
  sourceJobId,
}: DraftProps & { sourceJobId: string }) {
  const { pick } = useI18n();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const guideId = useId();
  const showGuide = Boolean(sourceJobId) && !valid;
  const preview = useMutation({
    mutationFn: (signal: AbortSignal) =>
      request<DryRunResult>(`/api/projects/${encodeURIComponent(projectId)}/dry-run`, {
        ...jsonRequest('POST', { sourceJobId, draft }),
        signal,
      }),
  });
  return (
    <>
      <button
        type="button"
        className="wf-secondary"
        disabled={!sourceJobId || !valid || preview.isPending}
        aria-describedby={showGuide ? guideId : undefined}
        onClick={() => {
          controller.current?.abort();
          controller.current = new AbortController();
          preview.mutate(controller.current.signal);
        }}
      >
        {preview.isPending
          ? pick('計画を確認中…', 'Checking plan…')
          : pick('実行計画を確認', 'Preview task plan')}
      </button>
      {showGuide && (
        <p id={guideId} className="wf-help">
          {pick(
            '下書きのエラーを修正すると、実行計画を確認できます。',
            'Fix the errors in the draft to preview the task plan.',
          )}
        </p>
      )}
      {preview.isError && (
        <p role="alert" className="condition-error">
          {preview.error.message}
        </p>
      )}
      {preview.data && <PlanDetails result={preview.data} />}
    </>
  );
}

function PlanDetails({ result }: { result: DryRunResult }) {
  const { pick } = useI18n();
  const { tasks, reviewTaskKeys, runtimeRequirements: runtime, trigger } = result;
  const title = {
    pass: pick('起動条件を満たしています', 'Trigger passed'),
    fail: pick('起動条件未達', 'Trigger not met'),
    error: pick('起動条件の評価エラー', 'Trigger evaluation error'),
    unknown: pick('起動条件は未確定', 'Trigger unknown'),
  }[trigger.status];
  const requirements = [
    ...(runtime.revision
      ? [pick(`環境の版 ${runtime.revision}`, `Revision ${runtime.revision}`)]
      : []),
    ...(runtime.python ? [`Python · ${runtime.python}`] : []),
    ...Object.entries(runtime.expected).map(([tool, version]) => `${tool} = ${version}`),
    ...Object.entries(runtime.packages).map(([name, version]) => `${name} == ${version}`),
  ];
  return (
    <section className="break-words" aria-label={pick('Dry Run の結果', 'Dry run result')}>
      <div className={`condition-evidence evidence-${trigger.status}`}>
        <div>
          <strong>{title}</strong>
        </div>
        <DryRunTriggerEvidence trigger={trigger} />
      </div>
      <p>
        {pick(`固定入力 ${result.sourceJobId}`, `Frozen input ${result.sourceJobId}`)} · SHA-256{' '}
        <code className="break-all">{result.datasetHash}</code>
      </p>
      <p>
        {pick(
          `全 ${result.taskCount} タスク · 並列上限 ${result.maxParallelTasks} · 公開工程 ${result.publishStage} · 承認候補 ${reviewTaskKeys.length} 件`,
          `${result.taskCount} tasks · Parallel limit ${result.maxParallelTasks} · Publish stage ${result.publishStage} · ${reviewTaskKeys.length} review candidates`,
        )}
      </p>
      <p>
        {pick('実行環境の要件', 'Runtime requirements')} ·{' '}
        {requirements.join(', ') || pick('指定なし', 'None specified')}
      </p>
      <p className="wf-help">
        {pick(
          'ワーカーの実環境、上流出力を使うゲート、キャッシュの有無は実行時に判定します。',
          'The worker environment, gates that depend on upstream output, and cache availability are checked at runtime.',
        )}
      </p>
      {Array.from(
        Map.groupBy(tasks, (task) => task.stageKey),
        ([stageKey, group]) => (
          <details key={stageKey} className="wf-disclosure" open>
            <summary>
              {stageKey} ·{' '}
              {group[0].item
                ? pick(`Map ${group.length} 件`, `Map items: ${group.length}`)
                : group[0].label}
            </summary>
            <ul>
              {group.map((task) => (
                <li key={task.key}>
                  <code>{task.key}</code>
                  {task.item && <> · {task.item.path}</>}
                  {reviewTaskKeys.includes(task.key) && (
                    <strong> · {pick('承認候補', 'Review candidate')}</strong>
                  )}
                  <p className="wf-help">
                    {pick('依存タスク', 'Depends on')} ·{' '}
                    {task.dependsOn.join(', ') || pick('なし', 'None')}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ),
      )}
    </section>
  );
}
