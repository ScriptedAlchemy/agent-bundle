import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve, win32 } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { artifactHookIndexName, artifactManifestName } from '../build/emit.ts';
import { parseArtifactManifest, type ArtifactManifestV2 } from '../build/manifest.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { ProjectContext } from '../core/project-context.ts';
import { classifyMcpArtifactArgument } from '../services/mcp-artifact-reference.ts';
import { parseArtifactHookIndex } from '../services/hook-index.ts';
import { resolveMcpPathTokens } from '../services/mcp-path-tokens.ts';
import {
  readTargetMcpServers,
  type McpRuntimeRoots,
  type McpRuntimeValueField,
  type McpRuntimeValueResolution,
  type ModernMcpServersReadResult,
  type TargetMcpRuntimeContract,
} from '../services/mcp-runtime.ts';
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

const mcpArtifactPathApi = process.platform === 'win32'
  ? Object.freeze({
    isAbsolute: win32.isAbsolute,
    normalize: win32.normalize,
    relative: win32.relative,
    resolve: win32.resolve,
    sep: '\\' as const,
  })
  : Object.freeze({
    isAbsolute: posix.isAbsolute,
    normalize: posix.normalize,
    relative: posix.relative,
    resolve: posix.resolve,
    sep: '/' as const,
  });

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

const dataRecord = (value: unknown): value is object => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
  } catch {
    return false;
  }
};

const dataValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
};

const dataArray = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  try {
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      length === undefined || !('value' in length) ||
      !Number.isSafeInteger(length.value) || length.value < 0 ||
      Reflect.ownKeys(value).length !== length.value + 1
    ) return undefined;
    const entries: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      entries.push(descriptor.value);
    }
    return Object.freeze(entries);
  } catch {
    return undefined;
  }
};

const snapshotRuntimeDiagnostic = (value: unknown): Diagnostic | undefined => {
  if (!dataRecord(value)) return undefined;
  const code = dataValue(value, 'code');
  const generatedPath = dataValue(value, 'generatedPath');
  const message = dataValue(value, 'message');
  const recovery = dataValue(value, 'recovery');
  const severity = dataValue(value, 'severity');
  const sourcePath = dataValue(value, 'sourcePath');
  const target = dataValue(value, 'target');
  if (
    typeof code !== 'string' || typeof message !== 'string' ||
    (generatedPath !== undefined && typeof generatedPath !== 'string') ||
    (recovery !== undefined && typeof recovery !== 'string') ||
    (sourcePath !== undefined && typeof sourcePath !== 'string') ||
    (target !== undefined && typeof target !== 'string') ||
    (severity !== 'error' && severity !== 'info' && severity !== 'warning')
  ) return undefined;
  return Object.freeze({
    code,
    ...(generatedPath === undefined ? {} : { generatedPath }),
    message,
    ...(recovery === undefined ? {} : { recovery }),
    severity,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(target === undefined ? {} : { target }),
  });
};

const snapshotMcpValueResolution = (value: unknown): McpRuntimeValueResolution | undefined => {
  if (!dataRecord(value)) return undefined;
  const diagnostics = dataArray(dataValue(value, 'diagnostics'));
  const resolved = dataValue(value, 'value');
  if (diagnostics === undefined || typeof resolved !== 'string') return undefined;
  const snapshots = diagnostics.map(snapshotRuntimeDiagnostic);
  if (snapshots.some((diagnostic) => diagnostic === undefined)) return undefined;
  return Object.freeze({ diagnostics: Object.freeze(snapshots as Diagnostic[]), value: resolved });
};

const mcpResolutionKey = (
  field: McpRuntimeValueField,
  roots: McpRuntimeRoots,
  value: string,
): string => JSON.stringify([field, roots.pluginData, roots.pluginRoot, roots.workspaceRoot, value]);

class ValidatedMcpRuntime {
  readonly #capturedValueResolutions = new Map<string, McpRuntimeValueResolution>();
  readonly #capturedStdioArguments = new Map<string, string>();
  readonly #runtime: TargetMcpRuntimeContract;
  readonly #validationRuntime: TargetMcpRuntimeContract;
  #servers: ModernMcpServersReadResult | undefined;
  #sealed = false;

  constructor(runtime: TargetMcpRuntimeContract) {
    this.#runtime = runtime;
    this.#validationRuntime = Object.freeze({
      manifestPath: runtime.manifestPath,
      readModernServers: (document: unknown) => this.#readModernServers(document),
      resolveStdioArgument: (value: string, roots: McpRuntimeRoots) => this.#resolveStdioArgument(value, roots),
      resolveValue: (field: McpRuntimeValueField, roots: McpRuntimeRoots, value: string) =>
        this.#resolveValue(field, roots, value),
    });
  }

  get manifestPath(): string {
    return this.#validationRuntime.manifestPath;
  }

  get runtime(): TargetMcpRuntimeContract {
    return this.#validationRuntime;
  }

  get servers(): ModernMcpServersReadResult | undefined {
    return this.#servers;
  }

  seal(): void {
    this.#sealed = true;
  }

  #readModernServers(document: unknown): ModernMcpServersReadResult {
    if (this.#servers !== undefined) return this.#servers;
    if (this.#sealed) return Object.freeze({ status: 'invalid' });
    this.#servers = readTargetMcpServers(this.#runtime, document);
    return this.#servers;
  }

  #resolveStdioArgument(value: string, roots: McpRuntimeRoots): string {
    const key = mcpResolutionKey('args', roots, value);
    const captured = this.#capturedStdioArguments.get(key);
    if (captured !== undefined) return captured;
    if (this.#sealed) throw new Error('MCP stdio argument was not resolved during validation.');
    const resolved = this.#runtime.resolveStdioArgument(value, roots);
    if (typeof resolved !== 'string') throw new Error('MCP stdio argument resolver returned an invalid value.');
    this.#capturedStdioArguments.set(key, resolved);
    return resolved;
  }

  #resolveValue(
    field: McpRuntimeValueField,
    roots: McpRuntimeRoots,
    value: string,
  ): McpRuntimeValueResolution {
    const key = mcpResolutionKey(field, roots, value);
    const captured = this.#capturedValueResolutions.get(key);
    if (captured !== undefined) return captured;
    if (this.#sealed) throw new Error('MCP runtime value was not resolved during validation.');
    const resolved = snapshotMcpValueResolution(this.#runtime.resolveValue(field, roots, value));
    if (resolved === undefined) throw new Error('MCP runtime value resolver returned an invalid value.');
    this.#capturedValueResolutions.set(key, resolved);
    return resolved;
  }
}

class RuntimeFactCapture {
  readonly #mcpRuntimes = new Map<string, ValidatedMcpRuntime>();
  readonly #registry: TargetRegistry;

  constructor(registry: TargetRegistry) {
    this.#registry = registry;
  }

  validationRegistry(): TargetRegistry {
    return new Proxy(this.#registry, {
      get: (target, property) => {
        if (property === 'mcpRuntime') return this.#mcpRuntime.bind(this);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TargetRegistry;
  }

  mcpRuntime(target: string): ValidatedMcpRuntime | undefined {
    return this.#mcpRuntimes.get(target);
  }

  seal(): void {
    for (const runtime of this.#mcpRuntimes.values()) runtime.seal();
  }

  #mcpRuntime(target: string): TargetMcpRuntimeContract | undefined {
    const captured = this.#mcpRuntimes.get(target);
    if (captured !== undefined) return captured.runtime;
    const runtime = this.#registry.mcpRuntime(target);
    if (runtime === undefined) return undefined;
    const snapshot = new ValidatedMcpRuntime(runtime);
    this.#mcpRuntimes.set(target, snapshot);
    return snapshot.runtime;
  }
}

interface ValidatedArtifact {
  readonly manifest: ArtifactManifestV2;
  readonly runtimeFacts: RuntimeFactCapture;
}

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
    const runtime = await this.#runtime(reference.root, manifest, filesByPath, validated.runtimeFacts);

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

  async #validatedManifest(artifactRoot: string): Promise<ValidatedArtifact> {
    let diagnostics: readonly Diagnostic[];
    const runtimeFacts = new RuntimeFactCapture(this.#registry);
    try {
      diagnostics = await validateArtifact({
        allowEpochStagingMarker: true,
        artifactRoot,
        registry: runtimeFacts.validationRegistry(),
      });
    } catch {
      throw inspectionError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires a readable strictly validated artifact.',
        inspectionDiagnostic('AB6200', 'Artifact inspection could not validate the published artifact.', artifactManifestName),
      );
    } finally {
      runtimeFacts.seal();
    }
    if (diagnostics.length > 0) {
      throw new ArtifactInspectionServiceError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires an artifact with no validation diagnostics.',
        diagnostics,
      );
    }
    try {
      return Object.freeze({
        manifest: parseArtifactManifest(await readFile(resolve(artifactRoot, artifactManifestName), 'utf8')),
        runtimeFacts,
      });
    } catch {
      throw inspectionError(
        'ARTIFACT_INSPECTION_INVALID',
        'Artifact inspection requires a strict canonical Artifact Manifest v2.',
        inspectionDiagnostic('AB6001', 'Artifact manifest is not a strict canonical v2 manifest.', artifactManifestName),
      );
    }
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

  async #runtime(
    artifactRoot: string,
    manifest: ArtifactManifestV2,
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    runtimeFacts: RuntimeFactCapture,
  ): Promise<ArtifactInspectionRuntime> {
    const hooks = await this.#hooks(artifactRoot, filesByPath);
    const mcpServers = this.#mcpServers(artifactRoot, manifest, filesByPath, runtimeFacts);
    const executables = Object.freeze([...filesByPath.values()]
      .filter((file) => file.mode !== undefined && (file.mode & 0o111) !== 0)
      .sort(comparePaths));
    return Object.freeze({ executables, hooks, mcpServers });
  }

  async #hooks(
    artifactRoot: string,
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
  ): Promise<readonly ArtifactInspectionHook[]> {
    const indexFile = filesByPath.get(artifactHookIndexName);
    if (indexFile === undefined) {
      throw this.#runtimeError('Artifact hook index is missing from the declared artifact files.', artifactHookIndexName);
    }
    let index;
    try {
      index = parseArtifactHookIndex(await this.#readManifestedFile(artifactRoot, indexFile));
    } catch {
      index = undefined;
    }
    if (index === undefined) {
      throw this.#runtimeError('Artifact hook index is not strict canonical metadata.', artifactHookIndexName);
    }
    const hooks: ArtifactInspectionHook[] = [];
    for (const hook of index.hooks) {
      const file = filesByPath.get(hook.path);
      if (file === undefined || !hook.path.startsWith(`${hook.target}/`)) {
        throw this.#runtimeError('Artifact hook index references an unmanifested wrapper.', hook.path, hook.target);
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

  async #readManifestedFile(artifactRoot: string, file: ArtifactInspectionFile): Promise<string> {
    let bytes: Buffer;
    try {
      bytes = await readFile(resolve(artifactRoot, file.path));
    } catch {
      throw this.#runtimeError('Artifact runtime metadata file could not be read.', file.path);
    }
    if (bytes.byteLength !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw this.#runtimeError('Artifact runtime metadata file no longer matches its manifest entry.', file.path);
    }
    return bytes.toString('utf8');
  }

  #mcpServers(
    artifactRoot: string,
    manifest: ArtifactManifestV2,
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
    runtimeFacts: RuntimeFactCapture,
  ): readonly ArtifactInspectionMcpServer[] {
    const servers: ArtifactInspectionMcpServer[] = [];
    for (const target of manifest.targets) {
      const runtimeFact = runtimeFacts.mcpRuntime(target.name);
      if (runtimeFact === undefined) continue;
      const manifestPath = `${target.name}/${runtimeFact.manifestPath}`;
      if (!filesByPath.has(manifestPath)) continue;
      const result = runtimeFact.servers;
      if (result === undefined || result.status === 'invalid') {
        throw this.#runtimeError('Artifact MCP manifest is invalid for its target runtime contract.', manifestPath, target.name);
      }
      for (const entry of result.servers) {
        const server = this.#resolvedMcpServer(artifactRoot, target.name, runtimeFact.runtime, entry.server, manifestPath);
        const entryPaths = server.kind === 'stdio'
          ? this.#mcpEntryPaths(artifactRoot, target.name, server.command, server.args, filesByPath)
          : Object.freeze([]);
        servers.push(Object.freeze({
          entryPaths,
          kind: server.kind,
          manifestPath,
          name: entry.name,
          target: target.name,
        }));
      }
    }
    servers.sort((left, right) => left.target === right.target
      ? left.name.localeCompare(right.name)
      : left.target.localeCompare(right.target));
    return Object.freeze(servers);
  }

  #resolvedMcpServer(
    artifactRoot: string,
    target: string,
    runtime: NonNullable<ReturnType<TargetRegistry['mcpRuntime']>>,
    server: Parameters<typeof resolveMcpPathTokens>[0]['server'],
    manifestPath: string,
  ): ReturnType<typeof resolveMcpPathTokens> {
    try {
      return resolveMcpPathTokens({
        roots: {
          pluginData: resolve(artifactRoot, target),
          pluginRoot: resolve(artifactRoot, target),
          workspaceRoot: dirname(resolve(artifactRoot)),
        },
        runtime,
        server,
        target,
      });
    } catch {
      throw this.#runtimeError('Artifact MCP runtime values could not be resolved.', manifestPath, target);
    }
  }

  #mcpEntryPaths(
    artifactRoot: string,
    target: string,
    command: string,
    arguments_: readonly string[],
    filesByPath: ReadonlyMap<string, ArtifactInspectionFile>,
  ): readonly string[] {
    const paths = new Set<string>();
    for (const value of [command, ...arguments_]) {
      const reference = classifyMcpArtifactArgument({
        path: mcpArtifactPathApi,
        roots: {
          artifactRoot: resolve(artifactRoot),
          targetRoot: resolve(artifactRoot, target),
        },
        value,
      });
      if (reference.status !== 'artifact-local') continue;
      const path = `${target}/${reference.path}`;
      if (!path.startsWith(`${target}/`) || !filesByPath.has(path)) {
        throw this.#runtimeError('Artifact MCP runtime references an unmanifested target file.', path, target);
      }
      paths.add(path);
    }
    return Object.freeze([...paths].sort((left, right) => left.localeCompare(right)));
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
