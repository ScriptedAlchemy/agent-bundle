import type {
  EvalRunResult,
  EvalRunSelection,
  EvalSuiteListing,
} from '../../../agent-bundle/src/dev/eval-service.ts';
import type { EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';

export interface EvalClientOptions {
  readonly fetch?: typeof fetch;
}

/** Exactly what a browser may choose: authored suites, authored cases, and a trial count. */
export interface EvalRunStart extends EvalRunSelection {
  readonly trials?: number;
}

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
}

export class EvalClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EvalClientError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): EvalClientError =>
  new EvalClientError('AB8073', 'Eval route returned an invalid response.');

const frozenJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozenJson(entry)])));
  }
  return value;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw invalidResponse();
  return value;
};

const diagnosticError = (value: unknown, status: number): EvalClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new EvalClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new EvalClientError('AB8073', `Eval request failed with HTTP ${status}.`);
};

const suiteListing = (value: unknown): EvalSuiteListing => {
  const body = asRecord(value);
  if (!Array.isArray(body.diagnostics) || !Array.isArray(body.suites)) throw invalidResponse();
  if (!body.suites.every((entry) => isRecord(entry) && typeof entry.name === 'string' && Array.isArray(entry.cases))) {
    throw invalidResponse();
  }
  return frozenJson(body) as EvalSuiteListing;
};

const runResult = (value: unknown): EvalRunResult => {
  const run = asRecord(value).run;
  if (!isRecord(run) || !isRecord(run.run) || !Array.isArray(run.trials) || !Array.isArray(run.aggregates)) {
    throw invalidResponse();
  }
  return frozenJson(run) as EvalRunResult;
};

const runRecords = (value: unknown): readonly EvalRunRecord[] => {
  const runs = asRecord(value).runs;
  if (!Array.isArray(runs) || !runs.every((entry) => isRecord(entry) && typeof entry.id === 'string')) {
    throw invalidResponse();
  }
  return frozenJson(runs) as readonly EvalRunRecord[];
};

/** A typed, credential-memory-only browser client for the deterministic eval routes. */
export class EvalClient {
  readonly #fetch: typeof fetch;
  #authentication: Promise<ForegroundSession> | undefined;

  constructor(options: EvalClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async suites(): Promise<EvalSuiteListing> {
    return suiteListing(await this.#json('/api/evals/suites'));
  }

  async runs(): Promise<readonly EvalRunRecord[]> {
    return runRecords(await this.#json('/api/evals/runs'));
  }

  async read(runId: string): Promise<EvalRunResult> {
    return runResult(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}`));
  }

  async start(selection: EvalRunStart, signal?: AbortSignal): Promise<EvalRunResult> {
    return runResult(await this.#json('/api/evals/runs', {
      body: JSON.stringify({
        ...(selection.caseIds === undefined ? {} : { caseIds: selection.caseIds }),
        ...(selection.suites === undefined ? {} : { suites: selection.suites }),
        ...(selection.trials === undefined ? {} : { trials: selection.trials }),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void {
    this.#authentication = undefined;
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const authentication = await this.#authenticate();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await this.#fetch(path, { ...init, headers });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
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
    if (!response.ok) throw diagnosticError(body, response.status);
    const session = asRecord(body);
    if (typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) {
      throw new EvalClientError('AB8073', 'Foreground session bootstrap returned an invalid response.');
    }
    let origin: URL;
    try {
      origin = new URL(session.origin);
    } catch {
      throw new EvalClientError('AB8073', 'Foreground session bootstrap returned an invalid origin.');
    }
    if (origin.origin !== session.origin) {
      throw new EvalClientError('AB8073', 'Foreground session bootstrap returned an invalid origin.');
    }
    const browserOrigin = globalThis.location?.origin;
    if (browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== session.origin) {
      throw new EvalClientError('AB8003', 'Foreground session bootstrap origin does not match this browser.');
    }
    return Object.freeze({ origin: session.origin, token: session.token });
  }
}
