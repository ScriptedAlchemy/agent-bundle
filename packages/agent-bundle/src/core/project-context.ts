import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { SkillHostDocument, SkillIr, SkillSidecarRef } from '../skills/ir.ts';
import type { Diagnostic } from './diagnostics.ts';
import { digest } from './digest.ts';
import { deepFreeze } from './freeze.ts';
import { isInsideOrEqual } from './paths.ts';
import { snapshotStrictJsonValue } from './strict-json.ts';
import type { NormalizedPlugin, SourceProvenance } from './types.ts';

/** One deterministic, byte-addressed authored input in a project identity. */
export interface ProjectSourceInput {
  readonly executable?: boolean;
  readonly path: string;
  readonly sha256: string;
}

/** Snapshot status for one discovered input before a context can be committed. */
export interface ProjectSourceSnapshotInput {
  readonly error?: string;
  readonly executable?: boolean;
  readonly path: string;
  readonly sha256?: string;
}

/** Root-independent compiler identity for one normalized project revision. */
export interface ProjectContext {
  readonly configDigest: string;
  readonly configPath: string;
  readonly modelDigest: string;
  /** The validated npm package name axis; absent for unpackaged development projects. */
  readonly packageName?: string;
  /** The validated semantic release-version axis; absent for unpackaged development projects. */
  readonly packageVersion?: string;
  readonly revision: string;
  readonly sourceInputs: readonly ProjectSourceInput[];
}

export type PackageIdentityIssueKind = 'invalid-name' | 'invalid-version' | 'outside-root' | 'unparsable';

/** One problem found while deriving package identity from `package.json`. */
export interface PackageIdentityIssue {
  readonly kind: PackageIdentityIssueKind;
  readonly message: string;
}

/** The release-identity axes derived from a project's `package.json`. */
export interface PackageIdentitySnapshot {
  readonly issues: readonly PackageIdentityIssue[];
  readonly packageName?: string;
  readonly packageVersion?: string;
}

/** npm's naming rules for new packages: lowercase, URL-safe, optional scope. */
const packageNamePattern = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

/** Names npm's validator rejects outright even though the grammar matches. */
const reservedPackageNames = new Set(['node_modules', 'favicon.ico']);

/** The strict semver 2.0.0 grammar, without any leading `v`. */
const packageVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

/** True for a name npm would accept for a new package. */
export const isValidPackageName = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 214 &&
  !reservedPackageNames.has(value.toLowerCase()) &&
  packageNamePattern.test(value);

/** True for a strict semver 2.0.0 version. */
export const isValidPackageVersion = (value: string): boolean => packageVersionPattern.test(value);

/** The outcome of reading `<root>/package.json` for any project-identity purpose. */
export type PackageDocumentRead =
  /** No package.json, or one that cannot be read: a normal development state. */
  | { readonly kind: 'absent' }
  | { readonly document: Readonly<Record<string, unknown>>; readonly kind: 'document' }
  | { readonly issue: PackageIdentityIssue; readonly kind: 'issue' };

/**
 * Reads `<root>/package.json` the one way every identity-derived judgement
 * shares. A package.json symlinked outside the project cannot join the
 * identity: its bytes are invisible to the source snapshot, so anything
 * derived from it could drift without a revision change.
 */
export const readPackageDocument = (root: string): PackageDocumentRead => {
  let packageJsonPath: string;
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(root));
    packageJsonPath = realpathSync(join(resolve(root), 'package.json'));
  } catch {
    return { kind: 'absent' };
  }
  if (!isInsideOrEqual(canonicalRoot, packageJsonPath)) {
    return {
      issue: { kind: 'outside-root', message: 'package.json resolves outside the project root; package identity is ignored.' },
      kind: 'issue',
    };
  }
  let bytes: string;
  try {
    bytes = readFileSync(packageJsonPath, 'utf8');
  } catch {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { issue: { kind: 'unparsable', message: 'package.json is not valid JSON.' }, kind: 'issue' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { issue: { kind: 'unparsable', message: 'package.json must contain a JSON object.' }, kind: 'issue' };
  }
  return { document: parsed as Readonly<Record<string, unknown>>, kind: 'document' };
};

/**
 * Derives the release-identity axes from `<root>/package.json`. A missing
 * package.json (or missing name/version fields) is a normal development
 * state: no identity and no issues. An invalid name or version becomes an
 * issue for the caller to surface as a diagnostic, never a crash, and the
 * invalid value is withheld from the derived identity.
 */
export const snapshotPackageIdentity = (root: string): PackageIdentitySnapshot => {
  const read = readPackageDocument(root);
  switch (read.kind) {
    case 'absent':
      return deepFreeze({ issues: [] });
    case 'issue':
      return deepFreeze({ issues: [read.issue] });
    case 'document':
      break;
    default: {
      const exhaustive: never = read;
      throw new TypeError(`Unknown package document read ${String(exhaustive)}.`);
    }
  }
  const record = read.document;
  const issues: PackageIdentityIssue[] = [];
  let packageName: string | undefined;
  if (record.name !== undefined) {
    if (typeof record.name === 'string' && isValidPackageName(record.name)) packageName = record.name;
    else {
      issues.push({
        kind: 'invalid-name',
        message: `package.json name ${JSON.stringify(record.name)} is not a valid npm package name.`,
      });
    }
  }
  let packageVersion: string | undefined;
  if (record.version !== undefined) {
    if (typeof record.version === 'string' && isValidPackageVersion(record.version)) packageVersion = record.version;
    else {
      issues.push({
        kind: 'invalid-version',
        message: `package.json version ${JSON.stringify(record.version)} is not a valid semantic version.`,
      });
    }
  }
  return deepFreeze({
    issues,
    ...(packageName === undefined ? {} : { packageName }),
    ...(packageVersion === undefined ? {} : { packageVersion }),
  });
};

/**
 * The version a project carries while it has no release identity at all:
 * neither an authored `plugin.version` nor a valid `package.json` version.
 * It is a development-only value — `agent-bundle build` refuses to package
 * a project resting on it (AB4013), so it can never reach a release
 * artifact.
 */
export const developmentFallbackVersion = '0.0.0-dev';

/**
 * The human display label for the release-version axis. Without a package
 * version there is no release identity, so the label is a clearly marked
 * development fallback over the source revision — never a semantic version.
 */
export const projectVersionLabel = (
  context: Pick<ProjectContext, 'packageVersion' | 'revision'>,
): string =>
  context.packageVersion ??
  `${developmentFallbackVersion}.${context.revision.slice(0, 12)} (development fallback — no package.json version)`;

export interface CreateProjectContextOptions {
  readonly configPath: string;
  readonly model: NormalizedPlugin;
  readonly root: string;
  readonly sourceInputs: readonly ProjectSourceSnapshotInput[];
}

const escapesRoot = (root: string, candidate: string): boolean => !isInsideOrEqual(root, candidate);

const sha256Pattern = /^[a-f0-9]{64}$/u;

const assertCanonicalPath = (value: string, label: string): void => {
  if (value.includes('\\')) {
    throw new RangeError(`${label} must use a canonical POSIX path.`);
  }
  if (isAbsolute(value)) {
    if (value !== resolve(value)) throw new RangeError(`${label} must use a canonical POSIX path.`);
    return;
  }
  if (
    value.length === 0 ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new RangeError(`${label} must use a canonical POSIX path.`);
  }
};

const projectRelativePath = (root: string, value: string, label: string): string => {
  assertCanonicalPath(value, label);
  const resolvedRoot = resolve(root);
  const resolvedValue = resolve(resolvedRoot, value);
  if (escapesRoot(resolvedRoot, resolvedValue)) {
    throw new RangeError(`${label} ${JSON.stringify(resolvedValue)} is outside project root ${JSON.stringify(resolvedRoot)}.`);
  }
  const projectRelative = relative(resolvedRoot, resolvedValue).replaceAll('\\', '/');
  if (projectRelative.length === 0) {
    throw new RangeError(`${label} must not be the project root.`);
  }
  return projectRelative;
};

const resolvedProjectPath = (root: string, value: string, label: string): string => {
  const canonicalRoot = realpathSync(resolve(root));
  const lexicalRoot = resolve(root);
  projectRelativePath(lexicalRoot, value, label);
  const referencedPath = realpathSync(resolve(lexicalRoot, value));
  if (escapesRoot(canonicalRoot, referencedPath)) {
    throw new RangeError(`${label} ${JSON.stringify(referencedPath)} is outside project root ${JSON.stringify(canonicalRoot)}.`);
  }
  const projectRelative = relative(canonicalRoot, referencedPath).replaceAll('\\', '/');
  if (projectRelative.length === 0) throw new RangeError(`${label} must not be the project root.`);
  return projectRelative;
};

const canonicalCompilerPath = (root: string, value: string, label: string): string =>
  isAbsolute(value) ? projectRelativePath(root, value, label) : value;

const canonicalProvenance = (root: string, provenance: SourceProvenance): SourceProvenance => ({
  ...provenance,
  sourcePath: canonicalCompilerPath(root, provenance.sourcePath, 'Model provenance path'),
});

const canonicalDiagnostic = (root: string, diagnostic: Diagnostic): Diagnostic => ({
  ...diagnostic,
  ...(diagnostic.generatedPath === undefined
    ? {}
    : { generatedPath: canonicalCompilerPath(root, diagnostic.generatedPath, 'Diagnostic generated path') }),
  ...(diagnostic.sourcePath === undefined
    ? {}
    : { sourcePath: canonicalCompilerPath(root, diagnostic.sourcePath, 'Diagnostic source path') }),
});

const canonicalSkillSidecar = (root: string, sidecar: SkillSidecarRef): SkillSidecarRef => ({
  ...sidecar,
  ...(sidecar.source === undefined
    ? {}
    : { source: canonicalCompilerPath(root, sidecar.source, 'Skill sidecar source path') }),
});

const canonicalSkillIr = (root: string, skillIr: SkillIr): SkillIr => ({
  ...skillIr,
  diagnostics: skillIr.diagnostics.map((diagnostic) => canonicalDiagnostic(root, diagnostic)),
  resources: skillIr.resources.map((resource) => ({
    ...resource,
    source: canonicalCompilerPath(root, resource.source, 'Skill IR resource path'),
  })),
  sidecars: skillIr.sidecars.map((sidecar) => canonicalSkillSidecar(root, sidecar)),
  source: canonicalCompilerPath(root, skillIr.source, 'Skill IR source path'),
});

const canonicalHostDocuments = (
  root: string,
  hostDocuments: Readonly<Record<string, SkillHostDocument>>,
): Readonly<Record<string, SkillHostDocument>> =>
  Object.fromEntries(Object.entries(hostDocuments)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([host, document]) => [host, {
      ...document,
      diagnostics: document.diagnostics.map((diagnostic) => canonicalDiagnostic(root, diagnostic)),
      sidecars: document.sidecars.map((sidecar) => canonicalSkillSidecar(root, sidecar)),
    }]));

const modelPathReferences = (model: NormalizedPlugin): readonly string[] => [
  model.metadata.provenance.sourcePath,
  ...(model.assets ?? []).flatMap((asset) => [asset.provenance.sourcePath, asset.source]),
  ...(model.commands ?? []).flatMap((command) => [command.provenance.sourcePath, command.source]),
  ...(model.layouts ?? []).map((layout) => layout.source),
  ...(model.providers ?? []).map((provider) => provider.source),
  ...(model.rules ?? []).flatMap((rule) => [rule.provenance.sourcePath, rule.source]),
  ...Object.values(model.extensions).map((extension) => extension.provenance.sourcePath),
  ...(model.hostBins ?? []).flatMap((bin) => [
    bin.provenance.sourcePath,
    ...bin.files.map((file) => file.source),
  ]),
  ...(model.hostOutputStyles ?? []).flatMap((directory) => [
    directory.provenance.sourcePath,
    ...directory.files.map((file) => file.source),
  ]),
  ...(model.hostWorkflows ?? []).flatMap((directory) => [
    directory.provenance.sourcePath,
    ...directory.files.map((file) => file.source),
  ]),
  ...model.targets.map((target) => target.provenance.sourcePath),
  // A prebuilt hook's source is its payload file, which may not exist yet
  // (the payload comes from the consumer's own build step); its bytes join
  // the identity through the enumerated payload files instead.
  ...model.hooks.flatMap((hook) => [
    hook.provenance.sourcePath,
    ...(hook.prebuiltPath === undefined ? [hook.source] : []),
  ]),
  ...model.skills.flatMap((skill) => [
    skill.dir,
    skill.provenance.sourcePath,
    skill.source,
    ...skill.resources.map((resource) => resource.source),
    ...(skill.skillIr === undefined
      ? []
      : [
        skill.skillIr.source,
        ...skill.skillIr.resources.map((resource) => resource.source),
        ...skill.skillIr.sidecars.flatMap((sidecar) => sidecar.source === undefined ? [] : [sidecar.source]),
        ...skill.skillIr.diagnostics.flatMap((diagnostic) =>
          diagnostic.sourcePath === undefined ? [] : [diagnostic.sourcePath]),
      ]),
    ...(skill.hostDocuments === undefined
      ? []
      : Object.values(skill.hostDocuments).flatMap((document) => [
        ...document.diagnostics.flatMap((diagnostic) =>
          diagnostic.sourcePath === undefined ? [] : [diagnostic.sourcePath]),
        ...document.sidecars.flatMap((sidecar) => sidecar.source === undefined ? [] : [sidecar.source]),
      ])),
  ]),
  ...model.scripts.flatMap((script) => [script.provenance.sourcePath, script.source]),
  ...(model.state === undefined ? [] : [model.state.provenance.sourcePath, model.state.source]),
  ...model.mcpServers.flatMap((server) => [
    server.provenance.sourcePath,
    ...(server.source === undefined ? [] : [server.source]),
    ...(server.cwd === undefined || !isAbsolute(server.cwd) ? [] : [server.cwd]),
  ]),
  ...(model.mcpApps ?? []).flatMap((app) => [
    app.provenance.sourcePath,
    app.source,
    ...(app.template === undefined ? [] : [app.template]),
  ]),
  ...(model.nativeHooks ?? []).flatMap((hook) => [hook.provenance.sourcePath, hook.source]),
  ...(model.packageBuild?.bins ?? []).flatMap((bin) => [bin.provenance.sourcePath, bin.source]),
  ...(model.packageBuild?.lib === undefined
    ? []
    : [model.packageBuild.lib.provenance.sourcePath, model.packageBuild.lib.source]),
  // The payload source directory is deliberately absent: a declared payload
  // may not exist yet (its files list is then empty), and the enumerated
  // files below carry the byte-level identity.
  ...(model.payloads ?? []).flatMap((payload) => [
    payload.provenance.sourcePath,
    ...payload.files.map((file) => file.source),
  ]),
];

const assertModelPathsResolveInsideProject = (root: string, model: NormalizedPlugin): void => {
  for (const path of modelPathReferences(model)) {
    if (isAbsolute(path)) resolvedProjectPath(root, path, 'Model source path');
  }
};

/**
 * Produces the root-independent form used for model identity. It never mutates
 * the executable normalized model; every compiler-owned absolute path becomes
 * a project-relative POSIX path and escaping paths are rejected.
 */
export const canonicalizeNormalizedModel = (
  root: string,
  model: NormalizedPlugin,
): Readonly<Record<string, unknown>> => {
  const detached = snapshotStrictJsonValue(model) as unknown as NormalizedPlugin;
  return deepFreeze({
    ...detached,
    ...(detached.assets === undefined
      ? {}
      : {
        assets: detached.assets.map((asset) => ({
          ...asset,
          provenance: canonicalProvenance(root, asset.provenance),
          source: canonicalCompilerPath(root, asset.source, 'Asset source path'),
        })),
      }),
    ...(detached.commands === undefined
      ? {}
      : {
        commands: detached.commands.map((command) => ({
          ...command,
          provenance: canonicalProvenance(root, command.provenance),
          source: canonicalCompilerPath(root, command.source, 'Command source path'),
        })),
      }),
    ...(detached.layouts === undefined
      ? {}
      : {
        layouts: detached.layouts.map((layout) => ({
          ...layout,
          source: canonicalCompilerPath(root, layout.source, 'Layout source path'),
        })),
      }),
    ...(detached.providers === undefined
      ? {}
      : {
        providers: detached.providers.map((provider) => ({
          ...provider,
          source: canonicalCompilerPath(root, provider.source, 'Provider source path'),
        })),
      }),
    extensions: Object.fromEntries(Object.entries(detached.extensions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, extension]) => [key, {
        ...extension,
        provenance: canonicalProvenance(root, extension.provenance),
      }])),
    ...(detached.hostBins === undefined
      ? {}
      : {
        hostBins: detached.hostBins.map((bin) => ({
          ...bin,
          files: bin.files.map((file) => ({
            ...file,
            source: canonicalCompilerPath(root, file.source, 'Host bin file source path'),
          })),
          provenance: canonicalProvenance(root, bin.provenance),
          source: canonicalCompilerPath(root, bin.source, 'Host bin source path'),
        })),
      }),
    ...(detached.hostOutputStyles === undefined
      ? {}
      : {
        hostOutputStyles: detached.hostOutputStyles.map((directory) => ({
          ...directory,
          files: directory.files.map((file) => ({
            ...file,
            source: canonicalCompilerPath(root, file.source, 'Host output style file source path'),
          })),
          provenance: canonicalProvenance(root, directory.provenance),
          source: canonicalCompilerPath(root, directory.source, 'Host output styles source path'),
        })),
      }),
    ...(detached.hostWorkflows === undefined
      ? {}
      : {
        hostWorkflows: detached.hostWorkflows.map((directory) => ({
          ...directory,
          files: directory.files.map((file) => ({
            ...file,
            source: canonicalCompilerPath(root, file.source, 'Host workflow file source path'),
          })),
          provenance: canonicalProvenance(root, directory.provenance),
          source: canonicalCompilerPath(root, directory.source, 'Host workflows source path'),
        })),
      }),
    hooks: detached.hooks.map((hook) => ({
      ...hook,
      provenance: canonicalProvenance(root, hook.provenance),
      source: canonicalCompilerPath(root, hook.source, 'Hook source path'),
    })),
    ...(detached.mcpApps === undefined
      ? {}
      : {
        mcpApps: detached.mcpApps.map((app) => ({
          ...app,
          provenance: canonicalProvenance(root, app.provenance),
          source: canonicalCompilerPath(root, app.source, 'MCP App source path'),
          ...(app.template === undefined
            ? {}
            : { template: canonicalCompilerPath(root, app.template, 'MCP App template path') }),
        })),
      }),
    mcpServers: detached.mcpServers.map((server) => ({
      ...server,
      ...(server.cwd === undefined
        ? {}
        : { cwd: canonicalCompilerPath(root, server.cwd, 'MCP server working directory') }),
      provenance: canonicalProvenance(root, server.provenance),
      ...(server.source === undefined
        ? {}
        : { source: canonicalCompilerPath(root, server.source, 'MCP server source path') }),
    })),
    metadata: {
      ...detached.metadata,
      provenance: canonicalProvenance(root, detached.metadata.provenance),
    },
    ...(detached.nativeHooks === undefined
      ? {}
      : {
        nativeHooks: detached.nativeHooks.map((hook) => ({
          ...hook,
          provenance: canonicalProvenance(root, hook.provenance),
          source: canonicalCompilerPath(root, hook.source, 'Native hook source path'),
        })),
      }),
    ...(detached.payloads === undefined
      ? {}
      : {
        payloads: detached.payloads.map((payload) => ({
          ...payload,
          files: payload.files.map((file) => ({
            ...file,
            source: canonicalCompilerPath(root, file.source, 'Payload file source path'),
          })),
          provenance: canonicalProvenance(root, payload.provenance),
          source: canonicalCompilerPath(root, payload.source, 'Payload source path'),
        })),
      }),
    ...(detached.packageBuild === undefined
      ? {}
      : {
        packageBuild: {
          ...detached.packageBuild,
          bins: detached.packageBuild.bins.map((bin) => ({
            ...bin,
            provenance: canonicalProvenance(root, bin.provenance),
            source: canonicalCompilerPath(root, bin.source, 'Bin entry source path'),
          })),
          ...(detached.packageBuild.lib === undefined
            ? {}
            : {
              lib: {
                ...detached.packageBuild.lib,
                provenance: canonicalProvenance(root, detached.packageBuild.lib.provenance),
                source: canonicalCompilerPath(root, detached.packageBuild.lib.source, 'Lib entry source path'),
              },
            }),
        },
      }),
    ...(detached.rules === undefined
      ? {}
      : {
        rules: detached.rules.map((rule) => ({
          ...rule,
          provenance: canonicalProvenance(root, rule.provenance),
          source: canonicalCompilerPath(root, rule.source, 'Rule source path'),
        })),
      }),
    scripts: detached.scripts.map((script) => ({
      ...script,
      provenance: canonicalProvenance(root, script.provenance),
      source: canonicalCompilerPath(root, script.source, 'Script source path'),
    })),
    skills: detached.skills.map((skill) => ({
      ...skill,
      dir: canonicalCompilerPath(root, skill.dir, 'Skill directory path'),
      ...(skill.hostDocuments === undefined
        ? {}
        : { hostDocuments: canonicalHostDocuments(root, skill.hostDocuments) }),
      provenance: canonicalProvenance(root, skill.provenance),
      resources: skill.resources.map((resource) => ({
        ...resource,
        source: canonicalCompilerPath(root, resource.source, 'Skill resource path'),
      })),
      ...(skill.skillIr === undefined ? {} : { skillIr: canonicalSkillIr(root, skill.skillIr) }),
      source: canonicalCompilerPath(root, skill.source, 'Skill source path'),
    })),
    targets: detached.targets.map((target) => ({
      ...target,
      provenance: canonicalProvenance(root, target.provenance),
    })),
  });
};

const canonicalSourceInputs = (
  root: string,
  inputs: readonly ProjectSourceSnapshotInput[],
): readonly ProjectSourceInput[] => {
  const canonical = inputs.map((input) => {
    if (input.error !== undefined || input.sha256 === undefined || !sha256Pattern.test(input.sha256)) {
      throw new TypeError(`Project source input ${JSON.stringify(input.path)} must have a lowercase SHA-256 digest.`);
    }
    const path = resolvedProjectPath(root, input.path, 'Project source input path');
    return {
      ...(input.executable === undefined ? {} : { executable: input.executable }),
      path,
      sha256: input.sha256,
    } satisfies ProjectSourceInput;
  });
  canonical.sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1]?.path === canonical[index]?.path) {
      throw new RangeError(`Project source inputs contain duplicate path ${JSON.stringify(canonical[index]!.path)}.`);
    }
  }
  return deepFreeze(canonical);
};

/** Creates the single canonical identity carried from preparation to publication. */
export const createProjectContext = (options: CreateProjectContextOptions): ProjectContext => {
  const canonicalRoot = realpathSync(resolve(options.root));
  const configPath = resolvedProjectPath(canonicalRoot, options.configPath, 'Configuration path');
  const sourceInputs = canonicalSourceInputs(options.root, options.sourceInputs);
  const configInput = sourceInputs.find((input) => input.path === configPath);
  if (configInput === undefined) {
    throw new TypeError(`Configuration source ${JSON.stringify(configPath)} must have a SHA-256 digest.`);
  }
  assertModelPathsResolveInsideProject(canonicalRoot, options.model);
  const { packageName, packageVersion } = options.model.metadata;
  return deepFreeze({
    configDigest: configInput.sha256,
    configPath,
    modelDigest: digest(canonicalizeNormalizedModel(canonicalRoot, options.model)),
    ...(packageName === undefined ? {} : { packageName }),
    ...(packageVersion === undefined ? {} : { packageVersion }),
    revision: digest({ inputs: sourceInputs }),
    sourceInputs,
  });
};
