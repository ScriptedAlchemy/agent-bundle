import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type {
  CompiledAgentRoute,
  CompiledCliCommand,
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
 * - `cli-dispatch` runs an argv vector through the routed CLI's own shell over
 *   the compiled command graph, in this process. It proves command
 *   resolution, argv projection, and exit codes, not a spawned binary.
 * - `packed-stdio` installs the packed release tarball into a clean consumer,
 *   spawns the generated stdio entry as a real process, and drives it with a
 *   real MCP client. This is the only level here that is process evidence.
 *
 * Browser and deleted-source artifact levels are later stages; nothing here
 * stands in for them.
 */
export type AgentTestProofLevel = 'route-unit' | 'mcp-in-memory' | 'cli-dispatch' | 'packed-stdio';

export const ROUTE_UNIT_PROOF_LEVEL = 'route-unit' as const;
export const MCP_IN_MEMORY_PROOF_LEVEL = 'mcp-in-memory' as const;
export const CLI_DISPATCH_PROOF_LEVEL = 'cli-dispatch' as const;
export const PACKED_STDIO_PROOF_LEVEL = 'packed-stdio' as const;

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
    case 'cli-dispatch':
      return 'cli-dispatch (argv dispatched through the routed CLI shell in-process; NOT a spawned binary)';
    case 'packed-stdio':
      return 'packed-stdio (packed tarball installed into a clean consumer, generated stdio entry spawned as a real process)';
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
  readonly version: string;
}

/**
 * What the compiler tells the test harness about one project: the route
 * inventory, the project identity its generated servers advertise, the
 * selected targets, and the compiler's own diagnostics. Browser-App and
 * artifact descriptors arrive with the stages that can honestly prove them.
 */
export interface AgentBundleTestManifest {
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
  /** Plugin name and version, as the generated MCP server reports them in `initialize`. */
  readonly plugin: TestManifestPluginIdentity;
  readonly projectRoot: string;
  /** The level the manifest and its registered loaders alone supply; every other level stamps its own. */
  readonly proofLevel: AgentTestProofLevel;
  readonly routes: Readonly<Record<string, TestableRouteDescriptor>>;
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

const graphRoutes = (graph: CompiledRouteGraph): readonly CompiledAgentRoute[] => [
  ...(graph.cli?.routes ?? []),
  ...graph.events,
  ...graph.scripts,
  ...graph.servers.flatMap((server) => server.routes),
];

/**
 * Projects the compiled route graph into the manifest the harness addresses.
 * The graph is an input here, never recompiled: one compiler pass feeds the
 * build, `inspect`, and the harness alike.
 */
export const testManifestFromRouteGraph = (input: {
  readonly configPath?: string;
  readonly diagnostics?: readonly Diagnostic[];
  readonly graph: CompiledRouteGraph;
  readonly plugin?: TestManifestPluginIdentity;
  readonly projectRoot: string;
  readonly targets?: readonly string[];
}): AgentBundleTestManifest => {
  const routes: Record<string, TestableRouteDescriptor> = {};
  for (const route of graphRoutes(input.graph)) routes[route.id] = descriptorOf(route);
  return deepFreeze({
    cliCommands: [...(input.graph.cli?.commands ?? [])],
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    diagnostics: [...(input.diagnostics ?? input.graph.diagnostics)],
    digest: input.graph.digest,
    plugin: input.plugin ?? { name: 'unknown', version: '0.0.0' },
    projectRoot: input.projectRoot,
    proofLevel: ROUTE_UNIT_PROOF_LEVEL,
    routes,
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
    configPath: prepared.configPath,
    diagnostics: prepared.diagnostics,
    graph: prepared.routeGraph ?? emptyCompiledRouteGraph,
    ...(prepared.model === undefined
      ? {}
      : { plugin: { name: prepared.model.metadata.name, version: prepared.model.metadata.version } }),
    projectRoot: prepared.root,
    targets: prepared.model?.targets.map((target) => target.name) ?? [],
  });
};
