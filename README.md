# RAILFLOW — Ambient Agent Workflow Observatory

A local-first proof of concept for **pull-based Codex / Claude Code scientific-analysis jobs** with four synchronized views:

- **Actions / Runs** — GitHub Actions-inspired run history, active/review/failed status filtering, step list, attempts and expandable timestamped logs, live durations, search and raw log download.
- **Kanban** — queue, running, review/blocked, completed.
- **Railway execution** — stage-by-stage success and failure/retry routes, human review gate.
- **Trace explorer** — individual execution attempts rendered against elapsed time, with stage-level details, raw agent events and artifacts.

![Actions / Runs UI](docs/actions.png)

![Original Overview / Kanban UI](docs/preview.png)

## Quick start (Node.js 20+, no npm dependencies)

```bash
npm run demo
# Open http://127.0.0.1:4173
# Click "Demo run" to generate a sample XPS-like CSV and execute six quicklook stages.
# Shift + click "Demo run" to stop at human review before completing.
```

The demo worker creates a genuine `report.html` and, if `python-pptx` is installed, a `report.pptx`. It simulates a retry at the analysis stage to exercise the failure rail. **This is descriptive demo data processing, not a scientific XPS peak-fitting or peak assignment.**

Use separate processes for real agents:

```bash
npm start                     # terminal A: HTTP UI, inbox watcher, job queue, event store
npm run worker:codex          # terminal B: Codex CLI must be installed and authenticated
# or
npm run worker:claude         # terminal B: Claude Code CLI must be installed and authenticated
```

Drop CSV/TSV/TXT/JSON/DAT files onto the web UI, or place them inside `inbox/` (the filesystem watcher uses a polling fallback). The worker **pulls** jobs from `POST /api/jobs/claim` and sends structured updates to `POST /api/jobs/:id/events`.

By default, `codex exec --json --sandbox workspace-write` is used for Codex and `claude -p --output-format stream-json --verbose` for Claude. The CLI is started **once per workflow stage**, in the job's isolated working directory, and receives the previous stages' files as context. These commands are **not** asserted to be fully autonomous in every installation: unattended permission policies must be deliberately configured by the user; do not set unrestricted or dangerous permissions on the strength of this prototype. API costs and subscriptions depend on local CLI configuration.

Requires Python 3 for the demo report generator. Install `python-pptx` to enable demo PPTX export:

```bash
python3 -m pip install python-pptx
```

If Python is not available, the mock worker stops at the report step. Actual agents can use their own rendering stack.

## Data flow

```text
      CSV / TSV / other data
              │
      fs.watch + stable scan
              ▼
            Inbox
              │
      Job queue (event-sourced)
              │  POST /api/jobs/claim
              ▼
    ┌──────────────────────┐
    │ Codex / Claude worker│
    │  (or demo worker)    │
    └──────────┬───────────┘
               │ step.started / failed / retry / succeeded / agent.event
               ▼
        events.jsonl (append-only)
               │  SSE /api/stream
               ▼
       React-less web dashboard
       Actions / Kanban / Railway / Trace
               │
         Local report artifacts
```

Each job contains **6 workflow stages**: ingestion → preprocessing → analysis → scientific validation → visualization → publishing. They are **observable phases**, not a hardcoded scientific method. Codex/Claude still chooses how each stage is performed, subject to staged instructions and output checks.

**Important distinction:** the dashboard records **workflow spans** explicitly and captures CLI inner events as secondary logs. It cannot infer scientific progress reliably from unstructured agent prose. A general workflow synthesizer (from demonstrations/interactive conversations) is a future feature.

## Actions-style run details

Select **Actions / Runs** in the sidebar or scroll to the first section. The view is inspired by the **GitHub Actions run history and job logs UI**, but it does **not** import GitHub Actions runs or call the GitHub API. It observes Railflow pull-workers (Codex CLI, Claude Code CLI, or demo).

- Left: searchable run history, status filter (All / Active / Success / Issues), date, stage count and elapsed time. Pagination displays seven runs at a time.
- Center: six observable workflow stages, retry counts, stage durations and selected-step state, synchronized with the Railway inspector.
- Right: expandable **Attempt 01 / 02 / ...**, colored error/retry/success lines, timestamps toggle, live log search and **All run events** view.
- Run header: wall-clock runtime, total active stage time, queue wait, runner and completion progress. Time counters refresh without rebuilding the log console.
- **Download logs** requests `GET /api/jobs/:id/logs`, which exports the append-only event projection as a text attachment, including the event timestamps and stage details.
- Any step can be followed into the full **Trace explorer** for the Gantt-style timing breakdown.

This runs locally and displays only events the worker actually reports; it does **not** infer how far through a scientific analysis the model is from chat messages alone. It is a prototype, not a drop-in replacement for GitHub Actions or Jaeger.

## Event contract

`POST /api/jobs/run_xxxxxxxx/events` accepts:

```json
{
  "type": "stage.started",
  "stage": "analysis",
  "message": "Peak fitting started"
}
```

Supported event types: `job.created` (server-owned), `job.claimed` (server-owned), `stage.started`, `stage.progress`, `stage.succeeded`, `stage.failed`, `stage.retry`, `review.required`, `review.approved` (server-owned), `agent.event`, `artifact.created`, `job.completed`, `job.failed`.

Each event is augmented with an ISO timestamp and monotonic local sequence number. The UI reconstructs per-stage attempts into traces; each retry is its own span. Example:

```json
{"type":"stage.failed","stage":"analysis","message":"Fit did not converge"}
{"type":"stage.retry","stage":"analysis","message":"Updating initial guess"}
{"type":"stage.started","stage":"analysis","message":"Second attempt"}
{"type":"stage.succeeded","stage":"analysis","message":"Residual validation passed"}
```

This is **OpenTelemetry-inspired**, but it is **not yet an OTLP producer**. Real OpenTelemetry trace IDs, parent links, instrumented token usage and exporters are future work.

## File structure

```text
public/             UI (HTML, CSS, JS with no bundler)
server.mjs           fs.watch, job queue API, JSONL event store, SSE
worker.mjs           pull worker, mock/Codex/Claude adapters
start-demo.mjs       launches server + demo worker
scripts/             quicklook HTML/PPTX report generator
tests/               API and event-replay smoke test
data/                events.jsonl (created at runtime)
inbox/               incoming experimental files
work/                isolated job working directories
artifacts/           generated HTML / PPTX reports
```

Set `PORT`, `HOST`, `RAILFLOW_HOME`, `RAILFLOW_URL`, `RAILFLOW_AGENT_TIMEOUT_MS`, and `RAILFLOW_PYTHON` for deployment differences. The demo is designed for **localhost only** (default bind `127.0.0.1`), and has **no authentication**.

## Limitations / next steps

1. **Durable queue:** for multi-host/multi-worker production, move queue claims and heartbeats to SQLite/PostgreSQL with atomic leases and recovery. The MVP uses an in-memory projection rebuilt from append-only JSONL.
2. **Real OTel:** add `trace_id`, `span_id`, `parent_span_id`, duration, OTLP ingestion/export and Jaeger-compatible trace propagation, plus queue wait time vs processing time.
3. **AI-generated workflow:** synthesize stage DAGs and validation gates from demonstration traces, keeping them versioned with explicit approval before execution.
4. **Scientific trust:** stage checks must validate input units, uncertainty, numerical convergence, experimental constraints and provenance. The demo currently uses generic quicklook statistics.
5. **Security:** agent-executed shell commands are powerful, even with local directory sandboxing. Use restricted environments/credentials, file scanning, authentication and separate origin isolation for interactive HTML artifacts. The server adds CSP sandboxing to generated HTML.
6. **Scale:** multi-file experiments, fan-out/fan-in analysis, parent-child task spans, pause/cancel, cost/token charts, scheduling and long-running resumable jobs.
7. **Restart behavior:** jobs marked running before a process crash are not automatically reclaimed; add claim leases before unattended usage.

Run smoke tests with `npm test`.
