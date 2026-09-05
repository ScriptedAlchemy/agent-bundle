import { lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import type { NormalizedPlugin } from '../core/types.ts';
import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { sha256Hex } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import { readFileBytes, readFileString, runWithPlatform } from '../effect/platform.ts';
import { installSurfaceRequirements } from '../install/surface.ts';
import { artifactManifestName } from './emit.ts';
import { parseArtifactManifest } from './manifest.ts';
import {
  classifyDependency,
  declaredDependencies,
  importedPackageNames,
  isWorkspaceProtocol,
  packagedSourceInstallable,
  packagedSourcePath,
  type DeclaredDependency,
  type DependencyKind,
  type InstalledDependencyField,
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

/** Stays on `lstat`: a dangling symlink at a host manifest path still counts as present. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

const jsonRecord = async (path: string): Promise<Readonly<Record<string, unknown>>> => {
  const value: unknown = JSON.parse(await runWithPlatform(readFileString(path)));
  if (!isRecord(value)) throw new TypeError(`Expected a JSON object at ${JSON.stringify(path)}.`);
  return value;
};

const binEntries = (value: unknown): readonly [string, string][] => {
  if (typeof value === 'string') return Object.freeze([['bin', value] as const]);
  if (!isRecord(value)) return Object.freeze([]);
  return Object.freeze(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right)));
};

const diagnostic = (code: string, message: string, recovery: string, severity: DiagnosticSeverity = 'error'): Diagnostic =>
  Object.freeze({ code, message, recovery, severity });

const quoteAll = (values: readonly string[]): string => values.map((value) => JSON.stringify(value)).join(', ');

/** One diagnostic per installed-dependency field that has offending entries, entries sorted by name. */
const perField = (
  entries: readonly DeclaredDependency[],
  emit: (field: InstalledDependencyField, entries: readonly DeclaredDependency[]) => Diagnostic,
): readonly Diagnostic[] => [...Map.groupBy(entries, (entry) => entry.field)]
  .map(([field, own]) => emit(field, own.toSorted((left, right) => left.name.localeCompare(right.name))));

/**
 * `AB7014`/`AB7015`: the build inlines every dependency into `dist` and the
 * host packs, so an installed-dependency entry no packed file references
 * only makes every consumer's `npm install` fetch a build-time package — and
 * fail outright when the specifier is one a consumer's npm cannot resolve
 * (git, remote tarball, path, or an unrewritten workspace protocol). A
 * compiled bundle cannot `import` a bare package at all: `AB6005` fails the
 * build on any import specifier that is not a Node built-in, and `prepack`
 * runs that build before this inventory, so the import evidence `AB7014`
 * accepts comes only from modules the framework copied rather than compiled
 * — prebuilt payload modules and other scripts the `files` allowlist packs —
 * never from a `dist` bundle or a host-pack module. A `require`,
 * `createRequire(…)(…)`, or `import.meta.resolve(…)` call is not an import
 * and `AB6005` does not walk it, so that evidence is read from every packed
 * file, compiled bundles included.
 */
const unresolvableMessage = (field: InstalledDependencyField, own: readonly DeclaredDependency[]): string =>
  `package.json ${field} names packages a consumer's npm cannot resolve through a registry (an invalid name or a non-registry specifier): ${own.map((dependency) =>
    `${JSON.stringify(dependency.name)} -> ${JSON.stringify(dependency.specifier)}`).join(', ')}; `;

const unresolvableRecovery = 'Depend on a published registry version, or bundle the package and declare it under devDependencies. '
  + 'npm 12 refuses git and remote fetches by default (allow-git, allow-remote) and never accepts workspace: or catalog:, '
  + 'which only pnpm, Yarn, or Bun rewrite while packing.';

const dependencyDiagnostics = async (options: {
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly packedPaths: readonly string[];
  readonly packerRewritesWorkspaceProtocols: boolean;
  readonly projectRoot: string;
}): Promise<readonly Diagnostic[]> => {
  const declared = declaredDependencies(options.packageDocument);
  if (declared.length === 0) return [];
  // `prepack` runs the build before this inventory, and `AB6005` there refuses every bare import in a compiled
  // bundle, so any `import` evidence found here belongs to a packed module the framework did not compile; the
  // `require`/`createRequire`/`import.meta.resolve` evidence is not an import and may come from any packed file.
  const imported = await importedPackageNames({
    declared: declared.filter((dependency) => dependency.installed).map((dependency) => dependency.name),
    packageDocument: options.packageDocument,
    paths: options.packedPaths,
    projectRoot: options.projectRoot,
  });
  // The tarball itself may carry the dependency: `bundleDependencies` exempts an entry only when npm actually
  // packed it (a name absent from node_modules at pack time is silently dropped, and the consumer neither
  // fetches nor finds it), and a `file:` path inside the package is installed from the consumer's own copy
  // when the packed source is installable: a directory with a parseable manifest, or a tarball holding a package.
  const packed = new Set(options.packedPaths);
  const embeddedSources = new Set<DeclaredDependency>();
  for (const dependency of declared) {
    const source = packagedSourcePath(dependency.name, dependency.specifier);
    if (source !== undefined && await packagedSourceInstallable(options.projectRoot, source, packed)) {
      embeddedSources.add(dependency);
    }
  }
  const embedded = (dependency: DeclaredDependency): boolean =>
    (dependency.bundled && packed.has(`node_modules/${dependency.name}/package.json`)) || embeddedSources.has(dependency);
  // A workspace protocol the packer rewrites reaches the consumer as a registry version; every other entry
  // is read as npm itself reads it.
  const kindOf = (dependency: DeclaredDependency): DependencyKind =>
    isWorkspaceProtocol(dependency.specifier) && options.packerRewritesWorkspaceProtocols
      ? 'registry'
      : classifyDependency(dependency.name, dependency.specifier);
  const kinds = new Map(declared.map((dependency) => [dependency, kindOf(dependency)]));
  // A consumer's install fails on a fetch npm refuses (installed entries only), or on a name or specifier npm
  // cannot parse — which it reads even for a peer it never installs.
  const unresolvable = declared.filter((dependency) => !embedded(dependency)
    && (dependency.installed ? kinds.get(dependency) !== 'registry' : kinds.get(dependency) === 'unparseable'));
  // An optional dependency npm parses but cannot fetch: the install continues without it — unless a consumer
  // install script then runs it, or loads it from a packed file it runs, and fails on the missing package.
  const survivable = (dependency: DeclaredDependency): boolean =>
    dependency.field === 'optionalDependencies'
    && kinds.get(dependency) === 'fetched'
    && !imported.installScripts.has(dependency.name);
  // A computed import() may load any declared package; nothing can then be called unused.
  const unused = imported.complete
    ? declared.filter((dependency) => dependency.installed && !imported.names.has(dependency.name))
    : [];
  return [
    // A peer nothing imports may be a deliberate compatibility contract with the host that loads the package;
    // npm 7+ still installs it for every consumer, so it is worth a look, not a refusal.
    ...perField(unused, (field, own) => diagnostic(
      'AB7014',
      `package.json ${field} names packages no packed JavaScript or declaration file references, runs, or install script needs: ${quoteAll(own.map((dependency) => dependency.name))}. `
        + (field === 'peerDependencies'
          ? 'If they only constrain the host version, that is a compatibility contract; npm 7+ still installs them for every consumer.'
          : 'Every consumer installs them for nothing; the emitted outputs already inline what they use.'),
      field === 'peerDependencies'
        ? 'Keep a deliberate compatibility peer, mark it optional in peerDependenciesMeta so npm stops installing it, or move a build-only package to devDependencies.'
        : 'Move build-only packages to devDependencies; compiled bundles inline their imports (AB6005), so keep a runtime dependency only for what a prebuilt payload or other uncompiled packed module imports, a packed file requires or resolves (createRequire, import.meta.resolve), a packed declaration file references, a #subpath import reaches through the imports map, or an install script or packed JavaScript runs; a computed import() or require() in packed code withholds this check.',
      field === 'peerDependencies' ? 'warning' : 'error',
    )),
    // npm skips an optional dependency it cannot fetch, so the install survives — but only once the specifier parsed
    // (an unsupported protocol or invalid selector fails the manifest read itself, whichever field declares it) and
    // only when no install script then runs the skipped package's command.
    ...perField(unresolvable.filter((dependency) => !survivable(dependency)), (field, own) => diagnostic(
      'AB7015',
      `${unresolvableMessage(field, own)}consumers cannot install the package.`,
      unresolvableRecovery,
    )),
    ...perField(unresolvable.filter(survivable), (field, own) => diagnostic(
      'AB7015',
      `${unresolvableMessage(field, own)}every consumer install tries and fails to fetch them, then continues without them.`,
      unresolvableRecovery,
      'warning',
    )),
  ];
};

export const packInventoryDiagnostics = async (options: {
  readonly artifactRoot: string;
  readonly model: NormalizedPlugin;
  readonly packageBuild: PackageBuildResult;
  readonly packOutput: PackOutput;
  /** Whether the package manager packing the tarball rewrites `workspace:`/`catalog:` to registry versions. */
  readonly packerRewritesWorkspaceProtocols: boolean;
  readonly projectRoot: string;
}): Promise<readonly Diagnostic[]> => {
  const projectRoot = resolve(options.projectRoot);
  const artifactRoot = resolve(options.artifactRoot);
  const artifactPrefix = toPosixRelative(projectRoot, artifactRoot);
  const packagePrefix = toPosixRelative(projectRoot, options.packageBuild.outputRoot);
  const manifestPath = join(artifactRoot, artifactManifestName);
  const manifest = parseArtifactManifest(await runWithPlatform(readFileString(manifestPath)));
  const packageDocument = await jsonRecord(join(projectRoot, 'package.json'));
  const packed = new Set(options.packOutput.files.map((file) => file.path.replace(/^\.\//u, '')));
  const expected = new Set<string>([
    ...options.packageBuild.files.map((file) => `${packagePrefix}/${file.path}`),
    `${artifactPrefix}/${artifactManifestName}`,
    ...manifest.files.map((file) => `${artifactPrefix}/${file.path}`),
    ...installSurfaceRequirements(manifest.projections.map((projection) => projection.host))
      .map((path) => `${artifactPrefix}/${path}`),
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
    const bytes = await runWithPlatform(readFileBytes(join(artifactRoot, file.path)));
    if (sha256Hex(bytes) !== file.sha256) stale.push(`${artifactPrefix}/${file.path}`);
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
    ['artifact manifest', manifest.application.version],
    ['artifact provenance', manifest.project.packageVersion],
  ];
  // The host plugin manifests are wherever the artifact manifest points (#592
  // step 3), never a per-host path convention.
  for (const projection of manifest.projections) {
    const path = projection.documents.plugin;
    if (path === undefined) continue;
    const absolute = join(artifactRoot, path);
    if (await exists(absolute)) {
      versions.push([path, (await jsonRecord(absolute)).version]);
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
    packerRewritesWorkspaceProtocols: options.packerRewritesWorkspaceProtocols,
    projectRoot,
  }));

  return deepFreeze(diagnostics.sort((left, right) => left.code.localeCompare(right.code)));
};
