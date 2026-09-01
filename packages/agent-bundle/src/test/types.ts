import type { AgentBundleTestManifest, AgentTestProofLevel, TestableRouteDescriptor } from './manifest.ts';

/**
 * The route kinds the route-unit level renders. `app` routes are browser
 * surfaces, so the browser proof level owns them; every other compiled kind
 * renders here the way the generated server renders it.
 */
export type RenderableRouteKind = 'cli' | 'event-route' | 'prompt' | 'resource' | 'script' | 'tool';

/** The structural schema surface the harness needs: parsing, not schema introspection. */
export interface AgentRouteSchema {
  readonly parse: (value: unknown) => unknown;
}

/**
 * One route module the harness renders: the public route contract's async
 * default component, plus the schemas the generated server and the routed CLI
 * validate through — `inputSchema` on the way in (the CLI dispatch level's
 * boundary) and `resultSchema` on the document value coming out.
 */
export interface AgentRouteModule {
  readonly default: (props: never) => unknown;
  readonly inputSchema?: AgentRouteSchema;
  readonly resultSchema?: AgentRouteSchema;
}

export type AgentRouteModuleLoader = () => Promise<AgentRouteModule>;

/**
 * Where a rendered route came from and what the render proves. Every harness
 * failure reports this block so a red test names the route, the module, the
 * compiler pass behind it, and the level of proof it actually carried.
 */
export interface RenderedRouteProvenance {
  readonly kind: RenderableRouteKind;
  /** The manifest digest when the route came from the compiler; absent for a module rendered directly. */
  readonly manifestDigest?: string;
  /** Absolute module path when known. */
  readonly modulePath?: string;
  readonly projectRoot?: string;
  readonly proofLevel: AgentTestProofLevel;
  /** Project-relative POSIX path when the route came from the compiler. */
  readonly relativePath?: string;
  readonly routeId: string;
  readonly serverId?: string;
  /** `manifest` when the compiler named the route; `module` when the test passed a module in. */
  readonly source: 'manifest' | 'module';
  /** The project's selected host targets. Route-unit rendering is target-neutral. */
  readonly targets: readonly string[];
}

export type { AgentBundleTestManifest, AgentTestProofLevel, TestableRouteDescriptor };
