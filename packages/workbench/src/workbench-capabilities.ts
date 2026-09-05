import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import type { SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';

import type { ApplicationTreeSources } from './application/application-tree-model.ts';
import type { ArtifactClient } from './artifacts/artifact-client.ts';
import { errorMessage as messageFrom } from './client-helpers.ts';
import type { EvalClient } from './evals/eval-client.ts';
import type { RouteManifestClient } from './routes/route-manifest-client.ts';
import type { RouteCatalogState } from './routes/routes-model.ts';
import type { SkillClient } from './skill-client.ts';

/**
 * The compiled route manifest as the shell needs it: the manifest itself (the
 * application tree derives from it) plus its freshness against the published
 * build. `stale` is normal mid-rebuild drift — the dev server compiled newer
 * source than the epoch hosts see; `unavailable` carries the refusal.
 */
export interface WorkbenchRouteCatalog {
  readonly manifest?: RouteManifest;
  readonly message?: string;
  readonly state: RouteCatalogState;
}

/**
 * Which optional surfaces this build declares. Navigation no longer derives
 * from these — the application tree does — but the shell still gates what it
 * wires: the runtime backend exists only for a project with a `devRuntime`
 * provider, and Advanced sections read the flags for their empty states.
 */
export interface WorkbenchFeatures {
  readonly evals: boolean;
  readonly hooks: boolean;
  readonly mcp: boolean;
  /** The foreground owns a development Runtime controller (`ProjectStatus.runtime`). */
  readonly runtime: boolean;
  readonly scripts: boolean;
  readonly skills: boolean;
}

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
  readonly features: WorkbenchFeatures;
  readonly inspection: ArtifactInspection;
  readonly routes: WorkbenchRouteCatalog;
  readonly skillTree: SkillDocumentTree;
}

export interface WorkbenchCapabilityClients {
  readonly artifactClient: Pick<ArtifactClient, 'inspect'>;
  readonly buildId: string;
  /** The published epoch's project revision, used to detect a newer compiled manifest. */
  readonly epochSourceRevision?: string;
  readonly evalClient: Pick<EvalClient, 'suites'>;
  readonly routeManifestClient: Pick<RouteManifestClient, 'manifest'>;
  /** Whether the foreground reports a configured development Runtime (`ProjectStatus.runtime`). */
  readonly runtime?: boolean;
  readonly signal?: AbortSignal;
  readonly skillClient: Pick<SkillClient, 'sourceTree'>;
}

const errorMessage = (reason: unknown): string =>
  messageFrom(reason, 'The compiled route manifest could not be read.');

/**
 * An absent or refused manifest route degrades this one section rather than the
 * whole catalog: the artifact-derived evidence keeps the Workbench usable
 * against a dev server without the route, and the tree reports why it is empty.
 */
const routeCatalog = async (
  client: Pick<RouteManifestClient, 'manifest'>,
  epochSourceRevision: string | undefined,
  signal: AbortSignal | undefined,
): Promise<WorkbenchRouteCatalog> => {
  try {
    const manifest = await client.manifest(signal);
    return Object.freeze({
      manifest,
      state: epochSourceRevision === undefined || epochSourceRevision === manifest.sourceRevision ? 'current' : 'stale',
    });
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'AbortError') throw reason;
    return Object.freeze({ message: errorMessage(reason), state: 'unavailable' });
  }
};

const manifestHas = (manifest: RouteManifest | undefined, select: (manifest: RouteManifest) => number): boolean =>
  manifest !== undefined && select(manifest) > 0;

/**
 * Feature detection unions the compiled route graph with the artifact catalog:
 * a project may declare a surface through either, and neither may hide the other.
 */
const featuresFor = (
  counts: WorkbenchCapabilities['counts'],
  routes: WorkbenchRouteCatalog,
  runtime: boolean,
): WorkbenchFeatures => Object.freeze({
  evals: counts.evalSuites > 0,
  hooks: counts.hooks > 0 || manifestHas(routes.manifest, (manifest) => manifest.events.length),
  mcp: counts.mcpServers > 0 || manifestHas(routes.manifest, (manifest) => manifest.servers.length),
  runtime,
  scripts: counts.scripts > 0 || manifestHas(routes.manifest, (manifest) => manifest.scripts.length),
  skills: counts.skills > 0,
});

/** Composes existing strict route catalogs into one build-scoped Workbench view. */
export const loadWorkbenchCapabilities = async ({
  artifactClient,
  buildId,
  epochSourceRevision,
  evalClient,
  routeManifestClient,
  runtime = false,
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
    features: featuresFor(counts, routes, runtime),
    inspection,
    routes,
    skillTree,
  });
};

/** The application tree's inputs, read off one loaded capability catalog. */
export const applicationTreeSourcesFor = (capabilities: WorkbenchCapabilities): ApplicationTreeSources => Object.freeze({
  inspection: capabilities.inspection,
  ...(capabilities.routes.manifest === undefined ? {} : { manifest: capabilities.routes.manifest }),
  ...(capabilities.routes.message === undefined ? {} : { message: capabilities.routes.message }),
  skillTree: capabilities.skillTree,
  state: capabilities.routes.state,
});
