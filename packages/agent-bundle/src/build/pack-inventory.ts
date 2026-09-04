import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import type { NormalizedPlugin } from '../core/types.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import { installSurfaceRequirements } from '../install/surface.ts';
import { artifactManifestName } from './emit.ts';
import { parseArtifactManifest } from './manifest.ts';
import {
  declaredDependencies,
  importedPackageNames,
  isRegistrySpecifier,
  rewritesWorkspaceProtocols,
  type DeclaredDependency,
  type InstalledDependencyField,
  type RegistrySpecifierOptions,
} from './pack-dependencies.ts';
import type { PackageBuildResult } from './package-build.ts';

export interface PackOutputFile {
  readonly path: string;
}

export interface PackOutput {
  readonly filename: string;
  readonly files: readonly PackOutputFile[];
}

const packEntryName = (entry: unknown, key: string | undefined): string | undefined =>
  isRecord(entry) && typeof entry.name === 'string' ? entry.name : key;

/**
 * Parses `npm pack --json` output into one pack entry. npm emits either an
 * array or a package-keyed object depending on version; both are accepted.
 *
 * When `packageName` is given, the entry is selected by package name rather
 * than by position, so a pack that also lists sibling workspace packages
 * still resolves the intended tarball deterministically. Without it, the
 * output must contain exactly one entry.
 */
export const packOutputFromJson = (stdout: string, packageName?: string): PackOutput => {
  const parsed: unknown = JSON.parse(stdout);
  const entries: readonly (readonly [string | undefined, unknown])[] | undefined = Array.isArray(parsed)
    ? parsed.map((entry: unknown) => [undefined, entry] as const)
    : isRecord(parsed)
      ? Object.entries(parsed)
      : undefined;
  if (entries === undefined) {
    throw new TypeError('npm pack --json returned neither an array nor a package-keyed object.');
  }
  let entry: unknown;
  if (packageName === undefined) {
    if (entries.length !== 1) {
      throw new TypeError(`npm pack --json returned ${String(entries.length)} entries; expected exactly one.`);
    }
    entry = entries[0]?.[1];
  } else {
    const named = entries.filter(([key, candidate]) => packEntryName(candidate, key) === packageName);
    if (named.length !== 1) {
      const seen = entries.map(([key, candidate]) => packEntryName(candidate, key) ?? '<unnamed>');
      throw new TypeError(
        `npm pack --json returned ${String(named.length)} entries named ${JSON.stringify(packageName)}; `
        + `expected exactly one (saw: ${seen.map((name) => JSON.stringify(name)).join(', ')}).`,
      );
    }
    entry = named[0]?.[1];
  }
  if (!isRecord(entry) || typeof entry.filename !== 'string' || !Array.isArray(entry.files)) {
    throw new TypeError('npm pack --json returned an invalid pack entry; expected one object.');
  }
  const files = entry.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string') {
      throw new TypeError('npm pack --json returned an invalid file entry.');
    }
    return Object.freeze({ path: file.path });
  });
  return Object.freeze({ filename: entry.filename, files: Object.freeze(files) });
};

const toPosixRelative = (root: string, path: string): string =>
  relative(resolve(root), resolve(path)).replaceAll('\\', '/');

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const jsonRecord = async (path: string): Promise<Readonly<Record<string, unknown>>> => {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value)) throw new TypeError(`Expected a JSON object at ${JSON.stringify(path)}.`);
  return value;
};

const hostManifestPaths = (target: string): readonly string[] => {
  switch (target) {
    case 'claude':
      return Object.freeze(['.claude-plugin/plugin.json']);
    case 'codex':
      return Object.freeze(['.codex-plugin/plugin.json']);
    case 'cursor':
      return Object.freeze(['.cursor-plugin/plugin.json']);
    case 'plugin':
      return Object.freeze([
        '.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json',
        '.cursor-plugin/plugin.json',
      ]);
    case 'portable':
      return Object.freeze(['plugin.json']);
    default:
      return Object.freeze([]);
  }
};

const binEntries = (value: unknown): readonly [string, string][] => {
  if (typeof value === 'string') return Object.freeze([['bin', value] as const]);
  if (!isRecord(value)) return Object.freeze([]);
  return Object.freeze(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right)));
};

const diagnostic = (code: string, message: string, recovery: string): Diagnostic => Object.freeze({
  code,
  message,
  recovery,
  severity: 'error',
});

const quoteAll = (values: readonly string[]): string => values.map((value) => JSON.stringify(value)).join(', ');

/** One diagnostic per installed-dependency field that has offending entries, entries sorted by name. */
const perField = (
  entries: readonly DeclaredDependency[],
  emit: (field: InstalledDependencyField, entries: readonly DeclaredDependency[]) => Diagnostic,
): readonly Diagnostic[] => [...Map.groupBy(entries, (entry) => entry.field)]
  .map(([field, own]) => emit(field, own.toSorted((left, right) => left.name.localeCompare(right.name))));

/**
 * `AB7014`/`AB7015`: the build inlines every dependency into `dist/bin` and
 * the host packs, so an installed-dependency entry no packed JavaScript
 * imports only makes every consumer's `npm install` fetch a build-time
 * package — and fail outright when the specifier is one npm 12 refuses by
 * default (git, remote tarball, path).
 */
const dependencyDiagnostics = async (options: {
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly packedPaths: readonly string[];
  readonly packerUserAgent: string | undefined;
  readonly projectRoot: string;
}): Promise<readonly Diagnostic[]> => {
  const declared = declaredDependencies(options.packageDocument);
  if (declared.length === 0) return [];
  const imported = await importedPackageNames({ paths: options.packedPaths, projectRoot: options.projectRoot });
  const registry: RegistrySpecifierOptions = { workspaceProtocols: rewritesWorkspaceProtocols(options.packerUserAgent) };
  return [
    ...perField(declared.filter((dependency) => !imported.has(dependency.name)), (field, own) => diagnostic(
      'AB7014',
      `package.json ${field} names packages no packed JavaScript or declaration file imports: ${quoteAll(own.map((dependency) => dependency.name))}. `
        + 'Every consumer installs them for nothing; the emitted outputs already inline what they use.',
      'Move build-only packages to devDependencies, or import the package from a packed module if a consumer needs it at runtime.',
    )),
    ...perField(declared.filter((dependency) => !isRegistrySpecifier(dependency.specifier, registry)), (field, own) => diagnostic(
      'AB7015',
      `package.json ${field} resolves packages outside a registry: ${own.map((dependency) =>
        `${JSON.stringify(dependency.name)} -> ${JSON.stringify(dependency.specifier)}`).join(', ')}. `
        + 'npm 12 refuses git and remote fetches by default (allow-git, allow-remote) and rejects workspace protocols outright, so '
        + (field === 'optionalDependencies' ? 'every consumer install fails to fetch them.' : 'consumers cannot install the package.'),
      'Depend on a published registry version, or bundle the package and declare it under devDependencies. '
        + 'workspace: and catalog: are accepted only when pnpm, Yarn, or Bun runs the pack and rewrites them.',
    )),
  ];
};

export const packInventoryDiagnostics = async (options: {
  readonly artifactRoot: string;
  readonly model: NormalizedPlugin;
  readonly packageBuild: PackageBuildResult;
  readonly packOutput: PackOutput;
  /** `npm_config_user_agent` of the package manager running the pack; decides whether workspace protocols are rewritten. */
  readonly packerUserAgent: string | undefined;
  readonly projectRoot: string;
}): Promise<readonly Diagnostic[]> => {
  const projectRoot = resolve(options.projectRoot);
  const artifactRoot = resolve(options.artifactRoot);
  const artifactPrefix = toPosixRelative(projectRoot, artifactRoot);
  const packagePrefix = toPosixRelative(projectRoot, options.packageBuild.outputRoot);
  const manifestPath = join(artifactRoot, artifactManifestName);
  const manifest = parseArtifactManifest(await readFile(manifestPath, 'utf8'));
  const packageDocument = await jsonRecord(join(projectRoot, 'package.json'));
  const packed = new Set(options.packOutput.files.map((file) => file.path.replace(/^\.\//u, '')));
  const expected = new Set<string>([
    ...options.packageBuild.files.map((file) => `${packagePrefix}/${file.path}`),
    `${artifactPrefix}/${artifactManifestName}`,
    ...manifest.files.map((file) => `${artifactPrefix}/${file.path}`),
    ...manifest.targets.flatMap((target) =>
      installSurfaceRequirements(target.name).map((path) => `${artifactPrefix}/${target.name}/${path}`)),
    'README.md',
  ]);

  const diagnostics: Diagnostic[] = [];
  const missing = [...expected].filter((path) => !packed.has(path)).sort((left, right) => left.localeCompare(right));
  if (missing.length > 0) {
    diagnostics.push(diagnostic(
      'AB7010',
      `npm pack omits expected files: ${quoteAll(missing)}.`,
      'Add the exact paths (including dist and the artifact directory) to the package.json "files" allowlist.',
    ));
  }

  const stale: string[] = [];
  for (const file of manifest.files) {
    const bytes = await readFile(join(artifactRoot, file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) stale.push(`${artifactPrefix}/${file.path}`);
  }
  if (stale.length > 0) {
    diagnostics.push(diagnostic(
      'AB7011',
      `Artifact files no longer match their manifest hashes: ${quoteAll(stale.sort())}.`,
      'Run agent-bundle prepack again without modifying generated artifacts.',
    ));
  }

  const invalidBins = binEntries(packageDocument.bin)
    .filter(([, target]) => {
      const normalized = target.replace(/^\.\//u, '');
      return !normalized.startsWith(`${packagePrefix}/`) || normalized.startsWith('src/') || !packed.has(normalized);
    });
  if (invalidBins.length > 0) {
    diagnostics.push(diagnostic(
      'AB7012',
      `package.json bins must name packed dist outputs: ${invalidBins.map(([name, target]) =>
        `${JSON.stringify(name)} -> ${JSON.stringify(target)}`).join(', ')}.`,
      'Point every package.json bin value at its generated file under dist/bin and include that file in "files".',
    ));
  }

  const versions: Array<readonly [string, unknown]> = [
    ['package.json', packageDocument.version],
    ['normalized plugin', options.model.metadata.version],
    ['artifact provenance', manifest.project.packageVersion],
  ];
  for (const target of manifest.targets) {
    for (const path of hostManifestPaths(target.name)) {
      const absolute = join(artifactRoot, target.name, path);
      if (await exists(absolute)) {
        versions.push([`${target.name}/${path}`, (await jsonRecord(absolute)).version]);
      }
    }
  }
  const expectedVersion = options.model.metadata.version;
  const disagreements = versions
    .filter(([, version]) => version !== expectedVersion)
    .map(([source, version]) => `${source}=${JSON.stringify(version)}`)
    .sort((left, right) => left.localeCompare(right));
  if (disagreements.length > 0) {
    diagnostics.push(diagnostic(
      'AB7013',
      `Release versions disagree with normalized plugin version ${JSON.stringify(expectedVersion)}: ${disagreements.join(', ')}.`,
      'Set package.json, plugin metadata, generated host manifests, and artifact provenance to one semantic version.',
    ));
  }

  diagnostics.push(...await dependencyDiagnostics({
    packageDocument,
    packedPaths: [...packed],
    packerUserAgent: options.packerUserAgent,
    projectRoot,
  }));

  return deepFreeze(diagnostics.sort((left, right) => left.code.localeCompare(right.code)));
};
