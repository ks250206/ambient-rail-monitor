import { toJobHead, toStageHead } from '../../client/operations.ts';
import { RailflowError } from '../../client/types.ts';
import { waitJob } from '../../client/watch.ts';
import type { ToolHandlerContext } from '../catalog.ts';
import type { ToolArgs } from '../schemas.ts';

export const jobHandlers = {
  async railflow_demo_create(
    { projectId, review }: ToolArgs<'railflow_demo_create'>,
    { ops }: ToolHandlerContext,
  ) {
    return { job: toJobHead(await ops.createDemoJob(projectId, review)) };
  },
  async railflow_queue_get(_: ToolArgs<'railflow_queue_get'>, { ops }: ToolHandlerContext) {
    const { maxConcurrentJobs, maxJobsPerWorker, maxRecoveries, active, workers } =
      await ops.getQueue();
    return {
      settings: { maxConcurrentJobs, maxJobsPerWorker, maxRecoveries },
      active,
      workers: workers.map(({ id, active, lastHeartbeatAt }) => ({ id, active, lastHeartbeatAt })),
    };
  },
  async railflow_queue_set(args: ToolArgs<'railflow_queue_set'>, { ops }: ToolHandlerContext) {
    return { settings: await ops.setQueue(args) };
  },
  async railflow_jobs_list(
    args: ToolArgs<'railflow_jobs_list'>,
    { ops, page }: ToolHandlerContext,
  ) {
    const items = await ops.listJobs({ projectId: args.projectId, status: args.status });
    return page(items.map(toJobHead), args);
  },
  async railflow_job_get(args: ToolArgs<'railflow_job_get'>, { ops, page }: ToolHandlerContext) {
    const job = await ops.getJob(args.jobId);
    const head = toJobHead(job);
    return page(job.stages.map(toStageHead), args, (stages) => ({ job: head, stages }));
  },
  async railflow_job_wait(
    { jobId, until, timeoutMs = 10_000 }: ToolArgs<'railflow_job_wait'>,
    { client, ops, signal }: ToolHandlerContext,
  ) {
    try {
      const { job, reached, reason } = await waitJob(client, jobId, { until, timeoutMs, signal });
      return { job: toJobHead(job), reached, reason };
    } catch (error) {
      if (!(error instanceof RailflowError) || error.kind !== 'timeout') throw error;
      // Short waits can expire before SSE connects or the first snapshot arrives.
      const job = await ops.getJob(jobId);
      return { job: toJobHead(job), reached: false, reason: 'timeout' as const };
    }
  },
  railflow_job_logs(args: ToolArgs<'railflow_job_logs'>, { ops, window }: ToolHandlerContext) {
    return window(
      args,
      async () => {
        const response = await ops.openJobLogs(args.jobId);
        return { ...response, contentType: 'text/plain' };
      },
      (preview) => preview,
    );
  },
  async railflow_job_pause({ jobId }: ToolArgs<'railflow_job_pause'>, { ops }: ToolHandlerContext) {
    return { job: toJobHead(await ops.pauseJob(jobId)) };
  },
  async railflow_job_resume(
    { jobId }: ToolArgs<'railflow_job_resume'>,
    { ops }: ToolHandlerContext,
  ) {
    return { job: toJobHead(await ops.resumeJob(jobId)) };
  },
  async railflow_job_cancel(
    { jobId }: ToolArgs<'railflow_job_cancel'>,
    { ops }: ToolHandlerContext,
  ) {
    return { job: toJobHead(await ops.cancelJob(jobId)) };
  },
  async railflow_job_priority(
    { jobId, priority }: ToolArgs<'railflow_job_priority'>,
    { ops }: ToolHandlerContext,
  ) {
    return { job: toJobHead(await ops.setJobPriority(jobId, priority)) };
  },
  railflow_rerun_preview(
    { jobId, task }: ToolArgs<'railflow_rerun_preview'>,
    { ops }: ToolHandlerContext,
  ) {
    return ops.previewRerun(jobId, task);
  },
  async railflow_rerun_execute(
    { jobId, task }: ToolArgs<'railflow_rerun_execute'>,
    { ops }: ToolHandlerContext,
  ) {
    const { job } = await ops.executeRerun(jobId, task);
    return { parentJobId: jobId, job: toJobHead(job) };
  },
  async railflow_provenance_get(
    { jobId }: ToolArgs<'railflow_provenance_get'>,
    { ops }: ToolHandlerContext,
  ) {
    const { format, formatVersion, exportedAt, complete, asOfSequence, job, metrics } =
      await ops.getProvenance(jobId);
    return {
      format,
      formatVersion,
      exportedAt,
      complete,
      asOfSequence,
      job: toJobHead(job),
      metrics,
    };
  },
  async railflow_artifacts_list(
    args: ToolArgs<'railflow_artifacts_list'>,
    { ops, page }: ToolHandlerContext,
  ) {
    const artifacts = await ops.listArtifacts(args.jobId);
    return page(
      artifacts.map(({ name, bytes }) => ({ name, bytes })),
      args,
    );
  },
  railflow_artifact_read(
    args: ToolArgs<'railflow_artifact_read'>,
    { ops, window }: ToolHandlerContext,
  ) {
    const { jobId, name } = args;
    return window(
      args,
      () => ops.openArtifact(jobId, name),
      (preview) => ({ name, preview }),
    );
  },
};
