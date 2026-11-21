import { collectSelection, retryCommit, submitDataset } from '../../client/upload.ts';
import { parseCondition } from '../../shared/conditions.ts';
import { command, messageOf, usage } from '../format.ts';
import { watch } from './jobs.ts';

export const inputCommands = {
  'inputs list': command('inputs list [P]', [], 'project', async (ctx) => {
    ctx.output.print(await ctx.ops.listInputs(ctx.project()));
  }),
  'inputs check': command(
    'inputs check [P] --name NAME [--origin project|legacy] [--condition FILE|-]',
    ['name', 'origin', 'condition'],
    'project',
    async (ctx) => {
      const project = ctx.project();
      const name = ctx.required('name');
      const origin = ctx.option('origin');
      if (origin !== undefined && origin !== 'project' && origin !== 'legacy')
        usage('--origin must be project or legacy');
      const path = ctx.option('condition');
      let condition;
      if (path !== undefined) {
        const value = await ctx.readJson(path);
        try {
          condition = parseCondition(value, 'trigger');
        } catch (error) {
          usage(`Invalid --condition: ${messageOf(error)}`);
        }
      }
      const result = await ctx.ops.checkInput(project, { name, origin, condition });
      ctx.output.print(result);
      return result.status === 'pass' ? 0 : 6;
    },
  ),
  submit: command(
    'submit PATH... --project P [--name NAME] [--watch]',
    ['name', 'watch'],
    'paths',
    async (ctx) => {
      const project = ctx.explicitProject();
      const selection = await collectSelection(ctx.args, {
        name: ctx.option('name'),
        signal: ctx.signal,
      });
      const result = await submitDataset(ctx.client, project, selection, {
        signal: ctx.signal,
        onProgress:
          ctx.output.isTTY && !ctx.output.json
            ? (done, total, file) => ctx.output.diagnostic(`Uploaded ${done}/${total}: ${file}`)
            : undefined,
      });
      if (ctx.enabled('watch')) return watch(ctx, result.job.id);
      ctx.output.print(result);
    },
  ),
  'uploads commit': command('uploads commit UPLOAD_ID', [], 1, async (ctx) => {
    ctx.output.print(await retryCommit(ctx.client, ctx.args[0], { signal: ctx.signal }));
  }),
  demo: command('demo --project P [--review] [--watch]', ['review', 'watch'], 0, async (ctx) => {
    const result = await ctx.ops.createDemoJob(ctx.explicitProject(), ctx.enabled('review'));
    if (ctx.enabled('watch')) return watch(ctx, result.id);
    ctx.output.print(result);
  }),
};
