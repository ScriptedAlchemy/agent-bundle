import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundInput,
  HookPlaygroundListOptions,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
} from '../../../agent-bundle/src/dev/hook-playground-service.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export type HookSimulationResult = HookPlaygroundDiagnosticResult | HookPlaygroundSimulation;

export interface HookClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

export interface HookSimulationOptions {
  readonly epochId: string;
  readonly hook: string;
  readonly input: HookPlaygroundInput;
  readonly target: string;
}

export class HookClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HookClientError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): HookClientError =>
  new HookClientError('AB8033', 'Hook playground route returned an invalid response.');

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

const diagnosticError = (value: unknown, status: number): HookClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new HookClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new HookClientError('AB8033', `Hook playground request failed with HTTP ${status}.`);
};

const hookList = (value: unknown): readonly HookPlaygroundHook[] => {
  const hooks = asRecord(value).hooks;
  if (!Array.isArray(hooks)) throw invalidResponse();
  if (!hooks.every((entry) => isRecord(entry) && isRecord(entry.binding) && isRecord(entry.hook))) throw invalidResponse();
  return frozenJson(hooks) as readonly HookPlaygroundHook[];
};

const simulationResult = (value: unknown): HookSimulationResult => {
  const body = asRecord(value);
  if (Array.isArray(body.diagnostics)) {
    return frozenJson({ diagnostics: body.diagnostics }) as HookPlaygroundDiagnosticResult;
  }
  if (isRecord(body.simulation)) return frozenJson(body.simulation) as HookPlaygroundSimulation;
  throw invalidResponse();
};

/** A typed, credential-memory-only browser client for the epoch-bound hook playground routes. */
export class HookClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: HookClientOptions) {
    this.#foreground = options.foreground;
  }

  async list(options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    const query = new URLSearchParams({ epochId: options.epochId });
    if (options.target !== undefined) query.set('target', options.target);
    return hookList(await this.#json(`/api/hooks?${query.toString()}`));
  }

  async simulate(options: HookSimulationOptions, signal?: AbortSignal): Promise<HookSimulationResult> {
    return simulationResult(await this.#json('/api/hooks/simulations', {
      body: JSON.stringify({ epochId: options.epochId, hook: options.hook, input: options.input, target: options.target }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** The saved replay travels back exactly as the service emitted it, epoch binding included. */
  async replay(replay: HookPlaygroundReplay, signal?: AbortSignal): Promise<HookSimulationResult> {
    return simulationResult(await this.#json('/api/hooks/replays', {
      body: JSON.stringify({ binding: replay.binding, input: replay.input }),
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
