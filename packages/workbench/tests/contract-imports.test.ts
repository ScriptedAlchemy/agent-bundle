import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@rstest/core';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

// Vendored inspector code and its patches are third-party surface the
// contract boundary does not govern.
const excludedDirectories: ReadonlySet<string> = new Set([
  join('inspector', 'vendor'),
  join('inspector', 'patches'),
]);

const sourceFilePattern = /\.(?:ts|tsx)$/u;
const moduleSpecifierPattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/gu;
const contractPath = 'agent-bundle/src/contracts/';

const listSourceFiles = async (directory: string): Promise<readonly string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirectories.has(relative(srcRoot, entryPath))) continue;
      files.push(...(await listSourceFiles(entryPath)));
      continue;
    }
    if (sourceFilePattern.test(entry.name)) files.push(entryPath);
  }
  return files;
};

it('workbench src imports agent-bundle only through its contracts/ surface', async () => {
  const files = await listSourceFiles(srcRoot);
  // Guard the walker itself: an empty scan would vacuously pass.
  expect(files.length).toBeGreaterThan(30);

  const violations: string[] = [];
  for (const file of files) {
    const contents = await readFile(file, 'utf8');
    for (const match of contents.matchAll(moduleSpecifierPattern)) {
      const specifier = match[1]!;
      if (!specifier.includes('agent-bundle/src/')) continue;
      if (specifier.includes(contractPath)) continue;
      violations.push(`${relative(srcRoot, file)}: ${specifier}`);
    }
  }

  expect(violations).toEqual([]);
});
