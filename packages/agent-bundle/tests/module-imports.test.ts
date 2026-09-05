import { expect, it } from '@rstest/core';

import { sha256Hex } from '../src/core/digest.ts';
import { readModuleImports } from '../src/build/module-imports.ts';

const source = [
  "import { a } from './a.mjs';",
  "export * from './b.mjs';",
  "const lazy = () => import('./c.mjs');",
  'const dynamic = (name) => import(name);',
  'const here = import.meta.url;',
  'export { lazy, dynamic, here };',
  '',
].join('\n');

it('reports every import with its kind and literal specifier', async () => {
  expect(await readModuleImports(source, { check: 'lexed' })).toEqual([
    { kind: 'static', specifier: './a.mjs' },
    { kind: 'static', specifier: './b.mjs' },
    { kind: 'dynamic', specifier: './c.mjs' },
    { kind: 'dynamic', specifier: undefined },
    { kind: 'meta', specifier: undefined },
  ]);
});

it('remembers imports by digest and check level so the same bytes are lexed once per process', async () => {
  const bytes = `${source}// remembered\n`;
  const sha256 = sha256Hex(bytes);
  const imports = await readModuleImports(bytes, { check: 'lexed', sha256 });
  expect(Object.isFrozen(imports)).toBe(true);
  // The same bytes at the same level come back as the remembered object, even from a different source string.
  expect(await readModuleImports('/* replaced */', { check: 'lexed', sha256 })).toBe(imports);
  // A full parse is a stronger claim than a lex; each level is remembered on its own.
  const parsed = await readModuleImports(bytes, { check: 'parsed', sha256 });
  expect(parsed).not.toBe(imports);
  expect(parsed).toEqual(imports);
  // Without a digest nothing is remembered.
  const unkeyed = `${source}// unkeyed\n`;
  const first = await readModuleImports(unkeyed, { check: 'lexed' });
  expect(await readModuleImports(unkeyed, { check: 'lexed' })).not.toBe(first);
});

it('rejects what each check level rejects and remembers nothing for invalid input', async () => {
  const unterminated = 'export const broken = `;\n';
  const badStatement = 'export const broken = ;\n';
  await expect(readModuleImports(unterminated, { check: 'lexed', sha256: sha256Hex(unterminated) })).rejects.toThrow();
  await expect(readModuleImports(unterminated, { check: 'lexed', sha256: sha256Hex(unterminated) })).rejects.toThrow();
  // The lexer accepts a bare statement error a bundler never emits; the full parse does not.
  expect(await readModuleImports(badStatement, { check: 'lexed' })).toEqual([]);
  await expect(readModuleImports(badStatement, { check: 'parsed', sha256: sha256Hex(badStatement) })).rejects.toThrow();
  await expect(readModuleImports(badStatement, { check: 'parsed', sha256: sha256Hex(badStatement) })).rejects.toThrow();
  // A hashbang line is legal ESM input for both levels.
  expect(await readModuleImports("#!/usr/bin/env node\nimport './cli.mjs';\n", { check: 'parsed' })).toEqual([
    { kind: 'static', specifier: './cli.mjs' },
  ]);
});
