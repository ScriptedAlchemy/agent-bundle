import type { Diagnostic } from '../core/diagnostics.ts';

/**
 * Every route kind the conventional source tree can declare. Context
 * providers are deliberately not a route kind: a provider wraps route
 * execution rather than being addressable itself, so providers live in their
 * own {@link CompiledProvider} collection.
 */
export type CompiledRouteKind =
  | 'tool'
  | 'resource'
  | 'prompt'
  | 'app'
  | 'event-route'
  | 'cli'
  | 'script';

/**
 * Where a compiled route came from. This release only compiles conventional
 * filesystem routes; the relative path is the route's portable identity, so
 * graphs digest identically regardless of where the project is checked out.
 */
export interface RouteProvenance {
  readonly kind: 'conventional';
  /** Project-relative POSIX path of the route module. */
  readonly relativePath: string;
}

/**
 * Evidence backing a `supported`/`degraded` capability judgment: the adapter
 * capability record that asserted it, in the same identity terms the target
 * adapter metadata already publishes.
 */
export interface CapabilityEvidence {
  readonly capabilityRevision: string;
  readonly capabilitySha256: string;
  readonly observedVersion: string;
  readonly target: string;
}

/**
 * The one capability-state contract route validation, projectors, events,
 * and host components share (#93). This release exports the types only;
 * population arrives with the host-component capability work (#100).
 */
export type CapabilityState =
  | { readonly state: 'supported'; readonly evidence: CapabilityEvidence }
  | { readonly state: 'degraded'; readonly reason: string; readonly evidence?: CapabilityEvidence }
  | { readonly state: 'unavailable'; readonly reason: string }
  | { readonly state: 'prohibited'; readonly reason: string };

/**
 * The route `config` export is extracted by a later release; until then every
 * compiled route carries this shared frozen empty object.
 */
export const emptyRouteConfig: Readonly<Record<string, unknown>> = Object.freeze({});

/** One conventional route module compiled into the immutable route graph. */
export interface CompiledAgentRoute {
  /** Static route metadata. Always {@link emptyRouteConfig} in this release. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: CompiledRouteKind;
  readonly provenance: RouteProvenance;
  /** The owning MCP server id (`mcp:<name>`); MCP route kinds only. */
  readonly serverId?: string;
  /** Absolute route module path. */
  readonly source: string;
}

/** One conventional `src/providers/<name>.ts` context provider module. */
export interface CompiledProvider {
  readonly id: string;
  readonly name: string;
  readonly provenance: RouteProvenance;
  /** Absolute provider module path. */
  readonly source: string;
}

/**
 * The packaging mode of one MCP server that owns discovered route modules.
 * `generated`, `custom`, `command`, and `remote` are explicit or inferred
 * decisions; `conflict` records that discovery found routes but an existing
 * entry claims the same server and no explicit mode resolved it — discovery
 * is not a packaging choice, so the routes stay visible beside the error.
 */
export type CompiledServerMode = 'generated' | 'custom' | 'command' | 'remote' | 'conflict';

/** One MCP server surface assembled from `src/mcp/<name>/` route modules. */
export interface CompiledServerSurface {
  readonly id: string;
  readonly mode: CompiledServerMode;
  readonly name: string;
  /** Discovered routes; empty when an explicit non-generated mode omits them. */
  readonly routes: readonly CompiledAgentRoute[];
}

/**
 * The CLI surface mode: `generated` compiles `src/cli/**` command routes,
 * `conventional` keeps the existing `src/cli.ts` entry and omits the routed
 * commands, and `conflict` records both present without an explicit choice.
 */
export type CompiledCliMode = 'generated' | 'conventional' | 'conflict';

/** The CLI command surface assembled from `src/cli/**` route modules. */
export interface CompiledCliSurface {
  readonly mode: CompiledCliMode;
  /** Discovered command routes; empty when `conventional` mode omits them. */
  readonly routes: readonly CompiledAgentRoute[];
}

/**
 * The immutable route graph: one compiler IR for everything the conventional
 * source tree declares. Deep-frozen at compile time; `digest` covers only
 * project-relative identity so equal trees hash equally on every machine.
 */
export interface CompiledRouteGraph {
  readonly cli?: CompiledCliSurface;
  readonly diagnostics: readonly Diagnostic[];
  /** sha256 over the graph's project-relative identity. */
  readonly digest: string;
  readonly events: readonly CompiledAgentRoute[];
  readonly providers: readonly CompiledProvider[];
  readonly scripts: readonly CompiledAgentRoute[];
  readonly servers: readonly CompiledServerSurface[];
}
