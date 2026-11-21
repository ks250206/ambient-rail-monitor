import { Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_RUNTIME,
  nextPackageName,
  type PriceRate,
  type RuntimeProfile,
} from '../../shared/reuse.ts';
import { useI18n } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';

export interface PackageRow {
  id: number;
  name: string;
  version: string;
}

export function RuntimeFields({
  value = DEFAULT_RUNTIME,
  pricing = [],
  onRuntime,
  onPricing,
  enabled,
  rows,
  onRows,
  packageError,
}: {
  value?: RuntimeProfile;
  pricing?: PriceRate[];
  onRuntime: (value: RuntimeProfile) => void;
  onPricing: (value: PriceRate[]) => void;
  enabled: boolean;
  rows: PackageRow[];
  onRows: (rows: PackageRow[]) => void;
  packageError: string;
}) {
  const { pick } = useI18n();
  return (
    <details className="wf-runtime">
      <summary>{pick('実行環境・LLM料金の設定', 'Runtime environment & LLM pricing')}</summary>
      {enabled ? (
        <div>
          <h3>{pick('実行環境の要件（Workflow v2）', 'Runtime requirements (Workflow v2)')}</h3>
          <p className="wf-help">
            {pick(
              '指定したバージョンと一致しない場合は処理前に停止します。仮想環境は事前に用意し、そのPythonを指定してください。パッケージの自動インストールは行いません。',
              'Tasks stop before running if observed versions do not match. Prepare your virtualenv ahead of time and point to its Python binary; packages are never auto-installed.',
            )}
          </p>
          <div className="wf-fields">
            <label>
              {pick('環境の版', 'Environment revision')}
              <input
                value={value.revision}
                maxLength={120}
                placeholder={pick(
                  '例: analysis-env-v1（キャッシュ利用時に必要）',
                  'e.g., analysis-env-v1 (required for caching)',
                )}
                onChange={(e) => onRuntime({ ...value, revision: e.target.value })}
              />
            </label>
            <label>
              {pick('Python実行ファイル', 'Python executable')}
              <input
                value={value.python}
                maxLength={512}
                placeholder={pick(
                  '例: /path/to/venv/bin/python（空欄はworker既定）',
                  'e.g., /path/to/venv/bin/python (blank = worker default)',
                )}
                onChange={(e) => onRuntime({ ...value, python: e.target.value })}
              />
            </label>
            {(['node', 'python', 'codex', 'claude'] as const).map((key) => (
              <label key={key}>
                {pick(`${key} の要求バージョン`, `Expected ${key} version`)}
                <input
                  value={value.expected[key] ?? ''}
                  placeholder={pick('完全一致・空欄は指定なし', 'Exact match (blank = any)')}
                  maxLength={80}
                  onChange={(e) =>
                    onRuntime({ ...value, expected: { ...value.expected, [key]: e.target.value } })
                  }
                />
              </label>
            ))}
          </div>
          <h4>{pick('Pythonパッケージの固定', 'Pinned Python packages')}</h4>
          {packageError && (
            <p role="alert" className="condition-error">
              {packageError}{' '}
              {pick(
                '重複を解消するまで保存できません。',
                'Resolve duplicate package names before saving.',
              )}
            </p>
          )}
          <div id="runtime-packages">
            {rows.map((row, index) => (
              <div className="wf-package" key={row.id}>
                <input
                  aria-label={pick(`パッケージ名 ${index + 1}`, `Package name ${index + 1}`)}
                  value={row.name}
                  placeholder="numpy"
                  onChange={(e) =>
                    onRows(
                      rows.map((item) =>
                        item.id === row.id ? { ...item, name: e.target.value } : item,
                      ),
                    )
                  }
                />
                <input
                  aria-label={pick(`固定バージョン ${index + 1}`, `Pinned version ${index + 1}`)}
                  value={row.version}
                  placeholder={pick('完全一致', 'Exact version')}
                  onChange={(e) =>
                    onRows(
                      rows.map((item) =>
                        item.id === row.id ? { ...item, version: e.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="wf-icon-button"
                  aria-label={pick(`パッケージ ${index + 1} を削除`, `Remove package ${index + 1}`)}
                  onClick={() => onRows(rows.filter((item) => item.id !== row.id))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wf-secondary"
              disabled={rows.length >= 50 || Boolean(packageError)}
              onClick={() => {
                const id = Math.max(-1, ...rows.map((row) => row.id)) + 1;
                onRows([...rows, { id, name: nextPackageName(rows), version: '' }]);
              }}
            >
              <Plus size={15} />
              {pick('パッケージを追加', 'Add package')}
            </button>
          </div>
        </div>
      ) : (
        <p className="wf-help">
          {pick(
            '実行環境の要件は Workflow v2 で設定できます。',
            'Runtime requirements are available in Workflow v2.',
          )}
        </p>
      )}
      <h3>{pick('LLMの推定料金', 'LLM rate table (estimates)')}</h3>
      <p className="wf-help">
        {pick(
          'USD / 100万token。モデル名が完全一致する単価だけを使います。未設定は料金不明として表示します。CLIの報告値とこの単価はジョブに保存され、請求額そのものを表すものではありません。',
          'USD per 1M tokens. Only exact model name matches are priced; unconfigured models show as unpriced. Rates are snapshotted per job and represent estimates, not invoices.',
        )}
      </p>
      {pricing.map((rate, index) => (
        <fieldset className="wf-price-row" key={index}>
          <legend>{pick(`料金 ${index + 1}`, `Rate ${index + 1}`)}</legend>
          <label>
            {pick('エンジン', 'Engine')}
            <CustomSelect
              ariaLabel={pick('エンジン', 'Engine')}
              value={rate.engine}
              options={[
                { value: 'codex', label: 'Codex' },
                { value: 'claude', label: 'Claude' },
              ]}
              onChange={(engine) =>
                onPricing(pricing.map((r, i) => (i === index ? { ...r, engine } : r)))
              }
            />
          </label>
          <label>
            {pick('モデル名', 'Model name')}
            <input
              value={rate.model}
              onChange={(e) =>
                onPricing(
                  pricing.map((r, i) => (i === index ? { ...r, model: e.target.value } : r)),
                )
              }
            />
          </label>
          {(['input', 'cacheRead', 'cacheWrite', 'output'] as const).map((key) => (
            <label key={key}>
              {
                {
                  input: pick('通常入力', 'Input'),
                  cacheRead: pick('キャッシュ読込', 'Cache read'),
                  cacheWrite: pick('キャッシュ作成', 'Cache write'),
                  output: pick('出力', 'Output'),
                }[key]
              }
              <input
                type="number"
                min={0}
                max={1_000_000}
                step="any"
                value={Number.isNaN(rate[key]) ? '' : rate[key]}
                onChange={(e) =>
                  onPricing(
                    pricing.map((r, i) =>
                      i === index
                        ? { ...r, [key]: e.target.value === '' ? NaN : Number(e.target.value) }
                        : r,
                    ),
                  )
                }
              />
            </label>
          ))}
          <button
            type="button"
            className="wf-secondary"
            onClick={() => onPricing(pricing.filter((_, i) => i !== index))}
          >
            <Trash2 size={15} />
            {pick('この料金を削除', 'Remove rate')}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="wf-secondary"
        disabled={pricing.length >= 30}
        onClick={() =>
          onPricing([
            ...pricing,
            {
              engine: 'codex',
              model: '',
              input: NaN,
              cacheRead: NaN,
              cacheWrite: NaN,
              output: NaN,
            },
          ])
        }
      >
        <Plus size={15} />
        {pick('料金を追加', 'Add rate')}
      </button>
    </details>
  );
}
