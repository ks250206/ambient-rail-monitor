import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AppStateResponse } from '../../shared/types.ts';
import { jsonRequest, queryClient, request } from '../api.ts';
import { validQueueValue } from '../../shared/queue.ts';
import { QueueNumberField } from './QueueNumberField.tsx';

export function QueuePanel({ queue }: { queue: NonNullable<AppStateResponse['queue']> }) {
  const [settings, setSettings] = useState({
    maxConcurrentJobs: queue.maxConcurrentJobs,
    maxJobsPerWorker: queue.maxJobsPerWorker,
    maxRecoveries: queue.maxRecoveries,
  });
  useEffect(() => {
    setSettings({
      maxConcurrentJobs: queue.maxConcurrentJobs,
      maxJobsPerWorker: queue.maxJobsPerWorker,
      maxRecoveries: queue.maxRecoveries,
    });
  }, [queue.maxConcurrentJobs, queue.maxJobsPerWorker, queue.maxRecoveries]);
  const save = useMutation({
    mutationFn: () => request('/api/queue', jsonRequest('PUT', settings)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['monitor'] }),
  });
  const fields = [
    ['maxConcurrentJobs', '全体の同時ジョブ数'],
    ['maxJobsPerWorker', 'ワーカーあたりの同時ジョブ数'],
    ['maxRecoveries', 'ジョブの自動復旧回数'],
  ] as const;
  const invalid = fields.some(([key]) => !validQueueValue(key, settings[key]));
  return (
    <details className="wf-disclosure">
      <summary>
        実行キュー：{queue.active} / {queue.maxConcurrentJobs} ジョブ実行中
      </summary>
      <p className="wf-help">
        このサーバー全体の上限です。優先度が高いジョブから、同じ優先度は登録順に開始します。上限を下げても実行中の処理は完了まで続けます。
      </p>
      <fieldset disabled={save.isPending} className="wf-fields">
        {fields.map(([key, label]) => (
          <QueueNumberField
            key={key}
            field={key}
            label={label}
            value={settings[key]}
            onChange={(next) => {
              save.reset();
              setSettings({ ...settings, [key]: next });
            }}
          />
        ))}
        <button className="wf-secondary" disabled={invalid} onClick={() => save.mutate()}>
          キュー設定を保存
        </button>
      </fieldset>
      <p className="wf-help">
        ワーカーは --concurrency=N
        で担当ジョブ数を指定できます。プロジェクト・サーバー・ワーカーのうち最も小さい上限が適用されます。
      </p>
      {queue.workers.map((worker) => (
        <p key={worker.id} className="wf-help">
          {worker.id} · {worker.active} 件担当 · 最終応答{' '}
          {new Date(worker.lastHeartbeatAt).toLocaleTimeString('ja-JP')}
        </p>
      ))}
      {save.isError && (
        <p role="alert" className="condition-error">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && <p role="status">保存しました。</p>}
    </details>
  );
}
