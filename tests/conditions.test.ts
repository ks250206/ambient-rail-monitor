import { describe, expect, it } from 'vite-plus/test';
import { evaluateCondition, matchesPattern, parseCondition } from '../shared/conditions.ts';
import type { Condition, ConditionFacts } from '../shared/conditions.ts';
import {
  canRetry,
  parseExecution,
  remainingBudget,
  resolveExecution,
  retryDelay,
} from '../shared/execution-policy.ts';
import { expandTemplate, previewVariables } from '../shared/prompts.ts';
import type { ProjectSpec, WorkflowStageSpec } from '../shared/types.ts';

const facts: ConditionFacts = {
  name: 'experiment',
  quietMs: 30000,
  files: [
    { path: 'a/sample.csv', bytes: 10 },
    { path: 'b/sample.csv', bytes: 20 },
    { path: '.ready', bytes: 0 },
  ],
  texts: { 'metrics.json': { text: '{"quality":{"score":0.9,"passed":true}}' } },
};
const metric: Condition = {
  op: 'json.value',
  path: 'metrics.json',
  field: 'quality.score',
  compare: 'gte',
  value: 0.8,
};

describe('bounded no-code condition logic', () => {
  it('matches root and nested glob paths without exponential backtracking', () => {
    for (const value of ['sample.csv', 'a/sample.csv', 'a/b/sample.csv'])
      expect(matchesPattern(value, '**/*.csv')).toBe(true);
    expect(matchesPattern('a/sample.csv', '*.csv')).toBe(false);
    expect(matchesPattern('あ.csv', '?.csv')).toBe(true);
    expect(matchesPattern('a'.repeat(200) + 'b', '*a'.repeat(80) + 'c')).toBe(false);
  });
  it('evaluates nested groups, count, bytes, and typed JSON', () => {
    const condition = parseCondition(
      {
        op: 'all',
        children: [
          { op: 'file.count', pattern: '**/*.csv', compare: 'eq', value: 2 },
          { op: 'file.bytes', pattern: '**/*.csv', compare: 'gte', value: 30 },
          metric,
          { op: 'not', child: { op: 'file.exists', pattern: 'bad.txt' } },
        ],
      },
      'trigger',
    );
    expect(evaluateCondition(condition, facts).status).toBe('pass');
  });
  it('preserves unknown under NOT and supports valid OR alternatives', () => {
    const missing: Condition = { ...metric, field: 'missing' };
    expect(evaluateCondition({ op: 'not', child: missing }, facts).status).toBe('error');
    const alternative = evaluateCondition({ op: 'any', children: [missing, metric] }, facts);
    expect(alternative.status).toBe('pass');
    expect(alternative.children?.[0].status).toBe('error');
    expect(evaluateCondition({ ...metric, value: '0.8', compare: 'eq' }, facts).status).toBe(
      'error',
    );
    expect(
      evaluateCondition(metric, { ...facts, texts: { 'metrics.json': { text: '{broken' } } })
        .status,
    ).toBe('error');
    expect(
      evaluateCondition(
        {
          op: 'not',
          child: { op: 'all', children: [{ op: 'file.exists', pattern: 'missing' }, missing] },
        },
        facts,
      ).status,
    ).toBe('pass');
  });
  it('rejects empty groups, unsafe paths, unsupported fields, and excessive nesting', () => {
    for (const pattern of ['../secret', '/secret', 'C:/secret', 'a\\b', 'a/../b'])
      expect(() => parseCondition({ op: 'file.exists', pattern }, 'gate')).toThrow();
    expect(() => parseCondition({ op: 'all', children: [] }, 'gate')).toThrow();
    expect(() => parseCondition({ op: 'quiet', seconds: 1 }, 'gate')).toThrow();
    expect(() => parseCondition({ ...metric, field: '__proto__.score' }, 'gate')).toThrow();
    let deep: Condition = metric;
    for (let i = 0; i < 6; i++) deep = { op: 'not', child: deep };
    expect(() => parseCondition(deep, 'gate')).toThrow();
  });
});

it('keeps additional retry counts, explicit zero overrides, and time budgets distinct', () => {
  const policy = resolveExecution(
    { maxRetries: 2, attemptTimeoutMs: 1000 },
    { attemptTimeoutMs: 0, retryDelayMs: 50, backoff: 'exponential' },
  );
  expect(policy.attemptTimeoutMs).toBe(0);
  expect([1, 2, 3].map((attempt) => canRetry(policy, 'execution_error', attempt))).toEqual([
    true,
    true,
    false,
  ]);
  expect(canRetry(policy, 'job_timeout', 1)).toBe(false);
  expect(canRetry(resolveExecution({ maxRetries: 0 }), 'timeout', 1)).toBe(false);
  expect([1, 2, 3].map((attempt) => retryDelay(policy, attempt))).toEqual([50, 100, 200]);
  expect(retryDelay(policy, 30)).toBe(3600000);
  expect(remainingBudget(0, 123)).toBe(Infinity);
  expect(remainingBudget(100, 150)).toBe(0);
  expect(() => parseExecution({ maxRetries: -1 })).toThrow();
  expect(() => parseExecution({ attemptTimeoutMs: '1000' })).toThrow();
  expect(() => parseExecution({ toString: 0 })).toThrow();
});

it('expands prompt variables once and rejects unknown names', () => {
  const variables = previewVariables(
    { name: '{{job.id}}' } as ProjectSpec,
    { key: 'fit', label: '解析' } as WorkflowStageSpec,
  );
  expect(expandTemplate('{{project.name}} / {{input.count}}', variables)).toBe('{{job.id}} / 3');
  expect(() => expandTemplate('{{unknown}}', variables)).toThrow('不明なプロンプト変数');
});
