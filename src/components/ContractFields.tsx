import { useState } from 'react';
import type { FileContract, JsonSchema } from '../../shared/contracts.ts';
import { NumberValue } from './NumberValue.tsx';

const types: JsonSchema['type'][] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];
export function ContractFields({
  value,
  onChange,
  input,
}: {
  value: FileContract[];
  onChange: (next: FileContract[]) => void;
  input?: boolean;
}) {
  const [keyError, setKeyError] = useState<{ contract: number; message: string } | null>(null);
  const update = (index: number, patch: Partial<FileContract>) =>
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <div className="contract-fields">
      <p className="wf-help">
        {input
          ? 'データセットの相対パス、または前工程の「タスクキー/出力パス」を照合します。mapではそのファイルだけをデータセット入力として検証します。'
          : '出力の件数とJSONの型を検証します。受け入れた工程自身の出力は、すべて後続に渡します。'}
      </p>
      {value.map((contract, index) => (
        <fieldset key={index} className="contract-row">
          <legend>契約 {index + 1}</legend>
          <div className="wf-fields">
            {input && (
              <label>
                入力元
                <select
                  value={contract.source ?? 'dataset'}
                  onChange={(event) =>
                    update(index, { source: event.target.value as 'dataset' | 'upstream' })
                  }
                >
                  <option value="dataset">データセット</option>
                  <option value="upstream">合格した前工程</option>
                </select>
              </label>
            )}
            <label>
              ファイルパターン
              <input
                value={contract.pattern}
                onChange={(event) => update(index, { pattern: event.target.value })}
                placeholder="**/metrics.json"
              />
            </label>
            <label>
              最低件数
              <NumberValue
                value={contract.minFiles}
                integer
                onChange={(minFiles) => update(index, { minFiles })}
              />
            </label>
            <label>
              最大件数
              <NumberValue
                value={contract.maxFiles}
                integer
                onChange={(maxFiles) => update(index, { maxFiles })}
              />
            </label>
            <label>
              JSONの型検証
              <select
                value={contract.schema?.type ?? ''}
                onChange={(event) =>
                  update(index, {
                    schema: event.target.value
                      ? { type: event.target.value as JsonSchema['type'] }
                      : undefined,
                  })
                }
              >
                <option value="">なし</option>
                {types.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <button
              className="wf-secondary"
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              契約を削除
            </button>
          </div>
          {contract.schema?.type === 'object' && (
            <div className="schema-fields">
              {Object.entries(contract.schema.properties ?? {}).map(([name, rule], position) => {
                const replace = (nextName: string, nextRule: JsonSchema): boolean => {
                  const entries = Object.entries(contract.schema!.properties ?? {});
                  if (!nextName.trim()) {
                    setKeyError({ contract: index, message: 'JSONキー名を入力してください。' });
                    return false;
                  }
                  if (nextName !== name && entries.some(([key]) => key === nextName)) {
                    setKeyError({
                      contract: index,
                      message: `同じ名前のJSONキー「${nextName}」が既に存在します。`,
                    });
                    return false;
                  }
                  setKeyError(null);
                  update(index, {
                    schema: {
                      ...contract.schema!,
                      properties: Object.fromEntries(
                        entries.map(([key, item]) =>
                          key === name ? [nextName, nextRule] : [key, item],
                        ),
                      ),
                      required: contract.schema!.required
                        ? [
                            ...new Set(
                              contract.schema!.required.map((key) =>
                                key === name ? nextName : key,
                              ),
                            ),
                          ]
                        : undefined,
                    },
                  });
                  return true;
                };
                return (
                  // Position keys stay stable while a property is renamed, so the row
                  // (and the focused input) is not remounted on every committed rename.
                  <div className="condition-toolbar" key={position}>
                    <PropertyNameInput
                      name={name}
                      onCommit={(nextName) => nextName === name || replace(nextName, rule)}
                    />
                    <label>
                      型
                      <select
                        value={rule.type}
                        onChange={(event) => {
                          const nextType = event.target.value as JsonSchema['type'];
                          const numeric =
                            (rule.type === 'number' || rule.type === 'integer') &&
                            (nextType === 'number' || nextType === 'integer');
                          replace(name, numeric ? { ...rule, type: nextType } : { type: nextType });
                        }}
                      >
                        {types.map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </label>
                    <label className="wf-check">
                      <input
                        type="checkbox"
                        checked={contract.schema!.required?.includes(name) ?? false}
                        onChange={(event) =>
                          update(index, {
                            schema: {
                              ...contract.schema!,
                              required: event.target.checked
                                ? [...(contract.schema!.required ?? []), name]
                                : contract.schema!.required?.filter((key) => key !== name),
                            },
                          })
                        }
                      />
                      必須
                    </label>
                    <button
                      type="button"
                      className="wf-secondary"
                      onClick={() =>
                        update(index, {
                          schema: {
                            ...contract.schema!,
                            properties: Object.fromEntries(
                              Object.entries(contract.schema!.properties ?? {}).filter(
                                ([key]) => key !== name,
                              ),
                            ),
                            required: contract.schema!.required?.filter((key) => key !== name),
                          },
                        })
                      }
                    >
                      キーを削除
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="wf-secondary"
                onClick={() => {
                  let n = 1;
                  while (Object.hasOwn(contract.schema!.properties ?? {}, `field_${n}`)) n++;
                  update(index, {
                    schema: {
                      ...contract.schema!,
                      properties: {
                        ...contract.schema!.properties,
                        [`field_${n}`]: { type: 'number' },
                      },
                    },
                  });
                }}
              >
                JSONキーを追加
              </button>
              {keyError?.contract === index && (
                <p className="condition-error" role="alert">
                  {keyError.message}
                </p>
              )}
            </div>
          )}
        </fieldset>
      ))}
      <button
        type="button"
        className="wf-secondary"
        disabled={value.length >= 20}
        onClick={() => onChange([...value, { pattern: '**/*.json', minFiles: 1, maxFiles: 5000 }])}
      >
        ファイル契約を追加
      </button>
    </div>
  );
}

/**
 * Key names are edited as a local draft and validated only when committed (blur or
 * Enter), so intermediate spellings that collide with another key, or an empty field,
 * never interrupt typing. An invalid commit reverts the field to the saved name.
 */
function PropertyNameInput({
  name,
  onCommit,
}: {
  name: string;
  onCommit: (next: string) => boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <label>
      キー
      <input
        value={draft ?? name}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') setDraft(null);
        }}
      />
    </label>
  );
}
