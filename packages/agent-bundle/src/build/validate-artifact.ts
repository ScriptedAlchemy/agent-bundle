import { lstat, readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import type {
  TargetArtifactDocumentIssue,
  TargetArtifactDocumentValidator,
} from '../adapters/types.ts';
import { mcpEntryAliasPattern } from '../config/normalize.ts';
import { parseSkillMarkdown, referencedResources } from '../config/skill-references.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { isRecord } from '../core/strict-json.ts';
import { agentSkillsSchemaRevision, validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';
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
import type {
  ValidateArtifactOptions,
  ValidatedArtifactMcpServerEvidence,
  ValidatedArtifactRuntimeEvidence,
  ValidatedArtifactSnapshot,
  ValidateArtifactSnapshotResult,
} from './artifact-validation-types.ts';
import { validateJavaScriptModules } from './validate-artifact-modules.ts';
import { validateHookCoherence } from './validate-artifact-hooks.ts';
import { validateMcpCoherence } from './validate-artifact-mcp.ts';

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
  readonly manifest: ArtifactManifest;
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

const ownershipRecovery = artifactDiagnosticRecoveries.AB6014;

const targetNamespaces = (manifest: ArtifactManifest): ReadonlySet<string> =>
  new Set(manifest.targets.map((target) => target.name));

const pathTarget = (path: string, targets: ReadonlySet<string>): string | undefined => {
  const [target] = path.split('/');
  return target !== undefined && targets.has(target) ? target : undefined;
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
  return isDirectOutputLayoutPath(relativePath, layout.hookWrappers) ||
    isDirectOutputLayoutPath(relativePath, layout.mcpApps) ||
    isDirectOutputLayoutPath(relativePath, layout.mcpEntries) ||
    isDirectOutputLayoutPath(relativePath, layout.scripts) ||
    isSkillArtifactPath(relativePath, layout.skills) ||
    relativePath === hookContract?.manifestPath ||
    relativePath === mcpRuntime?.manifestPath ||
    registry.artifactValidation(target).documents.some((document) => document.path === relativePath);
};

const validateArtifactOwnership = (options: {
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
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
  readonly manifest: ArtifactManifest;
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
    mcpServers: runtimeEvidence.mcpServers,
  }));
  diagnostics.push(...await validateHookCoherence({
    artifactRoot,
    files: inspection.files,
    manifest,
    registry,
    hooks: runtimeEvidence.hooks,
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
