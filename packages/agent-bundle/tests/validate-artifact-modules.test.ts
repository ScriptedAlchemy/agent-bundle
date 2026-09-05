import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { listArtifactFiles, type ArtifactFile } from '../src/build/emit.ts';
import { validateJavaScriptModules } from '../src/build/validate-artifact-modules.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface StagedTree {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
}

/** Writes `files` under a fresh root and lists them the way the artifact and package builds list a staged tree. */
const stage = async (files: Readonly<Record<string, string>>): Promise<StagedTree> => {
  const artifactRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-validate-modules-')));
  roots.push(artifactRoot);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(artifactRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return { artifactRoot, files: await listArtifactFiles(artifactRoot) };
};

const recovery = 'Bundle every JavaScript dependency into the artifact, then rebuild it.';

/** The one diagnostic the walk raises: AB6005 against `generatedPath`, with `detail` after the shared prefix. */
const finding = (generatedPath: string, detail: string): Diagnostic => ({
  code: 'AB6005',
  generatedPath,
  message: `Generated JavaScript import from ${JSON.stringify(generatedPath)} ${detail}`,
  recovery,
  severity: 'error',
});

const probe = 'scripts/probe.mjs';
const compiled: ReadonlySet<string> = new Set([probe]);
const noJson: ReadonlySet<string> = new Set();

/** Validates `source` staged as the compiled `scripts/probe.mjs`, alone or beside `siblings`. */
const validateProbe = async (
  source: string,
  siblings: Readonly<Record<string, string>> = {},
): Promise<readonly Diagnostic[]> => validateJavaScriptModules({
  ...await stage({ [probe]: source, ...siblings }),
  bundledPaths: compiled,
  validJson: noJson,
});

const factoryImport = 'import { createRequire } from "node:module";\n';
const boundLoader = (declaration: 'const' | 'let' | 'var'): string =>
  `${factoryImport}${declaration} load = createRequire(import.meta.url);\n`;

/** The loader shim Rspack emits into ESM output for a `node-commonjs` external or a bundled CommonJS `require()`. */
const rspackShim = (specifier: string): string => [
  'import { createRequire as __rspack_createRequire } from "node:module";',
  'const __rspack_createRequire_require = __rspack_createRequire(import.meta.url);',
  `export const dep = __rspack_createRequire_require(${JSON.stringify(specifier)});`,
  '',
].join('\n');

const unsupported = (call: string): string => `uses unsupported specifier "left-pad" in ${call}.`;
const computed = (call: string): string => `loads a non-literal specifier through ${call}.`;
const requireReference = 'passes require on as a value instead of calling it.';
const boundReference = 'passes load, a createRequire(…) loader, on as a value instead of calling it.';

describe('validateJavaScriptModules', () => {
  it.each([
    ['require()', 'export const pad = require("left-pad");\n', unsupported('require("left-pad")')],
    [
      'require() in a template substitution',
      'export const banner = `v${require("left-pad")}`;\n',
      unsupported('require("left-pad")'),
    ],
    [
      'require() after postfix increment and division',
      'const n = count++ / require("left-pad") / 2;\nexport { n };\n',
      unsupported('require("left-pad")'),
    ],
    ['an optional require() call', 'export const pad = require?.("left-pad");\n', unsupported('require("left-pad")')],
    ['require() with a trailing comma', 'export const pad = require("left-pad",);\n', unsupported('require("left-pad")')],
    ['require.resolve()', 'export const where = require.resolve("left-pad");\n', unsupported('require.resolve("left-pad")')],
    [
      'a direct createRequire()() call',
      `${factoryImport}export const pad = createRequire(import.meta.url)("left-pad");\n`,
      unsupported('createRequire(…)("left-pad")'),
    ],
    [
      'createRequire().resolve()',
      `${factoryImport}export const where = createRequire(import.meta.url).resolve("left-pad");\n`,
      unsupported('createRequire(…).resolve("left-pad")'),
    ],
    ['a const-bound loader', `${boundLoader('const')}export const pad = load("left-pad");\n`, unsupported('load("left-pad"), a createRequire(…) loader')],
    ['a let-bound loader', `${boundLoader('let')}export const pad = load("left-pad");\n`, unsupported('load("left-pad"), a createRequire(…) loader')],
    [
      "a var-bound loader's resolve()",
      `${boundLoader('var')}export const where = load.resolve("left-pad");\n`,
      unsupported('load.resolve("left-pad"), a createRequire(…) loader'),
    ],
    [
      'an aliased factory',
      'import { createRequire as mk } from "node:module";\nexport const pad = mk(import.meta.url)("left-pad");\n',
      unsupported('mk(…)("left-pad")'),
    ],
    [
      'a namespace-qualified factory',
      'import * as Module from "node:module";\nexport const pad = Module.createRequire(import.meta.url)("left-pad");\n',
      unsupported('createRequire(…)("left-pad")'),
    ],
    ["Rspack's createRequire shim", rspackShim('left-pad'), unsupported('__rspack_createRequire_require("left-pad"), a createRequire(…) loader')],
    ['import.meta.resolve()', 'export const where = import.meta.resolve("left-pad");\n', unsupported('import.meta.resolve("left-pad")')],
    // The specifier is decoded before it is judged and named: `\x6c` is `l`.
    ['a hex-escaped require() literal', `${String.raw`export const pad = require("\x6ceft-pad");`}\n`, unsupported('require("left-pad")')],
  ])('rejects a compiled module that loads a bare package through %s', async (_form, source, detail) => {
    await expect(validateProbe(source)).resolves.toEqual([finding(probe, detail)]);
  });

  it.each([
    ['require()', 'export const load = (name) => require(name);\n', computed('require(…)')],
    ['require.resolve()', 'export const where = (name) => require.resolve(name);\n', computed('require.resolve(…)')],
    ['import.meta.resolve()', 'export const where = (name) => import.meta.resolve(name);\n', computed('import.meta.resolve(…)')],
    [
      'a direct createRequire()() call',
      `${factoryImport}export const load = (name) => createRequire(import.meta.url)(name);\n`,
      computed('createRequire(…)(…)'),
    ],
    [
      'createRequire().resolve()',
      `${factoryImport}export const where = (name) => createRequire(import.meta.url).resolve(name);\n`,
      computed('createRequire(…).resolve(…)'),
    ],
    ['a bound loader', `${boundLoader('const')}export const any = (name) => load(name);\n`, computed('load(…), a createRequire(…) loader')],
    [
      "a bound loader's resolve()",
      `${boundLoader('const')}export const where = (name) => load.resolve(name);\n`,
      computed('load.resolve(…), a createRequire(…) loader'),
    ],
    ['require() of a literal-prefixed expression', 'export const driver = (variant) => require("driver/" + variant);\n', computed('require(…)')],
    ['require.resolve() of a template literal', 'export const driver = (variant) => require.resolve(`driver/${variant}`);\n', computed('require.resolve(…)')],
  ])('rejects a compiled module whose %s argument is computed', async (_form, source, detail) => {
    await expect(validateProbe(source)).resolves.toEqual([finding(probe, detail)]);
  });

  it.each([
    // `l` is no loader the scan knows, so its call raises nothing further.
    ['const l = require;', 'const l = require;\nexport const pad = l("left-pad");\n', requireReference],
    ['fn(load) with a bound loader', `${boundLoader('const')}export const use = (fn) => fn(load);\n`, boundReference],
    ['[require]', 'export const loaders = [require];\n', requireReference],
    ['{ key: require }', 'export const host = { key: require };\n', requireReference],
    ['{ require }', 'export const host = { require };\n', requireReference],
    ['x ? load : y', `${boundLoader('const')}export const pick = (x, y) => x ? load : y;\n`, boundReference],
    ['return load', `${boundLoader('const')}export function loader() {\n  return load;\n}\n`, boundReference],
    ['=> load', `${boundLoader('const')}export const loader = () => load;\n`, boundReference],
    ['a default initializer, function f(x = require) {', 'export function f(x = require) { return x; }\n', requireReference],
    ['a default initializer in a pattern, const { x = load } = host', `${boundLoader('const')}const { x = load } = host;\nexport { x };\n`, boundReference],
  ])('rejects a compiled module that passes %s on as a value', async (_form, source, detail) => {
    await expect(validateProbe(source)).resolves.toEqual([finding(probe, detail)]);
  });

  it('names dist paths through reportedRoot the way the package build does', async () => {
    await expect(validateJavaScriptModules({
      ...await stage({ 'bin/tool.js': 'export const pad = require("left-pad");\n' }),
      bundledPaths: new Set(['bin/tool.js']),
      reportedRoot: 'dist',
      validJson: noJson,
    })).resolves.toEqual([finding('dist/bin/tool.js', unsupported('require("left-pad")'))]);
  });

  it('accepts Node built-ins loaded through every resolver, under both spellings', async () => {
    await expect(validateProbe([
      boundLoader('const').trimEnd(),
      'export const loaded = [',
      '  require("node:fs"),',
      '  require("fs"),',
      '  require.resolve("path"),',
      '  createRequire(import.meta.url)("node:util"),',
      '  createRequire(import.meta.url).resolve("util"),',
      '  load("node:os"),',
      '  load.resolve("crypto"),',
      '  import.meta.resolve("node:path"),',
      String.raw`  require("node:f\x73"),`,
      '];',
      '',
    ].join('\n'), { 'scripts/shim.mjs': rspackShim('perf_hooks') })).resolves.toEqual([]);
  });

  it('resolves a relative literal load inside the tree and walks the target', async () => {
    const helper = { 'scripts/helper.js': 'import "left-pad";\nexport const helper = true;\n' };
    await expect(validateProbe(
      `${factoryImport}export const helper = createRequire(import.meta.url)("./helper.js");\n`,
      helper,
    )).resolves.toEqual([finding('scripts/helper.js', 'uses unsupported specifier "left-pad".')]);

    // The target is walked from the load, not merely as a root of its own:
    // the entry sorts first, and its walk reports the helper's import before
    // the entry's own later load.
    await expect(validateJavaScriptModules({
      ...await stage({
        'scripts/entry.mjs': `${boundLoader('const')}export const helper = load("./helper.js");\nexport const pad = load("right-pad");\n`,
        ...helper,
      }),
      bundledPaths: new Set(['scripts/entry.mjs']),
      validJson: noJson,
    })).resolves.toEqual([
      finding('scripts/helper.js', 'uses unsupported specifier "left-pad".'),
      finding('scripts/entry.mjs', 'uses unsupported specifier "right-pad" in load("right-pad"), a createRequire(…) loader.'),
    ]);
  });

  it.each([
    ['import.meta.resolve()', 'export const where = import.meta.resolve("./helper.js");\n'],
    ['require.resolve()', 'export const where = require.resolve("./helper.js");\n'],
    ['hex-escaped require()', `${String.raw`export const helper = require("./hel\x70er.js");`}\n`],
  ])('accepts a relative %s target that exists in the tree', async (_form, source) => {
    // No `bundledPaths`: both modules are parsed in full, as copied ones are.
    await expect(validateJavaScriptModules({
      ...await stage({ [probe]: source, 'scripts/helper.js': 'export const helper = true;\n' }),
      validJson: noJson,
    })).resolves.toEqual([]);
  });

  it('reports a relative load whose target is missing, or a JSON target not listed as valid', async () => {
    const staged = await stage({
      [probe]: [
        'export const missing = require("./missing.js");',
        'export const data = require("./data.json");',
        'export const outside = import.meta.resolve("../../outside.js");',
        '',
      ].join('\n'),
      'scripts/data.json': '{"ok":true}\n',
    });
    await expect(validateJavaScriptModules({ ...staged, bundledPaths: compiled, validJson: noJson })).resolves.toEqual([
      finding(probe, 'is missing "./missing.js" in require("./missing.js").'),
      finding(probe, 'references invalid JSON "./data.json" in require("./data.json").'),
      finding(probe, 'resolves outside the artifact root: "../../outside.js" in import.meta.resolve("../../outside.js").'),
    ]);
    await expect(validateJavaScriptModules({
      ...staged,
      bundledPaths: compiled,
      validJson: new Set(['scripts/data.json']),
    })).resolves.toEqual([
      finding(probe, 'is missing "./missing.js" in require("./missing.js").'),
      finding(probe, 'resolves outside the artifact root: "../../outside.js" in import.meta.resolve("../../outside.js").'),
    ]);
  });

  it('never scans a prebuilt payload module, even one a compiled module loads', async () => {
    await expect(validateJavaScriptModules({
      ...await stage({
        [probe]: `${factoryImport}export const server = createRequire(import.meta.url)("./runtime/server.js");\n`,
        'scripts/runtime/server.js': [
          'import express from "express";',
          'const parser = require(process.env.PARSER);',
          'export default express;',
          'export { parser };',
          '',
        ].join('\n'),
      }),
      bundledPaths: compiled,
      prebuiltPaths: new Set(['scripts/runtime/server.js']),
      validJson: noJson,
    })).resolves.toEqual([]);
  });

  it.each<readonly [form: string, source: string, siblings?: Readonly<Record<string, string>>]>([
    ['a line comment', '// require("probe-dep") is prose\nexport const ok = true;\n'],
    ['a bundled docblock', '/**\n * Use require("probe-dep") when the host lacks it.\n */\nexport const ok = true;\n'],
    ['a string literal', 'export const text = \'require("probe-dep")\';\n'],
    ['a template literal', 'export const code = `require("ajv/dist/runtime/equal").default`;\n'],
    ['an escaped-quote string', `${String.raw`export const code = "require(\"ajv/dist/runtime/equal\").default";`}\n`],
    ['a regex literal holding a quote before such a string', 'export const quote = /["\']/u;\nexport const example = "require(\'probe-dep\')";\n'],
    [
      'a bundler runtime named like require',
      'const __webpack_require__ = (id) => id;\nexport const mod = __webpack_require__("./node_modules/probe-dep/index.js");\n',
    ],
    [
      "Rspack's missing-module stub",
      'export const missing = Object(function webpackMissingModule() { var e = new Error("Cannot find module \'probe-dep\'"); e.code = \'MODULE_NOT_FOUND\'; throw e; }());\n',
    ],
    ['typeof require', 'export const cjs = typeof require === "function";\n'],
    ['path and Promise resolution', 'import path from "node:path";\nexport const where = [path.resolve("probe-dep"), Promise.resolve("probe-dep")];\n'],
    ['a loader bound but never called', `${boundLoader('const')}export const canResolve = typeof load.resolve === "function";\n`],
    [
      'a private #require method',
      'export class Store {\n  #records = new Map();\n  #require(id) { return this.#records.get(id); }\n  get(id) { return this.#require(id); }\n}\n',
    ],
    ['a require method on another object', 'export const load = (host) => host.require("probe-dep");\n'],
    ['an object key named require', 'export const conditions = { import: true, require: false };\nexport const sys = { require: (base, name) => ({ base, name }) };\n'],
    [
      'a method and a function definition named require',
      'export class Host {\n  require(id) { return this.modules.get(id); }\n}\nfunction require(id, parent) {\n  return id;\n}\n',
    ],
    [
      'require binding positions',
      [
        'import { require } from "./helper.js";',
        'export function wrapper(module, exports, require) { return 1; }',
        'try { x(); } catch (require) {}',
        '{ const { require } = host; }',
        '',
      ].join('\n'),
      { 'scripts/helper.js': 'export const require = 1;\n' },
    ],
    [
      'a createRequire name inside a comment',
      '/* const load = createRequire(import.meta.url); */\nfunction load(x) { return x; }\nload("left-pad");\n',
    ],
    ['a longer identifier', 'const require_fast_uri = () => "fast-uri";\nexport const uri = require_fast_uri();\n'],
  ])('does not fail a compiled module for %s', async (_form, source, siblings = {}) => {
    await expect(validateProbe(source, siblings)).resolves.toEqual([]);
  });

  it('finds the same loads whether a module is lexed as a bundle or parsed in full', async () => {
    const staged = await stage({
      [probe]: [
        boundLoader('const').trimEnd(),
        'export const pad = load("left-pad");',
        'export const any = (name) => require(name);',
        'export const where = import.meta.resolve("right-pad");',
        '',
      ].join('\n'),
    });
    const expected = [
      finding(probe, unsupported('load("left-pad"), a createRequire(…) loader')),
      finding(probe, computed('require(…)')),
      finding(probe, 'uses unsupported specifier "right-pad" in import.meta.resolve("right-pad").'),
    ];
    await expect(validateJavaScriptModules({ ...staged, bundledPaths: compiled, validJson: noJson })).resolves.toEqual(expected);
    await expect(validateJavaScriptModules({ ...staged, validJson: noJson })).resolves.toEqual(expected);
  });

  it("reports a module's import findings before its load findings, each in source order", async () => {
    await expect(validateProbe([
      'import "left-pad";',
      'import "right-pad";',
      'export const top = require("top-pad");',
      'export const bottom = require.resolve("bottom-pad");',
      '',
    ].join('\n'))).resolves.toEqual([
      finding(probe, 'uses unsupported specifier "left-pad".'),
      finding(probe, 'uses unsupported specifier "right-pad".'),
      finding(probe, 'uses unsupported specifier "top-pad" in require("top-pad").'),
      finding(probe, 'uses unsupported specifier "bottom-pad" in require.resolve("bottom-pad").'),
    ]);
  });
});

// The host-pack shapes `validateArtifact` hands the walk: a compiled
// (`bundle`) script under a target directory, a prebuilt payload module, and
// a copied one. `validateArtifact` maps the manifest kinds onto
// `bundledPaths` and `prebuiltPaths`; these cases hold the walk itself to the
// same findings over that layout.
describe('validateJavaScriptModules over a host-pack layout', () => {
  const loader = 'custom/scripts/loader.mjs';

  it.each([
    ['require()', 'export const pad = require("left-pad");\n', unsupported('require("left-pad")')],
    ["Rspack's createRequire shim", rspackShim('left-pad'), unsupported('__rspack_createRequire_require("left-pad"), a createRequire(…) loader')],
    ['import.meta.resolve()', 'export const where = import.meta.resolve("left-pad");\n', unsupported('import.meta.resolve("left-pad")')],
    ['a computed require()', 'export const load = (name) => require(name);\n', computed('require(…)')],
  ])('rejects a host-pack script that loads a package through %s', async (_form, source, detail) => {
    await expect(validateJavaScriptModules({
      ...await stage({ 'custom/document.json': '{"kind":"custom"}\n', [loader]: source }),
      bundledPaths: new Set([loader]),
      validJson: new Set(['custom/document.json']),
    })).resolves.toEqual([finding(loader, detail)]);
  });

  it('leaves a prebuilt payload module opaque to the load scan while a copied module is parsed', async () => {
    const source = 'const express = require("express");\nexport default express;\n';
    await expect(validateJavaScriptModules({
      ...await stage({ 'custom/scripts/copied.mjs': source, 'custom/scripts/runtime/server.mjs': source }),
      prebuiltPaths: new Set(['custom/scripts/runtime/server.mjs']),
      validJson: noJson,
    })).resolves.toEqual([finding('custom/scripts/copied.mjs', 'uses unsupported specifier "express" in require("express").')]);
  });
});
