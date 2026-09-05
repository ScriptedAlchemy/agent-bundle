import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  parseJsonWithoutDuplicateKeys,
  snapshotStrictJsonValue,
  type JsonValue,
} from '../core/strict-json.ts';
import type {
  AgentBundleToolsConfig,
  NormalizedPackageBuild,
  NormalizedPlugin,
} from '../core/types.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside, toPosixRelative } from '../core/paths.ts';
import type { CompileResult } from './compile-result.ts';
import { buildWithRslib } from './compiler.ts';
import { declarationBuildDiagnostics, replayDeclarationEmit } from './declaration-diagnostics.ts';
import { listArtifactFiles, publishArtifact, resolveArtifactDestination } from './emit.ts';
import { scanEntryExports } from './entry-exports.ts';
import {
  generatedExecutableEntrySource,
  terminalCapabilityRuntimePath,
  terminalCapabilityRuntimeSpecifier,
} from './entry-shell.ts';
import { readArtifactManifest } from './manifest-file.ts';
import { artifactManifestName, type ArtifactManifest, type ArtifactManifestFileKind } from './manifest.ts';
import { projectMeta } from './meta.ts';
import { bundleSyntaxCheckFor } from './module-imports.ts';
import { isDeclarationGenerationFailure, type RslibEntry } from './rslib.ts';
import { runtimeIgnoredRoot } from './runtime-path.ts';
import { validateJavaScriptModules } from './validate-artifact-modules.ts';

/**
 * The framework-owned npm root: the proven artifact tree is copied unchanged,
 * then authored package-only bins and the optional library entry are added.
 * Routed CLI bins are never recompiled here; package.json points at the
 * artifact executable recorded by agent-bundle.manifest.json.
 */

const binShebang = '#!/usr/bin/env node';
const executableMode = 0o755;

export interface PackageOutputFile {
  readonly bytes: number;
  readonly kind: ArtifactManifestFileKind;
  /** Present only for executable outputs. */
  readonly mode?: number;
  /** POSIX path relative to the package output root. */
  readonly path: string;
  readonly sha256: string;
  /** Sorted, unique POSIX paths relative to the project root. */
  readonly sourceInputs: readonly string[];
}

export interface PackageBuildResult {
  readonly files: readonly PackageOutputFile[];
  readonly outputRoot: string;
}

const relativeSourceInputs = (projectRoot: string, inputs: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(inputs.map((input) => toPosixRelative(projectRoot, assertInside(projectRoot, input))))]
    .sort((left, right) => left.localeCompare(right)));

export interface PlannedPackageEntry extends RslibEntry {
  readonly executable: boolean;
}

/**
 * Declaration generation compiles the lib entry's source directory as its own
 * program — the project tsconfig typically also covers tests and config
 * files, which must never fail or pollute the package build. The synthesized
 * project extends the project's own `tsconfig.json` (compiler options such as
 * `jsx` and strictness) and pins `rootDir` so declarations land flat in the
 * package output, exactly like the dedicated build tsconfig consumers
 * previously maintained by hand.
 */
const synthesizeDtsTsconfig = async (options: {
  readonly projectRoot: string;
  readonly sourceDir: string;
}): Promise<{ readonly cleanup: () => Promise<void>; readonly path: string }> => {
  // The synthesized project lives under node_modules (mandatory-ignored for
  // source snapshots) so `types` and other tsconfig lookups resolve against
  // the project's own installed packages.
  await mkdir(resolve(options.projectRoot, 'node_modules'), { recursive: true });
  const root = await mkdtemp(resolve(options.projectRoot, 'node_modules', '.agent-bundle-dts-'));
  const projectTsconfig = resolve(options.projectRoot, 'tsconfig.json');
  const path = join(root, 'tsconfig.json');
  await writeFile(path, `${JSON.stringify({
    ...(existsSync(projectTsconfig) ? { extends: projectTsconfig } : {}),
    compilerOptions: { rootDir: options.sourceDir },
    // Colocated tests must neither fail the declaration build nor publish
    // test declarations into the package output.
    exclude: [
      `${options.sourceDir}/**/*.test.*`,
      `${options.sourceDir}/**/*.spec.*`,
      `${options.sourceDir}/**/__tests__/**`,
    ],
    include: [`${options.sourceDir}/**/*.ts`, `${options.sourceDir}/**/*.tsx`],
  }, null, 2)}\n`, 'utf8');
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    path,
  };
};

export const planPackageEntries = async (
  model: NormalizedPlugin,
  dtsTsconfigPath: string | undefined,
): Promise<readonly PlannedPackageEntry[]> => {
  const packageBuild = model.packageBuild;
  if (packageBuild === undefined) return Object.freeze([]);
  const entries: PlannedPackageEntry[] = [];
  for (const bin of packageBuild.bins) {
    if (bin.generatedCli !== undefined) continue;
    // A bin entry exporting `main` (or a default function) receives the
    // generated process envelope; a self-executing module bundles directly.
    const exports = await scanEntryExports(bin.source);
    const exportName = exports.hasMainExport ? 'main' as const : exports.hasDefaultExport ? 'default' as const : undefined;
    entries.push({
      banner: binShebang,
      executable: true,
      name: `bin-${bin.name}`,
      outputRelativePath: `bin/${bin.name}.js`,
      source: bin.source,
      sourceInputs: Object.freeze([bin.provenance.sourcePath, bin.source]),
      ...(exportName === undefined
        ? {}
        : {
          // The envelope probes the terminal (#511) through the aliased
          // dependency-free runtime module, like the cli-entry shell.
          aliases: { [terminalCapabilityRuntimeSpecifier]: terminalCapabilityRuntimePath() },
          virtualSource: generatedExecutableEntrySource({ entrySource: bin.source, exportName, hostSurface: 'cli' }),
        }),
    });
  }
  if (packageBuild.lib !== undefined) {
    const lib = packageBuild.lib;
    entries.push({
      dts: lib.dts,
      executable: false,
      name: lib.name,
      outputRelativePath: `${lib.name}.js`,
      source: lib.source,
      sourceInputs: Object.freeze([lib.provenance.sourcePath, lib.source]),
      ...(lib.dts && dtsTsconfigPath !== undefined ? { tsconfigPath: dtsTsconfigPath } : {}),
    });
  }
  return Object.freeze(entries);
};

/**
 * Runs the synthesized package build, translating a declaration-generation
 * abort into `AB4716` errors that name the underlying TypeScript diagnostics.
 * The bundler reports declaration failures as one prose line, so the detail is
 * recovered by replaying declaration emit over the same synthesized project
 * the failed pass used — which is exactly the manual
 * `tsc --declaration --emitDeclarationOnly` triage this removes.
 */
const buildPackageEntries = async (
  options: Parameters<typeof buildWithRslib>[0],
  declaration: { readonly entryName: string; readonly tsconfigPath: string } | undefined,
): Promise<CompileResult> => {
  try {
    return await buildWithRslib(options);
  } catch (error) {
    if (declaration === undefined || !isDeclarationGenerationFailure(error)) throw error;
    throw new DiagnosticError(declarationBuildDiagnostics({
      entryName: declaration.entryName,
      failure: error instanceof Error ? error.message : String(error),
      projectRoot: options.cwd,
      typeScriptDiagnostics: await replayDeclarationEmit({
        projectRoot: options.cwd,
        tsconfigPath: declaration.tsconfigPath,
      }),
    }));
  }
};

/** Maps one emitted `.d.ts` back to the authored module it declares. */
const declarationSource = (sourceDir: string, declarationPath: string): string | undefined => {
  const stem = declarationPath.slice(0, -'.d.ts'.length);
  for (const extension of ['.ts', '.tsx', '.mts']) {
    const candidate = resolve(sourceDir, `${stem}${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const packagePath = (outputDir: string, value: JsonValue): JsonValue => {
  if (typeof value === 'string') {
    const directory = outputDir.replaceAll('\\', '/');
    const explicitPrefix = `./${directory}/`;
    if (value.startsWith(explicitPrefix)) return `./${value.slice(explicitPrefix.length)}`;
    const prefix = `${directory}/`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => packagePath(outputDir, entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, packagePath(outputDir, entry)]));
  }
  return value;
};

const packageScripts = (value: JsonValue): JsonValue => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return value;
  const omitted = new Set([
    'postpack',
    'postpublish',
    'prepare',
    'prepack',
    'prepublish',
    'prepublishOnly',
    'publish',
  ]);
  return Object.fromEntries(Object.entries(value).filter(([name]) => !omitted.has(name)));
};

const packageDocument = async (
  projectRoot: string,
  packageBuild: NormalizedPackageBuild,
  manifest: ArtifactManifest,
): Promise<Readonly<Record<string, JsonValue>>> => {
  const source = snapshotStrictJsonValue(
    parseJsonWithoutDuplicateKeys(await readFile(join(projectRoot, 'package.json'), 'utf8')),
  );
  if (source === null || Array.isArray(source) || typeof source !== 'object') {
    throw new Error('package.json must contain a JSON object.');
  }
  const bins = Object.fromEntries(packageBuild.bins.map((bin) => {
    if (bin.generatedCli === undefined) return [bin.name, `./bin/${bin.name}.js`];
    const executable = manifest.executables.bins.find((entry) => entry.name === bin.name);
    if (executable === undefined) {
      throw new DiagnosticError([{
        code: 'AB4767',
        message: `The npm package declares routed CLI ${JSON.stringify(bin.name)}, but the artifact manifest has no executable for it.`,
        recovery: 'Select a target whose adapter publishes the cli capability, or set bin: false.',
        severity: 'error',
        sourcePath: bin.provenance.sourcePath,
      }]);
    }
    return [bin.name, `./${executable.path}`];
  }));
  const transformed = Object.fromEntries(Object.entries(source)
    .filter(([key]) => !['bin', 'files'].includes(key))
    .map(([key, value]) => [
      key,
      key === 'scripts'
        ? packageScripts(value)
        : ['exports', 'imports', 'main', 'module', 'types', 'typesVersions'].includes(key)
        ? packagePath(packageBuild.outputDir, value)
        : value,
    ]));
  return Object.freeze({
    ...transformed,
    ...(Object.keys(bins).length === 0 ? {} : { bin: bins }),
  });
};

const copyArtifactRoot = async (
  artifactRoot: string,
  stageRoot: string,
  manifest: ArtifactManifest,
): Promise<void> => {
  for (const file of [...manifest.files, { path: artifactManifestName }]) {
    const destination = resolveArtifactDestination(stageRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolveArtifactDestination(artifactRoot, file.path), destination);
  }
};

const copyStandardPackageFiles = async (
  projectRoot: string,
  stageRoot: string,
): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  for (const name of ['README.md', 'LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md']) {
    const source = join(projectRoot, name);
    if (!existsSync(source)) continue;
    const destination = join(stageRoot, name);
    if (existsSync(destination)) throw new Error(`Package metadata collides with artifact file ${JSON.stringify(name)}.`);
    await copyFile(source, destination);
    sources.set(name, source);
  }
  return sources;
};

export const buildPackageOutputs = async (options: {
  readonly artifactRoot: string;
  readonly model: NormalizedPlugin;
  readonly projectRoot: string;
  readonly tools?: AgentBundleToolsConfig;
}): Promise<PackageBuildResult | undefined> => {
  const packageBuild = options.model.packageBuild;
  if (packageBuild === undefined) return undefined;
  const projectRoot = resolve(options.projectRoot);
  const artifactRoot = resolve(options.artifactRoot);
  const manifestRead = await readArtifactManifest(artifactRoot);
  if (manifestRead.status !== 'ok') {
    throw new Error(`Cannot build npm root from ${JSON.stringify(manifestRead.path)}: ${manifestRead.status}.`);
  }
  const manifest = manifestRead.manifest;
  const outputRoot = assertInside(projectRoot, resolve(projectRoot, packageBuild.outputDir));
  const libSourceDir = packageBuild.lib === undefined ? undefined : dirname(packageBuild.lib.source);
  const dtsTsconfig = packageBuild.lib?.dts === true && libSourceDir !== undefined
    ? await synthesizeDtsTsconfig({ projectRoot, sourceDir: libSourceDir })
    : undefined;
  const entries = await planPackageEntries(options.model, dtsTsconfig?.path);

  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));
  const compileRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.compile-`));
  try {
    const ignoredRuntimeRoots = Object.freeze([...new Set([
      ...(entries.some((entry) => entry.aliases?.[terminalCapabilityRuntimeSpecifier] !== undefined)
        ? [runtimeIgnoredRoot(terminalCapabilityRuntimePath())]
        : []),
    ])]);
    const evidence = entries.length === 0
      ? { assets: Object.freeze([]), diagnostics: Object.freeze([]) }
      : await buildPackageEntries({
        cwd: projectRoot,
        diagnosticPathPrefix: toPosixRelative(projectRoot, outputRoot),
        entries,
        ...(ignoredRuntimeRoots.length === 0 ? {} : { ignoredSourcePaths: ignoredRuntimeRoots }),
        logLevel: 'error',
        meta: projectMeta(options.model.metadata),
        outputRoot: compileRoot,
        ...(options.tools === undefined ? {} : { tools: options.tools }),
      }, dtsTsconfig === undefined || packageBuild.lib === undefined
        ? undefined
        : { entryName: packageBuild.lib.name, tsconfigPath: dtsTsconfig.path });
    const evidenceByPath = new Map(evidence.assets.map((entry) => [entry.path, entry.sourceInputs]));
    await Promise.all(entries
      .filter((entry) => entry.executable)
      .map((entry) => chmod(resolveArtifactDestination(compileRoot, entry.outputRelativePath), executableMode)));

    await copyArtifactRoot(artifactRoot, stageRoot, manifest);
    for (const file of await listArtifactFiles(compileRoot)) {
      const destination = resolveArtifactDestination(stageRoot, file.path);
      if (existsSync(destination)) throw new Error(`Package output collides with artifact file ${JSON.stringify(file.path)}.`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolveArtifactDestination(compileRoot, file.path), destination);
    }
    const packageJsonSource = join(projectRoot, 'package.json');
    if (existsSync(join(stageRoot, 'package.json'))) {
      throw new Error('Package metadata collides with artifact file "package.json".');
    }
    await writeFile(
      join(stageRoot, 'package.json'),
      `${JSON.stringify(await packageDocument(projectRoot, packageBuild, manifest), null, 2)}\n`,
      'utf8',
    );
    const packageSources = await copyStandardPackageFiles(projectRoot, stageRoot);
    packageSources.set('package.json', packageJsonSource);

    const lib = packageBuild.lib;
    const provenanceByPath = new Map(manifest.compiler.provenance.map((entry) => [entry.path, entry.sourceInputs]));
    const artifactByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
    const staged = await listArtifactFiles(stageRoot);
    const files = staged.map((file): PackageOutputFile => {
      const bundled = evidenceByPath.get(file.path);
      const artifact = artifactByPath.get(file.path);
      const packageSource = packageSources.get(file.path);
      const declared = lib?.dts === true && libSourceDir !== undefined && file.path.endsWith('.d.ts')
        ? declarationSource(libSourceDir, file.path) ?? lib.source
        : undefined;
      if (
        bundled === undefined &&
        declared === undefined &&
        artifact === undefined &&
        packageSource === undefined &&
        file.path !== artifactManifestName
      ) {
        throw new Error(`Package build emitted unexpected output ${JSON.stringify(file.path)}.`);
      }
      let generatedSourceInputs: readonly string[];
      if (bundled !== undefined) {
        generatedSourceInputs = bundled;
      } else if (declared !== undefined) {
        if (lib === undefined) {
          throw new Error(`Declaration output has no package library entry: ${JSON.stringify(file.path)}.`);
        }
        generatedSourceInputs = [lib.provenance.sourcePath, declared];
      } else {
        generatedSourceInputs = [packageSource ?? options.model.metadata.provenance.sourcePath];
      }
      return {
        bytes: file.bytes,
        kind: artifact?.kind ?? (bundled === undefined ? 'generated' : 'bundle'),
        ...((file.mode & 0o111) === 0 ? {} : { mode: file.mode }),
        path: file.path,
        sha256: file.sha256,
        sourceInputs: artifact === undefined
          ? relativeSourceInputs(projectRoot, generatedSourceInputs)
          : provenanceByPath.get(file.path) ?? Object.freeze([]),
      };
    }).sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of entries) {
      if (!files.some((file) => file.path === entry.outputRelativePath)) {
        throw new Error(`Package build did not emit expected output ${JSON.stringify(entry.outputRelativePath)}.`);
      }
    }
    if (lib?.dts === true && !files.some((file) => file.path === `${lib.name}.d.ts`)) {
      throw new Error(`Package build did not emit expected declarations ${JSON.stringify(`${lib.name}.d.ts`)}.`);
    }

    // The npm form of the plugin is held to the same line as its host packs:
    // every emitted `dist` module is walked as an ES module, and a bare
    // specifier that is not a Node built-in — an import the `tools` hatch
    // kept external — fails the build (`AB6005`) before `dist` is published,
    // so a `dist/bin` executable imports nothing from a consumer's
    // `node_modules`. The walk reads import specifiers (static and literal
    // dynamic); a `createRequire(…)(…)` or `import.meta.resolve(…)` call is
    // not an import and is outside it, in `dist` as in a host pack — the
    // prepack gate reads those as dependency evidence. Declarations are not
    // modules and are not walked; they may still reference declared
    // dependencies.
    const selfContainment = await validateJavaScriptModules({
      artifactRoot: stageRoot,
      bundledPaths: new Set(files.filter((file) => file.kind === 'bundle').map((file) => file.path)),
      bundleSyntaxCheck: bundleSyntaxCheckFor(options.tools),
      files: staged.filter((file) => !artifactByPath.has(file.path)),
      reportedRoot: toPosixRelative(projectRoot, outputRoot),
      validJson: new Set(),
    });
    if (selfContainment.length > 0) throw new DiagnosticError(selfContainment);

    await publishArtifact({ outputRoot, stageRoot });
    return Object.freeze({ files: Object.freeze(files), outputRoot });
  } finally {
    // publishArtifact removes the stage on success; a failed build leaves it.
    await rm(stageRoot, { force: true, recursive: true });
    await rm(compileRoot, { force: true, recursive: true });
    await dtsTsconfig?.cleanup();
  }
};
