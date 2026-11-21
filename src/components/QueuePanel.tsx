import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AppStateResponse } from '../../shared/types.ts';
import { jsonRequest, queryClient, request } from '../api.ts';
import { validQueueValue } from '../../shared/queue.ts';
import { useI18n } from '../i18n.ts';
import { QueueNumberField } from './QueueNumberField.tsx';

export function QueuePanel({ queue }: { queue: NonNullable<AppStateResponse['queue']> }) {
  const { locale, pick } = useI18n();
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
    ['maxConcurrentJobs', pick('全体の同時ジョブ数', 'Global max concurrent jobs')],
    ['maxJobsPerWorker', pick('ワーカーあたりの同時ジョブ数', 'Max concurrent jobs per worker')],
    ['maxRecoveries', pick('ジョブの自動復旧回数', 'Max automatic recoveries')],
  ] as const;
  const invalid = fields.some(([key]) => !validQueueValue(key, settings[key]));
  return (
    <details className="wf-disclosure">
      <summary>
        {pick(
          `実行キュー：${queue.active} / ${queue.maxConcurrentJobs} ジョブ実行中`,
          `Execution queue: ${queue.active} / ${queue.maxConcurrentJobs} jobs running`,
        )}
      </summary>
      <p className="wf-help">
        {pick(
          'このサーバー全体の上限です。優先度が高いジョブから、同じ優先度は登録順に開始します。上限を下げても実行中の処理は完了まで続けます。',
          'Server-wide limits. Higher-priority jobs start first (FIFO on ties). Lowering a limit lets currently running jobs finish.',
        )}
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
          {pick('キュー設定を保存', 'Save queue settings')}
        </button>
      </fieldset>
      <p className="wf-help">
        {pick(
          'ワーカーは --concurrency=N で担当ジョブ数を指定できます。プロジェクト・サーバー・ワーカーのうち最も小さい上限が適用されます。',
          'Workers can pass --concurrency=N. The smallest limit across project, server, and worker applies.',
        )}
      </p>
      {queue.workers.map((worker) => (
        <p key={worker.id} className="wf-help">
          {worker.id} · {pick(`${worker.active} 件担当`, `${worker.active} active`)} ·{' '}
          {pick('最終応答 ', 'Last heartbeat ')}
          {new Date(worker.lastHeartbeatAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'ja-JP')}
        </p>
      ))}
      {save.isError && (
        <p role="alert" className="condition-error">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && <p role="status">{pick('保存しました。', 'Saved.')}</p>}
    </details>
  );
}
