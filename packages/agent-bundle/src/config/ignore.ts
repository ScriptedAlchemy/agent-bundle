import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { isErrno } from '../core/errors.ts';
import { toPosixRelative } from '../core/paths.ts';

const mandatoryDirectoryNames = new Set([
  '.agent-bundle',
  '.git',
  'dist',
  'node_modules',
]);

export { toPosixPath } from '../core/paths.ts';

const isMandatoryIgnored = (relativePath: string): boolean =>
  relativePath.split('/').some((part) => mandatoryDirectoryNames.has(part));

export const readProjectIgnoreRules = async (root: string): Promise<Ignore> => {
  const rules = ignore();

  try {
    rules.add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch (error: unknown) {
    if (!isErrno(error, 'ENOENT')) {
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
  const relativePath = toPosixRelative(root, source);

  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('../') &&
    (isMandatoryIgnored(relativePath) || rules.ignores(relativePath))
  );
};
