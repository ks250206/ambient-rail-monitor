import { toProjectHead } from '../../client/operations.ts';
import { parseWorkflowTemplate, type PortableWorkflow } from '../../shared/templates.ts';
import type { ToolHandlerContext } from '../catalog.ts';
import { usage, type ToolArgs } from '../schemas.ts';

function checkedTemplate(value: unknown) {
  try {
    return parseWorkflowTemplate(value);
  } catch (error) {
    return usage(error instanceof Error ? error.message : 'Invalid workflow template');
  }
}

export const projectHandlers = {
  railflow_health: (_: ToolArgs<'railflow_health'>, { ops }: ToolHandlerContext) => ops.health(),
  async railflow_projects_list(
    args: ToolArgs<'railflow_projects_list'>,
    { ops, page }: ToolHandlerContext,
  ) {
    return page((await ops.listProjects()).map(toProjectHead), args);
  },
  async railflow_project_get(
    { projectId }: ToolArgs<'railflow_project_get'>,
    { ops }: ToolHandlerContext,
  ) {
    return { project: await ops.getProject(projectId) };
  },
  async railflow_project_create(
    { name, id, template }: ToolArgs<'railflow_project_create'>,
    { ops }: ToolHandlerContext,
  ) {
    const project = await ops.createProject({
      name,
      id,
      template: template === undefined ? undefined : checkedTemplate(template),
    });
    return { project: toProjectHead(project) };
  },
  async railflow_workflow_set(
    { projectId, definition, expectedUpdatedAt }: ToolArgs<'railflow_workflow_set'>,
    { ops }: ToolHandlerContext,
  ) {
    // The API accepts a portable patch, including stage fields that it fills with defaults.
    const project = await ops.setWorkflow(
      projectId,
      definition as Partial<PortableWorkflow>,
      expectedUpdatedAt,
    );
    return { project: toProjectHead(project) };
  },
  railflow_project_delete(
    { projectId }: ToolArgs<'railflow_project_delete'>,
    { ops }: ToolHandlerContext,
  ) {
    return ops.deleteProject(projectId);
  },
  async railflow_templates_list(
    args: ToolArgs<'railflow_templates_list'>,
    { ops, page }: ToolHandlerContext,
  ) {
    const { builtins, saved } = await ops.listTemplates();
    const items = [
      ...builtins.map(({ template }) => ({ source: 'builtin' as const, ...template })),
      ...saved.map(({ template }) => ({ source: 'saved' as const, ...template })),
    ];
    return page(items, args);
  },
  async railflow_template_export(
    { projectId, name, revision }: ToolArgs<'railflow_template_export'>,
    { ops }: ToolHandlerContext,
  ) {
    return { template: await ops.exportTemplate(projectId, { name, revision }) };
  },
  async railflow_template_validate(
    { template }: ToolArgs<'railflow_template_validate'>,
    { ops }: ToolHandlerContext,
  ) {
    const {
      template: validated,
      preview,
      executionDetails,
    } = await ops.validateTemplate(checkedTemplate(template));
    return { identity: validated.template, preview, executionDetails };
  },
  async railflow_template_save(
    { projectId, name, revision }: ToolArgs<'railflow_template_save'>,
    { ops }: ToolHandlerContext,
  ) {
    const { template } = await ops.saveTemplate(projectId, name, revision);
    return { identity: template.template };
  },
  railflow_template_delete(
    { name, revision, hash }: ToolArgs<'railflow_template_delete'>,
    { ops }: ToolHandlerContext,
  ) {
    return ops.deleteTemplate({ name, revision, hash });
  },
};
