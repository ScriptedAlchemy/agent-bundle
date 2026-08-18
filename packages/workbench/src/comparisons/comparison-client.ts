import type { EvalComparison } from '../../../agent-bundle/src/eval/compare.ts';
import type { EvalRunRecord, EvalTrialRecord } from '../../../agent-bundle/src/eval/run-store.ts';

export interface ComparisonClientOptions {
  readonly fetch?: typeof fetch;
}

export interface ComparisonRequest {
  readonly base: string;
  readonly candidate: string;
}

export interface EvalRunDetail {
  readonly run: EvalRunRecord;
  readonly trials: readonly EvalTrialRecord[];
}

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
}

export class ComparisonClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ComparisonClientError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): ComparisonClientError =>
  new ComparisonClientError('AB8083', 'Eval comparison route returned an invalid response.');

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

const diagnosticError = (value: unknown, status: number): ComparisonClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new ComparisonClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new ComparisonClientError('AB8083', `Eval comparison request failed with HTTP ${status}.`);
};

const runList = (value: unknown): readonly EvalRunRecord[] => {
  const runs = asRecord(value).runs;
  if (!Array.isArray(runs) || !runs.every((entry) => isRecord(entry) && typeof entry.id === 'string')) {
    throw invalidResponse();
  }
  return frozenJson(runs) as readonly EvalRunRecord[];
};

const runDetail = (value: unknown): EvalRunDetail => {
  const body = asRecord(value);
  if (!isRecord(body.run) || typeof body.run.id !== 'string' || !Array.isArray(body.trials)) throw invalidResponse();
  return frozenJson({ run: body.run, trials: body.trials }) as EvalRunDetail;
};

const comparisonResult = (value: unknown): EvalComparison => {
  const comparison = asRecord(value).comparison;
  if (!isRecord(comparison) ||
    typeof comparison.baselineRunId !== 'string' ||
    typeof comparison.candidateRunId !== 'string' ||
    typeof comparison.sampleSize !== 'number' ||
    !isRecord(comparison.summary) ||
    !Array.isArray(comparison.rows) ||
    !comparison.rows.every((row) => isRecord(row) && typeof row.comparable === 'boolean')) {
    throw invalidResponse();
  }
  return frozenJson(comparison) as EvalComparison;
};

/** A typed, credential-memory-only browser client for the recorded eval run and comparison routes. */
export class ComparisonClient {
  readonly #fetch: typeof fetch;
  #authentication: Promise<ForegroundSession> | undefined;

  constructor(options: ComparisonClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listRuns(signal?: AbortSignal): Promise<readonly EvalRunRecord[]> {
    return runList(await this.#json('/api/evals/runs', signal === undefined ? {} : { signal }));
  }

  async readRun(runId: string, signal?: AbortSignal): Promise<EvalRunDetail> {
    return runDetail(await this.#json(
      `/api/evals/runs/${encodeURIComponent(runId)}`,
      signal === undefined ? {} : { signal },
    ));
  }

  /** The route aligns the two runs; the page never derives a delta of its own. */
  async compare(request: ComparisonRequest, signal?: AbortSignal): Promise<EvalComparison> {
    const query = new URLSearchParams({ base: request.base, candidate: request.candidate });
    return comparisonResult(await this.#json(
      `/api/evals/comparisons?${query.toString()}`,
      signal === undefined ? {} : { signal },
    ));
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
      throw new ComparisonClientError('AB8083', 'Foreground session bootstrap returned an invalid response.');
    }
    let origin: URL;
    try {
      origin = new URL(session.origin);
    } catch {
      throw new ComparisonClientError('AB8083', 'Foreground session bootstrap returned an invalid origin.');
    }
    if (origin.origin !== session.origin) {
      throw new ComparisonClientError('AB8083', 'Foreground session bootstrap returned an invalid origin.');
    }
    const browserOrigin = globalThis.location?.origin;
    if (browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== session.origin) {
      throw new ComparisonClientError('AB8003', 'Foreground session bootstrap origin does not match this browser.');
    }
    return Object.freeze({ origin: session.origin, token: session.token });
  }
}
