import { usageSummary } from '../../shared/usage.ts';
import type { WorkflowJob, JobStage } from '../../shared/types.ts';
import { useState } from 'react';
import { useProjectJobs } from '../api.ts';
import { useI18n, type Locale } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';

function outputComparison(locale: Locale, current?: JobStage, other?: JobStage) {
  if (!current) return locale === 'en' ? 'Task missing (current)' : '対象タスクなし（今回）';
  if (!other) return locale === 'en' ? 'Task missing (comparison)' : '対象タスクなし（比較先）';
  if (!current.output && !other.output) return locale === 'en' ? 'Both pending' : '両方未確定';
  if (!current.output) return locale === 'en' ? 'Current pending' : '今回のみ未確定';
  if (!other.output) return locale === 'en' ? 'Comparison pending' : '比較先のみ未確定';
  return current.output.hash === other.output.hash
    ? locale === 'en'
      ? 'Match'
      : '一致'
    : locale === 'en'
      ? 'Different'
      : '異なる';
}

function RunComparison({ job }: { job: WorkflowJob }) {
  const { locale, pick } = useI18n();
  const jobs = useProjectJobs(job.projectId).data?.jobs ?? [];
  const [selected, setSelected] = useState('');
  const other = jobs.find((item) => item.id === selected && item.id !== job.id);
  const cost = (run: WorkflowJob) => {
    const metrics = usageSummary(run);
    if (metrics.estimatedCostUsd === null) return pick('推定額なし', 'No estimate');
    const partial = metrics.partialAttempts
      ? pick(
          ` / 一部のみ ${metrics.partialAttempts} 試行`,
          ` / partial ${metrics.partialAttempts} attempt(s)`,
        )
      : '';
    return pick(
      `$${metrics.estimatedCostUsd.toFixed(6)}（料金不明 ${metrics.unpricedAttempts} 試行${partial}）`,
      `$${metrics.estimatedCostUsd.toFixed(6)} (unpriced ${metrics.unpricedAttempts} attempt(s)${partial})`,
    );
  };
  const currentTasks = new Map(job.stages.map((task) => [task.key, task]));
  const otherTasks = new Map(other?.stages.map((task) => [task.key, task]));
  const keys = new Set([...currentTasks.keys(), ...otherTasks.keys()]);
  const compareOptions = [
    { value: '', label: pick('選択してください', 'Select a job') },
    ...jobs
      .filter((item) => item.id !== job.id)
      .map((item) => ({
        value: item.id,
        label: `${item.id} · ${item.file} · ${item.status}`,
      })),
  ];
  return (
    <details className="run-comparison">
      <summary>{pick('同じプロジェクトの実行結果と比較', 'Compare with another run')}</summary>
      <label>
        {pick('比較するジョブ', 'Job to compare')}
        <CustomSelect
          ariaLabel={pick('比較するジョブ', 'Job to compare')}
          value={other?.id ?? ''}
          options={compareOptions}
          onChange={setSelected}
        />
      </label>
      {other && (
        <>
          <table className="runtime-table">
            <thead>
              <tr>
                <th>{pick('項目', 'Metric')}</th>
                <th>
                  {pick('今回 ', 'Current ')}
                  {job.id}
                </th>
                <th>
                  {pick('比較 ', 'Compare ')}
                  {other.id}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{pick('状態', 'Status')}</td>
                <td>{job.status}</td>
                <td>{other.status}</td>
              </tr>
              <tr>
                <td>{pick('入力hash', 'Input hash')}</td>
                <td>{job.dataset?.hash.slice(0, 12) ?? pick('未記録', 'Not recorded')}</td>
                <td>{other.dataset?.hash.slice(0, 12) ?? pick('未記録', 'Not recorded')}</td>
              </tr>
              <tr>
                <td>{pick('定義hash', 'Definition hash')}</td>
                <td>{job.workflow?.hash.slice(0, 12) ?? pick('未記録', 'Not recorded')}</td>
                <td>{other.workflow?.hash.slice(0, 12) ?? pick('未記録', 'Not recorded')}</td>
              </tr>
              <tr>
                <td>{pick('累計稼働時間', 'Total active time')}</td>
                <td>
                  {job.activeMs === undefined
                    ? pick('未記録', 'Not recorded')
                    : pick(
                        `${(job.activeMs / 1000).toFixed(2)}秒`,
                        `${(job.activeMs / 1000).toFixed(2)}s`,
                      )}
                </td>
                <td>
                  {other.activeMs === undefined
                    ? pick('未記録', 'Not recorded')
                    : pick(
                        `${(other.activeMs / 1000).toFixed(2)}秒`,
                        `${(other.activeMs / 1000).toFixed(2)}s`,
                      )}
                </td>
              </tr>
              <tr>
                <td>{pick('設定単価の推定額', 'Estimated cost')}</td>
                <td>{cost(job)}</td>
                <td>{cost(other)}</td>
              </tr>
            </tbody>
          </table>
          <p className="wf-help">
            {pick(
              '出力の一致はファイル内容のhashで判定します。内容の科学的な妥当性は各ジョブのレポート・判定記録で確認してください。',
              'Output equality compares file content hashes. Verify scientific validity using each run’s reports and gate records.',
            )}
          </p>
          <div className="comparison-outputs">
            <table className="runtime-table">
              <thead>
                <tr>
                  <th>{pick('タスク', 'Task')}</th>
                  <th>{pick('出力', 'Output')}</th>
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
                          <summary>{pick('タスクキー', 'Task key')}</summary>
                          <code>{key}</code>
                        </details>
                      </th>
                      <td>{outputComparison(locale, current, previous)}</td>
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
  const { pick } = useI18n();
  const stats = usageSummary(job);
  return (
    <details className="run-metrics">
      <summary>
        {pick(
          `使用量・実行記録 · キャッシュ ${stats.cacheHits} 件 / チェックポイント再利用 ${stats.reusedTasks} 件`,
          `Usage & provenance · ${stats.cacheHits} cache hit(s) / ${stats.reusedTasks} checkpoint reuse(s)`,
        )}
      </summary>
      <p>
        {pick('ジョブの累計稼働時間: ', 'Job active time: ')}
        {stats.activeMs === null
          ? pick('未取得', 'Unavailable')
          : pick(
              `${(stats.activeMs / 1000).toFixed(2)} 秒`,
              `${(stats.activeMs / 1000).toFixed(2)}s`,
            )}
        {job.status === 'running'
          ? pick(
              '（現在の実行区間は終了後に加算）',
              ' (current running interval added on completion)',
            )
          : ''}
      </p>
      {stats.aiAttempts ? (
        <>
          <p>
            {pick(
              `AI試行 ${stats.aiAttempts} 回 · 使用量未取得 ${stats.unknownAttempts} 回 · 一部のみ取得 ${stats.partialAttempts} 回`,
              `AI attempts: ${stats.aiAttempts} · Unknown usage: ${stats.unknownAttempts} · Partial: ${stats.partialAttempts}`,
            )}
          </p>
          {stats.aiAttempts > stats.unknownAttempts && (
            <p>
              {pick(
                `取得済みtoken: 通常入力 ${stats.input.toLocaleString()} / キャッシュ読込 ${stats.cacheRead.toLocaleString()} / キャッシュ作成 ${stats.cacheWrite.toLocaleString()} / 出力 ${stats.output.toLocaleString()}`,
                `Tokens: input ${stats.input.toLocaleString()} / cache read ${stats.cacheRead.toLocaleString()} / cache write ${stats.cacheWrite.toLocaleString()} / output ${stats.output.toLocaleString()}`,
              )}
            </p>
          )}
          <p>
            {pick('設定単価による推定: ', 'Estimated cost (rate table): ')}
            {stats.estimatedCostUsd === null
              ? pick('算出できません', 'Unavailable')
              : pick(
                  `$${stats.estimatedCostUsd.toFixed(6)}（取得済み・料金設定済み ${stats.pricedAttempts} 試行分）`,
                  `$${stats.estimatedCostUsd.toFixed(6)} (${stats.pricedAttempts} priced attempt(s))`,
                )}{' '}
            ·{' '}
            {pick(
              `料金または使用量が不明 ${stats.unpricedAttempts} 試行`,
              `unpriced or missing usage: ${stats.unpricedAttempts} attempt(s)`,
            )}
          </p>
          {stats.reportedCostUsd !== null && (
            <p>
              {pick(
                `CLIが報告した推定料金: $${stats.reportedCostUsd.toFixed(6)}（${stats.reportedAttempts} 試行分）`,
                `CLI-reported cost: $${stats.reportedCostUsd.toFixed(6)} (${stats.reportedAttempts} attempt(s))`,
              )}
            </p>
          )}
        </>
      ) : (
        <p>
          {pick(
            'このジョブでは新規AI試行の記録はありません。',
            'No new AI attempts recorded for this job.',
          )}
        </p>
      )}
      <p className="wf-help">
        {pick(
          '失敗・リトライを含む今回の使用量です。再利用元の使用量は加算しません。外部コマンドの料金は含まれず、推定額と実際の請求額は異なる場合があります。',
          'Includes failed and retried attempts for this run only (reused source usage is not added). External command costs are excluded and estimates may differ from billed amounts.',
        )}
      </p>
      <a className="wf-secondary" href={`/api/jobs/${job.id}/provenance`} download>
        {pick('入力・定義・判定・環境・使用量の記録をJSONで保存', 'Download full provenance JSON')}
      </a>
      <RunComparison key={job.id} job={job} />
    </details>
  );
}

export function RuntimeDetails({ job, stage }: { job: WorkflowJob; stage: JobStage }) {
  const { pick } = useI18n();
  const records = job.events.filter((event) => event.stage === stage.key && event.runtime);
  if (!records.length) return null;
  return (
    <details className="run-metrics">
      <summary>{pick('各試行の実行環境', 'Observed runtime per attempt')}</summary>
      {records.map((event) => {
        const runtime = event.runtime!;
        const expected = job.workflow?.project.runtime;
        return (
          <section key={event.sequence}>
            <h4>
              {pick(`試行 ${event.attempt}`, `Attempt ${event.attempt}`)} · {runtime.engine} ·{' '}
              {runtime.recordedAt}
            </h4>
            <p>
              {pick('環境の版 ', 'Environment revision ')}
              {runtime.revision || pick('指定なし', 'Not set')} · {runtime.platform} /{' '}
              {runtime.arch}
            </p>
            <table className="runtime-table">
              <thead>
                <tr>
                  <th>{pick('項目', 'Item')}</th>
                  <th>{pick('登録時の要求', 'Expected')}</th>
                  <th>{pick('実測', 'Observed')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Node</td>
                  <td>{expected?.expected.node || pick('指定なし', 'Any')}</td>
                  <td>{runtime.node}</td>
                </tr>
                <tr>
                  <td>Python</td>
                  <td>{expected?.expected.python || pick('指定なし', 'Any')}</td>
                  <td>{runtime.python ?? pick('未取得 / 対象外', 'Unavailable / N/A')}</td>
                </tr>
                <tr>
                  <td>{pick('実行ツール', 'Tool')}</td>
                  <td>
                    {expected?.expected[runtime.engine as 'codex' | 'claude'] ||
                      pick('指定なし', 'Any')}
                  </td>
                  <td>{runtime.toolVersion ?? pick('バージョン未取得', 'Version unavailable')}</td>
                </tr>
                {Object.entries(expected?.packages ?? {}).map(([name, version]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{version}</td>
                    <td>{runtime.packages[name] ?? pick('未導入', 'Not installed')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="wf-help">
              {pick('実行ファイル: ', 'Executable: ')}
              {runtime.program} · hash{' '}
              {runtime.executableHash?.slice(0, 12) ?? pick('未取得', 'Unavailable')}
            </p>
            {runtime.issues.length ? (
              <p className="condition-error">{runtime.issues.join(' / ')}</p>
            ) : (
              <p>
                {pick(
                  '指定された要件に不一致はありません。',
                  'All declared environment requirements matched.',
                )}
              </p>
            )}
            {Object.keys(runtime.packages).length > 0 && (
              <details>
                <summary>
                  {pick(
                    `取得したPythonパッケージ（${Object.keys(runtime.packages).length}件）`,
                    `Observed Python packages (${Object.keys(runtime.packages).length})`,
                  )}
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
