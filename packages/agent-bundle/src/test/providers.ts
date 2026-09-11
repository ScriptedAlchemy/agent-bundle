import { join } from 'node:path';

import type {
  AgentPluginIdentity,
  AgentRequestInitBase,
  AgentProviderValues,
  Observed,
  resolvePluginRoot,
} from '@agent-bundle/runtime';

import {
  executeProviders,
  providerProcessLifetimeValue,
  type ExecutableProvider,
  type ProviderProcessLifetime,
  type ProviderProcessLifetimeValue,
} from '../routes/provider-execution.ts';
import { AgentTestError } from './errors.ts';
import type { AgentBundleTestManifest, TestableProviderDescriptor } from './manifest.ts';
import { registeredProviderLoader } from './registry.ts';
import type { RenderedRouteProvenance } from './types.ts';

/**
 * Conventional request context providers for harness request scopes.
 *
 * Factories load on demand through `context.provider(key)`, once per request.
 * They receive the same identity and read-only handles as generated scopes.
 * An explicit `context.providers` map bypasses discovery.
 *
 * What the harness simulates per executable is the framework-owned process
 * identity (`processLifetime`), not module evaluation. Provider modules load
 * through the generated setup's static loaders, so one Rstest worker evaluates
 * each module once and every simulated CLI invocation, route render, and
 * in-memory server in that worker shares its module-level state — the same
 * way the worker shares the route modules themselves. A real artifact
 * evaluates the module afresh in every CLI process and Flight worker, so a
 * provider's module-level cache, counter, or singleton is only proven by the
 * packed and projected proof levels that spawn the artifact; a route-unit test
 * that needs cold module state should substitute a fixture through
 * `context.providers` or reset that state between calls.
 */

export interface MountProvidersOptions {
  /** Explicit provider values from the test; when present they win and nothing is discovered. */
  readonly explicit: Partial<AgentProviderValues> | undefined;
  /** The surface-specific provider invocation the generated scope would pass (`tool`, `event`, `cli`, `script`). */
  readonly invocation: unknown;
  /** Absent for a module rendered directly: no project, so nothing to discover. */
  readonly manifest: AgentBundleTestManifest | undefined;
  /**
   * This request's claimed hit on the simulated executable's process identity
   * (see {@link claimProcessHit}); mounted verbatim as `context.process`.
   */
  readonly processHit: ProviderProcessLifetimeValue;
  readonly provenance?: RenderedRouteProvenance;
}

const loadProvider = async (
  manifest: AgentBundleTestManifest,
  descriptor: TestableProviderDescriptor,
  provenance: RenderedRouteProvenance | undefined,
): Promise<ExecutableProvider> => {
  const loader = registeredProviderLoader(manifest, descriptor.id);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Context provider ${descriptor.id} (${descriptor.relativePath}) is compiled but no test-time module loader is registered for it.`,
      {
        ...(provenance === undefined ? {} : { provenance }),
        recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers provider loaders, or pass context.providers explicitly to skip conventional provider discovery.',
      },
    );
  }
  return { key: descriptor.key, module: await loader(), source: descriptor.relativePath };
};

/**
 * Claims one request's hit on a simulated executable's process identity and
 * snapshots it in the same synchronous step, exactly where the generated
 * scopes do: before any state binding or provider module `await`, so a
 * concurrent request on the same identity cannot move this request's value.
 *
 * Callers scope the identity as the artifact scopes its module-level
 * `processLifetime`: one per CLI invocation (each generated executable starts
 * at hit 1), one per rendered route request, and one per open in-memory MCP
 * server session (shared by every request that session handles). It is never
 * shared across unrelated helper calls, so a provider branching on `hits` or
 * `instanceId` cannot observe warmth the artifact would not exhibit.
 */
export const claimProcessHit = (processLifetime: ProviderProcessLifetime): ProviderProcessLifetimeValue => {
  processLifetime.hits += 1;
  return providerProcessLifetimeValue(processLifetime);
};

export interface HarnessPluginRootOptions {
  /** The test's context seam; an explicit `plugin` wins, as every other injected axis does. */
  readonly context: { readonly plugin?: Observed<AgentPluginIdentity> };
  /** Absent for a module rendered directly. */
  readonly manifest: AgentBundleTestManifest | undefined;
  /** The runtime's resolver, loaded with the rest of the renderer. */
  readonly resolvePluginRoot: typeof resolvePluginRoot;
}

/**
 * The plugin root a harness request scope publishes as `request.plugin` and
 * hands its providers (#468): the test's `context.plugin` when injected,
 * otherwise the runtime's own resolution — `AGENT_BUNDLE_PLUGIN_ROOT` when the
 * environment sets it, else the project root's `.agent-bundle` (the npm
 * package bin's fallback; the working directory's for a module rendered
 * directly). Harness state itself mounts in a temporary directory, so this
 * value describes where an artifact would anchor, not where the test wrote.
 */
export const harnessPluginRoot = (options: HarnessPluginRootOptions): Observed<AgentPluginIdentity> =>
  options.context.plugin
    ?? options.resolvePluginRoot({ fallback: join(options.manifest?.projectRoot ?? process.cwd(), '.agent-bundle') }).identity;

/** Supply explicit fixture values or a lazy resolver over the compiled provider catalog. */
export const mountProviders = (options: MountProvidersOptions): Pick<AgentRequestInitBase, 'resolveProvider' | 'process'> & { readonly providers?: Partial<AgentProviderValues> } => {
  if (options.explicit !== undefined) return { providers: options.explicit, process: options.processHit };
  const manifest = options.manifest;
  if (manifest === undefined) {
    return { process: options.processHit };
  }
  return {
    process: options.processHit,
    resolveProvider: async (key, request) => {
      const descriptor = (manifest.providers ?? []).find((provider) => provider.key === key);
      if (descriptor === undefined) throw new TypeError(`Unknown provider ${JSON.stringify(key)}.`);
      const values = await executeProviders({
        invocation: options.invocation,
        providers: [await loadProvider(manifest, descriptor, options.provenance)],
        request,
      });
      return values[key];
    },
  };
};
