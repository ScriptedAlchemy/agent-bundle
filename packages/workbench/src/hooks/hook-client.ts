import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundInput,
  HookPlaygroundListOptions,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
} from '../../../agent-bundle/src/dev/hook-playground-service.ts';
import { ForegroundTransport } from '../foreground-session.ts';

export type HookSimulationResult = HookPlaygroundDiagnosticResult | HookPlaygroundSimulation;

export interface HookClientOptions {
  readonly fetch?: typeof fetch;
}

export interface HookSimulationOptions {
  readonly epochId: string;
  readonly hook: string;
  readonly input: HookPlaygroundInput;
  readonly target: string;
}

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
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

const dataValue = (descriptor: PropertyDescriptor): unknown => {
  if (!('value' in descriptor)) throw new TypeError('Hook playground response values must not expose accessors.');
  return descriptor.value;
};

/** Clones JSON-shaped values without reading untrusted property accessors or sharing mutable response data. */
export const deeplyFrozenHookValue = (value: unknown, ancestors = new WeakSet<object>()): unknown => {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Hook playground response values must be JSON-compatible.');
  if (ancestors.has(value)) throw new TypeError('Hook playground response values must not contain cycles.');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = dataValue(descriptors.length!);
      if (typeof length !== 'number') throw new TypeError('Hook playground response arrays must have a numeric length.');
      const clone: unknown[] = new Array(length);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        const descriptor = dataValue(Object.getOwnPropertyDescriptor(descriptors, key)!) as PropertyDescriptor;
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          value: deeplyFrozenHookValue(dataValue(descriptor), ancestors),
          writable: true,
        });
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new TypeError('Hook playground response objects must have a standard or null prototype.');
    }
    const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = dataValue(Object.getOwnPropertyDescriptor(descriptors, key)!) as PropertyDescriptor;
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        value: deeplyFrozenHookValue(dataValue(descriptor), ancestors),
        writable: true,
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
};

const frozenJson = (value: unknown): unknown => {
  try {
    return deeplyFrozenHookValue(value);
  } catch {
    throw invalidResponse();
  }
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw invalidResponse();
  return value;
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
  readonly #transport: ForegroundTransport;

  constructor(options: HookClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new HookClientError(code, message),
      fallbackCode: 'AB8033',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Hook playground',
    });
  }

  async list(options: HookPlaygroundListOptions, signal?: AbortSignal): Promise<readonly HookPlaygroundHook[]> {
    const query = new URLSearchParams({ epochId: options.epochId });
    if (options.target !== undefined) query.set('target', options.target);
    return hookList(await this.#transport.json(`/api/hooks?${query.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    }));
  }

  async simulate(options: HookSimulationOptions, signal?: AbortSignal): Promise<HookSimulationResult> {
    return simulationResult(await this.#transport.json('/api/hooks/simulations', {
      body: JSON.stringify({ epochId: options.epochId, hook: options.hook, input: options.input, target: options.target }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** The saved replay travels back exactly as the service emitted it, epoch binding included. */
  async replay(replay: HookPlaygroundReplay, signal?: AbortSignal): Promise<HookSimulationResult> {
    return simulationResult(await this.#transport.json('/api/hooks/replays', {
      body: JSON.stringify({ binding: replay.binding, input: replay.input }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void {
    this.#transport.forget();
  }

}
