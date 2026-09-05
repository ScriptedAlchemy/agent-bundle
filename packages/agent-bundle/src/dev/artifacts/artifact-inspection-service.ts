import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import { artifactManifestName } from '../../build/emit.ts';
import type { ArtifactManifest } from '../../build/manifest.ts';
import {
  validateArtifactWithSnapshot,
  type ValidatedArtifactSnapshot,
} from '../../build/validate-artifact.ts';
import type { Diagnostic } from '../../core/diagnostics.ts';
import type { ProjectContext } from '../../core/project-context.ts';
import { EpochReference, EpochStore } from '../epoch-store.ts';
import { applicationExplorerFor } from './application-explorer.ts';
import { artifactManifestScriptExecutions } from './artifact-executables.ts';
import type {
  ArtifactEpochAddedFile,
  ArtifactEpochChangedFile,
  ArtifactEpochDiff,
  ArtifactEpochRemovedFile,
  ArtifactEpochUnchangedFile,
  ArtifactInspectionBin,
  ArtifactInspection,
  ArtifactInspectionDirectoryNode,
  ArtifactInspectionFile,
  ArtifactInspectionFileNode,
  ArtifactInspectionHook,
  ArtifactInspectionMcpServer,
  ArtifactInspectionProjection,
  ArtifactInspectionScript,
  ArtifactInspectionProvenance,
  ArtifactInspectionRuntime,
  ArtifactInspectionSourceInput,
  ArtifactInspectionTreeNode,
} from '../types.ts';
import { YieldableCodedError } from '../../effect/errors.ts';

export type ArtifactInspectionServiceErrorCode =
  | 'ARTIFACT_INSPECTION_INVALID'
  | 'ARTIFACT_INSPECTION_RELEASE_FAILED'
  | 'ARTIFACT_INSPECTION_RUNTIME_INVALID';

const inspectionDiagnostic = (
  code: string,
  message: string,
  generatedPath?: string,
  target?: string,
): Diagnostic => Object.freeze({
  code,
  ...(generatedPath === undefined ? {} : { generatedPath }),
  message,
  severity: 'error',
  ...(target === undefined ? {} : { target }),
});

const snapshotDiagnostic = (diagnostic: Diagnostic): Diagnostic => Object.freeze({
  code: diagnostic.code,
  ...(diagnostic.generatedPath === undefined ? {} : { generatedPath: diagnostic.generatedPath }),
  message: diagnostic.message,
  ...(diagnostic.recovery === undefined ? {} : { recovery: diagnostic.recovery }),
  severity: diagnostic.severity,
  ...(diagnostic.sourcePath === undefined ? {} : { sourcePath: diagnostic.sourcePath }),
  ...(diagnostic.target === undefined ? {} : { target: diagnostic.target }),
});

export class ArtifactInspectionServiceError extends YieldableCodedError<ArtifactInspectionServiceErrorCode> {
  readonly diagnostics: readonly Diagnostic[];

  constructor(code: ArtifactInspectionServiceErrorCode, message: string, diagnostics: readonly Diagnostic[]) {
    super('ArtifactInspectionServiceError', code, message);
    this.diagnostics = Object.freeze(diagnostics.map(snapshotDiagnostic));
  }
}

interface TreeBuildDirectory {
  readonly directories: Map<string, TreeBuildDirectory>;
  readonly files: Map<string, ArtifactInspectionFile>;
}

const comparePaths = (left: { readonly path: string }, right: { readonly path: string }): number =>
  left.path.localeCompare(right.path);

const sameSourceInputs = (
  left: readonly ArtifactInspectionSourceInput[],
  right: readonly ArtifactInspectionSourceInput[],
): boolean => left.length === right.length && left.every((input, index) => {
  const candidate = right[index];
  return candidate !== undefined && input.path === candidate.path;
});

const sameFile = (left: ArtifactInspectionFile, right: ArtifactInspectionFile): boolean =>
  left.bytes === right.bytes &&
  left.kind === right.kind &&
  left.mode === right.mode &&
  left.sha256 === right.sha256 &&
  sameSourceInputs(left.sourceInputs, right.sourceInputs);

const emptyTreeBuildDirectory = (): TreeBuildDirectory => ({
  directories: new Map(),
  files: new Map(),
});

const treeNode = (
  name: string,
  path: string,
  directory: TreeBuildDirectory,
): ArtifactInspectionDirectoryNode => {
  const children: ArtifactInspectionTreeNode[] = [
    ...[...directory.directories.entries()]
      .map(([directoryName, child]) => treeNode(directoryName, path === '.' ? directoryName : `${path}/${directoryName}`, child)),
    ...[...directory.files.entries()].map(([fileName, file]): ArtifactInspectionFileNode => Object.freeze({
      file,
      kind: 'file',
      name: fileName,
      path: file.path,
    })),
  ];
  children.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    children: Object.freeze(children),
    kind: 'directory',
    name,
    path,
  });
};

const inspectionError = (
  code: ArtifactInspectionServiceErrorCode,
  message: string,
  diagnostic: Diagnostic,
): ArtifactInspectionServiceError => new ArtifactInspectionServiceError(code, message, [diagnostic]);

export class ArtifactInspectionService {
  readonly #registry: TargetRegistry;
  readonly #store: EpochStore;

  constructor(store: EpochStore, registry: TargetRegistry = createDefaultRegistry()) {
    this.#store = store;
    this.#registry = registry;
  }

  async inspect(epochId: string): Promise<ArtifactInspection> {
    let reference: EpochReference | undefined;
    try {
      reference = await this.#store.acquireEpochReference(epochId);
      return await this.#inspectReference(epochId, reference);
    } finally {
      await this.#releaseReferences(reference === undefined ? [] : [reference]);
    }
  }

  async diff(baseEpochId: string, candidateEpochId: string): Promise<ArtifactEpochDiff> {
    let baseReference: EpochReference | undefined;
    let candidateReference: EpochReference | undefined;
    try {
      baseReference = await this.#store.acquireEpochReference(baseEpochId);
      candidateReference = await this.#store.acquireEpochReference(candidateEpochId);
      const [base, candidate] = await Promise.all([
        this.#inspectReference(baseEpochId, baseReference),
        this.#inspectReference(candidateEpochId, candidateReference),
      ]);
      return this.#diff(base, candidate);
    } finally {
      await this.#releaseReferences([baseReference, candidateReference].filter(
        (reference): reference is EpochReference => reference !== undefined,
      ));
    }
  }

  async #inspectReference(epochId: string, reference: EpochReference): Promise<ArtifactInspection> {
    const validated = await this.#validatedManifest(reference.root);
    const { manifest } = validated;
    const sourceInputs = new Map<string, ArtifactInspectionSourceInput>();
    for (const input of manifest.project.sourceInputs) {
      sourceInputs.set(input.path, Object.freeze({ path: input.path, sha256: input.sha256 }));
    }

    const files = Object.freeze(manifest.files
      .map((file) => this.#file(file, sourceInputs))
      .sort(comparePaths));
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const project = this.#project(manifest.project, sourceInputs);
    const runtime = this.#runtime(filesByPath, manifest, validated.runtime);

    return Object.freeze({
      application: applicationExplorerFor(manifest),
      epochId,
      files,
      project,
      projections: this.#projections(manifest, files),
      provenance: Object.freeze(files.map((file): ArtifactInspectionProvenance => Object.freeze({
        outputPath: file.path,
        sourceInputs: file.sourceInputs,
      }))),
      runtime,
    });
  }

  async #validatedManifest(artifactRoot: string): Promise<ValidatedArtifactSnapshot> {
    let validation;
    try {
      validation = await validateArtifactWithSnapshot({
        allowEpochStagingMarker: true,
        artifactRoot,
        registry: this.#registry,
      });
    } catch {
      throw inspectionError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires a readable strictly validated artifact.',
        inspectionDiagnostic('AB6200', 'Artifact inspection could not validate the published artifact.', artifactManifestName),
      );
    }
    if (validation.diagnostics.length > 0 || validation.snapshot === undefined) {
      throw new ArtifactInspectionServiceError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires an artifact with no validation diagnostics.',
        validation.diagnostics,
      );
    }
    return validation.snapshot;
  }

  #file(
    file: ArtifactManifest['files'][number],
    sourceInputs: ReadonlyMap<string, ArtifactInspectionSourceInput>,
  ): ArtifactInspectionFile {
    const inputs = file.sourceInputs.map((path) => sourceInputs.get(path));
    if (inputs.some((input) => input === undefined)) {
      throw inspectionError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires every output provenance input to be declared by the manifest project.',
        inspectionDiagnostic('AB6200', 'Artifact file provenance references an unknown project source input.', file.path),
      );
    }
    return Object.freeze({
      bytes: file.bytes,
      kind: file.kind,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
      path: file.path,
      sha256: file.sha256,
      sourceInputs: Object.freeze(inputs as ArtifactInspectionSourceInput[]),
    });
  }

  #project(
    project: ArtifactManifest['project'],
    sourceInputs: ReadonlyMap<string, ArtifactInspectionSourceInput>,
  ): ProjectContext {
    const inputs = project.sourceInputs.map((input) => sourceInputs.get(input.path));
    if (inputs.some((input) => input === undefined)) {
      throw inspectionError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires every manifest project input to be structurally valid.',
        inspectionDiagnostic('AB6200', 'Artifact manifest project inputs are invalid.', artifactManifestName),
      );
    }
    return Object.freeze({
      configDigest: project.configDigest,
      configPath: project.configPath,
      modelDigest: project.modelDigest,
      ...(project.packageName === undefined ? {} : { packageName: project.packageName }),
      ...(project.packageVersion === undefined ? {} : { packageVersion: project.packageVersion }),
      revision: project.revision,
      sourceInputs: Object.freeze(inputs as ArtifactInspectionSourceInput[]),
    });
  }

  #projections(
    manifest: ArtifactManifest,
    files: readonly ArtifactInspectionFile[],
  ): readonly ArtifactInspectionProjection[] {
    // One composite root (#555): every selected projection reads the same tree.
    const root = emptyTreeBuildDirectory();
    for (const file of files) {
      const segments = file.path.split('/');
      const fileName = segments.pop();
      if (fileName === undefined) continue;
      let directory = root;
      for (const segment of segments) {
        let child = directory.directories.get(segment);
        if (child === undefined) {
          child = emptyTreeBuildDirectory();
          directory.directories.set(segment, child);
        }
        directory = child;
      }
      directory.files.set(fileName, file);
    }
    return Object.freeze(manifest.projections.map((projection): ArtifactInspectionProjection => Object.freeze({
      documents: projection.documents,
      host: projection.host,
      ...(projection.marketplace === undefined ? {} : { marketplace: projection.marketplace.name }),
      tree: treeNode(projection.host, '.', root),
    })));
  }

  #runtime(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    manifest: ArtifactManifest,
    runtime: ValidatedArtifactSnapshot['runtime'],
  ): ArtifactInspectionRuntime {
    const hooks = this.#hooks(filesByPath, runtime);
    const mcpServers = this.#mcpServers(filesByPath, manifest);
    const bins = this.#bins(filesByPath, manifest);
    const executables = Object.freeze([...filesByPath.values()]
      .filter((file) => file.mode !== undefined && (file.mode & 0o111) !== 0)
      .sort(comparePaths));
    const scripts = this.#scripts(filesByPath, manifest);
    return Object.freeze({ bins, executables, hooks, mcpServers, scripts });
  }

  #bins(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    manifest: ArtifactManifest,
  ): readonly ArtifactInspectionBin[] {
    return Object.freeze(manifest.executables.bins.map((bin): ArtifactInspectionBin => Object.freeze({
      file: this.#runtimeFile(filesByPath, bin.path, 'Manifest bin references an unmanifested file.'),
      hosts: Object.freeze([...bin.hosts]),
      name: bin.name,
      ...(bin.worker === undefined
        ? {}
        : { worker: this.#runtimeFile(filesByPath, bin.worker, 'Manifest bin references an unmanifested worker.') }),
    })));
  }

  #scripts(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    manifest: ArtifactManifest,
  ): readonly ArtifactInspectionScript[] {
    return Object.freeze(artifactManifestScriptExecutions(manifest).map((script): ArtifactInspectionScript => Object.freeze({
      file: this.#runtimeFile(filesByPath, script.path, 'Manifest script references an unmanifested file.', script.target),
      id: script.id,
      mode: script.mode,
      name: script.name,
      ...(script.rendered === undefined ? {} : { rendered: script.rendered }),
      target: script.target,
      ...(script.worker === undefined
        ? {}
        : { worker: this.#runtimeFile(filesByPath, script.worker, 'Manifest script references an unmanifested worker.', script.target) }),
    })));
  }

  #hooks(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    runtime: ValidatedArtifactSnapshot['runtime'],
  ): readonly ArtifactInspectionHook[] {
    const hooks: ArtifactInspectionHook[] = [];
    for (const hook of runtime.hooks) {
      const file = filesByPath.get(hook.path);
      if (file === undefined) {
        throw this.#runtimeError('Validated hook evidence references an unmanifested wrapper.', hook.path, hook.host);
      }
      hooks.push(Object.freeze({
        event: hook.event,
        file,
        id: hook.id,
        kind: hook.kind,
        name: hook.name,
        path: hook.path,
        target: hook.host,
        ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
      }));
    }
    hooks.sort((left, right) => left.target === right.target
      ? left.id.localeCompare(right.id)
      : left.target.localeCompare(right.target));
    return Object.freeze(hooks);
  }

  #mcpServers(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    manifest: ArtifactManifest,
  ): readonly ArtifactInspectionMcpServer[] {
    const servers: ArtifactInspectionMcpServer[] = [];
    const projections = new Map(manifest.projections.map((projection) => [projection.host, projection]));
    for (const server of manifest.executables.mcpServers) {
      const entryPaths = server.entry === undefined
        ? Object.freeze([])
        : Object.freeze([
          server.entry.path,
          ...(server.entry.worker === undefined ? [] : [server.entry.worker]),
        ]);
      for (const target of server.hosts) {
        const manifestPath = projections.get(target)?.documents.mcp;
        if (manifestPath === undefined) {
          throw this.#runtimeError(
            'Manifest MCP server host has no projection MCP document.',
            artifactManifestName,
            target,
          );
        }
        this.#runtimeFile(filesByPath, manifestPath, 'Manifest MCP server references an unmanifested target document.', target);
        for (const path of entryPaths) {
          this.#runtimeFile(filesByPath, path, 'Manifest MCP server references an unmanifested entry file.', target);
        }
        servers.push(Object.freeze({
          apps: Object.freeze(server.apps.map((app) => Object.freeze({
            id: app.id,
            name: app.name,
            ...(app.path === undefined ? {} : { path: app.path }),
            resourceUri: app.resourceUri,
          }))),
          entryPaths,
          kind: server.kind,
          manifestPath,
          name: server.name,
          target,
        }));
      }
    }
    servers.sort((left, right) => left.target === right.target
      ? left.name.localeCompare(right.name)
      : left.target.localeCompare(right.target));
    return Object.freeze(servers);
  }

  #runtimeFile(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    path: string,
    message: string,
    target?: string,
  ): ArtifactInspectionFile {
    const file = filesByPath.get(path);
    if (file === undefined) throw this.#runtimeError(message, path, target);
    return file;
  }

  #runtimeError(message: string, generatedPath: string, target?: string): ArtifactInspectionServiceError {
    return inspectionError(
      'ARTIFACT_INSPECTION_RUNTIME_INVALID',
      'Artifact inspection could not derive safe runtime metadata.',
      inspectionDiagnostic('AB6202', message, generatedPath, target),
    );
  }

  #diff(base: ArtifactInspection, candidate: ArtifactInspection): ArtifactEpochDiff {
    const baseFiles = new Map(base.files.map((file) => [file.path, file]));
    const candidateFiles = new Map(candidate.files.map((file) => [file.path, file]));
    const added: ArtifactEpochAddedFile[] = [];
    const changed: ArtifactEpochChangedFile[] = [];
    const removed: ArtifactEpochRemovedFile[] = [];
    const unchanged: ArtifactEpochUnchangedFile[] = [];

    for (const [path, before] of baseFiles) {
      const after = candidateFiles.get(path);
      if (after === undefined) {
        removed.push(Object.freeze({ before, path }));
      } else if (sameFile(before, after)) {
        unchanged.push(Object.freeze({ after, before, path }));
      } else {
        changed.push(Object.freeze({ after, before, path }));
      }
    }
    for (const [path, after] of candidateFiles) {
      if (!baseFiles.has(path)) added.push(Object.freeze({ after, path }));
    }

    added.sort(comparePaths);
    changed.sort(comparePaths);
    removed.sort(comparePaths);
    unchanged.sort(comparePaths);
    return Object.freeze({
      added: Object.freeze(added),
      baseEpochId: base.epochId,
      candidateEpochId: candidate.epochId,
      changed: Object.freeze(changed),
      removed: Object.freeze(removed),
      unchanged: Object.freeze(unchanged),
    });
  }

  async #releaseReferences(references: readonly EpochReference[]): Promise<void> {
    const results = await Promise.allSettled(references.map(async (reference) => reference.close()));
    if (results.some((result) => result.status === 'rejected')) {
      throw inspectionError(
        'ARTIFACT_INSPECTION_RELEASE_FAILED',
        'Artifact inspection could not release an epoch reference.',
        inspectionDiagnostic('AB6201', 'Artifact inspection could not release every acquired epoch reference.'),
      );
    }
  }
}
