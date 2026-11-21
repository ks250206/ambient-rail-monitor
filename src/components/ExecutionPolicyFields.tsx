import { MAX_BUDGET_MS, resolveExecution, RETRY_LABELS } from '../../shared/execution-policy.ts';
import type { ExecutionPolicy } from '../../shared/execution-policy.ts';
import { NumberValue } from './NumberValue.tsx';

const NUMBERS = [
  { key: 'maxRetries', label: '追加リトライ回数', unit: 1, max: 10, step: 1 },
  {
    key: 'attemptTimeoutMs',
    label: '1回の実行上限（秒・0は無制限）',
    unit: 1000,
    max: MAX_BUDGET_MS / 1000,
    step: 0.001,
  },
  {
    key: 'stageTimeoutMs',
    label: '工程全体の上限（秒・0は無制限）',
    unit: 1000,
    max: MAX_BUDGET_MS / 1000,
    step: 0.001,
  },
  { key: 'retryDelayMs', label: '再試行までの待機（秒）', unit: 1000, max: 3600, step: 0.001 },
] as const;

export function ExecutionPolicyFields({
  value,
  onChange,
  inherited,
}: {
  value: Partial<ExecutionPolicy>;
  onChange: (next: Partial<ExecutionPolicy>) => void;
  inherited?: ExecutionPolicy;
}) {
  const effective = resolveExecution(inherited, value);
  const update = <K extends keyof ExecutionPolicy>(key: K, next: ExecutionPolicy[K]) =>
    onChange({ ...value, [key]: next });
  const toggle = (key: keyof ExecutionPolicy) => (
    <label className="wf-check policy-override">
      <input
        type="checkbox"
        checked={Object.hasOwn(value, key)}
        onChange={(e) => {
          const next = { ...value };
          if (e.target.checked) Object.assign(next, { [key]: effective[key] });
          else delete next[key];
          onChange(next);
        }}
      />
      この工程で上書き
    </label>
  );
  return (
    <div className="execution-fields">
      <p className="wf-help">
        リトライは初回に追加する回数です。0回なら1回だけ実行。工程・ジョブの上限にはリトライ待機を含め、キュー・レビュー待ちは含めません。上位の時間上限が優先されます。
      </p>
      <div className="wf-fields">
        {NUMBERS.map(({ key, label, unit }) => (
          <div className="policy-field" key={key}>
            {inherited && toggle(key)}
            <label>
              {label}
              <NumberValue
                value={effective[key]}
                scale={unit}
                integer={unit === 1}
                disabled={Boolean(inherited) && !Object.hasOwn(value, key)}
                onChange={(next) => update(key, next)}
              />
            </label>
          </div>
        ))}
        <div className="policy-field">
          {inherited && toggle('backoff')}
          <label>
            待機時間の増やし方
            <select
              value={effective.backoff}
              disabled={Boolean(inherited) && !Object.hasOwn(value, 'backoff')}
              onChange={(e) => update('backoff', e.target.value as ExecutionPolicy['backoff'])}
            >
              <option value="fixed">一定</option>
              <option value="exponential">2倍ずつ（最大1時間）</option>
            </select>
          </label>
        </div>
        <div className="policy-field">
          {inherited && toggle('onFailure')}
          <label>
            再試行できない場合
            <select
              value={effective.onFailure}
              disabled={Boolean(inherited) && !Object.hasOwn(value, 'onFailure')}
              onChange={(e) => update('onFailure', e.target.value as ExecutionPolicy['onFailure'])}
            >
              <option value="stop">ジョブを失敗として停止</option>
              <option value="review">人間の確認を待つ</option>
            </select>
          </label>
        </div>
        <div className="wf-wide policy-field">
          {inherited && toggle('retryOn')}
          <span>リトライする失敗の種類</span>
          <div className="condition-toolbar">
            {Object.entries(RETRY_LABELS).map(([key, label]) => (
              <label className="wf-check" key={key}>
                <input
                  type="checkbox"
                  checked={effective.retryOn.includes(key as ExecutionPolicy['retryOn'][number])}
                  disabled={Boolean(inherited) && !Object.hasOwn(value, 'retryOn')}
                  onChange={(e) =>
                    update(
                      'retryOn',
                      e.target.checked
                        ? [...effective.retryOn, key as ExecutionPolicy['retryOn'][number]]
                        : effective.retryOn.filter((item) => item !== key),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>
      <p className="wf-help">
        工程・ジョブ全体の時間切れとワーカー停止は再試行・例外承認の対象外です。
      </p>
    </div>
  );
}
