import { useState } from 'react';
import type { FileContract, JsonSchema } from '../../shared/contracts.ts';
import { useI18n, type Locale } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';
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

function schemaSummary(rule: JsonSchema, locale: Locale, path = '$'): string[] {
  const attributes: string[] = [rule.type];
  if (rule.minimum !== undefined)
    attributes.push(locale === 'en' ? `min ${rule.minimum}` : `最小値 ${rule.minimum}`);
  if (rule.maximum !== undefined)
    attributes.push(locale === 'en' ? `max ${rule.maximum}` : `最大値 ${rule.maximum}`);
  if (rule.minLength !== undefined)
    attributes.push(locale === 'en' ? `minLength ${rule.minLength}` : `最短 ${rule.minLength}文字`);
  if (rule.maxLength !== undefined)
    attributes.push(locale === 'en' ? `maxLength ${rule.maxLength}` : `最長 ${rule.maxLength}文字`);
  if (rule.minItems !== undefined)
    attributes.push(locale === 'en' ? `minItems ${rule.minItems}` : `最少 ${rule.minItems}要素`);
  if (rule.maxItems !== undefined)
    attributes.push(locale === 'en' ? `maxItems ${rule.maxItems}` : `最多 ${rule.maxItems}要素`);
  if (rule.enum)
    attributes.push(
      locale === 'en'
        ? `enum ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}`
        : `選択肢 ${rule.enum.map((entry) => JSON.stringify(entry)).join('、')}`,
    );
  if (rule.required?.length)
    attributes.push(
      locale === 'en'
        ? `required ${rule.required.join(', ')}`
        : `必須キー ${rule.required.join('、')}`,
    );
  if (rule.additionalProperties !== undefined)
    attributes.push(
      locale === 'en'
        ? `additionalProperties ${rule.additionalProperties ? 'allowed' : 'disallowed'}`
        : `追加キー${rule.additionalProperties ? '可' : '不可'}`,
    );
  return [
    locale === 'en' ? `${path}: ${attributes.join(' / ')}` : `${path}：${attributes.join('／')}`,
    ...Object.entries(rule.properties ?? {}).flatMap(([key, value]) =>
      schemaSummary(value, locale, `${path}[${JSON.stringify(key)}]`),
    ),
    ...(rule.items ? schemaSummary(rule.items, locale, `${path}[*]`) : []),
  ];
}

export function ContractFields({
  value,
  onChange,
  input,
}: {
  value: FileContract[];
  onChange: (next: FileContract[]) => void;
  input?: boolean;
}) {
  const { locale, pick } = useI18n();
  const [keyError, setKeyError] = useState<{ contract: number; message: string } | null>(null);
  const update = (index: number, patch: Partial<FileContract>) =>
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const fieldId = (index: number, field: string) =>
    `contract-${input ? 'inputs' : 'outputs'}-${index}-${field}`;
  return (
    <div className="contract-fields">
      <p className="wf-help">
        {input
          ? pick(
              'データセットの相対パス、または前工程の「タスクキー/出力パス」を照合します。mapではそのファイルだけをデータセット入力として検証します。',
              'Matches dataset relative paths or upstream "taskKey/outputPath". On map stages, only the mapped file is checked as dataset input.',
            )
          : pick(
              '出力の件数とJSONの型を検証します。受け入れた工程自身の出力は、すべて後続に渡します。',
              'Validates output file counts and JSON schema types. Accepted outputs from this stage are passed downstream.',
            )}
      </p>
      {value.map((contract, index) => (
        <fieldset key={index} className="contract-row">
          <legend>{pick(`契約 ${index + 1}`, `Contract ${index + 1}`)}</legend>
          <details className="wf-disclosure">
            <summary>
              {pick(`契約 ${index + 1} の全制約`, `All constraints for contract ${index + 1}`)}
            </summary>
            <p>
              {input
                ? contract.source === 'upstream'
                  ? pick('前工程の出力', 'Upstream outputs')
                  : pick('データセット', 'Dataset')
                : pick('この工程の出力', 'Stage outputs')}
              {pick(
                `：${contract.pattern}（${contract.minFiles}〜${contract.maxFiles}件）`,
                `: ${contract.pattern} (${contract.minFiles}–${contract.maxFiles} files)`,
              )}
            </p>
            {contract.schema ? (
              <ul>
                {schemaSummary(contract.schema, locale).map((line) => (
                  <li key={line}>
                    <code>{line}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{pick('JSONの型検証なし', 'No JSON schema validation')}</p>
            )}
          </details>
          <div className="wf-fields">
            {input && (
              <label id={fieldId(index, 'source')}>
                {pick('入力元', 'Source')}
                <CustomSelect
                  ariaLabel={pick('入力元', 'Source')}
                  value={contract.source ?? 'dataset'}
                  options={[
                    { value: 'dataset', label: pick('データセット', 'Dataset') },
                    { value: 'upstream', label: pick('合格した前工程', 'Accepted upstream') },
                  ]}
                  onChange={(source) => update(index, { source })}
                />
              </label>
            )}
            <label id={fieldId(index, 'pattern')}>
              {pick('ファイルパターン', 'File pattern')}
              <input
                value={contract.pattern}
                onChange={(event) => update(index, { pattern: event.target.value })}
                placeholder="**/metrics.json"
              />
            </label>
            <label id={fieldId(index, 'minFiles')}>
              {pick('最低件数', 'Min files')}
              <NumberValue
                value={contract.minFiles}
                integer
                onChange={(minFiles) => update(index, { minFiles })}
              />
            </label>
            <label id={fieldId(index, 'maxFiles')}>
              {pick('最大件数', 'Max files')}
              <NumberValue
                value={contract.maxFiles}
                integer
                onChange={(maxFiles) => update(index, { maxFiles })}
              />
            </label>
            <label id={fieldId(index, 'schema')}>
              {pick('JSONの型検証', 'JSON schema type')}
              <CustomSelect
                ariaLabel={pick('JSONの型検証', 'JSON schema type')}
                value={contract.schema?.type ?? ''}
                options={[
                  { value: '', label: pick('なし', 'None') },
                  ...types.map((type) => ({ value: type, label: type })),
                ]}
                onChange={(nextType) =>
                  update(index, {
                    schema: nextType ? { type: nextType as JsonSchema['type'] } : undefined,
                  })
                }
              />
            </label>
            <button
              className="wf-secondary"
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              {pick('契約を削除', 'Remove contract')}
            </button>
          </div>
          {contract.schema?.type === 'object' && (
            <div className="schema-fields">
              {Object.entries(contract.schema.properties ?? {}).map(([name, rule], position) => {
                const replace = (nextName: string, nextRule: JsonSchema): boolean => {
                  const entries = Object.entries(contract.schema!.properties ?? {});
                  if (!nextName.trim()) {
                    setKeyError({
                      contract: index,
                      message: pick('JSONキー名を入力してください。', 'Enter a JSON key name.'),
                    });
                    return false;
                  }
                  if (nextName !== name && entries.some(([key]) => key === nextName)) {
                    setKeyError({
                      contract: index,
                      message: pick(
                        `同じ名前のJSONキー「${nextName}」が既に存在します。`,
                        `JSON key "${nextName}" already exists.`,
                      ),
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
                  <div className="condition-toolbar" key={position}>
                    <PropertyNameInput
                      name={name}
                      onCommit={(nextName) => nextName === name || replace(nextName, rule)}
                    />
                    <label className="min-w-[120px]">
                      {pick('型', 'Type')}
                      <CustomSelect
                        ariaLabel={pick('型', 'Type')}
                        value={rule.type}
                        options={types.map((type) => ({ value: type, label: type }))}
                        onChange={(nextType) => {
                          const numeric =
                            (rule.type === 'number' || rule.type === 'integer') &&
                            (nextType === 'number' || nextType === 'integer');
                          replace(name, numeric ? { ...rule, type: nextType } : { type: nextType });
                        }}
                      />
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
                      {pick('必須', 'Required')}
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
                      {pick('キーを削除', 'Remove key')}
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
                {pick('JSONキーを追加', 'Add JSON key')}
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
        {pick('ファイル契約を追加', 'Add file contract')}
      </button>
    </div>
  );
}

function PropertyNameInput({
  name,
  onCommit,
}: {
  name: string;
  onCommit: (next: string) => boolean;
}) {
  const { pick } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <label>
      {pick('キー', 'Key')}
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
