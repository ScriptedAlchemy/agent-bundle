import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { isErrno } from './errors.ts';

const escapesRoot = (path: string): boolean =>
  path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path);

/**
 * Converts a host-native path to POSIX separators. Callers must pass paths
 * produced by host `join`/`relative`; literal backslashes inside POSIX
 * segment names are preserved.
 */
export const toPosixPath = (path: string): string => path.split(sep).join('/');

/** POSIX-form path of `path` relative to `root`; asserts nothing about containment. */
export const toPosixRelative = (root: string, path: string): string => toPosixPath(relative(root, path));

/** `path` in POSIX form relative to `root` when it lies inside or at `root`; otherwise `path` unchanged. */
export const posixRelativeWhenInside = (root: string, path: string): string =>
  (isInsideOrEqual(root, path) ? toPosixRelative(root, path) : path);

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

/** Root entries owned by generated runtime code; the compiler never emits under them and installers never remove or rewrite them. */
export const preservedRuntimeEntries: readonly string[] = Object.freeze(['state']);

/**
 * Whether a root entry name is a preserved runtime root. Matched
 * case-insensitively: on case-insensitive filesystems `State/` *is* `state/`,
 * so no spelling of a runtime root may be emitted, inventoried, staged, or
 * claimed by a receipt.
 */
export const isPreservedRuntimeRoot = (name: string): boolean =>
  preservedRuntimeEntries.includes(name.toLowerCase());

/** The installer's receipt beside an installed root; reserved as a top-level entry in every spelling, file or directory. */
export const installReceiptFile = '.agent-bundle-install.json';

export const isInstallReceiptEntry = (name: string): boolean => name.toLowerCase() === installReceiptFile.toLowerCase();

/** A non-empty relative path (POSIX or Windows form) whose segments never traverse upward. */
export const isContainedRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !isAbsolute(value) &&
  !/^[a-z]:/iu.test(value) &&
  !value.split(/[/\\]/u).includes('..');

const windowsDeviceName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;

/**
 * One path segment every supported filesystem can hold and hand back unchanged:
 * non-empty, never `.` or `..`, no control character or Windows-reserved
 * character, not a Windows device name, and no trailing dot or space (which
 * Windows strips). The manifest's `files[]` rows and the installer's receipt
 * share this rule, so a manifest the parser accepts is one the installer can
 * inventory, copy, and own.
 */
export const isPortablePathSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment !== '.' &&
  segment !== '..' &&
  !/[<>:"|?*]/u.test(segment) &&
  [...segment].every((character) => character.charCodeAt(0) >= 0x20) &&
  !windowsDeviceName.test(segment) &&
  !segment.endsWith('.') &&
  !segment.endsWith(' ');

/**
 * The manifest's path rule: a non-empty POSIX path that is relative on every platform
 * (no leading `/`, no drive letter, no backslash) whose every segment is portable,
 * so the path means the same file wherever the root lands.
 */
export const isRelocatablePosixPath = (path: string): boolean =>
  path.length > 0 &&
  !path.includes('\\') &&
  !path.startsWith('/') &&
  !/^[a-z]:/iu.test(path) &&
  path.split('/').every(isPortablePathSegment);

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

/** True when a filesystem entry (including a symlink itself) exists at path. */
export const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

/** Absolute paths pass through; relative paths must resolve inside root. */
export const resolveContained = (root: string, path: string): string =>
  isAbsolute(path) ? path : assertInside(root, resolve(root, path));
