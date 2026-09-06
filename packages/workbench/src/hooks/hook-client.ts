import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundInput,
  HookPlaygroundListOptions,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
} from '../../../agent-bundle/src/contracts/hooks.ts';
import { isRecord } from '../client-helpers.ts';
import { z } from 'zod';

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

const invalidResponse = (): HookClientError =>
  new HookClientError('AB8033', 'Hook playground route returned an invalid response.');

const textSchema = z.string();
const canonicalHookEventSchema = z.enum(['sessionStart', 'beforeTool', 'afterTool', 'stop']);
const canonicalRecordSchema = z.record(z.string(), z.json());
const bindingSchema = z.strictObject({
  epochId: textSchema,
  hook: textSchema,
  target: textSchema,
});
// Mirrors `ArtifactManifestHook`: the manifest's own hook row (#592 step 3).
const hookSchema = z.strictObject({
  event: textSchema,
  host: textSchema,
  id: textSchema,
  kind: z.enum(['config', 'event-route']),
  name: textSchema,
  path: textSchema,
  routeId: textSchema.optional(),
  timeout: z.number().optional(),
});
const hookListSchema = z.strictObject({
  hooks: z.array(z.strictObject({ binding: bindingSchema, hook: hookSchema })),
});
const canonicalIntentSchema = z.strictObject({
  event: canonicalHookEventSchema,
  hook: textSchema,
  input: canonicalRecordSchema,
});
const hostMappingSchema = z.strictObject({
  canonicalEvent: canonicalHookEventSchema,
  matcher: textSchema.optional(),
  nativeEvent: textSchema,
  nativeProjection: z.literal('deterministic'),
  nativeSelector: textSchema,
  target: textSchema,
  wrapperPath: textSchema,
});
const replaySchema = z.strictObject({
  binding: bindingSchema,
  input: canonicalRecordSchema,
});
const simulationSchema = z.strictObject({
  binding: bindingSchema,
  canonicalIntent: canonicalIntentSchema,
  canonicalResult: canonicalRecordSchema.optional(),
  hostMapping: hostMappingSchema,
  nativeInput: canonicalRecordSchema,
  nativeOutput: canonicalRecordSchema.optional(),
  replay: replaySchema,
}).transform((simulation) => ({
  ...simulation,
  canonicalResult: simulation.canonicalResult,
  nativeOutput: simulation.nativeOutput,
} satisfies HookPlaygroundSimulation));
const diagnosticSchema = z.strictObject({
  code: z.enum([
    'hook.playground.event.unsupported',
    'hook.playground.manifest.missing',
    'hook.playground.target.unsupported',
  ]),
  event: textSchema,
  message: textSchema,
  severity: z.literal('error'),
  target: textSchema,
});
const simulationResponseSchema = z.union([
  z.strictObject({ diagnostics: z.array(diagnosticSchema) }),
  z.strictObject({ simulation: simulationSchema }),
]);

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

const frozenJson = <T>(value: T): T => {
  try {
    return deeplyFrozenHookValue(value) as T;
  } catch {
    throw invalidResponse();
  }
};

const diagnosticError = (value: unknown, status: number): HookClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new HookClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new HookClientError('AB8033', `Hook playground request failed with HTTP ${status}.`);
};

const hookList = (value: unknown): readonly HookPlaygroundHook[] => {
  const parsed = hookListSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return frozenJson(parsed.data.hooks);
};

const simulationResult = (value: unknown): HookSimulationResult => {
  const parsed = simulationResponseSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return 'diagnostics' in parsed.data
    ? frozenJson(parsed.data)
    : frozenJson(parsed.data.simulation);
};

/** A typed, credential-memory-only browser client for the epoch-bound hook playground routes. */
export class HookClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: HookClientOptions) {
    this.#foreground = options.foreground;
  }

  async list(options: HookPlaygroundListOptions, signal?: AbortSignal): Promise<readonly HookPlaygroundHook[]> {
    const query = new URLSearchParams({ epochId: options.epochId });
    if (options.target !== undefined) query.set('target', options.target);
    return hookList(await this.#json(`/api/hooks?${query.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    }));
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
