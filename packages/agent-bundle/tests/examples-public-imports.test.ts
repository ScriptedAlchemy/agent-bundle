import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, it } from '@rstest/core';

const examplesRoot = join(process.cwd(), 'examples');

/** A module specifier that reaches into a workspace package's source instead of its public exports. */
const packageSourceSpecifier = /(?:from\s*|import\s*\(\s*|import\s+)['"][^'"]*packages\/(?:agent-bundle|rsc-runtime)\/src\/[^'"]*['"]/u;

const sourceFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...await sourceFiles(path));
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|jsx)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
};

/**
 * `examples/*` are user-facing products (AGENTS.md): their `src/**` may use
 * only the public `agent-bundle` exports and `workspace:*` dependencies. A
 * relative path into `packages/<pkg>/src` compiles here and nowhere else, so
 * this sweep fails the moment an example needs a name the package does not
 * export — the fix is to export it (#485), never to allow-list the example.
 * Example tests are exempt: test-only wiring against internal services is
 * legitimate there and is reviewed case by case.
 */
it('every example imports the framework through its public exports only', async () => {
  const examples = (await readdir(examplesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(examples.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const example of examples) {
    const source = join(examplesRoot, example, 'src');
    let files: readonly string[];
    try {
      files = await sourceFiles(source);
    } catch {
      continue;
    }
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (packageSourceSpecifier.test(line)) {
          offenders.push(`${relative(examplesRoot, file)}:${String(index + 1)}: ${line.trim()}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

it('authors every example MCP tool with defineTool', async () => {
  const examples = (await readdir(examplesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const toolFiles = (await Promise.all(examples.map(async (example) => {
    const source = join(examplesRoot, example, 'src');
    try {
      return await sourceFiles(source);
    } catch {
      return [];
    }
  }))).flat()
    .filter((file) => /^[^/]+\/src\/mcp\/[^/]+\/tools\/(?!.*\.cli\.)[^/]+\.(?:ts|tsx)$/u.test(relative(examplesRoot, file)))
    .sort();
  expect(toolFiles).toHaveLength(21);

  for (const file of toolFiles) {
    const text = await readFile(file, 'utf8');
    expect(text, relative(examplesRoot, file)).toContain('export default defineTool({');
    expect(text, relative(examplesRoot, file)).not.toContain('export const config');
  }
});

it('keeps host-test event capture cheap until session context renders', async () => {
  const eventsRoot = join(examplesRoot, 'host-test', 'src', 'events');
  const eventFiles = (await sourceFiles(eventsRoot)).map((file) => relative(eventsRoot, file)).sort();
  const views = eventFiles.filter((file) => file.endsWith('.view.tsx'));
  const handlers = eventFiles.filter((file) => !file.endsWith('.view.tsx'));

  expect(views).toEqual(['session/start.view.tsx']);
  expect(handlers).toHaveLength(20);
  expect(handlers.every((file) => file.endsWith('.ts'))).toBe(true);
  for (const file of handlers) {
    await expect(readFile(join(eventsRoot, file), 'utf8')).resolves.toContain('export default events.');
  }
});
