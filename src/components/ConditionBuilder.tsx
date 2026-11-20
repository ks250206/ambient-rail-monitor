import { NumberValue } from './NumberValue.tsx';
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

const TITLES: Record<Condition['op'], string> = {
  all: 'すべて満たす（AND）',
  any: 'いずれかを満たす（OR）',
  not: 'でない（NOT）',
  'file.exists': 'ファイルが存在する',
  'file.count': 'ファイル数',
  'file.bytes': '合計サイズ（バイト）',
  'file.contains': 'テキストを含む',
  'json.value': 'JSON の値',
  quiet: '変更のない時間',
  'name.contains': 'データセット名',
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
        <select
          aria-label={`${label}のテンプレート`}
          value=""
          onChange={(e) => {
            if (e.target.value === 'files')
              onChange({
                op: 'all',
                children: [
                  { op: 'file.count', pattern: '**/*.csv', compare: 'gte', value: 2 },
                  { op: 'file.exists', pattern: '.ready' },
                ],
              });
            if (e.target.value === 'quality')
              onChange({
                op: 'all',
                children: [{ op: 'file.exists', pattern: 'report.html' }, initial('json.value')],
              });
          }}
        >
          <option value="">テンプレートから作成…</option>
          <option value="files">CSV 2件以上 + .ready</option>
          <option value="quality">レポート + JSON 品質判定</option>
        </select>
        {value && (
          <button className="wf-secondary" type="button" onClick={() => onChange(null)}>
            条件を解除
          </button>
        )}
      </div>
      {value ? (
        <ConditionNode value={value} onChange={onChange} scope={scope} depth={1} />
      ) : (
        <button className="wf-secondary" type="button" onClick={() => onChange(initial('all'))}>
          ＋ 条件を追加
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
        パスは入力／作業フォルダからの相対パス。* は同じ階層、** はサブフォルダも対象です。JSON
        の欠損・型違いは判定不能となり、「でない」でも合格にはなりません。
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
  const negated = value.op === 'not';
  const node = negated ? value.child : value;
  const nodeDepth = depth + Number(negated);
  const change = (next: Condition) => onChange(negated ? { op: 'not', child: next } : next);
  const compare = (operator: Compare, update: (value: Compare) => void, numeric = true) => (
    <label>
      比較
      <select value={operator} onChange={(e) => update(e.target.value as Compare)}>
        {Object.entries(COMPARE_LABELS)
          .filter(([key]) => numeric || key === 'eq' || key === 'ne')
          .map(([key, title]) => (
            <option key={key} value={key}>
              {title}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <div className={`condition-block ${negated ? 'is-negated' : ''}`}>
      <div className="condition-toolbar">
        <label>
          条件の種類
          <select
            value={node.op}
            onChange={(e) => change(initial(e.target.value as Condition['op']))}
          >
            {Object.entries(TITLES)
              .filter(
                ([op]) =>
                  op !== 'not' &&
                  (scope === 'trigger' || op !== 'quiet') &&
                  (nodeDepth < CONDITION_LIMITS.depth || (op !== 'all' && op !== 'any')),
              )
              .map(([op, text]) => (
                <option key={op} value={op}>
                  {text}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="wf-secondary condition-not"
          aria-pressed={negated}
          disabled={!negated && depth + height(value) > CONDITION_LIMITS.depth}
          onClick={() => onChange(negated ? node : { op: 'not', child: node })}
        >
          でない（NOT）
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
                  aria-label={`条件 ${i + 1} を削除`}
                  disabled={node.children.length === 1}
                  onClick={() =>
                    change({ ...node, children: node.children.filter((_, index) => index !== i) })
                  }
                >
                  削除
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
              ＋ 条件
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
              ＋ グループ
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
            ファイルパターン
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
            ファイルの相対パス
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
              {node.op === 'file.count' ? '件数' : 'バイト数'}
              <input
                type="number"
                min={0}
                step={1}
                value={node.value}
                onChange={(e) => change({ ...node, value: Number(e.target.value) })}
              />
            </label>
          </>
        )}
        {node.op === 'file.contains' && (
          <label>
            含まれる文字列
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
              JSON キー
              <input
                value={node.field}
                maxLength={200}
                onChange={(e) => change({ ...node, field: e.target.value })}
                placeholder="quality.passed"
              />
            </label>
            <label>
              値の型
              <select
                value={typeof node.value}
                onChange={(e) =>
                  change({
                    ...node,
                    compare: 'eq',
                    value:
                      e.target.value === 'number' ? 0 : e.target.value === 'boolean' ? true : '',
                  })
                }
              >
                <option value="number">数値</option>
                <option value="string">文字列</option>
                <option value="boolean">真偽値</option>
              </select>
            </label>
            {compare(
              node.compare,
              (operator) => change({ ...node, compare: operator }),
              typeof node.value === 'number',
            )}
            <label>
              期待する値
              {typeof node.value === 'boolean' ? (
                <select
                  value={String(node.value)}
                  onChange={(e) => change({ ...node, value: e.target.value === 'true' })}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
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
            無変更時間（秒）
            <input
              type="number"
              min={0}
              max={86400}
              step={1}
              value={node.seconds}
              onChange={(e) => change({ ...node, seconds: Number(e.target.value) })}
            />
          </label>
        )}
        {node.op === 'name.contains' && (
          <label>
            名前に含まれる文字列
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
  const title = { pass: '合格', fail: '不合格', error: '判定不能' }[result.status];
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
