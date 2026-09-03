import { relative, resolve, sep } from 'node:path';

import { isRenderedScriptRoute, judgeScriptRoute, scriptRouteName } from '../config/script-routes.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { NormalizedMcpApp, NormalizedScript, NormalizedStateDefinition } from '../core/types.ts';
import { orderedProviders } from '../routes/provider-execution.ts';
import { providerKeyFromName } from '../routes/providers.ts';
import type {
  CompiledAgentRoute,
  CompiledCliCommand,
  CompiledProvider,
  CompiledLayoutScope,
  CompiledRouteGraph,
  CompiledRouteKind,
} from '../routes/types.ts';

/**
 * The proof level one harness helper supplies. The levels are deliberately
 * separate and separately named: a pass at one is never a receipt for
 * another, and every helper stamps the level it actually carried into its
 * provenance and its failure text.
 *
 * - `route-unit` renders a route module through the real Agent renderer. No
 *   transport, no browser surface, no host artifact.
 * - `mcp-in-memory` runs the real generated MCP server against a real MCP
 *   client over the SDK's in-memory transport pair. It proves the protocol
 *   contract — registration, schemas, content projection — and proves
 *   **nothing** about a process, stdout framing, or a packed artifact.
 * - `dev-epoch` opens an epoch-pinned generated stdio entry through the
 *   Workbench session service and drives its real process. It proves the
 *   generated development artifact, not packed or native-host provenance.
 * - `cli-dispatch` runs an argv vector through the routed CLI's own shell over
 *   the compiled command graph, in this process. It proves command
 *   resolution, argv projection, and exit codes, not a spawned binary.
 * - `script-dispatch` runs one conventional `src/scripts/*` module through the
 *   contract its generated `scripts/<name>.mjs` executable carries, in this
 *   process: a rendered `.tsx` script through the rendered-script shell and
 *   its four output modes, a plain `.ts` script through the `main` process
 *   envelope. It proves the script's behavior and output contract, not the
 *   bundled artifact or a spawned process.
 * - `workbench-surface` projects the compiled route graph the way the dev
 *   server serves it to the Workbench — route catalog, state, lifecycle
 *   fixtures, page availability — without a browser or a dev server. It
 *   proves what the Workbench would be given, not that the Workbench rendered
 *   it.
 * - `packed-stdio` installs the packed release tarball into a clean consumer,
 *   spawns the generated stdio entry as a real process, and drives it with a
 *   real MCP client. This is the packed process-and-protocol evidence level.
 * - `packed-deleted-source` carries the `packed-stdio` proof after project
 *   source and configuration have been removed and verified absent. It proves
 *   that the generated entry is self-contained; it does not prove native-host
 *   install or dispatch, or an install mode that copies the artifact elsewhere.
 * - `browser-app` compiles MCP App HTML through the production Rsbuild
 *   profile and mounts it over the product bridge in a real browser page. It
 *   does not prove host embedding, a packed artifact, or Workbench behavior.
 * - `simulated` stages an emitted bundle directly into an isolated host-shaped
 *   root and spawns its MCP command. It does not prove a host-owned install.
 * - `host-install` installs a built bundle into an isolated real host home
 *   through the public install path and observes registration through the
 *   host's own CLI. It does not prove session behavior or packed provenance.
 */
export type AgentTestProofLevel =
  | 'route-unit'
  | 'mcp-in-memory'
  | 'dev-epoch'
  | 'cli-dispatch'
  | 'script-dispatch'
  | 'workbench-surface'
  | 'packed-stdio'
  | 'packed-deleted-source'
  | 'browser-app'
  | 'simulated'
  | 'host-install';

export const ROUTE_UNIT_PROOF_LEVEL = 'route-unit' as const;
export const MCP_IN_MEMORY_PROOF_LEVEL = 'mcp-in-memory' as const;
export const DEV_EPOCH_PROOF_LEVEL = 'dev-epoch' as const;
export const CLI_DISPATCH_PROOF_LEVEL = 'cli-dispatch' as const;
export const SCRIPT_DISPATCH_PROOF_LEVEL = 'script-dispatch' as const;
export const WORKBENCH_SURFACE_PROOF_LEVEL = 'workbench-surface' as const;
export const PACKED_STDIO_PROOF_LEVEL = 'packed-stdio' as const;
export const PACKED_DELETED_SOURCE_PROOF_LEVEL = 'packed-deleted-source' as const;
export const BROWSER_APP_PROOF_LEVEL = 'browser-app' as const;
export const SIMULATED_PROOF_LEVEL = 'simulated' as const;
export const HOST_INSTALL_PROOF_LEVEL = 'host-install' as const;

/**
 * One line per level, printed in every harness failure. A red test has to
 * say what the passing case would have proven, or the level discipline is
 * only a naming convention.
 */
export const proofLevelLabel = (level: AgentTestProofLevel): string => {
  switch (level) {
    case 'route-unit':
      return 'route-unit (real Agent renderer; no transport, browser, or artifact)';
    case 'mcp-in-memory':
      return 'mcp-in-memory (real generated MCP server + real client over the SDK in-memory transport; NOT process or packed-artifact evidence)';
    case 'dev-epoch':
      return 'dev-epoch (epoch-pinned generated stdio entry spawned as a real process through the Workbench session service; NOT packed or native-host evidence)';
    case 'cli-dispatch':
      return 'cli-dispatch (argv dispatched through the routed CLI shell in-process; NOT a spawned binary)';
    case 'script-dispatch':
      return 'script-dispatch (conventional script run through its generated executable contract — rendered-script shell in-process, or plain main envelope as a Node process over the source; NOT the bundled scripts/<name>.mjs artifact)';
    case 'workbench-surface':
      return 'workbench-surface (compiled route graph projected exactly as the dev server serves it to the Workbench; NOT a browser, dev-server, or built-artifact receipt)';
    case 'packed-stdio':
      return 'packed-stdio (packed tarball installed into a clean consumer, generated stdio entry spawned as a real process)';
    case 'packed-deleted-source':
      return 'packed-deleted-source (packed tarball installed into a clean consumer, artifact built, project source removed and verified absent, generated stdio entry spawned as a real process; self-contained-artifact evidence)';
    case 'browser-app':
      return 'browser-app (MCP App HTML compiled through the production Rsbuild profile, mounted in a real browser page over the product bridge; NOT host embedding, packed-artifact, or Workbench evidence)';
    case 'simulated':
      return 'simulated (adapter-simulated discovery and stdio spawn from an isolated installed root; NOT host-install evidence)';
    case 'host-install':
      return 'host-install (built bundle installed into an isolated real host home through the public install path, registration observed via the host\'s own CLI; NOT session-behavior or packed-artifact evidence)';
    default: {
      const exhaustive: never = level;
      throw new TypeError(`Unknown proof level ${String(exhaustive)}.`);
    }
  }
};

/** One compiled route the harness can address, with the identity its diagnostics report. */
export interface TestableRouteDescriptor {
  /** The route module's statically extracted `config` export; `{}` when absent. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: CompiledRouteKind;
  /** Project-relative POSIX path of the route module. */
  readonly relativePath: string;
  /** The owning MCP server id (`mcp:<name>`); MCP route kinds only. */
  readonly serverId?: string;
  /** Absolute route module path. */
  readonly source: string;
}

/** The project identity a generated MCP server advertises on the wire. */
export interface TestManifestPluginIdentity {
  readonly name: string;
  /** The validated npm package name, absent for unpackaged development projects. */
  readonly packageName?: string;
  /** The validated semantic release version, absent for unpackaged development projects. */
  readonly packageVersion?: string;
  readonly version: string;
}

/**
 * The identity a manifest carries when preparation produced no plugin model
 * (the configuration could not be loaded or normalized). It is one frozen
 * sentinel rather than a guess at the project, and {@link isFallbackPluginIdentity}
 * recognizes it so no harness surface — the Rstest presets' `agent-bundle/meta`
 * alias in particular — ever serves it as a real identity.
 */
export const FALLBACK_PLUGIN_IDENTITY: TestManifestPluginIdentity = Object.freeze({
  name: 'unknown',
  version: '0.0.0',
});

/**
 * True when a manifest's identity is the model-less sentinel. The check is
 * by reference only: `deepFreeze` freezes in place, so the manifest the
 * compiler pass hands the presets still carries the sentinel object itself,
 * while a real project that happens to declare `plugin.name: 'unknown'` and
 * `plugin.version: '0.0.0'` is a distinct model-backed object and keeps its
 * identity. A manifest that crossed a JSON boundary has already been handed
 * to a worker; only the preset, in the runner process, asks this question.
 */
export const isFallbackPluginIdentity = (plugin: TestManifestPluginIdentity): boolean =>
  plugin === FALLBACK_PLUGIN_IDENTITY;
/** One conventional layout module the harness composes around manifest route renders, exactly as generated workers do. */
export interface TestableLayoutDescriptor {
  /** `layout:root` or `layout:mcp:<server>`. */
  readonly id: string;
  /** Project-relative POSIX path of the layout module. */
  readonly relativePath: string;
  readonly scope: CompiledLayoutScope;
  /** The owning MCP server id (`mcp:<name>`); `server` scope only. */
  readonly serverId?: string;
  /** Absolute layout module path. */
  readonly source: string;
}

/**
 * One conventional `src/scripts/<name>` module the script-dispatch level can
 * run. `rendered` is the extension contract (#102 stage 3): `.tsx`/`.jsx`
 * scripts render through the Agent renderer, everything else is a plain
 * executable module. Explicit `scripts:` configuration entries are bundled
 * entries rather than routes, so they never appear here.
 */
export interface TestableScriptDescriptor {
  /** The path-derived script name (`script:verify` -> `verify`). */
  readonly name: string;
  /** Project-relative POSIX path of the script module. */
  readonly relativePath: string;
  readonly rendered: boolean;
  readonly routeId: string;
  /** Absolute script module path. */
  readonly source: string;
}

/** The conventional state module the generated route-unit registry can load. */
export interface TestableStateDescriptor {
  readonly id: string;
  readonly lifetime: NormalizedStateDefinition['lifetime'];
  readonly relativePath: string;
  readonly source: string;
}

/**
 * One conventional `src/providers/<name>.ts` context provider the harness
 * mounts for every manifest request scope, exactly as the generated entries
 * do (#313). `key` is the camel-cased request-context key.
 */
export interface TestableProviderDescriptor {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  /** Project-relative POSIX path of the provider module. */
  readonly relativePath: string;
  /** Absolute provider module path. */
  readonly source: string;
}

/** One normalized MCP App declaration addressable by the browser proof level. */
export interface TestableAppDescriptor {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly name: string;
  readonly prebuilt?: true;
  /** Project-relative POSIX path of the browser entry module. */
  readonly relativePath: string;
  readonly resourceUri: string;
  /** Every MCP server sharing this identical app declaration. */
  readonly serverIds: readonly string[];
  /** Absolute browser entry module path. */
  readonly source: string;
  readonly targets: readonly string[];
  /** Absolute optional HTML shell template path. */
  readonly template?: string;
}

/**
 * What the compiler tells the test harness about one project: the route
 * and MCP App inventories, the project identity its generated servers
 * advertise, the selected targets, and the compiler's own diagnostics.
 * Artifact descriptors arrive with the stage that can honestly prove them.
 */
export interface AgentBundleTestManifest {
  /** Collision-checked MCP App declarations from the same compiler pass. */
  readonly apps: Readonly<Record<string, TestableAppDescriptor>>;
  /**
   * The collision-checked routed-CLI command graph (#102 stage 2) from the
   * same pass, so the CLI dispatch level drives the product's own dispatcher
   * over the product's own commands instead of resolving argv itself. Empty
   * when the project compiles no `src/cli/**` commands.
   */
  readonly cliCommands: readonly CompiledCliCommand[];
  /** The absolute config path the compiler pass evaluated. */
  readonly configPath?: string;
  /** Diagnostics from the same pass, so a harness failure can name a compiler cause. */
  readonly diagnostics: readonly Diagnostic[];
  /** The route graph digest: project-relative route identity, equal on every machine. */
  readonly digest: string;
  /** Generated MCP server that owns the shared event runtime, when event routes and a generated server coexist. */
  readonly eventRuntimeServerId?: string;
  /** Conventional layouts from the same pass, ordered by id; empty when the project declares none. */
  readonly layouts: readonly TestableLayoutDescriptor[];
  /** Plugin name and version, as the generated MCP server reports them in `initialize`. */
  readonly plugin: TestManifestPluginIdentity;
  readonly projectRoot: string;
  /** The level the manifest and its registered loaders alone supply; every other level stamps its own. */
  readonly proofLevel: AgentTestProofLevel;
  /**
   * Conventional request context providers, in the execution order every
   * generated request scope uses; the harness mounts them automatically unless
   * a test passes `context.providers`. Absent when the project declares none.
   */
  readonly providers?: readonly TestableProviderDescriptor[];
  readonly routes: Readonly<Record<string, TestableRouteDescriptor>>;
  /**
   * The conventional `src/scripts/*` modules from the same pass, collision-
   * checked by name, so the script-dispatch level runs the product's own
   * script contract instead of guessing at file extensions. Empty when the
   * project compiles no conventional scripts.
   */
  readonly scripts: readonly TestableScriptDescriptor[];
  /** Conventional project state mounted automatically for manifest route renders. */
  readonly state?: TestableStateDescriptor;
  /** Host targets the project selected. Route-unit rendering is target-neutral; these name the projection surfaces a later proof level owns. */
  readonly targets: readonly string[];
}

export interface CompileTestManifestOptions {
  readonly configPath?: string;
  readonly root?: string;
}

const descriptorOf = (route: CompiledAgentRoute): TestableRouteDescriptor => ({
  config: route.config,
  id: route.id,
  kind: route.kind,
  relativePath: route.provenance.relativePath,
  ...(route.serverId === undefined ? {} : { serverId: route.serverId }),
  source: route.source,
});

const providerDescriptors = (
  providers: readonly CompiledProvider[],
): readonly TestableProviderDescriptor[] => orderedProviders(providers).map((provider) => ({
  id: provider.id,
  key: providerKeyFromName(provider.name),
  name: provider.name,
  relativePath: provider.provenance.relativePath,
  source: provider.source,
}));

const graphRoutes = (graph: CompiledRouteGraph): readonly CompiledAgentRoute[] => [
  ...(graph.cli?.routes ?? []),
  ...graph.events,
  ...graph.scripts,
  ...graph.servers.flatMap((server) => server.routes),
];

const appDescriptors = (
  apps: readonly NormalizedMcpApp[],
  projectRoot: string,
): Readonly<Record<string, TestableAppDescriptor>> => {
  const descriptors: Record<string, TestableAppDescriptor> = {};
  const identities = new Map<string, string>();
  for (const app of apps) {
    const identity = stableJson({
      ...(app._meta === undefined ? {} : { _meta: app._meta }),
      resourceUri: app.resourceUri,
      source: app.source,
      ...(app.template === undefined ? {} : { template: app.template }),
    });
    const existing = descriptors[app.name];
    if (existing !== undefined) {
      if (identities.get(app.name) !== identity) {
        throw new Error(
          `Duplicate compiled MCP App destination ${JSON.stringify(`mcp-apps/${app.name}.html`)}; `
          + 'servers may share an app name only with an identical declaration.',
        );
      }
      descriptors[app.name] = {
        ...existing,
        serverIds: [...new Set([...existing.serverIds, app.serverId])].sort((left, right) => left.localeCompare(right)),
        targets: [...new Set([...existing.targets, ...app.targets])],
      };
      continue;
    }
    identities.set(app.name, identity);
    descriptors[app.name] = {
      ...(app._meta === undefined ? {} : { _meta: app._meta }),
      id: app.id,
      name: app.name,
      ...(app.prebuilt === undefined ? {} : { prebuilt: app.prebuilt }),
      relativePath: relative(projectRoot, app.source).split(sep).join('/'),
      resourceUri: app.resourceUri,
      serverIds: [app.serverId],
      source: app.source,
      targets: [...app.targets],
      ...(app.template === undefined ? {} : { template: app.template }),
    };
  }
  return descriptors;
};

/**
 * The script names explicit `scripts:` configuration claims. Normalization
 * carries them as config-provenance scripts; a conventional route that
 * collides with one is an `AB4809` error and never ships.
 */
const configuredScriptNames = (scripts: readonly NormalizedScript[]): ReadonlySet<string> =>
  new Set(scripts.filter((script) => script.provenance.kind === 'config').map((script) => script.name));

/**
 * Only the conventional script routes normalization ships become
 * `scripts/<name>.mjs` executables. The same #102 judgment gates this
 * inventory, so `runScript` can never carry a `script-dispatch` proof for a
 * nested (`AB4808`) or configuration-conflicting (`AB4809`) route whose
 * executable cannot exist.
 */
const scriptDescriptors = (
  graph: CompiledRouteGraph,
  configured: ReadonlySet<string>,
): readonly TestableScriptDescriptor[] => {
  const seen = new Map<string, string>();
  return graph.scripts.flatMap((route): TestableScriptDescriptor[] => {
    const judgment = judgeScriptRoute(route, configured);
    switch (judgment) {
      case 'nested':
      case 'conflicting':
        return [];
      case 'rendered':
      case 'shippable':
        break;
      default: {
        const exhaustive: never = judgment;
        return exhaustive;
      }
    }
    const name = scriptRouteName(route);
    const existing = seen.get(name);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate compiled script name ${JSON.stringify(name)}: ${existing} and ${route.provenance.relativePath} `
        + 'would both compile to the same scripts/<name>.mjs executable.',
      );
    }
    seen.set(name, route.provenance.relativePath);
    return [{
      name,
      relativePath: route.provenance.relativePath,
      rendered: isRenderedScriptRoute(route),
      routeId: route.id,
      source: route.source,
    }];
  });
};

/**
 * Projects the compiled route graph into the manifest the harness addresses.
 * The graph is an input here, never recompiled: one compiler pass feeds the
 * build, `inspect`, and the harness alike.
 */
export const testManifestFromRouteGraph = (input: {
  readonly apps?: readonly NormalizedMcpApp[];
  readonly configPath?: string;
  readonly diagnostics?: readonly Diagnostic[];
  readonly graph: CompiledRouteGraph;
  readonly plugin?: TestManifestPluginIdentity;
  readonly projectRoot: string;
  /** The normalized script inventory; its config-provenance entries decide which conventional routes conflict. */
  readonly scripts?: readonly NormalizedScript[];
  readonly state?: NormalizedStateDefinition;
  readonly targets?: readonly string[];
}): AgentBundleTestManifest => {
  const routes: Record<string, TestableRouteDescriptor> = {};
  for (const route of graphRoutes(input.graph)) routes[route.id] = descriptorOf(route);
  const eventRuntimeServerId = input.graph.events.length === 0
    ? undefined
    : input.graph.servers.find((server) => server.mode === 'generated')?.id;
  return deepFreeze({
    apps: appDescriptors(input.apps ?? [], input.projectRoot),
    cliCommands: [...(input.graph.cli?.commands ?? [])],
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    diagnostics: [...(input.diagnostics ?? input.graph.diagnostics)],
    digest: input.graph.digest,
    ...(eventRuntimeServerId === undefined ? {} : { eventRuntimeServerId }),
    layouts: [...(input.graph.layouts ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((layout) => ({
        id: layout.id,
        relativePath: layout.provenance.relativePath,
        scope: layout.scope,
        ...(layout.serverId === undefined ? {} : { serverId: layout.serverId }),
        source: layout.source,
      })),
    plugin: input.plugin ?? FALLBACK_PLUGIN_IDENTITY,
    projectRoot: input.projectRoot,
    proofLevel: ROUTE_UNIT_PROOF_LEVEL,
    ...(input.graph.providers.length === 0 ? {} : { providers: providerDescriptors(input.graph.providers) }),
    routes,
    scripts: scriptDescriptors(input.graph, configuredScriptNames(input.scripts ?? [])),
    ...(input.state === undefined
      ? {}
      : {
          state: {
            id: input.state.id,
            lifetime: input.state.lifetime,
            relativePath: relative(input.projectRoot, input.state.source).split(sep).join('/'),
            source: input.state.source,
          },
        }),
    targets: [...(input.targets ?? [])],
  });
};

/**
 * Compiles one project's test manifest from the same preparation the build
 * and `inspect` run: configuration load, conventional discovery (which owns
 * route-graph compilation), normalization, and validation. No artifact is
 * built and no bundler runs, so route-unit tests get the manifest without a
 * build.
 *
 * The compiler is reached through a dynamic import on purpose: the generated
 * Rstest configuration compiles the manifest once in the runner process and
 * hands it to workers, so a test worker that only renders routes never loads
 * the compiler at all.
 */
export const compileTestManifest = async (
  options: CompileTestManifestOptions = {},
): Promise<AgentBundleTestManifest> => {
  const root = resolve(options.root ?? process.cwd());
  const { ProjectService } = await import('../dev/project-service.ts');
  const { emptyCompiledRouteGraph } = await import('../routes/graph.ts');
  const prepared = await new ProjectService({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    root,
  }).prepare('inspect');
  return testManifestFromRouteGraph({
    apps: prepared.model?.mcpApps ?? [],
    configPath: prepared.configPath,
    diagnostics: prepared.diagnostics,
    graph: prepared.routeGraph ?? emptyCompiledRouteGraph,
    ...(prepared.model === undefined
      ? {}
      : {
        plugin: {
          name: prepared.model.metadata.name,
          ...(prepared.model.metadata.packageName === undefined ? {} : { packageName: prepared.model.metadata.packageName }),
          ...(prepared.model.metadata.packageVersion === undefined ? {} : { packageVersion: prepared.model.metadata.packageVersion }),
          version: prepared.model.metadata.version,
        },
      }),
    projectRoot: prepared.root,
    scripts: prepared.model?.scripts ?? [],
    ...(prepared.model?.state === undefined ? {} : { state: prepared.model.state }),
    targets: prepared.model?.targets.map((target) => target.name) ?? [],
  });
};
