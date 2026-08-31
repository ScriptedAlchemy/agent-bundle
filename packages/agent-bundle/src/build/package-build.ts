import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { AgentBundleToolsConfig, NormalizedPlugin } from '../core/types.ts';
import { assertInside } from '../core/paths.ts';
import { listArtifactFiles, publishArtifact, resolveArtifactDestination } from './emit.ts';
import { scanEntryExports } from './entry-exports.ts';
import { generatedExecutableEntrySource } from './entry-shell.ts';
import { buildWithRslib, type RslibEntry } from './rslib.ts';

/**
 * The framework-owned npm package build: `bin` entries become self-executing
 * `dist/bin/<name>.js` bundles (shebang + executable bit) and the `lib` entry
 * becomes `dist/<name>.js` (+ bundled `.d.ts`), all through the same Rslib
 * synthesis, invariant assertions, and staged atomic publication as artifact
 * executables. This is the build audiobook-curator previously needed a second
 * bundler config, a tsconfig, and a hand-written bin shim to produce.
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

interface PlannedPackageEntry extends RslibEntry {
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
    include: [`${options.sourceDir}/**/*.ts`, `${options.sourceDir}/**/*.tsx`],
  }, null, 2)}\n`, 'utf8');
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    path,
  };
};

const planPackageEntries = async (
  model: NormalizedPlugin,
  dtsTsconfigPath: string | undefined,
): Promise<readonly PlannedPackageEntry[]> => {
  const packageBuild = model.packageBuild;
  if (packageBuild === undefined) return Object.freeze([]);
  const entries: PlannedPackageEntry[] = [];
  for (const bin of packageBuild.bins) {
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
  const entries = await planPackageEntries(options.model, dtsTsconfig?.path);
  if (entries.length === 0) {
    await dtsTsconfig?.cleanup();
    return undefined;
  }

  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));
  try {
    const evidence = await buildWithRslib({
      cwd: projectRoot,
      entries,
      logLevel: 'error',
      outputRoot: stageRoot,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    });
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
