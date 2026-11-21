import { RailflowError } from '../client/types.ts';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  McpProtocolError,
  RESOURCE_NOT_FOUND,
  type McpRequestContext,
  type McpServerHandlers,
} from './protocol.ts';
import { isJobId, isProjectId, type ToolArgs, type ToolName } from './schemas.ts';

const mimeType = 'application/json';
const staticResources = [
  { uri: 'railflow://projects', name: 'Projects', tool: 'railflow_projects_list' },
  { uri: 'railflow://queue', name: 'Queue', tool: 'railflow_queue_get' },
  { uri: 'railflow://templates', name: 'Workflow templates', tool: 'railflow_templates_list' },
] as const;
const resources = staticResources.map(({ uri, name }) => ({ uri, name, mimeType }));

const resourceTemplates = [
  { uriTemplate: 'railflow://projects/{projectId}', name: 'Project' },
  { uriTemplate: 'railflow://projects/{projectId}/jobs', name: 'Project jobs' },
  { uriTemplate: 'railflow://jobs/{jobId}', name: 'Job' },
  { uriTemplate: 'railflow://jobs/{jobId}/logs', name: 'Job log' },
  { uriTemplate: 'railflow://jobs/{jobId}/provenance', name: 'Job provenance' },
  { uriTemplate: 'railflow://jobs/{jobId}/artifacts', name: 'Job artifacts' },
].map((template) => ({ ...template, mimeType }));

type ReadTool = <N extends ToolName>(
  name: N,
  args: ToolArgs<N>,
  ctx: McpRequestContext,
) => Promise<unknown>;

function resolveResource(uri: string, call: ReadTool, ctx: McpRequestContext) {
  const resource = staticResources.find((resource) => resource.uri === uri);
  if (resource) return call(resource.tool, {}, ctx);

  if (uri.startsWith('railflow://')) {
    // Use the raw URI. URL normalization could hide forbidden components or dot segments.
    const parts = uri.slice('railflow://'.length).split('/');
    const [collection, id, suffix] = parts;
    if (
      (parts.length === 2 || parts.length === 3) &&
      collection === 'projects' &&
      isProjectId(id)
    ) {
      if (suffix === undefined) return call('railflow_project_get', { projectId: id }, ctx);
      if (suffix === 'jobs') return call('railflow_jobs_list', { projectId: id }, ctx);
    }
    if ((parts.length === 2 || parts.length === 3) && collection === 'jobs' && isJobId(id)) {
      if (suffix === undefined) return call('railflow_job_get', { jobId: id }, ctx);
      if (suffix === 'logs') return call('railflow_job_logs', { jobId: id }, ctx);
      if (suffix === 'provenance') return call('railflow_provenance_get', { jobId: id }, ctx);
      if (suffix === 'artifacts') return call('railflow_artifacts_list', { jobId: id }, ctx);
    }
  }
  throw new McpProtocolError(INVALID_PARAMS, 'Invalid Railflow resource URI');
}

export function createResourceHandlers(
  call: ReadTool,
): Pick<McpServerHandlers, 'listResources' | 'listResourceTemplates' | 'readResource'> {
  return {
    listResources: () => ({ resources }),
    listResourceTemplates: () => ({ resourceTemplates }),
    async readResource({ uri }, ctx) {
      try {
        const data = await resolveResource(uri, call, ctx);
        return { contents: [{ uri, mimeType, text: JSON.stringify(data) }] };
      } catch (error) {
        if (!(error instanceof RailflowError)) throw error;
        const code = error.status === 404 ? RESOURCE_NOT_FOUND : INTERNAL_ERROR;
        throw new McpProtocolError(code, error.message, error.toJSON());
      }
    },
  };
}
