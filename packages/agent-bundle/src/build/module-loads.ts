import { DigestCache } from '../core/digest.ts';

/**
 * The module loads a JavaScript source makes outside the `import` syntax the
 * ES-module lexer reports: `require("x")` and `require.resolve("x")`, a
 * `createRequire(…)` factory called at once (`createRequire(…)("x")`,
 * `Module.createRequire(…).resolve("x")`, an alias `mk(…)("x")`), a loader
 * bound from one and called later (`const load = createRequire(import.meta.url);
 * load("x")` — the shim Rspack emits for an external kept as `node-commonjs`),
 * and `import.meta.resolve("x")`. Two gates read them and agree on what a load
 * is while disagreeing on what it means. `AB6005`
 * (`validate-artifact-modules.ts`) walks every load of every compiled or
 * generated module it validates and fails a bare package name, a computed
 * argument, or a loader passed on as a value, exactly as it fails the same
 * shapes of `import`. `AB7014` (`pack-dependencies.ts`) reads the literal
 * specifiers as evidence that a declared dependency is used, and a computed
 * load or a passed-on loader as a reason to withhold the finding, since the
 * file may then load a package no literal names.
 *
 * The scan reads code, not text. One pass over the source treats block and
 * line comments, string and template literals, and regular-expression
 * literals as tokens it steps over, so `require("x")` inside a bundled
 * docblock, an ajv code template, or an error message is never a load. A
 * keep-only gate could tolerate a match inside prose — at worst it keeps a
 * declaration — but under `AB6005` every match fails a build, and bundled
 * library output is full of prose that says `require`. Word boundaries make
 * the rest exact: a loader or factory name is matched whole and never after
 * `.`, `#`, or an identifier character (`host.require(…)`,
 * `this.#require(…)`, `__webpack_require__(…)`, `require_fast_uri()`); an
 * argument list followed by `{` is a method or function being defined
 * (`require(id) {`), not a call; and only `require`, `import.meta`, and a
 * `createRequire` factory resolve modules, so `path.resolve("x")`,
 * `Promise.resolve("x")`, and `typeof require` never match.
 *
 * Two approximations remain. Bound loaders and factory aliases are tracked by
 * name — `const|let|var <name> = createRequire(…)`, `createRequire as <name>`,
 * `createRequire: <name>` — found anywhere in the source, comments included,
 * so the tracking assumes the unminified output the framework's bundler
 * emits, and a loader rebound another way (`let load; load = createRequire(…)`,
 * a destructured result) is not one. A `/` is read as a regular-expression
 * literal where an operand is expected — after an operator, an opening
 * bracket, `return`, `typeof`, and the like — and as division after `)` or
 * an identifier, so a regex that follows `)` (`if (x) /'/.test(y)`) is
 * scanned as code, and a quote inside it can misalign the strings after it
 * on the same line.
 */

/** The call a load is made through, the shape `AB6005` names in its message. */
export type ModuleLoadForm =
  | 'require' // require("x")
  | 'require.resolve' // require.resolve("x")
  | 'createRequire' // createRequire(…)("x"), Module.createRequire(…)("x"), mk(…)("x") for an alias mk
  | 'createRequire.resolve' // createRequire(…).resolve("x")
  | 'bound-loader' // load("x") after const load = createRequire(…)
  | 'bound-loader.resolve' // load.resolve("x") after const load = createRequire(…)
  | 'import.meta.resolve'; // import.meta.resolve("x")

interface ModuleLoadSite {
  readonly form: ModuleLoadForm;
  /** The identifier as written: `require`, the bound name (`load`), the factory or its alias (`createRequire`, `mk`), or `import.meta`. */
  readonly loader: string;
}

/** A load whose argument is one string literal; `specifier` is the decoded value (`"\x6ceft-pad"` is `left-pad`). */
export interface LiteralModuleLoad extends ModuleLoadSite {
  readonly kind: 'literal';
  readonly specifier: string;
}

/** A load whose argument is not a single string literal: `require(name)`, `require("driver/" + v)`, a template literal. */
export interface ComputedModuleLoad extends ModuleLoadSite {
  readonly kind: 'computed';
}

/**
 * A loader passed on as a value rather than called — `const l = require`,
 * `fn(load)`, `[require]`, `{ require }`, `{ key: require }`, `x ? require : y`,
 * `return load`, `=> load` — after which packages may be loaded under a name
 * the scan never sees.
 */
export interface LoaderReference {
  readonly kind: 'reference';
  readonly form: 'require' | 'bound-loader';
  readonly loader: string;
}

export type ModuleLoad = LiteralModuleLoad | ComputedModuleLoad | LoaderReference;

const identifier = String.raw`[A-Za-z_$][\w$]*`;

/**
 * A parenthesised argument list with calls nested up to two deep —
 * `(new URL("./entry.js", import.meta.url))`, `(join(dirname(x), "y"))` — the
 * shapes a `createRequire` argument takes.
 */
const nestedArguments = (() => {
  const flat = String.raw`[(][^()]*[)]`;
  return String.raw`[(](?:[^()]|${flat})*[)]`;
})();
/** The rest of an argument list whose `(` was consumed: up to and including its `)`. */
const argumentsRest = String.raw`(?:[^()]|${nestedArguments})*[)]`;
const callArguments = String.raw`[(]${argumentsRest}`;

// Whitespace and comments, the trivia JavaScript allows around a call's parentheses: `require /* x */ ("y")`.
const trivia = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;

/*
 * The tokens the scan steps over, each matched whole where it starts: a block
 * or line comment; a single- or double-quoted string, a backslash escaping any
 * character, a newline included; a template literal, whose `${…}` substitutions
 * may hold one flat template and up to two levels of braces
 * (`${JSON.stringify({ a })}`, `${xs.map((x) => { if (x) { … } })}`) — deeper
 * nesting leaves the template unrecognised and its text scanned as code; and a
 * regular-expression literal where an operand is expected.
 */
const blockComment = String.raw`/\*[\s\S]*?\*/`;
const lineComment = String.raw`//[^\n]*`;
const doubleQuoted = String.raw`"(?:[^"\\\n]|\\[\s\S])*"`;
const singleQuoted = String.raw`'(?:[^'\\\n]|\\[\s\S])*'`;
const flatTemplate = String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60`;
const substitutionBraces = String.raw`\{(?:[^{}\x60]|\{[^{}\x60]*\})*\}`;
const templateLiteral = String.raw`\x60(?:[^\x60\\$]|\\[\s\S]|\$(?!\{)|\$\{(?:[^{}\x60]|${substitutionBraces}|${flatTemplate})*\})*\x60`;
// A `/` where an operand is expected starts a regular-expression literal, never a division.
const regexLiteral = String.raw`(?<=(?:^|[\n(,=:[!&|?{};+\-*%<>~^])\s*|\b(?:return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw)\s+)/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+/[a-zA-Z]*`;
const skippedToken = `(?<skipped>${blockComment}|${lineComment}|${doubleQuoted}|${singleQuoted}|${templateLiteral}|${regexLiteral})`;

/**
 * A single- or double-quoted string literal: `quote` is the opening quote and
 * `body` the text between the quotes, escapes as written (`decodeLiteral`
 * reads the value). A fragment for callers' own expressions —
 * `declarationSpecifiers` in `pack-dependencies.ts` — whose groups are also
 * numbered from the fragment's position: 1 and 2 when it opens the expression.
 */
export const quotedLiteral = String.raw`(?<quote>["'])(?<body>(?:(?!\k<quote>)[^\\\n]|\\.)+)\k<quote>`;

const escapeSequence = /\\(?:x(?<hex>[0-9A-Fa-f]{2})|u\{(?<point>[0-9A-Fa-f]+)\}|u(?<unit>[0-9A-Fa-f]{4})|(?<other>.))/gsu;
const controlEscapes: Readonly<Record<string, string>> = { 0: '\0', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/**
 * The string a JavaScript literal's body denotes: `\x66oo` is `foo`,
 * `foo\u002fsubpath` is `foo/subpath`, `\/` is `/`. Node resolves the value,
 * not the source text, so a package name compared textually has to be
 * decoded first.
 */
export const decodeLiteral = (body: string): string => body.replace(escapeSequence, (...args) => {
  const groups = args.at(-1) as Record<string, string | undefined>;
  if (groups.hex !== undefined) return String.fromCharCode(Number.parseInt(groups.hex, 16));
  if (groups.unit !== undefined) return String.fromCharCode(Number.parseInt(groups.unit, 16));
  if (groups.point !== undefined) {
    const point = Number.parseInt(groups.point, 16);
    // Beyond Unicode the literal is a syntax error; the file never loads anything.
    return point > 0x10_ff_ff ? '' : String.fromCodePoint(point);
  }
  const other = groups.other ?? '';
  return controlEscapes[other] ?? other;
});

const escapeIdentifier = (name: string): string => name.replace(/\$/gu, String.raw`\$`);

/**
 * `createRequire` renamed on import or destructuring: `import { createRequire
 * as makeRequire } from "node:module"` or `const { createRequire: makeRequire }
 * = require("node:module")`. Each alias is a factory like `createRequire` itself.
 */
const createRequireAlias = /\bcreateRequire\s*(?:as|:)\s*([A-Za-z_$][\w$]*)/gu;

const factoryNames = (source: string): readonly string[] => [...new Set([
  'createRequire',
  ...Array.from(source.matchAll(createRequireAlias), (match) => escapeIdentifier(match[1] ?? '')),
])];

/**
 * What may qualify a factory in a loader binding: nothing (`createRequire(…)`
 * after a named import), a dotted namespace (`Module.createRequire(…)` after
 * `import * as Module from "node:module"`, `ns.default.createRequire(…)`), or a
 * CommonJS load (`require("node:module").createRequire(…)`,
 * `require('module')…`; any argument). No capture group: `loaderBinding`
 * counts its own by number.
 */
const factoryQualifier = String.raw`(?:(?:${identifier}\s*\.\s*)*|\brequire\s*${callArguments}\s*\.\s*)`;

/**
 * `const load = <factory>(…)` — `let` and `var` too — the factory qualified as
 * `factoryQualifier` allows or not: the binding is a loader, called like
 * `require` from then on.
 */
const loaderBinding = (factories: readonly string[]): RegExp => new RegExp(
  String.raw`\b(?:const|let|var)\s+(${identifier})\s*=\s*${factoryQualifier}(?<![\w$#])(?:${factories.join('|')})\s*[(]`,
  'gu',
);

/**
 * The identifiers a file loads packages through: `require` itself plus every
 * name bound to a `createRequire(…)` result — under the factory's own name or
 * an alias — so `const load = createRequire(import.meta.url); load("driver")`
 * counts like `require("driver")`.
 */
const loaderNames = (source: string, factories: readonly string[]): readonly string[] => [...new Set([
  'require',
  ...Array.from(source.matchAll(loaderBinding(factories)), (match) => escapeIdentifier(match[1] ?? '')),
])];

/**
 * One pass over a source: the tokens the scan steps over, then the calls and
 * loader references it reports, each alternative anchored so that it matches
 * where JavaScript would read a call or a value and nowhere else.
 */
const loadScanner = (loaders: readonly string[], factories: readonly string[]): RegExp => {
  // A loader name whole: not after `.` (a member, `host.require`), `#` (a private name), or an identifier character
  // (`__webpack_require__`), and not before one (`require_fast_uri`). A factory may follow `.`: that is the qualified
  // form, `Module.createRequire(…)` or `require("node:module").createRequire(…)`, whose qualifier needs no matching.
  const loaderCall = String.raw`(?<![\w$.#])(?<loader>${loaders.join('|')})(?![\w$])(?<loaderResolve>\s*\.\s*resolve)?`;
  const metaCall = String.raw`(?<![\w$.#])(?<meta>import\s*\.\s*meta\s*\.\s*resolve)`;
  const factoryCall = String.raw`(?<![\w$#])(?<factory>${factories.join('|')})(?![\w$])${trivia}${callArguments}(?<factoryResolve>\s*\.\s*resolve)?`;
  const call = String.raw`(?:${loaderCall}|${metaCall}|${factoryCall})${trivia}[(]${trivia}`;
  const literal = String.raw`${quotedLiteral}${trivia}[)]`;
  // Anything but a lone literal: an identifier, a template, an operator after a literal (`"driver/" + v`). A comment is
  // trivia the call prefix already consumed, not the start of a computed argument.
  const computed = String.raw`(?<computed>(?!/[*/])[^"'\s)]|"[^"\n]*"${trivia}(?!/[*/])[^)\s]|'[^'\n]*'${trivia}(?!/[*/])[^)\s])`;
  // `require(id) {` is a method or function named `require` being defined, not a call: the lookahead sees the block
  // after a balanced argument list. An argument list nesting deeper than `argumentsRest` reads is a computed call.
  const notDefinition = String.raw`(?!${argumentsRest}\s*\{)`;
  // A loader passed on as a value: after `=`, `(`, `,`, `[`, `{`, `:`, `?`, `|`, `&`, `=>`, or `return`, and before
  // `;`, `,`, `)`, `]`, `}`, or a line end (`fn(require)`, `{ key: require }`, `x ? y : require`, `return load`); or
  // the consequent of a ternary (`x ? require : y`). A `:` after the name makes it an object key (`{ require: x }`),
  // not the loader, unless a `?` precedes it.
  const names = loaders.join('|');
  const reference = String.raw`(?<=(?:=>|\breturn|[=(,[{:?|&])\s*)(?<reference>${names})(?![\w$])(?=\s*(?:[;,)\]}]|\n|$))|(?<=\?\s*)(?<ternary>${names})(?![\w$])(?=\s*:)`;
  return new RegExp(`${skippedToken}|${call}(?:${literal}|${notDefinition}${computed})|${reference}`, 'gu');
};

/** The named groups of `loadScanner`; each match sets those of one alternative. */
interface ScanGroups {
  readonly skipped?: string;
  readonly loader?: string;
  readonly loaderResolve?: string;
  readonly meta?: string;
  readonly factory?: string;
  readonly factoryResolve?: string;
  readonly quote?: string;
  readonly body?: string;
  readonly computed?: string;
  readonly reference?: string;
  readonly ternary?: string;
}

const loadForm = (groups: ScanGroups): ModuleLoadForm => {
  if (groups.meta !== undefined) return 'import.meta.resolve';
  if (groups.factory !== undefined) return groups.factoryResolve === undefined ? 'createRequire' : 'createRequire.resolve';
  if (groups.loader === 'require') return groups.loaderResolve === undefined ? 'require' : 'require.resolve';
  return groups.loaderResolve === undefined ? 'bound-loader' : 'bound-loader.resolve';
};

/** Loads already read from bytes with a known SHA-256; see `DigestCache`. */
const loadsByDigest = new DigestCache<readonly ModuleLoad[]>(512);

/**
 * Every load and loader reference of one JavaScript source, in source order.
 * Synchronous and total: a source the scan cannot follow yields the loads it
 * could read, never an error — syntax is another gate's concern. When the
 * source's SHA-256 is known, a result remembered for those bytes is returned
 * as is, and a fresh scan is remembered for the next pass over the same
 * bytes; the result is frozen either way.
 */
export const scanModuleLoads = (source: string, options?: { readonly sha256?: string }): readonly ModuleLoad[] => {
  const sha256 = options?.sha256;
  if (sha256 !== undefined) {
    const known = loadsByDigest.get(sha256);
    if (known !== undefined) return known;
  }
  const factories = factoryNames(source);
  const loaders = loaderNames(source, factories);
  const loads: ModuleLoad[] = [];
  for (const match of source.matchAll(loadScanner(loaders, factories))) {
    const groups: ScanGroups = match.groups ?? {};
    if (groups.skipped !== undefined) continue;
    const referenced = groups.reference ?? groups.ternary;
    let load: ModuleLoad;
    if (referenced !== undefined) {
      load = { form: referenced === 'require' ? 'require' : 'bound-loader', kind: 'reference', loader: referenced };
    } else {
      const site: ModuleLoadSite = { form: loadForm(groups), loader: groups.loader ?? groups.factory ?? 'import.meta' };
      load = groups.computed !== undefined
        ? { ...site, kind: 'computed' }
        : { ...site, kind: 'literal', specifier: decodeLiteral(groups.body ?? '') };
    }
    loads.push(Object.freeze(load));
  }
  const frozen = Object.freeze(loads);
  if (sha256 !== undefined) loadsByDigest.set(sha256, frozen);
  return frozen;
};
