export interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
}

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
    const authentication = await this.#authenticate();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await this.#fetch(path, { ...init, headers });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw this.diagnosticError(body, response.status);
    return body;
  }

  /** Authenticated raw response, for callers that read a stream body themselves. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const authentication = await this.#authenticate();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    return this.#fetch(path, { ...init, headers });
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
    if (!isRecord(body)) throw this.invalidResponse();
    const { origin: declared, token } = body;
    if (typeof declared !== 'string' || typeof token !== 'string' || token.length === 0) {
      throw this.#errorFor(this.#fallbackCode, 'Foreground session bootstrap returned an invalid response.');
    }
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
