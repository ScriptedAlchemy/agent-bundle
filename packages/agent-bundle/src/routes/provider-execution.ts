import { providerKeyFromName } from './providers.ts';
import type { CompiledProvider } from './types.ts';

/** Provider identity and execution shared by generated scopes and source harnesses. */

/** Deterministic execution order: by mounted key, then by source path for a key collision. */
export const orderedProviders = <T extends Pick<CompiledProvider, 'name' | 'source'>>(
  providers: readonly T[],
): readonly T[] => [...providers].sort((left, right) => {
  const byKey = providerKeyFromName(left.name).localeCompare(providerKeyFromName(right.name));
  return byKey === 0 ? left.source.localeCompare(right.source) : byKey;
});

export const providerFactoryMissingMessage = (key: string, source: string): string =>
  `Context provider "${key}" (${source}) must default-export a factory.`;

export const providerFailedMessage = (key: string, source: string, cause: unknown): string =>
  `Context provider "${key}" (${source}) failed: ${cause instanceof Error ? cause.message : String(cause)}`;

/** The framework-owned process identity a request scope mounts at `context.process`. */
export interface ProviderProcessLifetime {
  hits: number;
  readonly instanceId: string;
  readonly pid: number;
}

export const createProviderProcessLifetime = (): ProviderProcessLifetime => ({
  hits: 0,
  instanceId: crypto.randomUUID(),
  pid: process.pid,
});

/** The immutable snapshot of one process lifetime a request observes. */
export interface ProviderProcessLifetimeValue {
  readonly hits: number;
  readonly instanceId: string;
  readonly pid: number;
}

export const providerProcessLifetimeValue = (
  lifetime: ProviderProcessLifetime,
): ProviderProcessLifetimeValue => ({
  hits: lifetime.hits,
  instanceId: lifetime.instanceId,
  pid: lifetime.pid,
});

/** One loaded provider module in execution order, with the identity its failures name. */
export interface ExecutableProvider {
  readonly key: string;
  readonly module: { readonly default?: unknown };
  /** Project-relative path, as the generated scopes report it. */
  readonly source: string;
}

/**
 * The read-only request view `runAgentRequest` hands a provider resolver
 * (#459): the runtime's `AgentProviderRequest`, spelled structurally so this
 * module — emitted into generated shells and imported by the harness — stays
 * free of the optional runtime peer's declarations. Every member is spread
 * onto the factory context verbatim, beside the surface-specific
 * `invocation`; `signal` is the same request signal the scope opened with.
 */
export interface ProviderRequestView {
  readonly host: unknown;
  readonly lineage: unknown;
  readonly notices?: unknown;
  /** The observed plugin root the request scope publishes (#468); handed to every factory unchanged. */
  readonly plugin: unknown;
  readonly session: unknown;
  readonly signal: AbortSignal;
  readonly state?: unknown;
  readonly workspace: unknown;
}

export interface ExecuteProvidersOptions {
  /** The surface-specific provider invocation (`tool`, `event`, `cli`, `script`). */
  readonly invocation: unknown;
  /** Providers already in {@link orderedProviders} order. */
  readonly providers: readonly ExecutableProvider[];
  /** The request view `runAgentRequest` resolved; the factory context is this plus `invocation`. */
  readonly request: ProviderRequestView;
}

/** Runs the requested provider factories with the same read-only context as generated scopes. */
export const executeProviders = async (
  options: ExecuteProvidersOptions,
): Promise<Readonly<Record<string, unknown>>> => {
  const values: Record<string, unknown> = {};
  for (const provider of options.providers) {
    const factory = provider.module.default;
    if (typeof factory !== 'function') {
      throw new TypeError(providerFactoryMissingMessage(provider.key, provider.source));
    }
    try {
      values[provider.key] = await (factory as (context: ProviderRequestView & { readonly invocation: unknown }) => unknown)({
        ...options.request,
        invocation: options.invocation,
      });
    } catch (error) {
      throw new Error(providerFailedMessage(provider.key, provider.source, error), { cause: error });
    }
  }
  return values;
};
