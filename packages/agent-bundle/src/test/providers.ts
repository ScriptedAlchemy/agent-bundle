import type { AgentProviderValues } from '@agent-bundle/runtime';

import {
  executeProviders,
  providerProcessLifetimeValue,
  type ExecutableProvider,
  type ProviderProcessLifetime,
} from '../routes/provider-execution.ts';
import { AgentTestError } from './errors.ts';
import type { AgentBundleTestManifest, TestableProviderDescriptor } from './manifest.ts';
import { registeredProviderLoader } from './registry.ts';
import type { RenderedRouteProvenance } from './types.ts';

/**
 * Conventional request context providers for harness request scopes.
 *
 * Every generated request scope discovers `src/providers/*` and executes them
 * once per request before `runAgentRequest` (#313, #366). The harness does the
 * same for every manifest-backed render, dispatch, and in-memory projection,
 * through the shared execution helper the generated scopes mirror, so a test
 * observes the provider map the artifact would mount. A test that passes
 * `context.providers` opts out: the explicit map is used verbatim, exactly as
 * the runtime's request contract reads it.
 */

export interface MountProvidersOptions {
  /** Explicit provider values from the test; when present they win and nothing is discovered. */
  readonly explicit: AgentProviderValues | undefined;
  /** The surface-specific provider invocation the generated scope would pass (`tool`, `event`, `cli`, `script`). */
  readonly invocation: unknown;
  /** Absent for a module rendered directly: no project, so nothing to discover. */
  readonly manifest: AgentBundleTestManifest | undefined;
  /**
   * The process identity of the simulated executable, scoped exactly as the
   * artifact scopes its module-level `processLifetime`: one per CLI
   * invocation (each generated executable starts at hit 1), one per rendered
   * route request, and one per open in-memory MCP server session (shared by
   * every request that session handles). Never shared across unrelated
   * helper calls, so a provider branching on `hits` or `instanceId` cannot
   * observe warmth the artifact would not exhibit.
   */
  readonly processLifetime: ProviderProcessLifetime;
  readonly provenance?: RenderedRouteProvenance;
  readonly signal: AbortSignal;
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
 * The `providers` value for one harness request scope: the explicit map when
 * the test supplied one, otherwise the project's conventional providers
 * executed in the generated order over the caller's process identity.
 */
export const mountProviders = async (options: MountProvidersOptions): Promise<AgentProviderValues> => {
  if (options.explicit !== undefined) return options.explicit;
  const { processLifetime } = options;
  processLifetime.hits += 1;
  if (options.manifest === undefined) {
    return { processLifetime: providerProcessLifetimeValue(processLifetime) };
  }
  const providers: ExecutableProvider[] = [];
  for (const descriptor of options.manifest.providers ?? []) {
    providers.push(await loadProvider(options.manifest, descriptor, options.provenance));
  }
  return executeProviders({
    invocation: options.invocation,
    processLifetime,
    providers,
    signal: options.signal,
  });
};
