import type { StageRunner } from '../../shared/graph.ts';
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
  return (
    <div id="stage-runner" className="wf-fields">
      <label>
        工程の種類
        <select
          value={value.kind}
          onChange={(event) =>
            onChange(structuredClone(defaults[event.target.value as StageRunner['kind']]))
          }
        >
          <option value="ai">AIエージェント</option>
          <option value="command">プログラム・シェル</option>
          <option value="python">Python</option>
          <option value="http">HTTP API</option>
          <option value="human" disabled={disableHuman}>
            人間の確認{disableHuman ? '（公開工程は不可）' : ''}
          </option>
        </select>
      </label>
      {value.kind === 'ai' && (
        <label>
          実行エンジン
          <select
            value={value.engine}
            onChange={(event) =>
              onChange({ ...value, engine: event.target.value as 'worker' | 'codex' | 'claude' })
            }
          >
            <option value="worker">ワーカーの起動モード</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
      )}
      {value.kind === 'command' && (
        <label>
          実行プログラム
          <input
            value={value.program}
            onChange={(event) => onChange({ ...value, program: event.target.value })}
          />
          <small>シェル処理なら bash と引数 -c を明示してください。</small>
        </label>
      )}
      {value.kind === 'python' && (
        <label className="wf-wide">
          Pythonコード
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
            引数（1行で1つ）
            <textarea
              rows={3}
              value={argumentText ?? value.args.join('\n')}
              onChange={(event) => onArgumentsChange(event.target.value)}
            />
          </label>
          <p className="wf-help wf-wide">
            入力は環境変数 RAILFLOW_INPUT_DIR、RAILFLOW_INPUT_ITEM、RAILFLOW_UPSTREAM_MANIFEST
            から参照できます。bash -c 等のシェル文字列には {'{{...}}'}{' '}
            を直接埋め込まず、環境変数を使用してください。
          </p>
        </>
      )}
      {value.kind === 'http' && (
        <>
          <label>
            メソッド
            <select
              value={value.method}
              onChange={(event) =>
                onChange({ ...value, method: event.target.value as 'GET' | 'POST' })
              }
            >
              <option>GET</option>
              <option>POST</option>
            </select>
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
                リクエスト本文
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
                同じタスクの再試行に同じIdempotency-Keyを送る（接続先の対応が必要）
              </label>
            </>
          )}
          <label>
            成功ステータス
            <NumberValue
              value={value.successStatus}
              integer
              onChange={(successStatus) => onChange({ ...value, successStatus })}
            />
          </label>
          <label>
            レスポンス保存先
            <input
              value={value.output}
              onChange={(event) => onChange({ ...value, output: event.target.value })}
            />
          </label>
          <p className="wf-help wf-wide">
            応答は最大2
            MiB。リダイレクトには追従しません。POSTのリトライにはIdempotency-Keyを有効にしてください。
          </p>
        </>
      )}
      {value.kind === 'human' && (
        <p className="wf-help wf-wide">
          AIを呼ばず、入力資料とこの工程の指示を表示して承認を待ちます。並列の他工程は続行できます。
        </p>
      )}
    </div>
  );
}
