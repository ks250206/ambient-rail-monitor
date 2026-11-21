export const STARTER_WORKFLOWS = [
  {
    name: 'CSVの一括点検',
    purpose:
      'ファイルごとに行数・列名・空欄数を確認し、一覧レポートを作る。科学的なフィッティングやピーク同定は行わない。',
    graph: { mode: 'dag', maxParallelTasks: 2, publishStage: 'publish' },
    runtime: { revision: 'csv-stdlib-v1' },
    stages: [
      {
        key: 'inspect',
        label: '各CSVを点検',
        short: 'Inspect',
        dependsOn: [],
        map: { pattern: '**/*.csv', maxItems: 100, isolateInput: true },
        cache: { enabled: true, revision: '1' },
        runner: {
          kind: 'python',
          code: `import csv, json, os
from pathlib import Path
relative = os.environ['RAILFLOW_INPUT_ITEM']
with (Path(os.environ['RAILFLOW_INPUT_DIR']) / relative).open(encoding='utf-8-sig', newline='') as f:
    rows = list(csv.reader(f))
header, data = (rows[0], rows[1:]) if rows else ([], [])
result = {'file': relative, 'rows': len(data), 'columns': header, 'empty_cells': sum(not cell.strip() for row in data for cell in row)}
Path('metrics.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
`,
        },
        contracts: {
          outputs: [
            {
              pattern: 'metrics.json',
              schema: {
                type: 'object',
                required: ['file', 'rows', 'columns', 'empty_cells'],
                properties: {
                  rows: { type: 'integer' },
                  empty_cells: { type: 'integer' },
                  columns: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          ],
        },
      },
      {
        key: 'publish',
        label: '一覧を作成',
        short: 'Report',
        dependsOn: ['inspect'],
        runner: {
          kind: 'python',
          code: `import html, json, os
from pathlib import Path
manifest = json.loads(Path(os.environ['RAILFLOW_UPSTREAM_MANIFEST']).read_text())
items = [json.loads((Path(source['directory']) / 'metrics.json').read_text()) for source in manifest['upstream'] if source['stage'] == 'inspect']
rows = ''.join('<tr><td>'+html.escape(x['file'])+'</td><td>'+str(x['rows'])+'</td><td>'+html.escape(', '.join(x['columns']))+'</td><td>'+str(x['empty_cells'])+'</td></tr>' for x in items)
Path('report.html').write_text('<!doctype html><html lang="ja"><meta charset="utf-8"><title>CSV点検</title><style>body{font-family:sans-serif;margin:3rem}td,th{padding:.7rem;border:1px solid #ccc}table{border-collapse:collapse}</style><h1>CSVの一括点検</h1><p>行数・列名・空欄数の記録です。内容の科学的妥当性は別途確認してください。</p><table><tr><th>ファイル</th><th>データ行</th><th>列名</th><th>空欄</th></tr>'+rows+'</table></html>', encoding='utf-8')
`,
        },
      },
    ],
  },
  {
    name: 'AI解析と人間の確認',
    purpose: '根拠と制約を整理し、人間の承認後に結果を公開する。',
    graph: { mode: 'sequential', maxParallelTasks: 1, publishStage: 'publish' },
    stages: [
      {
        key: 'analysis',
        label: '根拠を整理',
        short: 'Analysis',
        instruction: '入力から裏付けられる結果と未解決事項をanalysis.mdに記録してください。',
        contracts: { outputs: [{ pattern: 'analysis.md' }] },
      },
      {
        key: 'review',
        label: '人間の確認',
        short: 'Review',
        runner: { kind: 'human' },
        instruction:
          '上流のanalysis.mdを確認し、前提・根拠・限界を検討してください。採用できる場合のみ承認してください。',
      },
      {
        key: 'publish',
        label: 'レポート公開',
        short: 'Report',
        instruction:
          '上流の承認済みanalysis.mdから、根拠と限界を含む自己完結したreport.htmlを作成してください。',
      },
    ],
  },
];
