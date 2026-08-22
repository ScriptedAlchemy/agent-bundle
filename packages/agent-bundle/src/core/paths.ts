import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';

const escapesRoot = (path: string): boolean =>
  path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path);

/** True when candidate resolves strictly inside root. */
export const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length > 0 && !escapesRoot(path);
};

/** True when candidate resolves inside root or to root itself. */
export const isInsideOrEqual = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length === 0 || !escapesRoot(path);
};

export const assertInside = (root: string, candidate: string): string => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativeCandidate = relative(resolvedRoot, resolvedCandidate);
  const escapesRoot =
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate);

  if (escapesRoot) {
    throw new Error(
      `Path ${JSON.stringify(resolvedCandidate)} is outside output root ${JSON.stringify(resolvedRoot)}.`,
    );
  }

  return resolvedCandidate;
};

/** One case-insensitive alphanumeric-leading path segment; structurally unable to be `.` or `..`. */
export const isSafePathSegment = (value: string): boolean => /^[a-z0-9][a-z0-9._-]*$/iu.test(value);

/** A non-empty relative path (POSIX or Windows form) whose segments never traverse upward. */
export const isContainedRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !isAbsolute(value) &&
  !/^[a-z]:/iu.test(value) &&
  !value.split(/[/\\]/u).includes('..');

/** A normalized relative path that cannot traverse out of an artifact root. */
export const safeArtifactPath = (path: string): boolean =>
  path.length > 0 &&
  !isAbsolute(path) &&
  path === posix.normalize(path) &&
  path !== '..' &&
  !path.startsWith('../');

export const joinArtifact = (root: string, relativePath: string): string => {
  if (!safeArtifactPath(relativePath)) {
    throw new Error(`Unsafe artifact path ${JSON.stringify(relativePath)}.`);
  }
  return assertInside(root, resolve(root, relativePath));
};

/** dev/ino identity check shared by the symlink/TOCTOU defenses. */
export const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
