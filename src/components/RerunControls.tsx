import { useMutation } from '@tanstack/react-query';
import type { WorkflowJob } from '../../shared/types.ts';
import { jsonRequest, request } from '../api.ts';
import { useI18n } from '../i18n.ts';
import { navigateWithTransition } from '../utils/navigation.ts';
import { monitorJobHref } from '../utils/workflow.ts';

export function RerunControls({ job, task }: { job: WorkflowJob; task: string }) {
  const { locale, pick } = useI18n();
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
    onSuccess: ({ job: next }) => navigateWithTransition(monitorJobHref(next.projectId, next.id)),
  });
  if (
    job.workflow?.version !== 2 ||
    !['done', 'failed', 'cancelled', 'paused', 'review'].includes(job.status)
  )
    return null;
  const sep = locale === 'en' ? ', ' : '、';
  const labels = (keys: string[]) =>
    keys.map((key) => job.stages.find((item) => item.key === key)?.label ?? key).join(sep) ||
    pick('なし', 'None');
  const targetLabel = job.stages.find((item) => item.key === task)?.label ?? task;
  return (
    <details className="wf-disclosure">
      <summary>{pick(`「${targetLabel}」から再実行`, `Rerun from "${targetLabel}"`)}</summary>
      <p className="wf-help">
        {pick(
          '元の入力・定義を使って新しいジョブを作成します。選択タスクと後続をやり直し、他の合格済み出力はハッシュを検証して引き継ぎます。',
          'Creates a new job using the original inputs and definition. Selected and downstream tasks re-execute while other accepted outputs are hash-verified and reused.',
        )}
      </p>
      <button
        type="button"
        className="wf-secondary"
        disabled={preview.isPending}
        onClick={() => preview.mutate()}
      >
        {pick('実行範囲を確認', 'Preview scope')}
      </button>
      {preview.data && (
        <>
          <p>
            {pick('再実行：', 'Rerun: ')}
            {labels(preview.data.rerun)}
          </p>
          <p>
            {pick('再利用：', 'Reuse: ')}
            {labels(preview.data.reuse)}
          </p>
          <button
            type="button"
            className="wf-primary"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {pick('新しいジョブで再実行', 'Start rerun job')}
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
