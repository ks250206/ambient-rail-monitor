# Reliable execution

## Queue and controls

The Jobs page exposes server-wide simultaneous jobs (default 4), jobs per worker
(default 2), and automatic recoveries per job (default 3). A project's definition
also sets its concurrent job limit (default 4) and default priority (-100 to 100).
Higher priorities run first; equal priorities preserve registration order.
Project limits are live operational settings, so lowering a limit affects the
next claim even for previously registered jobs. Running work is not evicted.

Workers default to one job at a time. `node worker.ts --mode=codex --concurrency=2`
uses two pull loops. The server, project and worker limits all apply. These are
concurrency limits, not OS memory/CPU quotas. Workers share the server's filesystem;
this is a single-host coordinator, not a multi-host scheduler.

Job details offer pause, resume, cancel and queued-job priority. A running pause
or cancellation first enters **pausing/cancelling**. Its slot remains reserved
until the worker has stopped its child processes and acknowledged, or the lease
expires. Cancelled jobs remain in history. Resume preserves accepted checkpoints
and starts a fresh attempt for an interrupted stage. A paused review resumes to
the same review; it never implies approval.

## Lease and recovery protocol

Every claim returns an opaque lease token. Worker events, heartbeat and release
require it. The default lease lasts 30 seconds; heartbeat is every quarter of
that period. `RAILFLOW_LEASE_MS` changes it (1–300 seconds).

The worker fails closed _before_ the server-side lease can expire. Its local
deadline is measured from when the claim or last accepted heartbeat request was
**sent** (`sentAt + ttl`), never from when the response arrived, so it cannot
outlive the server's renewal. It reserves a stop budget (the supervisor's TERM →
KILL grace plus the runner's kill fallback, 2 s by default; reduced to
`ttl − 2 × heartbeat` for very short leases) and stops its processes when:

- the server rejects the lease (409/404) — immediately;
- a heartbeat fails and the next one could not renew in time, i.e.
  `now + heartbeat + reserve ≥ deadline` (a single transient error, such as a
  server restart, is tolerated while the lease still has room);
- a watchdog reaches `deadline − reserve`, even if a heartbeat request hangs.

With the defaults, failing heartbeats stop the worker about 22.5 s after its last
successful heartbeat was sent, and the watchdog guarantees it by 28 s, leaving the
whole process stop budget before the 30 s expiry.

A separate process supervisor watches a pipe from
the worker, so even SIGKILL of the worker closes the pipe and terminates the CLI
process group (TERM, then KILL). Windows uses `taskkill /T /F`.

Expired claims, crashed workers and other unplanned stops are returned to the
queue, up to the recovery limit (`recoveryCount`). A planned worker shutdown
(SIGINT/SIGTERM) still interrupts the running attempt, but the worker acknowledges
it with `release` `{ reason: "shutdown" }`, so the job is requeued without spending
the recovery budget; restarting or redeploying workers never fails a job. Successful
and approved stages survive; interrupted output is never inherited. Actual
attempt numbers only increase, while application `retryCount` is separate:
pause/crash recovery does not spend an execution-error retry. A crash after a
recorded failure still follows that failure's retry/stop/review policy. Remaining
backoff is saved across a pause. Repeated infrastructure failures eventually stop
the job instead of restarting forever.

Active time from interrupted attempts is retained. On an unacknowledged failure,
the coordinator conservatively accounts up to lease expiry; it cannot know the
exact instant a disconnected process stopped. Queue/review/paused time is excluded.

Publications are written to lease-specific staging. Only the server copies them
to the public directory after checking the current lease and accepted stages.
Late events and publications from an old token cannot change a recovered job.
Worker events carry request IDs; redelivery returns the already committed event
without increasing attempts, time or output registrations a second time.

## Persistence and compatibility

`data/journal.sqlite` is the authoritative journal and lease store. Events and
claim/release changes commit in one SQLite transaction. On first start existing
`events.jsonl` records are imported; on subsequent starts JSONL is rebuilt from
SQLite as a human-readable export. A second server using the same home is rejected
by the database lock. Only one coordinator owns the in-memory projections.

Use server and worker from the same release: old workers do not send lease tokens.
Old projects, input snapshots, accepted checkpoints and review records remain
readable. Back up the whole `RAILFLOW_HOME` while stopped, including the SQLite
database. Do not edit JSONL to alter current state or run old/new servers together.

### API additions

- `PUT /api/queue`: `{ maxConcurrentJobs, maxJobsPerWorker, maxRecoveries }`.
- `POST /api/jobs/:id/pause`, `/resume`, `/cancel`: explicit job controls.
- `POST /api/jobs/:id/priority`: `{ priority }`, only queued/paused jobs.
- `POST /api/jobs/:id/heartbeat`: `{ leaseToken }`, returns a control action.
- `POST /api/jobs/:id/release`: `{ leaseToken, reason? }`, after local processes have stopped;
  `reason: "shutdown"` marks a planned stop that does not count as a recovery.
- `POST /api/jobs/:id/events`: adds `leaseToken` and optional UUID `requestId`.
- `/api/state` includes queue limits and currently leased workers. The `/api/stream`
  change carries `queueUpdated: true` on queue setting changes and on every claim or
  release, so every project's monitor refreshes the shared queue panel.

Limits do not sandbox command execution or authenticate remote clients. The
existing default remains a trusted local server bound to `127.0.0.1`.
