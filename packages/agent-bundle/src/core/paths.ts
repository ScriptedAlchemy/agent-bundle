import { isAbsolute, relative, resolve, sep } from 'node:path';

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
