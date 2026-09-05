import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  checkPackedDeclarations,
  declarationImportViolations,
  declarationSpecifiers,
  formatDeclarationImportReport,
  packageNameOf,
  runCheckDeclarationImports,
  type DeclarationManifest,
} from '../../../scripts/check-declaration-imports.mjs';

const manifest: DeclarationManifest = {
  name: 'fixture-package',
  dependencies: { effect: '4.0.0', '@modelcontextprotocol/client': '2.0.0' },
  devDependencies: { zod: '4.5.4', 'typescript-5': 'npm:typescript@5.9.3', '@types/node': '26.4.0' },
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './routes': { types: './dist/routes/public.d.ts', import: './dist/routes.js' },
    './package.json': './package.json',
  },
  peerDependencies: { react: '19.2.8' },
};

describe('declarationSpecifiers', () => {
  it('collects every form of module reference a declaration can carry', () => {
    const text = [
      '/// <reference types="node" />',
      '/// <reference path="./globals.d.ts" />',
      "import { z } from 'zod';",
      'import type { Effect } from "effect";',
      "import * as ns from './ns.ts';",
      "import ts = require('typescript-5');",
      "import './side-effect.js';",
      "export * from './re-export.js';",
      "export type { Foo } from '../foo.js';",
      'export declare const lazy: () => Promise<typeof import("@modelcontextprotocol/client")>;',
      "export declare const inline: import('react').ReactNode;",
    ].join('\n');

    expect(declarationSpecifiers(text).map(({ kind, specifier }) => `${kind} ${specifier}`)).toEqual([
      'import zod',
      'import effect',
      'import ./ns.ts',
      'import typescript-5',
      'import ./side-effect.js',
      'import ./re-export.js',
      'import ../foo.js',
      'import @modelcontextprotocol/client',
      'import react',
      'types-reference node',
      'path-reference ./globals.d.ts',
    ]);
  });

  it('ignores prose in comments, string literal types, templates, and declare module', () => {
    const text = [
      '/**',
      " * Mirrors the runtime: `import { x } from 'driver'` is what the consumer writes,",
      " * and `require('not reported')` never runs here.",
      ' */',
      "// import { hidden } from 'line-comment';",
      "export type Kind = 'from' | 'import';",
      "export interface Shape { readonly from: 'literal'; readonly import: 'also literal'; import(spec: 'x'): void }",
      'export type Tpl = `from ${string}`;',
      "declare module 'ambient-module' { export const value: number; }",
      "export { real } from './real.js'; // trailing: import('comment')",
    ].join('\n');

    expect(declarationSpecifiers(text)).toEqual([{ kind: 'import', line: 10, specifier: './real.js' }]);
  });

  it('derives the package name from scoped and deep specifiers', () => {
    expect(packageNameOf('effect')).toBe('effect');
    expect(packageNameOf('effect/Schema')).toBe('effect');
    expect(packageNameOf('@agent-bundle/runtime/state/sqlite')).toBe('@agent-bundle/runtime');
  });
});

describe('declarationImportViolations', () => {
  const packedPaths = [
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/routes.js',
    'dist/routes/public.d.ts',
    'dist/routes/input-schema.d.ts',
    'dist/events/ipc.d.ts',
    'dist/core/types.d.ts',
    'dist/core/capabilities.json',
    'dist/globals.d.ts',
  ];

  it('accepts declarations that only reach packed files, built-ins, and declared packages', () => {
    const report = declarationImportViolations({
      manifest,
      packedPaths,
      declarations: [
        {
          path: 'dist/index.d.ts',
          text: [
            '/// <reference path="./globals.d.ts" />',
            "import type { Effect } from 'effect';",
            "import type { Client } from '@modelcontextprotocol/client/index.js';",
            "import { readFile } from 'node:fs/promises';",
            "import { EventEmitter } from 'events';",
            "import type { Own } from 'fixture-package/routes';",
            "import type { Shared } from './core/types.ts';",
            "import capabilities from './core/capabilities.json';",
            "export * from './routes/public.js';",
          ].join('\n'),
        },
        { path: 'dist/routes/public.d.ts', text: "import type { ReactNode } from 'react';\nexport type Route = ReactNode;" },
        { path: 'dist/core/types.d.ts', text: 'export type Shared = string;' },
        { path: 'dist/globals.d.ts', text: 'declare const __VERSION__: string;' },
      ],
    });

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.declarationCount).toBe(4);
    expect([...report.reachable].sort()).toEqual([
      'dist/core/types.d.ts',
      'dist/globals.d.ts',
      'dist/index.d.ts',
      'dist/routes/public.d.ts',
    ]);
    expect(report.roots).toEqual([
      { entry: '.', path: 'dist/index.d.ts' },
      { entry: './routes', path: 'dist/routes/public.d.ts' },
    ]);
  });

  it('fails a devDependency import the moment an export reaches it, and only warns while it is internal', () => {
    const report = declarationImportViolations({
      manifest,
      packedPaths,
      declarations: [
        { path: 'dist/index.d.ts', text: "export type { Input } from './routes/input-schema.ts';" },
        { path: 'dist/routes/public.d.ts', text: 'export type Route = string;' },
        // Reached through dist/index.d.ts, so a consumer's TypeScript loads it.
        { path: 'dist/routes/input-schema.d.ts', text: "import ts from 'typescript-5';\nexport type Input = ts.Node;" },
        // No export reaches it: latent until the next re-export.
        { path: 'dist/events/ipc.d.ts', text: "import { z } from 'zod';\nexport declare const schema: z.ZodType;" },
      ],
    });

    expect(report.errors).toEqual([{
      line: 1,
      message: 'imports "typescript-5" — "typescript-5" is a devDependency, so consumers do not install it',
      path: 'dist/routes/input-schema.d.ts',
      reachableFrom: '.',
      reason: 'dev-dependency',
      specifier: 'typescript-5',
    }]);
    expect(report.warnings).toEqual([{
      line: 1,
      message: 'imports "zod" — "zod" is a devDependency, so consumers do not install it',
      path: 'dist/events/ipc.d.ts',
      reachableFrom: undefined,
      reason: 'dev-dependency',
      specifier: 'zod',
    }]);
  });

  it('reports undeclared packages, unpacked relative targets, type references, and missing export targets', () => {
    const report = declarationImportViolations({
      manifest: { ...manifest, exports: { ...(manifest.exports as object), './gone': { types: './dist/gone.d.ts' } } },
      packedPaths,
      declarations: [
        {
          path: 'dist/index.d.ts',
          text: [
            '/// <reference types="node" />',
            // An absolute reference resolves from the filesystem root, not the
            // package, even when a same-named file happens to be packed.
            '/// <reference path="/globals.d.ts" />',
            "import type { Ajv } from 'ajv';",
            "import type { Missing } from './missing.js';",
            "import type { Internal } from '#internal/thing';",
            "import type { Remote } from 'https://example.invalid/types.d.ts';",
            "import type { Own } from 'fixture-package/internal';",
          ].join('\n'),
        },
        { path: 'dist/routes/public.d.ts', text: 'export type Route = string;' },
      ],
    });

    expect(report.errors.map(({ reason, specifier }) => `${reason} ${specifier}`)).toEqual([
      'export-target-missing dist/gone.d.ts',
      'dev-dependency node',
      'unresolvable /globals.d.ts',
      'undeclared ajv',
      'missing-target ./missing.js',
      'subpath-import #internal/thing',
      'unresolvable https://example.invalid/types.d.ts',
      'unexported fixture-package/internal',
    ]);
    expect(report.errors[1]?.message).toBe(
      'references types "node" — "@types/node" is a devDependency, so consumers do not install it',
    );
    expect(report.errors[2]?.message).toBe(
      'references "/globals.d.ts" — an absolute path or URL cannot resolve in a consumer install',
    );
    expect(report.errors[4]?.message).toBe(
      'no packed declaration for "./missing.js" (tried dist/missing.d.ts)',
    );
    expect(report.errors[7]?.message).toBe(
      'imports "fixture-package/internal" — the package\'s own "exports" has no entry for "./internal"',
    );
  });

  it('resolves self-imports through the package\'s own exports map', () => {
    // Severity is covered above; these fixtures export `.js` targets only, so
    // the declaration is unreachable and every violation is a warning.
    const check = (exports: unknown, specifiers: readonly string[]): readonly string[] => {
      const report = declarationImportViolations({
        manifest: { name: 'self', exports },
        packedPaths: ['dist/index.d.ts'],
        declarations: [{ path: 'dist/index.d.ts', text: specifiers.map((specifier) => `import '${specifier}';`).join('\n') }],
      });
      return [...report.errors, ...report.warnings].map(({ specifier }) => specifier);
    };

    // Subpath map: exact keys and `*` patterns resolve, anything else does not.
    const subpaths = { '.': './dist/index.js', './routes': './dist/routes.js', './features/*': './dist/features/*.js' };
    expect(check(subpaths, ['self', 'self/routes', 'self/features/a', 'self/features/nested/b'])).toEqual([]);
    expect(check(subpaths, ['self/internal', 'self/features'])).toEqual(['self/internal', 'self/features']);
    // A string or conditions-only `exports` serves the root alone.
    expect(check('./dist/index.js', ['self', 'self/routes'])).toEqual(['self/routes']);
    expect(check({ types: './dist/index.d.ts', import: './dist/index.js' }, ['self', 'self/routes'])).toEqual(['self/routes']);
    // No `exports` at all: every file resolves by path.
    expect(check(undefined, ['self', 'self/dist/anything.js'])).toEqual([]);
  });

  it('resolves the source extensions tsgo keeps and extensionless directory imports', () => {
    const report = declarationImportViolations({
      manifest: { name: 'fixture-package', exports: { '.': { types: './dist/index.d.ts' } } },
      packedPaths: ['dist/index.d.ts', 'dist/a.d.ts', 'dist/b.d.mts', 'dist/c.d.cts', 'dist/dir/index.d.ts'],
      declarations: [
        {
          path: 'dist/index.d.ts',
          text: [
            "export * from './a.ts';",
            "export * from './a.tsx';",
            "export * from './b.mjs';",
            "export * from './b.mts';",
            "export * from './c.cjs';",
            "export * from './dir';",
            "export * from './a';",
          ].join('\n'),
        },
        { path: 'dist/a.d.ts', text: 'export {};' },
        { path: 'dist/b.d.mts', text: 'export {};' },
        { path: 'dist/c.d.cts', text: 'export {};' },
        { path: 'dist/dir/index.d.ts', text: 'export {};' },
      ],
    });

    expect(report.errors).toEqual([]);
    expect(report.reachable.size).toBe(5);
  });
});

describe('the packed-declaration gate', () => {
  const writeFixturePack = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-declaration-gate-'));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return root;
  };

  const badManifest = {
    name: 'bad-fixture',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './package.json': './package.json' },
    dependencies: { effect: '4.0.0' },
    devDependencies: { zod: '4.5.4' },
  };
  const badFiles = {
    'package.json': `${JSON.stringify(badManifest, null, 2)}\n`,
    'dist/index.js': 'export const schema = 1;\n',
    'dist/index.d.ts': "import type { z } from 'zod';\nexport declare const schema: z.ZodType;\n",
  };
  const packed = ['package.json', 'dist/index.js', 'dist/index.d.ts'];

  it('fails a fixture pack whose exported declaration imports a devDependency', async () => {
    const root = await writeFixturePack(badFiles);
    try {
      const report = await checkPackedDeclarations({ manifest: badManifest, packageDirectory: root, packedPaths: packed });
      expect(report.errors.map(({ path, reason, specifier }) => [path, reason, specifier])).toEqual([
        ['dist/index.d.ts', 'dev-dependency', 'zod'],
      ]);

      const lines: string[] = [];
      const exitCode = await runCheckDeclarationImports({
        argv: [root],
        inventory: async () => packed,
        log: (line) => lines.push(line),
      });
      expect(exitCode).toBe(1);
      expect(lines).toEqual([
        'bad-fixture: 1 packed declarations, 1 reachable from 1 export entries; 1 errors, 0 warnings',
        '  error   dist/index.d.ts:1 imports "zod" — "zod" is a devDependency, so consumers do not install it '
          + '(reachable from exports["."])',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('passes the same pack once the import is declared, and lets --strict fail internal declarations', async () => {
    const goodManifest = { ...badManifest, name: 'good-fixture', dependencies: { effect: '4.0.0', zod: '4.5.4' }, devDependencies: {} };
    const root = await writeFixturePack({
      ...badFiles,
      'package.json': `${JSON.stringify(goodManifest, null, 2)}\n`,
      'dist/internal.d.ts': "import type ts from 'typescript-5';\nexport type Node = ts.Node;\n",
    });
    const paths = [...packed, 'dist/internal.d.ts'];
    try {
      const lines: string[] = [];
      const log = (line: string): void => {
        lines.push(line);
      };
      expect(await runCheckDeclarationImports({ argv: [root], inventory: async () => paths, log })).toBe(0);
      expect(lines).toEqual([
        'good-fixture: 2 packed declarations, 1 reachable from 1 export entries; 0 errors, 1 warnings',
        '  warning dist/internal.d.ts:1 imports "typescript-5" — "typescript-5" is not declared in dependencies, '
          + 'peerDependencies, or optionalDependencies (internal declaration; no export reaches it)',
      ]);

      lines.length = 0;
      expect(await runCheckDeclarationImports({ argv: ['--strict', root], inventory: async () => paths, log })).toBe(1);
      expect(lines[0]).toBe('good-fixture: 2 packed declarations, 1 reachable from 1 export entries; 1 errors, 0 warnings');
      expect(lines[1]).toContain('  error   dist/internal.d.ts:1 imports "typescript-5"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('formats a clean report on one line', () => {
    const report = declarationImportViolations({
      manifest: { name: 'clean', exports: { '.': { types: './dist/index.d.ts' } } },
      packedPaths: ['dist/index.d.ts'],
      declarations: [{ path: 'dist/index.d.ts', text: 'export {};' }],
    });
    expect(formatDeclarationImportReport('clean', report)).toEqual([
      'clean: 1 packed declarations, 1 reachable from 1 export entries; 0 errors, 0 warnings',
    ]);
  });

  it('rejects an unknown flag and an empty package list', async () => {
    await expect(runCheckDeclarationImports({ argv: ['--bogus', 'x'] })).rejects.toThrow('Unknown argument: --bogus');
    await expect(runCheckDeclarationImports({ argv: [] })).rejects.toThrow(/Usage: node scripts\/check-declaration-imports\.mjs/u);
  });
});
