import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import * as renderer from '../src/index.js';

/**
 * The published types are the hand-written `src/index.d.ts` (copied into
 * `dist/` by rslib.config.ts, `dts: false`), so no compiler derives them from
 * the renderer. `tests/types.ts` proves the declared signatures compile
 * against real calls; this proves the declared value exports are exactly the
 * ones `src/index.js` — the entry `dist/index.js` bundles — implements, so a
 * renamed or added function cannot ship with a stale declaration.
 */
const declaredValueExports = (declaration: string): readonly string[] => [
  ...declaration.matchAll(/^export (?:declare )?(?:async )?(?:function|const|let|var|class) (?<name>[A-Za-z_$][\w$]*)/gmu),
].map((match) => match.groups!['name']!);

it('declares exactly the value exports the renderer implements', async () => {
  const declaration = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');

  expect([...declaredValueExports(declaration)].sort()).toEqual(Object.keys(renderer).sort());
  expect(Object.keys(renderer).sort()).toEqual(['renderToMarkdown', 'renderToMarkdownStream']);
});
