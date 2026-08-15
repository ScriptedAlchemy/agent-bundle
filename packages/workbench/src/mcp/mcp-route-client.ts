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

export interface ForegroundRouteClientOptions {
  readonly fetch?: typeof fetch;
}

export interface McpRouteClientOptions extends ForegroundRouteClientOptions {
  /** Reuses Workbench's memory-only foreground authentication authority. */
  readonly foreground?: ForegroundRouteClient;
}

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
}

interface ForegroundAuthentication {
  readonly generation: number;
  readonly promise: Promise<ForegroundSession>;
}

interface Diagnostic {
  readonly code: string;
  readonly details?: unknown;
  readonly message: string;
  readonly phase?: string;
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
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: true,
        value: detachedJson(entry, ancestors),
        writable: false,
      });
    }
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
    return Object.freeze({
      code: value.diagnostic.code,
      ...(value.diagnostic.details === undefined ? {} : { details: detachedJson(value.diagnostic.details) }),
      message: value.diagnostic.message,
      ...(typeof value.diagnostic.phase === 'string' ? { phase: value.diagnostic.phase } : {}),
    });
  }
  return Object.freeze({ code: 'AB8019', message: `Foreground MCP request failed with HTTP ${status}.` });
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
    typeof binding.epochId !== 'string' || typeof binding.serverName !== 'string' || !isTarget(binding.target)
  ) {
    throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid session.');
  }
  return Object.freeze({
    binding: Object.freeze({ epochId: binding.epochId, serverName: binding.serverName, target: binding.target }),
    connection: routeConnection(session.connection),
    id: session.id,
  });
};

const encode = (value: string): string => encodeURIComponent(value);

const foregroundRoute = (path: string): string => {
  const origin = 'http://foreground.invalid';
  let parsed: URL;
  try {
    parsed = new URL(path, origin);
  } catch {
    throw new ForegroundRouteClientError('AB8015', 'Foreground route is not valid.', 400);
  }
  if (!path.startsWith('/') || path.startsWith('//') || parsed.origin !== origin || parsed.username.length > 0 || parsed.password.length > 0 ||
    parsed.hash.length > 0 || `${parsed.pathname}${parsed.search}` !== path) {
    throw new ForegroundRouteClientError('AB8015', 'Foreground route is not valid.', 400);
  }
  return path;
};

/** Memory-only authentication shared by foreground browser route clients. */
export class ForegroundRouteClient {
  readonly #fetch: typeof fetch;
  #authentication: ForegroundAuthentication | undefined;
  #authenticationGeneration = 0;

  constructor(options: ForegroundRouteClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async publicJson(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.#json(await this.#fetch(foregroundRoute(path), init));
  }

  async protectedJson(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.#json(await this.protectedResponse(path, init));
  }

  async protectedResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const route = foregroundRoute(path);
    const authentication = this.#authenticate();
    const session = await authentication.promise;
    if (!this.#isAuthenticationCurrent(authentication)) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground authentication was invalidated.', 401);
    }
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', session.token);
    const response = await this.#fetch(route, { ...init, headers });
    if (!response.ok) throw ForegroundRouteClientError.fromResponse(await response.clone().json().catch(() => undefined), response.status);
    return response;
  }

  /** Erases the short-lived foreground token once its owning transport closes. */
  forgetAuthentication(): void {
    if (this.#authentication === undefined) return;
    this.#authentication = undefined;
    this.#authenticationGeneration += 1;
  }

  async #json(response: Response): Promise<unknown> {
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw ForegroundRouteClientError.fromResponse(body, response.status);
    try {
      return detachedJson(body);
    } catch (error) {
      if (error instanceof McpRouteClientError) throw new ForegroundRouteClientError(error.code, error.message, response.status);
      throw error;
    }
  }

  #authenticate(): ForegroundAuthentication {
    if (this.#authentication !== undefined) return this.#authentication;
    const authentication = Object.freeze({
      generation: this.#authenticationGeneration,
      promise: this.#bootstrap(),
    });
    this.#authentication = authentication;
    void authentication.promise.catch(() => {
      if (this.#isAuthenticationCurrent(authentication)) this.#authentication = undefined;
    });
    return authentication;
  }

  #isAuthenticationCurrent(authentication: ForegroundAuthentication): boolean {
    return this.#authentication === authentication && this.#authenticationGeneration === authentication.generation;
  }

  async #bootstrap(): Promise<ForegroundSession> {
    const response = await this.#fetch('/api/project/session', { credentials: 'same-origin' });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw ForegroundRouteClientError.fromResponse(body, response.status);
    if (!isRecord(body) || typeof body.origin !== 'string' || typeof body.token !== 'string' || body.token.length === 0) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid response.', response.status);
    }
    let origin: URL;
    try {
      origin = new URL(body.origin);
    } catch {
      throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid origin.', response.status);
    }
    if (origin.origin !== body.origin) throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid origin.', response.status);
    const browserOrigin = globalThis.location?.origin;
    if (browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== body.origin) {
      throw new ForegroundRouteClientError('AB8003', 'Foreground session bootstrap origin does not match this browser.', response.status);
    }
    return Object.freeze({ origin: body.origin, token: body.token });
  }
}

export class ForegroundRouteClientError extends Error {
  readonly code: string;
  readonly details: unknown | undefined;
  readonly phase: string | undefined;
  readonly status: number;

  constructor(code: string, message: string, status: number, options: Readonly<{ readonly details?: unknown; readonly phase?: string }> = {}) {
    super(message);
    this.name = 'ForegroundRouteClientError';
    this.code = code;
    this.details = options.details;
    this.phase = options.phase;
    this.status = status;
  }

  static fromResponse(body: unknown, status: number): ForegroundRouteClientError {
    const detail = diagnostic(body, status);
    return new ForegroundRouteClientError(detail.code, detail.message, status, detail);
  }
}

/** A typed, credential-memory-only browser client for the foreground MCP routes. */
export class McpRouteClient {
  readonly #foreground: ForegroundRouteClient;

  constructor(options: McpRouteClientOptions = {}) {
    this.#foreground = options.foreground ?? new ForegroundRouteClient({ fetch: options.fetch });
  }

  async create(binding: McpRouteSessionBinding): Promise<McpRouteSession> {
    return routeSession(await this.#json('/api/mcp/sessions', {
      body: JSON.stringify(binding),
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

  forgetAuthentication(): void {
    this.#foreground.forgetAuthentication();
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    try {
      return await this.#foreground.protectedJson(path, init);
    } catch (error) {
      throw this.#mcpError(error);
    }
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#foreground.protectedResponse(path, init);
    } catch (error) {
      throw this.#mcpError(error);
    }
  }

  #mcpError(error: unknown): McpRouteClientError | unknown {
    if (error instanceof McpRouteClientError) return error;
    if (error instanceof ForegroundRouteClientError) return new McpRouteClientError(error.code, error.message);
    return error;
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
