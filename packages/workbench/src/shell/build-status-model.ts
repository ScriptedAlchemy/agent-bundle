/**
 * The shell's read of `ProjectStatus` (#600): build state and epoch for the
 * header, the aggregated diagnostics behind the Problems badge, and the
 * Problems list itself. Absorbs the status pieces of the deleted Overview
 * page; the page-recommendation pieces died with it.
 */
import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  ArtifactEpoch,
  ArtifactState,
  BuildStatus,
  DevContractFailure,
  HostAdoptionStatus,
  ProjectStatus,
  SourceState,
} from '../../../agent-bundle/src/contracts/project.ts';
import { applicationLeaves, type ApplicationTree } from '../application/application-tree-model.ts';
import type { RouteCatalogState } from '../routes/routes-model.ts';
import { type ApplicationNodeRef, applicationNodeRefForRouteId } from './workbench-location.ts';

export type DiagnosticSeverity = Diagnostic['severity'];
export type BuildState = BuildStatus['state'];

/** The active (or last-good) artifact epoch, or undefined when none was published. */
export const activeEpochFor = (status: ProjectStatus): ArtifactEpoch | undefined =>
  status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;

export interface BuildStatusSource {
  readonly label: string;
  readonly revision?: string;
  readonly state: SourceState;
}

export interface BuildStatusEpoch {
  readonly createdAt?: string;
  readonly id?: string;
  readonly state: ArtifactState;
  readonly summary: string;
}

export interface BuildStatusTarget {
  readonly digest: string;
  readonly name: string;
  readonly state: 'built' | 'last-good';
}

export interface BuildStatusNextAction {
  readonly label: 'Rebuild';
  readonly summary: string;
}

export type BuildStatusHostAdoptionState = 'direct' | 'failed' | 'passed' | 'pending';

/** What live host connections and development installs serve, and why. */
export interface BuildStatusHostAdoption {
  readonly adoptedEpochId?: string;
  readonly failures: readonly DevContractFailure[];
  readonly gateSummary?: string;
  readonly mode: HostAdoptionStatus['mode'];
  readonly state: BuildStatusHostAdoptionState;
  readonly summary: string;
}

export interface BuildStatusModel {
  readonly build: BuildState;
  /** Source, latest-build, and contract-gate diagnostics, deduplicated. */
  readonly diagnostics: readonly Diagnostic[];
  readonly epoch: BuildStatusEpoch;
  /** Error-severity diagnostics; the header badge's count before route-catalog and host problems are added. */
  readonly errorCount: number;
  readonly hostAdoption?: BuildStatusHostAdoption;
  readonly nextAction: BuildStatusNextAction;
  readonly source: BuildStatusSource;
  readonly targets: readonly BuildStatusTarget[];
}

const sourceLabel = (state: SourceState): string => {
  switch (state) {
    case 'ready': return 'Normalized successfully';
    case 'invalid': return 'Normalization needs attention';
    case 'unknown': return 'Normalization has not completed';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

const buildDiagnostics = (status: ProjectStatus): readonly Diagnostic[] =>
  'lastAttempt' in status.build && status.build.lastAttempt !== undefined
    ? status.build.lastAttempt.diagnostics
    : [];

const diagnosticKey = (diagnostic: Diagnostic): string => [
  diagnostic.code,
  diagnostic.generatedPath ?? '',
  diagnostic.message,
  diagnostic.severity,
  diagnostic.sourcePath ?? '',
  diagnostic.target ?? '',
].join('\u0000');

const uniqueDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
  const seen = new Set<string>();
  return Object.freeze(diagnostics.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
};

const epochFor = (status: ProjectStatus): BuildStatusEpoch => {
  if (status.artifact.state === 'missing') return Object.freeze({ state: 'missing', summary: 'No successful build' });
  return Object.freeze({
    createdAt: status.artifact.activeEpoch.createdAt,
    id: status.artifact.activeEpoch.id,
    state: status.artifact.state,
    summary: status.artifact.state === 'active' ? 'Current build' : 'Last good build',
  });
};

const targetsFor = (status: ProjectStatus): readonly BuildStatusTarget[] => {
  if (status.artifact.state === 'missing') return Object.freeze([]);
  const state: BuildStatusTarget['state'] = status.artifact.state === 'active' ? 'built' : 'last-good';
  return Object.freeze(Object.entries(status.artifact.activeEpoch.targetDigests)
    .map(([name, digest]) => Object.freeze({ digest, name, state }))
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
const hostAdoptionFor = (status: ProjectStatus): BuildStatusHostAdoption | undefined => {
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
  errors: number,
  hostAdoption: BuildStatusHostAdoption | undefined,
): BuildStatusNextAction => {
  if (hostAdoption?.state === 'failed' && errors > 0) {
    return { label: 'Rebuild', summary: `Resolve ${counted(errors, 'error')}, then rebuild; hosts keep the last passing build` };
  }
  if (errors > 0) return { label: 'Rebuild', summary: `Resolve ${counted(errors, 'error')}, then rebuild` };
  if (status.artifact.state === 'missing') return { label: 'Rebuild', summary: 'Create the first successful build' };
  if (status.artifact.state === 'stale') return { label: 'Rebuild', summary: 'Rebuild the latest normalized source' };
  return { label: 'Rebuild', summary: 'The current build matches your source' };
};

export const buildStatusFor = (status: ProjectStatus): BuildStatusModel => {
  const diagnostics = uniqueDiagnostics([
    ...status.source.diagnostics,
    ...buildDiagnostics(status),
    ...contractDiagnostics(status),
  ]);
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const hostAdoption = hostAdoptionFor(status);
  return Object.freeze({
    build: status.build.state,
    diagnostics,
    epoch: epochFor(status),
    errorCount,
    ...(hostAdoption === undefined ? {} : { hostAdoption }),
    nextAction: Object.freeze(nextActionFor(status, errorCount, hostAdoption)),
    source: Object.freeze({
      label: sourceLabel(status.source.state),
      ...(status.source.revision === undefined ? {} : { revision: status.source.revision }),
      state: status.source.state,
    }),
    targets: targetsFor(status),
  });
};

/** Which subsystem reported a problem; the Problems list groups and labels by it. */
export type ProblemSource = 'build' | 'contract-gate' | 'host-attach' | 'route-catalog' | 'runtime' | 'source';

export interface Problem {
  /** The diagnostic code; absent for conditions the shell derives (catalog freshness, contract failures, host attach, runtime bootstrap). */
  readonly code?: string;
  /** Source path, generated path, or target the diagnostic names; the list's "Source" column. */
  readonly location?: string;
  readonly message: string;
  /** The application leaf the problem names, when it names one; the row deep-links to it. */
  readonly node?: ApplicationNodeRef;
  readonly recovery?: string;
  /** True when a rebuild is the documented repair (build, source, stale catalog); the Repair action is offered. */
  readonly repairable: boolean;
  readonly severity: DiagnosticSeverity;
  readonly source: ProblemSource;
}

/** The compiled route catalog's freshness as the capability loader reports it. */
export interface ProblemsCatalog {
  readonly diagnostics: readonly Diagnostic[];
  readonly message?: string;
  readonly state: RouteCatalogState;
}

export interface ProblemsInput {
  readonly catalog?: ProblemsCatalog;
  /** The devRuntime bootstrap failure, when the project declares a runtime provider that could not be reached. */
  readonly runtimeDiagnostic?: string;
  readonly status: ProjectStatus;
  readonly tree?: ApplicationTree;
}

/** The wording the Routes page used for a stale catalog; browser acceptance asserts it verbatim. */
export const staleCatalogMessage = 'The dev server has compiled newer source than the published build. Rebuild to publish these routes.';

const severityRank: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({ error: 0, info: 2, warning: 1 });

/** A node for a diagnostic that names a compiled route: by route id in `target`, else by its source module. */
const nodeForDiagnostic = (diagnostic: Diagnostic, tree: ApplicationTree | undefined): ApplicationNodeRef | undefined => {
  const byTarget = diagnostic.target === undefined ? undefined : applicationNodeRefForRouteId(diagnostic.target);
  if (byTarget !== undefined) return byTarget;
  if (tree === undefined || diagnostic.sourcePath === undefined) return undefined;
  return applicationLeaves(tree).find((leaf) => leaf.source === diagnostic.sourcePath)?.ref;
};

const problemFromDiagnostic = (
  diagnostic: Diagnostic,
  source: ProblemSource,
  repairable: boolean,
  tree: ApplicationTree | undefined,
): Problem => {
  const location = diagnostic.sourcePath ?? diagnostic.generatedPath ?? diagnostic.target;
  const node = nodeForDiagnostic(diagnostic, tree);
  return Object.freeze({
    code: diagnostic.code,
    ...(location === undefined ? {} : { location }),
    message: diagnostic.message,
    ...(node === undefined ? {} : { node }),
    ...(diagnostic.recovery === undefined ? {} : { recovery: diagnostic.recovery }),
    repairable,
    severity: diagnostic.severity,
    source,
  });
};

const catalogProblems = (catalog: ProblemsCatalog | undefined, tree: ApplicationTree | undefined): readonly Problem[] => {
  if (catalog === undefined) return [];
  const problems: Problem[] = catalog.diagnostics.map((diagnostic) => problemFromDiagnostic(diagnostic, 'route-catalog', false, tree));
  switch (catalog.state) {
    case 'current':
      break;
    case 'stale':
      problems.push(Object.freeze({ message: staleCatalogMessage, repairable: true, severity: 'warning', source: 'route-catalog' }));
      break;
    case 'unavailable':
      problems.push(Object.freeze({
        message: catalog.message ?? 'The compiled route manifest could not be read.',
        repairable: true,
        severity: 'error',
        source: 'route-catalog',
      }));
      break;
    default: {
      const exhaustive: never = catalog.state;
      return exhaustive;
    }
  }
  return problems;
};

const hostProblems = (status: ProjectStatus, model: BuildStatusModel): readonly Problem[] => {
  const adoption = model.hostAdoption;
  if (adoption === undefined) return [];
  const problems: Problem[] = adoption.failures.map((failure) => {
    const node = applicationNodeRefForRouteId(failure.routeId);
    return Object.freeze({
      location: failure.routeId,
      message: `${failure.routeId} failed ${counted(failure.checks.length, 'contract check')}: ${failure.checks.join(', ')}`,
      ...(node === undefined ? {} : { node }),
      repairable: true,
      severity: 'error' as const,
      source: 'contract-gate' as const,
    });
  });
  const epoch = activeEpochFor(status);
  if (adoption.state === 'failed' || (epoch !== undefined && adoption.adoptedEpochId !== undefined && adoption.adoptedEpochId !== epoch.id)) {
    problems.push(Object.freeze({
      message: adoption.summary,
      repairable: adoption.state === 'failed',
      severity: adoption.state === 'failed' ? 'error' : 'warning',
      source: 'host-attach',
    }));
  }
  return problems;
};

/**
 * Every condition the shell reports as a problem, one list: source
 * normalization, the latest build attempt, the contract gate, route-catalog
 * freshness, host attach, and the runtime provider. Errors first, then
 * warnings, then infos; stable within a severity.
 */
export const problemsFor = ({ catalog, runtimeDiagnostic, status, tree }: ProblemsInput): readonly Problem[] => {
  const model = buildStatusFor(status);
  const contractCodes = new Set(contractDiagnostics(status).map(diagnosticKey));
  const sourceCodes = new Set(status.source.diagnostics.map(diagnosticKey));
  const problems: Problem[] = model.diagnostics.map((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const source: ProblemSource = contractCodes.has(key) ? 'contract-gate' : sourceCodes.has(key) ? 'source' : 'build';
    return problemFromDiagnostic(diagnostic, source, source !== 'contract-gate', tree);
  });
  problems.push(...catalogProblems(catalog, tree), ...hostProblems(status, model));
  if (runtimeDiagnostic !== undefined) {
    problems.push(Object.freeze({ message: runtimeDiagnostic, repairable: false, severity: 'error', source: 'runtime' }));
  }
  return Object.freeze(problems
    .map((problem, index) => ({ index, problem }))
    .sort((left, right) => severityRank[left.problem.severity] - severityRank[right.problem.severity] || left.index - right.index)
    .map(({ problem }) => problem));
};

/** The header badge count: error-severity problems. */
export const problemFailureCount = (problems: readonly Problem[]): number =>
  problems.filter((problem) => problem.severity === 'error').length;
