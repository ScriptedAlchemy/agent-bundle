import type { Diagnostic } from '../../core/diagnostics.ts';
import { deepFreeze } from '../../core/freeze.ts';
import {
  stateDefinitionProjection,
  type StateDefinitionProjection,
} from '../../core/state-inspection.ts';
import type { NormalizedNotices, NormalizedStateDefinition } from '../../core/types.ts';
import type {
  CompiledAgentRoute,
  CompiledCliMode,
  CompiledCliSurface,
  CompiledRouteGraph,
  CompiledServerMode,
  CompiledServerSurface,
} from '../../routes/types.ts';
import type {
  ArtifactManifestCliCommand,
  ArtifactManifestCliOption,
  ArtifactManifestCliProjection,
  ArtifactManifestProvider,
  ArtifactManifestRoute,
  ArtifactManifestRouteContract,
  ArtifactManifestRouteKind,
  ArtifactManifestRouteProvenance,
} from '../../build/manifest.ts';
import {
  artifactCliCommandFor,
  artifactProviderFor,
  artifactRouteContractFor,
  artifactRouteFor,
} from '../../build/manifest-routes.ts';

/** Mirrors {@link CompiledRouteKind}: the catalog groups by the compiler's own kinds. */
export type RouteManifestKind = ArtifactManifestRouteKind;

/** Mirrors {@link CompiledServerMode}. */
export type RouteManifestServerMode = CompiledServerMode;

/** Mirrors {@link CompiledCliMode}. */
export type RouteManifestCliMode = CompiledCliMode;

/**
 * One statically extracted route-config property, flattened to a display pair.
 * Containers report their size instead of nested JSON: this is the catalog
 * summary, and whole config values belong to the schema-driven input editors
 * of the next Workbench stage rather than to navigation.
 */
export interface RouteManifestConfigEntry {
  readonly key: string;
  readonly kind: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string';
  readonly value: string;
}

/** How a route entered the graph; the same discriminant the artifact manifest records. */
export type RouteManifestProvenance = ArtifactManifestRouteProvenance;

/** Mirrors one compiler route contract: the artifact manifest's own row. */
export type RouteManifestContract = ArtifactManifestRouteContract;

/**
 * One compiled route projected for the browser catalog: the artifact
 * manifest's route row (including its bound `contract` id) plus the flattened
 * config summary only the catalog displays.
 */
export interface RouteManifestRoute extends ArtifactManifestRoute {
  readonly config: readonly RouteManifestConfigEntry[];
}

/** One MCP server surface with the routes its packaging mode actually compiles. */
export interface RouteManifestServer {
  readonly id: string;
  readonly mode: RouteManifestServerMode;
  readonly name: string;
  readonly routes: readonly RouteManifestRoute[];
}

/** One argv projection of a CLI route's input schema, without editor defaults. */
export type RouteManifestCliOption = ArtifactManifestCliOption;

/** Mirrors {@link CompiledCliProjection}: the explicit CLI surface projection of one tool. */
export type RouteManifestCliProjection = ArtifactManifestCliProjection;

/** One executable command compiled from a custom CLI route or projected MCP tool. */
export type RouteManifestCliCommand = ArtifactManifestCliCommand;

/** The CLI surface assembled from `src/cli/**` route modules. */
export interface RouteManifestCliSurface {
  /** Present only in `generated` mode, matching the compiler surface. */
  readonly commands?: readonly RouteManifestCliCommand[];
  readonly mode: RouteManifestCliMode;
  readonly routes: readonly RouteManifestRoute[];
}

/** One conventional `src/providers/<name>` context provider module. */
export type RouteManifestProvider = ArtifactManifestProvider;

/** The effective static state declaration exposed to the browser catalog. */
export type RouteManifestState = StateDefinitionProjection;

/**
 * The browser projection of one compiled route graph. It is the same compiler
 * pass the build, `inspect`, and the test harness read — the Workbench derives
 * navigation from this manifest instead of running a second discovery.
 */
export interface RouteManifest {
  readonly cli?: RouteManifestCliSurface;
  /** Present only when the compiler graph carries route contracts. */
  readonly contracts?: readonly RouteManifestContract[];
  readonly diagnostics: readonly Diagnostic[];
  /** The graph digest over project-relative route identity. */
  readonly digest: string;
  readonly events: readonly RouteManifestRoute[];
  readonly providers: readonly RouteManifestProvider[];
  readonly scripts: readonly RouteManifestRoute[];
  readonly servers: readonly RouteManifestServer[];
  /** Absent when the project declares no conventional state module. */
  readonly state?: RouteManifestState;
  /**
   * The source revision of the compiler pass that produced the graph. The
   * browser compares it against the published build's project revision so a
   * catalog newer than the last good build is labelled, never presented as
   * what that build shipped.
   */
  readonly sourceRevision: string;
}

export interface RouteManifestResponse {
  readonly manifest: RouteManifest;
}

const configEntry = (key: string, value: unknown): RouteManifestConfigEntry => {
  if (value === null) return { key, kind: 'null', value: 'null' };
  if (Array.isArray(value)) {
    return { key, kind: 'array', value: `${String(value.length)} ${value.length === 1 ? 'entry' : 'entries'}` };
  }
  switch (typeof value) {
    case 'boolean':
      return { key, kind: 'boolean', value: value ? 'true' : 'false' };
    case 'number':
      return { key, kind: 'number', value: String(value) };
    case 'string':
      return { key, kind: 'string', value };
    default: {
      const keys = Object.keys(value as Readonly<Record<string, unknown>>);
      return { key, kind: 'object', value: `${String(keys.length)} ${keys.length === 1 ? 'key' : 'keys'}` };
    }
  }
};

/**
 * Extraction accepts only JSON literals (AB4806 rejects anything else), so the
 * summary needs no escape hatch for functions, symbols, or cycles.
 */
const configSummary = (config: Readonly<Record<string, unknown>>): readonly RouteManifestConfigEntry[] =>
  Object.keys(config).sort((left, right) => left.localeCompare(right))
    .map((key) => configEntry(key, config[key]));

const manifestRoute = (route: CompiledAgentRoute): RouteManifestRoute => ({
  ...artifactRouteFor(route),
  config: configSummary(route.config),
});

const manifestServer = (server: CompiledServerSurface): RouteManifestServer => ({
  id: server.id,
  mode: server.mode,
  name: server.name,
  routes: server.routes.map(manifestRoute),
});

const manifestCli = (cli: CompiledCliSurface): RouteManifestCliSurface => ({
  ...(cli.commands === undefined ? {} : { commands: cli.commands.map(artifactCliCommandFor) }),
  mode: cli.mode,
  routes: cli.routes.map(manifestRoute),
});

/** Projects one compiled route graph into its immutable browser manifest. */
export const routeManifestFor = (
  graph: CompiledRouteGraph,
  sourceRevision: string,
  state?: NormalizedStateDefinition,
  notices?: NormalizedNotices,
): RouteManifest => deepFreeze({
  ...(graph.cli === undefined ? {} : { cli: manifestCli(graph.cli) }),
  ...(graph.contracts === undefined ? {} : { contracts: graph.contracts.map(artifactRouteContractFor) }),
  diagnostics: graph.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  digest: graph.digest,
  events: graph.events.map(manifestRoute),
  providers: graph.providers.map(artifactProviderFor),
  scripts: graph.scripts.map(manifestRoute),
  servers: graph.servers.map(manifestServer),
  ...(state === undefined ? {} : { state: stateDefinitionProjection(state, 'src/state.ts', notices) }),
  sourceRevision,
});
