import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { WorkflowJob } from '../../shared/types.ts';
import { jsonRequest, queryClient, request } from '../api.ts';
import { NumberValue } from './NumberValue.tsx';

export function JobControls({ job }: { job: WorkflowJob }) {
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
  return (
    <div className="job-controls">
      <div className="condition-toolbar">
        {['queued', 'running', 'review'].includes(job.status) && (
          <button
            className="wf-secondary"
            disabled={action.isPending}
            onClick={() => action.mutate({ name: 'pause' })}
          >
            一時停止
          </button>
        )}
        {job.status === 'paused' && (
          <button
            className="wf-primary"
            disabled={action.isPending}
            onClick={() => action.mutate({ name: 'resume' })}
          >
            合格済み工程から再開
          </button>
        )}
        {!stopped && job.status !== 'cancelling' && (
          <button
            className="wf-secondary"
            disabled={action.isPending}
            onClick={() => action.mutate({ name: 'cancel' })}
          >
            キャンセル
          </button>
        )}
        {['queued', 'paused'].includes(job.status) && (
          <>
            <label>
              優先度（大きい順）
              <NumberValue value={priority} integer onChange={setPriority} />
            </label>
            <button
              className="wf-secondary"
              disabled={
                action.isPending || !Number.isInteger(priority) || priority === (job.priority ?? 0)
              }
              onClick={() => action.mutate({ name: 'priority', data: { priority } })}
            >
              優先度を保存
            </button>
          </>
        )}
      </div>
      {['pausing', 'cancelling'].includes(job.status) && (
        <p role="status" className="wf-help">
          実行中のプロセスの停止を待っています。この間は実行枠を保持します。
        </p>
      )}
      {job.status === 'paused' && (
        <p className="wf-help">
          合格済みの出力を保持しています。中断した工程は再開時に新しい試行で実行します。
        </p>
      )}
      {!!job.recoveryCount && (
        <p className="wf-help">
          ワーカーの停止から {job.recoveryCount} 回復旧しました。詳細はログで確認できます。
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
