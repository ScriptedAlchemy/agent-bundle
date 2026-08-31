import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { digest } from './digest.ts';
import { deepFreeze } from './freeze.ts';
import { isInsideOrEqual } from './paths.ts';
import { snapshotStrictJsonValue } from './strict-json.ts';
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
  readonly revision: string;
  readonly sourceInputs: readonly ProjectSourceInput[];
}

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

const modelPathReferences = (model: NormalizedPlugin): readonly string[] => [
  model.metadata.provenance.sourcePath,
  ...(model.assets ?? []).flatMap((asset) => [asset.provenance.sourcePath, asset.source]),
  ...Object.values(model.extensions).map((extension) => extension.provenance.sourcePath),
  ...model.targets.map((target) => target.provenance.sourcePath),
  ...model.hooks.flatMap((hook) => [hook.provenance.sourcePath, hook.source]),
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
  return deepFreeze({
    configDigest: configInput.sha256,
    configPath,
    modelDigest: digest(canonicalizeNormalizedModel(canonicalRoot, options.model)),
    revision: digest({ inputs: sourceInputs }),
    sourceInputs,
  });
};
