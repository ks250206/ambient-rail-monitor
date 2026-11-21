import { NumberValue } from './NumberValue.tsx';
import { CustomSelect } from './CustomSelect.tsx';
import {
  COMPARE_LABELS,
  CONDITION_LIMITS,
  describeCondition,
  parseCondition,
} from '../../shared/conditions.ts';
import type {
  Compare,
  Condition,
  ConditionResult,
  ConditionScope,
} from '../../shared/conditions.ts';
import { useI18n } from '../i18n.ts';

const TITLES: Record<Condition['op'], { ja: string; en: string }> = {
  all: { ja: 'すべて満たす（AND）', en: 'Match all (AND)' },
  any: { ja: 'いずれかを満たす（OR）', en: 'Match any (OR)' },
  not: { ja: 'でない（NOT）', en: 'Negate (NOT)' },
  'file.exists': { ja: 'ファイルが存在する', en: 'File exists' },
  'file.count': { ja: 'ファイル数', en: 'File count' },
  'file.bytes': { ja: '合計サイズ（バイト）', en: 'Total bytes' },
  'file.contains': { ja: 'テキストを含む', en: 'Text contains' },
  'json.value': { ja: 'JSON の値', en: 'JSON value' },
  quiet: { ja: '変更のない時間', en: 'Quiet duration' },
  'name.contains': { ja: 'データセット名', en: 'Dataset name' },
};

const COMPARE_LABELS_EN: Record<Compare, string> = {
  eq: 'equals (=)',
  ne: 'not equals (≠)',
  gt: 'greater than (>)',
  gte: 'at least (≥)',
  lt: 'less than (<)',
  lte: 'at most (≤)',
};

function initial(op: Condition['op']): Condition {
  switch (op) {
    case 'all':
    case 'any':
      return { op, children: [initial('file.exists')] };
    case 'not':
      return { op, child: initial('file.exists') };
    case 'file.exists':
      return { op, pattern: '**/*.csv' };
    case 'file.count':
    case 'file.bytes':
      return { op, pattern: '**/*.csv', compare: 'gte', value: op === 'file.count' ? 2 : 1 };
    case 'file.contains':
      return { op, path: 'summary.txt', text: '完了' };
    case 'json.value':
      return { op, path: 'metrics.json', field: 'quality.passed', compare: 'eq', value: true };
    case 'quiet':
      return { op, seconds: 30 };
    case 'name.contains':
      return { op, value: '測定' };
  }
}

export function ConditionBuilder({
  value,
  onChange,
  scope,
  label,
}: {
  value: Condition | null;
  onChange: (value: Condition | null) => void;
  scope: ConditionScope;
  label: string;
}) {
  const { pick } = useI18n();
  let error = '';
  try {
    parseCondition(value, scope);
  } catch (err) {
    error = (err as Error).message;
  }
  return (
    <div className="condition-editor" aria-label={label}>
      <div className="condition-toolbar">
        <strong>{label}</strong>
        <div className="min-w-[200px]">
          <CustomSelect
            ariaLabel={pick(`${label}のテンプレート`, `${label} presets`)}
            value=""
            placeholder={pick('テンプレートから作成…', 'Start from preset…')}
            options={[
              { value: 'files', label: pick('CSV 2件以上 + .ready', '2+ CSV files + .ready') },
              {
                value: 'quality',
                label: pick('レポート + JSON 品質判定', 'Report + JSON quality check'),
              },
            ]}
            onChange={(preset) => {
              if (preset === 'files')
                onChange({
                  op: 'all',
                  children: [
                    { op: 'file.count', pattern: '**/*.csv', compare: 'gte', value: 2 },
                    { op: 'file.exists', pattern: '.ready' },
                  ],
                });
              if (preset === 'quality')
                onChange({
                  op: 'all',
                  children: [{ op: 'file.exists', pattern: 'report.html' }, initial('json.value')],
                });
            }}
          />
        </div>
        {value && (
          <button className="wf-secondary" type="button" onClick={() => onChange(null)}>
            {pick('条件を解除', 'Clear condition')}
          </button>
        )}
      </div>
      {value ? (
        <ConditionNode value={value} onChange={onChange} scope={scope} depth={1} />
      ) : (
        <button className="wf-secondary" type="button" onClick={() => onChange(initial('all'))}>
          {pick('＋ 条件を追加', '+ Add condition')}
        </button>
      )}
      <p className="condition-sentence" aria-live="polite">
        {describeCondition(value)}
      </p>
      {error && (
        <p className="condition-error" role="alert">
          {error}
        </p>
      )}
      <p className="wf-help">
        {pick(
          'パスは入力／作業フォルダからの相対パス。* は同じ階層、** はサブフォルダも対象です。JSON の欠損・型違いは判定不能となり、「でない」でも合格にはなりません。',
          'Paths are relative to the input/workspace directory (* matches one level, ** includes subdirectories). Missing JSON keys or type mismatches evaluate to unknown, and NOT does not turn unknown into pass.',
        )}
      </p>
    </div>
  );
}

function height(node: Condition): number {
  if (node.op === 'all' || node.op === 'any') return 1 + Math.max(...node.children.map(height));
  return node.op === 'not' ? 1 + height(node.child) : 1;
}

function ConditionNode({
  value,
  onChange,
  scope,
  depth,
}: {
  value: Condition;
  onChange: (next: Condition) => void;
  scope: ConditionScope;
  depth: number;
}) {
  const { locale, pick } = useI18n();
  const negated = value.op === 'not';
  const node = negated ? value.child : value;
  const nodeDepth = depth + Number(negated);
  const change = (next: Condition) => onChange(negated ? { op: 'not', child: next } : next);
  const compare = (operator: Compare, update: (value: Compare) => void, numeric = true) => (
    <label>
      {pick('比較', 'Compare')}
      <CustomSelect
        ariaLabel={pick('比較', 'Compare')}
        value={operator}
        options={Object.entries(COMPARE_LABELS)
          .filter(([key]) => numeric || key === 'eq' || key === 'ne')
          .map(([key, title]) => ({
            value: key as Compare,
            label: locale === 'en' ? COMPARE_LABELS_EN[key as Compare] : title,
          }))}
        onChange={update}
      />
    </label>
  );
  const opOptions = (Object.entries(TITLES) as Array<[Condition['op'], { ja: string; en: string }]>)
    .filter(
      ([op]) =>
        (op !== 'not' || node.op === 'not') &&
        (scope === 'trigger' || op !== 'quiet') &&
        (nodeDepth < CONDITION_LIMITS.depth || (op !== 'all' && op !== 'any')),
    )
    .map(([op, text]) => ({ value: op, label: pick(text.ja, text.en) }));

  return (
    <div className={`condition-block ${negated ? 'is-negated' : ''}`}>
      <div className="condition-toolbar">
        <label className="min-w-[180px]">
          {pick('条件の種類', 'Condition type')}
          <CustomSelect
            ariaLabel={pick('条件の種類', 'Condition type')}
            value={node.op}
            options={opOptions}
            onChange={(nextOp) => change(initial(nextOp))}
          />
        </label>
        <button
          type="button"
          className="wf-secondary condition-not"
          aria-pressed={negated}
          disabled={!negated && depth + height(value) > CONDITION_LIMITS.depth}
          onClick={() => onChange(negated ? node : { op: 'not', child: node })}
        >
          {pick('でない（NOT）', 'Negate (NOT)')}
        </button>
      </div>
      {(node.op === 'all' || node.op === 'any') && (
        <>
          <div className="condition-children">
            {node.children.map((child, i) => (
              <div key={i} className="condition-child">
                <ConditionNode
                  value={child}
                  onChange={(next) =>
                    change({
                      ...node,
                      children: node.children.map((item, index) => (index === i ? next : item)),
                    })
                  }
                  scope={scope}
                  depth={nodeDepth + 1}
                />
                <button
                  type="button"
                  className="wf-secondary"
                  aria-label={pick(`条件 ${i + 1} を削除`, `Remove condition ${i + 1}`)}
                  disabled={node.children.length === 1}
                  onClick={() =>
                    change({ ...node, children: node.children.filter((_, index) => index !== i) })
                  }
                >
                  {pick('削除', 'Remove')}
                </button>
              </div>
            ))}
          </div>
          <div className="condition-toolbar">
            <button
              type="button"
              className="wf-secondary"
              disabled={
                node.children.length >= CONDITION_LIMITS.children ||
                nodeDepth >= CONDITION_LIMITS.depth
              }
              onClick={() =>
                change({ ...node, children: [...node.children, initial('file.exists')] })
              }
            >
              {pick('＋ 条件', '+ Condition')}
            </button>
            <button
              type="button"
              className="wf-secondary"
              disabled={
                node.children.length >= CONDITION_LIMITS.children ||
                nodeDepth + 1 >= CONDITION_LIMITS.depth
              }
              onClick={() => change({ ...node, children: [...node.children, initial('all')] })}
            >
              {pick('＋ グループ', '+ Group')}
            </button>
          </div>
        </>
      )}
      {node.op === 'not' && (
        <ConditionNode value={node} onChange={change} scope={scope} depth={nodeDepth} />
      )}
      <div className="condition-fields">
        {'pattern' in node && (
          <label>
            {pick('ファイルパターン', 'File pattern')}
            <input
              value={node.pattern}
              maxLength={512}
              onChange={(e) => change({ ...node, pattern: e.target.value })}
              placeholder="**/*.csv"
            />
          </label>
        )}
        {'path' in node && (
          <label>
            {pick('ファイルの相対パス', 'Relative file path')}
            <input
              value={node.path}
              maxLength={512}
              onChange={(e) => change({ ...node, path: e.target.value })}
            />
          </label>
        )}
        {(node.op === 'file.count' || node.op === 'file.bytes') && (
          <>
            {compare(node.compare, (operator) => change({ ...node, compare: operator }))}
            <label>
              {node.op === 'file.count' ? pick('件数', 'Count') : pick('バイト数', 'Bytes')}
              <NumberValue
                value={node.value}
                integer
                onChange={(value) => change({ ...node, value })}
              />
            </label>
          </>
        )}
        {node.op === 'file.contains' && (
          <label>
            {pick('含まれる文字列', 'Text to match')}
            <input
              value={node.text}
              maxLength={2000}
              onChange={(e) => change({ ...node, text: e.target.value })}
            />
          </label>
        )}
        {node.op === 'json.value' && (
          <>
            <label>
              {pick('JSON キー', 'JSON key')}
              <input
                value={node.field}
                maxLength={200}
                onChange={(e) => change({ ...node, field: e.target.value })}
                placeholder="quality.passed"
              />
            </label>
            <label>
              {pick('値の型', 'Value type')}
              <CustomSelect
                ariaLabel={pick('値の型', 'Value type')}
                value={typeof node.value as 'number' | 'string' | 'boolean'}
                options={[
                  { value: 'number', label: pick('数値', 'Number') },
                  { value: 'string', label: pick('文字列', 'String') },
                  { value: 'boolean', label: pick('真偽値', 'Boolean') },
                ]}
                onChange={(nextType) =>
                  change({
                    ...node,
                    compare: 'eq',
                    value: nextType === 'number' ? 0 : nextType === 'boolean' ? true : '',
                  })
                }
              />
            </label>
            {compare(
              node.compare,
              (operator) => change({ ...node, compare: operator }),
              typeof node.value === 'number',
            )}
            <label>
              {pick('期待する値', 'Expected value')}
              {typeof node.value === 'boolean' ? (
                <CustomSelect
                  ariaLabel={pick('期待する値', 'Expected value')}
                  value={String(node.value) as 'true' | 'false'}
                  options={[
                    { value: 'true', label: 'true' },
                    { value: 'false', label: 'false' },
                  ]}
                  onChange={(next) => change({ ...node, value: next === 'true' })}
                />
              ) : typeof node.value === 'number' ? (
                <NumberValue value={node.value} onChange={(value) => change({ ...node, value })} />
              ) : (
                <input
                  value={node.value}
                  maxLength={2000}
                  onChange={(e) => change({ ...node, value: e.target.value })}
                />
              )}
            </label>
          </>
        )}
        {node.op === 'quiet' && (
          <label>
            {pick('無変更時間（秒）', 'Quiet seconds')}
            <NumberValue
              value={node.seconds}
              integer
              onChange={(seconds) => change({ ...node, seconds })}
            />
          </label>
        )}
        {node.op === 'name.contains' && (
          <label>
            {pick('名前に含まれる文字列', 'Substring in dataset name')}
            <input
              value={node.value}
              maxLength={120}
              onChange={(e) => change({ ...node, value: e.target.value })}
            />
          </label>
        )}
      </div>
    </div>
  );
}

export function ConditionEvidence({ result }: { result: ConditionResult }) {
  const { pick } = useI18n();
  const title = {
    pass: pick('合格', 'Pass'),
    fail: pick('不合格', 'Fail'),
    error: pick('判定不能', 'Unknown'),
  }[result.status];
  return (
    <div className={`condition-evidence evidence-${result.status}`}>
      <div>
        <strong>{title}</strong> <span>{result.label}</span>
      </div>
      <p>{result.message}</p>
      {result.children && (
        <div className="evidence-children">
          {result.children.map((child, i) => (
            <ConditionEvidence key={i} result={child} />
          ))}
        </div>
      )}
    </div>
  );
}
