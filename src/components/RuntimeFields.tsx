import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DEFAULT_RUNTIME, type PriceRate, type RuntimeProfile } from '../../shared/reuse.ts';

export function RuntimeFields({
  value = DEFAULT_RUNTIME,
  pricing = [],
  onRuntime,
  onPricing,
}: {
  value?: RuntimeProfile;
  pricing?: PriceRate[];
  onRuntime: (value: RuntimeProfile) => void;
  onPricing: (value: PriceRate[]) => void;
}) {
  const packages = Object.entries(value.packages);
  const [packageError, setPackageError] = useState('');
  const changePackage = (index: number, name: string, version: string) => {
    const normalize = (value: string) =>
      value.toLowerCase().replaceAll('_', '-').replaceAll('.', '-');
    if (packages.some(([existing], i) => i !== index && normalize(existing) === normalize(name))) {
      setPackageError(
        '同じ名前のパッケージがあります。名前を変えるか、その行のバージョンを編集してください。',
      );
      return;
    }
    setPackageError('');
    onRuntime({
      ...value,
      packages: Object.fromEntries(
        packages.map((pair, i) => (i === index ? [name, version] : pair)),
      ),
    });
  };
  return (
    <details className="wf-runtime">
      <summary>実行環境・LLM料金の設定</summary>
      <h3>実行環境の要件（Workflow v2）</h3>
      <p className="wf-help">
        指定したバージョンと一致しない場合は処理前に停止します。仮想環境は事前に用意し、そのPythonを指定してください。パッケージの自動インストールは行いません。
      </p>
      <div className="wf-fields">
        <label>
          環境の版
          <input
            value={value.revision}
            maxLength={120}
            placeholder="例: analysis-env-v1（キャッシュ利用時に必要）"
            onChange={(e) => onRuntime({ ...value, revision: e.target.value })}
          />
        </label>
        <label>
          Python実行ファイル
          <input
            value={value.python}
            maxLength={512}
            placeholder="例: /path/to/venv/bin/python（空欄はworker既定）"
            onChange={(e) => onRuntime({ ...value, python: e.target.value })}
          />
        </label>
        {(['node', 'python', 'codex', 'claude'] as const).map((key) => (
          <label key={key}>
            {key} の要求バージョン
            <input
              value={value.expected[key] ?? ''}
              placeholder="完全一致・空欄は指定なし"
              maxLength={80}
              onChange={(e) =>
                onRuntime({ ...value, expected: { ...value.expected, [key]: e.target.value } })
              }
            />
          </label>
        ))}
      </div>
      <h4>Pythonパッケージの固定</h4>
      {packageError && (
        <p role="alert" className="condition-error">
          {packageError}
        </p>
      )}
      {packages.map(([name, version], index) => (
        <div className="wf-package" key={index}>
          <input
            aria-label={`パッケージ名 ${index + 1}`}
            value={name}
            placeholder="numpy"
            onChange={(e) => changePackage(index, e.target.value, version)}
          />
          <input
            aria-label={`固定バージョン ${index + 1}`}
            value={version}
            placeholder="完全一致"
            onChange={(e) => changePackage(index, name, e.target.value)}
          />
          <button
            type="button"
            className="wf-icon-button"
            aria-label={`パッケージ ${index + 1} を削除`}
            onClick={() =>
              onRuntime({
                ...value,
                packages: Object.fromEntries(packages.filter((_, i) => i !== index)),
              })
            }
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="wf-secondary"
        disabled={packages.length >= 50}
        onClick={() => {
          let i = 1;
          while (Object.hasOwn(value.packages, `package-${i}`)) i++;
          onRuntime({ ...value, packages: { ...value.packages, [`package-${i}`]: '' } });
        }}
      >
        <Plus size={15} />
        パッケージを追加
      </button>
      <h3>LLMの推定料金</h3>
      <p className="wf-help">
        USD /
        100万token。モデル名が完全一致する単価だけを使います。未設定は料金不明として表示します。CLIの報告値とこの単価はジョブに保存され、請求額そのものを表すものではありません。
      </p>
      {pricing.map((rate, index) => (
        <fieldset className="wf-price-row" key={index}>
          <legend>料金 {index + 1}</legend>
          <label>
            エンジン
            <select
              value={rate.engine}
              onChange={(e) =>
                onPricing(
                  pricing.map((r, i) =>
                    i === index ? { ...r, engine: e.target.value as PriceRate['engine'] } : r,
                  ),
                )
              }
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            モデル名
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
                  input: '通常入力',
                  cacheRead: 'キャッシュ読込',
                  cacheWrite: 'キャッシュ作成',
                  output: '出力',
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
            この料金を削除
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
        料金を追加
      </button>
    </details>
  );
}
