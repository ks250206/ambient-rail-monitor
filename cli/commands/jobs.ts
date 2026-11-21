import { RailflowError } from '../../client/types.ts';
import { waitJob, watchJob, type WaitResult } from '../../client/watch.ts';
import { QUEUE_LIMITS } from '../../shared/queue.ts';
import type { JobStatus } from '../../shared/types.ts';
import { command, integer, usage, type CommandContext } from '../format.ts';

const jobStatuses = new Set<string>([
  'queued',
  'running',
  'review',
  'done',
  'failed',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
] satisfies JobStatus[]);

function jobExit(reason: WaitResult['reason']): number {
  switch (reason) {
    case 'done':
      return 0;
    case 'failed':
    case 'cancelled':
      return 7;
    case 'review':
    case 'paused':
      return 8;
    case 'timeout':
      return 9;
  }
}

export async function watch(ctx: CommandContext, jobId: string): Promise<number> {
  for await (const observation of watchJob(ctx.client, jobId, {
    until: 'attention',
    signal: ctx.signal,
  })) {
    if (ctx.output.json) ctx.output.print(observation);
    else {
      const status = observation.job.status;
      const attention =
        observation.reason && observation.reason !== status ? ` (${observation.reason})` : '';
      ctx.output.text(`${jobId} ${status}${attention}\n`);
    }
    if (observation.reached && observation.reason) return jobExit(observation.reason);
  }
  throw new RailflowError({ kind: 'protocol', jobId, message: 'Job watch ended without a result' });
}

export const jobCommands = {
  'jobs list': command(
    'jobs list [--project P] [--status STATUS] [--limit N]',
    ['status', 'limit'],
    0,
    async (ctx) => {
      const status = ctx.option('status');
      if (status !== undefined && !jobStatuses.has(status)) usage(`Unknown job status: ${status}`);
      const limit = ctx.option('limit');
      const count = limit === undefined ? undefined : integer(limit, '--limit');
      const jobs = await ctx.ops.listJobs({
        projectId: ctx.projectId,
        status: status as JobStatus | undefined,
      });
      ctx.output.print(jobs.slice(0, count));
    },
  ),
  'jobs get': command('jobs get JOB [--watch]', ['watch'], 1, async (ctx) => {
    const [jobId] = ctx.args;
    if (ctx.enabled('watch')) return watch(ctx, jobId);
    ctx.output.print(await ctx.ops.getJob(jobId));
  }),
  'jobs wait': command(
    'jobs wait JOB [--until terminal|attention] [--timeout-ms N]',
    ['until', 'timeout-ms'],
    1,
    async (ctx) => {
      const until = ctx.option('until') ?? 'terminal';
      if (until !== 'attention' && until !== 'terminal')
        usage('--until must be terminal or attention');
      const timeout = ctx.option('timeout-ms');
      const result = await waitJob(ctx.client, ctx.args[0], {
        until,
        timeoutMs: timeout === undefined ? undefined : integer(timeout, '--timeout-ms', 0),
        signal: ctx.signal,
      });
      if (ctx.output.json) ctx.output.print(result);
      else ctx.output.text(`${result.job.id} ${result.reason}\n`);
      return jobExit(result.reason);
    },
  ),
  'jobs logs': command('jobs logs JOB [--tail N | --out FILE]', ['tail', 'out'], 1, async (ctx) => {
    const destination = ctx.option('out');
    const tail = ctx.option('tail');
    if (tail !== undefined && destination) usage('--tail and --out cannot be used together');
    if (destination === '-') usage('--out requires a file path');
    const count = tail === undefined ? undefined : integer(tail, '--tail');
    const response = await ctx.ops.openJobLogs(ctx.args[0]);
    if (count === undefined) return ctx.output.stream(response, destination);
    await ctx.output.tail(response, count);
  }),
  'jobs pause': command('jobs pause JOB', [], 1, async (ctx) => {
    ctx.output.print(await ctx.ops.pauseJob(ctx.args[0]));
  }),
  'jobs resume': command('jobs resume JOB', [], 1, async (ctx) => {
    ctx.output.print(await ctx.ops.resumeJob(ctx.args[0]));
  }),
  'jobs cancel': command('jobs cancel JOB --yes', ['yes'], 1, async (ctx) => {
    ctx.confirm();
    ctx.output.print(await ctx.ops.cancelJob(ctx.args[0]));
  }),
  'jobs priority': command('jobs priority JOB N', [], 2, async (ctx) => {
    const [jobId, rawPriority] = ctx.args;
    const priority = integer(rawPriority, 'Priority', QUEUE_LIMITS.priority.min);
    ctx.output.print(await ctx.ops.setJobPriority(jobId, priority));
  }),
  'jobs rerun preview': command('jobs rerun preview JOB --task TASK', ['task'], 1, async (ctx) => {
    ctx.output.print(await ctx.ops.previewRerun(ctx.args[0], ctx.required('task')));
  }),
  'jobs rerun execute': command(
    'jobs rerun execute JOB --task TASK [--watch]',
    ['task', 'watch'],
    1,
    async (ctx) => {
      const result = await ctx.ops.executeRerun(ctx.args[0], ctx.required('task'));
      if (ctx.enabled('watch')) return watch(ctx, result.job.id);
      ctx.output.print(result);
    },
  ),
  'jobs provenance': command('jobs provenance JOB [--out FILE]', ['out'], 1, async (ctx) => {
    const [jobId] = ctx.args;
    const destination = ctx.option('out');
    if (destination === '-') usage('--out requires a file path');
    if (destination) await ctx.output.stream(await ctx.ops.openProvenance(jobId), destination);
    else ctx.output.print(await ctx.ops.getProvenance(jobId));
  }),
  'artifacts list': command('artifacts list JOB', [], 1, async (ctx) => {
    ctx.output.print(await ctx.ops.listArtifacts(ctx.args[0]));
  }),
  'artifacts get': command(
    'artifacts get JOB --name NAME --out FILE|-',
    ['name', 'out'],
    1,
    async (ctx) => {
      const destination = ctx.required('out');
      if (destination === '-' && ctx.output.json) usage('--out - cannot be combined with --json');
      const response = await ctx.ops.openArtifact(ctx.args[0], ctx.required('name'));
      await ctx.output.stream(response, destination === '-' ? undefined : destination);
    },
  ),
};
