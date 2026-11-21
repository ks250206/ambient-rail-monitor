import { usageSummary } from '../../shared/usage.ts';
import type { WorkflowJob, JobStage } from '../../shared/types.ts';
import { useState } from 'react';
import { useProjectJobs } from '../api.ts';

function outputComparison(current?: JobStage, other?: JobStage) {
  if (!current) return '対象タスクなし（今回）';
  if (!other) return '対象タスクなし（比較先）';
  if (!current.output && !other.output) return '両方未確定';
  if (!current.output) return '今回のみ未確定';
  if (!other.output) return '比較先のみ未確定';
  return current.output.hash === other.output.hash ? '一致' : '異なる';
}

function RunComparison({ job }: { job: WorkflowJob }) {
  const jobs = useProjectJobs(job.projectId).data?.jobs ?? [];
  const [selected, setSelected] = useState('');
  const other = jobs.find((item) => item.id === selected && item.id !== job.id);
  const cost = (run: WorkflowJob) => {
    const metrics = usageSummary(run);
    return metrics.estimatedCostUsd === null
      ? '推定額なし'
      : `$${metrics.estimatedCostUsd.toFixed(6)}（料金不明 ${metrics.unpricedAttempts} 試行${metrics.partialAttempts ? ` / 一部のみ ${metrics.partialAttempts} 試行` : ''}）`;
  };
  const currentTasks = new Map(job.stages.map((task) => [task.key, task]));
  const otherTasks = new Map(other?.stages.map((task) => [task.key, task]));
  const keys = new Set([...currentTasks.keys(), ...otherTasks.keys()]);
  return (
    <details className="run-comparison">
      <summary>同じプロジェクトの実行結果と比較</summary>
      <label>
        比較するジョブ
        <select value={other?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
          <option value="">選択してください</option>
          {jobs
            .filter((item) => item.id !== job.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.file} · {item.status}
              </option>
            ))}
        </select>
      </label>
      {other && (
        <>
          <table className="runtime-table">
            <thead>
              <tr>
                <th>項目</th>
                <th>今回 {job.id}</th>
                <th>比較 {other.id}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>状態</td>
                <td>{job.status}</td>
                <td>{other.status}</td>
              </tr>
              <tr>
                <td>入力hash</td>
                <td>{job.dataset?.hash.slice(0, 12) ?? '未記録'}</td>
                <td>{other.dataset?.hash.slice(0, 12) ?? '未記録'}</td>
              </tr>
              <tr>
                <td>定義hash</td>
                <td>{job.workflow?.hash.slice(0, 12) ?? '未記録'}</td>
                <td>{other.workflow?.hash.slice(0, 12) ?? '未記録'}</td>
              </tr>
              <tr>
                <td>累計稼働時間</td>
                <td>
                  {job.activeMs === undefined ? '未記録' : `${(job.activeMs / 1000).toFixed(2)}秒`}
                </td>
                <td>
                  {other.activeMs === undefined
                    ? '未記録'
                    : `${(other.activeMs / 1000).toFixed(2)}秒`}
                </td>
              </tr>
              <tr>
                <td>設定単価の推定額</td>
                <td>{cost(job)}</td>
                <td>{cost(other)}</td>
              </tr>
            </tbody>
          </table>
          <p className="wf-help">
            出力の一致はファイル内容のhashで判定します。内容の科学的な妥当性は各ジョブのレポート・判定記録で確認してください。
          </p>
          <div className="comparison-outputs">
            <table className="runtime-table">
              <thead>
                <tr>
                  <th>タスク</th>
                  <th>出力</th>
                </tr>
              </thead>
              <tbody>
                {[...keys].map((key) => {
                  const current = currentTasks.get(key);
                  const previous = otherTasks.get(key);
                  const task = current ?? previous!;
                  const path = task.item?.path;
                  const label =
                    path && !task.label.endsWith(` / ${path}`)
                      ? `${task.label} / ${path}`
                      : task.label;
                  return (
                    <tr key={key}>
                      <th scope="row">
                        {label}
                        <details>
                          <summary>タスクキー</summary>
                          <code>{key}</code>
                        </details>
                      </th>
                      <td>{outputComparison(current, previous)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}

export function RunMetrics({ job }: { job: WorkflowJob }) {
  const stats = usageSummary(job);
  return (
    <details className="run-metrics">
      <summary>
        使用量・実行記録 · キャッシュ {stats.cacheHits} 件 / チェックポイント再利用{' '}
        {stats.reusedTasks} 件
      </summary>
      <p>
        ジョブの累計稼働時間:{' '}
        {stats.activeMs === null ? '未取得' : `${(stats.activeMs / 1000).toFixed(2)} 秒`}
        {job.status === 'running' ? '（現在の実行区間は終了後に加算）' : ''}
      </p>
      {stats.aiAttempts ? (
        <>
          <p>
            AI試行 {stats.aiAttempts} 回 · 使用量未取得 {stats.unknownAttempts} 回 · 一部のみ取得{' '}
            {stats.partialAttempts} 回
          </p>
          {stats.aiAttempts > stats.unknownAttempts && (
            <p>
              取得済みtoken: 通常入力 {stats.input.toLocaleString()} / キャッシュ読込{' '}
              {stats.cacheRead.toLocaleString()} / キャッシュ作成{' '}
              {stats.cacheWrite.toLocaleString()} / 出力 {stats.output.toLocaleString()}
            </p>
          )}
          <p>
            設定単価による推定:{' '}
            {stats.estimatedCostUsd === null
              ? '算出できません'
              : `$${stats.estimatedCostUsd.toFixed(6)}（取得済み・料金設定済み ${stats.pricedAttempts} 試行分）`}{' '}
            · 料金または使用量が不明 {stats.unpricedAttempts} 試行
          </p>
          {stats.reportedCostUsd !== null && (
            <p>
              CLIが報告した推定料金: ${stats.reportedCostUsd.toFixed(6)}（{stats.reportedAttempts}{' '}
              試行分）
            </p>
          )}
        </>
      ) : (
        <p>このジョブでは新規AI試行の記録はありません。</p>
      )}
      <p className="wf-help">
        失敗・リトライを含む今回の使用量です。再利用元の使用量は加算しません。外部コマンドの料金は含まれず、推定額と実際の請求額は異なる場合があります。
      </p>
      <a className="wf-secondary" href={`/api/jobs/${job.id}/provenance`} download>
        入力・定義・判定・環境・使用量の記録をJSONで保存
      </a>
      <RunComparison key={job.id} job={job} />
    </details>
  );
}

export function RuntimeDetails({ job, stage }: { job: WorkflowJob; stage: JobStage }) {
  const records = job.events.filter((event) => event.stage === stage.key && event.runtime);
  if (!records.length) return null;
  return (
    <details className="run-metrics">
      <summary>各試行の実行環境</summary>
      {records.map((event) => {
        const runtime = event.runtime!;
        const expected = job.workflow?.project.runtime;
        return (
          <section key={event.sequence}>
            <h4>
              試行 {event.attempt} · {runtime.engine} · {runtime.recordedAt}
            </h4>
            <p>
              環境の版 {runtime.revision || '指定なし'} · {runtime.platform} / {runtime.arch}
            </p>
            <table className="runtime-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>登録時の要求</th>
                  <th>実測</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Node</td>
                  <td>{expected?.expected.node || '指定なし'}</td>
                  <td>{runtime.node}</td>
                </tr>
                <tr>
                  <td>Python</td>
                  <td>{expected?.expected.python || '指定なし'}</td>
                  <td>{runtime.python ?? '未取得 / 対象外'}</td>
                </tr>
                <tr>
                  <td>実行ツール</td>
                  <td>{expected?.expected[runtime.engine as 'codex' | 'claude'] || '指定なし'}</td>
                  <td>{runtime.toolVersion ?? 'バージョン未取得'}</td>
                </tr>
                {Object.entries(expected?.packages ?? {}).map(([name, version]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{version}</td>
                    <td>{runtime.packages[name] ?? '未導入'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="wf-help">
              実行ファイル: {runtime.program} · hash{' '}
              {runtime.executableHash?.slice(0, 12) ?? '未取得'}
            </p>
            {runtime.issues.length ? (
              <p className="condition-error">{runtime.issues.join(' / ')}</p>
            ) : (
              <p>指定された要件に不一致はありません。</p>
            )}
            {Object.keys(runtime.packages).length > 0 && (
              <details>
                <summary>
                  取得したPythonパッケージ（{Object.keys(runtime.packages).length}件）
                </summary>
                <pre>{JSON.stringify(runtime.packages, null, 2)}</pre>
              </details>
            )}
          </section>
        );
      })}
    </details>
  );
}
