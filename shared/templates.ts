import { createHash } from 'node:crypto';
import { canonical } from './reuse.ts';
import type { ProjectSpec } from './types.ts';

const FIELDS = [
  'name',
  'purpose',
  'acceptanceCriteria',
  'llm',
  'stages',
  'input',
  'execution',
  'jobTimeoutMs',
  'finalGate',
  'prompt',
  'queue',
  'graph',
  'runtime',
  'pricing',
] as const;
export type PortableWorkflow = Pick<ProjectSpec, (typeof FIELDS)[number]>;
export interface WorkflowTemplate {
  format: 'ambient-rail-monitor.workflow';
  formatVersion: 1;
  template: { name: string; revision: string; hash: string };
  definition: PortableWorkflow;
}
export function portable(project: ProjectSpec): PortableWorkflow {
  return Object.fromEntries(
    FIELDS.filter((key) => project[key] !== undefined).map((key) => [
      key,
      structuredClone(project[key]),
    ]),
  ) as PortableWorkflow;
}
export function templateOrigin(value: unknown): WorkflowTemplate['template'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('テンプレートの出典が不正です。');
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.name !== 'string' ||
    !raw.name.trim() ||
    raw.name.length > 120 ||
    typeof raw.revision !== 'string' ||
    !raw.revision.trim() ||
    raw.revision.length > 80 ||
    typeof raw.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.hash)
  )
    throw new Error('テンプレート名・版・hashを確認してください。');
  return { name: raw.name.trim(), revision: raw.revision.trim(), hash: raw.hash };
}
export function exportTemplate(
  project: ProjectSpec,
  name: string,
  revision: string,
): WorkflowTemplate {
  const definition = portable(project);
  const hash = createHash('sha256').update(canonical(definition)).digest('hex');
  return {
    format: 'ambient-rail-monitor.workflow',
    formatVersion: 1,
    template: templateOrigin({ name, revision, hash })!,
    definition,
  };
}
export function parseWorkflowTemplate(value: unknown): WorkflowTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('ワークフローテンプレートJSONを指定してください。');
  const raw = value as Record<string, unknown>;
  if (raw.format !== 'ambient-rail-monitor.workflow' || raw.formatVersion !== 1)
    throw new Error('対応するテンプレート形式はformatVersion 1です。');
  const template = templateOrigin(raw.template);
  if (
    !template ||
    !raw.definition ||
    typeof raw.definition !== 'object' ||
    Array.isArray(raw.definition)
  )
    throw new Error('テンプレート定義がありません。');
  const definition = raw.definition as Record<string, unknown>;
  const readText = (value: unknown, label: string, max: number, required = false) => {
    if (
      typeof value !== 'string' ||
      value.length > max ||
      value.includes('\0') ||
      (required && !value.trim())
    )
      throw new Error(`${label}は${max}文字以内の文字列にしてください。`);
  };
  const readLlm = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('モデル設定が不正です。');
    const config = value as Record<string, unknown>;
    if (Object.keys(config).some((key) => key !== 'model' && key !== 'effort'))
      throw new Error('モデル設定に未対応の項目が含まれています。');
    readText(config.model, 'モデル名', 100);
    if (!/^[A-Za-z0-9._:/-]*$/.test(String(config.model)))
      throw new Error('モデル名の文字が不正です。');
    if (
      typeof config.effort !== 'string' ||
      !['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort)
    )
      throw new Error('推論設定が不正です。');
  };
  readText(definition.name, 'プロジェクト名', 120, true);
  readText(definition.purpose, '説明', 2000);
  readText(definition.acceptanceCriteria, '全体の受け入れ要件', 4000);
  readLlm(definition.llm);
  if (Object.keys(definition).some((key) => !(FIELDS as readonly string[]).includes(key)))
    throw new Error('テンプレートに未対応の設定または保存先が含まれています。');
  if (
    !Array.isArray(definition.stages) ||
    !definition.stages.length ||
    definition.stages.length > 50
  )
    throw new Error('テンプレートの工程数は1〜50件です。');
  const keys = definition.stages.map((stage) => stage?.key);
  if (
    keys.some((key) => typeof key !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(key)) ||
    new Set(keys).size !== keys.length
  )
    throw new Error('工程キーの形式または重複を確認してください。');
  const stageFields = [
    'key',
    'label',
    'short',
    'instruction',
    'llm',
    'acceptanceCriteria',
    'gate',
    'execution',
    'runner',
    'dependsOn',
    'map',
    'contracts',
    'cache',
  ];
  for (const stage of definition.stages) {
    if (
      !stage ||
      typeof stage !== 'object' ||
      Array.isArray(stage) ||
      Object.keys(stage).some((key) => !stageFields.includes(key))
    )
      throw new Error('テンプレートに未対応の工程設定があります。');
    readText(stage.label, '工程名', 80, true);
    readText(stage.short, '短縮名', 40, true);
    readText(stage.instruction, '工程の指示', 8000);
    readLlm(stage.llm);
  }
  const hash = createHash('sha256').update(canonical(definition)).digest('hex');
  if (hash !== template.hash)
    throw new Error('テンプレートの内容とhashが一致しません。保存元から書き出し直してください。');
  return {
    format: 'ambient-rail-monitor.workflow',
    formatVersion: 1,
    template,
    definition: structuredClone(definition) as PortableWorkflow,
  };
}
