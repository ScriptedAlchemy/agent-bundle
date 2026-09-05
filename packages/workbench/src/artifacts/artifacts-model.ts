import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  ArtifactEpochDiff,
  ArtifactInspection,
  ArtifactInspectionDirectoryNode,
  ArtifactInspectionFile,
  ArtifactInspectionFileNode,
  ArtifactInspectionProjection,
  ArtifactInspectionProvenance,
  ArtifactInspectionRuntime,
  ArtifactInspectionSourceInput,
  ArtifactInspectionTreeNode,
} from '../../../agent-bundle/src/contracts/artifacts.ts';
import { deepFreeze } from '../freeze.ts';


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
  readonly kind: 'config' | 'event-route';
  readonly label: string;
  readonly path: string;
  readonly sha256: string;
  readonly target: string;
  readonly timeout?: number;
}

export interface ArtifactMcpServerRow {
  readonly entryPaths: readonly string[];
  readonly key: string;
  readonly kind: 'command' | 'compiled' | 'remote';
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

export interface ArtifactBinRow {
  readonly hosts: readonly string[];
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly worker?: string;
}

export interface ArtifactRuntimeView {
  readonly bins: readonly ArtifactBinRow[];
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

export interface ArtifactProjectionOption {
  readonly host: string;
  readonly key: string;
  readonly label: string;
}

export interface ArtifactViewOptions {
  readonly diagnostics: readonly Diagnostic[];
  readonly diff: ArtifactEpochDiff | undefined;
  readonly epochId: string | undefined;
  readonly inspection: ArtifactInspection | undefined;
  readonly selectedProjection: string | undefined;
}

export interface ArtifactView {
  readonly diagnostics: readonly Diagnostic[];
  readonly diff: ArtifactDiffView | undefined;
  readonly epochId: string | undefined;
  readonly bins: readonly ArtifactBinRow[];
  readonly executables: readonly ArtifactExecutableRow[];
  readonly hooks: readonly ArtifactHookRow[];
  readonly identity: readonly ArtifactDetailRow[];
  readonly mcpServers: readonly ArtifactMcpServerRow[];
  readonly projection: readonly ArtifactDetailRow[];
  readonly projections: readonly ArtifactProjectionOption[];
  readonly provenance: readonly ArtifactProvenanceRow[];
  readonly selected: ArtifactProjectionOption | undefined;
  readonly state: ArtifactViewState;
  readonly summary: string;
  readonly tree: readonly ArtifactTreeRow[];
}

const noDiagnostics: readonly Diagnostic[] = Object.freeze([]);

const noBins: readonly ArtifactBinRow[] = Object.freeze([]);

const noExecutables: readonly ArtifactExecutableRow[] = Object.freeze([]);

const noHooks: readonly ArtifactHookRow[] = Object.freeze([]);

const noMcpServers: readonly ArtifactMcpServerRow[] = Object.freeze([]);

const noProvenance: readonly ArtifactProvenanceRow[] = Object.freeze([]);

const noRows: readonly ArtifactDetailRow[] = Object.freeze([]);

const noProjections: readonly ArtifactProjectionOption[] = Object.freeze([]);

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

export const artifactTreeRowsFor = (projection: ArtifactInspectionProjection): readonly ArtifactTreeRow[] =>
  Object.freeze(treeRows(projection.tree, 0));

export const artifactProjectionOptionsFor = (
  projections: readonly ArtifactInspectionProjection[],
): readonly ArtifactProjectionOption[] => deepFreeze(
  projections
    .map((projection): ArtifactProjectionOption => ({
      host: projection.host,
      key: projection.host,
      label: projection.host,
    }))
    .sort((left, right) => left.key.localeCompare(right.key)),
);

export const artifactProjectionRowsFor = (
  projection: ArtifactInspectionProjection,
): readonly ArtifactDetailRow[] => Object.freeze([
  row('Host', projection.host),
  ...(projection.documents.plugin === undefined ? [] : [row('Plugin document', projection.documents.plugin)]),
  ...(projection.documents.marketplace === undefined ? [] : [row('Marketplace document', projection.documents.marketplace)]),
  ...(projection.marketplace === undefined ? [] : [row('Marketplace', projection.marketplace)]),
]);

export const artifactEpochIdentityRowsFor = (inspection: ArtifactInspection): readonly ArtifactDetailRow[] =>
  Object.freeze([
    row('Build ID', inspection.epochId),
    row('Project revision', inspection.project.revision),
    row('Config digest', inspection.project.configDigest),
    row('Model digest', inspection.project.modelDigest),
    row('Config path', inspection.project.configPath),
    row('Emitted files', String(inspection.files.length)),
  ]);

export const artifactRuntimeViewFor = (runtime: ArtifactInspectionRuntime): ArtifactRuntimeView => deepFreeze({
  bins: runtime.bins
    .map((bin): ArtifactBinRow => ({
      hosts: bin.hosts,
      key: bin.name,
      name: bin.name,
      path: bin.file.path,
      ...(bin.worker === undefined ? {} : { worker: bin.worker.path }),
    }))
    .sort((left, right) => left.key.localeCompare(right.key)),
  executables: runtime.executables
      .map((file): ArtifactExecutableRow => Object.freeze({
        bytes: file.bytes,
        key: file.path,
        kind: file.kind,
        ...modeFields(file),
        path: file.path,
        sha256: file.sha256,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  hooks: runtime.hooks
      .map((hook): ArtifactHookRow => Object.freeze({
        bytes: hook.file.bytes,
        event: hook.event,
        key: `${hook.target}/${hook.id}`,
        kind: hook.kind,
        label: `${hook.name} · ${hook.event} · ${hook.target}`,
        path: hook.path,
        sha256: hook.file.sha256,
        target: hook.target,
        ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  mcpServers: runtime.mcpServers
      .map((server): ArtifactMcpServerRow => Object.freeze({
        entryPaths: Object.freeze([...server.entryPaths].sort((left, right) => left.localeCompare(right))),
        key: `${server.target}/${server.name}`,
        kind: server.kind,
        label: `${server.name} · ${server.kind} · ${server.target}`,
        manifestPath: server.manifestPath,
        target: server.target,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
});

export const artifactProvenanceRowsFor = (
  provenance: readonly ArtifactInspectionProvenance[],
): readonly ArtifactProvenanceRow[] => deepFreeze(
  provenance
    .map((entry): ArtifactProvenanceRow => ({
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
  const rows = deepFreeze(
    entries
      .map((entry): ArtifactDiffRow => ({
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
    return `${inspection.application.name}@${inspection.application.version} build ${inspection.epochId} contains ` +
      `${inspection.files.length} files across ${inspection.projections.length} projections.`;
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
  const projections = inspection === undefined ? noProjections : artifactProjectionOptionsFor(inspection.projections);
  const selected = projections.find((option) => option.host === options.selectedProjection) ?? projections[0];
  const runtime = inspection === undefined ? undefined : artifactRuntimeViewFor(inspection.runtime);
  const projection = inspection?.projections.find((entry) => entry.host === selected?.host);
  return Object.freeze({
    bins: runtime?.bins ?? noBins,
    diagnostics: options.diagnostics.length === 0 ? noDiagnostics : Object.freeze([...options.diagnostics]),
    diff: options.diff === undefined ? undefined : artifactDiffViewFor(options.diff),
    epochId: options.epochId,
    executables: runtime?.executables ?? noExecutables,
    hooks: runtime?.hooks ?? noHooks,
    identity: inspection === undefined ? noRows : artifactEpochIdentityRowsFor(inspection),
    mcpServers: runtime?.mcpServers ?? noMcpServers,
    projection: projection === undefined ? noRows : artifactProjectionRowsFor(projection),
    projections,
    provenance: inspection === undefined ? noProvenance : artifactProvenanceRowsFor(inspection.provenance),
    selected,
    state,
    summary: summaryFor(state, inspection),
    tree: projection === undefined ? noTree : artifactTreeRowsFor(projection),
  });
};
