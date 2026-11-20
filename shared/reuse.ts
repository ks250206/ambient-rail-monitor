import { object } from './graph.ts';

export interface RuntimeProfile {
  revision: string;
  python: string;
  expected: Partial<Record<'node' | 'python' | 'codex' | 'claude', string>>;
  packages: Record<string, string>;
}
export interface PriceRate {
  engine: 'codex' | 'claude';
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export interface CachePolicy {
  enabled: boolean;
  revision: string;
}
export interface RuntimeSnapshot {
  version: 1;
  recordedAt: string;
  platform: string;
  arch: string;
  node: string;
  engine: string;
  program: string;
  executableHash: string | null;
  toolVersion: string | null;
  python: string | null;
  packages: Record<string, string>;
  revision: string;
  issues: string[];
}

export const DEFAULT_RUNTIME: RuntimeProfile = {
  revision: '',
  python: '',
  expected: {},
  packages: {},
};
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

const string = (value: unknown, max = 200) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error(`設定は${max}文字以内の文字列にしてください。`);
  return value.trim();
};
export function parseRuntime(value: unknown): RuntimeProfile {
  const raw = object(value ?? DEFAULT_RUNTIME);
  const expected: RuntimeProfile['expected'] = {};
  for (const [key, version] of Object.entries(object(raw.expected ?? {}))) {
    if (!['node', 'python', 'codex', 'claude'].includes(key))
      throw new Error(`不明な実行環境: ${key}`);
    const parsed = string(version, 80);
    if (parsed) expected[key as keyof typeof expected] = parsed;
  }
  const packages: Record<string, string> = {};
  const entries = Object.entries(object(raw.packages ?? {}));
  if (entries.length > 50) throw new Error('固定するPythonパッケージは50件以内にしてください。');
  for (const [key, version] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(key))
      throw new Error('Pythonパッケージ名が不正です。');
    const parsed = string(version, 80);
    if (!parsed) throw new Error('パッケージの固定バージョンを指定してください。');
    const normalized = normalizePackageName(key);
    if (Object.hasOwn(packages, normalized)) throw new Error('Pythonパッケージが重複しています。');
    Object.defineProperty(packages, normalized, { value: parsed, enumerable: true });
  }
  return {
    revision: string(raw.revision ?? '', 120),
    python: string(raw.python ?? '', 512),
    expected,
    packages,
  };
}
export function parseCache(value: unknown): CachePolicy {
  const raw = object(value ?? { enabled: false, revision: '' });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
    throw new Error('キャッシュ設定は真偽値で指定してください。');
  return { enabled: raw.enabled === true, revision: string(raw.revision ?? '', 120) };
}
export function parsePricing(value: unknown): PriceRate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30)
    throw new Error('料金設定は30件以内にしてください。');
  const seen = new Set<string>();
  return value.map((item) => {
    const raw = object(item);
    if (raw.engine !== 'codex' && raw.engine !== 'claude')
      throw new Error('料金のAIエンジンが不正です。');
    const model = string(raw.model, 120);
    if (!model || seen.has(`${raw.engine}/${model}`))
      throw new Error('料金のモデル名が空欄または重複しています。');
    seen.add(`${raw.engine}/${model}`);
    const rate = (key: string) => {
      const n = raw[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1_000_000)
        throw new Error('料金は0〜1,000,000 USD / 100万tokenで指定してください。');
      return n;
    };
    return {
      engine: raw.engine,
      model,
      input: rate('input'),
      cacheRead: rate('cacheRead'),
      cacheWrite: rate('cacheWrite'),
      output: rate('output'),
    };
  });
}

export function runtimeIssues(profile: RuntimeProfile, snapshot: RuntimeSnapshot): string[] {
  const issues: string[] = [];
  const actual = {
    node: snapshot.node,
    python: snapshot.python,
    codex: snapshot.engine === 'codex' ? snapshot.toolVersion : null,
    claude: snapshot.engine === 'claude' ? snapshot.toolVersion : null,
  };
  for (const [key, expected] of Object.entries(profile.expected)) {
    // Engine requirements apply to attempts using that engine, not unrelated scripts.
    if ((key === 'codex' || key === 'claude') && snapshot.engine !== key) continue;
    if (actual[key as keyof typeof actual] !== expected)
      issues.push(
        `${key}: 要求 ${expected} / 実際 ${actual[key as keyof typeof actual] ?? '未取得'}`,
      );
  }
  for (const [name, expected] of Object.entries(profile.packages))
    if (snapshot.packages[name] !== expected)
      issues.push(`${name}: 要求 ${expected} / 実際 ${snapshot.packages[name] ?? '未導入'}`);
  return issues;
}

/** JSON object key order must not change template/cache identity. */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
