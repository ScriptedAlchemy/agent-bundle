import type {
  EvalRunResult,
  EvalRunSelection,
  EvalSuiteListing,
} from '../../../agent-bundle/src/dev/eval-service.ts';
import type { EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export interface EvalClientOptions {
  /** Workbench-owned memory-only session authority shared by all foreground routes. */
  readonly foreground: ForegroundRequestAuthority;
}

/** Exactly what a browser may choose: authored suites, authored cases, and a trial count. */
export interface EvalRunStart extends EvalRunSelection {
  readonly trials?: number;
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
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: EvalClientOptions) {
    this.#foreground = options.foreground;
  }

  async suites(signal?: AbortSignal): Promise<EvalSuiteListing> {
    return suiteListing(await this.#json('/api/evals/suites', signal === undefined ? {} : { signal }));
  }

  async runs(signal?: AbortSignal): Promise<readonly EvalRunRecord[]> {
    return runRecords(await this.#json('/api/evals/runs', signal === undefined ? {} : { signal }));
  }

  async read(runId: string, signal?: AbortSignal): Promise<EvalRunResult> {
    return runResult(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}`, signal === undefined ? {} : { signal }));
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

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
  }
}
