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
  readonly fetch?: typeof fetch;
}

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
}

interface Diagnostic {
  readonly code: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTarget = (value: unknown): value is McpRouteTarget =>
  value === 'claude' || value === 'codex' || value === 'portable';

const detachedJson = (value: unknown, ancestors = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new McpRouteClientError('AB8016', 'Foreground MCP data must contain finite JSON numbers.');
  }
  if (typeof value !== 'object') throw new McpRouteClientError('AB8016', 'Foreground MCP data must contain only JSON values.');
  if (ancestors.has(value)) throw new McpRouteClientError('AB8016', 'Foreground MCP data must not be cyclic.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => detachedJson(entry, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new McpRouteClientError('AB8016', 'Foreground MCP data must use ordinary JSON objects.');
    }
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = detachedJson(entry, ancestors);
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
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

const diagnostic = (value: unknown, status: number): Diagnostic => {
  if (isRecord(value) && isRecord(value.diagnostic) && typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return { code: value.diagnostic.code, message: value.diagnostic.message };
  }
  return { code: 'AB8019', message: `Foreground MCP request failed with HTTP ${status}.` };
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
  readonly #fetch: typeof fetch;
  #authentication: Promise<ForegroundSession> | undefined;

  constructor(options: McpRouteClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
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
    return this.#request(`${this.#sessionPath(id)}/stream?after=${this.#cursor(after)}`, { signal });
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

  /** Erases the short-lived foreground token once its owning transport closes. */
  forgetAuthentication(): void {
    this.#authentication = undefined;
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#request(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = diagnostic(body, response.status);
      throw new McpRouteClientError(detail.code, detail.message);
    }
    return detachedJson(body);
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const authentication = await this.#authenticate();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await this.#fetch(path, { ...init, headers });
    if (!response.ok) {
      const body: unknown = await response.clone().json().catch(() => undefined);
      const detail = diagnostic(body, response.status);
      throw new McpRouteClientError(detail.code, detail.message);
    }
    return response;
  }

  async #authenticate(): Promise<ForegroundSession> {
    if (this.#authentication === undefined) this.#authentication = this.#bootstrap();
    try {
      return await this.#authentication;
    } catch (error) {
      this.#authentication = undefined;
      throw error;
    }
  }

  async #bootstrap(): Promise<ForegroundSession> {
    const response = await this.#fetch('/api/project/session', { credentials: 'same-origin' });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = diagnostic(body, response.status);
      throw new McpRouteClientError(detail.code, detail.message);
    }
    const session = asRecord(body);
    if (typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) {
      throw new McpRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid response.');
    }
    let origin: URL;
    try {
      origin = new URL(session.origin);
    } catch {
      throw new McpRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid origin.');
    }
    if (origin.origin !== session.origin) throw new McpRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid origin.');
    const browserOrigin = globalThis.location?.origin;
    if (browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== session.origin) {
      throw new McpRouteClientError('AB8003', 'Foreground session bootstrap origin does not match this browser.');
    }
    return Object.freeze({ origin: session.origin, token: session.token });
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

export class McpRouteClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpRouteClientError';
    this.code = code;
  }
}
