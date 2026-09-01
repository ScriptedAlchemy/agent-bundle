import type { Diagnostic } from '../core/diagnostics.ts';

/**
 * Route kinds recognized under the conventional source roots (#93). The
 * issue's `CompiledAgentRoute` union lists seven kinds explicitly;
 * `provider` covers the `src/providers/*` conventional root the same issue
 * declares alongside them.
 */
export type AgentRouteKind =
  | 'tool'
  | 'resource'
  | 'prompt'
  | 'app'
  | 'event-route'
  | 'provider'
  | 'cli'
  | 'script';

/**
 * Where one route came from. This wave discovers routes only through the
 * conventional roots; explicit per-route overrides arrive with the public
 * authoring surface and will add their own provenance kind.
 */
export interface RouteProvenance {
  /** The project-relative POSIX directory of the conventional root that matched. */
  readonly conventionalRoot: string;
  readonly kind: 'conventional';
  /** The project-relative POSIX path of the route module. */
  readonly relativePath: string;
}

/**
 * One entry of the immutable route graph — #93's `CompiledAgentRoute`. The
 * filesystem path supplies kind, owning server, and identity. The `config`
 * field stays empty until the static `config`-export extractor lands; the
 * compiler never fabricates metadata a route module did not declare.
 */
export interface CompiledAgentRoute {
  readonly config: Readonly<Record<string, unknown>>;
  /** Path-derived stable identity: the `src/`-relative POSIX path without its extension. */
  readonly id: string;
  readonly kind: AgentRouteKind;
  readonly provenance: RouteProvenance;
  /** The owning generated MCP server; present only for tool/resource/prompt/app routes. */
  readonly serverId?: string;
  /** The absolute path of the route module. */
  readonly source: string;
}

/**
 * The immutable route graph. Deterministic (sorted routes and servers),
 * deep-frozen, and consumer-invisible this wave: nothing generates entries
 * or registries from it yet.
 */
export interface AgentRouteGraph {
  readonly diagnostics: readonly Diagnostic[];
  readonly routes: readonly CompiledAgentRoute[];
  /** Sorted ids of MCP servers that own at least one generated route. */
  readonly servers: readonly string[];
}

/** The graph of a project without conventional route modules. */
export const emptyAgentRouteGraph: AgentRouteGraph = Object.freeze({
  diagnostics: Object.freeze<Diagnostic[]>([]),
  routes: Object.freeze<CompiledAgentRoute[]>([]),
  servers: Object.freeze<string[]>([]),
});

/** The human noun for one route kind, shared by diagnostics and inspect output. */
export const describeRouteKind = (kind: AgentRouteKind): string => {
  switch (kind) {
    case 'tool':
      return 'tool';
    case 'resource':
      return 'resource';
    case 'prompt':
      return 'prompt';
    case 'app':
      return 'MCP App';
    case 'event-route':
      return 'event route';
    case 'provider':
      return 'context provider';
    case 'cli':
      return 'CLI command';
    case 'script':
      return 'script';
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled route kind ${String(unreachable)}.`);
    }
  }
};
