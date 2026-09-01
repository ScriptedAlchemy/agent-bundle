import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { Diagnostic } from './diagnostics.ts';
import { digest, sha256Hex } from './digest.ts';
import { isErrno } from './errors.ts';
import { deepFreeze } from './freeze.ts';
import { isInsideOrEqual } from './paths.ts';
import { parseSemanticVersion } from './semver.ts';
import { isRecord, snapshotStrictJsonValue } from './strict-json.ts';
import type { NormalizedPlugin, SourceProvenance } from './types.ts';

/** One deterministic, byte-addressed authored input in a project identity. */
export interface ProjectSourceInput {
  readonly path: string;
  readonly sha256: string;
}

/** Snapshot status for one discovered input before a context can be committed. */
export interface ProjectSourceSnapshotInput {
  readonly error?: string;
  readonly path: string;
  readonly sha256?: string;
}

/** Root-independent compiler identity for one normalized project revision. */
export interface ProjectContext {
  readonly configDigest: string;
  readonly configPath: string;
  readonly modelDigest: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly revision: string;
  readonly sourceInputs: readonly ProjectSourceInput[];
}

export interface CreateProjectContextOptions {
  readonly configPath: string;
  readonly model: NormalizedPlugin;
  readonly requirePackageIdentity?: boolean;
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

const modelPathReferences = (model: NormalizedPlugin): readonly string[] => [
  model.metadata.provenance.sourcePath,
  ...(model.assets ?? []).flatMap((asset) => [asset.provenance.sourcePath, asset.source]),
  ...Object.values(model.extensions).map((extension) => extension.provenance.sourcePath),
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
  ]),
  ...model.scripts.flatMap((script) => [script.provenance.sourcePath, script.source]),
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
    extensions: Object.fromEntries(Object.entries(detached.extensions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, extension]) => [key, {
        ...extension,
        provenance: canonicalProvenance(root, extension.provenance),
      }])),
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
    scripts: detached.scripts.map((script) => ({
      ...script,
      provenance: canonicalProvenance(root, script.provenance),
      source: canonicalCompilerPath(root, script.source, 'Script source path'),
    })),
    skills: detached.skills.map((skill) => ({
      ...skill,
      dir: canonicalCompilerPath(root, skill.dir, 'Skill directory path'),
      provenance: canonicalProvenance(root, skill.provenance),
      resources: skill.resources.map((resource) => ({
        ...resource,
        source: canonicalCompilerPath(root, resource.source, 'Skill resource path'),
      })),
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
    return { path, sha256: input.sha256 } satisfies ProjectSourceInput;
  });
  canonical.sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1]?.path === canonical[index]?.path) {
      throw new RangeError(`Project source inputs contain duplicate path ${JSON.stringify(canonical[index]!.path)}.`);
    }
  }
  return deepFreeze(canonical);
};

export interface ProjectPackageJsonSnapshot {
  readonly identity?: {
    readonly packageName: string;
    readonly packageVersion: string;
  };
  readonly sha256: string;
}

const packageVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const isPackageName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim() === value;

export const isSemanticPackageVersion = (value: unknown): value is string =>
  typeof value === 'string' &&
  packageVersionPattern.test(value) &&
  parseSemanticVersion(value) !== undefined;

const invalidPackageIdentity = (root: string): never => {
  throw new TypeError(
    `Project package.json in ${JSON.stringify(root)} must declare a nonempty name and valid semantic version.`,
  );
};

export const readProjectPackageJson = (root: string): ProjectPackageJsonSnapshot | undefined => {
  const packageJsonPath = resolve(root, 'package.json');
  let bytes: string;
  try {
    bytes = readFileSync(packageJsonPath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw new TypeError(`Project package.json ${JSON.stringify(packageJsonPath)} could not be read.`);
  }
  const sha256 = sha256Hex(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new TypeError(`Project package.json ${JSON.stringify(packageJsonPath)} must be valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new TypeError(`Project package.json ${JSON.stringify(packageJsonPath)} must be a JSON object.`);
  }
  if (isPackageName(parsed.name) && isSemanticPackageVersion(parsed.version)) {
    return {
      identity: { packageName: parsed.name, packageVersion: parsed.version },
      sha256,
    };
  }
  return { sha256 };
};

export const packageVersionMismatchDiagnostic = (
  pluginVersion: string,
  packageVersion: string,
  sourcePath: string,
): Diagnostic | undefined => {
  if (pluginVersion === packageVersion) return undefined;
  return {
    code: 'AB4008',
    message:
      `plugin.version ${JSON.stringify(pluginVersion)} differs from package.json version ${JSON.stringify(packageVersion)}; package.json is authoritative.`,
    recovery:
      'Keep package.json version as the package identity and update plugin.version to match. plugin.version does not override package.json.',
    severity: 'warning',
    sourcePath,
  };
};

const withPackageJsonSourceInput = (
  root: string,
  inputs: readonly ProjectSourceSnapshotInput[],
  packageSnapshot: ProjectPackageJsonSnapshot | undefined,
): readonly ProjectSourceSnapshotInput[] => {
  if (packageSnapshot === undefined) return inputs;
  const packageJsonPath = resolve(root, 'package.json');
  const canonicalPath = resolvedProjectPath(root, packageJsonPath, 'Package manifest path');
  const alreadyDeclared = inputs.some((input) => {
    try {
      return resolvedProjectPath(root, input.path, 'Project source input path') === canonicalPath;
    } catch {
      return false;
    }
  });
  if (alreadyDeclared) return inputs;
  return [...inputs, { path: packageJsonPath, sha256: packageSnapshot.sha256 }];
};

/** Creates the single canonical identity carried from preparation to publication. */
export const createProjectContext = (options: CreateProjectContextOptions): ProjectContext => {
  const canonicalRoot = realpathSync(resolve(options.root));
  const configPath = resolvedProjectPath(canonicalRoot, options.configPath, 'Configuration path');
  const packageSnapshot = readProjectPackageJson(canonicalRoot);
  if (options.requirePackageIdentity === true && packageSnapshot?.identity === undefined) {
    invalidPackageIdentity(canonicalRoot);
  }
  const sourceInputs = canonicalSourceInputs(
    options.root,
    withPackageJsonSourceInput(canonicalRoot, options.sourceInputs, packageSnapshot),
  );
  const configInput = sourceInputs.find((input) => input.path === configPath);
  if (configInput === undefined) {
    throw new TypeError(`Configuration source ${JSON.stringify(configPath)} must have a SHA-256 digest.`);
  }
  assertModelPathsResolveInsideProject(canonicalRoot, options.model);
  const identity = packageSnapshot?.identity;
  return deepFreeze({
    configDigest: configInput.sha256,
    configPath,
    modelDigest: digest(canonicalizeNormalizedModel(canonicalRoot, options.model)),
    ...(identity === undefined ? {} : {
      packageName: identity.packageName,
      packageVersion: identity.packageVersion,
    }),
    revision: digest({ inputs: sourceInputs }),
    sourceInputs,
  });
};
