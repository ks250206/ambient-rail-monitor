# RAILFLOW

[English](README.md)

RAILFLOW はローカル環境で動くプル型のエージェント実行モニターです。Codex CLI や Claude Code CLI を使った科学データ解析ジョブを対象としており、Node.js 26、pnpm 12、Vite+、React 19、TypeScript、Tailwind CSS v4 で構成しています。UI の配色とタイポグラフィには東京科学大学（Institute of Science Tokyo / Science Tokyo）のデザインシステムを取り入れています。

![RAILFLOW のワークフロー概要画面](docs/preview.png)

## 主な画面構成

画面はジョブボードを先頭に配置し、選択したジョブや工程が連動して表示されます。

- ワークフロー定義・LLM 設定・カスタム指示（`/workflow`）: 別ページとして用意しており、このワークフローの目的、受け入れ要件、共通および工程別のモデルと推論エフォート（Codex は `--model` と `-c model_reasoning_effort`、Claude は `--model` と `--effort`）、各工程のカスタム指示を記入して保存できます。保存した内容は `data/workflow-spec.json`（`GET/PUT /api/workflow`）に記録され、ワーカーがジョブを取得したときの実行引数と指示に反映されます。
- ジョブボード（Kanban）: 監視画面（`/`）の先頭に配置し、キュー待ち、実行中、レビュー待ち・停止中、完了の4列でジョブの状態を表示します。参照画像: [カンバンボード](docs/board.png)
- 実行履歴・工程詳細（Actions / Runs）: 実行履歴の一覧と Actions 風の縦タブで各工程を切り替え、右ペインの同一エリア内で「結果の概要」（`summary_<stage>.txt`、未出力時は最終応答から取得）と「ステップログ」をタブ切り替えで確認できます。状態別の絞り込み（active / review / failed）、折りたたみ可能な試行ごとのログ、時刻表示の切り替え、経過時間の更新、検索、レビュー承認、生ログのダウンロードに対応しています。参照画像: [ステップログ](docs/actions.png) / [レビュー画面](docs/review.png)
- トレース・イベント・成果物: 各工程の試行を時間軸に沿って表示し、Science Tokyo の配色と状態ラベル、エージェントのイベント履歴、生成された成果物を確認できます。

## 技術スタック

| 区分                   | 採用技術と詳細                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム             | Node.js 26 以上（`server.ts`、`worker.ts`、`start-demo.ts` をネイティブの TypeScript 実行で動かします）                                                                                                                                        |
| パッケージマネージャー | pnpm 12（`packageManager: pnpm@12.21.0`）                                                                                                                                                                                                      |
| ツールチェーン         | Vite+（`vite-plus` / `vp` CLI。Vite 8 / Rolldown、Vitest、Oxlint、Oxfmt を含みます）                                                                                                                                                           |
| フロントエンド         | React 19、TypeScript、Tailwind CSS v4（`@tailwindcss/vite`）                                                                                                                                                                                   |
| デザインシステム       | Science Tokyo パレット（Science Blue `#1c3177`、Sub color `#7f96c2`、Navy 700 `#435ea5`、背景 `#f2f4f9` / `#e8eaf1`、WCAG 2.1 AA 準拠のコントラスト比）、セルフホストの Noto Sans JP と Hind（`@fontsource/noto-sans-jp`、`@fontsource/hind`） |

> 大学ロゴの扱い: Science Tokyo デザインシステムのガイドラインに従い、公式ロゴ（「Science S」やロゴタイプ）は自作・同梱していません。公式のブランドデータが必要な場合は、学内限定の Science Tokyo デザインシステムから取得してください。

## セットアップと起動

Node.js 26 以上と pnpm 12 以上が必要です。次のコマンドで依存パッケージをインストールし、デモ環境を起動します。

```bash
pnpm install
pnpm run demo
```

起動したらブラウザで `http://127.0.0.1:4173` を開きます。

1. 「Demo run」をクリックすると、XPS データを模したサンプル CSV が生成され、6段階のクイックルック処理が始まります。
2. 開始前に「デモをレビューで一時停止」にチェックを入れると、人間の確認待ちで処理が一時停止します。Shift キーを押しながら「Demo run」をクリックしても同じ動作になります。

フロントエンドの HMR を有効にして開発する場合は、3つのターミナルで次のコマンドをそれぞれ起動します。

```bash
pnpm run dev:server   # ターミナル A: HTTP API、inbox 監視、SSE ストリーム（:4173）
pnpm run dev          # ターミナル B: Vite+ 開発サーバー（:5173、/api と /artifacts をプロキシ）
pnpm run worker:demo  # ターミナル C: デモワーカー（実エージェントは worker:codex / worker:claude）
```

## 利用できるスクリプト

| コマンド                 | 用途                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `pnpm run dev`           | Vite+ 開発サーバーを起動します（`vp dev`）                           |
| `pnpm run build`         | 本番用のフロントエンドを `dist/` にビルドします（`vp build`）        |
| `pnpm run start`         | `dist/` の配信と API サーバーを起動します（`node server.ts`）        |
| `pnpm run demo`          | フロントエンドをビルドし、サーバーとデモワーカーをまとめて起動します |
| `pnpm run worker:demo`   | デモ用のプル型ワーカーを起動します                                   |
| `pnpm run worker:codex`  | Codex CLI を使うプル型ワーカーを起動します                           |
| `pnpm run worker:claude` | Claude Code CLI を使うプル型ワーカーを起動します                     |
| `pnpm run check`         | フォーマット、リント、型チェックを実行します（`vp check`）           |
| `pnpm run test`          | Vitest テストスイートを実行します（`vp test run`）                   |

## デモワーカーの挙動と注意点

デモワーカーは Science Tokyo パレットを使った `report.html` を生成し、`python-pptx` が入っている環境では游ゴシックを使った `report.pptx` もあわせて出力します。また、失敗・再試行ルートの動作を確かめるため、解析（analysis）の段階で再試行を模擬します。

**デモワーカーの出力は記述的なクイックルック処理であり、科学的な XPS ピークフィッティングやピーク帰属ではありません。**

## ファイル構成

```text
index.html           Vite の HTML エントリーポイント
vite.config.ts       Vite+ の統合設定（React、Tailwind CSS v4、プロキシ、lint、fmt、test）
shared/types.ts      イベントとジョブの共有 TypeScript 型定義
src/                 React、TypeScript、Tailwind CSS によるダッシュボード UI
server.ts            fs.watch、ジョブキュー API、JSONL イベントストア、SSE、dist/ 配信サーバー
worker.ts            プル型ワーカー（demo / Codex / Claude アダプター）
start-demo.ts        server.ts とデモワーカーを同時に起動するスクリプト
scripts/             Science Tokyo デザインのクイックルック HTML / PPTX レポート生成スクリプト
tests/               Vitest による API・イベントリプレイ・ヘルパーのテスト
```

## 環境変数とセキュリティ上の注意

デプロイ先や動作環境に合わせて、次の環境変数を設定できます。

- `PORT`
- `HOST`
- `RAILFLOW_HOME`
- `RAILFLOW_URL`
- `RAILFLOW_AGENT_TIMEOUT_MS`
- `RAILFLOW_PYTHON`

このデモはローカルホスト専用（既定のバインド先は `127.0.0.1`）として設計しており、認証機能はありません。
