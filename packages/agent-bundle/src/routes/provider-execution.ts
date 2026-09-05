import { providerKeyFromName } from './providers.ts';
import type { CompiledProvider } from './types.ts';

/**
 * The per-request provider execution contract every generated request scope
 * implements (#313, #366): once per request, sequentially in deterministic
 * key order, fail-closed on a missing factory or a thrown/rejected factory,
 * with the framework-owned `processLifetime` value seeded first.
 *
 * `entry-shell.ts` emits this loop as generated source so artifacts stay
 * self-contained; `agent-bundle/test` runs it in-process through
 * {@link executeProviders}. Ordering and the fail-closed messages live here so
 * the two cannot drift: the harness must mount exactly what the artifact does.
 *
 * Which providers a route resolves is decided before the loop, by
 * {@link selectRequiredProviders} over the route's static declaration (#595):
 * every conventional provider when it declares none, otherwise the declared
 * subset in the same order. The loop itself runs whatever it is handed.
 */

/** Deterministic execution order: by mounted key, then by source path for a key collision. */
export const orderedProviders = <T extends Pick<CompiledProvider, 'name' | 'source'>>(
  providers: readonly T[],
): readonly T[] => [...providers].sort((left, right) => {
  const byKey = providerKeyFromName(left.name).localeCompare(providerKeyFromName(right.name));
  return byKey === 0 ? left.source.localeCompare(right.source) : byKey;
});

/**
 * The provider keys one route statically declares it requires (#595).
 * `undefined` — no declaration — keeps the pre-#595 contract: every
 * conventional provider resolves. An explicit list selects only those
 * providers; `[]` mounts the framework-owned `processLifetime` alone.
 */
export type RequiredProviderKeys = readonly string[] | undefined;

/**
 * The key every request scope seeds itself before any provider runs. The
 * graph refuses a provider module deriving it (AB4942), so no declaration can
 * select it: it is mounted whatever the route declares.
 */
const reservedProviderKey = 'processLifetime';

/**
 * One defect in a required-provider declaration, as pure data: the graph maps
 * each to a diagnostic (message from {@link requiredProviderKeyProblemMessage},
 * code and recovery its own), so the wording never forks between the compiler
 * and the harness.
 */
export type RequiredProviderKeyProblem =
  | { readonly key: string; readonly kind: 'duplicate-provider-key' }
  | { readonly key: string; readonly kind: 'reserved-provider-key' }
  | {
    readonly key: string;
    /** Every selectable key, sorted as {@link orderedProviders} sorts, unique. */
    readonly known: readonly string[];
    readonly kind: 'unknown-provider-key';
  };

/**
 * Validates an explicit declaration against the project's provider keys. One
 * pass in declaration order; every occurrence reports at most one problem —
 * a repeated key is `duplicate` from its second occurrence on, and the first
 * occurrence still reports `reserved` or `unknown` when it is one — so a
 * single build surfaces every defect. Pure: touches neither input, and the
 * empty result means the declaration is accepted.
 */
export const validateRequiredProviderKeys = (
  required: readonly string[],
  knownKeys: Iterable<string>,
): readonly RequiredProviderKeyProblem[] => {
  const known = new Set(knownKeys);
  const listed = Object.freeze([...known].sort((left, right) => left.localeCompare(right)));
  const seen = new Set<string>();
  const problems: RequiredProviderKeyProblem[] = [];
  for (const key of required) {
    if (seen.has(key)) {
      problems.push(Object.freeze({ key, kind: 'duplicate-provider-key' }));
      continue;
    }
    seen.add(key);
    if (key === reservedProviderKey) {
      problems.push(Object.freeze({ key, kind: 'reserved-provider-key' }));
    } else if (!known.has(key)) {
      problems.push(Object.freeze({ key, kind: 'unknown-provider-key', known: listed }));
    }
  }
  return Object.freeze(problems);
};

export const requiredProviderKeyProblemMessage = (problem: RequiredProviderKeyProblem): string => {
  switch (problem.kind) {
    case 'duplicate-provider-key':
      return `Required provider key ${JSON.stringify(problem.key)} is declared more than once.`;
    case 'reserved-provider-key':
      return `Required provider key ${JSON.stringify(problem.key)} is the framework-owned process identity every request mounts; do not declare it.`;
    case 'unknown-provider-key':
      return `Required provider key ${JSON.stringify(problem.key)} matches no conventional provider; ${
        problem.known.length === 0 ? 'the project declares none' : `known keys: ${problem.known.join(', ')}`
      }.`;
    default: {
      const exhaustive: never = problem;
      throw new TypeError(`Unhandled required provider key problem: ${JSON.stringify(exhaustive)}`);
    }
  }
};

/**
 * The outcome of {@link selectRequiredProviders}: the providers one route
 * resolves, already in {@link orderedProviders} order, or the declaration
 * defects that stop it from resolving any.
 */
export type RequiredProviderSelection<T> =
  | { readonly ok: true; readonly providers: readonly T[] }
  | { readonly ok: false; readonly problems: readonly RequiredProviderKeyProblem[] };

/**
 * Selects the providers one route resolves from its declaration (#595): all
 * of them when it declares nothing, otherwise exactly the declared keys —
 * matched against the derived camel-case key a route reads, never the file
 * stem — in the existing key/source order, not declaration order. A
 * declaration with a duplicate, reserved, or unknown key selects nothing and
 * reports every defect instead. The result is frozen; the caller's provider
 * records are not touched.
 */
export const selectRequiredProviders = <T extends Pick<CompiledProvider, 'name' | 'source'>>(
  providers: readonly T[],
  required: RequiredProviderKeys,
): RequiredProviderSelection<T> => {
  const ordered = orderedProviders(providers);
  if (required === undefined) return Object.freeze({ ok: true, providers: Object.freeze(ordered) });
  const keys = ordered.map((provider) => providerKeyFromName(provider.name));
  const problems = validateRequiredProviderKeys(required, keys);
  if (problems.length > 0) return Object.freeze({ ok: false, problems });
  const selected = new Set(required);
  return Object.freeze({
    ok: true,
    providers: Object.freeze(ordered.filter((_provider, index) => selected.has(keys[index]!))),
  });
};

export const providerFactoryMissingMessage = (key: string, source: string): string =>
  `Context provider "${key}" (${source}) must default-export a factory.`;

export const providerFailedMessage = (key: string, source: string, cause: unknown): string =>
  `Context provider "${key}" (${source}) failed: ${cause instanceof Error ? cause.message : String(cause)}`;

/** The framework-owned process identity a request scope mounts at `providers.processLifetime`. */
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
  readonly processLifetime: ProviderProcessLifetime;
  /** Providers already in {@link orderedProviders} order. */
  readonly providers: readonly ExecutableProvider[];
  /** The request view `runAgentRequest` resolved; the factory context is this plus `invocation`. */
  readonly request: ProviderRequestView;
}

/**
 * Executes conventional providers for one request exactly as a generated
 * request scope does: as the request's provider resolver, after its identity
 * axes are frozen and its notice lease is open, before the route runs. The
 * caller increments `processLifetime.hits` before the call, as every generated
 * scope does before its request opens.
 */
export const executeProviders = async (
  options: ExecuteProvidersOptions,
): Promise<Readonly<Record<string, unknown>>> => {
  const values: Record<string, unknown> = {
    processLifetime: providerProcessLifetimeValue(options.processLifetime),
  };
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
