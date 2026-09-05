import { lstat, readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';

import { portableAdapter } from '../adapters/portable.ts';
import { createDefaultRegistry, type ArtifactRootContracts, type TargetRegistry } from '../adapters/registry.ts';
import type {
  TargetArtifactDocumentIssue,
  TargetArtifactDocumentValidator,
} from '../adapters/types.ts';
import { mcpEntryAliasPattern } from '../config/normalize.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { dataArrayValues, isPlainDataRecord, isRecord, ownDataValue } from '../core/strict-json.ts';
import { validatePortablePluginFiles } from '../host-contracts/portable-plugin-validation.ts';
import { agentSkillsSchemaRevision } from '../schemas/agent-skills/contract.ts';
import {
  artifactDiagnostic as diagnostic,
  artifactDiagnosticRecoveries,
} from './artifact-diagnostics.ts';
import {
  isDirectOutputLayoutPath,
  matchesManifestFile,
} from './artifact-layout.ts';
import {
  artifactHookIndexName,
  artifactManifestName,
  inspectArtifactFilesystem,
  type ArtifactFile,
  type ArtifactFilesystemSnapshot,
  type ArtifactHook,
  type ManifestFile,
} from './emit.ts';
import { parseArtifactManifest, type ArtifactManifest } from './manifest.ts';
import type { ModuleSyntaxCheck } from './module-imports.ts';
import type {
  ValidateArtifactOptions,
  ValidatedArtifactMcpServerEvidence,
  ValidatedArtifactRuntimeEvidence,
  ValidatedArtifactSnapshot,
  ValidateArtifactSnapshotResult,
} from './artifact-validation-types.ts';
import { validateJavaScriptModules } from './validate-artifact-modules.ts';
import { validateHookCoherence } from './validate-artifact-hooks.ts';
import { manifestLogoPathDiagnostics } from './validate-artifact-logo.ts';
import { validateMcpCoherence } from './validate-artifact-mcp.ts';
import { manifestTargetNames, validateEmittedSkills } from './validate-artifact-skills.ts';
import { installSurfaceRequirements } from '../install/surface.ts';

export { artifactDiagnosticRecoveries, type ArtifactDiagnosticCode } from './artifact-diagnostics.ts';
export type * from './artifact-validation-types.ts';

const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';
const artifactRootMetadata = new Set([artifactHookIndexName]);

const matchesManifestFileTable = (
  files: readonly ArtifactFile[],
  manifestFiles: readonly ManifestFile[],
): boolean => {
  if (files.length !== manifestFiles.length) return false;
  const manifestFilesByPath = new Map(manifestFiles.map((file) => [file.path, file]));
  return files.every((file) => {
    const manifestFile = manifestFilesByPath.get(file.path);
    return manifestFile !== undefined && matchesManifestFile(file, manifestFile);
  });
};

const sameArtifactFile = (left: ArtifactFile, right: ArtifactFile): boolean =>
  left.bytes === right.bytes &&
  left.mode === right.mode &&
  left.path === right.path &&
  left.sha256 === right.sha256;

const changedArtifactPaths = (
  initialFiles: readonly ArtifactFile[],
  finalFiles: readonly ArtifactFile[],
): readonly string[] => {
  const initialFilesByPath = new Map(initialFiles.map((file) => [file.path, file]));
  const finalFilesByPath = new Map(finalFiles.map((file) => [file.path, file]));
  return [...new Set([...initialFilesByPath.keys(), ...finalFilesByPath.keys()])]
    .filter((path) => {
      const initialFile = initialFilesByPath.get(path);
      const finalFile = finalFilesByPath.get(path);
      return initialFile === undefined || finalFile === undefined || !sameArtifactFile(initialFile, finalFile);
    })
    .sort((left, right) => left.localeCompare(right));
};

const localMcpArgument = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const relative = value.replace(/^\.\//, '');
  return mcpEntryAliasPattern.test(relative) ? relative : undefined;
};

const localMcpPaths = (document: unknown): readonly string[] => {
  if (!isRecord(document)) return [];
  const servers = document.mcpServers;
  if (!isRecord(servers)) return [];
  return Object.values(servers).flatMap((server) => {
    if (!isRecord(server)) return [];
    const args = server.args;
    return Array.isArray(args) ? [localMcpArgument(args[0])].filter((path): path is string => path !== undefined) : [];
  });
};

const isEpochStagingMarker = (value: string): boolean => {
  try {
    const marker: unknown = JSON.parse(value);
    if (!isRecord(marker) || !('token' in marker)) return false;
    const entries = Object.entries(marker);
    return entries.length === 1 &&
      typeof marker.token === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(marker.token);
  } catch {
    return false;
  }
};

interface ArtifactInspection {
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly files: readonly ArtifactFile[];
}

interface RuntimeEvidenceBuilder {
  readonly hooks: ArtifactHook[];
  readonly mcpServers: ValidatedArtifactMcpServerEvidence[];
}

const runtimeEvidenceBuilder = (): RuntimeEvidenceBuilder => ({ hooks: [], mcpServers: [] });

const snapshotRuntimeEvidence = (evidence: RuntimeEvidenceBuilder): ValidatedArtifactRuntimeEvidence => Object.freeze({
  hooks: Object.freeze(evidence.hooks.map((hook) => Object.freeze({
    event: hook.event,
    id: hook.id,
    name: hook.name,
    path: hook.path,
    target: hook.target,
    ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
  }))),
  mcpServers: Object.freeze(evidence.mcpServers.map((server) => Object.freeze({
    entryPaths: Object.freeze([...server.entryPaths]),
    kind: server.kind,
    manifestPath: server.manifestPath,
    name: server.name,
    target: server.target,
  }))),
});

interface ManifestSnapshot {
  readonly bytes: Buffer;
  readonly device: number;
  readonly inode: number;
}

const sameManifestSnapshot = (left: ManifestSnapshot, right: ManifestSnapshot): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.bytes.equals(right.bytes);

/** Stays on `lstat`: the read is bracketed by a `dev`/`ino` identity check the pinned `FileSystem` cannot make. */
const snapshotManifest = async (path: string): Promise<ManifestSnapshot> => {
  const initialMetadata = await lstat(path);
  if (!initialMetadata.isFile()) throw new Error('Artifact manifest is not a regular file.');
  const bytes = await readFile(path);
  const finalMetadata = await lstat(path);
  if (
    !finalMetadata.isFile() ||
    initialMetadata.dev !== finalMetadata.dev ||
    initialMetadata.ino !== finalMetadata.ino
  ) {
    throw new Error('Artifact manifest changed while being read.');
  }
  return Object.freeze({ bytes, device: initialMetadata.dev, inode: initialMetadata.ino });
};

const inspectArtifact = async (context: ValidateArtifactOptions): Promise<ArtifactInspection> => {
  const filesystem = await inspectArtifactFilesystem(context.artifactRoot);
  let allowedEpochStagingMarker = false;
  if (
    context.allowEpochStagingMarker === true &&
    filesystem.files.some((file) => file.path === epochStagingMarkerName)
  ) {
    try {
      allowedEpochStagingMarker = isEpochStagingMarker(
        await runWithPlatform(readFileString(resolve(context.artifactRoot, epochStagingMarkerName))),
      );
    } catch {
      allowedEpochStagingMarker = false;
    }
  }
  return {
    filesystem,
    files: filesystem.files.filter(
      (file) => file.path !== artifactManifestName &&
        !(allowedEpochStagingMarker && file.path === epochStagingMarkerName),
    ),
  };
};

const filesystemRecovery = artifactDiagnosticRecoveries.AB6013;

const filesystemDiagnostics = (filesystem: ArtifactFilesystemSnapshot): readonly Diagnostic[] =>
  filesystem.entries
    .filter((entry) => entry.kind !== 'directory' && entry.kind !== 'file')
    .map((entry) => diagnostic(
      'AB6013',
      `Artifact contains unsupported ${entry.kind} filesystem entry ${JSON.stringify(entry.path)}.`,
      entry.path,
      undefined,
      filesystemRecovery,
    ));

const filesystemDriftDiagnostics = (
  initial: ArtifactFilesystemSnapshot,
  final: ArtifactFilesystemSnapshot,
): readonly Diagnostic[] => {
  const initialKinds = new Map(initial.entries.map((entry) => [entry.path, entry.kind]));
  const finalKinds = new Map(final.entries.map((entry) => [entry.path, entry.kind]));
  const changedEntries = new Set([...new Set([...initialKinds.keys(), ...finalKinds.keys()])]
    .filter((path) => initialKinds.get(path) !== finalKinds.get(path)));
  const changedFiles = changedArtifactPaths(initial.files, final.files);
  const unsupportedDiagnostics = filesystemDiagnostics(final)
    .filter((entry) => entry.generatedPath !== undefined && changedEntries.has(entry.generatedPath));
  const unsupportedPaths = new Set(unsupportedDiagnostics
    .map((entry) => entry.generatedPath)
    .filter((path): path is string => path !== undefined));
  const fileDiagnostics = changedFiles
    .filter((path) => path !== artifactManifestName && !unsupportedPaths.has(path))
    .map((path) => diagnostic('AB6004', `Artifact file changed during validation: ${JSON.stringify(path)}.`, path));
  const coveredPaths = [...changedFiles, ...unsupportedPaths];
  const directoryDiagnostics = [...changedEntries]
    .sort((left, right) => left.localeCompare(right))
    .filter((path) => initialKinds.get(path) === 'directory' || finalKinds.get(path) === 'directory')
    .filter((path) => !coveredPaths.some((covered) => covered === path || covered.startsWith(`${path}/`)))
    .map((path) => diagnostic(
      'AB6014',
      `Artifact directory changed during validation: ${JSON.stringify(path)}.`,
      path,
      undefined,
      ownershipRecovery,
    ));
  return Object.freeze([...unsupportedDiagnostics, ...fileDiagnostics, ...directoryDiagnostics]);
};

const finalEvidenceDiagnostics = (options: {
  readonly finalFilesystem?: ArtifactFilesystemSnapshot;
  readonly finalManifest?: ManifestSnapshot;
  readonly initialFilesystem: ArtifactFilesystemSnapshot;
  readonly initialManifest: ManifestSnapshot;
}): readonly Diagnostic[] => {
  const diagnostics = options.finalFilesystem === undefined
    ? [diagnostic('AB6004', 'Artifact file table changed during validation.', artifactManifestName)]
    : [...filesystemDriftDiagnostics(options.initialFilesystem, options.finalFilesystem)];
  const manifestChangedInFilesystem = options.finalFilesystem !== undefined &&
    changedArtifactPaths(options.initialFilesystem.files, options.finalFilesystem.files).includes(artifactManifestName);
  if (
    options.finalManifest === undefined ||
    manifestChangedInFilesystem ||
    !sameManifestSnapshot(options.initialManifest, options.finalManifest)
  ) {
    diagnostics.push(diagnostic('AB6001', 'Artifact manifest changed during validation.', artifactManifestName));
  }
  return Object.freeze(diagnostics);
};

const sameSchemas = (
  manifest: ArtifactManifest['targets'][number]['schemas'],
  registered: ReturnType<TargetRegistry['metadata']>['schemas'],
): boolean => {
  const expected = [...registered].sort((left, right) => left.name.localeCompare(right.name));
  return manifest.length === expected.length && manifest.every((schema, index) => {
    const current = expected[index];
    return current !== undefined &&
      schema.name === current.name &&
      schema.revision === current.revision &&
      schema.sha256 === current.sha256;
  });
};

const matchesTargetMetadata = (
  target: ArtifactManifest['targets'][number],
  metadata: ReturnType<TargetRegistry['metadata']>,
): boolean => target.adapterRevision === metadata.adapterRevision &&
  target.observedVersion === metadata.observedVersion &&
  sameSchemas(target.schemas, metadata.schemas);

const schemaValidationFailure = (): readonly TargetArtifactDocumentIssue[] => Object.freeze([
  Object.freeze({ instancePath: '/', message: 'schema validation failed' }),
]);

// Extra data keys stay tolerated (adapters may return richer issue objects),
// but `then` is rejected so a thenable issue cannot poison awaited pipelines.
const snapshotSchemaIssue = (value: unknown): TargetArtifactDocumentIssue | undefined => {
  if (!isPlainDataRecord(value) || Object.hasOwn(value, 'then')) return undefined;
  const instancePath = ownDataValue(value, 'instancePath');
  const message = ownDataValue(value, 'message');
  if (
    instancePath === undefined ||
    message === undefined ||
    typeof instancePath.value !== 'string' ||
    typeof message.value !== 'string'
  ) {
    return undefined;
  }
  return Object.freeze({ instancePath: instancePath.value, message: message.value });
};

const snapshotSchemaIssues = (value: unknown): readonly TargetArtifactDocumentIssue[] => {
  const entries = dataArrayValues(value);
  if (entries === undefined) return schemaValidationFailure();
  const issues: TargetArtifactDocumentIssue[] = [];
  for (const entry of entries) {
    const issue = snapshotSchemaIssue(entry);
    if (issue === undefined) return schemaValidationFailure();
    issues.push(issue);
  }
  return Object.freeze(issues);
};

const validateSchemaDocument = (
  validator: TargetArtifactDocumentValidator,
  document: unknown,
): readonly TargetArtifactDocumentIssue[] => {
  try {
    return snapshotSchemaIssues(validator(document));
  } catch {
    return schemaValidationFailure();
  }
};

const matchesArtifactDocumentPath = (contractPath: string, relativePath: string): boolean => {
  const wildcard = contractPath.indexOf('*');
  if (wildcard === -1) return contractPath === relativePath;
  if (contractPath.indexOf('*', wildcard + 1) !== -1) return false;
  const prefix = contractPath.slice(0, wildcard);
  const suffix = contractPath.slice(wildcard + 1);
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(suffix)) return false;
  const matched = relativePath.slice(prefix.length, relativePath.length - suffix.length);
  return matched.length > 0 && !matched.includes('/');
};

const validateTargetContracts = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const files = new Set(options.files.map((file) => file.path));
  const knownTargets = manifestTargetNames(options.manifest).filter((target) => options.registry.has(target));

  for (const target of options.manifest.targets) {
    if (!options.registry.has(target.name)) {
      diagnostics.push(diagnostic(
        'AB6009',
        `Artifact declares unknown target ${JSON.stringify(target.name)}.`,
        artifactManifestName,
        target.name,
      ));
      continue;
    }
    if (!matchesTargetMetadata(target, options.registry.metadata(target.name))) {
      diagnostics.push(diagnostic(
        'AB6010',
        `Artifact metadata for target ${JSON.stringify(target.name)} does not match its registered contract.`,
        artifactManifestName,
        target.name,
      ));
      continue;
    }
  }
  if (knownTargets.length === 0) return Object.freeze(diagnostics);

  // One root projects every declared host (#555): the install surface and
  // the host documents (relocated where the composition moved them) all live
  // at the root, validated by the root's contracts.
  const root = options.registry.root(knownTargets);
  // A single-host root's diagnostics name that host; a composite root's name
  // no projection, since the whole root is at issue.
  const rootTarget = root.targets.length === 1 ? root.targets[0] : undefined;
  for (const relativePath of installSurfaceRequirements(knownTargets)) {
    if (files.has(relativePath)) continue;
    diagnostics.push(diagnostic(
      relativePath === 'INSTALL.md' ? 'AB6023' : 'AB6024',
      `Plugin root ${JSON.stringify(root.name)} is missing required install surface ${JSON.stringify(relativePath)}.`,
      relativePath,
      rootTarget,
    ));
  }

  const validation = root.artifactValidation;
  const validators = new Map(validation.schemas.map((schema) => [schema.name, schema.validate]));
  for (const document of validation.documents) {
    const generatedPaths = document.path.includes('*')
      ? [...files]
        .filter((path) => matchesArtifactDocumentPath(document.path, path))
        .sort((left, right) => left.localeCompare(right))
      : [document.path].filter((path) => files.has(path));
    if (generatedPaths.length === 0) {
      if (document.required) {
        diagnostics.push(diagnostic(
          'AB6011',
          `Plugin root ${JSON.stringify(root.name)} is missing required document ${JSON.stringify(document.path)}.`,
          document.path,
          rootTarget,
        ));
      }
      continue;
    }
    for (const generatedPath of generatedPaths) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await runWithPlatform(readFileString(resolve(options.artifactRoot, generatedPath)))) as unknown;
      } catch {
        continue;
      }
      const validate = validators.get(document.schema);
      if (validate === undefined) continue;
      const issues = validateSchemaDocument(validate, parsed);
      const issue = issues[0];
      if (issue !== undefined) {
        diagnostics.push(diagnostic(
          'AB6012',
          `Plugin root ${JSON.stringify(root.name)} document ${JSON.stringify(generatedPath)} is invalid for schema ${JSON.stringify(document.schema)} at ${issue.instancePath || '/'}: ${issue.message}.`,
          generatedPath,
          rootTarget,
        ));
      }
      if (
        document.path.endsWith('plugin.json') &&
        isRecord(parsed) &&
        typeof parsed.logo === 'string'
      ) {
        diagnostics.push(...manifestLogoPathDiagnostics({
          files,
          generatedPath,
          logo: parsed.logo,
          target: root.name,
        }));
      }
    }
  }
  return Object.freeze(diagnostics);
};

/**
 * Agent Plugins 1.0.0 bytes-at-rest lane (AB6035–AB6037) over every tree
 * emitted by the built-in portable adapter, so a standard-invalid `mcp.json`
 * or layout fails ordinary `build` and `validate --artifact` rather than only
 * `--host-validation`. The lane keys on the registered adapter identity, not
 * the name: an advanced registry may bind `portable` to its own adapter and
 * contract, and that output is validated by its own `artifactValidation`.
 * A tree that already holds a symlink or other unsupported entry (AB6013) is
 * skipped: the byte lane follows `plugin.json`/`mcp.json`/`skills` with
 * `stat`/`readFile`/`readdir`, so it must not touch paths whose containment
 * the filesystem inspection has already refused.
 */
const validatePortableTargets = async (options: {
  readonly artifactRoot: string;
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const knownTargets = manifestTargetNames(options.manifest).filter((target) => options.registry.has(target));
  const root = knownTargets.length === 0 ? undefined : options.registry.root(knownTargets);
  for (const target of options.manifest.targets) {
    if (root === undefined || !options.registry.has(target.name) || options.registry.get(target.name) !== portableAdapter) continue;
    // The portable pack is the root itself, or its namespaced `portable/`
    // view beside other hosts (#555).
    const hostRoot = root.hostRoot(target.name);
    const prefix = hostRoot === '' ? '' : `${hostRoot}/`;
    if (!options.filesystem.files.some((file) => file.path.startsWith(prefix))) continue;
    const unsupported = options.filesystem.entries.some((entry) =>
      (prefix === '' || entry.path === hostRoot || entry.path.startsWith(prefix)) &&
      entry.kind !== 'directory' &&
      entry.kind !== 'file');
    if (unsupported) continue;
    for (const entry of await validatePortablePluginFiles({
      pluginDirectory: resolve(options.artifactRoot, hostRoot),
      target: target.name,
    })) {
      diagnostics.push(Object.freeze({ ...entry, message: `Target ${JSON.stringify(target.name)}: ${entry.message}` }));
    }
  }
  return Object.freeze(diagnostics);
};

const ownershipRecovery = artifactDiagnosticRecoveries.AB6014;

const isSkillArtifactPath = (relativePath: string, skills: string | undefined): boolean => {
  if (skills === undefined) return false;
  const [layout, name, resource] = relativePath.split('/');
  return layout === skills && name !== undefined && resource !== undefined;
};

const isRecursiveArtifactPath = (relativePath: string, directory: string | undefined): boolean => {
  if (directory === undefined) return false;
  const [layout, ...segments] = relativePath.split('/');
  return layout === directory && segments.length > 0 && segments.every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\'));
};

const isAdapterRootDocument = (relativePath: string, rootDocuments: readonly string[] | undefined): boolean =>
  rootDocuments?.includes(relativePath) === true;

/**
 * True when a root-relative path belongs to a layout the root's contracts
 * declare: the compiler-owned directories, any projected host's hook or MCP
 * document (relocated where the composition moved it), or a host document.
 */
/**
 * True when a path inside a host's namespaced view (the `portable/` Agent
 * Plugins pack of a composite root) belongs to that host's own layout: its
 * documents, skills, assets, payloads, and the `mcp/` shims onto the shared
 * compiled servers.
 */
const isHostViewArtifactPath = (
  relativePath: string,
  host: string,
  registry: TargetRegistry,
): boolean => {
  const layout = registry.artifactLayout(host);
  const hookContract = registry.hookContract(host);
  const mcpRuntime = registry.mcpRuntime(host);
  return isRecursiveArtifactPath(relativePath, layout.assets) ||
    isDirectOutputLayoutPath(relativePath, layout.mcpEntries) ||
    isSkillArtifactPath(relativePath, layout.skills) ||
    isAdapterRootDocument(relativePath, layout.rootDocuments) ||
    relativePath === hookContract?.manifestPath ||
    relativePath === mcpRuntime?.manifestPath ||
    registry.artifactValidation(host).documents.some((document) =>
      matchesArtifactDocumentPath(document.path, relativePath));
};

const isRootArtifactPath = (
  relativePath: string,
  root: ArtifactRootContracts,
  registry: TargetRegistry,
): boolean => {
  for (const host of root.targets) {
    const hostRoot = root.hostRoot(host);
    if (hostRoot !== '' && relativePath.startsWith(`${hostRoot}/`)) {
      return isHostViewArtifactPath(relativePath.slice(hostRoot.length + 1), host, registry);
    }
  }
  const layout = root.artifactLayout;
  return isRecursiveArtifactPath(relativePath, layout.assets) ||
    isRecursiveArtifactPath(relativePath, layout.bin) ||
    isDirectOutputLayoutPath(relativePath, layout.cliBin) ||
    isDirectOutputLayoutPath(relativePath, layout.commands) ||
    isDirectOutputLayoutPath(relativePath, layout.hookWrappers) ||
    isDirectOutputLayoutPath(relativePath, layout.mcpApps) ||
    isDirectOutputLayoutPath(relativePath, layout.mcpEntries) ||
    isDirectOutputLayoutPath(relativePath, layout.rules) ||
    isDirectOutputLayoutPath(relativePath, layout.scripts) ||
    isSkillArtifactPath(relativePath, layout.skills) ||
    isAdapterRootDocument(relativePath, layout.rootDocuments) ||
    root.targets.some((host) =>
      relativePath === root.hookContractFor(host)?.manifestPath ||
      relativePath === root.mcpRuntimeFor(host)?.manifestPath) ||
    root.artifactValidation.documents.some((document) =>
      matchesArtifactDocumentPath(document.path, relativePath));
};

const validateArtifactOwnership = (options: {
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const knownTargets = manifestTargetNames(options.manifest).filter((target) => options.registry.has(target));
  // Unknown targets are diagnosed by the target-contract validator; without
  // their registry contracts there is no trustworthy layout to classify against.
  if (knownTargets.length === 0 || knownTargets.length !== options.manifest.targets.length) return Object.freeze(diagnostics);
  const root = options.registry.root(knownTargets);
  const rootTarget = root.targets.length === 1 ? root.targets[0] : undefined;
  const manifestKinds = new Map(options.manifest.files.map((file) => [file.path, file.kind]));

  for (const file of options.files) {
    if (artifactRootMetadata.has(file.path)) continue;
    if (isRootArtifactPath(file.path, root, options.registry)) continue;
    // Prebuilt payload files live in config-named directories at the root,
    // so no emitted layout describes them.
    if (manifestKinds.get(file.path) === 'prebuilt') continue;
    diagnostics.push(diagnostic(
      'AB6014',
      `Artifact file ${JSON.stringify(file.path)} is outside the plugin root's emitted layouts.`,
      file.path,
      rootTarget,
      ownershipRecovery,
    ));
  }

  for (const entry of options.filesystem.entries) {
    if (entry.kind !== 'directory' || entry.path === '.') continue;
    if (!options.files.some((file) => file.path.startsWith(`${entry.path}/`))) {
      diagnostics.push(diagnostic(
        'AB6014',
        `Artifact directory ${JSON.stringify(entry.path)} is empty.`,
        entry.path,
        rootTarget,
        ownershipRecovery,
      ));
    }
  }

  return Object.freeze(diagnostics);
};

const validateArtifactStructure = (options: {
  readonly changedFrom?: readonly ArtifactFile[];
  readonly inspection: ArtifactInspection;
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [...filesystemDiagnostics(options.inspection.filesystem)];
  if (!matchesManifestFileTable(options.inspection.files, options.manifest.files)) {
    const changedPaths = options.changedFrom === undefined
      ? []
      : changedArtifactPaths(options.changedFrom, options.inspection.files);
    if (changedPaths.length === 0) {
      diagnostics.push(diagnostic('AB6004', 'Artifact files do not match the manifest.', artifactManifestName));
    } else {
      diagnostics.push(...changedPaths.map((path) =>
        diagnostic('AB6004', `Artifact file changed during validation: ${JSON.stringify(path)}.`, path)));
    }
  }
  diagnostics.push(...validateArtifactOwnership({
    filesystem: options.inspection.filesystem,
    files: options.inspection.files,
    manifest: options.manifest,
    registry: options.registry,
  }));
  return Object.freeze(diagnostics);
};

const validateGeneratedFiles = async (options: {
  readonly artifactRoot: string;
  readonly bundleSyntaxCheck?: ModuleSyntaxCheck;
  readonly files: readonly ArtifactFile[];
  readonly manifestFiles?: readonly ManifestFile[];
  readonly prebuiltPaths?: ReadonlySet<string>;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const generatedFiles = new Set(options.files.map((file) => file.path));
  // Prebuilt payload files are opaque consumer build outputs: they stay
  // hash-locked to the manifest, but their contents are never held to the
  // generated-output contracts (strict JSON, bundled ESM import graphs).
  const prebuiltPaths = options.prebuiltPaths ?? new Set(
    (options.manifestFiles ?? []).filter((file) => file.kind === 'prebuilt').map((file) => file.path),
  );
  const validJson = new Set<string>();

  for (const file of options.files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      const document = JSON.parse(await runWithPlatform(readFileString(resolve(options.artifactRoot, file.path)))) as unknown;
      validJson.add(file.path);
      if (!file.path.includes('/')) {
        for (const mcpPath of localMcpPaths(document)) {
          const generatedPath = posix.join(dirname(file.path), mcpPath);
          if (!generatedFiles.has(generatedPath)) {
            diagnostics.push(diagnostic(
              'AB6007',
              `MCP manifest references missing generated server ${JSON.stringify(mcpPath)}.`,
              file.path,
            ));
          }
        }
      }
    } catch {
      if (!prebuiltPaths.has(file.path)) {
        diagnostics.push(diagnostic('AB6006', 'Generated JSON cannot be parsed.', file.path));
      }
    }
  }

  diagnostics.push(...await validateJavaScriptModules({
    artifactRoot: options.artifactRoot,
    ...(options.bundleSyntaxCheck === undefined ? {} : { bundleSyntaxCheck: options.bundleSyntaxCheck }),
    files: options.files,
    ...(options.manifestFiles === undefined
      ? {}
      : {
        bundledPaths: new Set(options.manifestFiles.filter((file) => file.kind === 'bundle').map((file) => file.path)),
        manifestFiles: new Set(options.manifestFiles.map((file) => file.path)),
      }),
    prebuiltPaths,
    validJson,
  }));

  return Object.freeze(diagnostics);
};

/**
 * The pre-manifest content pass `build` runs over a staged tree before it
 * writes the manifest. The planned manifest file table, when given, tells
 * the JavaScript validator which modules the compiler emitted; without it
 * every module is parsed in full.
 */
export const validateArtifactFiles = async (
  context: ValidateArtifactOptions & { readonly manifestFiles?: readonly ManifestFile[] },
): Promise<readonly Diagnostic[]> => {
  const inspection = await inspectArtifact(context);
  return Object.freeze([
    ...filesystemDiagnostics(inspection.filesystem),
    ...await validateGeneratedFiles({
      artifactRoot: context.artifactRoot,
      ...(context.bundleSyntaxCheck === undefined ? {} : { bundleSyntaxCheck: context.bundleSyntaxCheck }),
      files: inspection.files,
      ...(context.manifestFiles === undefined ? {} : { manifestFiles: context.manifestFiles }),
      ...(context.prebuiltPaths === undefined ? {} : { prebuiltPaths: context.prebuiltPaths }),
    }),
  ]);
};

const invalidArtifactSnapshot = (diagnostics: readonly Diagnostic[]): ValidateArtifactSnapshotResult => Object.freeze({
  diagnostics: Object.freeze([...diagnostics]),
});

const validArtifactSnapshot = (
  manifest: ArtifactManifest,
  runtimeEvidence: RuntimeEvidenceBuilder,
  inspection: ArtifactInspection,
): ValidateArtifactSnapshotResult => Object.freeze({
  diagnostics: Object.freeze([]),
  snapshot: Object.freeze({
    files: Object.freeze([...inspection.files]),
    filesystem: Object.freeze({
      entries: Object.freeze([...inspection.filesystem.entries]),
      files: Object.freeze([...inspection.filesystem.files]),
    }),
    manifest,
    runtime: snapshotRuntimeEvidence(runtimeEvidence),
  }),
});

/**
 * Validates once and returns immutable manifest/runtime evidence only after all
 * structural and target-contract checks pass against that same artifact snapshot.
 */
export const validateArtifactWithSnapshot = async (
  context: ValidateArtifactOptions,
): Promise<ValidateArtifactSnapshotResult> => {
  const artifactRoot = context.artifactRoot;
  const allowEpochStagingMarker = context.allowEpochStagingMarker === true;
  const registry = context.registry ?? createDefaultRegistry();
  const inspectionOptions: ValidateArtifactOptions = allowEpochStagingMarker
    ? { allowEpochStagingMarker: true, artifactRoot }
    : { artifactRoot };
  let inspection: ArtifactInspection;
  try {
    inspection = await inspectArtifact(inspectionOptions);
  } catch {
    return invalidArtifactSnapshot([diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName)]);
  }
  const initialFilesystemDiagnostics = filesystemDiagnostics(inspection.filesystem);
  const rootEntry = inspection.filesystem.entries.find((entry) => entry.path === '.');
  if (rootEntry !== undefined) {
    return invalidArtifactSnapshot([
      ...initialFilesystemDiagnostics,
      diagnostic('AB6000', 'Artifact root is not a readable directory.', artifactManifestName),
    ]);
  }

  const manifestEntry = inspection.filesystem.entries.find((entry) => entry.path === artifactManifestName);
  if (manifestEntry !== undefined && manifestEntry.kind !== 'file') {
    return invalidArtifactSnapshot([
      ...initialFilesystemDiagnostics,
      diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName),
    ]);
  }

  const manifestPath = resolve(artifactRoot, artifactManifestName);
  let manifestSnapshot: ManifestSnapshot;
  try {
    manifestSnapshot = await snapshotManifest(manifestPath);
  } catch {
    return invalidArtifactSnapshot([diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName)]);
  }

  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(manifestSnapshot.bytes.toString('utf8'));
  } catch {
    return invalidArtifactSnapshot([diagnostic('AB6001', 'Artifact manifest is not a strict canonical manifest.', artifactManifestName)]);
  }

  const runtimeEvidence = runtimeEvidenceBuilder();
  const initialStructuralDiagnostics = validateArtifactStructure({ inspection, manifest, registry });
  const diagnostics: Diagnostic[] = [...initialStructuralDiagnostics];
  if (
    manifest.agentSkills.schemaSha256 !== agentSkillsSchemaRevision.schemaSha256 ||
    manifest.agentSkills.sourceRevision !== agentSkillsSchemaRevision.sourceRevision ||
    manifest.agentSkills.specification !== agentSkillsSchemaRevision.specification
  ) {
    diagnostics.push(diagnostic(
      'AB6008',
      'Artifact Agent Skills provenance does not match the pinned schema contract.',
      artifactManifestName,
      undefined,
      artifactDiagnosticRecoveries.AB6008,
    ));
  }
  // Read-only validators over the same immutable inspection run concurrently;
  // collecting in this fixed order keeps the diagnostics sequence deterministic.
  const [
    targetContractDiagnostics,
    portableTargetDiagnostics,
    mcpCoherenceDiagnostics,
    hookCoherenceDiagnostics,
    emittedSkillDiagnostics,
    generatedFileDiagnostics,
  ] = await Promise.all([
    validateTargetContracts({
      artifactRoot,
      files: inspection.files,
      manifest,
      registry,
    }),
    validatePortableTargets({
      artifactRoot,
      filesystem: inspection.filesystem,
      manifest,
      registry,
    }),
    validateMcpCoherence({
      artifactRoot,
      files: inspection.files,
      manifest,
      registry,
      mcpServers: runtimeEvidence.mcpServers,
    }),
    validateHookCoherence({
      artifactRoot,
      files: inspection.files,
      manifest,
      registry,
      hooks: runtimeEvidence.hooks,
    }),
    validateEmittedSkills({
      artifactRoot,
      files: inspection.files,
      manifest,
      registry,
    }),
    validateGeneratedFiles({
      artifactRoot,
      ...(context.bundleSyntaxCheck === undefined ? {} : { bundleSyntaxCheck: context.bundleSyntaxCheck }),
      files: inspection.files,
      manifestFiles: manifest.files,
    }),
  ]);
  diagnostics.push(
    ...targetContractDiagnostics,
    ...portableTargetDiagnostics,
    ...mcpCoherenceDiagnostics,
    ...hookCoherenceDiagnostics,
    ...emittedSkillDiagnostics,
    ...generatedFileDiagnostics,
  );

  let finalInspection: ArtifactInspection | undefined;
  try {
    finalInspection = await inspectArtifact(inspectionOptions);
  } catch {
    finalInspection = undefined;
  }

  let finalManifestSnapshot: ManifestSnapshot | undefined;
  try {
    finalManifestSnapshot = await snapshotManifest(manifestPath);
  } catch {
    finalManifestSnapshot = undefined;
  }
  diagnostics.push(...finalEvidenceDiagnostics({
    ...(finalInspection === undefined ? {} : { finalFilesystem: finalInspection.filesystem }),
    ...(finalManifestSnapshot === undefined ? {} : { finalManifest: finalManifestSnapshot }),
    initialFilesystem: inspection.filesystem,
    initialManifest: manifestSnapshot,
  }));
  return diagnostics.length === 0
    ? validArtifactSnapshot(manifest, runtimeEvidence, inspection)
    : invalidArtifactSnapshot(diagnostics);
};

/**
 * Re-stats and re-digests a staged tree against a prior validated snapshot.
 * Preserves the post-rename integrity gate without re-parsing generated files.
 */
export const recheckValidatedArtifactSnapshot = async (
  snapshot: ValidatedArtifactSnapshot,
  context: ValidateArtifactOptions,
): Promise<readonly Diagnostic[]> => {
  const registry = context.registry ?? createDefaultRegistry();
  let inspection: ArtifactInspection;
  try {
    inspection = await inspectArtifact(context);
  } catch {
    return Object.freeze([diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName)]);
  }
  const diagnostics = [...validateArtifactStructure({
    changedFrom: snapshot.files,
    inspection,
    manifest: snapshot.manifest,
    registry,
  })];
  const expectedManifest = snapshot.filesystem.files.find((file) => file.path === artifactManifestName);
  const stagedManifest = inspection.filesystem.files.find((file) => file.path === artifactManifestName);
  if (
    expectedManifest === undefined ||
    stagedManifest === undefined ||
    !sameArtifactFile(expectedManifest, stagedManifest)
  ) {
    diagnostics.push(diagnostic(
      'AB6004',
      `Artifact file changed during validation: ${JSON.stringify(artifactManifestName)}.`,
      artifactManifestName,
    ));
  }
  return Object.freeze(diagnostics);
};

/** Preserves the established diagnostics-only validation API. */
export const validateArtifact = async (
  context: ValidateArtifactOptions,
): Promise<readonly Diagnostic[]> => (await validateArtifactWithSnapshot(context)).diagnostics;
