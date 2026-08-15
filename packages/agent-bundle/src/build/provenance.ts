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

const toPosixRelative = (root: string, path: string): string =>
  relative(resolve(root), assertInside(root, path)).replaceAll('\\', '/');

const sortedUnique = (paths: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(paths)].sort((left, right) => left.localeCompare(right)));

const sourceInputsFor = (projectRoot: string, sourceInputs: readonly string[]): readonly string[] =>
  sortedUnique(sourceInputs.map((source) => toPosixRelative(projectRoot, source)));

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
