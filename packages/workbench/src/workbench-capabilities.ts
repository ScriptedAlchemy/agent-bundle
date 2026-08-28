import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';

import type { ArtifactClient } from './artifacts/artifact-client.ts';
import type { EvalClient } from './evals/eval-client.ts';
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
  readonly skillTree: SkillDocumentTree;
}

export interface WorkbenchCapabilityClients {
  readonly artifactClient: Pick<ArtifactClient, 'inspect'>;
  readonly buildId: string;
  readonly evalClient: Pick<EvalClient, 'suites'>;
  readonly signal?: AbortSignal;
  readonly skillClient: Pick<SkillClient, 'sourceTree'>;
}

export const generalWorkbenchPages: ReadonlySet<WorkbenchPage> = Object.freeze(new Set<WorkbenchPage>([
  'overview',
  'artifacts',
  'logs',
]));

const pagesFor = (counts: WorkbenchCapabilities['counts']): ReadonlySet<WorkbenchPage> => {
  const pages: WorkbenchPage[] = ['overview'];
  if (counts.skills > 0) pages.push('skills');
  if (counts.hooks > 0) pages.push('hooks');
  if (counts.mcpServers > 0) pages.push('mcp');
  pages.push('artifacts');
  if (counts.hooks + counts.scripts > 0) pages.push('playground');
  pages.push('logs');
  if (counts.evalSuites > 0) pages.push('evals', 'comparisons');
  return Object.freeze(new Set(pages));
};

/** Composes existing strict route catalogs into one build-scoped Workbench view. */
export const loadWorkbenchCapabilities = async ({
  artifactClient,
  buildId,
  evalClient,
  signal,
  skillClient,
}: WorkbenchCapabilityClients): Promise<WorkbenchCapabilities> => {
  signal?.throwIfAborted();
  const [inspection, skillTree, evalListing] = await Promise.all([
    artifactClient.inspect(buildId, signal),
    skillClient.sourceTree(),
    evalClient.suites(),
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
  return Object.freeze({ buildId, counts, inspection, pages: pagesFor(counts), skillTree });
};
