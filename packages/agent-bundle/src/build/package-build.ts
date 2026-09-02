import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { AgentBundleToolsConfig, NormalizedPlugin } from '../core/types.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside } from '../core/paths.ts';
import { declarationBuildDiagnostics, replayDeclarationEmit } from './declaration-diagnostics.ts';
import { listArtifactFiles, publishArtifact, resolveArtifactDestination } from './emit.ts';
import { scanEntryExports } from './entry-exports.ts';
import { runtimeIgnoredRoot } from './entries.ts';
import {
  cliEntryRuntimePath,
  cliEntryRuntimeSpecifier,
  generatedCliBinEntrySource,
  generatedExecutableEntrySource,
  generatedInstallBinEntrySource,
  generatedRenderedRouteWorkerSource,
  installEntryRuntimePath,
  installEntryRuntimeSpecifier,
} from './entry-shell.ts';
import { projectMeta } from './meta.ts';
import type { BundledOutputEvidence } from './provenance.ts';
import { buildWithRslib, isDeclarationGenerationFailure, type RslibEntry } from './rslib.ts';

/**
 * The framework-owned npm package build: `bin` entries become self-executing
 * `dist/bin/<name>.js` bundles (shebang + executable bit) and the `lib` entry
 * becomes `dist/<name>.js` (+ a bundleless `.d.ts` declaration graph), all
 * through the same Rslib synthesis, invariant assertions, and staged atomic
 * publication as artifact executables. This is the build audiobook-curator
 * previously needed a second bundler config, a tsconfig, and a hand-written
 * bin shim to produce.
 */

const binShebang = '#!/usr/bin/env node';
const executableMode = 0o755;

export interface PackageOutputFile {
  readonly bytes: number;
  readonly kind: 'bundle' | 'generated';
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

const toPosixRelative = (root: string, path: string): string =>
  relative(resolve(root), path).replaceAll('\\', '/');

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
  options: {
    readonly artifactRoot?: string;
    readonly packageOutputRoot?: string;
  } = {},
): Promise<readonly PlannedPackageEntry[]> => {
  const packageBuild = model.packageBuild;
  if (packageBuild === undefined) return Object.freeze([]);
  const entries: PlannedPackageEntry[] = [];
  for (const bin of packageBuild.bins) {
    if (bin.generatedCli !== undefined) {
      // A routed-CLI bin compiles the framework-generated command program;
      // the cli-entry runtime shell is aliased in so the emitted executable
      // stays self-contained, exactly like generated stdio MCP entries.
      // Rendered commands add one sibling react-server Flight worker.
      const rendered = bin.generatedCli.commands.some((command) => command.rendered);
      const workerFile = `${bin.name}-flight.mjs`;
      const sourceInputs = Object.freeze([...new Set([
        bin.provenance.sourcePath,
        ...bin.generatedCli.routes.map((route) => route.source),
        ...(model.providers ?? []).map((provider) => provider.source),
        ...(model.state === undefined ? [] : [model.state.source]),
      ])]);
      entries.push({
        aliases: { [cliEntryRuntimeSpecifier]: cliEntryRuntimePath() },
        banner: binShebang,
        executable: true,
        name: `bin-${bin.name}`,
        outputRelativePath: `bin/${bin.name}.js`,
        ...(rendered ? { rscManifest: true as const } : {}),
        source: bin.source,
        sourceInputs,
        virtualSource: generatedCliBinEntrySource({
          commands: bin.generatedCli.commands,
          plugin: {
            ...(model.metadata.description === undefined ? {} : { description: model.metadata.description }),
            name: model.metadata.name,
            version: model.metadata.version,
          },
          routes: bin.generatedCli.routes,
          ...(model.state === undefined ? {} : { state: model.state }),
          ...(rendered ? { workerFile } : {}),
        }),
      });
      if (rendered) {
        const renderedRoutes = bin.generatedCli.routes.filter((route) =>
          bin.generatedCli!.commands.some((command) => command.rendered && command.routeId === route.id));
        entries.push({
          executable: false,
          name: `bin-${bin.name}-flight`,
          outputRelativePath: `bin/${workerFile}`,
          reactServer: true,
          rscManifest: true,
          source: bin.source,
          sourceInputs,
          virtualSource: generatedRenderedRouteWorkerSource({
            providers: model.providers ?? [],
            routes: renderedRoutes,
            ...(model.state === undefined ? {} : { state: model.state }),
          }),
        });
      }
      continue;
    }
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
        : { virtualSource: generatedExecutableEntrySource({ entrySource: bin.source, exportName }) }),
    });
  }
  const installHosts = Object.freeze((['claude', 'codex', 'cursor'] as const)
    .filter((host) => model.targets.some((target) => target.name === host || target.name === 'plugin')));
  if (
    installHosts.length > 0 &&
    options.artifactRoot !== undefined &&
    options.packageOutputRoot !== undefined
  ) {
    const occupiedNames = new Set(packageBuild.bins.map((bin) => bin.name));
    let name = model.metadata.name;
    if (occupiedNames.has(name)) {
      name = `${model.metadata.name}-install`;
      let suffix = 2;
      while (occupiedNames.has(name)) {
        name = `${model.metadata.name}-install-${String(suffix)}`;
        suffix += 1;
      }
    }
    const outputRelativePath = `bin/${name}.js`;
    const emittedBinDirectory = dirname(resolve(options.packageOutputRoot, outputRelativePath));
    const relativeArtifact = relative(emittedBinDirectory, options.artifactRoot).replaceAll('\\', '/');
    const source = packageBuild.bins[0]?.source ?? packageBuild.lib!.source;
    entries.push({
      aliases: { [installEntryRuntimeSpecifier]: installEntryRuntimePath() },
      banner: binShebang,
      executable: true,
      name: `bin-${name}`,
      outputRelativePath,
      source,
      sourceInputs: Object.freeze([model.metadata.provenance.sourcePath, source]),
      virtualSource: generatedInstallBinEntrySource({
        artifactRelativeUrl: relativeArtifact === '' ? './' : `${relativeArtifact}/`,
        hosts: installHosts,
        name,
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
): Promise<readonly BundledOutputEvidence[]> => {
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

export const buildPackageOutputs = async (options: {
  readonly artifactRoot?: string;
  readonly model: NormalizedPlugin;
  readonly projectRoot: string;
  readonly tools?: AgentBundleToolsConfig;
}): Promise<PackageBuildResult | undefined> => {
  const packageBuild = options.model.packageBuild;
  if (packageBuild === undefined) return undefined;
  const projectRoot = resolve(options.projectRoot);
  const outputRoot = assertInside(projectRoot, resolve(projectRoot, packageBuild.outputDir));
  const libSourceDir = packageBuild.lib === undefined ? undefined : dirname(packageBuild.lib.source);
  const dtsTsconfig = packageBuild.lib?.dts === true && libSourceDir !== undefined
    ? await synthesizeDtsTsconfig({ projectRoot, sourceDir: libSourceDir })
    : undefined;
  const entries = await planPackageEntries(options.model, dtsTsconfig?.path, {
    ...(options.artifactRoot === undefined ? {} : { artifactRoot: resolve(options.artifactRoot) }),
    packageOutputRoot: outputRoot,
  });
  if (entries.length === 0) {
    await dtsTsconfig?.cleanup();
    return undefined;
  }

  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));
  try {
    const ignoredRuntimeRoots = Object.freeze([
      ...(entries.some((entry) => entry.aliases?.[cliEntryRuntimeSpecifier] !== undefined)
        ? [runtimeIgnoredRoot(cliEntryRuntimePath())]
        : []),
      ...(entries.some((entry) => entry.aliases?.[installEntryRuntimeSpecifier] !== undefined)
        ? [runtimeIgnoredRoot(installEntryRuntimePath())]
        : []),
    ]);
    const evidence = await buildPackageEntries({
      cwd: projectRoot,
      entries,
      ...(ignoredRuntimeRoots.length === 0 ? {} : { ignoredSourcePaths: ignoredRuntimeRoots }),
      logLevel: 'error',
      meta: projectMeta(options.model.metadata),
      outputRoot: stageRoot,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }, dtsTsconfig === undefined || packageBuild.lib === undefined
      ? undefined
      : { entryName: packageBuild.lib.name, tsconfigPath: dtsTsconfig.path });
    const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
    await Promise.all(entries
      .filter((entry) => entry.executable)
      .map((entry) => chmod(resolveArtifactDestination(stageRoot, entry.outputRelativePath), executableMode)));

    const lib = packageBuild.lib;
    const files = (await listArtifactFiles(stageRoot)).map((file): PackageOutputFile => {
      const bundled = evidenceByPath.get(file.path);
      const declared = lib?.dts === true && libSourceDir !== undefined && file.path.endsWith('.d.ts')
        ? declarationSource(libSourceDir, file.path) ?? lib.source
        : undefined;
      if (bundled === undefined && declared === undefined) {
        throw new Error(`Package build emitted unexpected output ${JSON.stringify(file.path)}.`);
      }
      return {
        bytes: file.bytes,
        kind: bundled === undefined ? 'generated' : 'bundle',
        ...((file.mode & 0o111) === 0 ? {} : { mode: file.mode }),
        path: file.path,
        sha256: file.sha256,
        sourceInputs: relativeSourceInputs(
          projectRoot,
          bundled ?? [lib!.provenance.sourcePath, declared!],
        ),
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

    await publishArtifact({ outputRoot, stageRoot });
    return Object.freeze({ files: Object.freeze(files), outputRoot });
  } finally {
    // publishArtifact removes the stage on success; a failed build leaves it.
    await rm(stageRoot, { force: true, recursive: true });
    await dtsTsconfig?.cleanup();
  }
};
