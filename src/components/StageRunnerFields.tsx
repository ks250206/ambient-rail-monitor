import type { StageRunner } from '../../shared/graph.ts';
import { useI18n } from '../i18n.ts';
import { CustomSelect } from './CustomSelect.tsx';
import { NumberValue } from './NumberValue.tsx';

const defaults: Record<StageRunner['kind'], StageRunner> = {
  ai: { kind: 'ai', engine: 'worker' },
  command: { kind: 'command', program: 'python3', args: [] },
  python: {
    kind: 'python',
    code: 'import json, os\nfrom pathlib import Path\n\n# RAILFLOW_INPUT_DIR / RAILFLOW_INPUT_ITEM / RAILFLOW_UPSTREAM_MANIFEST\nPath("metrics.json").write_text(json.dumps({"ok": True}))\n',
    args: [],
  },
  http: {
    kind: 'http',
    method: 'GET',
    url: 'http://127.0.0.1:8080/results',
    output: 'response.json',
    body: '',
    successStatus: 200,
    idempotencyKey: false,
  },
  human: { kind: 'human' },
};

export function StageRunnerFields({
  value = defaults.ai,
  onChange,
  disableHuman = false,
  argumentText,
  onArgumentsChange,
}: {
  value?: StageRunner;
  onChange: (next: StageRunner) => void;
  disableHuman?: boolean;
  argumentText?: string;
  onArgumentsChange: (text: string) => void;
}) {
  const { pick } = useI18n();
  return (
    <div id="stage-runner" className="wf-fields">
      <label>
        {pick('工程の種類', 'Stage runner')}
        <CustomSelect
          ariaLabel={pick('工程の種類', 'Stage runner')}
          value={value.kind}
          options={[
            { value: 'ai', label: pick('AIエージェント', 'AI agent') },
            { value: 'command', label: pick('プログラム・シェル', 'Command / shell') },
            { value: 'python', label: 'Python' },
            { value: 'http', label: 'HTTP API' },
            {
              value: 'human',
              label: pick(
                `人間の確認${disableHuman ? '（公開工程は不可）' : ''}`,
                `Human approval${disableHuman ? ' (unavailable on publish stage)' : ''}`,
              ),
              disabled: disableHuman,
            },
          ]}
          onChange={(kind) => onChange(structuredClone(defaults[kind]))}
        />
      </label>
      {value.kind === 'ai' && (
        <label>
          {pick('実行エンジン', 'AI engine')}
          <CustomSelect
            ariaLabel={pick('実行エンジン', 'AI engine')}
            value={value.engine}
            options={[
              { value: 'worker', label: pick('ワーカーの起動モード', 'Worker default mode') },
              { value: 'codex', label: 'Codex' },
              { value: 'claude', label: 'Claude' },
            ]}
            onChange={(engine) => onChange({ ...value, engine })}
          />
        </label>
      )}
      {value.kind === 'command' && (
        <label>
          {pick('実行プログラム', 'Executable program')}
          <input
            value={value.program}
            onChange={(event) => onChange({ ...value, program: event.target.value })}
          />
          <small>
            {pick(
              'シェル処理なら bash と引数 -c を明示してください。',
              'For shell scripts, explicitly specify bash with -c in arguments.',
            )}
          </small>
        </label>
      )}
      {value.kind === 'python' && (
        <label className="wf-wide">
          {pick('Pythonコード', 'Python code')}
          <textarea
            rows={10}
            value={value.code}
            maxLength={32000}
            onChange={(event) => onChange({ ...value, code: event.target.value })}
          />
        </label>
      )}
      {(value.kind === 'command' || value.kind === 'python') && (
        <>
          <label className="wf-wide">
            {pick('引数（1行で1つ）', 'Arguments (one per line)')}
            <textarea
              rows={3}
              value={argumentText ?? value.args.join('\n')}
              onChange={(event) => onArgumentsChange(event.target.value)}
            />
          </label>
          <p className="wf-help wf-wide">
            {pick(
              '入力は環境変数 RAILFLOW_INPUT_DIR、RAILFLOW_INPUT_ITEM、RAILFLOW_UPSTREAM_MANIFEST から参照できます。bash -c 等のシェル文字列には {{...}} を直接埋め込まず、環境変数を使用してください。',
              'Read inputs via RAILFLOW_INPUT_DIR, RAILFLOW_INPUT_ITEM, and RAILFLOW_UPSTREAM_MANIFEST. Avoid interpolating {{...}} directly into bash -c strings; use environment variables instead.',
            )}
          </p>
        </>
      )}
      {value.kind === 'http' && (
        <>
          <label>
            {pick('メソッド', 'HTTP method')}
            <CustomSelect
              ariaLabel={pick('メソッド', 'HTTP method')}
              value={value.method}
              options={[
                { value: 'GET', label: 'GET' },
                { value: 'POST', label: 'POST' },
              ]}
              onChange={(method) => onChange({ ...value, method })}
            />
          </label>
          <label className="wf-wide">
            URL
            <input
              type="url"
              value={value.url}
              onChange={(event) => onChange({ ...value, url: event.target.value })}
            />
          </label>
          {value.method === 'POST' && (
            <>
              <label className="wf-wide">
                {pick('リクエスト本文', 'Request body (JSON)')}
                <textarea
                  rows={4}
                  value={value.body}
                  onChange={(event) => onChange({ ...value, body: event.target.value })}
                />
              </label>
              <label className="wf-check wf-wide">
                <input
                  type="checkbox"
                  checked={value.idempotencyKey}
                  onChange={(event) => onChange({ ...value, idempotencyKey: event.target.checked })}
                />
                {pick(
                  '同じタスクの再試行に同じIdempotency-Keyを送る（接続先の対応が必要）',
                  'Send a stable Idempotency-Key across retries of the same task (endpoint must support it)',
                )}
              </label>
            </>
          )}
          <label>
            {pick('成功ステータス', 'Expected HTTP status')}
            <NumberValue
              value={value.successStatus}
              integer
              onChange={(successStatus) => onChange({ ...value, successStatus })}
            />
          </label>
          <label>
            {pick('レスポンス保存先', 'Response output file')}
            <input
              value={value.output}
              onChange={(event) => onChange({ ...value, output: event.target.value })}
            />
          </label>
          <p className="wf-help wf-wide">
            {pick(
              '応答は最大2 MiB。リダイレクトには追従しません。POSTのリトライにはIdempotency-Keyを有効にしてください。',
              'Max response size 2 MiB; redirects are not followed. Enable Idempotency-Key when retrying POST requests.',
            )}
          </p>
        </>
      )}
      {value.kind === 'human' && (
        <p className="wf-help wf-wide">
          {pick(
            'AIを呼ばず、入力資料とこの工程の指示を表示して承認を待ちます。並列の他工程は続行できます。',
            'Pauses for human review without invoking an AI agent. Independent sibling branches continue running in parallel.',
          )}
        </p>
      )}
    </div>
  );
}
