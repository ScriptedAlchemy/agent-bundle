import { isAbsolute, relative, resolve, sep } from 'node:path';

import { digest } from './digest.ts';
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

const escapesRoot = (root: string, candidate: string): boolean => {
  const relativeCandidate = relative(root, candidate);
  return relativeCandidate === '..' || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate);
};

const projectRelativePath = (root: string, value: string, label: string): string => {
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

const canonicalCompilerPath = (root: string, value: string, label: string): string =>
  isAbsolute(value) ? projectRelativePath(root, value, label) : value;

const canonicalProvenance = (root: string, provenance: SourceProvenance): SourceProvenance => ({
  ...provenance,
  sourcePath: canonicalCompilerPath(root, provenance.sourcePath, 'Model provenance path'),
});

const deepFreeze = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const property of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, property), seen);
  }
  return Object.freeze(value);
};

/**
 * Produces the root-independent form used for model identity. It never mutates
 * the executable normalized model; every compiler-owned absolute path becomes
 * a project-relative POSIX path and escaping paths are rejected.
 */
export const canonicalizeNormalizedModel = (
  root: string,
  model: NormalizedPlugin,
): Readonly<Record<string, unknown>> => deepFreeze({
  ...model,
  extensions: Object.fromEntries(Object.entries(model.extensions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, extension]) => [key, {
      ...extension,
      provenance: canonicalProvenance(root, extension.provenance),
    }])),
  hooks: model.hooks.map((hook) => ({
    ...hook,
    provenance: canonicalProvenance(root, hook.provenance),
    source: canonicalCompilerPath(root, hook.source, 'Hook source path'),
  })),
  ...(model.mcpApps === undefined
    ? {}
    : {
      mcpApps: model.mcpApps.map((app) => ({
        ...app,
        provenance: canonicalProvenance(root, app.provenance),
        source: canonicalCompilerPath(root, app.source, 'MCP App source path'),
        ...(app.template === undefined
          ? {}
          : { template: canonicalCompilerPath(root, app.template, 'MCP App template path') }),
      })),
    }),
  mcpServers: model.mcpServers.map((server) => ({
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
    ...model.metadata,
    provenance: canonicalProvenance(root, model.metadata.provenance),
  },
  ...(model.nativeHooks === undefined
    ? {}
    : {
      nativeHooks: model.nativeHooks.map((hook) => ({
        ...hook,
        provenance: canonicalProvenance(root, hook.provenance),
        source: canonicalCompilerPath(root, hook.source, 'Native hook source path'),
      })),
    }),
  scripts: model.scripts.map((script) => ({
    ...script,
    provenance: canonicalProvenance(root, script.provenance),
    source: canonicalCompilerPath(root, script.source, 'Script source path'),
  })),
  skills: model.skills.map((skill) => ({
    ...skill,
    dir: canonicalCompilerPath(root, skill.dir, 'Skill directory path'),
    provenance: canonicalProvenance(root, skill.provenance),
    resources: skill.resources.map((resource) => ({
      ...resource,
      source: canonicalCompilerPath(root, resource.source, 'Skill resource path'),
    })),
    source: canonicalCompilerPath(root, skill.source, 'Skill source path'),
  })),
  targets: model.targets.map((target) => ({
    ...target,
    provenance: canonicalProvenance(root, target.provenance),
  })),
});

const canonicalSourceInputs = (
  root: string,
  inputs: readonly ProjectSourceSnapshotInput[],
): readonly ProjectSourceInput[] => {
  const canonical = inputs.map((input) => {
    const path = projectRelativePath(root, input.path, 'Project source input path');
    if (input.error !== undefined || input.sha256 === undefined) {
      throw new TypeError(`Project source input ${JSON.stringify(path)} must have a SHA-256 digest.`);
    }
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
  const configPath = projectRelativePath(options.root, options.configPath, 'Configuration path');
  const sourceInputs = canonicalSourceInputs(options.root, options.sourceInputs);
  const configInput = sourceInputs.find((input) => input.path === configPath);
  if (configInput === undefined) {
    throw new TypeError(`Configuration source ${JSON.stringify(configPath)} must have a SHA-256 digest.`);
  }
  return deepFreeze({
    configDigest: configInput.sha256,
    configPath,
    modelDigest: digest(canonicalizeNormalizedModel(options.root, options.model)),
    revision: digest({ inputs: sourceInputs }),
    sourceInputs,
  });
};
