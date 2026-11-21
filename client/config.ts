import { RailflowError, type RailflowErrorData, type ResolvedConfig } from './types.ts';

export const DEFAULT_SERVER = 'http://127.0.0.1:4173';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function parseServerOrigin(raw: string): URL {
  // Inspect the original input so the URL parser cannot hide credentials,
  // dot segments, empty queries, or alternate spellings of an IPv4 address.
  const match = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?\/?$/i.exec(raw);
  const bareIPv6 = /^(https?):\/\/::1\/?$/i.exec(raw);
  if (match?.[0] === raw || bareIPv6?.[0] === raw) {
    const protocol = match?.[1] ?? bareIPv6?.[1];
    const host = match?.[2].toLowerCase() ?? '[::1]';
    const port = match?.[3] ?? '';
    try {
      const origin = new URL(`${protocol}://${host === 'localhost' ? '127.0.0.1' : host}${port}`);
      if (origin.port !== '0') return origin;
    } catch {
      // Invalid port.
    }
  }
  throw new RailflowError({
    kind: 'usage',
    message:
      'Server must be an HTTP or HTTPS loopback origin without credentials, port 0, a path, a query, or a fragment.',
  });
}

export function resolveConfig(
  options: { server?: string; project?: string; requestTimeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const origin = parseServerOrigin(options.server ?? env.RAILFLOW_SERVER ?? DEFAULT_SERVER);
  const projectId = options.project ?? env.RAILFLOW_PROJECT;
  if (projectId !== undefined && (projectId === '' || /[^a-z0-9_-]/.test(projectId))) {
    throw new RailflowError({ kind: 'usage', message: 'Invalid project ID' });
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  validateRequestTimeout(requestTimeoutMs);
  return { origin, ...(projectId === undefined ? {} : { projectId }), requestTimeoutMs };
}

export function validateRequestTimeout(
  timeoutMs: number,
  context?: Pick<RailflowErrorData, 'operation' | 'uploadId' | 'jobId'>,
): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RailflowError({
      ...context,
      kind: 'usage',
      message: 'Request timeout must be a positive safe integer',
    });
  }
}
