import { lstat, readFile, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, posix, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseJavaScript } from 'acorn';
import { init, parse } from 'es-module-lexer';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import {
  compilerHookWrapperPath,
  generatedHookCommand,
  readTargetNativeHookCommands,
} from '../adapters/hook-contract.ts';
import type {
  TargetArtifactDocumentIssue,
  TargetArtifactDocumentValidator,
  TargetArtifactOutputLayout,
} from '../adapters/types.ts';
import { parseSkillMarkdown, referencedResources } from '../config/skill-references.ts';
import { DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { agentSkillsSchemaRevision, validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';
import { classifyMcpArtifactArgument } from '../services/mcp-artifact-reference.ts';
import { parseArtifactHookIndex } from '../services/hook-index.ts';
import { resolveMcpPathTokens } from '../services/mcp-path-tokens.ts';
import { readTargetMcpServers } from '../services/mcp-runtime.ts';
import {
  artifactHookIndexName,
  artifactManifestName,
  inspectArtifactFilesystem,
  type ArtifactFile,
  type ArtifactFilesystemSnapshot,
  type ArtifactHook,
  type ArtifactHookIndex,
  type ManifestFile,
} from './emit.ts';
import { parseArtifactManifest, type ArtifactManifestV2 } from './manifest.ts';

const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';
const artifactRootMetadata = new Set([artifactHookIndexName]);

export interface ValidateArtifactOptions {
  /** Enables the one store-owned epoch staging marker after its exact schema validates. */
  readonly allowEpochStagingMarker?: true;
  readonly artifactRoot: string;
  /** Target contracts that produced and must validate this artifact. */
  readonly registry?: TargetRegistry;
}

/** Safe runtime facts derived during the same validation pass as the manifest. */
export interface ValidatedArtifactRuntimeEvidence {
  readonly hooks: readonly ArtifactHook[];
  readonly mcpServers: readonly ValidatedArtifactMcpServerEvidence[];
}

/** One non-secret modern MCP server fact validated against manifested target files. */
export interface ValidatedArtifactMcpServerEvidence {
  readonly entryPaths: readonly string[];
  readonly kind: 'stdio' | 'streamable-http';
  readonly manifestPath: string;
  readonly name: string;
  readonly target: string;
}

/** Deeply frozen artifact evidence that passed one complete validation pass. */
export interface ValidatedArtifactSnapshot {
  readonly manifest: ArtifactManifestV2;
  readonly runtime: ValidatedArtifactRuntimeEvidence;
}

/** Validation diagnostics plus immutable evidence only when no diagnostics were found. */
export interface ValidateArtifactSnapshotResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly snapshot?: ValidatedArtifactSnapshot;
}

export type ArtifactDiagnosticCode =
  | 'AB6000'
  | 'AB6001'
  | 'AB6002'
  | 'AB6003'
  | 'AB6004'
  | 'AB6005'
  | 'AB6006'
  | 'AB6007'
  | 'AB6008'
  | 'AB6009'
  | 'AB6010'
  | 'AB6011'
  | 'AB6012'
  | 'AB6013'
  | 'AB6014'
  | 'AB6015'
  | 'AB6016'
  | 'AB6017'
  | 'AB6018';

export const artifactDiagnosticRecoveries: Readonly<Record<ArtifactDiagnosticCode, string>> = Object.freeze({
  AB6000: 'Restore a readable artifact root and canonical manifest, then rebuild the artifact.',
  AB6001: 'Regenerate the strict canonical v2 manifest without concurrent writes, then rerun validation.',
  AB6002: 'Rebuild the artifact from complete project source, then rerun validation.',
  AB6003: 'Rebuild the artifact with canonical generated output, then rerun validation.',
  AB6004: 'Rebuild the artifact so its file table and contents match the manifest.',
  AB6005: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
  AB6006: 'Regenerate the affected JSON document as valid JSON, then rebuild the artifact.',
  AB6007: 'Repair MCP manifest references to generated servers, then rebuild the artifact.',
  AB6008: 'Rebuild the artifact with the pinned Agent Skills contract.',
  AB6009: 'Rebuild the artifact with a registered target.',
  AB6010: 'Rebuild the artifact with the current target registry.',
  AB6011: 'Generate the required target document, then rebuild the artifact.',
  AB6012: 'Correct the target document source so it satisfies its schema, then rebuild the artifact.',
  AB6013: 'Remove unsupported filesystem entries and rebuild the artifact.',
  AB6014: 'Rebuild the artifact with files only in declared target namespaces.',
  AB6015: 'Restore canonical Skill Markdown and copied resources, then rebuild the artifact.',
  AB6016: 'Copy every referenced Skill resource inside its Skill root, then rebuild the artifact.',
  AB6017: 'Rebuild the artifact so every target MCP manifest references its exact compiler outputs.',
  AB6018: 'Rebuild the artifact so native hook commands and hook metadata agree.',
});

const isArtifactDiagnosticCode = (code: string): code is ArtifactDiagnosticCode =>
  Object.hasOwn(artifactDiagnosticRecoveries, code);

const recoveryForArtifactDiagnostic = (code: string): string =>
  isArtifactDiagnosticCode(code)
    ? artifactDiagnosticRecoveries[code]
    : 'Repair the target MCP configuration and rebuild the artifact.';

const diagnostic = (
  code: string,
  message: string,
  generatedPath?: string,
  target?: string,
  recovery = recoveryForArtifactDiagnostic(code),
): Diagnostic => ({
  code,
  generatedPath,
  message,
  recovery,
  severity: 'error',
  ...(target === undefined ? {} : { target }),
});

const javaScriptModuleSuffix = /\.(?:m?js)$/u;
const generatedJavaScriptRecovery = artifactDiagnosticRecoveries.AB6005;

const jsonModuleSuffix = /\.json$/u;

const artifactPathFor = (root: string, path: string): string | undefined => {
  const artifactPath = relative(root, path).replaceAll('\\', '/');
  return artifactPath === '' || artifactPath === '..' || artifactPath.startsWith('../') || isAbsolute(artifactPath)
    ? undefined
    : artifactPath;
};

const graphDiagnostic = (importer: string, message: string): Diagnostic => diagnostic(
  'AB6005',
  `Generated JavaScript import from ${JSON.stringify(importer)} ${message}`,
  importer,
  undefined,
  generatedJavaScriptRecovery,
);

const resolveJavaScriptImport = async (options: {
  readonly artifactRoot: string;
  readonly files: ReadonlyMap<string, ArtifactFile>;
  readonly importer: string;
  readonly specifier: string;
  readonly validJson: ReadonlySet<string>;
}): Promise<{ readonly diagnostic?: Diagnostic; readonly module?: string }> => {
  if (isBuiltin(options.specifier)) return {};
  if (!options.specifier.startsWith('.') && !options.specifier.startsWith('file:')) {
    return { diagnostic: graphDiagnostic(options.importer, `uses unsupported specifier ${JSON.stringify(options.specifier)}.`) };
  }

  let url: URL;
  try {
    url = new URL(options.specifier, pathToFileURL(resolve(options.artifactRoot, options.importer)));
  } catch {
    return { diagnostic: graphDiagnostic(options.importer, `uses invalid specifier ${JSON.stringify(options.specifier)}.`) };
  }
  if (url.protocol !== 'file:' || url.search.length > 0 || url.hash.length > 0) {
    return { diagnostic: graphDiagnostic(options.importer, `uses unsupported specifier ${JSON.stringify(options.specifier)}.`) };
  }

  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return { diagnostic: graphDiagnostic(options.importer, `uses invalid file URL ${JSON.stringify(options.specifier)}.`) };
  }
  if (artifactPathFor(options.artifactRoot, path) === undefined) {
    return { diagnostic: graphDiagnostic(options.importer, `resolves outside the artifact root: ${JSON.stringify(options.specifier)}.`) };
  }

  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    return { diagnostic: graphDiagnostic(options.importer, `is missing ${JSON.stringify(options.specifier)}.`) };
  }
  if (!metadata.isFile()) {
    return { diagnostic: graphDiagnostic(options.importer, `does not resolve to a regular file: ${JSON.stringify(options.specifier)}.`) };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    return { diagnostic: graphDiagnostic(options.importer, `is missing ${JSON.stringify(options.specifier)}.`) };
  }
  const artifactPath = artifactPathFor(options.artifactRoot, canonicalPath);
  if (artifactPath === undefined) {
    return { diagnostic: graphDiagnostic(options.importer, `resolves outside the artifact root: ${JSON.stringify(options.specifier)}.`) };
  }
  if (!options.files.has(artifactPath)) {
    return { diagnostic: graphDiagnostic(options.importer, `is not listed in the artifact manifest: ${JSON.stringify(options.specifier)}.`) };
  }
  if (jsonModuleSuffix.test(artifactPath)) {
    return options.validJson.has(artifactPath)
      ? {}
      : { diagnostic: graphDiagnostic(options.importer, `references invalid JSON ${JSON.stringify(options.specifier)}.`) };
  }
  if (!javaScriptModuleSuffix.test(artifactPath)) {
    return { diagnostic: graphDiagnostic(options.importer, `uses unsupported target ${JSON.stringify(options.specifier)}.`) };
  }
  return { module: artifactPath };
};

const validateJavaScriptModules = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifestFiles?: ReadonlySet<string>;
  readonly validJson: ReadonlySet<string>;
}): Promise<readonly Diagnostic[]> => {
  await init;
  const artifactRoot = await realpath(options.artifactRoot);
  const files = new Map(options.files
    .filter((file) => options.manifestFiles === undefined || options.manifestFiles.has(file.path))
    .map((file) => [file.path, file]));
  const diagnostics: Diagnostic[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const validateModule = async (path: string): Promise<void> => {
    if (visited.has(path) || visiting.has(path)) return;
    visiting.add(path);
    let source: string;
    try {
      source = await readFile(resolve(artifactRoot, path), 'utf8');
    } catch {
      diagnostics.push(graphDiagnostic(path, 'cannot be read.'));
      visiting.delete(path);
      visited.add(path);
      return;
    }

    let imports: ReturnType<typeof parse>[0];
    try {
      parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' });
      [imports] = parse(source);
    } catch {
      diagnostics.push(graphDiagnostic(path, 'has invalid syntax.'));
      visiting.delete(path);
      visited.add(path);
      return;
    }
    for (const imported of imports) {
      if (imported.d === -2) continue;
      if (imported.n === undefined) {
        diagnostics.push(graphDiagnostic(path, 'has a non-literal dynamic import.'));
        continue;
      }
      const resolved = await resolveJavaScriptImport({
        artifactRoot,
        files,
        importer: path,
        specifier: imported.n,
        validJson: options.validJson,
      });
      if (resolved.diagnostic !== undefined) diagnostics.push(resolved.diagnostic);
      else if (resolved.module !== undefined) await validateModule(resolved.module);
    }
    visiting.delete(path);
    visited.add(path);
  };

  for (const path of [...files.keys()].filter((path) => javaScriptModuleSuffix.test(path)).sort((left, right) => left.localeCompare(right))) {
    await validateModule(path);
  }
  return Object.freeze(diagnostics);
};

const sameFile = (left: ArtifactFile, right: ManifestFile): boolean =>
  left.bytes === right.bytes &&
  (right.mode === undefined ? (left.mode & 0o111) === 0 : left.mode === right.mode) &&
  left.path === right.path &&
  left.sha256 === right.sha256;

const matchesManifestFileTable = (
  files: readonly ArtifactFile[],
  manifestFiles: readonly ManifestFile[],
): boolean => {
  if (files.length !== manifestFiles.length) return false;
  const manifestFilesByPath = new Map(manifestFiles.map((file) => [file.path, file]));
  return files.every((file) => {
    const manifestFile = manifestFilesByPath.get(file.path);
    return manifestFile !== undefined && sameFile(file, manifestFile);
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
  return /^mcp\/mcp-[a-z0-9-]+-[a-f\d]{8}\.mjs$/u.test(relative) ? relative : undefined;
};

const localMcpPaths = (document: unknown): readonly string[] => {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return [];
  const servers = (document as { readonly mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return [];
  return Object.values(servers).flatMap((server) => {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) return [];
    const args = (server as { readonly args?: unknown }).args;
    return Array.isArray(args) ? [localMcpArgument(args[0])].filter((path): path is string => path !== undefined) : [];
  });
};

const isEpochStagingMarker = (value: string): boolean => {
  try {
    const marker: unknown = JSON.parse(value);
    if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return false;
    if (!('token' in marker) || !('version' in marker)) return false;
    const entries = Object.entries(marker);
    return entries.length === 2 &&
      marker.version === 1 &&
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
        await readFile(resolve(context.artifactRoot, epochStagingMarkerName), 'utf8'),
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
  manifest: ArtifactManifestV2['targets'][number]['schemas'],
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
  target: ArtifactManifestV2['targets'][number],
  metadata: ReturnType<TargetRegistry['metadata']>,
): boolean => target.adapterRevision === metadata.adapterRevision &&
  target.capabilityRevision === metadata.capabilityRevision &&
  target.capabilitySha256 === metadata.capabilitySha256 &&
  target.observedVersion === metadata.observedVersion &&
  sameSchemas(target.schemas, metadata.schemas);

const schemaValidationFailure = (): readonly TargetArtifactDocumentIssue[] => Object.freeze([
  Object.freeze({ instancePath: '/', message: 'schema validation failed' }),
]);

const snapshotSchemaIssue = (value: unknown): TargetArtifactDocumentIssue | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return undefined;
  const instancePath = descriptors.instancePath;
  const message = descriptors.message;
  if (
    instancePath === undefined ||
    message === undefined ||
    !('value' in instancePath) ||
    !('value' in message) ||
    typeof instancePath.value !== 'string' ||
    typeof message.value !== 'string' ||
    Object.hasOwn(descriptors, 'then')
  ) {
    return undefined;
  }
  return Object.freeze({ instancePath: instancePath.value, message: message.value });
};

const snapshotSchemaIssues = (value: unknown): readonly TargetArtifactDocumentIssue[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.hasOwn(value, 'then')) {
    return schemaValidationFailure();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return schemaValidationFailure();
  }
  const issues: TargetArtifactDocumentIssue[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const entry = descriptors[index];
    if (entry === undefined || !('value' in entry)) return schemaValidationFailure();
    const issue = snapshotSchemaIssue(entry.value);
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

const validateTargetContracts = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifestV2;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const files = new Set(options.files.map((file) => file.path));

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

    const validation = options.registry.artifactValidation(target.name);
    const validators = new Map(validation.schemas.map((schema) => [schema.name, schema.validate]));
    for (const document of validation.documents) {
      const generatedPath = `${target.name}/${document.path}`;
      if (!files.has(generatedPath)) {
        if (document.required) {
          diagnostics.push(diagnostic(
            'AB6011',
            `Target ${JSON.stringify(target.name)} is missing required document ${JSON.stringify(document.path)}.`,
            generatedPath,
            target.name,
          ));
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(resolve(options.artifactRoot, generatedPath), 'utf8')) as unknown;
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
          `Target ${JSON.stringify(target.name)} document ${JSON.stringify(document.path)} is invalid for schema ${JSON.stringify(document.schema)} at ${issue.instancePath || '/'}: ${issue.message}.`,
          generatedPath,
          target.name,
        ));
      }
    }
  }
  return Object.freeze(diagnostics);
};

const mcpCoherenceRecovery = artifactDiagnosticRecoveries.AB6017;
const hookCoherenceRecovery = artifactDiagnosticRecoveries.AB6018;

const coherenceDiagnostic = (
  code: 'AB6017' | 'AB6018',
  message: string,
  generatedPath: string,
  target: string,
  recovery: string,
): Diagnostic => diagnostic(code, message, generatedPath, target, recovery);

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

const targetArtifactPath = (target: string, path: string): string => `${target}/${path}`;

const isTargetContainedCwd = (artifactRoot: string, targetRoot: string, value: string): boolean => {
  const localPath = mcpArtifactPathApi.sep === '/'
    ? value.replaceAll('\\', '/')
    : value.replaceAll('/', '\\');
  return value === '.' || value === './' || value === '.\\' ||
    (mcpArtifactPathApi.isAbsolute(localPath) && mcpArtifactPathApi.resolve(localPath) === targetRoot) ||
    classifyMcpArtifactArgument({
      path: mcpArtifactPathApi,
      roots: { artifactRoot, targetRoot },
      value,
    }).status === 'artifact-local';
};

interface McpReferenceOccurrence {
  readonly field: 'argument' | 'command';
  readonly server: string;
}

const recordMcpReference = (
  references: Map<string, McpReferenceOccurrence[]>,
  path: string,
  occurrence: McpReferenceOccurrence,
): void => {
  const occurrences = references.get(path);
  if (occurrences !== undefined) occurrences.push(occurrence);
};

const pathInOutputLayout = (
  targetPath: string,
  target: string,
  layout: TargetArtifactOutputLayout | undefined,
): boolean => isDirectLayoutPath(targetPath.slice(target.length + 1), layout);

const validateMcpArtifactReference = (options: {
  readonly artifactRoot: string;
  readonly directExecutable: boolean;
  readonly field: 'argument' | 'command';
  readonly files: ReadonlyMap<string, ArtifactFile>;
  readonly manifestFiles: ReadonlyMap<string, ManifestFile>;
  readonly manifestPath: string;
  readonly target: string;
  readonly targetRoot: string;
  readonly value: string;
}): readonly Diagnostic[] => {
  const reference = classifyMcpArtifactArgument({
    path: mcpArtifactPathApi,
    roots: { artifactRoot: options.artifactRoot, targetRoot: options.targetRoot },
    value: options.value,
  });
  if (reference.status === 'external') return Object.freeze([]);
  if (reference.status === 'escaped') {
    return Object.freeze([coherenceDiagnostic(
      'AB6017',
      `MCP ${options.field} ${JSON.stringify(options.value)} escapes target ${JSON.stringify(options.target)}.`,
      options.manifestPath,
      options.target,
      mcpCoherenceRecovery,
    )]);
  }

  const path = targetArtifactPath(options.target, reference.path);
  const file = options.files.get(path);
  const manifestFile = options.manifestFiles.get(path);
  const diagnostics: Diagnostic[] = [];
  if (file === undefined || manifestFile === undefined || !sameFile(file, manifestFile)) {
    if (options.field === 'argument' && file === undefined && manifestFile !== undefined) {
      diagnostics.push(diagnostic(
        'AB6007',
        `MCP manifest references missing generated server ${JSON.stringify(options.value)}.`,
        options.manifestPath,
      ));
    } else {
      diagnostics.push(coherenceDiagnostic(
        'AB6017',
        `MCP ${options.field} ${JSON.stringify(options.value)} references missing or unmanifested artifact file ${JSON.stringify(path)}.`,
        options.manifestPath,
        options.target,
        mcpCoherenceRecovery,
      ));
    }
  } else if (options.directExecutable && (manifestFile.mode === undefined || (manifestFile.mode & 0o111) === 0)) {
    diagnostics.push(coherenceDiagnostic(
      'AB6017',
      `MCP command ${JSON.stringify(options.value)} references non-executable artifact file ${JSON.stringify(path)}.`,
      options.manifestPath,
      options.target,
      mcpCoherenceRecovery,
    ));
  }

  return Object.freeze(diagnostics);
};

const validateMcpCoherence = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifestV2;
  readonly registry: TargetRegistry;
  readonly runtimeEvidence: RuntimeEvidenceBuilder;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const files = new Map(options.files.map((file) => [file.path, file]));
  const manifestFiles = new Map(options.manifest.files.map((file) => [file.path, file]));
  const artifactRoot = resolve(options.artifactRoot);

  for (const target of options.manifest.targets) {
    if (!options.registry.has(target.name) || !options.registry.supports(target.name, 'mcp')) continue;
    const runtime = options.registry.mcpRuntime(target.name);
    if (runtime === undefined) continue;
    const manifestPath = targetArtifactPath(target.name, runtime.manifestPath);
    const targetRoot = resolve(artifactRoot, target.name);
    const mcpLayout = options.registry.artifactLayout(target.name).mcpEntries;
    const referenceCounts = new Map<string, McpReferenceOccurrence[]>();
    const mcpEntries = options.files.filter((file) => pathInOutputLayout(file.path, target.name, mcpLayout));
    for (const file of mcpEntries) referenceCounts.set(file.path, []);

    const manifestFile = files.get(manifestPath);
    if (manifestFile !== undefined) {
      let document: unknown;
      try {
        document = parseJsonWithoutDuplicateKeys(await readFile(resolve(artifactRoot, manifestPath), 'utf8'));
      } catch {
        diagnostics.push(coherenceDiagnostic(
          'AB6017',
          `MCP manifest for target ${JSON.stringify(target.name)} is not valid strict JSON.`,
          manifestPath,
          target.name,
          mcpCoherenceRecovery,
        ));
        document = undefined;
      }
      if (document !== undefined) {
        const servers = readTargetMcpServers(runtime, document);
        if (servers.status === 'invalid') {
          diagnostics.push(coherenceDiagnostic(
            'AB6017',
            `MCP manifest for target ${JSON.stringify(target.name)} does not contain only modern supported servers.`,
            manifestPath,
            target.name,
            mcpCoherenceRecovery,
          ));
        } else {
          for (const entry of servers.servers) {
            let server = entry.server;
            try {
              server = resolveMcpPathTokens({
                roots: {
                  pluginData: targetRoot,
                  pluginRoot: targetRoot,
                  workspaceRoot: dirname(artifactRoot),
                },
                runtime,
                server,
                target: target.name,
              });
            } catch (error) {
              if (error instanceof DiagnosticError) {
                diagnostics.push(...error.diagnostics.map((entry) => diagnostic(
                  entry.code,
                  entry.message,
                  manifestPath,
                  target.name,
                  mcpCoherenceRecovery,
                )));
              } else {
                diagnostics.push(coherenceDiagnostic(
                  'AB6017',
                  `MCP server ${JSON.stringify(entry.name)} could not resolve target runtime values.`,
                  manifestPath,
                  target.name,
                  mcpCoherenceRecovery,
                ));
              }
              continue;
            }
            const entryPaths = new Set<string>();
            if (server.kind !== 'stdio') {
              options.runtimeEvidence.mcpServers.push(Object.freeze({
                entryPaths: Object.freeze([]),
                kind: server.kind,
                manifestPath,
                name: entry.name,
                target: target.name,
              }));
              continue;
            }

            if (server.cwd !== undefined) {
              if (!isTargetContainedCwd(artifactRoot, targetRoot, server.cwd)) {
                diagnostics.push(coherenceDiagnostic(
                  'AB6017',
                  `MCP cwd ${JSON.stringify(server.cwd)} escapes target ${JSON.stringify(target.name)}.`,
                  manifestPath,
                  target.name,
                  mcpCoherenceRecovery,
                ));
              }
            }

            if (!server.command.includes('${')) {
              diagnostics.push(...validateMcpArtifactReference({
                artifactRoot,
                directExecutable: true,
                field: 'command',
                files,
                manifestFiles,
                manifestPath,
                target: target.name,
                targetRoot,
                value: server.command,
              }));
              const commandReference = classifyMcpArtifactArgument({
                path: mcpArtifactPathApi,
                roots: { artifactRoot, targetRoot },
                value: server.command,
              });
              if (commandReference.status === 'artifact-local') {
                const path = targetArtifactPath(target.name, commandReference.path);
                recordMcpReference(referenceCounts, path, { field: 'command', server: entry.name });
                entryPaths.add(path);
              }
            }

            for (const argument of server.args) {
              diagnostics.push(...validateMcpArtifactReference({
                artifactRoot,
                directExecutable: false,
                field: 'argument',
                files,
                manifestFiles,
                manifestPath,
                target: target.name,
                targetRoot,
                value: argument,
              }));
              const argumentReference = classifyMcpArtifactArgument({
                path: mcpArtifactPathApi,
                roots: { artifactRoot, targetRoot },
                value: argument,
              });
              if (argumentReference.status === 'artifact-local') {
                const path = targetArtifactPath(target.name, argumentReference.path);
                recordMcpReference(referenceCounts, path, { field: 'argument', server: entry.name });
                entryPaths.add(path);
              }
            }
            options.runtimeEvidence.mcpServers.push(Object.freeze({
              entryPaths: Object.freeze([...entryPaths].sort((left, right) => left.localeCompare(right))),
              kind: server.kind,
              manifestPath,
              name: entry.name,
              target: target.name,
            }));
          }
        }
      }
    }

    for (const [path, occurrences] of referenceCounts) {
      if (occurrences.length === 1) continue;
      diagnostics.push(coherenceDiagnostic(
        'AB6017',
        occurrences.length === 0
          ? `Compiler MCP entry ${JSON.stringify(path)} is not referenced by a server in target ${JSON.stringify(target.name)}.`
          : `Compiler MCP entry ${JSON.stringify(path)} is referenced ${occurrences.length} times in target ${JSON.stringify(target.name)}.`,
        path,
        target.name,
        mcpCoherenceRecovery,
      ));
    }
  }
  return Object.freeze(diagnostics);
};

const readArtifactHookIndex = async (artifactRoot: string): Promise<ArtifactHookIndex | undefined> => {
  try {
    return parseArtifactHookIndex(await readFile(resolve(artifactRoot, artifactHookIndexName), 'utf8'));
  } catch {
    return undefined;
  }
};

const validateHookCoherence = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifestV2;
  readonly registry: TargetRegistry;
  readonly runtimeEvidence: RuntimeEvidenceBuilder;
}): Promise<readonly Diagnostic[]> => {
  const indexFile = options.files.find((file) => file.path === artifactHookIndexName);
  const index = indexFile === undefined ? undefined : await readArtifactHookIndex(options.artifactRoot);
  if (index === undefined) {
    return Object.freeze([coherenceDiagnostic(
      'AB6018',
      'Artifact hook metadata is not strict canonical hook index data.',
      artifactHookIndexName,
      'artifact',
      hookCoherenceRecovery,
    )]);
  }

  options.runtimeEvidence.hooks.push(...index.hooks);

  const diagnostics: Diagnostic[] = [];
  const files = new Map(options.files.map((file) => [file.path, file]));
  const manifestFiles = new Map(options.manifest.files.map((file) => [file.path, file]));
  const targets = new Set(options.manifest.targets.map((target) => target.name));
  const indexedByTarget = new Map<string, typeof index.hooks>();
  for (const hook of index.hooks) {
    const entries = indexedByTarget.get(hook.target) ?? [];
    indexedByTarget.set(hook.target, [...entries, hook]);
  }

  for (const hook of index.hooks) {
    if (!targets.has(hook.target) || (options.registry.has(hook.target) && !options.registry.supports(hook.target, 'hooks'))) {
      diagnostics.push(coherenceDiagnostic(
        'AB6018',
        `Hook index entry ${JSON.stringify(hook.id)} selects undeclared or hook-incompatible target ${JSON.stringify(hook.target)}.`,
        artifactHookIndexName,
        hook.target,
        hookCoherenceRecovery,
      ));
      continue;
    }
    if (!options.registry.has(hook.target)) continue;
    const contract = options.registry.hookContract(hook.target);
    const layout = options.registry.artifactLayout(hook.target).hookWrappers;
    const expectedPrefix = `${hook.target}/`;
    const file = files.get(hook.path);
    const manifestFile = manifestFiles.get(hook.path);
    if (
      contract === undefined ||
      !hook.path.startsWith(expectedPrefix) ||
      !pathInOutputLayout(hook.path, hook.target, layout) ||
      file === undefined ||
      manifestFile === undefined ||
      !sameFile(file, manifestFile)
    ) {
      diagnostics.push(coherenceDiagnostic(
        'AB6018',
        `Hook index entry ${JSON.stringify(hook.id)} references missing or invalid target wrapper ${JSON.stringify(hook.path)}.`,
        hook.path,
        hook.target,
        hookCoherenceRecovery,
      ));
    }
  }

  for (const { name: target } of options.manifest.targets) {
    if (!options.registry.has(target) || !options.registry.supports(target, 'hooks')) continue;
    const contract = options.registry.hookContract(target);
    if (contract === undefined) continue;
    const hooks = indexedByTarget.get(target) ?? [];
    const manifestPath = targetArtifactPath(target, contract.manifestPath);
    if (!files.has(manifestPath)) {
      if (hooks.length === 0) continue;
      diagnostics.push(coherenceDiagnostic(
        'AB6018',
        `Hook index target ${JSON.stringify(target)} is missing native hook manifest ${JSON.stringify(contract.manifestPath)}.`,
        manifestPath,
        target,
        hookCoherenceRecovery,
      ));
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(await readFile(resolve(options.artifactRoot, manifestPath), 'utf8'));
    } catch {
      diagnostics.push(coherenceDiagnostic(
        'AB6018',
        `Hook index target ${JSON.stringify(target)} is missing native hook manifest ${JSON.stringify(contract.manifestPath)}.`,
        manifestPath,
        target,
        hookCoherenceRecovery,
      ));
      continue;
    }
    const commands = readTargetNativeHookCommands(contract, document);
    if (commands.status === 'invalid') {
      diagnostics.push(coherenceDiagnostic(
        'AB6018',
        `Native hook manifest ${JSON.stringify(contract.manifestPath)} for target ${JSON.stringify(target)} is invalid for command enumeration.`,
        manifestPath,
        target,
        hookCoherenceRecovery,
      ));
      continue;
    }
    const relativePaths = new Map<string, number>();
    for (const hook of hooks) {
      const relativePath = hook.path.slice(target.length + 1);
      relativePaths.set(relativePath, (relativePaths.get(relativePath) ?? 0) + 1);
      const command = generatedHookCommand(contract, relativePath);
      const occurrences = commands.commands.filter((candidate) => candidate.command === command).length;
      if (occurrences !== 1) {
        diagnostics.push(coherenceDiagnostic(
          'AB6018',
          `Hook index entry ${JSON.stringify(hook.id)} requires exactly one native command ${JSON.stringify(command)} but found ${occurrences}.`,
          manifestPath,
          target,
          hookCoherenceRecovery,
        ));
      }
    }
    for (const command of commands.commands) {
      const relativePath = compilerHookWrapperPath(contract, command.command);
      if (relativePath === undefined) continue;
      const entries = relativePaths.get(relativePath) ?? 0;
      if (entries === 1) continue;
      diagnostics.push(coherenceDiagnostic(
        'AB6018',
        entries === 0
          ? `Native hook command ${JSON.stringify(command.command)} is not indexed.`
          : `Native hook command ${JSON.stringify(command.command)} is indexed multiple times.`,
        manifestPath,
        target,
        hookCoherenceRecovery,
      ));
    }
  }
  return Object.freeze(diagnostics);
};

const ownershipRecovery = artifactDiagnosticRecoveries.AB6014;

const targetNamespaces = (manifest: ArtifactManifestV2): ReadonlySet<string> =>
  new Set(manifest.targets.map((target) => target.name));

const pathTarget = (path: string, targets: ReadonlySet<string>): string | undefined => {
  const [target] = path.split('/');
  return target !== undefined && targets.has(target) ? target : undefined;
};

const isDirectLayoutPath = (relativePath: string, layout: TargetArtifactOutputLayout | undefined): boolean => {
  if (layout === undefined) return false;
  const [directory, file, ...nested] = relativePath.split('/');
  return directory === layout.directory &&
    file !== undefined &&
    nested.length === 0 &&
    layout.allowedSuffixes.some((suffix) => file.length > suffix.length && file.endsWith(suffix));
};

const isSkillArtifactPath = (relativePath: string, skills: string | undefined): boolean => {
  if (skills === undefined) return false;
  const [layout, name, resource] = relativePath.split('/');
  return layout === skills && name !== undefined && resource !== undefined;
};

const isTargetArtifactPath = (
  path: string,
  target: string,
  registry: TargetRegistry,
): boolean => {
  const relativePath = path.slice(target.length + 1);
  // Unknown targets are diagnosed by the target-contract validator; without their
  // registry contract there is no trustworthy layout against which to classify files.
  if (!registry.has(target)) return true;
  const layout = registry.artifactLayout(target);
  const hookContract = registry.hookContract(target);
  const mcpRuntime = registry.mcpRuntime(target);
  return isDirectLayoutPath(relativePath, layout.hookWrappers) ||
    isDirectLayoutPath(relativePath, layout.mcpApps) ||
    isDirectLayoutPath(relativePath, layout.mcpEntries) ||
    isDirectLayoutPath(relativePath, layout.scripts) ||
    isSkillArtifactPath(relativePath, layout.skills) ||
    relativePath === hookContract?.manifestPath ||
    relativePath === mcpRuntime?.manifestPath ||
    registry.artifactValidation(target).documents.some((document) => document.path === relativePath);
};

const validateArtifactOwnership = (options: {
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifestV2;
  readonly registry: TargetRegistry;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const targets = targetNamespaces(options.manifest);

  for (const file of options.files) {
    if (artifactRootMetadata.has(file.path)) continue;
    const target = pathTarget(file.path, targets);
    if (target !== undefined && isTargetArtifactPath(file.path, target, options.registry)) continue;
    diagnostics.push(diagnostic(
      'AB6014',
      `Artifact file ${JSON.stringify(file.path)} is outside declared target emitted layouts.`,
      file.path,
      target,
      ownershipRecovery,
    ));
  }

  for (const entry of options.filesystem.entries) {
    if (entry.kind !== 'directory' || entry.path === '.') continue;
    const target = pathTarget(entry.path, targets);
    if (!entry.path.includes('/') && !targets.has(entry.path)) {
      diagnostics.push(diagnostic(
        'AB6014',
        `Artifact directory ${JSON.stringify(entry.path)} does not name a declared target namespace.`,
        entry.path,
        undefined,
        ownershipRecovery,
      ));
      continue;
    }
    if (!options.files.some((file) => file.path.startsWith(`${entry.path}/`))) {
      diagnostics.push(diagnostic(
        'AB6014',
        `Artifact directory ${JSON.stringify(entry.path)} is empty.`,
        entry.path,
        target,
        ownershipRecovery,
      ));
    }
  }

  for (const target of options.manifest.targets) {
    if (!options.files.some((file) => file.path.startsWith(`${target.name}/`))) {
      diagnostics.push(diagnostic(
        'AB6014',
        `Declared target ${JSON.stringify(target.name)} has no emitted namespace.`,
        target.name,
        target.name,
        ownershipRecovery,
      ));
    }
  }

  return Object.freeze(diagnostics);
};

const validateArtifactStructure = (options: {
  readonly changedFrom?: readonly ArtifactFile[];
  readonly inspection: ArtifactInspection;
  readonly manifest: ArtifactManifestV2;
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

interface EmittedSkill {
  readonly name: string;
  readonly path: string;
  readonly root: string;
  readonly target: string;
}

const emittedSkillFor = (
  file: ArtifactFile,
  targets: ReadonlySet<string>,
  registry: TargetRegistry,
): EmittedSkill | undefined => {
  const segments = file.path.split('/');
  const [target, layout, name, document] = segments;
  if (target === undefined || !targets.has(target) || !registry.has(target)) return undefined;
  const skillLayout = registry.artifactLayout(target).skills;
  if (
    layout !== skillLayout ||
    name === undefined ||
    document !== 'SKILL.md' ||
    segments.length !== 4
  ) {
    return undefined;
  }
  if (skillLayout === undefined) return undefined;
  return {
    name,
    path: file.path,
    root: `${target}/${skillLayout}/${name}`,
    target,
  };
};

const isSkillRootEscape = (reference: string): boolean =>
  reference === '..' || reference.startsWith('../') || reference.startsWith('/');

const skillRecovery = artifactDiagnosticRecoveries.AB6015;

const validateEmittedSkills = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifestV2;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const targets = targetNamespaces(options.manifest);
  const skills = options.files
    .map((file) => emittedSkillFor(file, targets, options.registry))
    .filter((skill): skill is EmittedSkill => skill !== undefined);
  const skillsByRoot = new Map(skills.map((skill) => [skill.root, skill]));

  for (const file of options.files) {
    if (!file.path.endsWith('/SKILL.md') || emittedSkillFor(file, targets, options.registry) !== undefined) continue;
    const target = pathTarget(file.path, targets);
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill document ${JSON.stringify(file.path)} does not use the canonical skills/<name>/SKILL.md layout.`,
      file.path,
      target,
      skillRecovery,
    ));
  }

  const resourceFilesBySkill = new Map<string, readonly ArtifactFile[]>();
  for (const file of options.files) {
    const [target, layout, name] = file.path.split('/');
    if (target === undefined || name === undefined || !targets.has(target) || !options.registry.has(target)) continue;
    if (layout !== options.registry.artifactLayout(target).skills) continue;
    const root = `${target}/${layout}/${name}`;
    const existing = resourceFilesBySkill.get(root) ?? [];
    resourceFilesBySkill.set(root, [...existing, file]);
  }

  for (const [root, files] of resourceFilesBySkill) {
    if (skillsByRoot.has(root)) continue;
    const [target] = root.split('/');
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill resource directory ${JSON.stringify(root)} is missing its SKILL.md document.`,
      files[0]?.path,
      target,
      skillRecovery,
    ));
  }

  for (const skill of skills) {
    let markdown: string;
    try {
      markdown = await readFile(resolve(options.artifactRoot, skill.path), 'utf8');
    } catch {
      diagnostics.push(diagnostic(
        'AB6015',
        'Emitted Skill Markdown cannot be read.',
        skill.path,
        skill.target,
        skillRecovery,
      ));
      continue;
    }

    const parsed = parseSkillMarkdown(markdown);
    if (parsed.status === 'missing-frontmatter') {
      diagnostics.push(diagnostic(
        'AB6015',
        'Emitted Skill Markdown must start with YAML frontmatter.',
        skill.path,
        skill.target,
        skillRecovery,
      ));
      continue;
    }
    if (parsed.status === 'malformed-frontmatter') {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill YAML frontmatter is invalid: ${parsed.message}`,
        skill.path,
        skill.target,
        skillRecovery,
      ));
      continue;
    }

    for (const issue of validateAgentSkillsFrontmatter(parsed.frontmatter)) {
      const location = issue.field ?? (issue.instancePath === '' ? 'root' : issue.instancePath);
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill frontmatter ${location} ${issue.message}.`,
        skill.path,
        skill.target,
        skillRecovery,
      ));
    }
    if (typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name !== skill.name) {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill name ${JSON.stringify(parsed.frontmatter.name)} must match directory ${JSON.stringify(skill.name)}.`,
        skill.path,
        skill.target,
        skillRecovery,
      ));
    }

    const resources = new Set(
      (resourceFilesBySkill.get(skill.root) ?? []).map((file) => file.path.slice(skill.root.length + 1)),
    );
    for (const reference of referencedResources(parsed.body)) {
      if (isSkillRootEscape(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill reference ${JSON.stringify(reference)} escapes its Skill root.`,
          skill.path,
          skill.target,
          artifactDiagnosticRecoveries.AB6016,
        ));
      } else if (!resources.has(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill references missing regular resource ${JSON.stringify(reference)}.`,
          skill.path,
          skill.target,
          artifactDiagnosticRecoveries.AB6016,
        ));
      }
    }
  }

  return Object.freeze(diagnostics);
};

const validateGeneratedFiles = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifestFiles?: readonly ManifestFile[];
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const generatedFiles = new Set(options.files.map((file) => file.path));
  const validJson = new Set<string>();

  for (const file of options.files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      const document = JSON.parse(await readFile(resolve(options.artifactRoot, file.path), 'utf8')) as unknown;
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
      diagnostics.push(diagnostic('AB6006', 'Generated JSON cannot be parsed.', file.path));
    }
  }

  diagnostics.push(...await validateJavaScriptModules({
    artifactRoot: options.artifactRoot,
    files: options.files,
    ...(options.manifestFiles === undefined
      ? {}
      : { manifestFiles: new Set(options.manifestFiles.map((file) => file.path)) }),
    validJson,
  }));

  return Object.freeze(diagnostics);
};

export const validateArtifactFiles = async (
  context: ValidateArtifactOptions,
): Promise<readonly Diagnostic[]> => {
  const inspection = await inspectArtifact(context);
  return Object.freeze([
    ...filesystemDiagnostics(inspection.filesystem),
    ...await validateGeneratedFiles({ artifactRoot: context.artifactRoot, files: inspection.files }),
  ]);
};

const invalidArtifactSnapshot = (diagnostics: readonly Diagnostic[]): ValidateArtifactSnapshotResult => Object.freeze({
  diagnostics: Object.freeze([...diagnostics]),
});

const validArtifactSnapshot = (
  manifest: ArtifactManifestV2,
  runtimeEvidence: RuntimeEvidenceBuilder,
): ValidateArtifactSnapshotResult => Object.freeze({
  diagnostics: Object.freeze([]),
  snapshot: Object.freeze({
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
  const inspectionOptions = { allowEpochStagingMarker, artifactRoot };
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

  let manifest: ArtifactManifestV2;
  try {
    manifest = parseArtifactManifest(manifestSnapshot.bytes.toString('utf8'));
  } catch {
    return invalidArtifactSnapshot([diagnostic('AB6001', 'Artifact manifest is not a strict canonical v2 manifest.', artifactManifestName)]);
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
  diagnostics.push(...await validateTargetContracts({
    artifactRoot,
    files: inspection.files,
    manifest,
    registry,
  }));
  diagnostics.push(...await validateMcpCoherence({
    artifactRoot,
    files: inspection.files,
    manifest,
    registry,
    runtimeEvidence,
  }));
  diagnostics.push(...await validateHookCoherence({
    artifactRoot,
    files: inspection.files,
    manifest,
    registry,
    runtimeEvidence,
  }));
  diagnostics.push(...await validateEmittedSkills({
    artifactRoot,
    files: inspection.files,
    manifest,
    registry,
  }));
  diagnostics.push(...await validateGeneratedFiles({
    artifactRoot,
    files: inspection.files,
    manifestFiles: manifest.files,
  }));

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
    ? validArtifactSnapshot(manifest, runtimeEvidence)
    : invalidArtifactSnapshot(diagnostics);
};

/** Preserves the established diagnostics-only validation API. */
export const validateArtifact = async (
  context: ValidateArtifactOptions,
): Promise<readonly Diagnostic[]> => (await validateArtifactWithSnapshot(context)).diagnostics;
