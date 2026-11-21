import { isPromise } from 'node:util/types';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const SERVER_BUSY = -32000;
export const RESOURCE_NOT_FOUND = -32002;

export type JsonRpcId = string | number;

export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    this.data = data;
  }
}

export interface McpRequestContext {
  signal: AbortSignal;
  requestId: JsonRpcId;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

type Params = Record<string, unknown>;
type Handler<P> = (params: P, ctx: McpRequestContext) => unknown;

export interface McpServerHandlers {
  serverInfo: McpServerInfo;
  listTools: Handler<{ cursor?: string }>;
  callTool: Handler<{ name: string; arguments?: Params }>;
  listResources: Handler<{ cursor?: string }>;
  listResourceTemplates: Handler<{ cursor?: string }>;
  readResource: Handler<{ uri: string }>;
  onDiagnostic?: (message: string) => void;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: '2.0';
      id: JsonRpcId | null;
      error: { code: number; message: string; data?: unknown };
    };

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isObject(value: unknown): value is Params {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isId(id: unknown): id is JsonRpcId {
  return typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
}

function idKey(id: JsonRpcId): string {
  return typeof id + ':' + id;
}

function invalidParams(): never {
  throw new McpProtocolError(INVALID_PARAMS, 'Invalid params');
}

type SessionState = 'new' | 'initializing' | 'ready' | 'closed';

export function createMcpSession(
  handlers: McpServerHandlers,
  send: (response: JsonRpcResponse) => void | Promise<void>,
  { maxConcurrent = 8 } = {},
) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }
  let state: SessionState = 'new';
  const active = new Map<string, AbortController>();

  function dispatch(method: string, params: Params, ctx: McpRequestContext) {
    if (method === 'ping') {
      if (
        Object.keys(params).some((key) => key !== '_meta') ||
        (params._meta !== undefined && !isObject(params._meta))
      )
        invalidParams();
      return {};
    }
    if (method === 'initialize') {
      if (state !== 'new') throw new McpProtocolError(INVALID_REQUEST, 'Already initialized');
      if (
        typeof params.protocolVersion !== 'string' ||
        !isObject(params.capabilities) ||
        !isObject(params.clientInfo) ||
        typeof params.clientInfo.name !== 'string' ||
        typeof params.clientInfo.version !== 'string'
      )
        invalidParams();
      state = 'initializing';
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: handlers.serverInfo,
        capabilities: { tools: {}, resources: {} },
      };
    }

    switch (method) {
      case 'tools/list':
      case 'resources/list':
      case 'resources/templates/list': {
        requireReady();
        const { cursor } = params;
        if (cursor !== undefined && typeof cursor !== 'string') invalidParams();
        const page = cursor === undefined ? {} : { cursor };
        if (method === 'tools/list') return handlers.listTools(page, ctx);
        if (method === 'resources/list') return handlers.listResources(page, ctx);
        return handlers.listResourceTemplates(page, ctx);
      }
      case 'tools/call': {
        requireReady();
        const { name, arguments: args } = params;
        if (typeof name !== 'string' || !name.trim() || (args !== undefined && !isObject(args)))
          invalidParams();
        return handlers.callTool(args === undefined ? { name } : { name, arguments: args }, ctx);
      }
      case 'resources/read': {
        requireReady();
        const { uri } = params;
        if (typeof uri !== 'string' || !uri.trim()) invalidParams();
        return handlers.readResource({ uri }, ctx);
      }
      default:
        throw new McpProtocolError(METHOD_NOT_FOUND, 'Method not found');
    }
  }

  function requireReady() {
    if (state !== 'ready') throw new McpProtocolError(INVALID_REQUEST, 'Server not initialized');
  }

  async function handleMessage(message: unknown): Promise<void> {
    if (state === 'closed') return;
    if (!isObject(message)) return send(errorResponse(null, INVALID_REQUEST, 'Invalid request'));
    const { id, method, params = {} } = message;
    if (
      message.jsonrpc !== '2.0' ||
      typeof method !== 'string' ||
      !isObject(params) ||
      (Object.hasOwn(message, 'id') && !isId(id))
    ) {
      return send(errorResponse(isId(id) ? id : null, INVALID_REQUEST, 'Invalid request'));
    }
    if (!isId(id)) {
      if (method === 'notifications/initialized' && state === 'initializing') state = 'ready';
      if (
        method === 'notifications/cancelled' &&
        isId(params.requestId) &&
        (params.reason === undefined || typeof params.reason === 'string')
      ) {
        active.get(idKey(params.requestId))?.abort(params.reason);
      }
      return;
    }

    const key = idKey(id);
    if (active.has(key))
      return send(errorResponse(id, INVALID_REQUEST, 'Duplicate in-flight request ID'));
    if (active.size >= maxConcurrent) return send(errorResponse(id, SERVER_BUSY, 'Server busy'));
    const controller = new AbortController();
    const { signal } = controller;
    active.set(key, controller);
    try {
      const pending = dispatch(method, params, { signal, requestId: id });
      const result = isPromise(pending) ? await pending : pending;
      if (signal.aborted) return;
      if (result === undefined || typeof result === 'function' || typeof result === 'symbol') {
        throw new TypeError('Handler returned no JSON result');
      }
      return send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof McpProtocolError)
        return send(errorResponse(id, error.code, error.message, error.data));
      handlers.onDiagnostic?.('MCP request handler failed');
      return send(errorResponse(id, INTERNAL_ERROR, 'Internal error'));
    } finally {
      active.delete(key);
    }
  }

  function close() {
    state = 'closed';
    for (const controller of active.values()) controller.abort();
    active.clear();
  }

  return {
    get state() {
      return state;
    },
    handleMessage,
    close,
  };
}
