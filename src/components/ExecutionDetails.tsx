import { useQuery } from '@tanstack/react-query';
import { resolveExecution, RETRY_LABELS } from '../../shared/execution-policy.ts';
import type { JobStage, WorkflowJob } from '../../shared/types.ts';
import { request } from '../api.ts';
import { ConditionEvidence } from './ConditionBuilder.tsx';

export function DatasetDetails({ job }: { job: WorkflowJob }) {
  return (
    <div className="dataset-details">
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
  const spec = job.workflow?.project.stages.find((item) => item.key === stage.key);
  const config = job.events.findLast(
    (event) => event.stage === stage.key && event.type === 'stage.started',
  )?.stageConfig;
  const policy =
    config?.execution ?? resolveExecution(job.workflow?.project.execution, spec?.execution);
  const budget = (ms: number) => (ms ? `${ms / 1000}秒` : '無制限');
  return (
    <div className="stage-execution-details">
      <div className="execution-facts">
        <span>
          試行 {stage.attempts} / {policy.maxRetries + 1} 回（追加リトライ {policy.maxRetries} 回）
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
          <h4>{gate.scope === 'stage' ? '工程の受け入れ判定' : '最終成果物の受け入れ判定'}</h4>
          <ConditionEvidence result={gate.result} />
        </div>
      ))}
      {stage.status === 'review' && stage.workspace && stage.reviewSequence !== undefined && (
        <ReviewOutputs job={job} stage={stage} />
      )}
      {config?.prompt && (
        <details>
          <summary>この試行で送信したプロンプト</summary>
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
      request<{ files: Array<{ path: string; bytes: number }> }>(`/api/jobs/${job.id}/review`, {
        signal,
      }),
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
                href={`/api/jobs/${job.id}/review/file?${new URLSearchParams({ path: file.path, sequence: String(stage.reviewSequence) })}`}
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
