export interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
}

/** Decodes the exact credential envelope returned by `/api/project/session`. */
export const decodeForegroundSession = (value: unknown): ForegroundSession | undefined => {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'origin') || !Object.hasOwn(value, 'token')) {
    return undefined;
  }
  if (typeof value.origin !== 'string' || typeof value.token !== 'string') return undefined;
  return Object.freeze({ origin: value.origin, token: value.token });
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
    const { origin: declared, token } = session;
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
    return Object.freeze({ origin: declared, token });
  }
}
