# Reusable pipelines and execution records

## Start from a template

Open **New project** and select a built-in/saved template, or load a template JSON
file. The server validates the file before displaying its name, revision, execution
model and stage kinds. Choose a new project name/ID and create an independent copy.
An invalid file keeps creation disabled until a valid file is selected or the
template is explicitly cleared. Older asynchronous validation responses cannot
replace a newer selection.

Two built-in templates are included:

- **CSVの一括点検**: Python standard-library CSV inspection per file, followed by an
  HTML inventory. It records row counts, column names and empty cells. It performs
  no spectral fitting, unit inference or peak assignment. Each file is isolated,
  so unchanged files can use their prior accepted results.
- **AI解析と人間の確認**: analysis notes, a human checkpoint, then report publication.
  Configure the worker/model before using a real AI engine. Cache is disabled.

The project management page can save the **persisted definition** as a named,
revisioned template, or download JSON. Unsaved workflow edits are not exported.
Saved templates live in the SQLite journal settings, with a limit of 30 entries.
A name/revision pair is immutable: changed content requires a new revision.

The envelope has `format: "ambient-rail-monitor.workflow"`, `formatVersion: 1`,
`template: { name, revision, hash }`, and a portable `definition`. The SHA-256 covers
canonical JSON with sorted object keys. It identifies content; it does not prove
authorship. Unknown envelope versions, invalid hashes, nonportable fields, malformed
metadata and invalid workflows are rejected. JSON files are limited to 4 MB.

Definitions include stages, prompts, conditions, contracts, execution policies,
graph, queue defaults, runtime requirements and optional price rates. They exclude
project IDs, timestamps, inbox/artifact locations, jobs, actual runtime observations
and usage records. Imported projects retain `templateOrigin`, while each job keeps
its own complete frozen project snapshot.

## Declare and inspect the execution environment

In **Workflow → 実行環境・LLM料金の設定**, configure any needed requirements:

| Setting                          | Meaning                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Environment revision             | A user-managed identifier for dependencies/configuration not otherwise observed. Required to enable result caching.                |
| Python executable                | Existing interpreter or virtualenv executable. Empty uses `RAILFLOW_PYTHON`, then `python3`.                                       |
| Node/Python/Codex/Claude version | Exact version string, e.g. `26.13.1`; blank means no version requirement. AI CLI requirements apply to attempts using that engine. |
| Python packages                  | Distribution names and exact installed versions, up to 50 requirements.                                                            |

Before a v2 task executes, the worker records its platform/architecture, Node
version, actual engine, resolved executable and SHA-256, tool version where
available, Python version and installed Python distribution versions when Python
is involved or explicitly required. CLI version probes and package inspection
are supervised and consume the same attempt/job budget. No package installation
or environment mutation is performed.

The server evaluates the frozen requirements against that observation. Missing
required evidence fails the preflight, as does a mismatched version. Normal
execution/acceptance cannot bypass that failure. The failure/review policy still
applies; an explicit exception is recorded as such and cannot seed the cache.
Observations are immutable events per attempt, so resuming on another worker
does not overwrite the previous worker's environment.

This is a checked local environment, not a container image, VM or operating-system
sandbox. Commands inherit the worker's permissions and environment. Arbitrary
environment variables and secrets are not collected into the runtime observation.
Update the environment revision when external configuration or dependencies change.
Versions/package names alone cannot prove byte-for-byte reproducibility of a whole
system or an AI service.

## Opt into verified result caching

Enable **結果の再利用** on an AI, command or Python stage. Caching is off by default.
HTTP and human stages cannot enable it. The setting declares that accepted output
may be reused when the declared inputs, definition and environment match. Use it
for analyses independent of the current time, job ID, external mutable services,
or undeclared files. Code can access such state; this declaration cannot be proven
by static analysis.

The key includes the project boundary, dataset name/kind and input file hashes,
task/map identity, every ancestor output manifest, effective engine/model/effort,
runner/code/arguments, instructions, contracts/gates, environment fingerprint and
manual cache/environment revisions. The cache and built-in prompt/runner format
also have explicit implementation versions. Timestamps and attempt workspace
locations are not treated as scientific inputs. User-authored templates referencing
volatile values (`job.id`, `attempt`, `retry.reason`, workspace or absolute input
paths) bypass caching. AI tasks also need an explicit model and observed CLI version;
demo AI results are excluded.

A hit restores only content-verified output files into a new attempt workspace.
File hashes include executable permissions. The current input/output contracts,
stage/final gates and required human approval run again. A cache hit never inherits
an old approval token. The task displays its source job/task/attempt, output hash,
and the reason for the hit or bypass.

Only normally accepted, freshly executed outputs seed the cache. Normal human
approval can complete this acceptance, but exception-approved failures, inherited
checkpoints and cache hits cannot seed new entries. Retry attempts and all child
jobs created by **rerun from this task** bypass lookup: selected work really executes.

Cache entries are copied, verified and committed by atomic directory rename after
acceptance is journaled. Cache-write failure does not invalidate accepted work.
Corrupt/missing entries are misses; copy failures fail that attempt instead of
running on partial restored output. Incomplete temporary entries are removed at
server startup. The local cache is bounded to 256 entries and 512 MiB of output
bytes, evicting oldest entries. Metadata is stored in addition to the output byte cap.
Original accepted workspaces and reports are independent of cache eviction.

### File-level incremental analysis

Ordinary map tasks can read the entire frozen dataset, so their key includes every
dataset file. Changing another file invalidates their key too.

To analyze files independently, enable **このファイルだけを入力に渡す** on the map stage.
The task receives a read-only copy of its one file with its original relative path,
a one-file manifest and an input count of one. The server and worker verify this
copy against the original snapshot. Such tasks key their dataset input by that
file; unchanged files can hit while changed files execute. Ancestor outputs still
participate in the key. A downstream reduction waits for all accepted map results
and sees the new complete set. This limits the provided input directory; it does
not add operating-system access restrictions.

## Usage, estimated cost and comparison

Every Codex/Claude invocation attempts to record a usage event even when execution
fails. Codex terminal `turn.completed` summaries are accumulated. Claude uses the
latest terminal `result`; per-model `modelUsage` is preferred because it includes
subagent work. Fallback `usage` is marked as a partial main-loop observation. Streamed
assistant messages are not summed, avoiding repeated usage from streaming chunks.
An interrupted CLI may provide no terminal summary: missing usage stays unknown.

The optional pricing table is **USD per million tokens**, matched by exact engine
and model string. It distinguishes normal input, cache reads, cache creation and
output. Prices are user supplied; this application does not fetch or guess them.
For Codex, cached input is separated from its inclusive input count. Claude's cache
counts are already separate. Reasoning tokens are not added a second time to output.

The server calculates estimates from the job's frozen price table and records the
result. Later project price edits cannot rewrite historical estimates. Claude's
reported `total_cost_usd` is displayed separately as a CLI estimate. Neither measure
is authoritative billing; tool calls, account pricing, external command services
and provider-specific adjustments may differ.

The monitor distinguishes unknown usage, observed zero, missing prices and partial
coverage. Totals include retries/failed attempts, preserve the engine of each
historical attempt after a worker change, and do not charge cache/reused source
usage to the new job. Queue/review time is excluded from the v2 active-time total;
the current active interval is added when the lease is released.

Under **使用量・実行記録**, compare another job in the same project: input/definition
hashes, status, active time, estimates with coverage, and task output equality.
The existing artifact comparison remains available for reading the reports side
by side. Equal hashes establish content equality, not scientific correctness.

CLI usage schema references:

- [OpenAI Codex event types](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts)
- [Claude Code usage and cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

## Export an execution record

**入力・定義・判定・環境・使用量の記録をJSONで保存** downloads
`railflow.provenance`, format version 1. It contains the frozen dataset/definition,
expanded task plan, parent/cache/reuse origins, actual prompts, attempt events,
gates/reviews, output manifests, runtime observations, usage and aggregate metrics.
`asOfSequence` identifies the last exported event; `complete` is false while the job
is unfinished. Lease tokens are private journal state and are never exported.

Prompts, filenames and explicit workflow code remain part of the record. Review
those contents before sharing a record outside your project.

## API and compatibility

- `GET /api/templates`: built-in and saved templates.
- `POST /api/templates/validate`: `{ template }`, read-only validation.
- `POST /api/templates`: `{ projectId, name?, revision }`, save a revision.
- `DELETE /api/templates`: `{ name, revision, hash }`, delete that saved revision.
- `GET /api/projects/:id/template?revision=1&name=...`: download persisted definition.
- `POST /api/projects`: `{ name, id?, purpose?, template }`, create a separate copy.
- Project: `runtime: { revision, python, expected, packages }`, `pricing: [...]`.
- Stage: `cache: { enabled, revision }`, `map.isolateInput: boolean`.
- `POST /api/jobs/:id/cache`: lease-bound internal restore/check endpoint.
- `GET /api/jobs/:id/provenance`: frozen and observed execution record.

New workers advertise protocol 3. Jobs requiring environment checks, caching, or
isolated map inputs cannot be claimed by earlier workers. Existing plain v2 jobs
remain compatible with protocol 2; v1 jobs retain their sequential behavior and
can record usage, while caching and environment checks require v2.
