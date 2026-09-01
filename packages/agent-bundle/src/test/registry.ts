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

export const registerTestRoutes = (registry: AgentTestRouteRegistry): void => {
  if (registry.version !== AGENT_TEST_REGISTRY_VERSION) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Incompatible Agent Bundle test registry version: found ${String(registry.version)}, expected ${String(AGENT_TEST_REGISTRY_VERSION)}.`,
      { recovery: 'Install one agent-bundle version for both the Rstest configuration and the test helpers.' },
    );
  }
  realm[REGISTRY_SYMBOL] = registry;
};

const registered = (): AgentTestRouteRegistry | undefined => realm[REGISTRY_SYMBOL];

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

export const registeredRouteLoader = (routeId: string): AgentRouteModuleLoader | undefined =>
  registered()?.loaders[routeId];

export const hasRegisteredRoutes = (): boolean => registered() !== undefined;
