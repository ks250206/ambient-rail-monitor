import { validRelativePath } from './conditions.ts';
import { boundedInteger } from './execution-policy.ts';

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}
export interface FileContract {
  pattern: string;
  minFiles: number;
  maxFiles: number;
  schema?: JsonSchema;
  source?: 'dataset' | 'upstream';
}
const allowed = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
]);

/** Deliberately bounded JSON Schema subset; unsupported keywords are rejected, never ignored. */
export function parseSchema(value: unknown): JsonSchema {
  let nodes = 0;
  const parse = (input: unknown, depth: number): JsonSchema => {
    if (++nodes > 64 || depth > 6 || !input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('JSON Schemaは64項目・6階層以内にしてください。');
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !allowed.has(key)))
      throw new Error('未対応のJSON Schemaキーワードです。対応範囲を確認してください。');
    if (
      !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
        String(raw.type),
      )
    )
      throw new Error('JSON Schemaのtypeを指定してください。');
    const result: JsonSchema = { type: raw.type as JsonSchema['type'] };
    if (raw.properties !== undefined) {
      if (!raw.properties || typeof raw.properties !== 'object' || Array.isArray(raw.properties))
        throw new Error('propertiesが不正です。');
      result.properties = Object.fromEntries(
        Object.entries(raw.properties).map(([key, entry]) => {
          if (!key || key.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(key))
            throw new Error('JSONキーが不正です。');
          return [key, parse(entry, depth + 1)];
        }),
      );
    }
    if (raw.required !== undefined) {
      if (
        !Array.isArray(raw.required) ||
        raw.required.length > 64 ||
        raw.required.some((key) => typeof key !== 'string' || key.length > 120)
      )
        throw new Error('requiredが不正です。');
      result.required = [...new Set(raw.required)] as string[];
    }
    if (raw.additionalProperties !== undefined) {
      if (typeof raw.additionalProperties !== 'boolean')
        throw new Error('additionalPropertiesは真偽値です。');
      result.additionalProperties = raw.additionalProperties;
    }
    if (raw.items !== undefined) result.items = parse(raw.items, depth + 1);
    if (raw.enum !== undefined) {
      if (
        !Array.isArray(raw.enum) ||
        !raw.enum.length ||
        raw.enum.length > 100 ||
        raw.enum.some(
          (entry) => entry !== null && !['string', 'number', 'boolean'].includes(typeof entry),
        )
      )
        throw new Error('enumは100件以内の文字列・数値・真偽値・nullです。');
      result.enum = raw.enum as JsonSchema['enum'];
    }
    for (const key of ['minimum', 'maximum'] as const)
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))
          throw new Error(`${key}は有限の数値です。`);
        result[key] = raw[key];
      }
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const)
      if (raw[key] !== undefined) result[key] = boundedInteger(raw[key], key, 1_000_000);
    for (const [min, max] of [
      ['minimum', 'maximum'],
      ['minItems', 'maxItems'],
      ['minLength', 'maxLength'],
    ] as const)
      if (result[min] !== undefined && result[max] !== undefined && result[min]! > result[max]!)
        throw new Error('JSON Schemaの最小値が最大値を超えています。');
    return result;
  };
  return parse(value, 1);
}

export function validateJson(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];
  let visited = 0;
  const visit = (data: unknown, rule: JsonSchema, field: string) => {
    if (++visited > 100_000) throw new Error('JSONの検証項目が上限を超えています。');
    if (errors.length >= 20) return;
    const matches =
      rule.type === 'null'
        ? data === null
        : rule.type === 'array'
          ? Array.isArray(data)
          : rule.type === 'object'
            ? !!data && typeof data === 'object' && !Array.isArray(data)
            : rule.type === 'integer'
              ? Number.isSafeInteger(data)
              : rule.type === 'number'
                ? typeof data === 'number' && Number.isFinite(data)
                : typeof data === rule.type;
    if (!matches) {
      errors.push(`${field}: ${rule.type} が必要です`);
      return;
    }
    if (rule.enum && !rule.enum.some((entry) => entry === data))
      errors.push(`${field}: enumにありません`);
    if (typeof data === 'number') {
      if (rule.minimum !== undefined && data < rule.minimum)
        errors.push(`${field}: 最小値 ${rule.minimum} 未満`);
      if (rule.maximum !== undefined && data > rule.maximum)
        errors.push(`${field}: 最大値 ${rule.maximum} 超過`);
    }
    if (typeof data === 'string') {
      const length = Array.from(data).length;
      if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity))
        errors.push(`${field}: 文字数が範囲外`);
    }
    if (Array.isArray(data)) {
      if (data.length < (rule.minItems ?? 0) || data.length > (rule.maxItems ?? Infinity))
        errors.push(`${field}: 要素数が範囲外`);
      if (rule.items) data.forEach((item, i) => visit(item, rule.items!, `${field}[${i}]`));
    } else if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      for (const key of rule.required ?? [])
        if (!Object.hasOwn(record, key)) errors.push(`${field}.${key}: 必須です`);
      for (const [key, entry] of Object.entries(rule.properties ?? {}))
        if (Object.hasOwn(record, key)) visit(record[key], entry, `${field}.${key}`);
      if (rule.additionalProperties === false)
        for (const key of Object.keys(record))
          if (!Object.hasOwn(rule.properties ?? {}, key))
            errors.push(`${field}.${key}: 未定義のキー`);
    }
  };
  visit(value, schema, '$');
  return errors.slice(0, 20);
}

export function parseContracts(value: unknown): FileContract[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('ファイル契約は20件以内です。');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('ファイル契約が不正です。');
    const raw = item as Record<string, unknown>;
    if (typeof raw.pattern !== 'string' || !validRelativePath(raw.pattern, true))
      throw new Error('契約には相対パスのパターンを指定してください。');
    const minFiles = boundedInteger(raw.minFiles ?? 1, '最小ファイル数', 5000);
    const maxFiles = boundedInteger(raw.maxFiles ?? 5000, '最大ファイル数', 5000);
    if (minFiles > maxFiles) throw new Error('最小ファイル数が最大値を超えています。');
    if (raw.source !== undefined && raw.source !== 'dataset' && raw.source !== 'upstream')
      throw new Error('入力契約の参照元が不正です。');
    return {
      pattern: raw.pattern,
      minFiles,
      maxFiles,
      ...(raw.schema ? { schema: parseSchema(raw.schema) } : {}),
      ...(raw.source ? { source: raw.source as 'dataset' | 'upstream' } : {}),
    };
  });
}
