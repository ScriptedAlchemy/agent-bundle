import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type { ArtifactEpoch, ArtifactState, ProjectStatus, SourceState } from '../../agent-bundle/src/dev/types.ts';

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

export interface OverviewModel {
  readonly changedFiles: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly epoch: OverviewEpoch;
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
  if (status.artifact.state === 'missing') return { state: 'missing', summary: 'No validated artifact epoch' };
  return {
    createdAt: status.artifact.activeEpoch.createdAt,
    id: status.artifact.activeEpoch.id,
    state: status.artifact.state,
    summary: status.artifact.state === 'active' ? 'Current artifact epoch' : 'Last good artifact epoch',
  };
};

const targetsFor = (status: ProjectStatus): readonly OverviewTarget[] => {
  if (status.artifact.state === 'missing') return [];
  const state: OverviewTarget['state'] = status.artifact.state === 'active' ? 'built' : 'last-good';
  return Object.freeze(Object.entries(status.artifact.activeEpoch.targetDigests)
    .map(([name, digest]) => ({ digest, name, state }))
    .sort((left, right) => left.name.localeCompare(right.name)));
};

const nextActionFor = (status: ProjectStatus, diagnostics: readonly Diagnostic[]): OverviewNextAction => {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  if (errors > 0) return { label: 'Rebuild', summary: `Resolve ${errors} ${errors === 1 ? 'error' : 'errors'}, then rebuild` };
  if (status.artifact.state === 'missing') return { label: 'Rebuild', summary: 'Build the first artifact epoch' };
  if (status.artifact.state === 'stale') return { label: 'Rebuild', summary: 'Rebuild the latest normalized source' };
  return { label: 'Rebuild', summary: 'Artifact epoch is current' };
};

export const overviewFor = (status: ProjectStatus, changedFiles: readonly string[] = []): OverviewModel => {
  const diagnostics = uniqueDiagnostics([...status.source.diagnostics, ...buildDiagnostics(status)]);
  return Object.freeze({
    changedFiles: Object.freeze([...changedFiles]),
    diagnostics,
    epoch: Object.freeze(epochFor(status)),
    nextAction: Object.freeze(nextActionFor(status, diagnostics)),
    normalization: Object.freeze({
      label: sourceLabel(status.source.state),
      ...(status.source.revision === undefined ? {} : { revision: status.source.revision }),
      state: status.source.state,
    }),
    targets: targetsFor(status),
  });
};
