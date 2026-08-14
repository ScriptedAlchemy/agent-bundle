import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import ignore, { type Ignore } from 'ignore';

const mandatoryDirectoryNames = new Set([
  '.agent-bundle',
  '.git',
  'dist',
  'node_modules',
]);

export const toPosixPath = (path: string): string => path.split(sep).join('/');

const isMandatoryIgnored = (relativePath: string): boolean =>
  relativePath.split('/').some((part) => mandatoryDirectoryNames.has(part));

export const readProjectIgnoreRules = async (root: string): Promise<Ignore> => {
  const rules = ignore();

  try {
    rules.add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  return rules;
};

export const isProjectPathIgnored = (
  rules: Ignore,
  root: string,
  source: string,
): boolean => {
  const relativePath = toPosixPath(relative(root, source));

  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('../') &&
    (isMandatoryIgnored(relativePath) || rules.ignores(relativePath))
  );
};
