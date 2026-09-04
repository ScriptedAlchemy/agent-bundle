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
}

/** Peers `peerDependenciesMeta` marks optional: npm never installs them, so they are not installed dependencies. */
const optionalPeers = (packageDocument: Readonly<Record<string, unknown>>): ReadonlySet<string> => {
  const meta = packageDocument.peerDependenciesMeta;
  return new Set(isRecord(meta)
    ? Object.entries(meta).filter(([, entry]) => isRecord(entry) && entry.optional === true).map(([name]) => name)
    : []);
};

/**
 * Which dependencies npm embeds under `node_modules` in the published tarball:
 * `bundleDependencies` (or the `bundledDependencies` spelling) as a name list,
 * or `true` for every entry of `dependencies`.
 */
const bundledDependencies = (packageDocument: Readonly<Record<string, unknown>>): ((name: string) => boolean) => {
  const value = packageDocument.bundleDependencies ?? packageDocument.bundledDependencies;
  if (value === true) return () => true;
  const names = new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return (name) => names.has(name);
};

/**
 * The entries npm installs for a consumer, one per name and field. A name in
 * both `dependencies` and `optionalDependencies` is the optional entry (npm
 * lets the optional declaration override); optional peers are never
 * installed and are dropped.
 */
export const declaredDependencies = (packageDocument: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] => {
  const skippedPeers = optionalPeers(packageDocument);
  const bundled = bundledDependencies(packageDocument);
  const entries = (field: InstalledDependencyField): readonly (readonly [string, string])[] => {
    const value = packageDocument[field];
    return isRecord(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : [];
  };
  const optional = new Set(entries('optionalDependencies').map(([name]) => name));
  const superseded = (field: InstalledDependencyField, name: string): boolean =>
    (field === 'dependencies' && optional.has(name)) || (field === 'peerDependencies' && skippedPeers.has(name));
  return installedDependencyFields.flatMap((field) => entries(field)
    .filter(([name]) => !superseded(field, name))
    .map(([name, specifier]) => ({ field, name, specifier, bundled: bundled(name) })));
};

/** Relative, package-imports (`#`), absolute, and URL-scheme specifiers (`node:`, `data:`, `file:`, `C:\`) name no package. */
const nonPackageSpecifier = /^(?:[.#/]|[a-z][a-z0-9+.-]*:)/iu;
/** `@scope/name` or `name`; a subpath after it is dropped. */
const packageNamePrefix = /^(?:@[^/]+\/)?[^@/][^/]*/u;

/** The package name an import specifier resolves through, or `undefined` for anything that is not a bare specifier. */
export const packageNameOf = (specifier: string): string | undefined =>
  nonPackageSpecifier.test(specifier) || isBuiltin(specifier) ? undefined : packageNamePrefix.exec(specifier)?.[0];

/** npm resolves an `npm:` alias through the registry itself; nothing has to rewrite it. */
const registryAlias = /^npm:/u;

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
 * Everything npm fetches as `git` or `remote`, or reads from disk: the forms
 * npm 12 refuses by default (`allow-git=none`, `allow-remote=none`) so a
 * consumer's `npm install` of the published package fails before any code
 * runs. Semver ranges and dist-tags never match: they contain no `:` and no
 * `/`, and a tilde range (`~1.2.3`) is followed by a digit, never a slash.
 */
const nonRegistrySpecifier = new RegExp([
  String.raw`^(?:git\+[a-z]+|git|github|gitlab|bitbucket|gist|https?|file|link|portal):`,
  String.raw`^[^\s@]+@[^\s:]+:`, // scp-style git@host:path
  String.raw`^[a-z]:[\\/]`, // Windows drive path
  String.raw`^(?:\.|/|~[\\/])`, // relative, absolute, or home path
  String.raw`^[^\s@/]+/[^\s/]+$`, // owner/repo[#ref] GitHub shorthand
].join('|'), 'iu');

/**
 * Whether a consumer's npm resolves this dependency specifier, as written,
 * through a package registry. A workspace protocol is not one; whether the
 * packer rewrites it first is the caller's policy (`isWorkspaceProtocol`).
 */
export const isRegistrySpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim();
  return registryAlias.test(trimmed) || !(workspaceProtocol.test(trimmed) || nonRegistrySpecifier.test(trimmed));
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
const requireCall = new RegExp(String.raw`(?:\brequire|\.resolve)\s*[(]\s*${quotedLiteral}\s*[)]`, 'gu');

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

/** The literal module specifiers a declaration file resolves, in order of appearance. */
export const declarationSpecifiers = (source: string): readonly string[] =>
  Array.from(source.matchAll(declarationSpecifier), (match) => match[2] ?? match[4] ?? '');

/**
 * The module specifiers packed JavaScript resolves: the lexer's static and
 * dynamic literal imports — never a mention inside a comment or string,
 * which bundled library docblocks are full of — plus literal `require` calls.
 */
const javaScriptSpecifiers = async (bytes: Buffer): Promise<readonly string[]> => {
  const source = bytes.toString('utf8');
  let imports: readonly ModuleImport[];
  try {
    imports = await readModuleImports(source, { check: 'lexed', sha256: sha256Hex(bytes) });
  } catch {
    // Syntax is another gate's concern; skipping can only keep a declaration.
    imports = [];
  }
  return [
    ...imports.flatMap((record) => (record.specifier === undefined ? [] : [record.specifier])),
    ...Array.from(source.matchAll(requireCall), (match) => match[2] ?? ''),
  ];
};

const javaScriptSuffix = /\.[cm]?js$/u;
const declarationSuffix = /\.d\.[cm]?ts$/u;

const packageNamesIn = async (path: string): Promise<readonly string[]> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    // npm listed the file; only its absence is a benign inconsistency.
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const specifiers = declarationSuffix.test(path)
    ? declarationSpecifiers(bytes.toString('utf8'))
    : await javaScriptSpecifiers(bytes);
  return specifiers.flatMap((specifier) => {
    const name = packageNameOf(specifier);
    return name === undefined ? [] : [name];
  });
};

/**
 * Every package name the packed JavaScript imports or requires, or the
 * packed declarations reference, read from the bytes npm would publish.
 */
export const importedPackageNames = async (options: {
  readonly paths: readonly string[];
  readonly projectRoot: string;
}): Promise<ReadonlySet<string>> => {
  const projectRoot = resolve(options.projectRoot);
  const names = await Promise.all(options.paths
    .filter((path) => javaScriptSuffix.test(path) || declarationSuffix.test(path))
    .map((path) => packageNamesIn(resolve(projectRoot, path))));
  return new Set(names.flat());
};
