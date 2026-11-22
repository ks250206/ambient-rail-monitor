import { RunMetrics, RuntimeDetails } from './RunMetrics.tsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { resolveExecution, RETRY_LABELS } from '../../shared/execution-policy.ts';
import type { JobStage, WorkflowJob } from '../../shared/types.ts';
import { useI18n } from '../i18n.ts';
import { monitorJobHref } from '../utils/workflow.ts';
import { useEffect, useState } from 'react';
import { QcReviewPanel } from './QcReviewPanel.tsx';
import { QC_FILENAME } from '../../shared/qc.ts';
import {
  ApiError,
  fetchReviewQc,
  request,
  type ReviewApproval,
  type InspectedOutput,
} from '../api.ts';
import { ConditionEvidence } from './ConditionBuilder.tsx';

const RETRY_LABELS_EN: Record<string, string> = {
  execution_error: 'Execution error',
  timeout: 'Attempt timeout',
  acceptance_failed: 'Acceptance check failed',
  stage_timeout: 'Stage timeout',
  job_timeout: 'Job timeout',
  interrupted: 'Worker interrupted',
};

export function DatasetDetails({ job }: { job: WorkflowJob }) {
  const { pick } = useI18n();
  return (
    <div className="dataset-details">
      <RunMetrics job={job} />
      {job.parentJobId && (
        <p className="wf-help">
          {pick('再実行元: ', 'Rerun of: ')}
          <a href={monitorJobHref(job.projectId, job.parentJobId)}>{job.parentJobId}</a>
        </p>
      )}
      {job.dataset && (
        <details>
          <summary>
            {pick(
              `登録時の入力：${job.dataset.files.length} ファイル・${(job.dataset.bytes / 1024 / 1024).toFixed(2)} MB`,
              `Registered input: ${job.dataset.files.length} files · ${(job.dataset.bytes / 1024 / 1024).toFixed(2)} MB`,
            )}
          </summary>
          <ul className="upload-file-list">
            {job.dataset.files.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>
                <small>
                  {file.bytes.toLocaleString()} bytes · {file.hash.slice(0, 12)}
                </small>
              </li>
            ))}
          </ul>
          <p className="wf-help">
            {pick('入力 SHA-256: ', 'Input SHA-256: ')}
            <code>{job.dataset.hash}</code>
          </p>
        </details>
      )}
      <p className="wf-help">
        {job.workflow ? (
          <>
            {pick('登録時の定義を固定して実行 · ', 'Frozen workflow definition · ')}
            <code>{job.workflow.hash.slice(0, 12)}</code> · {job.workflow.project.name}
          </>
        ) : (
          pick(
            '旧形式のジョブ：登録時の設定スナップショットはありません。',
            'Legacy job: no workflow snapshot recorded at submission.',
          )
        )}
      </p>
    </div>
  );
}

export function StageExecutionDetails({
  job,
  stage,
  nowMs,
  approving,
  onApprove,
}: {
  job: WorkflowJob;
  stage: JobStage;
  nowMs: number;
  approving: boolean;
  onApprove: (target: ReviewApproval) => Promise<unknown> | void;
}) {
  const { locale, pick } = useI18n();
  const spec = job.workflow?.project.stages.find(
    (item) => item.key === (stage.stageKey ?? stage.key),
  );
  const config = job.events.findLast(
    (event) => event.stage === stage.key && event.type === 'stage.started',
  )?.stageConfig;
  const policy =
    config?.execution ?? resolveExecution(job.workflow?.project.execution, spec?.execution);
  const budget = (ms: number) =>
    ms ? pick(`${ms / 1000}秒`, `${ms / 1000}s`) : pick('無制限', 'Unlimited');
  const activeSeconds = Math.round(
    ((stage.activeMs ?? 0) +
      (stage.status === 'running' && stage.startedAt
        ? Math.max(0, nowMs - Date.parse(stage.startedAt))
        : 0)) /
      1000,
  );
  return (
    <div className="stage-execution-details">
      {stage.item && (
        <p>
          {pick('対象ファイル：', 'Target file: ')}
          <strong>{stage.item.path}</strong>
        </p>
      )}
      {(stage.completion?.mode === 'reused' || stage.completion?.mode === 'cached') && (
        <p>
          {stage.completion.mode === 'cached'
            ? pick('キャッシュで実行を省略。元ジョブ ', 'Restored from cache. Source job ')
            : pick('チェックポイントを再利用。元ジョブ ', 'Reused checkpoint. Source job ')}
          <a href={monitorJobHref(job.projectId, stage.completion.jobId!)}>
            {stage.completion.jobId}
          </a>
          {stage.completion.task ? ` (${stage.completion.task})` : ''}
          {pick(
            ` の試行 ${stage.completion.attempt} を再利用しました。`,
            ` attempt ${stage.completion.attempt}.`,
          )}
        </p>
      )}
      {stage.cache && <p className="wf-help">{stage.cache.reason}</p>}
      <RuntimeDetails job={job} stage={stage} />
      {stage.output && (
        <details>
          <summary>
            {pick(
              `確定した出力（${stage.output.files.length}件）· ${stage.output.hash.slice(0, 12)}`,
              `Verified outputs (${stage.output.files.length}) · ${stage.output.hash.slice(0, 12)}`,
            )}
          </summary>
          <ul className="upload-file-list">
            {stage.output.files.map((file) => (
              <li key={file.path}>
                {file.path}
                <small>
                  {file.bytes} bytes · {file.hash.slice(0, 12)}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="execution-facts">
        <span>
          {pick(
            `試行 ${stage.attempts} 回 · リトライ ${stage.retryCount ?? 0} / ${policy.maxRetries} 回`,
            `Attempts ${stage.attempts} · Retries ${stage.retryCount ?? 0} / ${policy.maxRetries}`,
          )}
        </span>
        <span>
          {pick('1回の上限 ', 'Attempt limit ')}
          {budget(policy.attemptTimeoutMs)}
        </span>
        <span>
          {pick('工程の上限 ', 'Stage limit ')}
          {budget(policy.stageTimeoutMs)}
        </span>
        <span>
          {pick('ジョブの上限 ', 'Job limit ')}
          {budget(job.workflow?.project.jobTimeoutMs ?? 0)}
        </span>
        <span>{pick(`累計実行 ${activeSeconds} 秒`, `Active ${activeSeconds}s`)}</span>
      </div>
      <span role="status" className="sr-only">
        {stage.status === 'retry'
          ? pick('再試行を待っています。', 'Waiting to retry.')
          : stage.status === 'running'
            ? pick('試行を実行中です。', 'Attempt in progress.')
            : ''}
      </span>
      {stage.status === 'running' && stage.deadlineAt && (
        <p role="timer">
          {pick(
            `この試行の残り時間：約 ${Math.max(0, Math.ceil((Date.parse(stage.deadlineAt) - nowMs) / 1000))} 秒`,
            `Attempt time left: ~${Math.max(0, Math.ceil((Date.parse(stage.deadlineAt) - nowMs) / 1000))}s`,
          )}
        </p>
      )}
      {stage.status === 'retry' && stage.retryAt && (
        <p role="timer">
          {pick(
            `次の試行まで：約 ${Math.max(0, Math.ceil((Date.parse(stage.retryAt) - nowMs) / 1000))} 秒`,
            `Next retry in: ~${Math.max(0, Math.ceil((Date.parse(stage.retryAt) - nowMs) / 1000))}s`,
          )}
        </p>
      )}
      {stage.failureKind && (
        <p className="condition-error">
          {pick('失敗の種類：', 'Failure kind: ')}
          {locale === 'en'
            ? (RETRY_LABELS_EN[stage.failureKind] ?? stage.failureKind)
            : stage.failureKind in RETRY_LABELS
              ? RETRY_LABELS[stage.failureKind as keyof typeof RETRY_LABELS]
              : stage.failureKind}
        </p>
      )}
      {stage.approvedAttempt !== undefined && (
        <p>
          {pick(
            `試行 ${stage.approvedAttempt} の出力を人間が承認済み`,
            `Attempt ${stage.approvedAttempt} output approved by human review`,
          )}
          {stage.failureKind
            ? pick('（自動判定の失敗は下記に保持）', ' (failed automated checks retained below)')
            : ''}
        </p>
      )}
      {spec?.acceptanceCriteria && (
        <details>
          <summary>{pick('この工程の受け入れ要件', 'Stage acceptance requirements')}</summary>
          <p className="whitespace-pre-wrap">{spec.acceptanceCriteria}</p>
        </details>
      )}
      {stage.gates?.map((gate) => (
        <div key={gate.scope}>
          <h4>
            {
              {
                input: pick('入力契約', 'Input contracts'),
                output: pick('出力契約', 'Output contracts'),
                stage: pick('工程の受け入れ判定', 'Stage acceptance gate'),
                final: pick('最終成果物の受け入れ判定', 'Final publication gate'),
              }[gate.scope]
            }
          </h4>
          <ConditionEvidence result={gate.result} />
        </div>
      ))}
      {(job.status === 'review' ||
        job.status === 'running' ||
        (job.workflow?.version === 2 && job.status === 'queued')) &&
        stage.status === 'review' && (
          <ReviewOutputs
            key={JSON.stringify([job.id, stage.key, stage.reviewSequence])}
            job={job}
            stage={stage}
            approving={approving}
            onApprove={onApprove}
          />
        )}
      {config?.prompt && (
        <details>
          <summary>
            {!spec?.runner || spec.runner.kind === 'ai'
              ? pick('この試行で送信したプロンプト', 'Prompt sent for this attempt')
              : pick('この試行の指示と入力', 'Instructions and inputs for this attempt')}
          </summary>
          <pre className="prompt-preview">{config.prompt}</pre>
        </details>
      )}
    </div>
  );
}

function ReviewOutputs({
  job,
  stage,
  approving,
  onApprove,
}: {
  job: WorkflowJob;
  stage: JobStage;
  approving: boolean;
  onApprove: (target: ReviewApproval) => Promise<unknown> | void;
}) {
  const { pick } = useI18n();
  const client = useQueryClient();
  const [recheck, setRecheck] = useState(false);
  const [inspection, setInspection] = useState(0);
  const hasInventory = Boolean(stage.workspace && stage.reviewSequence !== undefined);
  const query = useQuery({
    queryKey: ['review-outputs', job.id, stage.key, stage.reviewSequence],
    enabled: hasInventory,
    gcTime: 0,
    retry: false,
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      request<InspectedOutput>(`/api/jobs/${job.id}/review?task=${encodeURIComponent(stage.key)}`, {
        signal,
      }),
  });
  const data = query.data;
  const current =
    hasInventory &&
    !recheck &&
    query.isSuccess &&
    !query.isFetching &&
    data !== undefined &&
    data.stageKey === stage.key &&
    data.attempt === stage.attempts &&
    data.reviewSequence === stage.reviewSequence &&
    (data.failureKind === null ||
      (typeof data.failureKind === 'string' && data.failureKind.length > 0)) &&
    Array.isArray(data.files);
  const showQc = current && job.workflow?.version === 2 && stage.key === 'qc';
  const qcFile = showQc ? stage.output?.files.find((file) => file.path === QC_FILENAME) : undefined;
  const currentQc = useQuery({
    queryKey: ['review-qc', job.id, stage.key, stage.reviewSequence, inspection],
    enabled: !!qcFile,
    retry: false,
    queryFn: ({ signal }) =>
      fetchReviewQc(job.id, stage.key, data!.reviewSequence, qcFile!.bytes, signal),
  });
  const qcChanged =
    !!qcFile && currentQc.error instanceof ApiError && currentQc.error.status === 409;
  const checkingQc = !!qcFile && (currentQc.isPending || currentQc.isFetching);
  useEffect(() => {
    if (qcChanged) setRecheck(true);
  }, [qcChanged]);
  const receipt = data?.receipt;
  const exact = current && typeof receipt === 'string' && receipt.trim().length > 0;
  const legacy = !job.workflow && (!hasInventory || (current && data.receipt === null));
  const failureKind = current ? data.failureKind : stage.failureKind;
  async function reload() {
    setRecheck(true);
    await Promise.all([
      query.refetch(),
      client.invalidateQueries({ queryKey: ['monitor', job.projectId] }),
    ]);
    setInspection((i) => i + 1);
    setRecheck(false);
  }
  async function approve() {
    const coords = {
      jobId: job.id,
      stage: stage.key,
      attempt: stage.attempts,
      reviewSequence: stage.reviewSequence,
    };
    try {
      if (exact)
        await onApprove({
          mode: 'exact',
          jobId: job.id,
          stage: data.stageKey,
          attempt: data.attempt,
          reviewSequence: data.reviewSequence,
          receipt,
          exception: data.failureKind !== null,
        });
      else if (legacy) await onApprove({ mode: 'legacy', ...coords });
    } catch {
      if (hasInventory) setRecheck(true);
    }
  }
  return (
    <div className="review-outputs">
      <h4>{pick('承認前の出力を確認', 'Review outputs before approval')}</h4>
      <p className="wf-help">
        {pick(
          `工程 ${stage.label}・試行 ${stage.attempts} の出力です。`,
          `Outputs from stage ${stage.label}, attempt ${stage.attempts}. `,
        )}
        {failureKind
          ? pick(
              '自動処理が失敗しています。例外承認すると、この試行の出力を採用して続行します。',
              'Automated checks failed. Exception approval accepts this attempt output and continues.',
            )
          : pick(
              'この工程を承認すると、後続工程または成果物の公開へ進みます。',
              'Approving advances to downstream stages or report publication.',
            )}
      </p>
      <p>
        {pick('対象：', 'Target: ')}
        {stage.item?.path ?? job.file}
      </p>
      {failureKind && (
        <p className="condition-error">
          {pick('失敗理由：', 'Failure reason: ')}
          {job.events.findLast(
            (event) =>
              event.stage === stage.key &&
              event.attempt === stage.attempts &&
              event.type === 'stage.failed',
          )?.message ||
            (current ? data.summary : stage.summary) ||
            failureKind}
        </p>
      )}
      {!hasInventory && (
        <p>
          {legacy
            ? pick(
                '旧形式のジョブには出力一覧の記録がありません。工程のログを確認してください。',
                'Legacy jobs have no recorded output inventory. Check the stage logs.',
              )
            : pick(
                'この試行の出力一覧を確認できません。',
                'Unable to inspect the output inventory for this attempt.',
              )}
        </p>
      )}
      {hasInventory && query.isPending && (
        <p role="status">{pick('出力を読み込み中…', 'Loading outputs…')}</p>
      )}
      {hasInventory &&
        (recheck ||
          query.isError ||
          (query.isSuccess && !query.isFetching && (!current || (!legacy && !exact)))) && (
          <p role="alert">
            {query.error?.message ??
              pick(
                '出力を再取得し、承認対象を確認してください。',
                'Reload the outputs and inspect the review target again.',
              )}{' '}
            <button className="wf-secondary" onClick={() => void reload()}>
              {pick('出力を再取得', 'Reload outputs')}
            </button>
          </p>
        )}
      {showQc && (
        <QcReviewPanel
          key={inspection}
          job={job}
          inspection={inspection}
          review={data}
          onReload={reload}
          current={currentQc}
          hasFile={!!qcFile}
        />
      )}
      {current && query.data.files.length === 0 && (
        <p>{pick('この試行に出力ファイルはありません。', 'No output files in this attempt.')}</p>
      )}
      {current && query.data.files.length > 0 && (
        <ul className="upload-file-list">
          {query.data.files.map((file) => (
            <li key={file.path}>
              <a
                target="_blank"
                rel="noreferrer"
                href={`/api/jobs/${job.id}/review/file?${new URLSearchParams({ path: file.path, sequence: String(stage.reviewSequence), task: stage.key })}`}
              >
                {file.path}
              </a>
              <small>{file.bytes.toLocaleString()} bytes</small>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="wf-primary"
        disabled={approving || recheck || checkingQc || qcChanged || (!exact && !legacy)}
        onClick={() => void approve()}
      >
        {approving
          ? pick('承認中…', 'Approving…')
          : failureKind
            ? pick('この試行の出力を例外承認して続行', 'Exception-approve this output & continue')
            : pick('この工程を承認して続行', 'Approve stage & continue')}
      </button>
    </div>
  );
}
