import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { posix, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

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
 * the optional declaration override), and a peer that `dependencies` or
 * `optionalDependencies` also names is that concrete entry — npm resolves
 * the concrete declaration and never reads the duplicate peer's selector; an
 * optional peer is kept, not `installed`.
 */
export const declaredDependencies = (packageDocument: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] => {
  const skippedPeers = optionalPeers(packageDocument);
  const bundled = bundledDependencies(packageDocument);
  const entries = (field: InstalledDependencyField): readonly (readonly [string, string])[] => {
    const value = packageDocument[field];
    return isRecord(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : [];
  };
  const optional = new Set(entries('optionalDependencies').map(([name]) => name));
  const concrete = new Set([...entries('dependencies').map(([name]) => name), ...optional]);
  const shadowed = (field: InstalledDependencyField, name: string): boolean => {
    switch (field) {
      case 'dependencies': return optional.has(name);
      case 'peerDependencies': return concrete.has(name);
      case 'optionalDependencies': return false;
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  };
  return installedDependencyFields.flatMap((field) => entries(field)
    .filter(([name]) => !shadowed(field, name))
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

const nulTerminated = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8');
};

const octalField = (bytes: Uint8Array): number | undefined => {
  const text = nulTerminated(bytes).trim();
  return /^[0-7]*$/u.test(text) ? Number.parseInt(text || '0', 8) : undefined;
};

/** Whether a 512-byte ustar header's stored checksum matches its bytes (the checksum field itself read as spaces). */
const headerChecksumValid = (header: Buffer): boolean => {
  const stored = octalField(header.subarray(148, 156));
  if (stored === undefined) return false;
  let sum = 0;
  for (const [index, byte] of header.entries()) sum += index >= 148 && index < 156 ? 0x20 : byte;
  return sum === stored;
};

/**
 * Whether a tar archive holds a package npm can install: an entry
 * `<dir>/package.json` one level down (the layout npm strips one component
 * from on install) whose payload parses to a JSON object. Headers are the
 * 512-byte ustar records, each with a valid checksum and a payload within the
 * archive; an all-zero record ends the archive. A malformed or truncated
 * archive (`TAR_BAD_ARCHIVE`) or a manifest that does not parse (`EJSONPARSE`)
 * fails the consumer's install, so neither counts.
 */
const tarHoldsPackage = (archive: Buffer): boolean => {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return false;
    const size = octalField(header.subarray(124, 136));
    if (size === undefined || !headerChecksumValid(header) || offset + 512 + size > archive.length) return false;
    const name = nulTerminated(header.subarray(0, 100));
    const prefix = nulTerminated(header.subarray(345, 500));
    if (/^[^/]+\/package\.json$/u.test(prefix === '' ? name : `${prefix}/${name}`)) {
      try {
        const parsed: unknown = JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString('utf8'));
        return isRecord(parsed);
      } catch {
        return false;
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return false;
};

/**
 * Whether the packed copy of a `file:` source is one npm can install from:
 * a directory whose packed `package.json` parses to an object, or a packed
 * tarball — gzipped or plain — holding a package. A path that merely exists
 * under the right name (`foo.tgz` that is not an archive) fails the consumer's
 * install with `TAR_BAD_ARCHIVE`, so it is not installable.
 */
export const packagedSourceInstallable = async (
  projectRoot: string,
  source: string,
  packed: ReadonlySet<string>,
): Promise<boolean> => {
  if (packed.has(`${source}/package.json`)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(resolve(projectRoot, source, 'package.json'), 'utf8'));
      return isRecord(parsed);
    } catch {
      return false;
    }
  }
  if (!packed.has(source)) return false;
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(projectRoot, source));
  } catch {
    return false;
  }
  let archive = bytes;
  try {
    archive = gunzipSync(bytes);
  } catch {
    // Not gzipped: a plain `.tar`, or not an archive at all — the header scan decides.
  }
  return tarHoldsPackage(archive);
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

// Whitespace and comments, the trivia JavaScript allows around a call's parentheses: `require /* x */ ("y")`.
const trivia = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;

/** The resolvers a file loads packages through, each followed by its argument list. */
const loadCall = (loaders: readonly string[], factories: readonly string[]): string =>
  String.raw`(?:\b(?:${loaders.join('|')})(?:\.resolve)?|\bimport\.meta\.resolve|\b(?:${factories.join('|')})${trivia}${callArguments}(?:\.resolve)?)${trivia}[(]${trivia}`;

const literalLoad = (loaders: readonly string[], factories: readonly string[]): RegExp => new RegExp(
  String.raw`${loadCall(loaders, factories)}${quotedLiteral}${trivia}[)]`,
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
  // A comment is trivia the call prefix already consumed, not the start of a computed argument.
  String.raw`${loadCall(loaders, factories)}(?:(?!/[*/])[^"'\s)]|"[^"\n]*"${trivia}(?!/[*/])[^)\s]|'[^'\n]*'${trivia}(?!/[*/])[^)\s])`,
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
 * JavaScript comments and string literals, each replaced by a space: the
 * text that is not code. Bundled docblocks are prose ("may fail, require
 * Effect services"), and a scan for a bare identifier has to skip them.
 * Regular-expression literals are not recognised; one containing a quote
 * can misalign the strings after it on the same line, which at worst hides
 * or invents a bare reference there.
 */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/gu, ' ');

/**
 * A loader passed on as a value rather than called — `const load = require`,
 * `fn(require)`, `[require]`, `{ require }`, `module.exports = require`,
 * `return require`, `x ? require : y` — after which packages may be loaded
 * under a name this scan never sees, so the file's evidence is incomplete
 * like a computed load's. A call (`require("x")`), a property access
 * (`require.resolve`), and `typeof require` pass nothing on and never match.
 * Run on `codeOnly` text, so a mention in a comment or string is not one.
 */
const loaderReference = (loaders: readonly string[]): RegExp => new RegExp(
  String.raw`(?:=>|\breturn|[=(,[{:?|&])\s*\b(?:${loaders.join('|')})\b\s*(?=[;,)\]}:]|$)`,
  'mu',
);

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
  /** `false` when a computed `import(expression)` or `require(expression)`, or a `require` passed on as a value, means the file may load a package no literal names. */
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
      && !computedLoad(loaders, factories).test(source)
      && !loaderReference(loaders).test(codeOnly(source)),
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
 * The targets the manifest's `imports` map gives one `#specifier`, resolved
 * the way Node does: the exact key, or else the pattern key `#prefix*suffix`
 * with the longest prefix (then the longest key) the specifier matches, its
 * `*` in every target replaced by the matched segment (`#setup/foo` through
 * `"#setup/*": "./scripts/*.js"` is `./scripts/foo.js`). Which conditional
 * target Node then picks depends on conditions, so every target of the
 * matched key is a candidate; a specifier no key matches reaches nothing.
 */
const packageImportTargets = (packageDocument: Readonly<Record<string, unknown>>, specifier: string): readonly string[] => {
  const imports = packageDocument.imports;
  if (!isRecord(imports)) return [];
  if (!specifier.includes('*') && Object.hasOwn(imports, specifier)) return importMapTargets(imports[specifier]);
  let best: { readonly key: string; readonly prefix: string; readonly suffix: string } | undefined;
  for (const key of Object.keys(imports)) {
    const star = key.indexOf('*');
    if (star === -1 || key.includes('*', star + 1)) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (specifier.length < key.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (best === undefined || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && key.length > best.key.length)) {
      best = { key, prefix, suffix };
    }
  }
  if (best === undefined) return [];
  const segment = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
  return importMapTargets(imports[best.key]).map((target) => target.replaceAll('*', segment));
};

/**
 * The lifecycle scripts npm runs when installing a package from a registry
 * or tarball. `prepare` is not one: npm runs it on `pack`, on local and
 * `link:` installs, and for git dependencies — never for the published
 * tarball — so a package it alone names is one every consumer installs for
 * nothing.
 */
const installScripts = ['preinstall', 'install', 'postinstall'] as const;

/**
 * The segments of one shell word: a double-quoted one, in which a backslash
 * escapes `"`, `\`, `$`, `` ` ``, and a newline and is literal before anything
 * else; a single-quoted one, in which nothing escapes; and an unquoted
 * backslash escape, `\x` being `x` and `\<newline>` a continuation. Unquoted
 * text between them stands as written.
 */
const shellSegment = /"((?:[^"\\\n]|\\[\s\S])*)"|'([^'\n]*)'|\\([\s\S])/gu;
const doubleQuotedEscape = /\\([\\"$`\n])/gu;

/** The text a shell word denotes: quotes removed and escapes resolved, segment by segment. */
const unquoteShellWord = (word: string): string => word.replace(
  shellSegment,
  (_segment, doubleQuoted: string | undefined, singleQuoted: string | undefined, escaped: string | undefined) => {
    if (doubleQuoted !== undefined) return doubleQuoted.replace(doubleQuotedEscape, (_escape, char: string) => (char === '\n' ? '' : char));
    if (singleQuoted !== undefined) return singleQuoted;
    return escaped === '\n' ? '' : escaped ?? '';
  },
);

/**
 * A shell command's words: quoted arguments kept whole and unquoted (`node
 * "scripts/my install.cjs"` is two words, `--import="./setup.mjs"` one),
 * backslash escapes resolved (`"require(\"driver\")"` is
 * `require("driver")`, `\"quoted\"` is `"quoted"`, `'lit\eral'` keeps its
 * backslash), and the operators `&&`, `||`, `;`, `|`, `&` split off even
 * without surrounding whitespace (`node install.js&&echo done` is four
 * words). A newline is an operator too: it ends a command as `;` does, and is
 * how `installScriptText` joins one script's body to the next.
 */
export const shellWords = (command: string): readonly string[] =>
  Array.from(
    command.matchAll(/(?:"(?:[^"\\\n]|\\[\s\S])*"|'[^'\n]*'|(?:[^\s"'&|;\\]|\\[\s\S])+)+|&&|\|\||[;|&\n]/gu),
    (match) => unquoteShellWord(match[0]),
  );

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
 * Dependencies a consumer's install lifecycle mentions: npm puts every
 * dependency's executables on `PATH` for `preinstall`/`install`/`postinstall`,
 * so a script that names a dependency, or one of its `bin` commands, anywhere
 * may need it installed even though no packed JavaScript imports it. Keep-only
 * evidence for `AB7014`: a mention in an argument or `echo` string cannot
 * report a dependency, but neither does it prove the script runs it.
 */
const installScriptMentions = (text: string, executables: ExecutableCommands): readonly string[] => {
  if (text === '') return [];
  const runs = (command: string): boolean => new RegExp(String.raw`(?<![\w-])${escapeRegExp(command)}(?![\w-])`, 'u').test(text);
  return [...executables]
    .filter(([name, { commands }]) => text.includes(name) || commands.some(runs))
    .map(([name]) => name);
};

const shellOperators = new Set(['&&', '||', ';', '|', '&', '\n']);
/** An environment assignment before the command proper (`FOO=1 node x`), also the form `cross-env` and `env` take: name, then value. */
const environmentAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u;
/** Words a shell command may start with before the command proper, besides environment assignments: options, and wrappers that exec their argument. */
const commandPrefix = /^(?:-|npx$|bunx$|cross-env$|env$|exec$|dotenv$|nice$|time$)/u;
const packageManagers = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const execSubcommands = new Set(['exec', 'dlx', 'x']);
/** npm's `run` and its aliases; each runs the script the first positional names. */
const runSubcommands = new Set(['run', 'run-script', 'rum', 'urn']);
/** npm's direct script commands, each running the script of the same name (`t` and `tst` are `test`). */
const directScriptCommands: ReadonlyMap<string, string> = new Map([
  ['test', 'test'],
  ['tst', 'test'],
  ['t', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['restart', 'restart'],
]);
/** Options npm, pnpm, Yarn, and Bun read with their value in the next word (`--prefix .`); `--option=value` takes none. */
const valuedManagerOptions = new Set(['-w', '--workspace', '-C', '--prefix', '--filter', '--script-shell', '--loglevel', '--userconfig', '--registry']);

interface ParsedOption {
  readonly name: string;
  readonly value: string | undefined;
}

/**
 * A command line read as its program does, up to the first positional word:
 * every `-x` before it is an option — one in `valued`, in space form, taking
 * the next word as its value, `--x=v` carrying its own, any other a flag —
 * and `--` ends the options, the word after it being positional. `-` alone
 * is positional (stdin). Returns the options and the index of that first
 * positional, `words.length` when there is none.
 */
const leadingOptions = (
  words: readonly string[],
  valued: ReadonlySet<string>,
  from = 0,
): { readonly options: readonly ParsedOption[]; readonly positional: number } => {
  const options: ParsedOption[] = [];
  for (let index = from; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') return { options, positional: index + 1 };
    if (word === '-' || !word.startsWith('-')) return { options, positional: index };
    const assigned = /^(--[^=]+)=(.*)$/u.exec(word);
    if (assigned !== null) {
      options.push({ name: assigned[1] as string, value: assigned[2] });
    } else if (valued.has(word)) {
      options.push({ name: word, value: words[index + 1] });
      index += 1;
    } else {
      options.push({ name: word, value: undefined });
    }
  }
  return { options, positional: words.length };
};

/** One simple command of a shell script: what it runs, the words after it, and the environment set for it alone. */
interface SimpleCommand {
  /** The command proper, the directory dropped from a path (`./node_modules/.bin/tsc` is `tsc`). */
  readonly command: string;
  readonly operands: readonly string[];
  /** The assignments before the command (`NODE_OPTIONS=-r x node install.js`, `cross-env CI=1 tsc`), by variable name. */
  readonly environment: ReadonlyMap<string, string>;
  /** The manifest script a package-manager command delegates to: `npm run setup`, `pnpm --filter pkg run setup`, `npm test`, `yarn start`. */
  readonly script: string | undefined;
}

/**
 * What a package-manager command runs, read as `npm [options] <subcommand>
 * [options] <positional…>`. A `run` subcommand (`run-script`, `rum`, `urn`)
 * runs the first positional after it as a manifest script — the rest, after
 * a `--` or not, are that script's arguments (`npm run setup -- dormant`
 * runs `setup` alone, as does `npm run setup dormant`) — and `test`, `start`,
 * `stop`, `restart` (`t`, `tst`) run the script of that name, their
 * positionals being arguments too. `exec`, `dlx`, and `x` run the first
 * positional as a command, the rest its operands. Any other subcommand is
 * the manager's own.
 */
const managerCommand = (manager: string, args: readonly string[], environment: ReadonlyMap<string, string>): SimpleCommand => {
  const sub = leadingOptions(args, valuedManagerOptions).positional;
  const subcommand = args[sub];
  const next = leadingOptions(args, valuedManagerOptions, sub + 1).positional;
  if (subcommand !== undefined && execSubcommands.has(subcommand) && next < args.length) {
    return { command: posix.basename(args[next] as string), environment, operands: args.slice(next + 1), script: undefined };
  }
  const script = subcommand === undefined
    ? undefined
    : runSubcommands.has(subcommand) ? args[next] : directScriptCommands.get(subcommand);
  return { command: manager, environment, operands: args.slice(sub + 1), script };
};

/**
 * The simple commands of a shell script, one per operator-separated segment:
 * the first word after environment assignments and exec wrappers (`FOO=1 npx
 * tsc`, `pnpm exec -- tsc`, `cross-env CI=1 tsc`) is the command, the rest of
 * the segment its operands, the assignments its environment; a package
 * manager's command is read by its own grammar (`managerCommand`).
 */
const simpleCommands = (text: string): readonly SimpleCommand[] => {
  const words = shellWords(text);
  const commands: SimpleCommand[] = [];
  let start = 0;
  const segment = (end: number): void => {
    const environment = new Map<string, string>();
    let index = start;
    for (; index < end; index += 1) {
      const assignment = environmentAssignment.exec(words[index] as string);
      if (assignment !== null) environment.set(assignment[1] as string, assignment[2] as string);
      else if (!commandPrefix.test(words[index] as string)) break;
    }
    if (index >= end) return;
    const word = words[index] as string;
    const rest = words.slice(index + 1, end);
    commands.push(packageManagers.has(word)
      ? managerCommand(word, rest, environment)
      : { command: posix.basename(word), environment, operands: rest, script: undefined });
  };
  words.forEach((word, index) => {
    if (!shellOperators.has(word)) return;
    segment(index);
    start = index + 1;
  });
  segment(words.length);
  return commands;
};

/**
 * The text a consumer's install lifecycle executes: the lifecycle scripts,
 * plus every script they reach through `npm run <name>` or a direct `npm
 * test`/`start`/`stop`/`restart` (with its `pre<name>` and `post<name>`
 * hooks), transitively. Dependency executables are on `PATH` for all of them.
 */
const installScriptText = (scripts: Readonly<Record<string, unknown>>): string => {
  const seen = new Set<string>();
  /**
   * The scripts npm runs for a delegated name: the script with its hooks, or
   * nothing when there is no such script — except `restart`, which without a
   * `restart` script runs `stop` then `start`, each with its hooks, inside
   * `prerestart`/`postrestart`.
   */
  const lifecycle = (name: string): readonly string[] => {
    if (Object.hasOwn(scripts, name)) return [`pre${name}`, name, `post${name}`];
    return name === 'restart' ? ['prerestart', ...lifecycle('stop'), ...lifecycle('start'), 'postrestart'] : [];
  };
  const visit = (name: string): void => {
    const body = scripts[name];
    if (seen.has(name) || typeof body !== 'string') return;
    seen.add(name);
    for (const { script } of simpleCommands(body)) {
      if (script !== undefined) for (const hook of lifecycle(script)) visit(hook);
    }
  };
  for (const script of installScripts) visit(script);
  return [...seen].map((name) => scripts[name] as string).join('\n');
};

/**
 * Node's options that take their value in the next word (`--require x`;
 * `--require=x` carries its own). Everything else before the program is a
 * flag, so the first word that is neither is the program.
 */
const valuedNodeOptions = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '-e', '--eval', '-p', '--print', '-pe',
  '--input-type', '-C', '--conditions', '--env-file', '--env-file-if-exists', '--title', '--run',
  '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-shard', '--watch-path',
  '--openssl-config', '--icu-data-dir', '--unhandled-rejections', '--dns-result-order', '--experimental-default-type',
  '--redirect-warnings', '--report-directory', '--report-filename', '--report-signal', '--diagnostic-dir',
  '--disable-warning', '--localstorage-file', '--cpu-prof-dir', '--cpu-prof-name', '--heap-prof-dir', '--heap-prof-name',
  '--trace-event-categories', '--trace-event-file-pattern', '--experimental-sea-config', '--secure-heap',
  '--stack-trace-limit', '--max-http-header-size', '--inspect-port', '--experimental-policy', '--policy-integrity',
  '--tls-cipher-list', '--tls-keylog', '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit',
]);
/** Node's preloads, loaded before the program: `-r`/`--require` (CommonJS), `--import`, and `--loader`/`--experimental-loader` (ES modules). */
const preloadOptions = /^(?:-r|--require|--import|--loader|--experimental-loader)$/u;
/** Node's inline programs: `-e`/`--eval`, `-p`/`--print`, and the one short combination Node accepts, `-pe`. */
const inlineOptions = /^(?:-e|--eval|-p|-pe|--print)$/u;

interface NodeCommand {
  readonly options: readonly ParsedOption[];
  /** The script Node runs, when the command names one: the first positional, unless an inline program makes it an argument. */
  readonly program: string | undefined;
}

/**
 * A `node` command read as Node does — `node [options] [script | -e code | -]
 * [arguments]`: options up to the first positional or a `--`, that positional
 * the program (an argument instead when `-e`/`-p` supply the program), and
 * nothing after it Node's (`node install.js --require x` passes `--require
 * x` to `install.js`). A `NODE_OPTIONS` assignment on the same command
 * (`NODE_OPTIONS=--require=x node install.js`, `cross-env NODE_OPTIONS="-r x"
 * node .`) supplies options Node applies before the command line's; one
 * exported by an earlier command is not read.
 */
const nodeCommand = ({ environment, operands }: SimpleCommand): NodeCommand => {
  const inherited = leadingOptions(shellWords(environment.get('NODE_OPTIONS') ?? ''), valuedNodeOptions).options;
  const { options, positional } = leadingOptions(operands, valuedNodeOptions);
  const inline = options.some((option) => inlineOptions.test(option.name));
  return { options: [...inherited, ...options], program: inline ? undefined : operands[positional] };
};

/**
 * The values a script gives one of `node`'s options, across every `node`
 * command in command position: `-r dotenv/config` or `--require=dotenv/config`
 * before the program, or in the command's `NODE_OPTIONS`; the same flag after
 * the program (`node install.js -r x`) or on another command (`rm -r dist`)
 * is never Node's.
 */
const nodeOptionValues = (commands: readonly SimpleCommand[], options: RegExp): readonly string[] =>
  commands.filter(({ command }) => command === 'node').flatMap((command) => nodeCommand(command).options
    .flatMap(({ name, value }) => (options.test(name) && value !== undefined ? [value] : [])));

/**
 * Dependencies a consumer's install lifecycle demonstrably needs: one of
 * their `bin` commands in command position (`setup-tool --init`, `npx
 * setup-tool`, `./node_modules/.bin/setup-tool`), a file of theirs run
 * directly (`node node_modules/setup-tool/install.js`), or a load in an
 * inline `node -e` program (`node -e "require('setup-tool')"`; a computed
 * load there may reach any declared package). An optional dependency npm
 * skipped after a failed fetch then fails the script, so this is what turns
 * a survivable `AB7015` fatal; `echo setup-tool` never does. The packages
 * the files and preloads a `node` command runs then load are
 * `installScriptModuleDependencies`'s.
 */
const installScriptCommandDependencies = (
  text: string,
  commands: readonly SimpleCommand[],
  executables: ExecutableCommands,
  declared: readonly string[],
): readonly string[] => {
  if (text === '') return [];
  const run = new Set(commands.map(({ command }) => command));
  const words = shellWords(text);
  const names = new Set<string>();
  for (const [name, { commands: bins }] of executables) {
    if (bins.some((command) => run.has(command))) names.add(name);
    if (words.some((word) => word.replace(/^\.\//u, '').startsWith(`node_modules/${name}/`))) names.add(name);
  }
  for (const program of nodeOptionValues(commands, inlineOptions)) {
    if (computedLoad(['require'], ['createRequire']).test(program)) for (const name of declared) names.add(name);
    for (const match of program.matchAll(literalLoad(['require'], ['createRequire']))) {
      const name = packageNameOf(decodeLiteral(match[2] ?? ''));
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
};

/** The packed files a module resolves through: the module files, and each packed directory manifest's `main`. */
interface PackedModules {
  readonly files: ReadonlySet<string>;
  /** Directory → the path its packed `package.json` `main` names, as Node reads it for `require("./dir")`. */
  readonly mains: ReadonlyMap<string, string>;
}

/**
 * Directory → the `main` of its packed manifest (`lib/package.json` with
 * `"main": "setup.cjs"` → `lib` → `lib/setup.cjs`), which Node consults before
 * the `index.js` fallback when a directory is required or run: the package's
 * own manifest for `.` (what `node .` runs), read from the document since
 * the inventory's `package.json` is the package itself, and every other
 * packed manifest outside `node_modules`, whose manifests belong to bundled
 * dependencies.
 */
const packedMains = async (
  paths: readonly string[],
  projectRoot: string,
  packageDocument: Readonly<Record<string, unknown>>,
): Promise<ReadonlyMap<string, string>> => {
  const manifests = paths.filter((path) => /^(?!node_modules\/).+\/package\.json$/u.test(path));
  const entries = await Promise.all(manifests.map(async (path): Promise<readonly [string, string] | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(resolve(projectRoot, path), 'utf8'));
      if (!isRecord(parsed) || typeof parsed.main !== 'string') return undefined;
      const directory = posix.dirname(path);
      return [directory, posix.join(directory, parsed.main)];
    } catch {
      return undefined;
    }
  }));
  return new Map([
    ...(typeof packageDocument.main === 'string' ? [['.', posix.join('.', packageDocument.main)] as const] : []),
    ...entries.filter((entry): entry is readonly [string, string] => entry !== undefined),
  ]);
};

/**
 * The packed module a path names, in the order Node's CommonJS loader tries
 * for `require("./lib")` or `node scripts/install`: the exact file, the `.js`
 * extension, then the directory — its manifest's `main` as a file, with
 * `.js`, or as a directory index, and finally `index.js`. Node never tries
 * `.cjs` or `.mjs` there. A trailing slash names the same directory (`node
 * scripts/`, `node ./`), and `.` is the package root.
 */
const packedModule = (path: string, modules: PackedModules): string | undefined => {
  const base = posix.normalize(path).replace(/(?<=.)\/$/u, '');
  const main = modules.mains.get(base);
  const candidates = [
    base,
    `${base}.js`,
    ...(main === undefined ? [] : [main, `${main}.js`, posix.join(main, 'index.js')]),
    posix.join(base, 'index.js'),
  ];
  return candidates.find((candidate) => javaScriptSuffix.test(candidate) && modules.files.has(candidate));
};

/** `.` or `./`: the package directory, which `node .` runs through the root manifest's `main`. */
const packageDirectory = /^\.\/*$/u;

/**
 * The packed JavaScript files an install script runs: `node install.cjs`,
 * `node ./scripts/setup.mjs`, `node scripts/install`, `node "scripts/my
 * install.cjs"`. Every word is tried; a word that is not a packed module is
 * not one, and the empty word `""` names no path. The package directory
 * itself counts only as a `node` program (`node .`, `node -r dotenv/config
 * .`): elsewhere `.` is the working directory an option names (`npm --prefix
 * . run setup`), not a program.
 */
const installScriptFiles = (text: string, commands: readonly SimpleCommand[], modules: PackedModules): readonly string[] => [
  ...shellWords(text).filter((word) => word !== '' && !packageDirectory.test(word)),
  ...commands.filter(({ command }) => command === 'node').flatMap((command) => {
    const { program } = nodeCommand(command);
    return program !== undefined && packageDirectory.test(program) ? [program] : [];
  }),
].flatMap((word) => {
  const module = packedModule(word, modules);
  return module === undefined ? [] : [module];
});

const relativeSpecifier = /^\.\.?\//u;

/**
 * The packages a consumer's install lifecycle loads through the packed
 * JavaScript it runs — `"postinstall": "node install.cjs"` with `install.cjs`
 * requiring a driver — and through the modules `node` preloads before the
 * program (`node -r dotenv/config install.cjs`, `node --import ./setup.mjs
 * .`), following relative imports and the manifest's `imports` map through
 * the tarball. A computed load in any of those files could reach any declared
 * package, so every declared name then counts as needed at install time.
 */
const installScriptModuleDependencies = (options: {
  /** The packed files run directly. */
  readonly roots: readonly string[];
  /** The specifiers preloaded from the package root, where npm runs the lifecycle. */
  readonly preloads: readonly string[];
  readonly evidenceByPath: ReadonlyMap<string, FileEvidence>;
  readonly modules: PackedModules;
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly declared: readonly string[];
}): readonly string[] => {
  const { declared, evidenceByPath, modules, packageDocument } = options;
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue = [...options.roots];
  // What one specifier resolved from `directory` reaches: a relative one a packed module to follow, a bare one a
  // package, a `#` one whatever the `imports` map gives it — a package, or the package's own file
  // (`"#setup": "./setup.js"`), relative to the package root.
  const follow = (specifier: string, directory: string): void => {
    if (relativeSpecifier.test(specifier)) {
      const target = packedModule(posix.join(directory, specifier), modules);
      if (target !== undefined) queue.push(target);
      return;
    }
    for (const target of specifier.startsWith('#') ? packageImportTargets(packageDocument, specifier) : [specifier]) {
      if (relativeSpecifier.test(target)) {
        const module = packedModule(target, modules);
        if (module !== undefined) queue.push(module);
        continue;
      }
      const name = packageNameOf(target);
      if (name !== undefined) names.add(name);
    }
  };
  for (const specifier of options.preloads) follow(specifier, '.');
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const evidence = evidenceByPath.get(path);
    if (seen.has(path) || evidence === undefined) continue;
    seen.add(path);
    if (!evidence.complete) for (const name of declared) names.add(name);
    for (const name of evidence.executed) names.add(name);
    for (const specifier of evidence.specifiers) follow(specifier, posix.dirname(path));
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
  const modules: PackedModules = {
    files: new Set(evidenceByPath.keys()),
    mains: await packedMains(options.paths, projectRoot, options.packageDocument),
  };
  const evidence = [...evidenceByPath.values()];
  const scriptText = installScriptText(isRecord(options.packageDocument.scripts) ? options.packageDocument.scripts : {});
  const commands = simpleCommands(scriptText);
  const neededByScripts = [
    ...installScriptCommandDependencies(scriptText, commands, executables, options.declared),
    ...installScriptModuleDependencies({
      declared: options.declared,
      evidenceByPath,
      modules,
      packageDocument: options.packageDocument,
      preloads: nodeOptionValues(commands, preloadOptions),
      roots: installScriptFiles(scriptText, commands, modules),
    }),
  ];
  const specifiers = evidence.flatMap((file) => file.specifiers);
  const reachable = specifiers
    .filter((specifier) => specifier.startsWith('#'))
    .flatMap((specifier) => packageImportTargets(options.packageDocument, specifier));
  return {
    complete: evidence.every((file) => file.complete),
    installScripts: new Set(neededByScripts),
    names: new Set([
      ...[...specifiers, ...reachable].flatMap((specifier) => {
        const name = packageNameOf(specifier);
        return name === undefined ? [] : [name];
      }),
      ...evidence.flatMap((file) => file.executed),
      ...installScriptMentions(scriptText, executables),
      ...neededByScripts,
    ]),
  };
};
