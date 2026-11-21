import { MAX_BUDGET_MS, resolveExecution, RETRY_LABELS } from '../../shared/execution-policy.ts';
import type { ExecutionPolicy } from '../../shared/execution-policy.ts';
import { useI18n } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';
import { NumberValue } from './NumberValue.tsx';

const NUMBERS = [
  {
    key: 'maxRetries',
    ja: '追加リトライ回数',
    en: 'Additional retries',
    unit: 1,
    max: 10,
    step: 1,
  },
  {
    key: 'attemptTimeoutMs',
    ja: '1回の実行上限（秒・0は無制限）',
    en: 'Per-attempt timeout (sec, 0 = unlimited)',
    unit: 1000,
    max: MAX_BUDGET_MS / 1000,
    step: 0.001,
  },
  {
    key: 'stageTimeoutMs',
    ja: '工程全体の上限（秒・0は無制限）',
    en: 'Stage budget limit (sec, 0 = unlimited)',
    unit: 1000,
    max: MAX_BUDGET_MS / 1000,
    step: 0.001,
  },
  {
    key: 'retryDelayMs',
    ja: '再試行までの待機（秒）',
    en: 'Retry delay (sec)',
    unit: 1000,
    max: 3600,
    step: 0.001,
  },
] as const;

const RETRY_LABELS_EN: Record<string, string> = {
  execution_error: 'Execution error',
  timeout: 'Attempt timeout',
  acceptance_failed: 'Acceptance check failed',
};

export function ExecutionPolicyFields({
  value,
  onChange,
  inherited,
}: {
  value: Partial<ExecutionPolicy>;
  onChange: (next: Partial<ExecutionPolicy>) => void;
  inherited?: ExecutionPolicy;
}) {
  const { locale, pick } = useI18n();
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
      {pick('この工程で上書き', 'Override for this stage')}
    </label>
  );
  return (
    <div className="execution-fields">
      <p className="wf-help">
        {pick(
          'リトライは初回に追加する回数です。0回なら1回だけ実行。工程・ジョブの上限にはリトライ待機を含め、キュー・レビュー待ちは含めません。上位の時間上限が優先されます。',
          'Retries are added after the first attempt (0 = 1 attempt total). Stage and job budgets include retry waits but exclude queue and review waits. Tighter parent limits take precedence.',
        )}
      </p>
      <div className="wf-fields">
        {NUMBERS.map(({ key, ja, en, unit }) => (
          <div className="policy-field" key={key}>
            {inherited && toggle(key)}
            <label>
              {pick(ja, en)}
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
            {pick('待機時間の増やし方', 'Backoff strategy')}
            <CustomSelect
              ariaLabel={pick('待機時間の増やし方', 'Backoff strategy')}
              value={effective.backoff}
              disabled={Boolean(inherited) && !Object.hasOwn(value, 'backoff')}
              options={[
                { value: 'fixed', label: pick('一定', 'Fixed') },
                {
                  value: 'exponential',
                  label: pick('2倍ずつ（最大1時間）', 'Exponential (max 1 hour)'),
                },
              ]}
              onChange={(next) => update('backoff', next)}
            />
          </label>
        </div>
        <div className="policy-field">
          {inherited && toggle('onFailure')}
          <label>
            {pick('再試行できない場合', 'On failure / retries exhausted')}
            <CustomSelect
              ariaLabel={pick('再試行できない場合', 'On failure / retries exhausted')}
              value={effective.onFailure}
              disabled={Boolean(inherited) && !Object.hasOwn(value, 'onFailure')}
              options={[
                { value: 'stop', label: pick('ジョブを失敗として停止', 'Stop job as failed') },
                { value: 'review', label: pick('人間の確認を待つ', 'Wait for human review') },
              ]}
              onChange={(next) => update('onFailure', next)}
            />
          </label>
        </div>
        <div className="wf-wide policy-field">
          {inherited && toggle('retryOn')}
          <span>{pick('リトライする失敗の種類', 'Retryable failure kinds')}</span>
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
                {locale === 'en' ? (RETRY_LABELS_EN[key] ?? label) : label}
              </label>
            ))}
          </div>
        </div>
      </div>
      <p className="wf-help">
        {pick(
          '工程・ジョブ全体の時間切れとワーカー停止は再試行・例外承認の対象外です。',
          'Stage/job timeouts and worker interruptions are never retried or exception-approved.',
        )}
      </p>
    </div>
  );
}
