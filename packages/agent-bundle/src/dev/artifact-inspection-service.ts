import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { artifactManifestName } from '../build/emit.ts';
import type { ArtifactManifestV2 } from '../build/manifest.ts';
import {
  validateArtifactWithSnapshot,
  type ValidatedArtifactSnapshot,
} from '../build/validate-artifact.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { ProjectContext } from '../core/project-context.ts';
import { EpochReference, EpochStore } from './epoch-store.ts';
import type {
  ArtifactEpochAddedFile,
  ArtifactEpochChangedFile,
  ArtifactEpochDiff,
  ArtifactEpochRemovedFile,
  ArtifactEpochUnchangedFile,
  ArtifactInspection,
  ArtifactInspectionDirectoryNode,
  ArtifactInspectionFile,
  ArtifactInspectionFileNode,
  ArtifactInspectionHook,
  ArtifactInspectionMcpServer,
  ArtifactInspectionProvenance,
  ArtifactInspectionRuntime,
  ArtifactInspectionSourceInput,
  ArtifactInspectionTarget,
  ArtifactInspectionTreeNode,
} from './types.ts';

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

export class ArtifactInspectionServiceError extends Error {
  readonly code: ArtifactInspectionServiceErrorCode;
  readonly diagnostics: readonly Diagnostic[];

  constructor(code: ArtifactInspectionServiceErrorCode, message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = 'ArtifactInspectionServiceError';
    this.code = code;
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
      .map(([directoryName, child]) => treeNode(directoryName, `${path}/${directoryName}`, child)),
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
    const runtime = this.#runtime(filesByPath, validated.runtime);

    return Object.freeze({
      epochId,
      files,
      project,
      provenance: Object.freeze(files.map((file): ArtifactInspectionProvenance => Object.freeze({
        outputPath: file.path,
        sourceInputs: file.sourceInputs,
      }))),
      runtime,
      targets: this.#targets(manifest, files),
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
    file: ArtifactManifestV2['files'][number],
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
    project: ArtifactManifestV2['project'],
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
      revision: project.revision,
      sourceInputs: Object.freeze(inputs as ArtifactInspectionSourceInput[]),
    });
  }

  #targets(
    manifest: ArtifactManifestV2,
    files: readonly ArtifactInspectionFile[],
  ): readonly ArtifactInspectionTarget[] {
    return Object.freeze(manifest.targets.map((target): ArtifactInspectionTarget => {
      const root = emptyTreeBuildDirectory();
      const prefix = `${target.name}/`;
      for (const file of files) {
        if (!file.path.startsWith(prefix)) continue;
        const segments = file.path.slice(prefix.length).split('/');
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
      return Object.freeze({ name: target.name, tree: treeNode(target.name, target.name, root) });
    }));
  }

  #runtime(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    runtime: ValidatedArtifactSnapshot['runtime'],
  ): ArtifactInspectionRuntime {
    const hooks = this.#hooks(filesByPath, runtime);
    const mcpServers = this.#mcpServers(filesByPath, runtime);
    const executables = Object.freeze([...filesByPath.values()]
      .filter((file) => file.mode !== undefined && (file.mode & 0o111) !== 0)
      .sort(comparePaths));
    return Object.freeze({ executables, hooks, mcpServers });
  }

  #hooks(
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    runtime: ValidatedArtifactSnapshot['runtime'],
  ): readonly ArtifactInspectionHook[] {
    const hooks: ArtifactInspectionHook[] = [];
    for (const hook of runtime.hooks) {
      const file = filesByPath.get(hook.path);
      if (file === undefined || !hook.path.startsWith(`${hook.target}/`)) {
        throw this.#runtimeError('Validated hook evidence references an unmanifested wrapper.', hook.path, hook.target);
      }
      hooks.push(Object.freeze({
        event: hook.event,
        file,
        id: hook.id,
        name: hook.name,
        path: hook.path,
        target: hook.target,
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
    runtime: ValidatedArtifactSnapshot['runtime'],
  ): readonly ArtifactInspectionMcpServer[] {
    const servers: ArtifactInspectionMcpServer[] = [];
    for (const server of runtime.mcpServers) {
      if (!server.manifestPath.startsWith(`${server.target}/`) || !filesByPath.has(server.manifestPath)) {
        throw this.#runtimeError('Validated MCP evidence references an unmanifested target manifest.', server.manifestPath, server.target);
      }
      for (const path of server.entryPaths) {
        if (!path.startsWith(`${server.target}/`) || !filesByPath.has(path)) {
          throw this.#runtimeError('Validated MCP evidence references an unmanifested target file.', path, server.target);
        }
      }
      servers.push(Object.freeze({
        entryPaths: Object.freeze([...server.entryPaths]),
        kind: server.kind,
        manifestPath: server.manifestPath,
        name: server.name,
        target: server.target,
      }));
    }
    servers.sort((left, right) => left.target === right.target
      ? left.name.localeCompare(right.name)
      : left.target.localeCompare(right.target));
    return Object.freeze(servers);
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
