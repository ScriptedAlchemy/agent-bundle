import { DigestCache } from '../core/digest.ts';

/**
 * The module loads a JavaScript source makes outside the `import` syntax the
 * ES-module lexer reports, for two gates that agree on what a load is while
 * disagreeing on what it means. `AB6005` (`validate-artifact-modules.ts`)
 * walks every load of every compiled or generated module it validates and
 * fails a bare package name, a computed argument, or a loader passed on as a
 * value, exactly as it fails the same shapes of `import`. `AB7014`
 * (`pack-dependencies.ts`) reads the literal specifiers as evidence that a
 * declared dependency is used, and a computed load or a passed-on loader as a
 * reason to withhold the finding, since the file may then load a package no
 * literal names.
 *
 * The calls recognised, each a literal load when its argument is one string
 * literal — a trailing comma allowed, `require("x",)` — and a computed load
 * otherwise (`require(name)`, `require("driver/" + v)`, `require("a", "b")`,
 * `require(("x"))`, and a template literal `` require(`x`) ``, static or not):
 * `require("x")` and `require.resolve("x")`; a `createRequire(…)` factory
 * called at once, `createRequire(…)("x")` and `createRequire(…).resolve("x")`,
 * the factory bare, qualified (`Module.createRequire(…)`,
 * `ns.default.createRequire(…)`, `require("node:module").createRequire(…)`),
 * or under an alias bound by `import { createRequire as mk }` or
 * `{ createRequire: mk }`; a loader bound from a factory by `const`, `let`,
 * or `var` whose initializer ends with the factory call — `const load =
 * createRequire(import.meta.url); load("x")`, `load.resolve("x")`, the shim
 * Rspack emits for an external kept as `node-commonjs`, and `const require =
 * createRequire(…)` alike, but not `const pad = createRequire(u)("x")`, which
 * binds a module and is the factory load itself; and
 * `import.meta.resolve("x")`. Whitespace and comments may separate the callee
 * from its parentheses and the argument from either parenthesis, and `?.` may
 * precede the argument list or `resolve` (`require?.("x")`,
 * `load?.resolve("x")`, `import.meta.resolve?.("x")`). A loader or factory
 * name is matched whole and
 * never after `.`, `#`, or an identifier character — `host.require(…)`,
 * `this.#require(…)`, `__webpack_require__(…)`, `require_fast_uri()` are not
 * loads — an argument list followed by `{` is a method or function being
 * defined (`require(id) {`), not a call, and only `require`, `import.meta`,
 * and a `createRequire` factory resolve modules, so `path.resolve("x")`,
 * `Promise.resolve("x")`, and `typeof require` never match. `require("")`,
 * which Node rejects, reports nothing.
 *
 * A loader reference is a loader name passed on as a value rather than called:
 * after `=`, `(`, `,`, `[`, `{`, `:`, `?`, `|`, `&`, `=>`, or `return` and
 * before `;`, `,`, `)`, `]`, `}`, or a line end — `const l = require`,
 * `fn(load)`, `[require]`, `{ require }`, `{ key: require }`, `x ? y : require`,
 * `return load`, `=> load`, `use({ require })`, `export { require }` — or the
 * consequent of a ternary (`x ? require : y`). A binding position introduces
 * a name and passes nothing on, so it is not a reference: a name inside a
 * parenthesised list that `{` or `=>` follows — a parameter list
 * (`function f(module, require) {`, `function (require) {`, `(require) => x`,
 * a method `m(require) {`, `catch (require) {`) or the head of an `if`,
 * `while`, or `switch`, which merely tests the name — a bare arrow parameter
 * (`require => x`), a destructuring pattern declared or assigned
 * (`const { require } = host`, `let [a, require] = xs`, `({ require } = host)`,
 * `const { a: { require } } = host`), a later declarator (`let a, require;`),
 * and an import or re-export specifier list (`import { require } from "./x"`,
 * `export { require } from "./x"`). The list walk reads a parameter list
 * nested two calls deep and a pattern nested one level deep; deeper, the
 * name is reported as a value. `export { require as r }` and
 * `export default require` are not read.
 *
 * The scan reads code, not text. One pass over the source treats block and
 * line comments, string literals, template literals, and regular-expression
 * literals as tokens it steps over, so `require("x")` in a bundled docblock,
 * an ajv code template, or an error message is never a load. A template's
 * quasis — the text outside its `${…}` substitutions — are text; every
 * substitution body is code, scanned with the same names as the source, so
 * `` `${require("x")}` `` and `` `${`${require("x")}`}` `` report a literal
 * load where the template appears, `` `require("x")` `` reports nothing, and a
 * loader name that is a whole substitution (`${require}`) is not a reference.
 * A substitution may hold braces two deep and one flat template
 * (`${JSON.stringify({ a: { b } })}`); a template nesting deeper is not
 * recognised, and its text is scanned as code, quasis included. The
 * `createRequire` aliases and bound loaders tracked by name are read from
 * the code between those tokens, so a binding written in a comment or a
 * string binds nothing.
 *
 * Two approximations remain. A `/` is read as a regular-expression literal
 * where an operand is expected — after an operator other than `++` and `--`,
 * after `(`, `,`, `[`, `{`, `;`, `:`, `?`, a line start, or `return`,
 * `typeof`, `case`, `do`, `else`, `in`, `of`, `instanceof`, `new`, `delete`,
 * `void`, `throw` — and as division after `)` or an identifier. So
 * `count++ / require("x") / d` reports the load, and a regex written directly
 * after `)` (`if (x) /require("y")/.test(s)`) is scanned as code: a load
 * written inside it is reported, and a quote inside it can misalign the
 * string tokens until the next quote on that line. Bindings are tracked by
 * name in the three forms above, wherever they appear in the code, which
 * assumes the unminified output the framework's bundler emits: a loader
 * bound another way — `r = createRequire(u)`, `r ??= createRequire(u)`,
 * `const [r] = [createRequire(u)]`, a second-hop alias `const s = r`, a
 * loader imported from another module — is not one, and its calls are not
 * loads. Out of scope likewise, hand-authored rather than emitted:
 * `require.call(…)`, `require.apply(…)`, `Reflect.apply(require, …)`,
 * `globalThis.require(…)`, `module.require(…)`, and `import.meta["resolve"](…)`.
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
 * `return load`, `=> load`, `export { require }` — after which packages may be
 * loaded under a name the scan never sees. A binding position (a parameter,
 * a destructuring pattern, an import specifier) is not one.
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
// An optional-chaining `?.` before an argument list: `require?.("x")`, `createRequire(…)?.("x")`.
const optionalCall = String.raw`(?:\?\.${trivia})?`;
// The `.resolve` member of a loader or a factory call, `?.resolve` included.
const resolveMember = String.raw`\s*\??\.\s*resolve`;

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
/** The code of one `${…}` substitution: anything but a brace or a backtick, braces two deep, one flat template. */
const substitutionBody = String.raw`(?:[^{}\x60]|${substitutionBraces}|${flatTemplate})*`;
const templateLiteral = String.raw`\x60(?:[^\x60\\$]|\\[\s\S]|\$(?!\{)|\$\{${substitutionBody}\})*\x60`;
// A `/` where an operand is expected starts a regular-expression literal, never a division. After `++` or `--` it is
// the division the operator's operand takes part in (`count++ / require("x")`). The `/` is matched before the
// lookbehind that reads what precedes it: an alternative that opens with a literal character lets the engine
// dispatch on that character, one that opens with a lookbehind runs the lookbehind at every position.
const regexLiteral = String.raw`/(?<=(?:^|[\n(,=:[!&|?{};+\-*%<>~^])\s*(?<!\+\+\s*|--\s*)/|\b(?:return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw)\s+/)(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+/[a-zA-Z]*`;
const skippedToken = `(?<skipped>${blockComment}|${lineComment}|${doubleQuoted}|${singleQuoted}|${templateLiteral}|${regexLiteral})`;
/** The tokens alone, for blanking them out of a source before its binding names are read. */
const skippedTokens = new RegExp(skippedToken, 'gu');
/**
 * The substitutions of a recognised template literal, each body captured; a
 * backslash escapes the character after it, so `\${` is text. The body grammar
 * is `templateLiteral`'s own, and reads the same text the same way.
 */
const templateSubstitution = new RegExp(String.raw`\\[\s\S]|\$\{(?<substitution>${substitutionBody})\}`, 'gu');

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

const factoryNames = (code: string): readonly string[] => [...new Set([
  'createRequire',
  ...Array.from(code.matchAll(createRequireAlias), (match) => escapeIdentifier(match[1] ?? '')),
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
 * `require` from then on. The factory call must end the initializer: with a
 * call, a member, an index, or `?.` after it — `const pad =
 * createRequire(u)("left-pad")`, `const where = createRequire(u).resolve(…)` —
 * the binding holds a module or a path, not a loader, and the load is the
 * factory call itself, reported where it stands.
 */
const loaderBinding = (factories: readonly string[]): RegExp => new RegExp(
  String.raw`\b(?:const|let|var)\s+(${identifier})\s*=\s*${factoryQualifier}(?<![\w$#])(?:${factories.join('|')})\s*${callArguments}(?!\s*[(.[?])`,
  'gu',
);

/**
 * The identifiers a file loads packages through: `require` itself plus every
 * name bound to a `createRequire(…)` result — under the factory's own name or
 * an alias — so `const load = createRequire(import.meta.url); load("driver")`
 * counts like `require("driver")`.
 */
const loaderNames = (code: string, factories: readonly string[]): readonly string[] => [...new Set([
  'require',
  ...Array.from(code.matchAll(loaderBinding(factories)), (match) => escapeIdentifier(match[1] ?? '')),
])];

interface BindingNames {
  readonly factories: readonly string[];
  readonly loaders: readonly string[];
}

/**
 * The factory and loader names of a source, read from its code alone: every
 * token the scan steps over becomes one space first, so a `const load =
 * createRequire(…)` in a comment or a string binds nothing, while
 * `require("node:module").createRequire(…)` still reads as the qualified
 * factory it is. Without the text `createRequire` anywhere there is no alias
 * and no bound loader, and the token pass is spared.
 */
const bindingNames = (source: string): BindingNames => {
  if (!source.includes('createRequire')) return { factories: ['createRequire'], loaders: ['require'] };
  const code = source.replace(skippedTokens, ' ');
  const factories = factoryNames(code);
  return { factories, loaders: loaderNames(code, factories) };
};

/*
 * The positions that bind a loader name rather than pass it on. Each is read
 * from the name outwards, over the rest of its enclosing list: `parameterList`
 * to the `)` — past calls nested two deep, never past `;` — and then `=>` or
 * `{`, which makes the list a parameter list, a `catch` clause, or an `if`,
 * `while`, or `switch` head; `patternTail` to the `}` or `]` of a pattern —
 * past one nested pattern, one inner close — and then `=` (not `==`, `=>`),
 * a destructuring assignment, or `from`, an import or re-export specifier
 * list; `declaredPattern`, read backwards, to the `{` or `[` a `const`, `let`,
 * or `var` opens, past one inner open; `declaratorList`, read backwards, to
 * the `,` of a declaration whose earlier declarators sit on the same
 * statement (`let a, require;`).
 */
const parameterList = String.raw`(?:[^();]|${nestedArguments})*[)]\s*(?:=>|\{)`;
const patternContent = String.raw`(?:[^{}[\]();]|\{[^{}[\]();]*\}|\[[^{}[\]();]*\])*`;
const patternTail = String.raw`${patternContent}(?:[}\]]${patternContent})?[}\]]\s*(?:=(?![=>])|from\b)`;
const declaredPattern = String.raw`\b(?:const|let|var)\s*[{[]${patternContent}(?:[{[]${patternContent})?`;
const declaratorList = String.raw`\b(?:const|let|var)\s+[^;{}()[\]]*,\s*`;

/**
 * One pass over a source: the tokens the scan steps over, then the calls and
 * loader references it reports, each alternative anchored so that it matches
 * where JavaScript would read a call or a value and nowhere else.
 */
const loadScanner = (loaders: readonly string[], factories: readonly string[]): RegExp => {
  // A loader name whole: not after `.` (a member, `host.require`), `#` (a private name), or an identifier character
  // (`__webpack_require__`), and not before one (`require_fast_uri`). A factory may follow `.`: that is the qualified
  // form, `Module.createRequire(…)` or `require("node:module").createRequire(…)`, whose qualifier needs no matching.
  const loaderCall = String.raw`(?<![\w$.#])(?<loader>${loaders.join('|')})(?![\w$])(?<loaderResolve>${resolveMember})?`;
  const metaCall = String.raw`(?<![\w$.#])(?<meta>import\s*\.\s*meta${resolveMember})`;
  const factoryCall = String.raw`(?<![\w$#])(?<factory>${factories.join('|')})(?![\w$])${trivia}${optionalCall}${callArguments}(?<factoryResolve>${resolveMember})?`;
  const call = String.raw`(?:${loaderCall}|${metaCall}|${factoryCall})${trivia}${optionalCall}[(]${trivia}`;
  const literal = String.raw`${quotedLiteral}${trivia}(?:,${trivia})?[)]`;
  // Anything but a lone literal: a template literal whole (its substitutions are code, read like any template's),
  // an identifier, an operator after a literal (`"driver/" + v`). A comment is trivia the call prefix already
  // consumed, not the start of a computed argument.
  const computed = String.raw`(?<computed>${templateLiteral}|(?!/[*/])[^"'\s)]|"[^"\n]*"${trivia}(?!/[*/])[^)\s]|'[^'\n]*'${trivia}(?!/[*/])[^)\s])`;
  // `require(id) {` is a method or function named `require` being defined, not a call: the lookahead sees the block
  // after a balanced argument list. An argument list nesting deeper than `argumentsRest` reads is a computed call.
  const notDefinition = String.raw`(?!${argumentsRest}\s*\{)`;
  // A loader passed on as a value: after `=`, `(`, `,`, `[`, `{`, `:`, `?`, `|`, `&`, `=>`, or `return`, and before
  // `;`, `,`, `)`, `]`, `}`, or a line end (`fn(require)`, `{ key: require }`, `x ? y : require`, `return load`); or
  // the consequent of a ternary (`x ? require : y`). A `:` after the name makes it an object key (`{ require: x }`),
  // not the loader, unless a `?` precedes it. A binding position — a parameter, a declared or assigned pattern, a
  // later declarator, an import specifier — is excluded by the list it sits in. The name is matched first, whole,
  // and every lookbehind reads back over it: as with `regexLiteral`, the engine then dispatches on the name's first
  // character, and the list walks run only where a loader name stands after an operator — a walk at every position
  // after an operator is quadratic in a stretch of source without brackets.
  const names = loaders.join('|');
  const value = String.raw`(?<![\w$.#])(?<reference>${names})(?![\w$])(?<=(?:=>|\breturn|[=(,[{:?|&])\s*(?:${names}))(?=\s*(?:[;,)\]}]|\n|$))(?<!(?:${declaredPattern}|${declaratorList})(?:${names}))(?!${parameterList})(?!${patternTail})`;
  const consequent = String.raw`(?<![\w$.#])(?<ternary>${names})(?![\w$])(?=\s*:)(?<=\?\s*(?:${names}))`;
  return new RegExp(`${skippedToken}|${call}(?:${literal}|${notDefinition}${computed})|${value}|${consequent}`, 'gu');
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

const backtick = '\x60';
/** Whether a template literal token has substitutions to scan: one with none is text throughout. */
const hasSubstitution = (template: string): boolean => template.startsWith(backtick) && template.includes('${');

/**
 * The loads and loader references of one stretch of code, appended in source
 * order. A template literal token — stepped over or a computed argument — has
 * each substitution body scanned as code in turn, by the same scanner, where
 * the template appears.
 */
const scanCode = (code: string, scanner: RegExp, loads: ModuleLoad[]): void => {
  for (const match of code.matchAll(scanner)) {
    const groups: ScanGroups = match.groups ?? {};
    if (groups.skipped !== undefined) {
      if (hasSubstitution(groups.skipped)) scanTemplate(groups.skipped, scanner, loads);
      continue;
    }
    const referenced = groups.reference ?? groups.ternary;
    if (referenced !== undefined) {
      loads.push(Object.freeze({ form: referenced === 'require' ? 'require' : 'bound-loader', kind: 'reference', loader: referenced }));
      continue;
    }
    const site: ModuleLoadSite = { form: loadForm(groups), loader: groups.loader ?? groups.factory ?? 'import.meta' };
    if (groups.computed === undefined) {
      loads.push(Object.freeze({ ...site, kind: 'literal', specifier: decodeLiteral(groups.body ?? '') }));
      continue;
    }
    loads.push(Object.freeze({ ...site, kind: 'computed' }));
    // A template argument matched whole; a lone backtick is one the template grammar did not recognise.
    if (groups.computed.length > 1 && hasSubstitution(groups.computed)) scanTemplate(groups.computed, scanner, loads);
  }
};

const scanTemplate = (template: string, scanner: RegExp, loads: ModuleLoad[]): void => {
  for (const match of template.matchAll(templateSubstitution)) {
    const body = match.groups?.substitution;
    if (body !== undefined) scanCode(body, scanner, loads);
  }
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
  const { factories, loaders } = bindingNames(source);
  const loads: ModuleLoad[] = [];
  scanCode(source, loadScanner(loaders, factories), loads);
  const frozen = Object.freeze(loads);
  if (sha256 !== undefined) loadsByDigest.set(sha256, frozen);
  return frozen;
};
