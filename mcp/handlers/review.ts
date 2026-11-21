import { RailflowError, type FileHead } from '../../client/types.ts';
import type { ToolHandlerContext } from '../catalog.ts';
import type { ToolArgs } from '../schemas.ts';

export const reviewHandlers = {
  async railflow_review_list(
    args: ToolArgs<'railflow_review_list'>,
    { review, page }: ToolHandlerContext,
  ) {
    const { files, ...inspection } = await review.inspectReview(args.jobId, args.stageKey);
    return page(files, args, (files) => ({ ...inspection, files }));
  },
  railflow_review_read(
    args: ToolArgs<'railflow_review_read'>,
    { review, window }: ToolHandlerContext,
  ) {
    const { jobId, stageKey, attempt, reviewSequence, path } = args;
    const ref = { jobId, stageKey, attempt, reviewSequence };
    let file: FileHead;
    return window(
      args,
      async () => {
        const inspection = await review.inspectReview(jobId, stageKey);
        if (inspection.ref.attempt !== attempt || inspection.ref.reviewSequence !== reviewSequence)
          throw new RailflowError({
            kind: 'http',
            status: 409,
            jobId,
            message: 'The review target has changed',
          });
        const entry = inspection.files.find((candidate) => candidate.path === path);
        if (!entry)
          throw new RailflowError({
            kind: 'http',
            status: 404,
            jobId,
            message: 'Review file not found',
          });
        file = entry;
        return review.openReviewFile(ref, path);
      },
      (preview) => ({ ref, file, preview }),
    );
  },
  railflow_review_approve(
    {
      jobId,
      stageKey,
      attempt,
      reviewSequence,
      receipt,
      exception,
    }: ToolArgs<'railflow_review_approve'>,
    { review }: ToolHandlerContext,
  ) {
    return review.approveExact({ jobId, stageKey, attempt, reviewSequence }, receipt, exception);
  },
};
