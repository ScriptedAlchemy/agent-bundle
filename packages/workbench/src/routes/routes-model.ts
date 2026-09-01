import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  RouteManifest,
  RouteManifestCliCommand,
  RouteManifestConfigEntry,
  RouteManifestKind,
  RouteManifestRoute,
  RouteManifestServerMode,
} from '../../../agent-bundle/src/contracts/routes.ts';

/**
 * The catalog's freshness against the published build. `stale` means the dev
 * server has compiled newer source than the epoch the rest of the Workbench
 * is scoped to; the catalog stays readable and says so rather than vanishing.
 */
export type RouteCatalogState = 'current' | 'stale' | 'unavailable';

/** The catalog group kinds the compiled graph can populate, in navigation order. */
export const routeCatalogKinds = Object.freeze([
  'tool',
  'resource',
  'prompt',
  'app',
  'event-route',
  'cli',
  'script',
] as const satisfies readonly RouteManifestKind[]);

export interface RouteCatalogEntry {
  readonly command?: RouteManifestCliCommand;
  readonly config: readonly RouteManifestConfigEntry[];
  readonly description?: string;
  readonly event?: string;
  readonly id: string;
  readonly kind: RouteManifestKind;
  readonly provenance: 'conventional';
  readonly source: string;
}

/**
 * One catalog section. MCP kinds carry the owning server; `cli` and `script`
 * are project-level surfaces, so their `server` stays undefined.
 */
export interface RouteCatalogGroup {
  readonly entries: readonly RouteCatalogEntry[];
  readonly kind: RouteManifestKind;
  readonly label: string;
  readonly mode?: string;
  readonly server?: string;
  readonly serverId?: string;
}

export interface RouteCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

/** One declared MCP server, including externally packaged surfaces with no manifest routes. */
export interface RouteCatalogServer {
  readonly id: string;
  readonly mode: RouteManifestServerMode;
  readonly name: string;
  readonly routeCount: number;
}

export interface RouteCatalog {
  readonly diagnostics: readonly Diagnostic[];
  readonly digest: string;
  readonly groups: readonly RouteCatalogGroup[];
  /** Present only when the catalog could not be read; `state` is `unavailable`. */
  readonly message?: string;
  readonly providers: readonly RouteCatalogProvider[];
  readonly routeCount: number;
  readonly servers: readonly RouteCatalogServer[];
  readonly sourceRevision?: string;
  readonly state: RouteCatalogState;
}

const kindLabels: Readonly<Record<RouteManifestKind, string>> = Object.freeze({
  app: 'MCP Apps',
  cli: 'CLI commands',
  'event-route': 'Event routes',
  prompt: 'Prompts',
  resource: 'Resources',
  script: 'Scripts',
  tool: 'Tools',
});

export const routeKindLabel = (kind: RouteManifestKind): string => kindLabels[kind];

const byId = (left: RouteCatalogEntry, right: RouteCatalogEntry): number => left.id.localeCompare(right.id);

const entryFor = (route: RouteManifestRoute, command?: RouteManifestCliCommand): RouteCatalogEntry => Object.freeze({
  ...(command === undefined ? {} : { command }),
  config: route.config,
  ...(route.description === undefined ? {} : { description: route.description }),
  ...(route.event === undefined ? {} : { event: route.event }),
  id: route.id,
  kind: route.kind,
  provenance: route.provenance.kind,
  source: route.source,
});

const groupFor = (
  kind: RouteManifestKind,
  entries: readonly RouteCatalogEntry[],
  server?: Readonly<{ id: string; mode: string; name: string }>,
): RouteCatalogGroup => Object.freeze({
  entries: Object.freeze([...entries].sort(byId)),
  kind,
  label: server === undefined ? kindLabels[kind] : `${server.name} · ${kindLabels[kind]}`,
  ...(server === undefined ? {} : { mode: server.mode, server: server.name, serverId: server.id }),
});

const serverGroups = (manifest: RouteManifest): readonly RouteCatalogGroup[] =>
  [...manifest.servers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((server) => routeCatalogKinds
      .map((kind) => Object.freeze({ entries: server.routes.filter((route) => route.kind === kind).map((route) => entryFor(route)), kind }))
      .filter((group) => group.entries.length > 0)
      .map((group) => groupFor(group.kind, group.entries, { id: server.id, mode: server.mode, name: server.name })));

const cliGroups = (manifest: RouteManifest): readonly RouteCatalogGroup[] => {
  const cli = manifest.cli;
  if (cli === undefined || cli.routes.length === 0) return [];
  const commands = new Map((cli.commands ?? []).map((command) => [command.routeId, command]));
  return [Object.freeze({
    entries: Object.freeze(cli.routes.map((route) => entryFor(route, commands.get(route.id))).sort(byId)),
    kind: 'cli' as const,
    label: kindLabels.cli,
    mode: cli.mode,
  })];
};

const projectGroups = (manifest: RouteManifest): readonly RouteCatalogGroup[] => [
  ...(manifest.events.length === 0 ? [] : [groupFor('event-route', manifest.events.map((route) => entryFor(route)))]),
  ...cliGroups(manifest),
  ...(manifest.scripts.length === 0 ? [] : [groupFor('script', manifest.scripts.map((route) => entryFor(route)))]),
];

/**
 * Projects the compiled route manifest into the Workbench catalog. `epochSourceRevision`
 * is the published build's project revision: an unequal manifest revision is normal
 * mid-rebuild drift, reported as `stale` rather than an error.
 */
export const routeCatalogFor = (
  manifest: RouteManifest,
  epochSourceRevision?: string,
): RouteCatalog => {
  const groups = Object.freeze([...serverGroups(manifest), ...projectGroups(manifest)]);
  return Object.freeze({
    diagnostics: manifest.diagnostics,
    digest: manifest.digest,
    groups,
    providers: Object.freeze([...manifest.providers]
      .map((provider) => Object.freeze({ id: provider.id, name: provider.name, source: provider.source }))
      .sort((left, right) => left.name.localeCompare(right.name))),
    routeCount: groups.reduce((total, group) => total + group.entries.length, 0),
    servers: Object.freeze([...manifest.servers]
      .map((server) => Object.freeze({ id: server.id, mode: server.mode, name: server.name, routeCount: server.routes.length }))
      .sort((left, right) => left.name.localeCompare(right.name))),
    sourceRevision: manifest.sourceRevision,
    state: epochSourceRevision === undefined || epochSourceRevision === manifest.sourceRevision ? 'current' : 'stale',
  });
};

export const unavailableRouteCatalog = (message: string): RouteCatalog => Object.freeze({
  diagnostics: Object.freeze([]),
  digest: '',
  groups: Object.freeze([]),
  message,
  providers: Object.freeze([]),
  routeCount: 0,
  servers: Object.freeze([]),
  state: 'unavailable',
});

/** True when the compiled graph itself declares this kind, whatever configuration adds beside it. */
export const routeCatalogHasKind = (catalog: RouteCatalog, kind: RouteManifestKind): boolean =>
  catalog.groups.some((group) => group.kind === kind && group.entries.length > 0);

export const routeCatalogServerCount = (catalog: RouteCatalog): number =>
  catalog.servers.length;
