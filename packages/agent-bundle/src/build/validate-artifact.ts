import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import type {
  TargetArtifactDocumentIssue,
  TargetArtifactDocumentValidator,
  TargetArtifactOutputLayout,
} from '../adapters/types.ts';
import { parseSkillMarkdown, referencedResources } from '../config/skill-references.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { agentSkillsSchemaRevision, validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';
import {
  artifactHookIndexName,
  artifactManifestName,
  inspectArtifactFilesystem,
  type ArtifactFile,
  type ArtifactFilesystemSnapshot,
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

const javaScriptModuleSuffix = /\.(?:[cm]?js)$/u;
const moduleImportTimeoutMs = 5_000;
const childOutputLimit = 8 * 1024;
const generatedJavaScriptRecovery = 'Bundle every JavaScript dependency into the artifact, then rebuild it.';

interface ChildImportResult {
  readonly error?: Error;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly timedOut: boolean;
}

interface BoundedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

const appendBoundedOutput = (output: string, chunk: Buffer): BoundedOutput => {
  const available = childOutputLimit - Buffer.byteLength(output);
  if (available <= 0) return { text: output, truncated: true };
  if (chunk.length <= available) return { text: output + chunk.toString(), truncated: false };
  return { text: output + chunk.subarray(0, available).toString(), truncated: true };
};

const runJavaScriptImport = async (artifactRoot: string, path: string): Promise<ChildImportResult> =>
  new Promise((resolvePromise) => {
    const artifactUrl = pathToFileURL(`${artifactRoot}/`).href;
    const loaderSource = [
      `const artifactUrl = ${JSON.stringify(artifactUrl)};`,
      'export async function resolve(specifier, context, nextResolve) {',
      '  const resolved = await nextResolve(specifier, context);',
      '  if (resolved.url.startsWith("file:") && !resolved.url.startsWith(artifactUrl)) {',
      '    throw new Error("Generated JavaScript resolved a dependency outside the artifact root.");',
      '  }',
      '  return resolved;',
      '}',
    ].join('\n');
    const loader = `data:text/javascript,${encodeURIComponent(loaderSource)}`;
    const importSource = [
      'import { register } from "node:module";',
      `register(${JSON.stringify(loader)}, import.meta.url);`,
      `await import(${JSON.stringify(pathToFileURL(path).href)});`,
      'process.exit(0);',
    ].join(' ');
    const child = spawn(process.execPath, ['--input-type=module', '--eval', importSource], {
      cwd: artifactRoot,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error: Error | undefined;
    let settled = false;
    let stderr = '';
    let stderrTruncated = false;
    let stdout = '';
    let stdoutTruncated = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, moduleImportTimeoutMs);
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        ...(error === undefined ? {} : { error }),
        exitCode,
        signal,
        stderr,
        stderrTruncated,
        stdout,
        stdoutTruncated,
        timedOut,
      });
    };
    child.stderr.on('data', (chunk: Buffer) => {
      const captured = appendBoundedOutput(stderr, chunk);
      stderr = captured.text;
      stderrTruncated ||= captured.truncated;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const captured = appendBoundedOutput(stdout, chunk);
      stdout = captured.text;
      stdoutTruncated ||= captured.truncated;
    });
    child.once('error', (spawnError) => {
      error = spawnError;
      if (child.pid === undefined) settle(null, null);
    });
    child.once('close', settle);
  });

const importFailure = (result: ChildImportResult): string => {
  if (result.timedOut) return `import timed out after ${moduleImportTimeoutMs}ms.`;
  if (result.error !== undefined) return `import process could not start: ${result.error.message}`;
  const output = result.stderr || result.stdout;
  const truncated = result.stderr ? result.stderrTruncated : result.stdoutTruncated;
  if (output.length > 0) return `${output.trim()}${truncated ? '\n[output truncated]' : ''}`;
  return `import process exited with ${result.signal ?? `code ${result.exitCode ?? 'unknown'}`}.`;
};

const checkJavaScriptImport = async (artifactRoot: string, relativePath: string): Promise<string | undefined> => {
  const root = resolve(artifactRoot);
  const result = await runJavaScriptImport(root, resolve(root, relativePath));
  return result.exitCode === 0 && !result.timedOut ? undefined : importFailure(result);
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

const filesystemRecovery = 'Remove unsupported filesystem entries and rebuild the artifact.';

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

const ownershipRecovery = 'Rebuild the artifact with files only in declared target namespaces.';

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

const skillRecovery = 'Restore canonical Skill Markdown and copied resources, then rebuild the artifact.';

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
          skillRecovery,
        ));
      } else if (!resources.has(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill references missing regular resource ${JSON.stringify(reference)}.`,
          skill.path,
          skill.target,
          skillRecovery,
        ));
      }
    }
  }

  return Object.freeze(diagnostics);
};

const validateGeneratedFiles = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const generatedFiles = new Set(options.files.map((file) => file.path));

  for (const file of options.files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      const document = JSON.parse(await readFile(resolve(options.artifactRoot, file.path), 'utf8')) as unknown;
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
    } catch {
      diagnostics.push(diagnostic('AB6006', 'Generated JSON cannot be parsed.', file.path));
    }
  }

  for (const file of options.files.filter((entry) => javaScriptModuleSuffix.test(entry.path))) {
    const importError = await checkJavaScriptImport(options.artifactRoot, file.path);
    if (importError !== undefined) {
      diagnostics.push(diagnostic(
        'AB6005',
        `Generated JavaScript cannot be imported: ${importError}`,
        file.path,
        undefined,
        generatedJavaScriptRecovery,
      ));
    }
  }

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

export const validateArtifact = async (context: ValidateArtifactOptions): Promise<readonly Diagnostic[]> => {
  let inspection: ArtifactInspection;
  try {
    inspection = await inspectArtifact(context);
  } catch {
    return [diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName)];
  }
  const structuralDiagnostics = filesystemDiagnostics(inspection.filesystem);
  const rootEntry = inspection.filesystem.entries.find((entry) => entry.path === '.');
  if (rootEntry !== undefined) {
    return Object.freeze([
      ...structuralDiagnostics,
      diagnostic('AB6000', 'Artifact root is not a readable directory.', artifactManifestName),
    ]);
  }

  const manifestEntry = inspection.filesystem.entries.find((entry) => entry.path === artifactManifestName);
  if (manifestEntry !== undefined && manifestEntry.kind !== 'file') {
    return Object.freeze([
      ...structuralDiagnostics,
      diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName),
    ]);
  }

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

  const registry = context.registry ?? createDefaultRegistry();
  const diagnostics: Diagnostic[] = [...structuralDiagnostics];
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
  if (!matchesManifestFileTable(inspection.files, manifest.files)) {
    diagnostics.push(diagnostic('AB6004', 'Artifact files do not match the manifest.', artifactManifestName));
  }
  diagnostics.push(...validateArtifactOwnership({
    filesystem: inspection.filesystem,
    files: inspection.files,
    manifest,
    registry,
  }));
  diagnostics.push(...await validateTargetContracts({
    artifactRoot: context.artifactRoot,
    files: inspection.files,
    manifest,
    registry,
  }));
  diagnostics.push(...await validateEmittedSkills({
    artifactRoot: context.artifactRoot,
    files: inspection.files,
    manifest,
    registry,
  }));
  diagnostics.push(...await validateGeneratedFiles({
    artifactRoot: context.artifactRoot,
    files: inspection.files,
  }));
  return Object.freeze(diagnostics);
};
