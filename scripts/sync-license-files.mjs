import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Copies the repository's LICENSE and NOTICE into every publishable package so
 * `npm pack` ships them at the tarball root. The copies are build outputs
 * (gitignored); the repository root files are the single source of truth.
 */
export const licenseFiles = Object.freeze(['LICENSE', 'NOTICE']);

export const publishablePackageDirectories = Object.freeze([
  'packages/agent-bundle',
  'packages/rsc-runtime',
  'packages/rsc-markdown-stream',
  'packages/create-agent-bundle',
]);

export const repositoryRoot = resolve(import.meta.dirname, '..');

export const syncLicenseFiles = async (root = repositoryRoot) => {
  await Promise.all(publishablePackageDirectories.flatMap((directory) => (
    licenseFiles.map((file) => copyFile(join(root, file), join(root, directory, file)))
  )));
};

if (import.meta.main) await syncLicenseFiles();
