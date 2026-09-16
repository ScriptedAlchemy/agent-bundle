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
  readonly routes: WorkbenchRouteCatalog;
  /** The foreground owns a development Runtime controller (`ProjectStatus.runtime`). */
  readonly runtime: boolean;
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
  const application = inspection.application;
  const counts = Object.freeze({
    evalSuites: evalListing.suites.length,
    hooks: application.events.reduce((count, event) => count + event.hooks.length, 0) +
      application.hooks.reduce((count, group) => count + group.hooks.length, 0),
    mcpServers: application.servers.length,
    scripts: application.scripts.length,
    skills: skillTree.skills.length,
    targets: application.hosts.length,
  });
  return Object.freeze({
    buildId,
    counts,
    inspection,
    routes,
    runtime,
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
