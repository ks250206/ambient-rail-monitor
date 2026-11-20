# RAILFLOW — Ambient Agent Workflow Observatory

A local-first proof of concept for **pull-based Codex / Claude Code scientific-analysis jobs**, styled with the **Institute of Science Tokyo (東京科学大学 / Science Tokyo)** design system and built with **Node.js 26, pnpm 12, Vite+, React 19, TypeScript, and Tailwind CSS v4**.

![RAILFLOW workflow overview](docs/preview.png)

Four synchronized operational views:

- **Actions / Runs** — GitHub Actions-inspired run history, active/review/failed status filtering, step list, collapsible attempts, expandable timestamped logs, live durations, search, and raw log download. [Step logs](docs/actions.png) · [Review gate](docs/review.png)
- **Kanban** — queue, running, review/blocked, completed. [Job board](docs/board.png)
- **Railway execution** — stage-by-stage success and failure/retry routes, human review gate, and step inspector.
- **Trace explorer** — individual execution attempts rendered against elapsed time with Science Tokyo colors and visible status labels, raw agent events, and artifacts.

## Tech stack

- **Runtime**: Node.js 26+ (native TypeScript execution for `server.ts`, `worker.ts`, and `start-demo.ts`)
- **Package manager**: pnpm 12 (`packageManager: pnpm@12.21.0`)
- **Toolchain**: Vite+ (`vite-plus` / `vp` CLI — Vite 8 / Rolldown, Vitest, Oxlint, Oxfmt)
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 (`@tailwindcss/vite`)
- **Design system**: Science Tokyo palette (`#1c3177` Science Blue, `#7f96c2` Sub color, `#435ea5` Navy 700, `#f2f4f9` / `#e8eaf1` surfaces, WCAG 2.1 AA contrast), self-hosted **Noto Sans JP** & **Hind** fonts (`@fontsource/noto-sans-jp`, `@fontsource/hind`)

> **Note on official university logos:** Per the Science Tokyo Design System guidelines, no official university logo ("Science S" / logotype) is fabricated or embedded. Obtain official brand assets from the intranet-only Science Tokyo Design System if needed.

## Quick start (Node.js 26+, pnpm 12+)

```bash
pnpm install
pnpm run demo
# Open http://127.0.0.1:4173
# Click "Demo run" to generate a sample XPS-like CSV and execute six quicklook stages.
# Select 「デモをレビューで一時停止」 before starting to pause for human review. Shift + click also works.
```

For Vite HMR frontend development alongside the local API server:

```bash
pnpm run dev:server   # terminal A: HTTP API, inbox watcher, SSE stream on :4173
pnpm run dev          # terminal B: Vite+ dev server on :5173 (proxies /api and /artifacts)
pnpm run worker:demo  # terminal C: demo worker (or worker:codex / worker:claude)
```

## Scripts

```bash
pnpm run dev          # Start Vite+ dev server (vp dev)
pnpm run build        # Production frontend build into dist/ (vp build)
pnpm run start        # Run HTTP server serving dist/ and API (node server.ts)
pnpm run demo         # Build frontend and launch server + demo worker
pnpm run worker:demo  # Run demo pull worker
pnpm run worker:codex # Run Codex CLI pull worker
pnpm run worker:claude# Run Claude Code CLI pull worker
pnpm run check        # Format, lint, and type check (vp check)
pnpm run test         # Run Vitest suite (vp test run)
```

The demo worker creates a genuine `report.html` (styled with the Science Tokyo palette) and, if `python-pptx` is installed, a `report.pptx` using Yu Gothic. It simulates a retry at the analysis stage to exercise the failure rail. **This is descriptive demo data processing, not a scientific XPS peak-fitting or peak assignment.**

## File structure

```text
index.html           Vite HTML entry point
vite.config.ts       Vite+ unified config (React, Tailwind CSS v4, proxy, lint, fmt, test)
shared/types.ts      Shared TypeScript event/job domain types
src/                 React + TypeScript + Tailwind CSS dashboard UI
server.ts            fs.watch, job queue API, JSONL event store, SSE, static dist/ server
worker.ts            Pull worker (demo / Codex / Claude adapters)
start-demo.ts        Launches server.ts + demo worker
scripts/             Science Tokyo-styled quicklook HTML/PPTX report generator
tests/               Vitest API, event-replay, and helper tests
```

Set `PORT`, `HOST`, `RAILFLOW_HOME`, `RAILFLOW_URL`, `RAILFLOW_AGENT_TIMEOUT_MS`, and `RAILFLOW_PYTHON` for deployment differences. The demo is designed for **localhost only** (default bind `127.0.0.1`), and has **no authentication**.
