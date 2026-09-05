import { describe, expect, it } from '@rstest/core';

import {
  decodeLiteral,
  quotedLiteral,
  scanModuleLoads,
  type LoaderReference,
  type ModuleLoad,
  type ModuleLoadForm,
} from '../src/build/module-loads.ts';
import { sha256Hex } from '../src/core/digest.ts';

const literal = (form: ModuleLoadForm, loader: string, specifier: string): ModuleLoad => ({ form, kind: 'literal', loader, specifier });
const computed = (form: ModuleLoadForm, loader: string): ModuleLoad => ({ form, kind: 'computed', loader });
const reference = (form: LoaderReference['form'], loader: string): ModuleLoad => ({ form, kind: 'reference', loader });

const rspackShim = (declaration: 'const' | 'let' | 'var'): string => [
  'import { createRequire as __rspack_createRequire } from "node:module";',
  `${declaration} __rspack_createRequire_require = __rspack_createRequire(import.meta.url);`,
  'const left_pad_namespaceObject = __rspack_createRequire_require("left-pad");',
  '',
].join('\n');

describe('scanModuleLoads reports a literal load', () => {
  it.each([
    ['require("…")', 'module.exports = require("node:path");', [literal('require', 'require', 'node:path')]],
    ['require.resolve("…")', 'module.exports = require.resolve("node:path");', [literal('require.resolve', 'require', 'node:path')]],
    ['import.meta.resolve("…")', 'export const tool = import.meta.resolve("tool-pkg/bin/tool");', [literal('import.meta.resolve', 'import.meta', 'tool-pkg/bin/tool')]],
    ['an inline node -e program', "require('optional-driver')", [literal('require', 'require', 'optional-driver')]],
    ['a statement-position call', 'require("./polyfill.js");\n', [literal('require', 'require', './polyfill.js')]],
    ['a relative require and createRequire target', 'const helper = require("./helper.cjs");\nconst data = createRequire(import.meta.url)("./data.json");\n', [
      literal('require', 'require', './helper.cjs'),
      literal('createRequire', 'createRequire', './data.json'),
    ]],
    // The factory called at once, bare or qualified through a namespace, a default import, or a CommonJS load of node:module.
    ['an inline factory call', 'import { createRequire } from "node:module";\nexport const driver = createRequire(import.meta.url)("driver-package");\n', [literal('createRequire', 'createRequire', 'driver-package')]],
    ['a nested factory argument', 'import { createRequire } from "node:module";\nexport const driver = createRequire(new URL("./entry.js", import.meta.url))("driver-package");\n', [literal('createRequire', 'createRequire', 'driver-package')]],
    ['Module.createRequire(…)("…")', 'import * as Module from "node:module";\nexport const driver = Module.createRequire(import.meta.url)("driver-package");', [literal('createRequire', 'createRequire', 'driver-package')]],
    ['module.createRequire(…)("…")', 'import module from "node:module";\nexport const driver = module.createRequire(import.meta.url)("driver-package");', [literal('createRequire', 'createRequire', 'driver-package')]],
    ['require("node:module").createRequire(…)("…")', 'module.exports = require("node:module").createRequire(__filename)("driver-package");', [
      literal('require', 'require', 'node:module'),
      literal('createRequire', 'createRequire', 'driver-package'),
    ]],
    ["require('module').createRequire(…)('…')", "module.exports = require('module').createRequire(__filename)('driver-package');", [
      literal('require', 'require', 'module'),
      literal('createRequire', 'createRequire', 'driver-package'),
    ]],
    ['require("node:module").createRequire(…).resolve("…")', 'module.exports = require("node:module").createRequire(__filename).resolve("driver-package");', [
      literal('require', 'require', 'node:module'),
      literal('createRequire.resolve', 'createRequire', 'driver-package'),
    ]],
    ['an async node-commonjs external', 'const p = import("node:module").then(function(module) { return (module.createRequire(import.meta.url)("left-pad")) });\n', [literal('createRequire', 'createRequire', 'left-pad')]],
    // A loader bound from the factory, under the factory's own name, an alias, or a qualifier.
    ['an aliased factory bound to a loader', 'import { createRequire as makeRequire } from "node:module";\nconst load = makeRequire(import.meta.url);\nexport const driver = load("driver-package");\n', [literal('bound-loader', 'load', 'driver-package')]],
    ['a loader bound from require("node:module").createRequire', 'const load = require("node:module").createRequire(__filename);\nmodule.exports = load("driver-package");\n', [
      literal('require', 'require', 'node:module'),
      literal('bound-loader', 'load', 'driver-package'),
    ]],
    ['a loader bound from a two-level namespace', 'import * as ns from "node:module";\nconst load = ns.default.createRequire(import.meta.url);\nexport const driver = load("driver-package");', [literal('bound-loader', 'load', 'driver-package')]],
    ['a bound loader\'s .resolve', 'const load = createRequire(import.meta.url);\nexport const where = load.resolve("driver-package");\n', [literal('bound-loader.resolve', 'load', 'driver-package')]],
    ['the Rspack node-commonjs shim, const', rspackShim('const'), [literal('bound-loader', '__rspack_createRequire_require', 'left-pad')]],
    ['the Rspack node-commonjs shim, let', rspackShim('let'), [literal('bound-loader', '__rspack_createRequire_require', 'left-pad')]],
    ['the Rspack node-commonjs shim, var', rspackShim('var'), [literal('bound-loader', '__rspack_createRequire_require', 'left-pad')]],
    ['the Rspack shim loading a built-in', 'import { createRequire as __rspack_createRequire } from "node:module";\nconst __rspack_createRequire_require = __rspack_createRequire(import.meta.url);\nmodule.exports = __rspack_createRequire_require("util");\n', [literal('bound-loader', '__rspack_createRequire_require', 'util')]],
    ['a bound loader beside an optional-chained method of the same name', 'const load = createRequire(import.meta.url);\nregistry?.load(name);\nload("driver-package");\n', [literal('bound-loader', 'load', 'driver-package')]],
    // Trivia and tokens around the call.
    ['comment trivia inside the call', 'module.exports = require /* driver */ ( // which\n /* a */ "driver-package" /* b */ );\n', [literal('require', 'require', 'driver-package')]],
    ['a hex escape in the specifier', String.raw`const hex = require("\x68ex-pkg");`, [literal('require', 'require', 'hex-pkg')]],
    ['a unicode escape in the specifier', String.raw`const unicode = require('unicode-pkg\u002fsubpath');`, [literal('require', 'require', 'unicode-pkg/subpath')]],
    ['a load after a nested template literal', 'const text = `outer ${flag ? `require("in-template")` : "x"} end`;\nrequire("after-template");\n', [literal('require', 'require', 'after-template')]],
    ['a load after a regex literal holding a quote, on the same line', 'const quote = /["\']/u; require("left-pad");\n', [literal('require', 'require', 'left-pad')]],
    // A template's substitutions are code: scanned with the source's names, reported where the template appears.
    ['a load in a template substitution', 'const v = `pre ${require("x")} post`;\n', [literal('require', 'require', 'x')]],
    ['a load in a nested template substitution', 'const v = `${`${require("x")}`}`;\n', [literal('require', 'require', 'x')]],
    ['loads around and inside templates, in source order', 'require("1"); const v = `${require("2")} ${`${require("3")}`}`; require("4");\n', [
      literal('require', 'require', '1'),
      literal('require', 'require', '2'),
      literal('require', 'require', '3'),
      literal('require', 'require', '4'),
    ]],
    ['a bound loader called in a template substitution', 'const load = createRequire(import.meta.url);\nconst v = `${load("driver-package")}`;\n', [literal('bound-loader', 'load', 'driver-package')]],
    ['a template beyond the nesting budget, whose text is scanned as code', 'const v = `${ {a:{b:{c: require("x")}}} }`;\n', [literal('require', 'require', 'x')]],
    // A `/` after `++` or `--` is division, so the operand after it is code.
    ['a load after a postfix increment and a division', 'count++ / require("left-pad") / divisor\n', [literal('require', 'require', 'left-pad')]],
    ['a load after a postfix decrement and a division', 'count-- / require("left-pad") / divisor\n', [literal('require', 'require', 'left-pad')]],
    ['a load after a prefix increment and a division', 'const x = ++i / 2; require("left-pad");\n', [literal('require', 'require', 'left-pad')]],
    // Optional chaining before the argument list or `resolve`.
    ['require?.("…")', 'module.exports = require?.("left-pad");', [literal('require', 'require', 'left-pad')]],
    ['require.resolve?.("…")', 'module.exports = require.resolve?.("left-pad");', [literal('require.resolve', 'require', 'left-pad')]],
    ['require?.resolve("…")', 'module.exports = require?.resolve("left-pad");', [literal('require.resolve', 'require', 'left-pad')]],
    ['require ?. ("…") with spaces', 'module.exports = require ?. ("left-pad");', [literal('require', 'require', 'left-pad')]],
    ['load?.("…") for a bound loader', 'const load = createRequire(import.meta.url);\nexport const driver = load?.("driver-package");\n', [literal('bound-loader', 'load', 'driver-package')]],
    ['load?.resolve("…") for a bound loader', 'const load = createRequire(import.meta.url);\nexport const where = load?.resolve("driver-package");\n', [literal('bound-loader.resolve', 'load', 'driver-package')]],
    ['import.meta.resolve?.("…")', 'export const tool = import.meta.resolve?.("tool-pkg");', [literal('import.meta.resolve', 'import.meta', 'tool-pkg')]],
    ['createRequire(…)?.("…")', 'export const driver = createRequire(import.meta.url)?.("driver-package");', [literal('createRequire', 'createRequire', 'driver-package')]],
    ['createRequire(…)?.resolve("…")', 'export const where = createRequire(import.meta.url)?.resolve("driver-package");', [literal('createRequire.resolve', 'createRequire', 'driver-package')]],
    // A trailing comma after the one literal argument.
    ['require("…",)', 'module.exports = require("left-pad",);', [literal('require', 'require', 'left-pad')]],
    ['require.resolve("…", )', 'module.exports = require.resolve("left-pad", );', [literal('require.resolve', 'require', 'left-pad')]],
    ['require("…", /* comment */)', 'module.exports = require("left-pad", /* was: "right-pad" */);', [literal('require', 'require', 'left-pad')]],
    ['import.meta.resolve("…",)', 'export const tool = import.meta.resolve("tool-pkg",);', [literal('import.meta.resolve', 'import.meta', 'tool-pkg')]],
    ['createRequire(…)("…",)', 'export const driver = createRequire(import.meta.url)("driver-package",);', [literal('createRequire', 'createRequire', 'driver-package')]],
    ['load("…",) and load.resolve("…",) for a bound loader', 'const load = createRequire(import.meta.url);\nload("driver-package",);\nload.resolve("asset-pkg",);\n', [
      literal('bound-loader', 'load', 'driver-package'),
      literal('bound-loader.resolve', 'load', 'asset-pkg'),
    ]],
    ['require rebound from createRequire, with every resolver', [
      'const { createRequire } = await import("node:module");',
      'const require = createRequire(import.meta.url);',
      'const required = require("@scope/required/subpath");',
      'const asset = require.resolve("asset-pkg/package.json");',
      'const tool = import.meta.resolve("tool-pkg/bin/tool");',
      String.raw`const hex = require("\x68ex-pkg");`,
      String.raw`const unicode = require('unicode-pkg\u002fsubpath');`,
      '// import { Function } from "effect" -- a comment never counts.',
    ].join('\n'), [
      literal('require', 'require', '@scope/required/subpath'),
      literal('require.resolve', 'require', 'asset-pkg/package.json'),
      literal('import.meta.resolve', 'import.meta', 'tool-pkg/bin/tool'),
      literal('require', 'require', 'hex-pkg'),
      literal('require', 'require', 'unicode-pkg/subpath'),
    ]],
  ])('for %s', (_form, source, loads) => {
    expect(scanModuleLoads(source)).toEqual(loads);
  });
});

describe('scanModuleLoads reports a computed load', () => {
  it.each([
    ['require(x)', 'module.exports = (name) => require(name);', [computed('require', 'require')]],
    ['require.resolve(x)', 'module.exports = (name) => require.resolve(name);', [computed('require.resolve', 'require')]],
    ['import.meta.resolve(x)', 'export const where = (name) => import.meta.resolve(name);', [computed('import.meta.resolve', 'import.meta')]],
    ['createRequire(…)(x)', 'import { createRequire } from "node:module";\nexport const load = (name) => createRequire(import.meta.url)(name);', [computed('createRequire', 'createRequire')]],
    ['createRequire(…)(x) with a nested factory argument', 'import { createRequire } from "node:module";\nexport const any = (name) => createRequire(new URL("./entry.js", import.meta.url))(name);\n', [computed('createRequire', 'createRequire')]],
    ['Module.createRequire(…)(x)', 'import * as Module from "node:module";\nexport const load = (name) => Module.createRequire(import.meta.url)(name);', [computed('createRequire', 'createRequire')]],
    ['require("node:module").createRequire(…)(x)', 'module.exports = (name) => require("node:module").createRequire(__filename)(name);', [
      literal('require', 'require', 'node:module'),
      computed('createRequire', 'createRequire'),
    ]],
    ['a bound loader called with an identifier', 'import * as Module from "node:module";\nconst load = Module.createRequire(import.meta.url);\nexport const any = (name) => load(name);\n', [computed('bound-loader', 'load')]],
    ['a bound loader\'s .resolve called with an identifier', 'const load = createRequire(import.meta.url);\nexport const any = (name) => load.resolve(name);\n', [computed('bound-loader.resolve', 'load')]],
    ['a literal-prefixed expression', 'module.exports = (variant) => require("chosen-at-runtime/" + variant);', [computed('require', 'require')]],
    ['a template literal argument', 'module.exports = (variant) => require.resolve(`chosen-at-runtime/${variant}`);', [computed('require.resolve', 'require')]],
    ['comment trivia before the argument', 'module.exports = (name) => require /* any */ (/* of */ name);\n', [computed('require', 'require')]],
    ['a statement-position call after a literal one', 'require("./polyfill.js");\nrequire(pathOf(x));\n', [
      literal('require', 'require', './polyfill.js'),
      computed('require', 'require'),
    ]],
    ['require?.(x)', 'module.exports = (name) => require?.(name);', [computed('require', 'require')]],
    ['load?.resolve(x) for a bound loader', 'const load = createRequire(import.meta.url);\nexport const any = (name) => load?.resolve(name);\n', [computed('bound-loader.resolve', 'load')]],
    ['two literal arguments', 'module.exports = require("left-pad", "right-pad");', [computed('require', 'require')]],
    ['a parenthesised literal', 'module.exports = require(("left-pad"));', [computed('require', 'require')]],
    // A template argument is a token like any template: its substitutions are code, its closing backtick closes it.
    ['a static template literal argument', 'module.exports = require(`left-pad`);', [computed('require', 'require')]],
    ['a template literal argument holding a load', 'module.exports = require(`${require("inner")}`);', [computed('require', 'require'), literal('require', 'require', 'inner')]],
    ['a template literal argument before another template', 'require(`x`); require("after"); const t = `z`; require("last");\n', [
      computed('require', 'require'),
      literal('require', 'require', 'after'),
      literal('require', 'require', 'last'),
    ]],
  ])('for %s', (_form, source, loads) => {
    expect(scanModuleLoads(source)).toEqual(loads);
  });
});

describe('scanModuleLoads reports a loader passed on as a value', () => {
  it.each([
    ['const load = require;', 'const load = require;\nmodule.exports = load("chosen-at-runtime");', [reference('require', 'require')]],
    ['fn(require)', 'module.exports = (fn) => fn(require);', [reference('require', 'require')]],
    ['module.exports = require', 'module.exports = require', [reference('require', 'require')]],
    ['[require]', 'module.exports = [require];', [reference('require', 'require')]],
    ['{ require }', 'module.exports = { require };\nexport const pair = { other, require };\n', [reference('require', 'require'), reference('require', 'require')]],
    ['{ key: require }', 'module.exports = { load: require };\n', [reference('require', 'require')]],
    ['x ? require : y', 'module.exports = typeof require === "function" ? require : null;', [reference('require', 'require')]],
    ['x ? y : require', 'module.exports = typeof require === "function" ? null : require;\n', [reference('require', 'require')]],
    ['return require', 'function loader() {\n  return require;\n}', [reference('require', 'require')]],
    ['=> require', 'export const loader = () => require;', [reference('require', 'require')]],
    ['fn(load) for a bound loader', 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const use = (fn) => fn(load);', [reference('bound-loader', 'load')]],
    ['return load for a bound loader', 'const load = createRequire(import.meta.url);\nfunction loader() { return load }\n', [reference('bound-loader', 'load')]],
    ['=> load for a bound loader', 'const load = createRequire(import.meta.url);\nexport const loader = () => load;\n', [reference('bound-loader', 'load')]],
    // Values that share a shape with a binding position, and are not one.
    ['fn(a, require) and fn(require, b)', 'fn(a, require);\nfn(require, b);\n', [reference('require', 'require'), reference('require', 'require')]],
    ['fn(require, callback) with a block body', 'register(require, function (id) { return id; });\nregister(require, () => { run(); });\n', [reference('require', 'require'), reference('require', 'require')]],
    ['fn(require) as an if condition', 'if (accepts(require)) { run(); }\n', [reference('require', 'require')]],
    ['use({ require }), an object literal argument', 'use({ require });\nuse({ other, require });\n', [reference('require', 'require'), reference('require', 'require')]],
    ['const x = { require }, an object literal initialiser', 'const context = { require };\n', [reference('require', 'require')]],
    ['{ require } returned before a later indexed assignment', 'function context() {\n  return { require }\n}\ncache[0] = 1;\n', [reference('require', 'require')]],
    ['[require] before a later array pattern', 'const list = [require];\nconst [first] = list;\n', [reference('require', 'require')]],
    ['[require].map(…)', 'const names = [require].map((fn) => fn.name);\n', [reference('require', 'require')]],
    ['a later declarator initialised with the loader', 'const a = b, load = require;\n', [reference('require', 'require')]],
    ['x && require, x || require', 'const l = a && require;\nconst m = a || require;\n', [reference('require', 'require'), reference('require', 'require')]],
    ['export { require }', 'const require = createRequire(import.meta.url);\nexport { require };\n', [reference('require', 'require')]],
    ['fn(require) in a template substitution', 'const text = `${describe(require)}`;\n', [reference('require', 'require')]],
    ['x ? require : y in a template substitution', 'const text = `${flag ? require : fallback}`;\n', [reference('require', 'require')]],
  ])('for %s', (_form, source, loads) => {
    expect(scanModuleLoads(source)).toEqual(loads);
  });
});

describe('scanModuleLoads reports nothing', () => {
  it.each([
    ['typeof require', 'module.exports = typeof require;'],
    ['the string "require"', 'module.exports = "require";'],
    ['prose in comments', '/**\n * Use when a getter may fail, require\n * services, or run asynchronously.\n */\n// factory(module, require)\nmodule.exports = 1;'],
    ['an express docblock', '/**\n * Module dependencies.\n * @private\n */\n\nvar debug = createDebug("express:router");\n// var depd = require("depd"); -- once\n'],
    ['a bundler runtime named like require', 'const load = __webpack_require__;\nmodule.exports = load;'],
    ['a longer identifier', 'var uri = require_fast_uri();\nvar u = __webpack_require__("./x");\n'],
    ['path and Promise resolution', 'import path, { resolve } from "node:path";\nexport const f = (a, b) => [resolve(a, b), Promise.resolve(a), path.resolve("never-loaded"), Promise.resolve("never-loaded")];'],
    ['ajv code in a template literal', 'code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`\n'],
    ['ajv code in a string with escaped quotes', 'equal.code = "require(\\"ajv/dist/runtime/equal\\").default";\n'],
    ['ajv code in a single-quoted string', "equal.code = 'require(\"ajv/dist/runtime/equal\").default';\n"],
    ['code in a template whose substitution holds an object literal', 'const text = `${JSON.stringify({ a })} then require("ajv/dist/x") ${xs.map((x) => { return x; })}`;\n'],
    ['a private #require method', 'class Store { #require(taskId) { return this.#records.get(taskId); }\n  get(taskId) { const record = this.#require(taskId); return record; } }\n'],
    ['a method named require on another object', 'const result = host.require(resolvedPath, pluginConfigEntry.name);\nsys.require = (baseDir, moduleName) => ({});\n'],
    ['an object key named require', 'const sys = {\n  base64encode: (input) => input,\n  require: (baseDir, moduleName) => ({ baseDir, moduleName }),\n};\nconst conditions = { import: true, require: false };\nconst hooks = { require: fn };\n'],
    ['a method and a function named require', 'class Host {\n  require(id) { return this.modules.get(id); }\n}\nfunction require(id, parent) {\n  return id;\n}\n'],
    ['the Rspack missing-module stub', '!(function webpackMissingModule() { var e = new Error("Cannot find module \'left-pad\'"); e.code = \'MODULE_NOT_FOUND\'; throw e; }())\n'],
    ['a regex literal holding a quote before a string with require', 'const quote = /["\']/u;\nconst example = "require(\'left-pad\')";\n'],
    ['iconv prose in a comment and an error string', '// > iconv.enableStreamingAPI(require(\'stream\'));\nthrow new Error("Use iconv.enableStreamingAPI(require(\'stream\'))");\n'],
    ['import.meta.url', 'const here = import.meta.url;\nconst dir = new URL(".", import.meta.url);\n'],
    ['a dynamic import, which the lexer reports', 'const p = import("left-pad");\nconst q = import(name);\n'],
    // Binding positions introduce a name; they pass no loader on.
    ['a function parameter', 'function wrapper(module, exports, require) {}\nfunction first(require, module) {}\n'],
    ['a function expression parameter', 'const wrapper = function (require) {};\nconst star = function* (module, require) {};\n'],
    ['an arrow parameter list', 'const one = (require) => 1;\nconst two = (module, require) => 2;\nconst three = async (require) => {};\n'],
    ['a bare arrow parameter', 'const one = require => 1;\n'],
    ['a method parameter', 'const host = { load(require) { return 1; } };\nclass Host { run(require) {} }\n'],
    ['a catch parameter', 'try { run(); } catch (require) {}\n'],
    ['a bound loader as a parameter', 'const load = createRequire(import.meta.url);\nfunction wrap(load) {}\nconst arrow = (load) => 1;\n'],
    ['an if, while, or switch head', 'if (require) {}\nwhile (require) {}\nswitch (require) {}\n'],
    ['a declared object pattern', 'const { require } = host;\nlet { a, require: r } = host;\nvar { other, require } = host;\n'],
    ['a declared object pattern, nested or renaming', 'const { a: { require } } = host;\nconst { a: require } = host;\n'],
    ['a declared array pattern', 'const [require] = host;\nlet [a, require] = xs;\n'],
    ['an assigned pattern', '({ require } = host);\n[require] = host;\n'],
    ['a pattern parameter', 'function wrap({ require }) {}\nconst arrow = ({ require }) => 1;\nfor (const { require } of hosts) {}\n'],
    ['a later declarator', 'let a, require;\nvar b = 1, require;\n'],
    ['a bound loader in a pattern', 'const load = createRequire(import.meta.url);\nconst { load } = host;\n'],
    ['an import specifier', 'import { require } from "./helper.js";\nimport { a, require } from "./helper.js";\nimport { require, a }\n  from "./helper.js";\n'],
    ['a re-export specifier', 'export { require } from "./helper.js";\n'],
    // Binding names are read from code, never from a comment, a string, or a template.
    ['a loader bound in a block comment', '/* const load = createRequire(import.meta.url); */\nfunction load(x) { return x; }\nload("left-pad");\n'],
    ['a factory alias in a block comment', '/* { createRequire: mk } */\nmk(import.meta.url)("left-pad");\n'],
    ['a factory alias in a line comment', '// import { createRequire as mk } from "node:module"\nmk(import.meta.url)("left-pad");\n'],
    ['a loader bound in a string', 'const shim = "const load = createRequire(import.meta.url);";\nfunction load(x) { return x; }\nload("left-pad");\n'],
    ['a loader bound in a template', 'const shim = `const load = createRequire(import.meta.url);`;\nload("left-pad");\n'],
    ['a bound loader called in a comment', 'const load = createRequire(import.meta.url);\n/* load("left-pad") */\n'],
    // Template quasis are text; an escaped `\${` is text; a whole-substitution loader name converts to a string.
    ['a template whose quasis say require', 'const v = `require("x")`;\nconst w = `require("no") ${ok} require("no")`;\n'],
    ['an escaped substitution', 'const v = `\\${require("x")}`;\n'],
    ['a loader name as a whole substitution', 'const v = `${require}`;\n'],
    ['an empty specifier', 'module.exports = require("");\n'],
  ])('for %s', (_form, source) => {
    expect(scanModuleLoads(source)).toEqual([]);
  });
});

/*
 * A `/` directly after `)` is division, since `(a + b) / 2` is common in emitted code and `if (x) /re/` is not, so a
 * regex written there is scanned as code: a load inside it is reported, and a quote inside it opens a string token
 * that runs to the next quote on the line, hiding the code between. Both are pinned here as the approximation the
 * module's header states.
 */
describe('scanModuleLoads reads a regex literal directly after `)` as code', () => {
  it.each([
    ['a load written inside the regex is reported', 'if (enabled) /require("left-pad")/.test(text)\n', [literal('require', 'require', 'left-pad')]],
    ['a quote inside the regex hides the rest of its line', 'if (x) /"/.test(y); require("hidden");\nrequire("next-line");\n', [literal('require', 'require', 'next-line')]],
    ['division after `)` is code as it should be', 'const half = (a + b) / 2; require("left-pad");\n', [literal('require', 'require', 'left-pad')]],
  ])('so %s', (_case, source, loads) => {
    expect(scanModuleLoads(source)).toEqual(loads);
  });
});

describe('decodeLiteral', () => {
  it.each([
    [String.raw`\x68ex-pkg`, 'hex-pkg'],
    [String.raw`unicode-pkg\u002fsubpath`, 'unicode-pkg/subpath'],
    [String.raw`\u{1F600}`, '\u{1F600}'],
    [String.raw`a\nb\tc\0`, 'a\nb\tc\0'],
    [String.raw`\/\'\"\\`, '/\'"\\'],
    ['plain', 'plain'],
    // Beyond Unicode the literal is a syntax error; the escape denotes nothing.
    [String.raw`\u{110000}x`, 'x'],
  ])('decodes %j to %j', (body, value) => {
    expect(decodeLiteral(body)).toBe(value);
  });
});

it('quotedLiteral names its groups and numbers them 1 and 2 when it opens the expression', () => {
  const match = new RegExp(quotedLiteral, 'u').exec(String.raw`x = "a\"b" + 'c'`);
  expect(match?.groups).toEqual({ body: String.raw`a\"b`, quote: '"' });
  expect([match?.[1], match?.[2]]).toEqual(['"', String.raw`a\"b`]);
  expect(new RegExp(quotedLiteral, 'u').exec("f('single')")?.groups?.body).toBe('single');
  // Nothing spans a newline or an empty body.
  expect(new RegExp(quotedLiteral, 'u').exec('"a\nb"')).toBeNull();
  expect(new RegExp(quotedLiteral, 'u').exec('""')).toBeNull();
});

it('remembers loads by digest so the same bytes are scanned once per process', () => {
  const bytes = 'const load = createRequire(import.meta.url);\nload("driver-package");\n';
  const sha256 = sha256Hex(bytes);
  const loads = scanModuleLoads(bytes, { sha256 });
  expect(loads).toEqual([literal('bound-loader', 'load', 'driver-package')]);
  expect(Object.isFrozen(loads)).toBe(true);
  expect(loads.every((load) => Object.isFrozen(load))).toBe(true);
  expect(scanModuleLoads(bytes, { sha256 })).toBe(loads);
  // The remembered value is the digest's, even from a different source string.
  expect(scanModuleLoads('/* replaced */', { sha256 })).toBe(loads);
  // Without a digest nothing is remembered.
  const first = scanModuleLoads(bytes);
  expect(first).toEqual(loads);
  expect(first).not.toBe(loads);
  expect(scanModuleLoads(bytes)).not.toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
});
