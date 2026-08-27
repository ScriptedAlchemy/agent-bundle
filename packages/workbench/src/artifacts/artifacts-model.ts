import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  ArtifactEpochDiff,
  ArtifactInspection,
  ArtifactInspectionDirectoryNode,
  ArtifactInspectionFile,
  ArtifactInspectionFileNode,
  ArtifactInspectionProvenance,
  ArtifactInspectionRuntime,
  ArtifactInspectionSourceInput,
  ArtifactInspectionTarget,
  ArtifactInspectionTreeNode,
} from '../../../agent-bundle/src/contracts/artifacts.ts';

export type ArtifactDiffChange = 'added' | 'changed' | 'removed' | 'unchanged';

export type ArtifactViewState = 'diagnostics' | 'empty' | 'no-epoch' | 'ready';

export interface ArtifactDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface ArtifactTreeRow {
  readonly bytes?: number;
  readonly depth: number;
  readonly entry: 'directory' | 'file';
  readonly key: string;
  readonly kind?: ArtifactInspectionFile['kind'];
  readonly mode?: string;
  readonly name: string;
  readonly path: string;
  readonly sha256?: string;
}

export interface ArtifactHookRow {
  readonly bytes: number;
  readonly event: string;
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly sha256: string;
  readonly target: string;
  readonly timeout?: number;
}

export interface ArtifactMcpServerRow {
  readonly entryPaths: readonly string[];
  readonly key: string;
  readonly kind: 'stdio' | 'streamable-http';
  readonly label: string;
  readonly manifestPath: string;
  readonly target: string;
}

export interface ArtifactExecutableRow {
  readonly bytes: number;
  readonly key: string;
  readonly kind: ArtifactInspectionFile['kind'];
  readonly mode?: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ArtifactRuntimeView {
  readonly executables: readonly ArtifactExecutableRow[];
  readonly hooks: readonly ArtifactHookRow[];
  readonly mcpServers: readonly ArtifactMcpServerRow[];
}

export interface ArtifactProvenanceRow {
  readonly key: string;
  readonly outputPath: string;
  readonly sourceInputs: readonly ArtifactInspectionSourceInput[];
}

export interface ArtifactDiffRow {
  readonly afterBytes?: number;
  readonly afterSha256?: string;
  readonly beforeBytes?: number;
  readonly beforeSha256?: string;
  readonly change: ArtifactDiffChange;
  readonly key: string;
  readonly path: string;
}

export interface ArtifactDiffGroup {
  readonly change: ArtifactDiffChange;
  readonly count: number;
  readonly label: string;
  readonly rows: readonly ArtifactDiffRow[];
}

export interface ArtifactDiffView {
  readonly baseEpochId: string;
  readonly candidateEpochId: string;
  readonly groups: readonly ArtifactDiffGroup[];
  readonly summary: string;
}

export interface ArtifactTargetOption {
  readonly key: string;
  readonly label: string;
  readonly name: string;
}

export interface ArtifactViewOptions {
  readonly diagnostics: readonly Diagnostic[];
  readonly diff: ArtifactEpochDiff | undefined;
  readonly epochId: string | undefined;
  readonly inspection: ArtifactInspection | undefined;
  readonly selectedTarget: string | undefined;
}

export interface ArtifactView {
  readonly diagnostics: readonly Diagnostic[];
  readonly diff: ArtifactDiffView | undefined;
  readonly epochId: string | undefined;
  readonly executables: readonly ArtifactExecutableRow[];
  readonly hooks: readonly ArtifactHookRow[];
  readonly identity: readonly ArtifactDetailRow[];
  readonly mcpServers: readonly ArtifactMcpServerRow[];
  readonly provenance: readonly ArtifactProvenanceRow[];
  readonly selected: ArtifactTargetOption | undefined;
  readonly state: ArtifactViewState;
  readonly summary: string;
  readonly targets: readonly ArtifactTargetOption[];
  readonly tree: readonly ArtifactTreeRow[];
}

const noDiagnostics: readonly Diagnostic[] = Object.freeze([]);

const noExecutables: readonly ArtifactExecutableRow[] = Object.freeze([]);

const noHooks: readonly ArtifactHookRow[] = Object.freeze([]);

const noMcpServers: readonly ArtifactMcpServerRow[] = Object.freeze([]);

const noProvenance: readonly ArtifactProvenanceRow[] = Object.freeze([]);

const noRows: readonly ArtifactDetailRow[] = Object.freeze([]);

const noTargets: readonly ArtifactTargetOption[] = Object.freeze([]);

const noTree: readonly ArtifactTreeRow[] = Object.freeze([]);

const row = (label: string, value: string): ArtifactDetailRow => Object.freeze({ label, value });

/** Manifested modes are POSIX permission bits, so they read as the octal the host applies. */
export const artifactModeLabel = (mode: number): string => mode.toString(8).padStart(4, '0');

const modeFields = (file: ArtifactInspectionFile): Readonly<{ readonly mode?: string }> =>
  file.mode === undefined ? {} : { mode: artifactModeLabel(file.mode) };

/** Directories precede files at each level so a flattened tree still reads as a tree. */
const orderedChildren = (children: readonly ArtifactInspectionTreeNode[]): readonly ArtifactInspectionTreeNode[] =>
  [...children].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

const fileRow = (node: ArtifactInspectionFileNode, depth: number): ArtifactTreeRow => Object.freeze({
  bytes: node.file.bytes,
  depth,
  entry: 'file',
  key: node.path,
  kind: node.file.kind,
  ...modeFields(node.file),
  name: node.name,
  path: node.path,
  sha256: node.file.sha256,
});

const directoryRow = (node: ArtifactInspectionDirectoryNode, depth: number): ArtifactTreeRow => Object.freeze({
  depth,
  entry: 'directory',
  key: node.path,
  name: node.name,
  path: node.path,
});

const treeRows = (node: ArtifactInspectionTreeNode, depth: number): readonly ArtifactTreeRow[] => {
  if (node.kind === 'file') return [fileRow(node, depth)];
  return [
    directoryRow(node, depth),
    ...orderedChildren(node.children).flatMap((child) => treeRows(child, depth + 1)),
  ];
};

export const artifactTreeRowsFor = (target: ArtifactInspectionTarget): readonly ArtifactTreeRow[] =>
  Object.freeze(treeRows(target.tree, 0));

export const artifactTargetOptionsFor = (
  targets: readonly ArtifactInspectionTarget[],
): readonly ArtifactTargetOption[] => Object.freeze(
  targets
    .map((target): ArtifactTargetOption => Object.freeze({ key: target.name, label: target.name, name: target.name }))
    .sort((left, right) => left.key.localeCompare(right.key)),
);

export const artifactEpochIdentityRowsFor = (inspection: ArtifactInspection): readonly ArtifactDetailRow[] =>
  Object.freeze([
    row('Build ID', inspection.epochId),
    row('Project revision', inspection.project.revision),
    row('Config digest', inspection.project.configDigest),
    row('Model digest', inspection.project.modelDigest),
    row('Config path', inspection.project.configPath),
    row('Emitted files', String(inspection.files.length)),
  ]);

export const artifactRuntimeViewFor = (runtime: ArtifactInspectionRuntime): ArtifactRuntimeView => Object.freeze({
  executables: Object.freeze(
    runtime.executables
      .map((file): ArtifactExecutableRow => Object.freeze({
        bytes: file.bytes,
        key: file.path,
        kind: file.kind,
        ...modeFields(file),
        path: file.path,
        sha256: file.sha256,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  ),
  hooks: Object.freeze(
    runtime.hooks
      .map((hook): ArtifactHookRow => Object.freeze({
        bytes: hook.file.bytes,
        event: hook.event,
        key: `${hook.target}/${hook.id}`,
        label: `${hook.name} · ${hook.event} · ${hook.target}`,
        path: hook.path,
        sha256: hook.file.sha256,
        target: hook.target,
        ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  ),
  mcpServers: Object.freeze(
    runtime.mcpServers
      .map((server): ArtifactMcpServerRow => Object.freeze({
        entryPaths: Object.freeze([...server.entryPaths].sort((left, right) => left.localeCompare(right))),
        key: `${server.target}/${server.name}`,
        kind: server.kind,
        label: `${server.name} · ${server.kind} · ${server.target}`,
        manifestPath: server.manifestPath,
        target: server.target,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  ),
});

export const artifactProvenanceRowsFor = (
  provenance: readonly ArtifactInspectionProvenance[],
): readonly ArtifactProvenanceRow[] => Object.freeze(
  provenance
    .map((entry): ArtifactProvenanceRow => Object.freeze({
      key: entry.outputPath,
      outputPath: entry.outputPath,
      sourceInputs: Object.freeze(
        [...entry.sourceInputs].sort((left, right) => left.path.localeCompare(right.path)),
      ),
    }))
    .sort((left, right) => left.key.localeCompare(right.key)),
);

const diffGroup = (
  change: ArtifactDiffChange,
  label: string,
  entries: readonly Readonly<{
    readonly after?: ArtifactInspectionFile;
    readonly before?: ArtifactInspectionFile;
    readonly path: string;
  }>[],
): ArtifactDiffGroup => {
  const rows = Object.freeze(
    entries
      .map((entry): ArtifactDiffRow => Object.freeze({
        ...(entry.after === undefined ? {} : { afterBytes: entry.after.bytes, afterSha256: entry.after.sha256 }),
        ...(entry.before === undefined ? {} : { beforeBytes: entry.before.bytes, beforeSha256: entry.before.sha256 }),
        change,
        key: `${change}:${entry.path}`,
        path: entry.path,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
  return Object.freeze({ change, count: rows.length, label, rows });
};

/** Groups read added, removed, changed, unchanged: what appeared, what vanished, then what merely moved. */
export const artifactDiffViewFor = (diff: ArtifactEpochDiff): ArtifactDiffView => Object.freeze({
  baseEpochId: diff.baseEpochId,
  candidateEpochId: diff.candidateEpochId,
  groups: Object.freeze([
    diffGroup('added', 'Added', diff.added),
    diffGroup('removed', 'Removed', diff.removed),
    diffGroup('changed', 'Changed', diff.changed),
    diffGroup('unchanged', 'Unchanged', diff.unchanged),
  ]),
  summary: `Build ${diff.candidateEpochId} compared with ${diff.baseEpochId}: ` +
    `${diff.added.length} added, ${diff.removed.length} removed, ` +
    `${diff.changed.length} changed, ${diff.unchanged.length} unchanged.`,
});

const summaryFor = (state: ArtifactViewState, inspection: ArtifactInspection | undefined): string => {
  if (state === 'no-epoch') return 'No successful build is available, so there is no generated output to inspect.';
  if (state === 'diagnostics') return 'This build failed validation, so its generated output cannot be inspected.';
  if (state === 'ready' && inspection !== undefined) {
    return `Build ${inspection.epochId} contains ${inspection.files.length} files ` +
      `across ${inspection.targets.length} targets.`;
  }
  return 'Generated output has not been loaded for this build yet.';
};

/** Derives every Artifacts page section from one epoch inspection, its diagnostics, and an optional diff. */
export const artifactViewFor = (options: ArtifactViewOptions): ArtifactView => {
  const inspection = options.inspection;
  const state: ArtifactViewState = options.epochId === undefined ? 'no-epoch'
    : options.diagnostics.length > 0 ? 'diagnostics'
      : inspection === undefined ? 'empty'
        : 'ready';
  const targets = inspection === undefined ? noTargets : artifactTargetOptionsFor(inspection.targets);
  const selected = targets.find((option) => option.name === options.selectedTarget) ?? targets[0];
  const runtime = inspection === undefined ? undefined : artifactRuntimeViewFor(inspection.runtime);
  const target = inspection?.targets.find((entry) => entry.name === selected?.name);
  return Object.freeze({
    diagnostics: options.diagnostics.length === 0 ? noDiagnostics : Object.freeze([...options.diagnostics]),
    diff: options.diff === undefined ? undefined : artifactDiffViewFor(options.diff),
    epochId: options.epochId,
    executables: runtime?.executables ?? noExecutables,
    hooks: runtime?.hooks ?? noHooks,
    identity: inspection === undefined ? noRows : artifactEpochIdentityRowsFor(inspection),
    mcpServers: runtime?.mcpServers ?? noMcpServers,
    provenance: inspection === undefined ? noProvenance : artifactProvenanceRowsFor(inspection.provenance),
    selected,
    state,
    summary: summaryFor(state, inspection),
    targets,
    tree: target === undefined ? noTree : artifactTreeRowsFor(target),
  });
};
