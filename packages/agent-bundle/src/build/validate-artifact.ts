import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactDocumentIssue, TargetArtifactDocumentValidator } from '../adapters/types.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { agentSkillsSchemaRevision } from '../schemas/agent-skills/contract.ts';
import {
  artifactManifestName,
  listArtifactFiles,
  type ArtifactFile,
  type ManifestFile,
} from './emit.ts';
import { parseArtifactManifest, type ArtifactManifestV2 } from './manifest.ts';

const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';

export interface ValidateArtifactOptions {
  /** Enables the one store-owned epoch staging marker after its exact schema validates. */
  readonly allowEpochStagingMarker?: true;
  readonly artifactRoot: string;
  /** Target contracts that produced and must validate this artifact. */
  readonly registry?: TargetRegistry;
}

const diagnostic = (
  code: string,
  message: string,
  generatedPath?: string,
  target?: string,
  recovery?: string,
): Diagnostic => ({
  code,
  generatedPath,
  message,
  ...(recovery === undefined ? {} : { recovery }),
  severity: 'error',
  ...(target === undefined ? {} : { target }),
});

const checkJavaScriptSyntax = async (path: string): Promise<string | undefined> =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--check', path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
    }, 5_000);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolvePromise(error.message);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolvePromise(code === 0 ? undefined : stderr.trim() || 'Node rejected generated JavaScript.');
    });
  });

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

const artifactFiles = async (context: ValidateArtifactOptions): Promise<readonly ArtifactFile[]> => {
  let allowedEpochStagingMarker = false;
  if (context.allowEpochStagingMarker === true) {
    try {
      allowedEpochStagingMarker = isEpochStagingMarker(
        await readFile(resolve(context.artifactRoot, epochStagingMarkerName), 'utf8'),
      );
    } catch {
      allowedEpochStagingMarker = false;
    }
  }
  return (await listArtifactFiles(context.artifactRoot)).filter(
    (file) => file.path !== artifactManifestName &&
      !(allowedEpochStagingMarker && file.path === epochStagingMarkerName),
  );
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

const targetRecovery = 'Rebuild the artifact with the current target registry.';

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
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (length === undefined || !('value' in length) || typeof length.value !== 'number') {
    return schemaValidationFailure();
  }
  const issues: TargetArtifactDocumentIssue[] = [];
  for (let index = 0; index < length.value; index += 1) {
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
        targetRecovery,
      ));
      continue;
    }
    if (!matchesTargetMetadata(target, options.registry.metadata(target.name))) {
      diagnostics.push(diagnostic(
        'AB6010',
        `Artifact metadata for target ${JSON.stringify(target.name)} does not match its registered contract.`,
        artifactManifestName,
        target.name,
        targetRecovery,
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
            targetRecovery,
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
          targetRecovery,
        ));
      }
    }
  }
  return Object.freeze(diagnostics);
};

export const validateArtifactFiles = async (
  context: ValidateArtifactOptions,
): Promise<readonly Diagnostic[]> => {
  const files = await artifactFiles(context);
  const diagnostics: Diagnostic[] = [];

  for (const file of files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      const document = JSON.parse(await readFile(resolve(context.artifactRoot, file.path), 'utf8')) as unknown;
      for (const mcpPath of localMcpPaths(document)) {
        try {
          await readFile(resolve(context.artifactRoot, dirname(file.path), mcpPath));
        } catch {
          diagnostics.push(diagnostic(
            'AB6007',
            `MCP manifest references missing generated server ${JSON.stringify(mcpPath)}.`,
            file.path,
          ));
        }
      }
    } catch {
      diagnostics.push(diagnostic('AB6006', 'Generated JSON cannot be parsed.', file.path));
    }
  }

  for (const file of files.filter((entry) => /\.(?:[cm]?js)$/u.test(entry.path))) {
    const syntaxError = await checkJavaScriptSyntax(resolve(context.artifactRoot, file.path));
    if (syntaxError !== undefined) {
      diagnostics.push(diagnostic('AB6005', `Generated JavaScript has invalid syntax: ${syntaxError}`, file.path));
    }
  }

  return Object.freeze(diagnostics);
};

export const validateArtifact = async (context: ValidateArtifactOptions): Promise<readonly Diagnostic[]> => {
  const manifestPath = resolve(context.artifactRoot, artifactManifestName);
  let manifest: ArtifactManifestV2;
  try {
    manifest = parseArtifactManifest(await readFile(manifestPath, 'utf8'));
  } catch {
    try {
      await readFile(manifestPath, 'utf8');
    } catch {
      return [diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName)];
    }
    return [diagnostic('AB6001', 'Artifact manifest is not a strict canonical v2 manifest.', artifactManifestName)];
  }

  const actualFiles = await artifactFiles(context);
  const diagnostics: Diagnostic[] = [];
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
      'Rebuild the artifact with the pinned Agent Skills contract.',
    ));
  }
  if (!matchesManifestFileTable(actualFiles, manifest.files)) {
    diagnostics.push(diagnostic('AB6004', 'Artifact files do not match the manifest.', artifactManifestName));
  }
  diagnostics.push(...await validateTargetContracts({
    artifactRoot: context.artifactRoot,
    files: actualFiles,
    manifest,
    registry: context.registry ?? createDefaultRegistry(),
  }));
  diagnostics.push(...await validateArtifactFiles(context));
  return Object.freeze(diagnostics);
};
