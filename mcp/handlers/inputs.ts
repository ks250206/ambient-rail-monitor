import { toJobHead } from '../../client/operations.ts';
import { RailflowError } from '../../client/types.ts';
import { collectSelection, retryCommit, submitDataset } from '../../client/upload.ts';
import type { ToolHandlerContext } from '../catalog.ts';
import { usage, type ToolArgs } from '../schemas.ts';

export const inputHandlers = {
  async railflow_inputs_list(
    args: ToolArgs<'railflow_inputs_list'>,
    { ops, page }: ToolHandlerContext,
  ) {
    return page(await ops.listInputs(args.projectId), args);
  },
  async railflow_input_check(
    { projectId, name, origin, condition }: ToolArgs<'railflow_input_check'>,
    { ops }: ToolHandlerContext,
  ) {
    return { result: await ops.checkInput(projectId, { name, origin, condition }) };
  },
  async railflow_dataset_submit(
    { projectId, paths, name }: ToolArgs<'railflow_dataset_submit'>,
    { uploadRoot, sessionUploadIds, client, signal }: ToolHandlerContext,
  ) {
    if (uploadRoot === undefined) usage('An upload root is required');
    const selection = await collectSelection(paths, { allowedRoot: uploadRoot, name });
    try {
      const { uploadId, job } = await submitDataset(client, projectId, selection, { signal });
      sessionUploadIds.add(uploadId);
      return { uploadId, job: toJobHead(job) };
    } catch (error) {
      if (error instanceof RailflowError && error.kind === 'outcome_unknown' && error.uploadId)
        sessionUploadIds.add(error.uploadId);
      throw error;
    }
  },
  async railflow_upload_commit(
    { uploadId }: ToolArgs<'railflow_upload_commit'>,
    { client, signal, sessionUploadIds }: ToolHandlerContext,
  ) {
    if (!sessionUploadIds.has(uploadId)) usage('The upload ID was not created in this MCP session');
    const { job } = await retryCommit(client, uploadId, { signal });
    return { uploadId, job: toJobHead(job) };
  },
};
