# Workflow Engine v2

## Define dependencies without code

In the workflow editor choose **Workflow v2 · sequential** or **DAG**. Select the
prerequisite stages with checkboxes, select the publishing stage, and set the
parallel task limit (1–8). The connection overview displays each stage, its
prerequisites, execution kind and task counts. In DAG mode reordering changes only
the display order. Cycles, missing references, duplicate keys and disconnected
publishing stages are rejected before saving.

The publishing stage must depend, directly or transitively, on every other stage.
It cannot be mapped or use the human runner. It creates a nonempty `report.html` and/or `report.pptx`, and
passes both its own gate and the final gate before publication. A human-review
stage is normally placed before the publishing stage, or review can be enabled on
the publishing gate itself.

Existing projects stay in legacy sequential mode until explicitly changed.
Registered v1 jobs always retain their original sequential execution model.
Changing a project cannot change an existing job's frozen plan. v2 jobs are only
claimed by workers advertising protocol 2 or later. Runtime requirements and
isolated map inputs require protocol 3; see [reusable pipelines](reusable-pipelines.md).
Server and worker should use matching releases.

## Map and reduce

Enable **run independently for each input file** and choose a glob such as
`**/*.csv`. The immutable dataset manifest is expanded when the job is registered.
Zero matches, too many matches, and plans over 256 tasks are rejected. Each map
stage permits at most 128 files. Task identifiers include a digest of the full
relative path, so `A/data.csv` and `B/data.csv` remain separate.

Every task has its own attempts, retries, timeout, evidence and review token.
Dependent stages wait for _all_ mapped tasks they depend on. A reduce stage is an
ordinary Python, command or AI stage depending on the map stage; its upstream
manifest lists accepted outputs in stable task-key order, independent of finish
order. A failed file is retried alone. Other accepted outputs remain available.

Attempts receive ancestor outputs under `_inputs/<task-key>/`. They are copied
and hash-verified separately instead of merged into one directory. The structured
manifest at `_railflow/inputs.json` includes each source stage, mapped input path,
relative directory and output hashes. Ancestors are included so an intervening
human approval stage does not lose access to the original analysis outputs.
Tasks must not modify `_inputs/` or the original dataset. These inputs are verified
again before acceptance. A task's own exported outputs exclude `_inputs/` and
`_railflow/`; every other regular output is hashed and made available downstream.

## Stage kinds

| Kind    | Execution                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AI      | Worker's demo/Codex/Claude mode, or explicitly choose Codex/Claude per stage.                                                         |
| Command | Program and argument array, passed directly without implicit shell expansion. To use shell syntax explicitly choose `bash` with `-c`. |
| Python  | Frozen source written to the attempt's `_railflow/task.py`; uses `RAILFLOW_PYTHON` or `python3`.                                      |
| HTTP    | GET or POST, explicit expected 2xx status and response output path; 2 MiB response bound, no redirects, normal stage timeout.         |
| Human   | No agent invocation. Displays the instructions and input files and requires exact task/attempt/sequence approval.                     |

HTTP POST requires opting into a stable `Idempotency-Key` (`job-id/task-id`). The
remote endpoint must implement that header to prevent repeated side effects on
retry or recovery. Credentials are not embedded in URLs. HTTP stages currently
use JSON content type and do not configure arbitrary authentication headers.

Commands and Python receive these environment variables:

- `RAILFLOW_INPUT_DIR`, `RAILFLOW_INPUT_MANIFEST`: frozen dataset and manifest.
- `RAILFLOW_INPUT_ITEM`: this map task's relative file path; empty for unmapped tasks.
- `RAILFLOW_UPSTREAM_MANIFEST`: `_railflow/inputs.json` with accepted source outputs.
- `RAILFLOW_JOB_ID`, `RAILFLOW_TASK_ID`, `RAILFLOW_ATTEMPT`.

Arguments and HTTP URL/body also support the prompt variables. New variables are
`{{task.id}}`, `{{input.item}}` and `{{upstream.manifest}}`. Python source itself is
not template-expanded: read environment variables to avoid source-code injection
from filenames. Command arguments are not joined into a shell string.

HTTP variables are encoded for their position: URL values are percent-encoded and
must keep the template's origin; body values are JSON-string escaped (place them
inside `"..."`), and the expanded body must parse as JSON. HTTP stages never
connect to link-local or cloud-metadata addresses (including IPv4-mapped/NAT64
IPv6 spellings and `fd00:ec2::254`); every DNS answer is checked when the socket
connects. Loopback, the worker's `RAILFLOW_URL` host and local interface
addresses on the control API's port are refused as well.

## Input and output contracts

The form editor sets file patterns, minimum/maximum counts and JSON types. Object
keys and required fields can be added without code. Inputs can refer to the
dataset or upstream task outputs (`<task-key>/<file>`, often `**/metrics.json`).
For a mapped task, dataset contracts inspect only that task's file.

The server evaluates input contracts before execution can be recorded, and output
contracts before success/review. Conditions and contracts remain separate evidence
entries. A normal exit cannot bypass either check. Exception approval retains the
failed evidence and uses the same explicit approval mechanism as v1.

JSON validation supports a bounded subset of JSON Schema: `type`, `properties`,
`required`, boolean `additionalProperties`, `items`, scalar `enum`, `minimum`,
`maximum`, `minItems`, `maxItems`, `minLength`, `maxLength`. Unknown keywords are
rejected rather than ignored. Schemas are limited to 64 nodes/6 levels; inspected
JSON files to 2 MiB. `$ref`, executable expressions, regex and remote schema
loading are not supported. The form exposes basic types/object fields; nested
schemas and range constraints are also accepted through the project JSON API.

## Parallel reviews, stopping and time

A review blocks its dependent tasks, while independent branches continue. Once no
task can run, the worker yields the job and frees its queue slot. Each review has
its own output preview and exact approval token. Pausing and resuming preserve all
reviews and resume any independently ready task. Failed branches retain successful
independent work for selective rerun.

The v2 job timeout counts active elapsed time for the whole job: parallel intervals
count once. Time while queued, paused or fully yielded for review is excluded.
Stage timeouts still count that task's preparation, execution, checks and backoff.
The job deadline stops all in-flight tasks together. The monitor's sum of stage
durations is processing time and can exceed job elapsed time when tasks overlap.

## Rerun selected work

On a stopped/completed v2 job, select a task and open **rerun from this task**.
Preview shows the tasks to execute and the accepted tasks to reuse. Confirmation
creates a new job with the same frozen inputs/definition and `parentJobId`.
The selected task, its descendants and unfinished tasks execute again; unrelated
accepted results are copied only after hash verification. The original job and
its history do not change. Reused tasks have provenance, not fictitious attempts.
The publishing stage is downstream and executes/gates again.

For a mapped stage this action selects one file's task, enabling file-level repair
before re-running aggregation. Using a newer project definition is a new submission,
not an implicit change to this rerun.

### API

- Project `graph`: `{ mode: "dag" | "sequential", maxParallelTasks, publishStage }`.
  Send `graph: null` to explicitly disable v2 when advanced stage settings are removed.
- Stage: `runner`, `dependsOn`, optional `map: { pattern, maxItems }`,
  `contracts: { inputs, outputs }`.
- `GET /api/jobs/:id`: authoritative task state.
- `POST /api/jobs/:id/rerun`: `{ task, preview?: true }`.
- Review listing/file URLs accept `task` in the query; approval already includes
  the task key, attempt and review sequence.

The v2 implementation schedules tasks on the single worker holding the job lease.
It does not distribute one DAG across multiple hosts. Explicit commands/Python run
with the worker's permissions, as local workflow code.
