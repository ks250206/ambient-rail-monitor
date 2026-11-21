import type { WorkflowStageSpec } from './types.ts';

export interface ExecutionDetailField {
  label: string;
  value: string;
}
export interface ExecutionDetail {
  key: string;
  label: string;
  kind: 'command' | 'python' | 'http';
  fields: ExecutionDetailField[];
}

/** Arguments as a JSON array keep boundaries visible when an argument contains spaces. */
const argv = (args: readonly string[]) => JSON.stringify(args);

/**
 * Everything a local-execution stage runs or sends, for confirming an external template.
 * Browser-safe: no Node imports.
 */
export function executionDetails(stages: readonly WorkflowStageSpec[]): ExecutionDetail[] {
  const details: ExecutionDetail[] = [];
  for (const stage of stages) {
    const runner = stage.runner;
    if (runner?.kind === 'command')
      details.push({
        key: stage.key,
        label: stage.label,
        kind: 'command',
        fields: [
          { label: '実行ファイル', value: runner.program },
          { label: '引数（JSON配列）', value: argv(runner.args) },
        ],
      });
    else if (runner?.kind === 'python')
      details.push({
        key: stage.key,
        label: stage.label,
        kind: 'python',
        fields: [
          { label: 'Pythonコード', value: runner.code },
          { label: '引数（JSON配列）', value: argv(runner.args) },
        ],
      });
    else if (runner?.kind === 'http')
      details.push({
        key: stage.key,
        label: stage.label,
        kind: 'http',
        fields: [
          { label: '接続先', value: `${runner.method} ${runner.url}` },
          { label: '送信本文', value: runner.body || '（なし）' },
          { label: '応答の保存先', value: runner.output },
        ],
      });
  }
  return details;
}
