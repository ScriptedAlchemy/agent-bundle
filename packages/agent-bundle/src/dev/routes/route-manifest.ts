import type { Diagnostic } from '../../core/diagnostics.ts';
import { deepFreeze } from '../../core/freeze.ts';
import {
  stateDefinitionProjection,
  type StateDefinitionProjection,
} from '../../core/state-inspection.ts';
import type { NormalizedNotices, NormalizedStateDefinition } from '../../core/types.ts';
import type { CliProjectionFlagDefault } from '../../routes/public.ts';
import type {
  CompiledAgentRoute,
  CompiledCliCommand,
  CompiledCliMode,
  CompiledCliOption,
  CompiledCliProjection,
  CompiledCliSurface,
  CompiledProvider,
  CompiledRouteGraph,
  CompiledRouteKind,
  CompiledServerMode,
  CompiledServerSurface,
  RouteInputSchema,
} from '../../routes/types.ts';

/** Mirrors {@link CompiledRouteKind}: the catalog groups by the compiler's own kinds. */
export type RouteManifestKind = CompiledRouteKind;

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

/**
 * How a route entered the graph. Only conventional filesystem discovery
 * exists today; keeping the discriminant makes a later provenance additive
 * rather than a wire break.
 */
export interface RouteManifestProvenance {
  readonly kind: 'conventional';
}

/** Mirrors one compiler route contract without exposing server-only module paths. */
export interface RouteManifestContract {
  readonly id: string;
  readonly input: RouteInputSchema;
  readonly origin: {
    readonly binding: string;
    readonly module: string;
  };
  readonly routes: readonly string[];
}

/** One compiled route projected for the browser catalog. */
export interface RouteManifestRoute {
  /** Id of the compiler contract this route binds. */
  readonly contract?: string;
  readonly config: readonly RouteManifestConfigEntry[];
  /** `config.description` when it is a string; the catalog's human label. */
  readonly description?: string;
  /** Canonical event identity; `event-route` routes only. */
  readonly event?: string;
  readonly id: string;
  /** Bounded JSON Schema projection; absent when the route schema is richer than the static grammar. */
  readonly inputSchema?: RouteInputSchema;
  readonly kind: RouteManifestKind;
  readonly provenance: RouteManifestProvenance;
  /** The owning MCP server id (`mcp:<name>`); MCP route kinds only. */
  readonly serverId?: string;
  /**
   * Project-relative POSIX module path. The compiler's absolute path stays on
   * the server: the relative path is the route's portable identity and the
   * only location that means anything to a browser reading this catalog.
   */
  readonly source: string;
}

/** One MCP server surface with the routes its packaging mode actually compiles. */
export interface RouteManifestServer {
  readonly id: string;
  readonly mode: RouteManifestServerMode;
  readonly name: string;
  readonly routes: readonly RouteManifestRoute[];
}

/** One argv projection of a CLI route's input schema, without editor defaults. */
export interface RouteManifestCliOption {
  readonly aliases?: readonly string[];
  readonly choices?: readonly string[];
  readonly description?: string;
  readonly key: string;
  readonly kind: CompiledCliOption['kind'];
  readonly option: string;
  readonly positional?: number;
  readonly repeated: boolean;
  readonly required: boolean;
}

/** Mirrors {@link CompiledCliProjection}: the explicit CLI surface projection of one tool. */
export interface RouteManifestCliProjection {
  /** Canonical key → the projection's `flags.<key>.default` literal (schema defaults are not listed); keys sorted. */
  readonly defaults?: Readonly<Record<string, CliProjectionFlagDefault>>;
  readonly mapInput: boolean;
  readonly module: string;
  readonly relaxed?: readonly string[];
}

/** One executable command compiled from a custom CLI route or projected MCP tool. */
export interface RouteManifestCliCommand {
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly exitCode: CompiledCliCommand['exitCode'];
  readonly mcp?: NonNullable<CompiledCliCommand['mcp']>;
  readonly options: readonly RouteManifestCliOption[];
  readonly path: readonly string[];
  readonly projection?: RouteManifestCliProjection;
  readonly routeId: string;
}

/** The CLI surface assembled from `src/cli/**` route modules. */
export interface RouteManifestCliSurface {
  /** Present only in `generated` mode, matching the compiler surface. */
  readonly commands?: readonly RouteManifestCliCommand[];
  readonly mode: RouteManifestCliMode;
  readonly routes: readonly RouteManifestRoute[];
}

/** One conventional `src/providers/<name>` context provider module. */
export interface RouteManifestProvider {
  readonly id: string;
  readonly name: string;
  /** Project-relative POSIX module path, for the same reason routes carry one. */
  readonly source: string;
}

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

const description = (config: Readonly<Record<string, unknown>>): string | undefined => {
  const value = config['description'];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

const manifestRoute = (route: CompiledAgentRoute): RouteManifestRoute => {
  const summary = description(route.config);
  return {
    ...(route.contract === undefined ? {} : { contract: route.contract }),
    config: configSummary(route.config),
    ...(summary === undefined ? {} : { description: summary }),
    ...(route.event === undefined ? {} : { event: route.event }),
    id: route.id,
    ...(route.inputSchema === undefined ? {} : { inputSchema: route.inputSchema }),
    kind: route.kind,
    provenance: { kind: route.provenance.kind },
    ...(route.serverId === undefined ? {} : { serverId: route.serverId }),
    source: route.provenance.relativePath,
  };
};

const manifestServer = (server: CompiledServerSurface): RouteManifestServer => ({
  id: server.id,
  mode: server.mode,
  name: server.name,
  routes: server.routes.map(manifestRoute),
});

const manifestCliOption = (option: CompiledCliOption): RouteManifestCliOption => ({
  ...(option.aliases === undefined ? {} : { aliases: [...option.aliases] }),
  ...(option.choices === undefined ? {} : { choices: [...option.choices] }),
  ...(option.description === undefined ? {} : { description: option.description }),
  key: option.key,
  kind: option.kind,
  option: option.option,
  ...(option.positional === undefined ? {} : { positional: option.positional }),
  repeated: option.repeated,
  required: option.required,
});

const manifestCliProjection = (projection: CompiledCliProjection): RouteManifestCliProjection => ({
  ...(projection.defaults === undefined
    ? {}
    : {
      defaults: Object.fromEntries(Object.entries(projection.defaults)
        .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])),
    }),
  mapInput: projection.mapInput,
  module: projection.module,
  ...(projection.relaxed === undefined ? {} : { relaxed: [...projection.relaxed] }),
});

const manifestCliCommand = (command: CompiledCliCommand): RouteManifestCliCommand => ({
  aliases: [...command.aliases],
  ...(command.description === undefined ? {} : { description: command.description }),
  exitCode: command.exitCode,
  ...(command.mcp === undefined ? {} : { mcp: { ...command.mcp } }),
  options: command.options.map(manifestCliOption),
  path: [...command.path],
  ...(command.projection === undefined ? {} : { projection: manifestCliProjection(command.projection) }),
  routeId: command.routeId,
});

const manifestCli = (cli: CompiledCliSurface): RouteManifestCliSurface => ({
  ...(cli.commands === undefined ? {} : { commands: cli.commands.map(manifestCliCommand) }),
  mode: cli.mode,
  routes: cli.routes.map(manifestRoute),
});

const manifestProvider = (provider: CompiledProvider): RouteManifestProvider => ({
  id: provider.id,
  name: provider.name,
  source: provider.provenance.relativePath,
});

/** Projects one compiled route graph into its immutable browser manifest. */
export const routeManifestFor = (
  graph: CompiledRouteGraph,
  sourceRevision: string,
  state?: NormalizedStateDefinition,
  notices?: NormalizedNotices,
): RouteManifest => deepFreeze({
  ...(graph.cli === undefined ? {} : { cli: manifestCli(graph.cli) }),
  ...(graph.contracts === undefined ? {} : {
    contracts: graph.contracts.map((contract) => ({
      id: contract.id,
      input: contract.input,
      origin: { ...contract.origin },
      routes: [...contract.routes],
    })),
  }),
  diagnostics: graph.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  digest: graph.digest,
  events: graph.events.map(manifestRoute),
  providers: graph.providers.map(manifestProvider),
  scripts: graph.scripts.map(manifestRoute),
  servers: graph.servers.map(manifestServer),
  ...(state === undefined ? {} : { state: stateDefinitionProjection(state, 'src/state.ts', notices) }),
  sourceRevision,
});
