import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DevRuntimeSession } from './runtime-provider.ts';
import type { DevRuntimeMcpOperationRequest, DevRuntimeMcpSessionControlRequest, DevRuntimeMcpSessionRequest } from './runtime-protocol.ts';

const bodyLimit = 64 * 1024;

interface RequestDiagnostic { readonly code: string; readonly message: string; readonly status: number; }
type Route =
  | Readonly<{ readonly kind: 'open' }>
  | Readonly<{ readonly kind: 'restart' | 'close' | 'rpc'; readonly sessionId: string }>;

export interface RuntimeMcpRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  /** Drains provider-owned App invalidations after a manual registry mutation. */
  readonly awaitRegistryMutation?: () => Promise<void>;
  /** Waits for a matching run-bound App logical revoke and cleanup attempt after session close. */
  readonly awaitSessionClose?: (request: DevRuntimeMcpSessionControlRequest) => Promise<void>;
  readonly runtime?: DevRuntimeSession;
}

const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({ code, message, status });
const requestError = (value: RequestDiagnostic): RequestDiagnostic & Error => Object.assign(new Error(value.message), value);
const isRequestDiagnostic = (value: unknown): value is RequestDiagnostic => typeof value === 'object' && value !== null && typeof (value as Partial<RequestDiagnostic>).status === 'number';
const responseJson = (response: ServerResponse, body: unknown): void => { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void => { response.writeHead(value.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ diagnostic: { code: value.code, message: value.message } })); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\0');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const hasOnly = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).every((key) => fields.includes(key));

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const contentType = request.headers['content-type'];
  if (contentType !== 'application/json' && contentType !== 'application/json; charset=utf-8') throw requestError(diagnostic('AB8009', 'Request body must use application/json.', 415));
  const chunks: Buffer[] = [];
  let bytes = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > bodyLimit) rejectPromise(requestError(diagnostic('AB8010', 'Request body exceeds 64 KiB.', 413)));
      else chunks.push(chunk);
    });
    request.once('end', resolvePromise);
    request.once('error', rejectPromise);
  });
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(parsed)) throw new Error('shape');
    return parsed;
  } catch (error) {
    if (isRequestDiagnostic(error)) throw error;
    throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
  }
};

const opaque = (value: string): string => {
  try {
    const decoded = decodeURIComponent(value);
    if (!nonempty(decoded) || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) throw new Error('path');
    return decoded;
  } catch {
    throw requestError(diagnostic('AB8202', 'Runtime route path is not valid.', 400));
  }
};

const route = (target: string | undefined): Route | undefined => {
  const pathname = target?.split(/[?#]/u, 1)[0] ?? '';
  if (
    (target?.includes('?') === true || target?.includes('#') === true) &&
    (pathname === '/api/runtime/mcp/sessions' || pathname.startsWith('/api/runtime/mcp/sessions/'))
  ) {
    throw requestError(diagnostic('AB8202', 'Runtime route path is not valid.', 400));
  }
  if (pathname === '/api/runtime/mcp/sessions') return Object.freeze({ kind: 'open' });
  if (!pathname.startsWith('/api/runtime/mcp/sessions/')) return undefined;
  const parts = pathname.split('/');
  if (parts.length < 6) throw requestError(diagnostic('AB8202', 'Runtime route path is not valid.', 400));
  const sessionId = opaque(parts[5]!);
  if (parts.length === 6) return Object.freeze({ kind: 'close', sessionId });
  if (parts.length === 7 && parts[6] === 'restart') return Object.freeze({ kind: 'restart', sessionId });
  if (parts.length === 7 && parts[6] === 'rpc') return Object.freeze({ kind: 'rpc', sessionId });
  throw requestError(diagnostic('AB8202', 'Runtime route path is not valid.', 400));
};

const openRequest = (body: Record<string, unknown>): DevRuntimeMcpSessionRequest => {
  if (!hasOnly(body, ['expectedRegistryRevision', 'serverName', 'target']) || !nonempty(body.serverName) || !nonempty(body.target) || (body.expectedRegistryRevision !== undefined && !positive(body.expectedRegistryRevision))) {
    throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
  }
  return Object.freeze({ ...(body.expectedRegistryRevision === undefined ? {} : { expectedRegistryRevision: body.expectedRegistryRevision }), serverName: body.serverName, target: body.target });
};

const controlRequest = (body: Record<string, unknown>, sessionId: string): DevRuntimeMcpSessionControlRequest => {
  if (!hasOnly(body, ['expectedSessionRevision', 'sessionId']) || body.sessionId !== sessionId || !positive(body.expectedSessionRevision)) {
    throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
  }
  return Object.freeze({ expectedSessionRevision: body.expectedSessionRevision, sessionId });
};

const json = (value: unknown): value is null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>> =>
  value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
  || Array.isArray(value) && value.every(json) || isRecord(value) && Object.values(value).every(json);

const rpcRequest = (body: Record<string, unknown>, sessionId: string): DevRuntimeMcpOperationRequest => {
  if (!hasOnly(body, ['arguments', 'expectedSessionRevision', 'kind', 'name', 'uri']) || !positive(body.expectedSessionRevision)) {
    throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
  }
  if (body.kind === 'list-tools' || body.kind === 'list-resources') {
    if (!hasOnly(body, ['expectedSessionRevision', 'kind'])) throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
    return Object.freeze({ expectedSessionRevision: body.expectedSessionRevision, kind: body.kind });
  }
  if (body.kind === 'read-resource' && hasOnly(body, ['expectedSessionRevision', 'kind', 'uri']) && nonempty(body.uri)) {
    return Object.freeze({ expectedSessionRevision: body.expectedSessionRevision, kind: 'read-resource', uri: body.uri });
  }
  if (body.kind === 'call-tool' && hasOnly(body, ['arguments', 'expectedSessionRevision', 'kind', 'name']) && nonempty(body.name) && isRecord(body.arguments) && json(body.arguments)) {
    return Object.freeze({ arguments: body.arguments as Readonly<Record<string, never>>, expectedSessionRevision: body.expectedSessionRevision, kind: 'call-tool', name: body.name });
  }
  void sessionId;
  throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
};

/** Stable, manual-only runtime MCP control surface. App previews use non-owning registry views instead. */
export class RuntimeMcpRoutes {
  readonly #authorize: RuntimeMcpRoutesOptions['authorize'];
  readonly #awaitRegistryMutation: RuntimeMcpRoutesOptions['awaitRegistryMutation'];
  readonly #awaitSessionClose: RuntimeMcpRoutesOptions['awaitSessionClose'];
  readonly #runtime: DevRuntimeSession | undefined;
  #closed = false;

  constructor(options: RuntimeMcpRoutesOptions) {
    this.#authorize = options.authorize;
    this.#awaitRegistryMutation = options.awaitRegistryMutation;
    this.#awaitSessionClose = options.awaitSessionClose;
    this.#runtime = options.runtime;
  }
  close(): void { this.#closed = true; }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closed || this.#runtime === undefined) throw requestError(diagnostic('AB8201', 'Development runtime is not available.', 404));
    try {
      const registry = this.#runtime.mcpRegistry;
      const method = request.method ?? 'GET';
      if (parsed.kind === 'open') {
        if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405)), true;
        const session = await registry.open(openRequest(await readBody(request)));
        responseJson(response, { session: session.snapshot() });
        return true;
      }
      if (parsed.kind === 'restart') {
        if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405)), true;
        const reconcile = await registry.restart(controlRequest(await readBody(request), parsed.sessionId));
        await this.#awaitRegistryMutation?.();
        if (reconcile.action === 'restart-failed') {
          return responseDiagnostic(response, diagnostic('AB8205', 'Runtime MCP session restart failed.', 409)), true;
        }
        responseJson(response, { reconcile });
        return true;
      }
      if (parsed.kind === 'close') {
        if (method !== 'DELETE') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405)), true;
        const control = controlRequest(await readBody(request), parsed.sessionId);
        await registry.closeSession(control);
        await this.#awaitSessionClose?.(control);
        await this.#awaitRegistryMutation?.();
        responseJson(response, { closed: true });
        return true;
      }
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405)), true;
      const view = registry.session(parsed.sessionId);
      if (view === undefined) throw requestError(diagnostic('AB8201', 'Runtime MCP session is not available.', 404));
      responseJson(response, { result: await view.execute(rpcRequest(await readBody(request), parsed.sessionId)) });
      return true;
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      const anyError = error as Partial<{ readonly code: string }>;
      if (anyError.code === 'AB8204' || anyError.code === 'RUNTIME_MCP_REGISTRY_CONFLICT') {
        throw requestError(diagnostic('AB8204', 'Runtime session revision is stale or unavailable for this operation.', 409));
      }
      if (anyError.code === 'RUNTIME_MCP_REGISTRY_NOT_FOUND' || anyError.code === 'RUNTIME_MCP_REGISTRY_CLOSED') {
        throw requestError(diagnostic('AB8201', 'Runtime MCP session is not available.', 404));
      }
      if (anyError.code === 'RUNTIME_MCP_REGISTRY_INVALID') {
        throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
      }
      throw requestError(diagnostic('AB8205', 'Runtime MCP request could not be completed.', 500));
    }
  }
}
