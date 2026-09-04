import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { posix, relative, resolve } from 'node:path';

import npa from 'npm-package-arg';

import { sha256Hex } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';
import { readModuleImports, type ModuleImport } from './module-imports.ts';

/**
 * Evidence for the npm prepack dependency gate (`AB7014`/`AB7015`, emitted by
 * `pack-inventory.ts`): what `package.json` asks npm to install alongside the
 * package, and which packages the packed JavaScript and declaration files
 * actually reference.
 */

/**
 * The `package.json` fields npm installs alongside the published package.
 * `peerDependencies` counts because npm 7+ installs peers automatically;
 * `devDependencies` never reach a consumer and are not inspected.
 */
export const installedDependencyFields = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const);

export type InstalledDependencyField = (typeof installedDependencyFields)[number];

export interface DeclaredDependency {
  readonly field: InstalledDependencyField;
  readonly name: string;
  readonly specifier: string;
  /** Embedded in the tarball by npm (`bundleDependencies`), so a consumer never fetches its specifier. */
  readonly bundled: boolean;
  /**
   * Fetched for a consumer. `false` for a peer `peerDependenciesMeta` marks
   * optional: npm parses its specifier — an unsupported protocol still fails
   * the install — but never installs it, so no packed file has to use it.
   */
  readonly installed: boolean;
}

/** Peers `peerDependenciesMeta` marks optional: npm parses but never installs them. */
const optionalPeers = (packageDocument: Readonly<Record<string, unknown>>): ReadonlySet<string> => {
  const meta = packageDocument.peerDependenciesMeta;
  return new Set(isRecord(meta)
    ? Object.entries(meta).filter(([, entry]) => isRecord(entry) && entry.optional === true).map(([name]) => name)
    : []);
};

/**
 * Which dependencies npm embeds under `node_modules` in the published tarball:
 * `bundleDependencies` (or the `bundledDependencies` spelling) as a name list,
 * or `true` for every entry of `dependencies`. Peers are never bundled, whatever
 * the list says: npm packs no `node_modules` entry for a peer-only name, so a
 * consumer still resolves the peer's own specifier.
 */
const bundledDependencies = (
  packageDocument: Readonly<Record<string, unknown>>,
): ((field: InstalledDependencyField, name: string) => boolean) => {
  const value = packageDocument.bundleDependencies ?? packageDocument.bundledDependencies;
  const names = new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return (field, name) => field !== 'peerDependencies' && (value === true ? field === 'dependencies' : names.has(name));
};

/**
 * The entries a consumer's npm reads, one per name and field. A name in both
 * `dependencies` and `optionalDependencies` is the optional entry (npm lets
 * the optional declaration override); an optional peer is kept, not
 * `installed`.
 */
export const declaredDependencies = (packageDocument: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] => {
  const skippedPeers = optionalPeers(packageDocument);
  const bundled = bundledDependencies(packageDocument);
  const entries = (field: InstalledDependencyField): readonly (readonly [string, string])[] => {
    const value = packageDocument[field];
    return isRecord(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : [];
  };
  const optional = new Set(entries('optionalDependencies').map(([name]) => name));
  return installedDependencyFields.flatMap((field) => entries(field)
    .filter(([name]) => !(field === 'dependencies' && optional.has(name)))
    .map(([name, specifier]) => ({
      field,
      name,
      specifier,
      bundled: bundled(field, name),
      installed: !(field === 'peerDependencies' && skippedPeers.has(name)),
    })));
};

/** Relative, package-imports (`#`), absolute, and URL-scheme specifiers (`node:`, `data:`, `file:`, `C:\`) name no package. */
const nonPackageSpecifier = /^(?:[.#/]|[a-z][a-z0-9+.-]*:)/iu;
/** `@scope/name` or `name`; a subpath after it is dropped. */
const packageNamePrefix = /^(?:@[^/]+\/)?[^@/][^/]*/u;

/** The package name an import specifier resolves through, or `undefined` for anything that is not a bare specifier. */
export const packageNameOf = (specifier: string): string | undefined =>
  nonPackageSpecifier.test(specifier) || isBuiltin(specifier) ? undefined : packageNamePrefix.exec(specifier)?.[0];

/**
 * Protocols only a workspace manager understands. pnpm, Yarn, and Bun
 * rewrite them to registry versions while packing; npm publishes them
 * verbatim and every consumer then fails with `EUNSUPPORTEDPROTOCOL`.
 */
const workspaceProtocol = /^(?:workspace|catalog):/u;

/** Exact-prefix, as the packers test it: `" workspace:*"` is rewritten by none of them and published verbatim. */
export const isWorkspaceProtocol = (specifier: string): boolean => workspaceProtocol.test(specifier);

/**
 * Whether the package manager running this pack (its `npm_config_user_agent`,
 * e.g. `pnpm/10.0.0 npm/? node/v24.0.0 linux x64`) rewrites workspace
 * protocols. Unknown or absent — `agent-bundle prepack` run outside any
 * lifecycle — means no, so the gate stays strict.
 */
export const rewritesWorkspaceProtocols = (packerUserAgent: string | undefined): boolean =>
  /^(?:pnpm|yarn|bun)\//u.test(packerUserAgent ?? '');

/**
 * How a consumer's npm reads one dependency entry, name and specifier
 * together:
 *
 * - `registry`: a version, range, dist-tag, or `npm:` alias of one — resolved
 *   through the registry, the only kind a published package can rely on.
 * - `fetched`: parseable, but a git, remote-tarball, or path source. npm 12
 *   refuses the first two by default (`allow-git=none`, `allow-remote=none`)
 *   and a path never exists on the consumer's disk; an optional entry
 *   survives the failed fetch, any other kind fails the install.
 * - `unparseable`: npm rejects the manifest before fetching anything —
 *   `EINVALIDPACKAGENAME`, `EUNSUPPORTEDPROTOCOL` (`workspace:`, `catalog:`,
 *   `link:`, a typo), `EINVALIDTAGNAME`, an alias of a non-registry target,
 *   or an invalid URL — whichever field declares it, even a peer it would
 *   never install.
 *
 * The verdict is npm's own: `npm-package-arg` is the parser npm, Arborist,
 * and pacote share, so the gate agrees with the consumer's install by
 * construction rather than by imitating its grammar. Whether the packer
 * rewrites a workspace protocol first is the caller's policy
 * (`isWorkspaceProtocol`).
 */
export type DependencyKind = 'registry' | 'fetched' | 'unparseable';

/**
 * Where the package would be installed from, for path specifiers: a directory
 * deep enough that `file:../sibling` stays distinguishable from a path inside
 * the package. Nothing touches the disk.
 */
const packageAnchor = '/package/root';

export const classifyDependency = (name: string, specifier: string): DependencyKind => {
  try {
    // The manifest value exactly as npm reads it: `" npm:bar@1"` is an invalid dist-tag, not an alias.
    return npa.resolve(name, specifier, packageAnchor).registry === true ? 'registry' : 'fetched';
  } catch {
    return 'unparseable';
  }
};

/**
 * The tarball-relative path a `file:` or bare path specifier reads from, when
 * it stays inside the package: `vendor/foo` for `file:vendor/foo`,
 * `vendor/foo.tgz` for `file:vendor/foo.tgz`. npm installs such a dependency
 * from the consumer's own `node_modules/<package>` copy, so shipping the
 * source in the tarball makes it installable without a registry. `undefined`
 * for anything else, including a path that escapes the package
 * (`file:../sibling`), which no consumer has.
 */
export const packagedSourcePath = (name: string, specifier: string): string | undefined => {
  try {
    const parsed = npa.resolve(name, specifier, packageAnchor);
    if ((parsed.type !== 'directory' && parsed.type !== 'file') || typeof parsed.fetchSpec !== 'string') return undefined;
    const path = relative(packageAnchor, parsed.fetchSpec).split('\\').join('/');
    return path === '' || path.startsWith('../') || path.startsWith('/') ? undefined : path;
  } catch {
    return undefined;
  }
};

/** A single- or double-quoted string literal; the group after the opening quote is its body. */
const quotedLiteral = String.raw`(["'])((?:(?!\1)[^\\\n]|\\.)+)\1`;

const escapeSequence = /\\(?:x(?<hex>[0-9A-Fa-f]{2})|u\{(?<point>[0-9A-Fa-f]+)\}|u(?<unit>[0-9A-Fa-f]{4})|(?<other>.))/gsu;
const controlEscapes: Readonly<Record<string, string>> = { 0: '\0', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/**
 * The string a JavaScript literal's body denotes: `\x66oo` is `foo`,
 * `foo\u002fsubpath` is `foo/subpath`, `\/` is `/`. Node resolves the value,
 * not the source text, so a package name compared textually has to be
 * decoded first.
 */
const decodeLiteral = (body: string): string => body.replace(escapeSequence, (...args) => {
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

/**
 * A `require("…")` call, or a resolution-only use — `require.resolve("…")`,
 * `createRequire(…).resolve("…")`, `import.meta.resolve("…")` — with a
 * literal argument. The ESM lexer reports `import` forms only; CommonJS
 * payloads a consumer prebuilt reach the package through `require`, and a
 * package located only to find an asset or executable is still a runtime
 * dependency. Only these resolvers count: `path.resolve("foo")` or
 * `Promise.resolve("foo")` never make an unused `foo` look reachable. A match
 * inside a comment or string can only mark a dependency as imported, never as
 * unused, so the pattern otherwise errs toward keeping a declaration.
 */
/**
 * A parenthesised argument list with calls nested up to two deep —
 * `(new URL("./entry.js", import.meta.url))`, `(join(dirname(x), "y"))` — the
 * shapes a `createRequire` argument takes.
 */
const callArguments = (() => {
  const flat = String.raw`[(][^()]*[)]`;
  const nested = String.raw`[(](?:[^()]|${flat})*[)]`;
  return String.raw`[(](?:[^()]|${nested})*[)]`;
})();

/** The resolvers a file loads packages through, each followed by its argument list. */
const loadCall = (loaders: readonly string[], factories: readonly string[]): string =>
  String.raw`(?:\b(?:${loaders.join('|')})(?:\.resolve)?|\bimport\.meta\.resolve|\b(?:${factories.join('|')})\s*${callArguments}(?:\.resolve)?)\s*[(]\s*`;

const literalLoad = (loaders: readonly string[], factories: readonly string[]): RegExp => new RegExp(
  String.raw`${loadCall(loaders, factories)}${quotedLiteral}\s*[)]`,
  'gu',
);

/**
 * A CommonJS load or resolution whose argument is not a string literal —
 * `require(x)`, `require.resolve(x)`, `import.meta.resolve(x)`, or a direct
 * `createRequire(…)(x)` — selecting a package at runtime, which no literal can
 * prove. An argument that merely starts with a literal, `require("driver/" +
 * variant)`, is computed too. Bundler runtimes (`__webpack_require__(…)`) have
 * no word boundary before `require` and never match; `path.resolve(x)` and
 * `Promise.resolve(x)` are not resolution and never match.
 */
const computedLoad = (loaders: readonly string[], factories: readonly string[]): RegExp => new RegExp(
  String.raw`${loadCall(loaders, factories)}(?:[^"'\s)]|"[^"\n]*"\s*[^)\s]|'[^'\n]*'\s*[^)\s])`,
  'u',
);

const escapeIdentifier = (name: string): string => name.replace(/\$/gu, String.raw`\$`);

/**
 * `createRequire` renamed on import or destructuring: `import { createRequire
 * as makeRequire } from "node:module"` or `const { createRequire: makeRequire }
 * = require("node:module")`. Each alias is a factory like `createRequire` itself.
 */
const createRequireAlias = /\bcreateRequire\s*(?:as|:)\s*([A-Za-z_$][\w$]*)/gu;

const factoryNames = (source: string): readonly string[] => [
  'createRequire',
  ...Array.from(source.matchAll(createRequireAlias), (match) => escapeIdentifier(match[1] ?? '')),
];

/**
 * `const load = <factory>(…)`, the factory bare, namespace-qualified
 * (`Module.createRequire(…)` after `import * as Module from "node:module"`),
 * or chained off a CommonJS load (`require("node:module").createRequire(…)`):
 * the binding is a loader, called like `require` from then on.
 */
const loaderBinding = (factories: readonly string[]): RegExp => new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:[A-Za-z_$][\w$]*|\brequire\s*${callArguments})\s*\.\s*)?(?:${factories.join('|')})\s*[(]`,
  'gu',
);

/**
 * The identifiers a file loads packages through: `require` itself plus every
 * name bound to a `createRequire(…)` result — under the factory's own name or
 * an alias — so `const load = createRequire(import.meta.url); load("driver")`
 * counts like `require("driver")`.
 */
const loaderNames = (source: string): readonly string[] => [
  'require',
  ...Array.from(source.matchAll(loaderBinding(factoryNames(source))), (match) => escapeIdentifier(match[1] ?? '')),
];

/**
 * Every module specifier a declaration file resolves: `from "…"`,
 * `import("…")`, `import x = require("…")`, `declare module "…"` (an
 * augmentation of that package's types, in an external-module declaration),
 * and `/// <reference types="…" />`.
 * A consumer needs the package that provides these types even though the
 * bundled JavaScript has no runtime import. Declarations are not ES modules
 * the lexer accepts, so this is a text scan with the same keep-only bias.
 */
const declarationSpecifier = new RegExp(
  String.raw`\b(?:from|import|require|declare\s+module)\s*\(?\s*${quotedLiteral}|<reference\s+types\s*=\s*(["'])([^"'\n]+)\3`,
  'gu',
);

/**
 * The package a `/// <reference types="name" />` directive resolves through:
 * `name` itself when it ships declarations, or its DefinitelyTyped package
 * (`@types/name`; `@types/scope__name` for a scoped name). Both are reported,
 * since the declaration cannot say which one the consumer needs.
 */
const typeDirectivePackages = (name: string): readonly string[] => [
  name,
  name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`,
];

/** The literal module specifiers a declaration file resolves, in order of appearance. */
export const declarationSpecifiers = (source: string): readonly string[] =>
  Array.from(source.matchAll(declarationSpecifier)).flatMap((match) =>
    (match[4] === undefined ? [decodeLiteral(match[2] ?? '')] : typeDirectivePackages(match[4])));

/** The `bin` commands of each declared dependency, by package name. */
type ExecutableCommands = ReadonlyMap<string, DependencyExecutables>;

interface DependencyExecutables {
  /** The commands the dependency's own manifest declares; empty when it declares none. */
  readonly commands: readonly string[];
  /**
   * Whether `commands` was read from the manifest rather than guessed. With no
   * manifest under `node_modules` (Plug'n'Play, a platform-specific optional
   * dependency not installed here) the unscoped package name stands in — npm's
   * default bin name — which is evidence enough in a shell script but too
   * loose for JavaScript, where the bare name is also how the package is
   * mentioned in a comment or docblock.
   */
  readonly known: boolean;
}

/** What one packed file proves about the packages it resolves. */
interface FileEvidence {
  readonly specifiers: readonly string[];
  /** Dependencies the file runs as executables rather than loading as modules. */
  readonly executed: readonly string[];
  /** `false` when a computed `import(expression)` means the file may load a package no literal names. */
  readonly complete: boolean;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * A string literal that is a shell command running `command`: the bare name
 * (`spawnSync("foo", ["--version"])`) or the name followed by its arguments
 * (`execSync("foo --version")`). A dependency a CLI package only ever shells
 * out to is still one the consumer needs installed; the match is keep-only,
 * so a name inside a comment or an unrelated string merely keeps a declaration.
 */
const commandLiteral = (command: string): RegExp =>
  new RegExp(String.raw`(["'\x60])${escapeRegExp(command)}(?:\s[^"'\x60\n]*)?\1`, 'u');

/**
 * The module specifiers packed JavaScript resolves: the lexer's static and
 * dynamic literal imports — never a mention inside a comment or string,
 * which bundled library docblocks are full of — plus literal `require` calls;
 * and the dependencies it runs by one of their `bin` commands.
 */
const javaScriptEvidence = async (bytes: Buffer, executables: ExecutableCommands): Promise<FileEvidence> => {
  const source = bytes.toString('utf8');
  let imports: readonly ModuleImport[];
  try {
    imports = await readModuleImports(source, { check: 'lexed', sha256: sha256Hex(bytes) });
  } catch {
    // Syntax is another gate's concern; skipping can only keep a declaration.
    imports = [];
  }
  const loaders = loaderNames(source);
  const factories = factoryNames(source);
  return {
    complete: imports.every((record) => record.kind !== 'dynamic' || record.specifier !== undefined)
      && !computedLoad(loaders, factories).test(source),
    executed: [...executables]
      .filter(([, { commands, known }]) => known && commands.some((command) => commandLiteral(command).test(source)))
      .map(([name]) => name),
    specifiers: [
      ...imports.flatMap((record) => (record.specifier === undefined ? [] : [record.specifier])),
      ...Array.from(source.matchAll(literalLoad(loaders, factories)), (match) => decodeLiteral(match[2] ?? '')),
    ],
  };
};

const javaScriptSuffix = /\.[cm]?js$/u;
const declarationSuffix = /\.d\.[cm]?ts$/u;

const fileEvidence = async (path: string, executables: ExecutableCommands): Promise<FileEvidence> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    // npm listed the file; only its absence is a benign inconsistency.
    if (isErrno(error, 'ENOENT')) return { complete: true, executed: [], specifiers: [] };
    throw error;
  }
  return declarationSuffix.test(path)
    ? { complete: true, executed: [], specifiers: declarationSpecifiers(bytes.toString('utf8')) }
    : javaScriptEvidence(bytes, executables);
};

export interface ImportedPackages {
  /** Every package name the packed files name literally, run as an executable, or need during a consumer's install. */
  readonly names: ReadonlySet<string>;
  /**
   * The subset a consumer's install lifecycle needs: run as a command by a
   * script, or loaded by a packed file the script runs. An optional dependency
   * npm skipped after a failed fetch is then missing from `PATH` or
   * `node_modules`, so the install fails after all.
   */
  readonly installScripts: ReadonlySet<string>;
  /**
   * Whether `names` is the whole story. A computed `import(expression)` or
   * `require(expression)` in packed JavaScript may load any declared package,
   * so no declaration can then be called unused.
   */
  readonly complete: boolean;
}

/** Every string target in a `package.json` `imports` map, through conditional and nested targets. */
const importMapTargets = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(importMapTargets);
  return isRecord(value) ? Object.values(value).flatMap(importMapTargets) : [];
};

/**
 * The packages a `#subpath` import may reach: Node resolves `#name` through
 * the manifest's `imports` map, whose targets may be external packages.
 * Which target a given `#name` picks depends on conditions, so a packed
 * `#` import counts for every package the map names.
 */
const packageImportTargets = (packageDocument: Readonly<Record<string, unknown>>): readonly string[] =>
  importMapTargets(packageDocument.imports);

/**
 * The lifecycle scripts npm runs when installing a package from a registry
 * or tarball. `prepare` is not one: npm runs it on `pack`, on local and
 * `link:` installs, and for git dependencies — never for the published
 * tarball — so a package it alone names is one every consumer installs for
 * nothing.
 */
const installScripts = ['preinstall', 'install', 'postinstall'] as const;

/**
 * One shell command invoking `npm run` (also `pnpm`/`yarn`/`bun`, and npm's
 * aliases `run-script`, `rum`, `urn`): the tool, any options before the
 * subcommand — valueless (`--silent`), valued (`--prefix .`,
 * `--workspace=pkg`) — then the rest of the command up to the next shell
 * operator. Which of those tokens is the script is settled against the
 * manifest's `scripts` rather than by option grammar, since every token that
 * names a script is one the command may run.
 */
const runSubcommand = String.raw`(?:run(?:-script)?|rum|urn)\b`;
const shellQuotes = /^(["'])(.*)\1$/u;
const delegatedRun = new RegExp(
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:(?!${runSubcommand})[^\s&|;]+\s+)*${runSubcommand}([^&|;\n]*)`,
  'gu',
);

/**
 * The text a consumer's install lifecycle executes: the lifecycle scripts,
 * plus every script they reach through `npm run <name>` (with its `pre<name>`
 * and `post<name>` hooks), transitively. Dependency executables are on `PATH`
 * for all of them.
 */
const installScriptText = (scripts: Readonly<Record<string, unknown>>): string => {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    const body = scripts[name];
    if (seen.has(name) || typeof body !== 'string') return;
    seen.add(name);
    for (const match of body.matchAll(delegatedRun)) {
      for (const token of (match[1] ?? '').trim().split(/\s+/u)) {
        // The shell strips the quotes of `npm run "setup"` before npm sees the name.
        const candidate = token.replace(shellQuotes, '$2');
        if (candidate === '' || candidate.startsWith('-') || !Object.hasOwn(scripts, candidate)) continue;
        for (const hook of [`pre${candidate}`, candidate, `post${candidate}`]) visit(hook);
      }
    }
  };
  for (const script of installScripts) visit(script);
  return [...seen].map((name) => scripts[name] as string).join('\n');
};

const unscopedName = (name: string): string => name.replace(/^@[^/]+\//u, '');

/**
 * The executables a dependency puts on `PATH`, from its own manifest under
 * `node_modules`. A string-form `bin` is one command named after the installed
 * manifest's unscoped `name` — `real` for an alias `"wrapper":
 * "npm:@scope/real@1"`, not `wrapper`. When the manifest is unreadable the
 * dependency's unscoped name stands in, marked as a guess.
 */
const executableCommands = async (names: readonly string[], projectRoot: string): Promise<ExecutableCommands> => {
  const binCommands = async (name: string): Promise<DependencyExecutables> => {
    const manifest = await readFile(resolve(projectRoot, 'node_modules', name, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest === undefined) return { commands: [unscopedName(name)], known: false };
    const parsed: unknown = JSON.parse(manifest);
    const bin = isRecord(parsed) ? parsed.bin : undefined;
    if (isRecord(bin)) return { commands: Object.keys(bin), known: true };
    if (typeof bin !== 'string') return { commands: [], known: true };
    return { commands: [unscopedName(isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : name)], known: true };
  };
  return new Map(await Promise.all(names.map(async (name) => [name, await binCommands(name)] as const)));
};

/**
 * Dependencies a consumer's install lifecycle uses: npm puts every
 * dependency's executables on `PATH` for `preinstall`/`install`/`postinstall`,
 * so a script that names a dependency, or one of its `bin` commands, needs it
 * installed even though no packed JavaScript imports it.
 */
const installScriptDependencies = (text: string, executables: ExecutableCommands): readonly string[] => {
  if (text === '') return [];
  const runs = (command: string): boolean => new RegExp(String.raw`(?<![\w-])${escapeRegExp(command)}(?![\w-])`, 'u').test(text);
  return [...executables]
    .filter(([name, { commands }]) => text.includes(name) || commands.some(runs))
    .map(([name]) => name);
};

/** The packed JavaScript files an install script runs: `node install.cjs`, `node ./scripts/setup.mjs`. */
const installScriptFiles = (text: string, packed: ReadonlySet<string>): readonly string[] =>
  text.split(/\s+/u)
    .map((token) => token.replace(shellQuotes, '$2').replace(/^\.\//u, ''))
    .filter((token) => javaScriptSuffix.test(token) && packed.has(token));

const relativeSpecifier = /^\.\.?\//u;

/**
 * The packed module a relative specifier resolves to, exact or with the
 * extension or `index` file Node's CommonJS loader would try.
 */
const relativeTarget = (from: string, specifier: string, packed: ReadonlySet<string>): string | undefined => {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`, `${base}/index.cjs`, `${base}/index.mjs`]
    .find((candidate) => packed.has(candidate));
};

/**
 * The packages a consumer's install lifecycle loads through the packed
 * JavaScript it runs — `"postinstall": "node install.cjs"` with `install.cjs`
 * requiring a driver — following relative imports through the tarball. A
 * computed load in any of those files could reach any declared package, so
 * every declared name then counts as needed at install time.
 */
const installScriptModuleDependencies = (
  roots: readonly string[],
  evidenceByPath: ReadonlyMap<string, FileEvidence>,
  packageDocument: Readonly<Record<string, unknown>>,
  declared: readonly string[],
): readonly string[] => {
  const packed = new Set(evidenceByPath.keys());
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue = [...roots];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const evidence = evidenceByPath.get(path);
    if (seen.has(path) || evidence === undefined) continue;
    seen.add(path);
    if (!evidence.complete) for (const name of declared) names.add(name);
    for (const name of evidence.executed) names.add(name);
    for (const specifier of evidence.specifiers) {
      if (relativeSpecifier.test(specifier)) {
        const target = relativeTarget(path, specifier, packed);
        if (target !== undefined) queue.push(target);
        continue;
      }
      const targets = specifier.startsWith('#') ? packageImportTargets(packageDocument) : [specifier];
      for (const target of targets) {
        const name = packageNameOf(target);
        if (name !== undefined) names.add(name);
      }
    }
  }
  return [...names];
};

/**
 * Every package name the packed JavaScript imports, requires, resolves, or
 * runs as an executable, the packed declarations reference, a packed `#`
 * import may reach through the manifest's `imports` map, or a consumer's
 * install script runs or loads — read from the bytes npm would publish.
 */
export const importedPackageNames = async (options: {
  /** Names to test for executable and install-script use; every other source is scanned whole. */
  readonly declared: readonly string[];
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly paths: readonly string[];
  readonly projectRoot: string;
}): Promise<ImportedPackages> => {
  const projectRoot = resolve(options.projectRoot);
  const executables = await executableCommands(options.declared, projectRoot);
  const evidenceByPath = new Map(await Promise.all(options.paths
    .filter((path) => javaScriptSuffix.test(path) || declarationSuffix.test(path))
    .map(async (path) => [path, await fileEvidence(resolve(projectRoot, path), executables)] as const)));
  const evidence = [...evidenceByPath.values()];
  const scriptText = installScriptText(isRecord(options.packageDocument.scripts) ? options.packageDocument.scripts : {});
  const fromScripts = [
    ...installScriptDependencies(scriptText, executables),
    ...installScriptModuleDependencies(
      installScriptFiles(scriptText, new Set(evidenceByPath.keys())),
      evidenceByPath,
      options.packageDocument,
      options.declared,
    ),
  ];
  const specifiers = evidence.flatMap((file) => file.specifiers);
  const reachable = specifiers.some((specifier) => specifier.startsWith('#'))
    ? packageImportTargets(options.packageDocument)
    : [];
  return {
    complete: evidence.every((file) => file.complete),
    installScripts: new Set(fromScripts),
    names: new Set([
      ...[...specifiers, ...reachable].flatMap((specifier) => {
        const name = packageNameOf(specifier);
        return name === undefined ? [] : [name];
      }),
      ...evidence.flatMap((file) => file.executed),
      ...fromScripts,
    ]),
  };
};
