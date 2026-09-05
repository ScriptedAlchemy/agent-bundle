import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { portableAdapter } from '../adapters/portable.ts';
import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import type {
  TargetArtifactDocumentIssue,
  TargetArtifactDocumentValidator,
} from '../adapters/types.ts';
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
  artifactManifestName,
  inspectArtifactFilesystem,
  type ArtifactFile,
  type ArtifactFilesystemSnapshot,
  type ManifestFile,
} from './emit.ts';
import { parseArtifactManifest, type ArtifactManifest, type ArtifactManifestHook } from './manifest.ts';
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
import { validateManifestCoherence } from './validate-artifact-manifest.ts';
import { validateMcpCoherence } from './validate-artifact-mcp.ts';
import { manifestTargets, validateEmittedSkills } from './validate-artifact-skills.ts';
import { installSurfaceRequirements } from '../install/surface.ts';

export { artifactDiagnosticRecoveries, type ArtifactDiagnosticCode } from './artifact-diagnostics.ts';
export type * from './artifact-validation-types.ts';

const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';

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
  readonly hooks: readonly ArtifactManifestHook[];
  readonly mcpServers: ValidatedArtifactMcpServerEvidence[];
}

/** The hook rows are the manifest's own (#592 step 3); the MCP evidence is still derived from the host documents. */
const runtimeEvidenceBuilder = (manifest: ArtifactManifest): RuntimeEvidenceBuilder =>
  ({ hooks: manifest.executables.hooks, mcpServers: [] });

const snapshotRuntimeEvidence = (evidence: RuntimeEvidenceBuilder): ValidatedArtifactRuntimeEvidence => Object.freeze({
  hooks: Object.freeze(evidence.hooks.map((hook) => Object.freeze({ ...hook }))),
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
  manifest: ArtifactManifest['projections'][number]['schemas'],
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
  target: ArtifactManifest['projections'][number],
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

/**
 * Every selected projection's contract, checked against the one composite
 * root (#555): the install surface is written once for the whole selection,
 * and each host's documents live at their contract paths inside the root.
 */
const validateTargetContracts = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const files = new Set(options.files.map((file) => file.path));
  const selected = manifestTargets(options.manifest);

  for (const relativePath of installSurfaceRequirements(selected)) {
    if (files.has(relativePath)) continue;
    diagnostics.push(diagnostic(
      relativePath === 'INSTALL.md' ? 'AB6023' : 'AB6024',
      `Artifact is missing required install surface ${JSON.stringify(relativePath)}.`,
      relativePath,
    ));
  }

  for (const target of options.manifest.projections) {
    if (!options.registry.has(target.host)) {
      diagnostics.push(diagnostic(
        'AB6009',
        `Artifact declares unknown target ${JSON.stringify(target.host)}.`,
        artifactManifestName,
        target.host,
      ));
      continue;
    }
    if (!matchesTargetMetadata(target, options.registry.metadata(target.host))) {
      diagnostics.push(diagnostic(
        'AB6010',
        `Artifact metadata for target ${JSON.stringify(target.host)} does not match its registered contract.`,
        artifactManifestName,
        target.host,
      ));
      continue;
    }

    const validation = options.registry.artifactValidation(target.host);
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
            `Target ${JSON.stringify(target.host)} is missing required document ${JSON.stringify(document.path)}.`,
            document.path,
            target.host,
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
            `Target ${JSON.stringify(target.host)} document ${JSON.stringify(generatedPath)} is invalid for schema ${JSON.stringify(document.schema)} at ${issue.instancePath || '/'}: ${issue.message}.`,
            generatedPath,
            target.host,
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
            target: target.host,
          }));
        }
      }
    }
  }
  return Object.freeze(diagnostics);
};

/**
 * Agent Plugins 1.0.0 bytes-at-rest lane (AB6035–AB6037) over the composite
 * root when the built-in portable adapter is among its projections, so a
 * standard-invalid `mcp.json` or layout fails ordinary `build` and
 * `validate --artifact` rather than only `--host-validation`. The lane keys
 * on the registered adapter identity, not the name: an advanced registry may
 * bind `portable` to its own adapter and contract, and that output is
 * validated by its own `artifactValidation`. A tree that already holds a
 * symlink or other unsupported entry (AB6013) is skipped: the byte lane
 * follows `plugin.json`/`mcp.json`/`skills` with `stat`/`readFile`/`readdir`,
 * so it must not touch paths whose containment the filesystem inspection has
 * already refused.
 */
const validatePortableProjection = async (options: {
  readonly artifactRoot: string;
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const portable = options.manifest.projections.find((target) =>
    options.registry.has(target.host) && options.registry.get(target.host) === portableAdapter);
  if (portable === undefined) return Object.freeze([]);
  const unsupported = options.filesystem.entries.some((entry) => entry.kind !== 'directory' && entry.kind !== 'file');
  if (unsupported) return Object.freeze([]);
  const diagnostics: Diagnostic[] = [];
  for (const entry of await validatePortablePluginFiles({
    pluginDirectory: options.artifactRoot,
    target: portable.host,
  })) {
    diagnostics.push(Object.freeze({ ...entry, message: `Target ${JSON.stringify(portable.host)}: ${entry.message}` }));
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
 * True when a selected host's contract admits `path` at the composite root:
 * its emitted layouts, its root documents, its hook and MCP documents, or a
 * document its artifact validation names (#555).
 */
const isProjectionArtifactPath = (
  relativePath: string,
  target: string,
  registry: TargetRegistry,
): boolean => {
  const layout = registry.artifactLayout(target);
  const hookContract = registry.hookContract(target);
  const mcpRuntime = registry.mcpRuntime(target);
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
    relativePath === hookContract?.manifestPath ||
    relativePath === mcpRuntime?.manifestPath ||
    registry.artifactValidation(target).documents.some((document) =>
      matchesArtifactDocumentPath(document.path, relativePath));
};

/**
 * Every file in the composite root must be owned by a selected projection's
 * contract, be a prebuilt payload file, or be artifact metadata; every
 * directory must hold a file. Unknown targets are diagnosed by the
 * target-contract validator, and without their registry contract there is no
 * trustworthy layout to classify files against, so their presence admits
 * every file.
 */
const validateArtifactOwnership = (options: {
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const selected = manifestTargets(options.manifest);
  const known = selected.filter((target) => options.registry.has(target));
  const admitsEverything = known.length !== selected.length;
  const manifestKinds = new Map(options.manifest.files.map((file) => [file.path, file.kind]));

  for (const file of options.files) {
    if (admitsEverything) continue;
    if (known.some((target) => isProjectionArtifactPath(file.path, target, options.registry))) continue;
    // Prebuilt payload files live in config-named directories under the
    // root, so no emitted layout describes them.
    if (manifestKinds.get(file.path) === 'prebuilt') continue;
    diagnostics.push(diagnostic(
      'AB6014',
      `Artifact file ${JSON.stringify(file.path)} is outside the emitted layouts of the selected targets.`,
      file.path,
      undefined,
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
        undefined,
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
  // Prebuilt payload files are opaque consumer build outputs: they stay
  // hash-locked to the manifest, but their contents are never held to the
  // generated-output contracts (strict JSON, bundled ESM import graphs).
  const prebuiltPaths = options.prebuiltPaths ?? new Set(
    (options.manifestFiles ?? []).filter((file) => file.kind === 'prebuilt').map((file) => file.path),
  );
  const validJson = new Set<string>();

  for (const file of options.files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      // Strict parseability only: host MCP documents are read against the
      // compiled entries by validateMcpCoherence.
      JSON.parse(await runWithPlatform(readFileString(resolve(options.artifactRoot, file.path))));
      validJson.add(file.path);
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

  const runtimeEvidence = runtimeEvidenceBuilder(manifest);
  const initialStructuralDiagnostics = validateArtifactStructure({ inspection, manifest, registry });
  // The manifest coherence lane (AB6039/AB6040) reads host documents as the
  // bytes the manifest hashed; over a tree that already disagrees with the
  // file table (AB6004) its findings would only restate that drift.
  const fileTableVerified = !initialStructuralDiagnostics.some((entry) => entry.code === 'AB6004');
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
    manifestCoherenceDiagnostics,
    emittedSkillDiagnostics,
    generatedFileDiagnostics,
  ] = await Promise.all([
    validateTargetContracts({
      artifactRoot,
      files: inspection.files,
      manifest,
      registry,
    }),
    validatePortableProjection({
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
    }),
    fileTableVerified
      ? validateManifestCoherence({ artifactRoot, manifest, registry })
      : Promise.resolve(Object.freeze([])),
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
    ...manifestCoherenceDiagnostics,
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
