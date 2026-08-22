import { isRecord } from './client-helpers.ts';

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
  /** The Workbench-wide authority that owns foreground credential refresh. */
  readonly authority?: ForegroundSessionAuthority;
  readonly fallbackCode: string;
  readonly fetch?: typeof fetch;
  readonly label: string;
}

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

export type WaitOnAbort = 'ignore' | 'reject' | 'resolve';

export interface WaitOptions {
  /** Factory for the rejection value when `onAbort` is `reject`. Defaults to a generic AbortError. */
  readonly abortError?: () => Error;
  readonly onAbort?: WaitOnAbort;
  readonly signal?: AbortSignal | null;
}

/** Promise-wrapped delay whose abort behavior is chosen per caller. */
export const wait = (milliseconds: number, options: WaitOptions = {}): Promise<void> => {
  const onAbort = options.onAbort ?? 'ignore';
  const signal = options.signal;
  switch (onAbort) {
    case 'ignore':
      return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });
    case 'reject':
    case 'resolve':
      break;
    default: {
      const exhaustive: never = onAbort;
      return exhaustive;
    }
  }
  if (signal === undefined || signal === null) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
  const aborted = options.abortError ?? abortError;
  return new Promise((resolve, reject) => {
    const settleAbort = (): void => {
      if (onAbort === 'resolve') resolve();
      else reject(aborted());
    };
    if (signal.aborted) {
      settleAbort();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      settleAbort();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
};

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
  readonly #authority: ForegroundSessionAuthority;
  readonly #errorFor: (code: string, message: string, body?: unknown) => Error;
  readonly #fallbackCode: string;
  readonly #fetch: typeof fetch;
  readonly #label: string;

  constructor(options: ForegroundTransportOptions) {
    this.#errorFor = options.errorFor;
    this.#fallbackCode = options.fallbackCode;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#label = options.label;
    this.#authority = options.authority ?? new ForegroundSessionAuthority({ fetch: this.#fetch });
  }

  /** Sends one authenticated same-session request and decodes a diagnostic body into the client's error. */
  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const authentication = await awaitWithAbort(init.signal, () => this.#snapshot());
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await awaitWithAbort(init.signal, () => this.#fetch(path, { ...init, headers }));
    const body: unknown = await awaitWithAbort(init.signal, () => response.json().catch(() => undefined));
    if (!response.ok) throw this.diagnosticError(body, response.status);
    return body;
  }

  /** Authenticated raw response, for callers that read a stream body themselves. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const authentication = await awaitWithAbort(init.signal, () => this.#snapshot());
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    return awaitWithAbort(init.signal, () => this.#fetch(path, { ...init, headers }));
  }

  /** Foreground identity after the same bootstrap-error mapping as `json`/`request`. */
  session(): Promise<ForegroundSessionSnapshot> {
    return this.#snapshot();
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

  async #snapshot(): Promise<ForegroundSessionSnapshot> {
    try {
      return await this.#authority.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Foreground session bootstrap returned an invalid response.';
      throw this.#errorFor(
        message === 'Foreground session bootstrap origin does not match this browser.' ? 'AB8003' : this.#fallbackCode,
        message,
      );
    }
  }
}
