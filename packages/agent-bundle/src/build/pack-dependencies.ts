import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';

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
 * An `npm:` alias, `npm:name` or `npm:name@<target>`. npm resolves the alias
 * itself, but only to a registry target: the part after the aliased name is
 * classified like any other specifier (an absent target is `latest`).
 */
const registryAlias = /^npm:(?:@[^/@]+\/)?[^/@]+(?:@(?<target>.*))?$/u;

/**
 * Protocols only a workspace manager understands. pnpm, Yarn, and Bun
 * rewrite them to registry versions while packing; npm publishes them
 * verbatim and every consumer then fails with `EUNSUPPORTEDPROTOCOL`.
 */
const workspaceProtocol = /^(?:workspace|catalog):/u;

export const isWorkspaceProtocol = (specifier: string): boolean => workspaceProtocol.test(specifier.trim());

/**
 * Whether the package manager running this pack (its `npm_config_user_agent`,
 * e.g. `pnpm/10.0.0 npm/? node/v24.0.0 linux x64`) rewrites workspace
 * protocols. Unknown or absent — `agent-bundle prepack` run outside any
 * lifecycle — means no, so the gate stays strict.
 */
export const rewritesWorkspaceProtocols = (packerUserAgent: string | undefined): boolean =>
  /^(?:pnpm|yarn|bun)\//u.test(packerUserAgent ?? '');

/**
 * The specifier schemes npm can parse at all. Anything else with a scheme —
 * `workspace:`, `catalog:`, `link:`, `portal:`, or a typo — fails every
 * consumer with `EUNSUPPORTEDPROTOCOL` before npm fetches anything, even for
 * a peer it would never install.
 */
const npmScheme = /^(?:git(?:\+[a-z]+)?|github|gitlab|bitbucket|gist|https?|file|npm):/iu;
const anyScheme = /^[a-z][a-z0-9+.-]*:/iu;

/** Whether npm parses this specifier; a Windows drive path (`c:\…`) is a path, not a scheme. */
export const isNpmParseable = (specifier: string): boolean => {
  const trimmed = specifier.trim();
  return !anyScheme.test(trimmed) || npmScheme.test(trimmed) || windowsDrivePath.test(trimmed);
};

const windowsDrivePath = /^[a-z]:[\\/]/iu;

/**
 * Everything npm fetches as `git` or `remote`, or reads from disk: the forms
 * npm 12 refuses by default (`allow-git=none`, `allow-remote=none`) so a
 * consumer's `npm install` of the published package fails before any code
 * runs. Semver ranges and dist-tags never match: they contain no `:` and no
 * `/`, and a tilde range (`~1.2.3`) is followed by a digit, never a slash.
 */
const nonRegistrySpecifier = new RegExp([
  String.raw`^(?:git(?:\+[a-z]+)?|github|gitlab|bitbucket|gist|https?|file):`,
  String.raw`^[^\s@]+@[^\s:]+:`, // scp-style git@host:path
  windowsDrivePath.source,
  String.raw`^(?:\.|/|~[\\/])`, // relative, absolute, or home path
  String.raw`^[^\s@/]+/[^\s/]+$`, // owner/repo[#ref] GitHub shorthand
].join('|'), 'iu');

/**
 * Whether a consumer's npm resolves this dependency specifier, as written,
 * through a package registry: parseable, and neither a fetch npm refuses nor
 * a path. A workspace protocol is not one; whether the packer rewrites it
 * first is the caller's policy (`isWorkspaceProtocol`).
 */
export const isRegistrySpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim();
  const alias = registryAlias.exec(trimmed);
  if (alias !== null) {
    const target = alias.groups?.target;
    return target === undefined || target === '' || (!target.startsWith('npm:') && isRegistrySpecifier(target));
  }
  return isNpmParseable(trimmed) && !nonRegistrySpecifier.test(trimmed);
};

/** A single- or double-quoted string literal; the group after the opening quote is its body. */
const quotedLiteral = String.raw`(["'])((?:(?!\1)[^\\\n]|\\.)+)\1`;

/**
 * A `require("…")` call, or a resolution-only use — `require.resolve("…")`,
 * `createRequire(…).resolve("…")`, `import.meta.resolve("…")` — with a
 * literal argument. The ESM lexer reports `import` forms only; CommonJS
 * payloads a consumer prebuilt reach the package through `require`, and a
 * package located only to find an asset or executable is still a runtime
 * dependency. A match inside a comment or string can only mark a dependency
 * as imported, never as unused, so the pattern errs toward keeping a
 * declaration.
 */
const literalLoad = (loaders: readonly string[]): RegExp =>
  new RegExp(String.raw`(?:\b(?:${loaders.join('|')})|\.resolve)\s*[(]\s*${quotedLiteral}\s*[)]`, 'gu');

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
  String.raw`(?:\b(?:${loaders.join('|')})(?:\.resolve)?|\bimport\.meta\.resolve|\b(?:${factories.join('|')})\s*[(][^)]*[)])\s*[(]\s*`
    + String.raw`(?:[^"'\s)]|"[^"\n]*"\s*[^)\s]|'[^'\n]*'\s*[^)\s])`,
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
 * `const load = <factory>(…)`, the factory bare or namespace-qualified
 * (`Module.createRequire(…)` after `import * as Module from "node:module"`):
 * the binding is a loader, called like `require` from then on.
 */
const loaderBinding = (factories: readonly string[]): RegExp => new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:${factories.join('|')})\s*[(]`,
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
 * `import("…")`, `import x = require("…")`, and `/// <reference types="…" />`.
 * A consumer needs the package that provides these types even though the
 * bundled JavaScript has no runtime import. Declarations are not ES modules
 * the lexer accepts, so this is a text scan with the same keep-only bias.
 */
const declarationSpecifier = new RegExp(
  String.raw`\b(?:from|import|require)\s*\(?\s*${quotedLiteral}|<reference\s+types\s*=\s*(["'])([^"'\n]+)\3`,
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
    (match[4] === undefined ? [match[2] ?? ''] : typeDirectivePackages(match[4])));

/** What one packed file proves about the packages it resolves. */
interface FileEvidence {
  readonly specifiers: readonly string[];
  /** `false` when a computed `import(expression)` means the file may load a package no literal names. */
  readonly complete: boolean;
}

/**
 * The module specifiers packed JavaScript resolves: the lexer's static and
 * dynamic literal imports — never a mention inside a comment or string,
 * which bundled library docblocks are full of — plus literal `require` calls.
 */
const javaScriptEvidence = async (bytes: Buffer): Promise<FileEvidence> => {
  const source = bytes.toString('utf8');
  let imports: readonly ModuleImport[];
  try {
    imports = await readModuleImports(source, { check: 'lexed', sha256: sha256Hex(bytes) });
  } catch {
    // Syntax is another gate's concern; skipping can only keep a declaration.
    imports = [];
  }
  const loaders = loaderNames(source);
  return {
    complete: imports.every((record) => record.kind !== 'dynamic' || record.specifier !== undefined)
      && !computedLoad(loaders, factoryNames(source)).test(source),
    specifiers: [
      ...imports.flatMap((record) => (record.specifier === undefined ? [] : [record.specifier])),
      ...Array.from(source.matchAll(literalLoad(loaders)), (match) => match[2] ?? ''),
    ],
  };
};

const javaScriptSuffix = /\.[cm]?js$/u;
const declarationSuffix = /\.d\.[cm]?ts$/u;

const fileEvidence = async (path: string): Promise<FileEvidence> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    // npm listed the file; only its absence is a benign inconsistency.
    if (isErrno(error, 'ENOENT')) return { complete: true, specifiers: [] };
    throw error;
  }
  return declarationSuffix.test(path)
    ? { complete: true, specifiers: declarationSpecifiers(bytes.toString('utf8')) }
    : javaScriptEvidence(bytes);
};

export interface ImportedPackages {
  /** Every package name the packed files name literally. */
  readonly names: ReadonlySet<string>;
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

const installScripts = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

/**
 * Dependencies a consumer's install lifecycle uses: npm puts every
 * dependency's executables on `PATH` for `preinstall`/`install`/`postinstall`
 * (and `prepare` when installing from git), so a script that names a
 * dependency, or one of its `bin` commands, needs it installed even though no
 * packed JavaScript imports it. Bin names come from the dependency's own
 * manifest under `node_modules`; when that manifest is unreadable (Plug'n'Play,
 * a platform-specific optional dependency not installed here) the unscoped
 * package name stands in, npm's default bin name — `node-pre-gyp` for
 * `@mapbox/node-pre-gyp`.
 */
const installScriptDependencies = async (
  packageDocument: Readonly<Record<string, unknown>>,
  names: readonly string[],
  projectRoot: string,
): Promise<readonly string[]> => {
  const scripts = isRecord(packageDocument.scripts) ? packageDocument.scripts : {};
  const text = installScripts.flatMap((script) => (typeof scripts[script] === 'string' ? [scripts[script]] : [])).join('\n');
  if (text === '') return [];
  const binCommands = async (name: string): Promise<readonly string[]> => {
    const unscoped = name.replace(/^@[^/]+\//u, '');
    const manifest = await readFile(resolve(projectRoot, 'node_modules', name, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest === undefined) return [unscoped];
    const parsed: unknown = JSON.parse(manifest);
    const bin = isRecord(parsed) ? parsed.bin : undefined;
    return typeof bin === 'string' ? [unscoped] : isRecord(bin) ? Object.keys(bin) : [];
  };
  const mentioned = async (name: string): Promise<boolean> =>
    text.includes(name) || (await binCommands(name)).some((command) =>
      new RegExp(String.raw`(?<![\w-])${command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\w-])`, 'u').test(text));
  const used = await Promise.all(names.map(async (name) => ((await mentioned(name)) ? [name] : [])));
  return used.flat();
};

/**
 * Every package name the packed JavaScript imports, requires, or resolves,
 * the packed declarations reference, a packed `#` import may reach through
 * the manifest's `imports` map, or a consumer's install script runs — read
 * from the bytes npm would publish.
 */
export const importedPackageNames = async (options: {
  /** Names to test for install-script use; every other source is scanned whole. */
  readonly declared: readonly string[];
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly paths: readonly string[];
  readonly projectRoot: string;
}): Promise<ImportedPackages> => {
  const projectRoot = resolve(options.projectRoot);
  const [evidence, fromScripts] = await Promise.all([
    Promise.all(options.paths
      .filter((path) => javaScriptSuffix.test(path) || declarationSuffix.test(path))
      .map((path) => fileEvidence(resolve(projectRoot, path)))),
    installScriptDependencies(options.packageDocument, options.declared, projectRoot),
  ]);
  const specifiers = evidence.flatMap((file) => file.specifiers);
  const reachable = specifiers.some((specifier) => specifier.startsWith('#'))
    ? packageImportTargets(options.packageDocument)
    : [];
  return {
    complete: evidence.every((file) => file.complete),
    names: new Set([
      ...[...specifiers, ...reachable].flatMap((specifier) => {
        const name = packageNameOf(specifier);
        return name === undefined ? [] : [name];
      }),
      ...fromScripts,
    ]),
  };
};
