import type { EvalComparison } from '../../../agent-bundle/src/eval/compare.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export interface ComparisonClientOptions {
  /** Workbench-owned memory-only session authority shared by all foreground routes. */
  readonly foreground: ForegroundRequestAuthority;
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
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: ComparisonClientOptions) {
    this.#foreground = options.foreground;
  }

  /** The route aligns the two runs; the page never derives a delta of its own. */
  async compare(request: ComparisonRequest, signal?: AbortSignal): Promise<EvalComparison> {
    const query = new URLSearchParams({ base: request.base, candidate: request.candidate });
    return comparisonResult(await this.#json(
      `/api/evals/comparisons?${query.toString()}`,
      signal === undefined ? {} : { signal },
    ));
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
  }
}
