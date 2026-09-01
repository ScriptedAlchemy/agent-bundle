import { AgentTestError } from './errors.ts';
import type { AgentBundleTestManifest } from './manifest.ts';
import type { AgentRouteModuleLoader } from './types.ts';

/**
 * The realm bridge between the generated Rstest configuration and the test
 * helpers. The configuration compiles the manifest once and writes a generated
 * setup module that installs it here; helpers imported by the test file read
 * it back. A realm global keeps the two sides independent of how the consumer
 * bundler resolved `agent-bundle/test`, the same reason the runtime's request
 * store uses one.
 */
export const AGENT_TEST_REGISTRY_SYMBOL_KEY = 'agent-bundle/test-route-registry';

const REGISTRY_SYMBOL = Symbol.for(AGENT_TEST_REGISTRY_SYMBOL_KEY);

export const AGENT_TEST_REGISTRY_VERSION = 1;

export interface AgentTestRouteRegistry {
  /** Lazy loaders keyed by compiled route id, so a test only compiles the routes it renders. */
  readonly loaders: Readonly<Record<string, AgentRouteModuleLoader>>;
  readonly manifest: AgentBundleTestManifest;
  readonly version: number;
}

const realm = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: AgentTestRouteRegistry };

const missingRegistry = (): AgentTestError => new AgentTestError(
  'manifest-unavailable',
  'No Agent Bundle test manifest is registered in this test process.',
  {
    recovery: 'Build the Rstest configuration with agentBundleRstest() from agent-bundle/rstest, or call compileTestManifest() and pass the route module to renderRoute() directly.',
  },
);

const compatible = (registry: AgentTestRouteRegistry): AgentTestRouteRegistry => {
  if (registry.version !== AGENT_TEST_REGISTRY_VERSION) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Incompatible Agent Bundle test registry version: found ${String(registry.version)}, expected ${String(AGENT_TEST_REGISTRY_VERSION)}.`,
      { recovery: 'Install one agent-bundle version for both the Rstest configuration and the test helpers.' },
    );
  }
  return registry;
};

export const registerTestRoutes = (registry: AgentTestRouteRegistry): void => {
  realm[REGISTRY_SYMBOL] = compatible(registry);
};

/**
 * The registry this worker may read. The version is checked here rather than
 * only in `registerTestRoutes`, because the generated setup module assigns the
 * realm global directly: when the Rstest helper and `agent-bundle/test` resolve
 * to different package versions, this is the only place that mismatch is seen
 * before it surfaces as a misleading loader or manifest error.
 */
const registered = (): AgentTestRouteRegistry | undefined => {
  const registry = realm[REGISTRY_SYMBOL];
  return registry === undefined ? undefined : compatible(registry);
};

/**
 * The manifest the generated configuration registered for this test process.
 * Throws with the wiring step when nothing is registered — a silent empty
 * manifest would read as "this project declares no routes".
 */
export const testManifest = (): AgentBundleTestManifest => {
  const registry = registered();
  if (registry === undefined) throw missingRegistry();
  return registry.manifest;
};

/**
 * Whether `manifest` is the compilation whose loaders were registered. Two
 * projects can name the same route id, so identity is the manifest digest and
 * project root rather than the route id alone.
 */
const producedRegisteredLoaders = (
  registry: AgentTestRouteRegistry,
  manifest: AgentBundleTestManifest,
): boolean =>
  registry.manifest === manifest
  || (registry.manifest.digest === manifest.digest && registry.manifest.projectRoot === manifest.projectRoot);

/**
 * The registered loader for one route of `manifest`. Loaders are bound to the
 * manifest that produced them: an explicit manifest describing another project
 * resolves no loader, so a multi-project suite cannot execute the registered
 * project's module while reporting the other manifest's provenance.
 */
export const registeredRouteLoader = (
  manifest: AgentBundleTestManifest,
  routeId: string,
): AgentRouteModuleLoader | undefined => {
  const registry = registered();
  if (registry === undefined || !producedRegisteredLoaders(registry, manifest)) return undefined;
  return registry.loaders[routeId];
};

/** The registered manifest's identity, so a loader miss can name the mismatch that caused it. */
export const registeredManifestIdentity = (): { readonly digest: string; readonly projectRoot: string } | undefined => {
  const registry = registered();
  return registry === undefined
    ? undefined
    : { digest: registry.manifest.digest, projectRoot: registry.manifest.projectRoot };
};

export const hasRegisteredRoutes = (): boolean => registered() !== undefined;
