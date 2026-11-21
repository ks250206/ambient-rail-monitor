export type Compare = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type Scalar = string | number | boolean;
export type Condition =
  | { op: 'all' | 'any'; children: Condition[] }
  | { op: 'not'; child: Condition }
  | { op: 'file.exists'; pattern: string }
  | { op: 'file.count' | 'file.bytes'; pattern: string; compare: Compare; value: number }
  | { op: 'file.contains'; path: string; text: string }
  | { op: 'json.value'; path: string; field: string; compare: Compare; value: Scalar }
  | { op: 'quiet'; seconds: number }
  | { op: 'name.contains'; value: string };

export type ConditionScope = 'trigger' | 'gate';
export type ConditionStatus = 'pass' | 'fail' | 'error';
export interface ConditionResult {
  status: ConditionStatus;
  label: string;
  message: string;
  actual?: Scalar;
  children?: ConditionResult[];
}
export interface ConditionFacts {
  name: string;
  files: Array<{ path: string; bytes: number }>;
  quietMs: number;
  /** Only files explicitly referenced by text/JSON conditions need to be read. */
  texts: Record<string, { text: string } | { error: string }>;
}

export const COMPARE_LABELS: Record<Compare, string> = {
  eq: 'と等しい',
  ne: 'と異なる',
  gt: 'より大きい',
  gte: '以上',
  lt: '未満',
  lte: '以下',
};
export const CONDITION_LIMITS = { depth: 5, nodes: 64, children: 12 };

/** POSIX relative paths are used in manifests, on every host platform. */
export function validRelativePath(value: string, pattern = false): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') &&
    Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          !/[<>:"|]/.test(part) &&
          (pattern || !/[*?]/.test(part)),
      )
  );
}

export function parseCondition(value: unknown, scope: ConditionScope): Condition | null {
  if (value === null || value === undefined) return null;
  let nodes = 0;
  function read(input: unknown, depth: number): Condition {
    if (++nodes > CONDITION_LIMITS.nodes || depth > CONDITION_LIMITS.depth)
      throw new Error('条件が複雑すぎます（最大64項目・5階層）。');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('条件ブロックの形式が不正です。');
    const item = input as Record<string, unknown>;
    const string = (key: string, limit = 512): string => {
      const raw = item[key];
      if (typeof raw !== 'string' || !raw.trim() || raw.length > limit)
        throw new Error(`条件の ${key} を入力してください（最大${limit}文字）。`);
      return raw;
    };
    const relative = (key: string, pattern = false) => {
      const raw = string(key);
      if (!validRelativePath(raw, pattern))
        throw new Error(
          'パスには相対パスを指定してください。親ディレクトリや絶対パスは使えません。',
        );
      return raw;
    };
    const compare = (): Compare => {
      if (typeof item.compare !== 'string' || !Object.hasOwn(COMPARE_LABELS, item.compare))
        throw new Error('不明な比較演算子です。');
      return item.compare as Compare;
    };
    switch (item.op) {
      case 'all':
      case 'any': {
        if (
          !Array.isArray(item.children) ||
          item.children.length < 1 ||
          item.children.length > CONDITION_LIMITS.children
        )
          throw new Error('条件グループには1〜12個の条件を設定してください。');
        return { op: item.op, children: item.children.map((child) => read(child, depth + 1)) };
      }
      case 'not':
        return { op: 'not', child: read(item.child, depth + 1) };
      case 'file.exists':
        return { op: item.op, pattern: relative('pattern', true) };
      case 'file.count':
      case 'file.bytes': {
        if (typeof item.value !== 'number' || !Number.isSafeInteger(item.value) || item.value < 0)
          throw new Error('ファイル数・バイト数には0以上の整数を指定してください。');
        return {
          op: item.op,
          pattern: relative('pattern', true),
          compare: compare(),
          value: item.value,
        };
      }
      case 'file.contains':
        return { op: item.op, path: relative('path'), text: string('text', 2000) };
      case 'json.value': {
        if (typeof item.value === 'string' && item.value.length > 2000)
          throw new Error('JSON の比較文字列は2000文字以内で指定してください。');
        if (
          !['string', 'boolean', 'number'].includes(typeof item.value) ||
          (typeof item.value === 'number' && !Number.isFinite(item.value))
        )
          throw new Error('比較するJSON値は文字列・数値・真偽値で指定してください。');
        const operator = compare();
        if (operator !== 'eq' && operator !== 'ne' && typeof item.value !== 'number')
          throw new Error('大小比較には数値を指定してください。');
        const field = string('field', 200);
        if (
          field
            .split('.')
            .some((key) => !key || ['__proto__', 'constructor', 'prototype'].includes(key))
        )
          throw new Error('JSONキーの指定が不正です。');
        return {
          op: item.op,
          path: relative('path'),
          field,
          compare: operator,
          value: item.value as Scalar,
        };
      }
      case 'quiet': {
        if (scope !== 'trigger') throw new Error('無変更時間は起動条件でのみ使用できます。');
        if (
          typeof item.seconds !== 'number' ||
          !Number.isInteger(item.seconds) ||
          item.seconds < 0 ||
          item.seconds > 86400
        )
          throw new Error('無変更時間は0〜86400秒で指定してください。');
        return { op: item.op, seconds: item.seconds };
      }
      case 'name.contains':
        return { op: item.op, value: string('value', 120) };
      default:
        throw new Error(`不明な条件ブロック: ${String(item.op)}`);
    }
  }
  return read(value, 1);
}

/** A deliberately small glob language: *, ?, **; no executable expressions. */
export function matchesPattern(filename: string, pattern: string): boolean {
  // Dynamic programming bounds work to O(path length × pattern length).
  // Translating user globs into a backtracking RegExp can block the watcher.
  const chars = Array.from(filename);
  const tokens = Array.from(pattern);
  let previous = Array<boolean>(chars.length + 1).fill(false);
  previous[0] = true;
  for (let i = 0; i < tokens.length; i++) {
    const start = i;
    let token = tokens[i];
    if (token === '*' && tokens[i + 1] === '*') {
      while (tokens[i + 1] === '*') i++;
      token = '**';
      if ((start === 0 || tokens[start - 1] === '/') && tokens[i + 1] === '/') {
        token = '**/';
        i++;
      }
    }
    const current = Array<boolean>(chars.length + 1).fill(false);
    if (token === '*' || token === '**' || token === '**/') current[0] = previous[0];
    let prefix = previous[0];
    for (let j = 1; j <= chars.length; j++) {
      if (token === '**/') current[j] = previous[j] || (chars[j - 1] === '/' && prefix);
      else if (token === '*' || token === '**')
        current[j] = previous[j] || (current[j - 1] && (token === '**' || chars[j - 1] !== '/'));
      else
        current[j] =
          previous[j - 1] && (token === '?' ? chars[j - 1] !== '/' : chars[j - 1] === token);
      prefix ||= previous[j];
    }
    previous = current;
  }
  return previous[chars.length];
}

export function describeCondition(condition: Condition | null): string {
  if (!condition) return '追加条件なし';
  switch (condition.op) {
    case 'all':
    case 'any':
      return `(${condition.children.map(describeCondition).join(condition.op === 'all' ? ' かつ ' : ' または ')})`;
    case 'not':
      return `「${describeCondition(condition.child)}」でない`;
    case 'file.exists':
      return `${condition.pattern} が存在する`;
    case 'file.count':
      return `${condition.pattern} の数が ${condition.value} ${COMPARE_LABELS[condition.compare]}`;
    case 'file.bytes':
      return `${condition.pattern} の合計サイズが ${condition.value} バイト ${COMPARE_LABELS[condition.compare]}`;
    case 'file.contains':
      return `${condition.path} が「${condition.text}」を含む`;
    case 'json.value':
      return `${condition.path} の ${condition.field} が ${JSON.stringify(condition.value)} ${COMPARE_LABELS[condition.compare]}`;
    case 'quiet':
      return `${condition.seconds} 秒間変更されていない`;
    case 'name.contains':
      return `データセット名が「${condition.value}」を含む`;
  }
}

function compareValues(actual: Scalar, expected: Scalar, compare: Compare): boolean {
  switch (compare) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return (actual as number) > (expected as number);
    case 'gte':
      return (actual as number) >= (expected as number);
    case 'lt':
      return (actual as number) < (expected as number);
    case 'lte':
      return (actual as number) <= (expected as number);
  }
}

export function evaluateCondition(
  condition: Condition | null,
  facts: ConditionFacts,
): ConditionResult {
  const label = describeCondition(condition);
  if (!condition) return { status: 'pass', label, message: '追加の自動判定は設定されていません。' };
  const result = (passed: boolean, actual?: Scalar, message?: string): ConditionResult => ({
    status: passed ? 'pass' : 'fail',
    label,
    message: message ?? `実測値: ${JSON.stringify(actual)}`,
    ...(actual !== undefined ? { actual } : {}),
  });
  const error = (message: string): ConditionResult => ({ status: 'error', label, message });
  if (condition.op === 'all' || condition.op === 'any' || condition.op === 'not') {
    const children = (condition.op === 'not' ? [condition.child] : condition.children).map(
      (child) => evaluateCondition(child, facts),
    );
    // Three-valued logic: a known alternative can pass OR, but NOT never turns
    // missing/invalid evidence into success.
    if (!children.length) return { ...error('条件がありません。'), children };
    if (condition.op === 'any' && children.some((child) => child.status === 'pass'))
      return { ...result(true, undefined, 'いずれかの条件を満たしています。'), children };
    if (condition.op === 'all' && children.some((child) => child.status === 'fail'))
      return { ...result(false, undefined, '満たしていない条件があります。'), children };
    if (children.some((child) => child.status === 'error'))
      return { ...error('判定できない条件があります。'), children };
    const passed =
      condition.op === 'not'
        ? children[0].status === 'fail'
        : condition.op === 'all'
          ? children.every((child) => child.status === 'pass')
          : children.some((child) => child.status === 'pass');
    return {
      ...result(passed, undefined, passed ? '条件を満たしています。' : '条件を満たしていません。'),
      children,
    };
  }
  switch (condition.op) {
    case 'file.exists': {
      const count = facts.files.filter((file) =>
        matchesPattern(file.path, condition.pattern),
      ).length;
      return result(count > 0, count, `${count} ファイルが一致`);
    }
    case 'file.count':
    case 'file.bytes': {
      const matched = facts.files.filter((file) => matchesPattern(file.path, condition.pattern));
      const actual =
        condition.op === 'file.count'
          ? matched.length
          : matched.reduce((sum, file) => sum + file.bytes, 0);
      return result(compareValues(actual, condition.value, condition.compare), actual);
    }
    case 'quiet':
      return result(
        facts.quietMs >= condition.seconds * 1000,
        Number.isFinite(facts.quietMs) ? Math.floor(facts.quietMs / 1000) : undefined,
        facts.quietMs === Infinity
          ? '手動投入の転送は完了しています。'
          : `変更停止から ${Math.floor(facts.quietMs / 1000)} 秒`,
      );
    case 'name.contains':
      return result(facts.name.includes(condition.value), facts.name);
    case 'file.contains':
    case 'json.value': {
      const source = facts.texts[condition.path];
      if (!source) return error(`ファイルが見つかりません: ${condition.path}`);
      if ('error' in source) return error(source.error);
      if (condition.op === 'file.contains')
        return result(
          source.text.includes(condition.text),
          undefined,
          source.text.includes(condition.text)
            ? '指定した文字列を確認しました。'
            : '指定した文字列がありません。',
        );
      let actual: unknown;
      try {
        actual = JSON.parse(source.text);
      } catch {
        return error(`${condition.path} は有効なJSONではありません。`);
      }
      for (const key of condition.field.split('.')) {
        if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, key))
          return error(`JSONキーがありません: ${condition.field}`);
        actual = (actual as Record<string, unknown>)[key];
      }
      if (
        typeof actual !== typeof condition.value ||
        (typeof actual === 'number' && !Number.isFinite(actual))
      )
        return error('JSON値の型が条件と一致しません。値の型は自動変換しません。');
      return result(
        compareValues(actual as Scalar, condition.value, condition.compare),
        actual as Scalar,
      );
    }
  }
}

export function referencedPaths(condition: Condition | null): string[] {
  if (!condition) return [];
  if (condition.op === 'all' || condition.op === 'any')
    return [...new Set(condition.children.flatMap(referencedPaths))];
  if (condition.op === 'not') return referencedPaths(condition.child);
  return condition.op === 'json.value' || condition.op === 'file.contains' ? [condition.path] : [];
}

export function failedEvidence(result: ConditionResult): string {
  if (result.children)
    return (
      result.children
        .filter((child) => child.status !== 'pass')
        .map(failedEvidence)
        .filter(Boolean)
        .join('\n') || `${result.label}: ${result.message}`
    );
  return `${result.label}: ${result.message}`;
}
