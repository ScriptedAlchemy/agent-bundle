import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const distRoot = join(process.cwd(), 'packages/agent-bundle/dist');
const commonJsPathGlobal = /\b__(?:filename|dirname)\b/u;

/** Rslib-emitted chunks of both libs; the copied Workbench and web-host browser builds are Rsbuild's. */
const rslibChunks = async (): Promise<readonly string[]> => (await readdir(distRoot, { recursive: true }))
  .filter((name) => name.endsWith('.js') && !name.startsWith('workbench/') && !name.startsWith('web-host/'))
  .sort();

/**
 * The bundled TypeScript 5 parser (#381) reads the CommonJS `__filename` and
 * `__dirname` globals in its eager `getNodeSystem()`, and the package ships
 * ESM, which defines neither. Rslib's `lib.shims.esm` rewrites every reference
 * to a path derived from the chunk's own `import.meta.url`; a reference it
 * left behind would be a ReferenceError the first time that chunk loads.
 * tests/packed-consumer-typescript.test.ts runs the parser from the installed
 * tarball; this holds the emitted bytes of every chunk, not just the one
 * that exercise reaches.
 */
it('leaves no CommonJS __filename/__dirname reference in any emitted chunk', async () => {
  const chunks = await rslibChunks();
  expect(chunks.length).toBeGreaterThan(0);
  const sources = new Map(await Promise.all(
    chunks.map(async (name) => [name, await readFile(join(distRoot, name), 'utf8')] as const),
  ));
  expect([...sources].filter(([, source]) => commonJsPathGlobal.test(source)).map(([name]) => name)).toEqual([]);

  const parserChunks = [...sources].filter(([, source]) => source.includes('getNodeSystem'));
  expect(parserChunks.map(([name]) => name)).toHaveLength(1);
  for (const [name, source] of parserChunks) expect(source, name).toMatch(/fileURLToPath\(import\.meta\.url\)/u);
});
