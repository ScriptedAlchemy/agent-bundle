import { CodedClientError, isRecord } from '../client-helpers.ts';
import { ForegroundSessionAuthority, ForegroundTransport } from '../foreground-session.ts';
import { mapStrictJsonReason, snapshotStrictJsonValue } from '../strict-json.ts';

export type McpRouteTarget = 'claude' | 'codex' | 'portable';

export interface McpRouteSessionBinding {
  readonly epochId: string;
  readonly serverName: string;
  readonly target: McpRouteTarget;
}

export interface McpRouteConnection {
  readonly capabilities?: unknown;
  readonly protocolEra?: 'legacy' | 'modern';
  readonly protocolVersion?: string;
  readonly server?: Readonly<{ readonly name: string; readonly version: string }>;
}

export interface McpRouteSession {
  readonly binding: McpRouteSessionBinding;
  readonly connection: McpRouteConnection;
  readonly id: string;
  readonly timeoutMs: number;
}

export interface McpRouteCatalog {
  readonly prompts: readonly unknown[];
  readonly resourceTemplates: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly tools: readonly unknown[];
}

export interface McpRouteTrace {
  readonly entries: readonly unknown[];
  readonly overflow?: unknown;
}

export type McpRouteOperation =
  | Readonly<{ readonly operation: 'initialize' | 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'tools/list' }>
  | Readonly<{ readonly arguments?: Readonly<Record<string, string>>; readonly name: string; readonly operation: 'prompts/get' }>
  | Readonly<{ readonly operation: 'resources/read'; readonly uri: string }>
  | Readonly<{ readonly arguments: Readonly<Record<string, unknown>>; readonly name: string; readonly operation: 'tools/call'; readonly requestId?: string }>;

export interface McpRouteClientOptions {
  readonly authority?: ForegroundSessionAuthority;
  readonly fetch?: typeof fetch;
}

const isTarget = (value: unknown): value is McpRouteTarget =>
  value === 'claude' || value === 'codex' || value === 'portable';

const mcpRouteJsonMessages = {
  'array-shape': 'Foreground MCP data must contain only JSON values.',
  cyclic: 'Foreground MCP data must not be cyclic.',
  'exotic-prototype': 'Foreground MCP data must use ordinary JSON objects.',
  nonfinite: 'Foreground MCP data must contain finite JSON numbers.',
  'not-json': 'Foreground MCP data must contain only JSON values.',
} as const;

const detachedJson = (value: unknown): unknown => {
  try {
    return snapshotStrictJsonValue(value);
  } catch (error) {
    throw new McpRouteClientError('AB8016', mapStrictJsonReason(error, mcpRouteJsonMessages));
  }
};

const asRecord = (value: unknown, code = 'AB8019'): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new McpRouteClientError(code, 'Foreground MCP route returned an invalid response.');
  return detachedJson(value) as Readonly<Record<string, unknown>>;
};

const asArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid response.');
  return detachedJson(value) as readonly unknown[];
};

const routeConnection = (value: unknown): McpRouteConnection => {
  const connection = asRecord(value);
  const server = connection.server;
  let serverSnapshot: Readonly<{ readonly name: string; readonly version: string }> | undefined;
  if (server !== undefined) {
    if (!isRecord(server) || typeof server.name !== 'string' || typeof server.version !== 'string') {
      throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid connection.');
    }
    serverSnapshot = Object.freeze({ name: server.name, version: server.version });
  }
  if (
    connection.protocolEra !== undefined && connection.protocolEra !== 'legacy' && connection.protocolEra !== 'modern' ||
    connection.protocolVersion !== undefined && typeof connection.protocolVersion !== 'string'
  ) {
    throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid connection.');
  }
  return Object.freeze({
    ...(connection.capabilities === undefined ? {} : { capabilities: connection.capabilities }),
    ...(connection.protocolEra === undefined ? {} : { protocolEra: connection.protocolEra }),
    ...(connection.protocolVersion === undefined ? {} : { protocolVersion: connection.protocolVersion }),
    ...(serverSnapshot === undefined ? {} : { server: serverSnapshot }),
  });
};

const routeSession = (value: unknown): McpRouteSession => {
  const response = asRecord(value);
  const session = asRecord(response.session);
  const binding = asRecord(session.binding);
  if (
    typeof session.id !== 'string' || session.id.length === 0 ||
    typeof binding.epochId !== 'string' || typeof binding.serverName !== 'string' || !isTarget(binding.target) ||
    typeof session.timeoutMs !== 'number' || !Number.isFinite(session.timeoutMs) || session.timeoutMs <= 0
  ) {
    throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid session.');
  }
  return Object.freeze({
    binding: Object.freeze({ epochId: binding.epochId, serverName: binding.serverName, target: binding.target }),
    connection: routeConnection(session.connection),
    id: session.id,
    timeoutMs: session.timeoutMs,
  });
};

const encode = (value: string): string => encodeURIComponent(value);

/** A typed, credential-memory-only browser client for the foreground MCP routes. */
export class McpRouteClient {
  readonly #transport: ForegroundTransport;

  constructor(options: McpRouteClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new McpRouteClientError(code, message),
      fallbackCode: 'AB8019',
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Foreground MCP',
    });
  }

  async create(binding: McpRouteSessionBinding, timeoutMs?: number): Promise<McpRouteSession> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new McpRouteClientError('AB8016', 'MCP session timeout must be a positive finite number.');
    }
    return routeSession(await this.#json('/api/mcp/sessions', {
      body: JSON.stringify({ ...binding, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  async session(id: string): Promise<McpRouteSession> {
    return routeSession(await this.#json(this.#sessionPath(id)));
  }

  async connection(id: string): Promise<McpRouteConnection> {
    return routeConnection(asRecord(await this.#json(`${this.#sessionPath(id)}/connection`)).connection);
  }

  async catalog(id: string): Promise<McpRouteCatalog> {
    const response = asRecord(await this.#json(`${this.#sessionPath(id)}/catalog`));
    return Object.freeze({
      prompts: asArray(response.prompts),
      resourceTemplates: asArray(response.resourceTemplates),
      resources: asArray(response.resources),
      tools: asArray(response.tools),
    });
  }

  async config(id: string): Promise<unknown> {
    return asRecord(await this.#json(`${this.#sessionPath(id)}/config`)).config;
  }

  async operation(id: string, operation: McpRouteOperation, signal?: AbortSignal): Promise<unknown> {
    return asRecord(await this.#json(`${this.#sessionPath(id)}/operations`, {
      body: JSON.stringify(operation),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    })).result;
  }

  async trace(id: string, after = 0): Promise<McpRouteTrace> {
    const trace = asRecord(asRecord(await this.#json(`${this.#sessionPath(id)}/trace?after=${this.#cursor(after)}`)).trace);
    return Object.freeze({
      entries: asArray(trace.entries),
      ...(trace.overflow === undefined ? {} : { overflow: trace.overflow }),
    });
  }

  async stream(id: string, after: number, signal?: AbortSignal): Promise<Response> {
    const response = await this.#transport.request(`${this.#sessionPath(id)}/stream?after=${this.#cursor(after)}`, { signal });
    if (!response.ok) {
      throw this.#transport.diagnosticError(await response.clone().json().catch(() => undefined), response.status);
    }
    return response;
  }

  async restart(id: string): Promise<McpRouteConnection> {
    const response = asRecord(await this.#json(`${this.#sessionPath(id)}/restart`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    return routeConnection(response.connection);
  }

  async cancel(id: string, requestId: string, signal?: AbortSignal): Promise<boolean> {
    const response = asRecord(await this.#json(`${this.#sessionPath(id)}/cancel`, {
      body: JSON.stringify({ requestId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
    if (typeof response.cancelled !== 'boolean') throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid cancellation response.');
    return response.cancelled;
  }

  async close(id: string): Promise<boolean> {
    const response = asRecord(await this.#json(this.#sessionPath(id), { method: 'DELETE' }));
    if (typeof response.closed !== 'boolean') throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid close response.');
    return response.closed;
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    return detachedJson(await this.#transport.json(path, init));
  }

  #cursor(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0) throw new McpRouteClientError('AB8017', 'MCP session trace cursor is not valid.');
    return String(value);
  }

  #sessionPath(id: string): string {
    if (id.length === 0) throw new McpRouteClientError('AB8015', 'MCP session is not available.');
    return `/api/mcp/sessions/${encode(id)}`;
  }
}

export class McpRouteClientError extends CodedClientError {
  constructor(code: string, message: string) {
    super('McpRouteClientError', code, message);
  }
}
