import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';

import { errorMessage as messageFrom } from './client-helpers.ts';

import type { ArtifactClient } from './artifacts/artifact-client.ts';
import type { EvalClient } from './evals/eval-client.ts';
import type { RouteManifestClient } from './routes/route-manifest-client.ts';
import {
  routeCatalogFor,
  routeCatalogHasKind,
  routeCatalogServerCount,
  unavailableRouteCatalog,
  type RouteCatalog,
} from './routes/routes-model.ts';
import type { SkillClient } from './skill-client.ts';
import type { WorkbenchPage } from './workbench-screen.tsx';

export interface WorkbenchCapabilities {
  readonly buildId: string;
  readonly counts: Readonly<{
    readonly evalSuites: number;
    readonly hooks: number;
    readonly mcpServers: number;
    readonly scripts: number;
    readonly skills: number;
    readonly targets: number;
  }>;
  readonly inspection: ArtifactInspection;
  readonly pages: ReadonlySet<WorkbenchPage>;
  /** The compiled route graph this build was produced from, projected for the browser. */
  readonly routes: RouteCatalog;
  readonly skillTree: SkillDocumentTree;
}

export interface WorkbenchCapabilityClients {
  readonly artifactClient: Pick<ArtifactClient, 'inspect'>;
  readonly buildId: string;
  /** The published epoch's project revision, used to detect a newer compiled manifest. */
  readonly epochSourceRevision?: string;
  readonly evalClient: Pick<EvalClient, 'suites'>;
  readonly routeManifestClient: Pick<RouteManifestClient, 'manifest'>;
  readonly signal?: AbortSignal;
  readonly skillClient: Pick<SkillClient, 'sourceTree'>;
}

export const generalWorkbenchPages: ReadonlySet<WorkbenchPage> = Object.freeze(new Set<WorkbenchPage>([
  'overview',
  'artifacts',
  'logs',
]));

/**
 * Navigation derives from the compiled route graph wherever the graph declares
 * the surface, and from the artifact catalog for everything configuration can
 * declare without a route module. The union is deliberate: a project may reach
 * a page through either source, and neither may hide the other.
 */
const pagesFor = (
  counts: WorkbenchCapabilities['counts'],
  routes: RouteCatalog,
): ReadonlySet<WorkbenchPage> => {
  const compiledEvents = routeCatalogHasKind(routes, 'event-route');
  const compiledScripts = routeCatalogHasKind(routes, 'script');
  const pages: WorkbenchPage[] = ['overview', 'routes'];
  if (counts.skills > 0) pages.push('skills');
  if (counts.hooks > 0 || compiledEvents) pages.push('hooks');
  if (compiledEvents) pages.push('lifecycles');
  if (counts.mcpServers > 0 || routeCatalogServerCount(routes) > 0) pages.push('mcp');
  pages.push('artifacts');
  if (counts.hooks + counts.scripts > 0 || compiledEvents || compiledScripts) pages.push('playground');
  pages.push('logs');
  if (counts.evalSuites > 0) pages.push('evals', 'comparisons');
  return Object.freeze(new Set(pages));
};

const errorMessage = (reason: unknown): string =>
  messageFrom(reason, 'The compiled route manifest could not be read.');

/**
 * An absent or refused manifest route degrades this one section rather than the
 * whole catalog: every page that predates the manifest keeps its artifact-derived
 * evidence, so the Workbench stays usable against a dev server without the route.
 */
const routeCatalog = async (
  client: Pick<RouteManifestClient, 'manifest'>,
  epochSourceRevision: string | undefined,
  signal: AbortSignal | undefined,
): Promise<RouteCatalog> => {
  try {
    return routeCatalogFor(await client.manifest(signal), epochSourceRevision);
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'AbortError') throw reason;
    return unavailableRouteCatalog(errorMessage(reason));
  }
};

/** Composes existing strict route catalogs into one build-scoped Workbench view. */
export const loadWorkbenchCapabilities = async ({
  artifactClient,
  buildId,
  epochSourceRevision,
  evalClient,
  routeManifestClient,
  signal,
  skillClient,
}: WorkbenchCapabilityClients): Promise<WorkbenchCapabilities> => {
  signal?.throwIfAborted();
  const [inspection, skillTree, evalListing, routes] = await Promise.all([
    artifactClient.inspect(buildId, signal),
    skillClient.sourceTree(),
    evalClient.suites(),
    routeCatalog(routeManifestClient, epochSourceRevision, signal),
  ]);
  signal?.throwIfAborted();
  if (inspection.epochId !== buildId) throw new Error('Capability catalog did not match the current build.');
  const counts = Object.freeze({
    evalSuites: evalListing.suites.length,
    hooks: inspection.runtime.hooks.length,
    mcpServers: inspection.runtime.mcpServers.length,
    scripts: inspection.runtime.scripts.length,
    skills: skillTree.skills.length,
    targets: inspection.targets.length,
  });
  return Object.freeze({
    buildId,
    counts,
    inspection,
    pages: pagesFor(counts, routes),
    routes,
    skillTree,
  });
};
