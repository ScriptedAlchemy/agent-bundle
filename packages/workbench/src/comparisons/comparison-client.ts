import type { EvalComparison } from '../../../agent-bundle/src/eval/compare.ts';
import { ForegroundTransport } from '../foreground-session.ts';

export interface ComparisonClientOptions {
  readonly fetch?: typeof fetch;
}

export interface ComparisonRequest {
  readonly base: string;
  readonly candidate: string;
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

/** A typed, credential-memory-only browser client for the eval comparison route. */
export class ComparisonClient {
  readonly #transport: ForegroundTransport;

  constructor(options: ComparisonClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new ComparisonClientError(code, message),
      fallbackCode: 'AB8083',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Eval comparison',
    });
  }

  /** The route aligns the two runs; the page never derives a delta of its own. */
  async compare(request: ComparisonRequest, signal?: AbortSignal): Promise<EvalComparison> {
    const query = new URLSearchParams({ base: request.base, candidate: request.candidate });
    return comparisonResult(await this.#transport.json(
      `/api/evals/comparisons?${query.toString()}`,
      signal === undefined ? {} : { signal },
    ));
  }

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void {
    this.#transport.forget();
  }

}
