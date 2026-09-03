import type { Diagnostic } from '../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  ArtifactEpoch,
  ArtifactState,
  DevContractFailure,
  HostAdoptionStatus,
  ProjectStatus,
  SourceState,
} from '../../agent-bundle/src/contracts/project.ts';
import type { WorkbenchCapabilities } from './workbench-capabilities.ts';
import type { WorkbenchPage } from './workbench-screen.tsx';

/** The active (or last-good) artifact epoch, or undefined when none was published. */
export const activeEpochFor = (status: ProjectStatus): ArtifactEpoch | undefined =>
  status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;

export interface OverviewNormalization {
  readonly label: string;
  readonly revision?: string;
  readonly state: SourceState;
}

export interface OverviewEpoch {
  readonly createdAt?: string;
  readonly id?: string;
  readonly state: ArtifactState;
  readonly summary: string;
}

export interface OverviewTarget {
  readonly digest: string;
  readonly name: string;
  readonly state: 'built' | 'last-good';
}

export interface OverviewNextAction {
  readonly label: 'Rebuild';
  readonly summary: string;
}

export interface BundleSummary {
  readonly capabilityLabels: readonly string[];
  readonly nextPages: readonly WorkbenchPage[];
  readonly targetCount: number;
}

export type OverviewHostAdoptionState = 'direct' | 'failed' | 'passed' | 'pending';

/** What live host connections and development installs serve, and why. */
export interface OverviewHostAdoption {
  readonly adoptedEpochId?: string;
  readonly failures: readonly DevContractFailure[];
  readonly gateSummary?: string;
  readonly mode: HostAdoptionStatus['mode'];
  readonly state: OverviewHostAdoptionState;
  readonly summary: string;
}

export interface OverviewModel {
  readonly changedFiles: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly epoch: OverviewEpoch;
  readonly hostAdoption?: OverviewHostAdoption;
  readonly nextAction: OverviewNextAction;
  readonly normalization: OverviewNormalization;
  readonly targets: readonly OverviewTarget[];
}

const sourceLabel = (state: SourceState): string => {
  switch (state) {
    case 'ready': return 'Normalized successfully';
    case 'invalid': return 'Normalization needs attention';
    case 'unknown': return 'Normalization has not completed';
  }
};

const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

export const bundleSummaryFor = (
  capabilities: Pick<WorkbenchCapabilities, 'counts' | 'pages'>,
): BundleSummary => {
  const { counts, pages } = capabilities;
  const capabilityLabels = Object.freeze([
    ...(counts.skills === 0 ? [] : [counted(counts.skills, 'Skill')]),
    ...(counts.hooks === 0 ? [] : [counted(counts.hooks, 'Hook')]),
    ...(counts.scripts === 0 ? [] : [counted(counts.scripts, 'script')]),
    ...(counts.mcpServers === 0 ? [] : [counted(counts.mcpServers, 'MCP server')]),
    ...(counts.evalSuites === 0 ? [] : [counted(counts.evalSuites, 'Eval suite')]),
    counted(counts.targets, 'generated target'),
  ]);
  const preferred: readonly WorkbenchPage[] = ['skills', 'hooks', 'playground', 'mcp', 'evals', 'artifacts'];
  return Object.freeze({
    capabilityLabels,
    nextPages: Object.freeze(preferred.filter((page) => pages.has(page)).slice(0, 3)),
    targetCount: counts.targets,
  });
};

const buildDiagnostics = (status: ProjectStatus): readonly Diagnostic[] =>
  'lastAttempt' in status.build && status.build.lastAttempt !== undefined
    ? status.build.lastAttempt.diagnostics
    : [];

const uniqueDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
  const seen = new Set<string>();
  return Object.freeze(diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.code,
      diagnostic.generatedPath ?? '',
      diagnostic.message,
      diagnostic.severity,
      diagnostic.sourcePath ?? '',
      diagnostic.target ?? '',
    ].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
};

const epochFor = (status: ProjectStatus): OverviewEpoch => {
  if (status.artifact.state === 'missing') return { state: 'missing', summary: 'No successful build' };
  return {
    createdAt: status.artifact.activeEpoch.createdAt,
    id: status.artifact.activeEpoch.id,
    state: status.artifact.state,
    summary: status.artifact.state === 'active' ? 'Current build' : 'Last good build',
  };
};

const targetsFor = (status: ProjectStatus): readonly OverviewTarget[] => {
  if (status.artifact.state === 'missing') return [];
  const state: OverviewTarget['state'] = status.artifact.state === 'active' ? 'built' : 'last-good';
  return Object.freeze(Object.entries(status.artifact.activeEpoch.targetDigests)
    .map(([name, digest]) => ({ digest, name, state }))
    .sort((left, right) => left.name.localeCompare(right.name)));
};

const contractDiagnostics = (status: ProjectStatus): readonly Diagnostic[] =>
  status.hostAdoption?.contracts?.state === 'failed' ? status.hostAdoption.contracts.diagnostics : [];

const contractViolationCount = (failures: readonly DevContractFailure[]): number =>
  failures.reduce((count, failure) => count + failure.checks.length, 0);

/**
 * A failed contract gate is a host-facing condition, not a build failure: the
 * artifact published, but live hosts and development installs kept the last
 * passing epoch. The summary names both epochs so the divergence is visible.
 */
const hostAdoptionFor = (status: ProjectStatus): OverviewHostAdoption | undefined => {
  const adoption = status.hostAdoption;
  if (adoption === undefined) return undefined;
  const epoch = activeEpochFor(status);
  const failures = adoption.contracts?.failures ?? [];
  const shared = {
    ...(adoption.adoptedEpochId === undefined ? {} : { adoptedEpochId: adoption.adoptedEpochId }),
    failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure, checks: Object.freeze([...failure.checks]) }))),
    ...(adoption.contracts === undefined ? {} : { gateSummary: adoption.contracts.summary }),
    mode: adoption.mode,
  };
  if (adoption.mode === 'direct') {
    return Object.freeze({
      ...shared,
      state: 'direct',
      summary: adoption.adoptedEpochId === undefined
        ? 'Hosts adopt each published build directly; none has been published yet'
        : 'Hosts serve the published build directly',
    });
  }
  if (adoption.contracts === undefined) {
    return Object.freeze({ ...shared, state: 'pending', summary: 'Contract matrix has not settled for a published build yet' });
  }
  if (adoption.contracts.state === 'passed') {
    return Object.freeze({
      ...shared,
      state: 'passed',
      summary: adoption.contracts.epochId === epoch?.id
        ? 'Contract matrix passed; hosts serve the current build'
        : `Contract matrix passed for build ${adoption.contracts.epochId}`,
    });
  }
  const violations = contractViolationCount(failures);
  const held = adoption.adoptedEpochId === undefined
    ? 'no build is served to hosts'
    : `hosts keep build ${adoption.adoptedEpochId}`;
  return Object.freeze({
    ...shared,
    state: 'failed',
    summary: violations === 0
      ? `Contract matrix could not complete for build ${adoption.contracts.epochId}; ${held}`
      : `Contract matrix failed for build ${adoption.contracts.epochId} with ${counted(violations, 'violation')}; ${held}`,
  });
};

const nextActionFor = (
  status: ProjectStatus,
  diagnostics: readonly Diagnostic[],
  hostAdoption: OverviewHostAdoption | undefined,
): OverviewNextAction => {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  if (hostAdoption?.state === 'failed' && errors > 0) {
    return { label: 'Rebuild', summary: `Resolve ${errors} ${errors === 1 ? 'error' : 'errors'}, then rebuild; hosts keep the last passing build` };
  }
  if (errors > 0) return { label: 'Rebuild', summary: `Resolve ${errors} ${errors === 1 ? 'error' : 'errors'}, then rebuild` };
  if (status.artifact.state === 'missing') return { label: 'Rebuild', summary: 'Create the first successful build' };
  if (status.artifact.state === 'stale') return { label: 'Rebuild', summary: 'Rebuild the latest normalized source' };
  return { label: 'Rebuild', summary: 'The current build matches your source' };
};

export const overviewFor = (status: ProjectStatus, changedFiles: readonly string[] = []): OverviewModel => {
  const diagnostics = uniqueDiagnostics([
    ...status.source.diagnostics,
    ...buildDiagnostics(status),
    ...contractDiagnostics(status),
  ]);
  const hostAdoption = hostAdoptionFor(status);
  return Object.freeze({
    changedFiles: Object.freeze([...changedFiles]),
    diagnostics,
    epoch: Object.freeze(epochFor(status)),
    ...(hostAdoption === undefined ? {} : { hostAdoption }),
    nextAction: Object.freeze(nextActionFor(status, diagnostics, hostAdoption)),
    normalization: Object.freeze({
      label: sourceLabel(status.source.state),
      ...(status.source.revision === undefined ? {} : { revision: status.source.revision }),
      state: status.source.state,
    }),
    targets: targetsFor(status),
  });
};
