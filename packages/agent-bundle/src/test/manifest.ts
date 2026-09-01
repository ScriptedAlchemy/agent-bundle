import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { CompiledAgentRoute, CompiledRouteGraph, CompiledRouteKind } from '../routes/types.ts';

/**
 * The proof level one harness helper supplies. Stage 1 of the consumer test
 * harness ships exactly one level: `route-unit` renders a route module
 * through the real Agent renderer and never opens a transport, compiles a
 * browser surface, or builds a host artifact. Later stages add their own
 * levels beside this one; a route-unit pass is never an artifact, transport,
 * or host receipt.
 */
export type AgentTestProofLevel = 'route-unit';

export const ROUTE_UNIT_PROOF_LEVEL: AgentTestProofLevel = 'route-unit';

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

/**
 * What the compiler tells the test harness about one project. Stage 1 carries
 * the route inventory, the selected targets, and the compiler's own
 * diagnostics; projection, browser-App, and artifact descriptors arrive with
 * the stages that can honestly prove them.
 */
export interface AgentBundleTestManifest {
  /** The absolute config path the compiler pass evaluated. */
  readonly configPath?: string;
  /** Diagnostics from the same pass, so a harness failure can name a compiler cause. */
  readonly diagnostics: readonly Diagnostic[];
  /** The route graph digest: project-relative route identity, equal on every machine. */
  readonly digest: string;
  readonly projectRoot: string;
  /** The one proof level stage 1 supplies. */
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
  readonly projectRoot: string;
  readonly targets?: readonly string[];
}): AgentBundleTestManifest => {
  const routes: Record<string, TestableRouteDescriptor> = {};
  for (const route of graphRoutes(input.graph)) routes[route.id] = descriptorOf(route);
  return deepFreeze({
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    diagnostics: [...(input.diagnostics ?? input.graph.diagnostics)],
    digest: input.graph.digest,
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
    projectRoot: prepared.root,
    targets: prepared.model?.targets.map((target) => target.name) ?? [],
  });
};
