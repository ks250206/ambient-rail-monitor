import { Readable } from 'node:stream';
import { parseWorkflowTemplate, templateOrigin } from '../../shared/templates.ts';
import { command, integer, messageOf, saveStream, usage, type CommandContext } from '../format.ts';

async function updateDefinition(ctx: CommandContext) {
  const path = ctx.required('file');
  const expected = ctx.required('expected-updated-at');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(expected) || !Number.isFinite(Date.parse(expected)))
    usage('--expected-updated-at requires an ISO timestamp');
  const definition = await ctx.readJson(path);
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition))
    usage('--file must contain a JSON object');
  return { definition, expected };
}

export const projectCommands = {
  'projects list': command('projects list', [], 0, async ({ ops, output }) => {
    output.print(await ops.listProjects());
  }),
  'projects get': command('projects get [P]', [], 'project', async (ctx) => {
    ctx.output.print(await ctx.ops.getProject(ctx.project()));
  }),
  'projects create': command(
    'projects create --name NAME [--id ID] [--template FILE|-]',
    ['name', 'id', 'template'],
    0,
    async (ctx) => {
      const name = ctx.required('name');
      const id = ctx.option('id');
      if (id !== undefined && /[^a-z0-9_-]/.test(id)) usage('Invalid project ID');
      const path = ctx.option('template');
      const template = path === undefined ? undefined : await readTemplate(ctx, path);
      ctx.output.print(await ctx.ops.createProject({ name, id, template }));
    },
  ),
  'projects update': command(
    'projects update [P] --file FILE|- --expected-updated-at ISO',
    ['file', 'expected-updated-at'],
    'project',
    async (ctx) => {
      const projectId = ctx.explicitProject();
      const { definition, expected } = await updateDefinition(ctx);
      ctx.output.print(await ctx.ops.updateProject(projectId, definition, expected));
    },
  ),
  'projects delete': command('projects delete [P] --yes', ['yes'], 'project', async (ctx) => {
    ctx.confirm();
    ctx.output.print(await ctx.ops.deleteProject(ctx.explicitProject()));
  }),
  'workflow get': command('workflow get [P]', [], 'project', async (ctx) => {
    ctx.output.print(await ctx.ops.getWorkflow(ctx.project()));
  }),
  'workflow set': command(
    'workflow set [P] --file FILE|- --expected-updated-at ISO',
    ['file', 'expected-updated-at'],
    'project',
    async (ctx) => {
      const projectId = ctx.explicitProject();
      const { definition, expected } = await updateDefinition(ctx);
      ctx.output.print(await ctx.ops.setWorkflow(projectId, definition, expected));
    },
  ),
  'templates list': command('templates list', [], 0, async ({ ops, output }) => {
    output.print(await ops.listTemplates());
  }),
  'templates export': command(
    'templates export [P] [--name NAME] [--revision REV] [--out FILE]',
    ['name', 'revision', 'out'],
    'project',
    async (ctx) => {
      const destination = ctx.option('out');
      if (destination === '-') usage('--out requires a file path');
      const template = await ctx.ops.exportTemplate(ctx.project(), {
        name: ctx.option('name'),
        revision: ctx.option('revision'),
      });
      if (destination) {
        const stream = Readable.from([JSON.stringify(template, null, 2) + '\n']);
        ctx.output.print(await saveStream(stream, destination));
      } else {
        ctx.output.print(template);
      }
    },
  ),
  'templates validate': command('templates validate --file FILE|-', ['file'], 0, async (ctx) => {
    ctx.output.print(await ctx.ops.validateTemplate(await ctx.readJson(ctx.required('file'))));
  }),
  'templates save': command(
    'templates save [P] --name NAME --revision REV',
    ['name', 'revision'],
    'project',
    async (ctx) => {
      ctx.output.print(
        await ctx.ops.saveTemplate(
          ctx.explicitProject(),
          ctx.required('name'),
          ctx.required('revision'),
        ),
      );
    },
  ),
  'templates delete': command(
    'templates delete --name NAME --revision REV --hash SHA256 --yes',
    ['name', 'revision', 'hash', 'yes'],
    0,
    async (ctx) => {
      ctx.confirm();
      const identity = {
        name: ctx.required('name'),
        revision: ctx.required('revision'),
        hash: ctx.required('hash'),
      };
      try {
        templateOrigin(identity);
      } catch (error) {
        usage(messageOf(error));
      }
      ctx.output.print(await ctx.ops.deleteTemplate(identity));
    },
  ),
  'queue get': command('queue get', [], 0, async ({ ops, output }) => {
    output.print(await ops.getQueue());
  }),
  'queue set': command(
    'queue set --max-concurrent-jobs N --max-jobs-per-worker N --max-recoveries N',
    ['max-concurrent-jobs', 'max-jobs-per-worker', 'max-recoveries'],
    0,
    async (ctx) => {
      ctx.output.print(
        await ctx.ops.setQueue({
          maxConcurrentJobs: integer(ctx.required('max-concurrent-jobs'), '--max-concurrent-jobs'),
          maxJobsPerWorker: integer(ctx.required('max-jobs-per-worker'), '--max-jobs-per-worker'),
          maxRecoveries: integer(ctx.required('max-recoveries'), '--max-recoveries', 0),
        }),
      );
    },
  ),
};

async function readTemplate(ctx: CommandContext, path: string) {
  const value = await ctx.readJson(path);
  try {
    return parseWorkflowTemplate(value);
  } catch (error) {
    usage(`Invalid --template: ${messageOf(error)}`);
  }
}
