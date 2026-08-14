import { isAbsolute, relative, resolve, sep } from 'node:path';

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
