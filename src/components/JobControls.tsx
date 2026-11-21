import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { WorkflowJob } from '../../shared/types.ts';
import { jsonRequest, queryClient, request } from '../api.ts';
import { validQueueValue } from '../../shared/queue.ts';
import { useI18n } from '../i18n.ts';
import { confirmDialog } from './DialogHost.tsx';
import { QueueNumberField } from './QueueNumberField.tsx';

export function JobControls({ job }: { job: WorkflowJob }) {
  const { pick } = useI18n();
  const [priority, setPriority] = useState(job.priority ?? 0);
  useEffect(() => {
    setPriority(job.priority ?? 0);
  }, [job.id, job.priority]);
  const action = useMutation({
    mutationFn: ({ name, data = {} }: { name: string; data?: unknown }) =>
      request(`/api/jobs/${job.id}/${name}`, jsonRequest('POST', data)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['monitor'] }),
  });
  const stopped = ['done', 'failed', 'cancelled'].includes(job.status);
  async function cancelJob() {
    const ok = await confirmDialog({
      title: pick('ジョブを中止', 'Cancel job'),
      message: pick(
        `「${job.file}」（${job.id}）を中止しますか？ 中止後はこのジョブを再開できません。`,
        `Cancel "${job.file}" (${job.id})? Cancelled jobs cannot be resumed.`,
      ),
      confirmLabel: pick('ジョブを中止する', 'Cancel job'),
      cancelLabel: pick('やめる', 'Keep running'),
      tone: 'danger',
    });
    if (ok) action.mutate({ name: 'cancel' });
  }
  return (
    <div className="job-controls">
      <div className="condition-toolbar">
        {['queued', 'running', 'review'].includes(job.status) && (
          <button
            className="wf-secondary"
            disabled={action.isPending}
            onClick={() => action.mutate({ name: 'pause' })}
          >
            {pick('一時停止', 'Pause')}
          </button>
        )}
        {job.status === 'paused' && (
          <button
            className="wf-primary"
            disabled={action.isPending}
            onClick={() => action.mutate({ name: 'resume' })}
          >
            {pick('合格済み工程から再開', 'Resume from checkpoint')}
          </button>
        )}
        {!stopped && job.status !== 'cancelling' && (
          <button
            className="wf-secondary"
            disabled={action.isPending}
            onClick={() => void cancelJob()}
          >
            {pick('ジョブを中止', 'Cancel job')}
          </button>
        )}
        {['queued', 'paused'].includes(job.status) && (
          <>
            <QueueNumberField
              field="priority"
              label={pick('優先度・数値が大きいほど先に実行', 'Priority (higher runs first)')}
              value={priority}
              onChange={setPriority}
            />
            <button
              className="wf-secondary"
              disabled={
                action.isPending ||
                !validQueueValue('priority', priority) ||
                priority === (job.priority ?? 0)
              }
              onClick={() => action.mutate({ name: 'priority', data: { priority } })}
            >
              {pick('優先度を保存', 'Save priority')}
            </button>
          </>
        )}
      </div>
      {['pausing', 'cancelling'].includes(job.status) && (
        <p role="status" className="wf-help">
          {pick(
            '実行中のプロセスの停止を待っています。この間は実行枠を保持します。',
            'Waiting for active processes to stop. The concurrency slot stays reserved in the meantime.',
          )}
        </p>
      )}
      {job.status === 'paused' && (
        <p className="wf-help">
          {pick(
            '合格済みの出力を保持しています。中断した工程は再開時に新しい試行で実行します。',
            'Accepted outputs are preserved. Interrupted stages will start a fresh attempt on resume.',
          )}
        </p>
      )}
      {!!job.recoveryCount && (
        <p className="wf-help">
          {pick(
            `ワーカーの停止から ${job.recoveryCount} 回復旧しました。詳細はログで確認できます。`,
            `Recovered ${job.recoveryCount} time(s) after worker interruption. See logs for details.`,
          )}
        </p>
      )}
      {action.isError && (
        <p role="alert" className="condition-error">
          {action.error.message}
        </p>
      )}
    </div>
  );
}
