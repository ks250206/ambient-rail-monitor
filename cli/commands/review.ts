import { createReviewOperations } from '../../client/review.ts';
import type { ReviewRef } from '../../client/types.ts';
import { command, integer, usage, type CommandContext } from '../format.ts';

function exactRef(ctx: CommandContext): ReviewRef {
  return {
    jobId: ctx.args[0],
    stageKey: ctx.required('stage'),
    attempt: integer(ctx.required('attempt'), '--attempt'),
    reviewSequence: integer(ctx.required('sequence'), '--sequence'),
  };
}

export const reviewCommands = {
  'review list': command('review list JOB --stage STAGE', ['stage'], 1, async (ctx) => {
    const review = createReviewOperations(ctx.client);
    ctx.output.print(
      await review.inspectReview(ctx.args[0], ctx.required('stage'), { signal: ctx.signal }),
    );
  }),
  'review read': command(
    'review read JOB --stage STAGE --attempt N --sequence N --path REL [--out FILE]',
    ['stage', 'attempt', 'sequence', 'path', 'out'],
    1,
    async (ctx) => {
      const destination = ctx.option('out');
      if (destination === '-') usage('--out requires a file path');
      const review = createReviewOperations(ctx.client);
      const response = await review.openReviewFile(exactRef(ctx), ctx.required('path'), {
        signal: ctx.signal,
      });
      await ctx.output.stream(response, destination);
    },
  ),
  'review approve': command(
    'review approve JOB --stage STAGE --attempt N --sequence N --receipt TOKEN [--exception] --yes',
    ['stage', 'attempt', 'sequence', 'receipt', 'exception', 'yes'],
    1,
    async (ctx) => {
      ctx.confirm();
      const review = createReviewOperations(ctx.client);
      ctx.output.print(
        await review.approveExact(
          exactRef(ctx),
          ctx.required('receipt'),
          ctx.enabled('exception'),
          { signal: ctx.signal },
        ),
      );
    },
  ),
};
