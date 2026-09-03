/**
 * The Workbench-surface proof level.
 *
 * The developer Workbench never discovers a project itself: the dev server
 * runs one compiler pass and serves projections of it — the route manifest
 * (`GET /api/routes/manifest`), the state declaration inside it, the
 * lifecycle-replay inventory (`GET /api/lifecycles`), and the capability
 * counts navigation derives its pages from. `inspectWorkbenchSurface` runs
 * that same compiler pass and the same projection functions in this process,
 * so a consumer can assert what the Workbench would be given for their
 * project without a browser or a dev server.
 *
 * It does **not** start the dev server, build an artifact, or render the
 * Workbench: page-availability and catalog grouping are re-derived here by the
 * Workbench's own rules over the same wire shapes, and the repository proves
 * that derivation against the real-Chrome Workbench acceptance. Artifact-only
 * facts — per-target executables, published epochs, host discovery, live MCP
 * probes — stay with the dev-server and browser levels.
 */
import { resolve } from 'node:path';

import type { Lifecycle, LifecycleListResponse } from '../contracts/lifecycles.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { NormalizedStateDefinition } from '../core/types.ts';
import { routeManifestFor } from '../dev/routes/route-manifest.ts';
import type {
  RouteManifest,
  RouteManifestCliCommand,
  RouteManifestKind,
  RouteManifestRoute,
  RouteManifestServerMode,
  RouteManifestState,
} from '../dev/routes/route-manifest.ts';
import type { CompiledRouteGraph } from '../routes/types.ts';
import { AgentTestError } from './errors.ts';
import { WORKBENCH_SURFACE_PROOF_LEVEL } from './manifest.ts';

/** Every Workbench page the navigation can show, in the Workbench's own order. */
export type WorkbenchPageName =
  | 'overview'
  | 'routes'
  | 'skills'
  | 'hooks'
  | 'lifecycles'
  | 'hosts'
  | 'mcp'
  | 'artifacts'
  | 'playground'
  | 'logs'
  | 'evals'
  | 'comparisons';

/**
 * The rail order `packages/workbench/src/main.tsx` renders its navigation
 * items in, minus Runtime (a dev-server runtime capability, not a compile-time
 * fact). The Workbench e2e pins this list against the real rail.
 */
const workbenchPageOrder: readonly WorkbenchPageName[] = Object.freeze([
  'overview',
  'routes',
  'skills',
  'hooks',
  'lifecycles',
  'hosts',
  'mcp',
  'artifacts',
  'playground',
  'logs',
  'evals',
  'comparisons',
]);

/** The Workbench's navigation labels, so an assertion can name the link a browser would show. */
export const workbenchPageLabel = (page: WorkbenchPageName): string => {
  switch (page) {
    case 'overview':
      return 'Overview';
    case 'routes':
      return 'Routes';
    case 'skills':
      return 'Skills';
    case 'hooks':
      return 'Hooks';
    case 'lifecycles':
      return 'Lifecycles';
    case 'hosts':
      return 'Hosts';
    case 'playground':
      return 'Playground';
    case 'mcp':
      return 'MCP playground';
    case 'evals':
      return 'Evals';
    case 'comparisons':
      return 'Comparisons';
    case 'artifacts':
      return 'Artifacts';
    case 'logs':
      return 'Logs';
    default: {
      const exhaustive: never = page;
      throw new TypeError(`Unknown Workbench page ${String(exhaustive)}.`);
    }
  }
};

/**
 * The capability counts the Workbench derives its navigation from, as the
 * built artifact's inventory would list them: one instance per hook, MCP
 * server, or script declaration per selected target it names (a hook shipped
 * to two hosts counts twice; a declaration whose targets select none of the
 * project's targets emits nothing and counts nothing), plus the declared
 * Skills, eval suites, and targets.
 */
export interface WorkbenchCapabilityCounts {
  readonly evalSuites: number;
  readonly hooks: number;
  readonly mcpServers: number;
  readonly scripts: number;
  readonly skills: number;
  readonly targets: number;
}

/** One route as the Workbench catalog lists it: the manifest route plus, for CLI routes, its compiled command. */
export interface WorkbenchRouteCatalogEntry {
  readonly command?: RouteManifestCliCommand;
  /** The `<bin> <command> …` usage line the Routes page renders for a CLI command. */
  readonly commandUsage?: string;
  readonly route: RouteManifestRoute;
}

/**
 * One catalog section, exactly as the Routes page groups them: per server and
 * kind for MCP routes (`curator · Tools`), project-level for event routes,
 * CLI commands, and scripts.
 */
export interface WorkbenchRouteCatalogGroup {
  readonly entries: readonly WorkbenchRouteCatalogEntry[];
  readonly kind: RouteManifestKind;
  /** The heading text the Routes page renders for this group. */
  readonly label: string;
  readonly mode?: string;
  readonly server?: string;
  readonly serverId?: string;
}

export interface WorkbenchRouteCatalogServer {
  readonly id: string;
  readonly mode: RouteManifestServerMode;
  readonly name: string;
  readonly routeCount: number;
}

export interface WorkbenchRouteCatalog {
  readonly diagnostics: readonly Diagnostic[];
  readonly digest: string;
  readonly groups: readonly WorkbenchRouteCatalogGroup[];
  readonly providers: readonly RouteManifest['providers'][number][];
  /** The number the Routes page shows under "Route graph identity". */
  readonly routeCount: number;
  readonly servers: readonly WorkbenchRouteCatalogServer[];
  /** The state declaration the Routes page's State region renders; absent when the project declares none. */
  readonly stateDefinition?: RouteManifestState;
}

export interface WorkbenchSurfaceProvenance {
  readonly configPath?: string;
  readonly manifestDigest: string;
  readonly projectRoot: string;
  readonly proofLevel: typeof WORKBENCH_SURFACE_PROOF_LEVEL;
  /** The compiler pass revision the dev server would stamp on the manifest. */
  readonly sourceRevision: string;
  readonly targets: readonly string[];
}

export interface WorkbenchSurface {
  readonly catalog: WorkbenchRouteCatalog;
  readonly counts: WorkbenchCapabilityCounts;
  /** Every event route with the concrete hosts and starter fixtures the Lifecycles page offers for replay. */
  readonly lifecycles: readonly Lifecycle[];
  /** Exactly the wire body of `GET /api/routes/manifest`. */
  readonly manifest: RouteManifest;
  /** The navigation pages the Workbench would show, in navigation order. */
  readonly pages: readonly WorkbenchPageName[];
  readonly provenance: WorkbenchSurfaceProvenance;
  /** The navigation pages the Workbench would hide for this project. */
  readonly unavailablePages: readonly WorkbenchPageName[];
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

/** The Routes page's group order for one server: MCP kinds first, then project surfaces. */
const catalogKinds: readonly RouteManifestKind[] = Object.freeze([
  'tool',
  'resource',
  'prompt',
  'app',
  'event-route',
  'cli',
  'script',
]);

const byRouteId = (left: WorkbenchRouteCatalogEntry, right: WorkbenchRouteCatalogEntry): number =>
  left.route.id.localeCompare(right.route.id);

const cliOperand = (option: RouteManifestCliCommand['options'][number]): string => {
  const kind = option.kind === 'enum' ? option.choices?.join('|') ?? 'string' : option.kind;
  return `<${kind}>`;
};

/** The usage line the Routes page renders: positionals in order, then flags, required ones unbracketed. */
export const workbenchCommandUsage = (command: RouteManifestCliCommand): string => {
  const positionals = command.options.filter((option) => option.positional !== undefined)
    .toSorted((left, right) => left.positional! - right.positional!)
    .map((option) => option.required
      ? `<${option.option}${option.repeated ? '...' : ''}>`
      : `[${option.option}${option.repeated ? '...' : ''}]`);
  const flags = command.options.filter((option) => option.positional === undefined)
    .map((option) => {
      const value = option.kind === 'boolean'
        ? `--${option.option}`
        : `--${option.option} ${cliOperand(option)}${option.repeated ? ' ...' : ''}`;
      return option.required ? value : `[${value}]`;
    });
  return [...command.path, ...positionals, ...flags].join(' ');
};

const entryFor = (route: RouteManifestRoute, command?: RouteManifestCliCommand): WorkbenchRouteCatalogEntry => ({
  ...(command === undefined ? {} : { command, commandUsage: workbenchCommandUsage(command) }),
  route,
});

const groupFor = (
  kind: RouteManifestKind,
  entries: readonly WorkbenchRouteCatalogEntry[],
  server?: Readonly<{ id: string; mode: string; name: string }>,
): WorkbenchRouteCatalogGroup => ({
  entries: [...entries].sort(byRouteId),
  kind,
  label: server === undefined ? kindLabels[kind] : `${server.name} · ${kindLabels[kind]}`,
  ...(server === undefined ? {} : { mode: server.mode, server: server.name, serverId: server.id }),
});

const serverGroups = (manifest: RouteManifest): readonly WorkbenchRouteCatalogGroup[] =>
  [...manifest.servers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((server) => catalogKinds
      .map((kind) => ({ entries: server.routes.filter((route) => route.kind === kind).map((route) => entryFor(route)), kind }))
      .filter((group) => group.entries.length > 0)
      .map((group) => groupFor(group.kind, group.entries, { id: server.id, mode: server.mode, name: server.name })));

const cliGroups = (manifest: RouteManifest): readonly WorkbenchRouteCatalogGroup[] => {
  const cli = manifest.cli;
  if (cli === undefined || cli.routes.length === 0) return [];
  const commands = new Map((cli.commands ?? []).map((command) => [command.routeId, command]));
  return [{
    entries: cli.routes.map((route) => entryFor(route, commands.get(route.id))).sort(byRouteId),
    kind: 'cli',
    label: kindLabels.cli,
    mode: cli.mode,
  }];
};

const projectGroups = (manifest: RouteManifest): readonly WorkbenchRouteCatalogGroup[] => [
  ...(manifest.events.length === 0 ? [] : [groupFor('event-route', manifest.events.map((route) => entryFor(route)))]),
  ...cliGroups(manifest),
  ...(manifest.scripts.length === 0 ? [] : [groupFor('script', manifest.scripts.map((route) => entryFor(route)))]),
];

/** The Routes page catalog derived from one route manifest, by the Workbench's grouping rules. */
export const workbenchRouteCatalog = (manifest: RouteManifest): WorkbenchRouteCatalog => {
  const groups = [...serverGroups(manifest), ...projectGroups(manifest)];
  return {
    diagnostics: manifest.diagnostics,
    digest: manifest.digest,
    groups,
    providers: [...manifest.providers].sort((left, right) => left.name.localeCompare(right.name)),
    routeCount: groups.reduce((total, group) => total + group.entries.length, 0),
    servers: [...manifest.servers]
      .map((server) => ({ id: server.id, mode: server.mode, name: server.name, routeCount: server.routes.length }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    ...(manifest.state === undefined ? {} : { stateDefinition: manifest.state }),
  };
};

const catalogHasKind = (catalog: WorkbenchRouteCatalog, kind: RouteManifestKind): boolean =>
  catalog.groups.some((group) => group.kind === kind && group.entries.length > 0);

/**
 * The Workbench navigation rule: a page appears when either the compiled
 * graph declares its surface or configuration declares it without a route
 * module. `hosts` is unconditional; the RSC runtime page depends on a live
 * runtime provider and is not projected here.
 */
export const workbenchPagesFor = (
  counts: WorkbenchCapabilityCounts,
  catalog: WorkbenchRouteCatalog,
): readonly WorkbenchPageName[] => {
  const compiledEvents = catalogHasKind(catalog, 'event-route');
  const compiledScripts = catalogHasKind(catalog, 'script');
  const pages = new Set<WorkbenchPageName>(['overview', 'routes', 'hosts', 'artifacts', 'logs']);
  if (counts.skills > 0) pages.add('skills');
  if (counts.hooks > 0 || compiledEvents) pages.add('hooks');
  if (compiledEvents) pages.add('lifecycles');
  if (counts.mcpServers > 0 || catalog.servers.length > 0) pages.add('mcp');
  if (counts.hooks + counts.scripts > 0 || compiledEvents || compiledScripts) pages.add('playground');
  if (counts.evalSuites > 0) {
    pages.add('evals');
    pages.add('comparisons');
  }
  return workbenchPageOrder.filter((page) => pages.has(page));
};

export interface WorkbenchSurfaceFromGraphInput {
  readonly configPath?: string;
  readonly counts: WorkbenchCapabilityCounts;
  readonly graph: CompiledRouteGraph;
  readonly lifecycles: LifecycleListResponse;
  readonly projectRoot: string;
  readonly sourceRevision: string;
  readonly state?: NormalizedStateDefinition;
  readonly targets: readonly string[];
}

/**
 * The pure projection behind {@link inspectWorkbenchSurface}: the same
 * `routeManifestFor` the dev server serves, grouped by the Routes page's
 * rules, with the navigation rule applied over the declared counts.
 */
export const workbenchSurfaceFromRouteGraph = (input: WorkbenchSurfaceFromGraphInput): WorkbenchSurface => {
  const manifest = routeManifestFor(input.graph, input.sourceRevision, input.state);
  const catalog = workbenchRouteCatalog(manifest);
  const pages = workbenchPagesFor(input.counts, catalog);
  return deepFreeze({
    catalog,
    counts: input.counts,
    lifecycles: input.lifecycles.lifecycles,
    manifest,
    pages,
    provenance: {
      ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
      manifestDigest: manifest.digest,
      projectRoot: input.projectRoot,
      proofLevel: WORKBENCH_SURFACE_PROOF_LEVEL,
      sourceRevision: input.sourceRevision,
      targets: input.targets,
    },
    unavailablePages: workbenchPageOrder.filter((page) => !pages.includes(page)),
  });
};

/**
 * The artifact instances a set of declarations produces: one per declaration
 * per selected target it names. A declaration with `targets: []`, or with
 * targets the project does not select, is emitted nowhere.
 */
const targetInstances = (
  declarations: readonly { readonly targets: readonly string[] }[],
  selected: readonly string[],
): number => declarations.reduce(
  (total, declaration) => total + declaration.targets.filter((target) => selected.includes(target)).length,
  0,
);

export interface InspectWorkbenchSurfaceOptions {
  /** Explicit Agent Bundle configuration path; discovered from `root` when omitted. */
  readonly configPath?: string;
  /** Project root; defaults to the working directory. */
  readonly root?: string;
}

/**
 * Runs the dev server's own preparation for one project and projects it the
 * way the Workbench receives it. No artifact is built and no server starts.
 *
 * This is the `workbench-surface` proof level.
 */
export const inspectWorkbenchSurface = async (
  options: InspectWorkbenchSurfaceOptions = {},
): Promise<WorkbenchSurface> => {
  const root = resolve(options.root ?? process.cwd());
  const [{ ProjectService }, { emptyCompiledRouteGraph }, { LifecycleReplayService }, { EvalService }] = await Promise.all([
    import('../dev/project-service.ts'),
    import('../routes/graph.ts'),
    import('../dev/playground/lifecycle-replay-service.ts'),
    import('../dev/eval/eval-service.ts'),
  ]);
  // Constructed as the Workbench server constructs its own: the
  // configuration factory sees `development`, a `dev` runtime declaration is
  // honored, and the dev server's output roots stay out of the source
  // snapshot — so a configuration that branches on the mode compiles here to
  // exactly what the Workbench shows.
  const prepared = await new ProjectService({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    includeDevRuntime: true,
    mode: 'development',
    outputRoots: ['dist', '.agent-bundle/runtime', '.agent-bundle/playground'],
    root,
  }).prepare('dev');
  const graph = prepared.routeGraph ?? emptyCompiledRouteGraph;
  const model = prepared.model;
  const sourceRevision = prepared.source.revision;
  // The dev server serves the route manifest only for a `ready` preparation —
  // a model, a revision, and no error diagnostic from normalization,
  // validation, or an adapter — and otherwise reports it unavailable (or
  // keeps serving the previous valid graph) rather than an empty or
  // invalid catalog; so does this.
  if (model === undefined || sourceRevision === undefined || prepared.source.state !== 'ready') {
    const errors = prepared.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    throw new AgentTestError(
      'manifest-unavailable',
      `The compiler pass produced no valid project (source state ${prepared.source.state}), so the dev server would report the route manifest unavailable.`,
      {
        details: [
          `project root: ${prepared.root}`,
          `config:       ${prepared.configPath}`,
          ...(errors.length === 0
            ? []
            : [`compiler:     ${String(errors.length)} error(s), first ${errors[0]!.code}: ${errors[0]!.message}`]),
        ],
        recovery: 'Fix the reported configuration or source diagnostics; the Workbench catalog exists only for a project the compiler accepted.',
      },
    );
  }
  const targets = Object.freeze(model.targets.map((target) => target.name));
  const lifecycles = new LifecycleReplayService({
    prepared: () => Object.freeze({ graph, sourceRevision, targets }),
    registry: prepared.registry,
  }).list();
  // The same configuration the preparation selected, never a second
  // discovery from the root; the eval service otherwise loads as the
  // Workbench server's does.
  const evalSuites = (await new EvalService({
    configPath: prepared.configPath,
    projectRoot: prepared.root,
    registry: prepared.registry,
  }).suites()).suites.length;
  return workbenchSurfaceFromRouteGraph({
    configPath: prepared.configPath,
    counts: Object.freeze({
      evalSuites,
      // The Workbench counts the artifact's hook index, which holds one
      // compiled wrapper per hook per target; a prebuilt hook points the
      // host at its payload and is never indexed, so it never counts.
      hooks: targetInstances(model.hooks.filter((hook) => hook.prebuiltPath === undefined), targets),
      mcpServers: targetInstances(model.mcpServers, targets),
      scripts: targetInstances(model.scripts, targets),
      skills: model.skills.length,
      targets: targets.length,
    }),
    graph,
    lifecycles,
    projectRoot: prepared.root,
    sourceRevision,
    ...(model.state === undefined ? {} : { state: model.state }),
    targets,
  });
};
