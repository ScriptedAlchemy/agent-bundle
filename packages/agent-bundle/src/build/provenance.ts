import { relative, resolve } from 'node:path';

import { assertInside } from '../core/paths.ts';

export type ArtifactOutputKind = 'bundle' | 'copy' | 'generated';

export interface ArtifactOutputProvenance {
  readonly kind: ArtifactOutputKind;
  /** POSIX path relative to the published artifact root, including its target. */
  readonly path: string;
  /** Sorted, unique POSIX paths relative to the project root. */
  readonly sourceInputs: readonly string[];
}

export interface ArtifactOutputCandidate {
  readonly kind: ArtifactOutputKind;
  /** Absolute path within the staging artifact root. */
  readonly path: string;
  /** Absolute authored paths within the project root. */
  readonly sourceInputs: readonly string[];
}

export interface BundledOutputCandidate {
  /** Asset path reported by the bundler, relative to its output root. */
  readonly path: string;
  /** Absolute authored inputs known by the compiler before bundling. */
  readonly sourceInputs: readonly string[];
}

export interface BundledOutputEvidence {
  readonly path: string;
  /** Absolute authored inputs. Build-boundary canonicalization happens separately. */
  readonly sourceInputs: readonly string[];
}

interface PublicStats {
  toJson(options?: unknown): unknown;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const toPosixRelative = (root: string, path: string): string =>
  relative(resolve(root), assertInside(root, path)).replaceAll('\\', '/');

const sortedUnique = (paths: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(paths)].sort((left, right) => left.localeCompare(right)));

const sourceInputsFor = (projectRoot: string, sourceInputs: readonly string[]): readonly string[] =>
  sortedUnique(sourceInputs.map((source) => toPosixRelative(projectRoot, source)));

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

const recordsAt = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value)
    ? value.map(asRecord).filter((candidate): candidate is JsonRecord => candidate !== undefined)
    : [];

const numberAt = (record: JsonRecord, key: string): number | undefined =>
  typeof record[key] === 'number' ? record[key] as number : undefined;

const stringAt = (record: JsonRecord, key: string): string | undefined =>
  typeof record[key] === 'string' ? record[key] as string : undefined;

const chunksAt = (record: JsonRecord): readonly (string | number)[] =>
  Array.isArray(record.chunks)
    ? record.chunks.filter((chunk): chunk is string | number => typeof chunk === 'string' || typeof chunk === 'number')
    : [];

const hasSharedChunk = (left: readonly (string | number)[], right: readonly (string | number)[]): boolean =>
  left.some((chunk) => right.includes(chunk));

const throwOnFilteredStats = (record: JsonRecord): void => {
  for (const key of ['filteredAssets', 'filteredChildren', 'filteredModules']) {
    if ((numberAt(record, key) ?? 0) > 0) {
      throw new Error(`Bundler stats are filtered (${key}) and cannot prove output provenance.`);
    }
  }
  for (const child of recordsAt(record.children)) throwOnFilteredStats(child);
};

const flattenModules = (modules: readonly JsonRecord[]): readonly JsonRecord[] => modules.flatMap((module) => [
  module,
  ...flattenModules(recordsAt(module.modules)),
]);

const flattenCompilations = (compilation: JsonRecord): readonly JsonRecord[] => [
  compilation,
  ...recordsAt(compilation.children).flatMap(flattenCompilations),
];

const isIgnoredModule = (path: string, ignoredSourcePaths: readonly string[]): boolean =>
  path.replaceAll('\\', '/').split('/').includes('node_modules') ||
  ignoredSourcePaths.some((ignored) => {
    const resolvedIgnored = resolve(ignored);
    const resolvedPath = resolve(path);
    return resolvedPath === resolvedIgnored || resolvedPath.startsWith(`${resolvedIgnored}/`);
  });

const assertProjectInput = (projectRoot: string, source: string): string =>
  assertInside(projectRoot, source);

const sourcesForAsset = (options: {
  readonly asset: JsonRecord;
  readonly compilation: JsonRecord;
  readonly explicitInputs: readonly string[];
  readonly ignoredSourcePaths: readonly string[];
  readonly projectRoot: string;
}): readonly string[] => {
  const assetChunks = chunksAt(options.asset);
  const modules = flattenModules(recordsAt(options.compilation.modules));
  const canUseAllModules = recordsAt(options.compilation.assets).length === 1;
  if (!canUseAllModules && assetChunks.length === 0) {
    throw new Error('Bundler stats cannot associate an output asset with its source modules.');
  }
  const sources = [
    ...options.explicitInputs.map((source) => assertProjectInput(options.projectRoot, source)),
    ...modules.flatMap((module) => {
      if (!canUseAllModules && !hasSharedChunk(assetChunks, chunksAt(module))) return [];
      const source = stringAt(module, 'nameForCondition');
      if (source === undefined || isIgnoredModule(source, options.ignoredSourcePaths)) return [];
      return [assertProjectInput(options.projectRoot, source)];
    }),
  ];
  return sortedUnique(sources);
};

/**
 * Extracts authored source evidence from the documented Rspack Stats.toJson surface.
 * The returned paths remain absolute until artifact publication can canonicalize them.
 */
export const collectBundledOutputEvidence = (options: {
  readonly expectedAssets: readonly BundledOutputCandidate[];
  readonly ignoredSourcePaths?: readonly string[];
  readonly projectRoot: string;
  readonly stats: PublicStats | undefined;
}): readonly BundledOutputEvidence[] => {
  if (options.stats === undefined) {
    throw new Error('Bundler build result did not include public stats for output provenance.');
  }
  const json = asRecord(options.stats.toJson({ assets: true, children: true, modules: true, nestedModules: true }));
  if (json === undefined) throw new Error('Bundler stats were not an object.');
  throwOnFilteredStats(json);
  const compilations = flattenCompilations(json);
  const ignoredSourcePaths = options.ignoredSourcePaths ?? [];

  return Object.freeze(options.expectedAssets.map((expected) => {
    const matches = compilations.flatMap((compilation) => recordsAt(compilation.assets)
      .filter((asset) => stringAt(asset, 'name') === expected.path)
      .map((asset) => ({ asset, compilation })));
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Bundler stats did not report expected output asset ${JSON.stringify(expected.path)}.`
          : `Bundler stats reported ambiguous output asset ${JSON.stringify(expected.path)}.`,
      );
    }
    const match = matches[0]!;
    return Object.freeze({
      path: expected.path,
      sourceInputs: sourcesForAsset({
        asset: match.asset,
        compilation: match.compilation,
        explicitInputs: expected.sourceInputs,
        ignoredSourcePaths,
        projectRoot: options.projectRoot,
      }),
    });
  }).sort((left, right) => left.path.localeCompare(right.path)));
};

export const createOutputProvenance = (options: {
  readonly artifactRoot: string;
  readonly outputs: readonly ArtifactOutputCandidate[];
  readonly projectRoot: string;
}): readonly ArtifactOutputProvenance[] => Object.freeze(options.outputs
  .map((output) => Object.freeze({
    kind: output.kind,
    path: toPosixRelative(options.artifactRoot, output.path),
    sourceInputs: sourceInputsFor(options.projectRoot, output.sourceInputs),
  }))
  .sort((left, right) => left.path.localeCompare(right.path)));
