import { useQuery } from '@tanstack/react-query';
import { resolveExecution, RETRY_LABELS } from '../../shared/execution-policy.ts';
import type { JobStage, WorkflowJob } from '../../shared/types.ts';
import { monitorJobHref } from '../utils/workflow.ts';
import { request } from '../api.ts';
import { ConditionEvidence } from './ConditionBuilder.tsx';

export function DatasetDetails({ job }: { job: WorkflowJob }) {
  return (
    <div className="dataset-details">
      {job.parentJobId && (
        <p className="wf-help">
          再実行元: <a href={monitorJobHref(job.projectId, job.parentJobId)}>{job.parentJobId}</a>
        </p>
      )}
      {job.dataset && (
        <details>
          <summary>
            登録時の入力：{job.dataset.files.length} ファイル・
            {(job.dataset.bytes / 1024 / 1024).toFixed(2)} MB
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
            入力 SHA-256: <code>{job.dataset.hash}</code>
          </p>
        </details>
      )}
      <p className="wf-help">
        {job.workflow ? (
          <>
            登録時の定義を固定して実行 · <code>{job.workflow.hash.slice(0, 12)}</code> ·{' '}
            {job.workflow.project.name}
          </>
        ) : (
          '旧形式のジョブ：登録時の設定スナップショットはありません。'
        )}
      </p>
    </div>
  );
}

export function StageExecutionDetails({
  job,
  stage,
  nowMs,
}: {
  job: WorkflowJob;
  stage: JobStage;
  nowMs: number;
}) {
  const spec = job.workflow?.project.stages.find(
    (item) => item.key === (stage.stageKey ?? stage.key),
  );
  const config = job.events.findLast(
    (event) => event.stage === stage.key && event.type === 'stage.started',
  )?.stageConfig;
  const policy =
    config?.execution ?? resolveExecution(job.workflow?.project.execution, spec?.execution);
  const budget = (ms: number) => (ms ? `${ms / 1000}秒` : '無制限');
  return (
    <div className="stage-execution-details">
      {stage.item && (
        <p>
          対象ファイル：<strong>{stage.item.path}</strong>
        </p>
      )}
      {stage.completion?.mode === 'reused' && (
        <p>
          元ジョブ{' '}
          <a href={monitorJobHref(job.projectId, stage.completion.jobId!)}>
            {stage.completion.jobId}
          </a>{' '}
          の試行 {stage.completion.attempt} を再利用しました。
        </p>
      )}
      {stage.output && (
        <details>
          <summary>
            確定した出力（{stage.output.files.length}件）· {stage.output.hash.slice(0, 12)}
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
          試行 {stage.attempts} 回 · リトライ {stage.retryCount ?? 0} / {policy.maxRetries} 回
        </span>
        <span>1回の上限 {budget(policy.attemptTimeoutMs)}</span>
        <span>工程の上限 {budget(policy.stageTimeoutMs)}</span>
        <span>ジョブの上限 {budget(job.workflow?.project.jobTimeoutMs ?? 0)}</span>
        <span>
          累計実行{' '}
          {Math.round(
            ((stage.activeMs ?? 0) +
              (stage.status === 'running' && stage.startedAt
                ? Math.max(0, nowMs - Date.parse(stage.startedAt))
                : 0)) /
              1000,
          )}{' '}
          秒
        </span>
      </div>
      <span role="status" className="sr-only">
        {stage.status === 'retry'
          ? '再試行を待っています。'
          : stage.status === 'running'
            ? '試行を実行中です。'
            : ''}
      </span>
      {stage.status === 'running' && stage.deadlineAt && (
        <p role="timer">
          この試行の残り時間：約{' '}
          {Math.max(0, Math.ceil((Date.parse(stage.deadlineAt) - nowMs) / 1000))} 秒
        </p>
      )}
      {stage.status === 'retry' && stage.retryAt && (
        <p role="timer">
          次の試行まで：約 {Math.max(0, Math.ceil((Date.parse(stage.retryAt) - nowMs) / 1000))} 秒
        </p>
      )}
      {stage.failureKind && (
        <p className="condition-error">
          失敗の種類：
          {stage.failureKind in RETRY_LABELS
            ? RETRY_LABELS[stage.failureKind as keyof typeof RETRY_LABELS]
            : stage.failureKind}
        </p>
      )}
      {stage.approvedAttempt !== undefined && (
        <p>
          試行 {stage.approvedAttempt} の出力を人間が承認済み
          {stage.failureKind ? '（自動判定の失敗は下記に保持）' : ''}
        </p>
      )}
      {spec?.acceptanceCriteria && (
        <details>
          <summary>この工程の受け入れ要件</summary>
          <p className="whitespace-pre-wrap">{spec.acceptanceCriteria}</p>
        </details>
      )}
      {stage.gates?.map((gate) => (
        <div key={gate.scope}>
          <h4>
            {
              {
                input: '入力契約',
                output: '出力契約',
                stage: '工程の受け入れ判定',
                final: '最終成果物の受け入れ判定',
              }[gate.scope]
            }
          </h4>
          <ConditionEvidence result={gate.result} />
        </div>
      ))}
      {job.status === 'review' &&
        stage.status === 'review' &&
        stage.workspace &&
        stage.reviewSequence !== undefined && <ReviewOutputs job={job} stage={stage} />}
      {config?.prompt && (
        <details>
          <summary>
            {!spec?.runner || spec.runner.kind === 'ai'
              ? 'この試行で送信したプロンプト'
              : 'この試行の指示と入力'}
          </summary>
          <pre className="prompt-preview">{config.prompt}</pre>
        </details>
      )}
    </div>
  );
}

function ReviewOutputs({ job, stage }: { job: WorkflowJob; stage: JobStage }) {
  const query = useQuery({
    queryKey: ['review-outputs', job.id, stage.reviewSequence],
    queryFn: ({ signal }) =>
      request<{ files: Array<{ path: string; bytes: number }> }>(
        `/api/jobs/${job.id}/review?task=${encodeURIComponent(stage.key)}`,
        {
          signal,
        },
      ),
  });
  return (
    <div className="review-outputs">
      <h4>承認前の出力を確認</h4>
      <p className="wf-help">
        工程 {stage.label}・試行 {stage.attempts} の出力です。
        {stage.failureKind
          ? '自動処理が失敗しています。例外承認すると、この試行の出力を採用して続行します。'
          : 'この工程を承認すると、後続工程または成果物の公開へ進みます。'}
      </p>
      {query.isPending && <p role="status">出力を読み込み中…</p>}
      {query.isError && <p className="condition-error">{query.error.message}</p>}
      {query.data && (
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
    </div>
  );
}
