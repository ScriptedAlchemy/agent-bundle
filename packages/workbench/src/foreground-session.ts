export interface ForegroundSession {
  readonly instanceId: string;
  readonly origin: string;
  readonly token: string;
}

export interface ForegroundSessionSnapshot extends ForegroundSession {
  readonly generation: number;
}

/** Decodes the exact credential envelope returned by `/api/project/session`. */
export const decodeForegroundSession = (value: unknown): ForegroundSession | undefined => {
  if (
    !isRecord(value) || Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'instanceId') || !Object.hasOwn(value, 'origin') || !Object.hasOwn(value, 'token')
  ) {
    return undefined;
  }
  if (
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 || value.instanceId.length > 128 || value.instanceId.trim() !== value.instanceId ||
    typeof value.origin !== 'string' || typeof value.token !== 'string'
  ) {
    return undefined;
  }
  return Object.freeze({ instanceId: value.instanceId, origin: value.origin, token: value.token });
};

export interface ForegroundTransportOptions {
  /**
   * Each client keeps its own error type and diagnostic band; only the shape is
   * shared. The decoded body is passed so a client can carry fields that are the
   * answer rather than an internal detail, such as validation diagnostics.
   */
  readonly errorFor: (code: string, message: string, body?: unknown) => Error;
  readonly fallbackCode: string;
  readonly fetch?: typeof fetch;
  readonly label: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ForegroundSessionAuthorityOptions {
  /** Overrides the browser origin only when an embedding host provides the capability boundary. */
  readonly browserOrigin?: string;
  readonly fetch?: typeof fetch;
}

/** Shares one foreground bootstrap credential snapshot between workbench clients. */
export class ForegroundSessionAuthority {
  readonly #browserOrigin: string | undefined;
  readonly #fetch: typeof fetch;
  #initialBootstrap: Promise<ForegroundSessionSnapshot> | undefined;
  #latestStartedBootstrapRequest = 0;
  #snapshot: ForegroundSessionSnapshot | undefined;

  constructor(options: ForegroundSessionAuthorityOptions = {}) {
    this.#browserOrigin = options.browserOrigin ?? globalThis.location?.origin;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  snapshot(): Promise<ForegroundSessionSnapshot> {
    if (this.#snapshot !== undefined) return Promise.resolve(this.#snapshot);
    if (this.#initialBootstrap === undefined) {
      const bootstrap = this.#bootstrap(++this.#latestStartedBootstrapRequest);
      this.#initialBootstrap = bootstrap;
      void bootstrap.catch(() => {
        if (this.#initialBootstrap === bootstrap) this.#initialBootstrap = undefined;
      });
    }
    return this.#initialBootstrap;
  }

  refresh(): Promise<ForegroundSessionSnapshot> {
    return this.#bootstrap(++this.#latestStartedBootstrapRequest);
  }

  async #bootstrap(request: number): Promise<ForegroundSessionSnapshot> {
    try {
      const response = await this.#fetch('/api/project/session', { credentials: 'same-origin' });
      if (request !== this.#latestStartedBootstrapRequest) {
        if (this.#snapshot !== undefined) return this.#snapshot;
        throw new Error('Foreground session bootstrap was superseded.');
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (request !== this.#latestStartedBootstrapRequest) {
        if (this.#snapshot !== undefined) return this.#snapshot;
        throw new Error('Foreground session bootstrap was superseded.');
      }
      const session = decodeForegroundSession(body);
      if (!response.ok || session === undefined || session.token.length === 0) {
        throw new Error('Foreground session bootstrap returned an invalid response.');
      }
      let origin: URL;
      try {
        origin = new URL(session.origin);
      } catch {
        throw new Error('Foreground session bootstrap returned an invalid origin.');
      }
      if (origin.origin !== session.origin) throw new Error('Foreground session bootstrap returned an invalid origin.');
      if (this.#browserOrigin !== undefined && this.#browserOrigin !== 'null' && this.#browserOrigin !== session.origin) {
        throw new Error('Foreground session bootstrap origin does not match this browser.');
      }
      const generation = this.#snapshot === undefined
        ? 0
        : this.#snapshot.instanceId === session.instanceId
          ? this.#snapshot.generation
          : this.#snapshot.generation + 1;
      const snapshot = Object.freeze({ ...session, generation });
      this.#snapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (request !== this.#latestStartedBootstrapRequest && this.#snapshot !== undefined) return this.#snapshot;
      throw error;
    }
  }
}

const abortError = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/** Waits for an operation without allowing one caller's signal to cancel shared work. */
export const awaitWithAbort = <T>(signal: AbortSignal | null | undefined, operation: () => Promise<T>): Promise<T> => {
  if (signal === undefined || signal === null) return operation();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => reject(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation().then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
};

/**
 * One same-origin session handshake for every workbench client. Origin pinning is a
 * security boundary, so it lives in one place rather than once per page's client.
 */
export class ForegroundTransport {
  readonly #errorFor: (code: string, message: string, body?: unknown) => Error;
  readonly #fallbackCode: string;
  readonly #fetch: typeof fetch;
  readonly #label: string;
  #authentication: Promise<ForegroundSession> | undefined;

  constructor(options: ForegroundTransportOptions) {
    this.#errorFor = options.errorFor;
    this.#fallbackCode = options.fallbackCode;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#label = options.label;
  }

  /** Sends one authenticated same-session request and decodes a diagnostic body into the client's error. */
  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const authentication = await awaitWithAbort(init.signal, () => this.#authenticate());
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await awaitWithAbort(init.signal, () => this.#fetch(path, { ...init, headers }));
    const body: unknown = await awaitWithAbort(init.signal, () => response.json().catch(() => undefined));
    if (!response.ok) throw this.diagnosticError(body, response.status);
    return body;
  }

  /** Authenticated raw response, for callers that read a stream body themselves. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const authentication = await awaitWithAbort(init.signal, () => this.#authenticate());
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    return awaitWithAbort(init.signal, () => this.#fetch(path, { ...init, headers }));
  }

  diagnosticError(value: unknown, status: number): Error {
    if (
      isRecord(value) && isRecord(value.diagnostic) &&
      typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string'
    ) {
      return this.#errorFor(value.diagnostic.code, value.diagnostic.message, value);
    }
    return this.#errorFor(this.#fallbackCode, `${this.#label} request failed with HTTP ${status}.`, value);
  }

  invalidResponse(): Error {
    return this.#errorFor(this.#fallbackCode, `${this.#label} route returned an invalid response.`);
  }

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forget(): void {
    this.#authentication = undefined;
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
    if (!response.ok) throw this.diagnosticError(body, response.status);
    const session = decodeForegroundSession(body);
    if (session === undefined || session.token.length === 0) {
      throw this.#errorFor(this.#fallbackCode, 'Foreground session bootstrap returned an invalid response.');
    }
    const { instanceId, origin: declared, token } = session;
    let origin: URL;
    try {
      origin = new URL(declared);
    } catch {
      throw this.#errorFor(this.#fallbackCode, 'Foreground session bootstrap returned an invalid origin.');
    }
    if (origin.origin !== declared) {
      throw this.#errorFor(this.#fallbackCode, 'Foreground session bootstrap returned an invalid origin.');
    }
    const browserOrigin = globalThis.location?.origin;
    if (browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== declared) {
      throw this.#errorFor('AB8003', 'Foreground session bootstrap origin does not match this browser.');
    }
    return Object.freeze({ instanceId, origin: declared, token });
  }
}
