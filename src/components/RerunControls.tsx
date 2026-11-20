import { useMutation } from '@tanstack/react-query';
import type { WorkflowJob } from '../../shared/types.ts';
import { jsonRequest, request } from '../api.ts';
import { monitorJobHref } from '../utils/workflow.ts';

export function RerunControls({ job, task }: { job: WorkflowJob; task: string }) {
  const preview = useMutation({
    mutationFn: () =>
      request<{ rerun: string[]; reuse: string[] }>(
        `/api/jobs/${job.id}/rerun`,
        jsonRequest('POST', { task, preview: true }),
      ),
  });
  const run = useMutation({
    mutationFn: () =>
      request<{ job: WorkflowJob }>(`/api/jobs/${job.id}/rerun`, jsonRequest('POST', { task })),
    onSuccess: ({ job: next }) => window.location.assign(monitorJobHref(next.projectId, next.id)),
  });
  if (
    job.workflow?.version !== 2 ||
    !['done', 'failed', 'cancelled', 'paused', 'review'].includes(job.status)
  )
    return null;
  const labels = (keys: string[]) =>
    keys.map((key) => job.stages.find((item) => item.key === key)?.label ?? key).join('、') ||
    'なし';
  return (
    <details className="wf-disclosure">
      <summary>このタスクから再実行</summary>
      <p className="wf-help">
        元の入力・定義を使って新しいジョブを作成します。選択タスクと後続をやり直し、他の合格済み出力はハッシュを検証して引き継ぎます。
      </p>
      <button
        type="button"
        className="wf-secondary"
        disabled={preview.isPending}
        onClick={() => preview.mutate()}
      >
        実行範囲を確認
      </button>
      {preview.data && (
        <>
          <p>再実行：{labels(preview.data.rerun)}</p>
          <p>再利用：{labels(preview.data.reuse)}</p>
          <button
            type="button"
            className="wf-primary"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            新しいジョブで再実行
          </button>
        </>
      )}
      {(preview.isError || run.isError) && (
        <p role="alert" className="condition-error">
          {preview.error?.message ?? run.error?.message}
        </p>
      )}
    </details>
  );
}
