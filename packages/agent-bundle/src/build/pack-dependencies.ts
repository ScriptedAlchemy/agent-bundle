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
 * package, and which packages the packed JavaScript actually imports.
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
}

export const declaredDependencies = (packageDocument: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] =>
  installedDependencyFields.flatMap((field) => {
    const value = packageDocument[field];
    if (!isRecord(value)) return [];
    return Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, specifier]) => ({ field, name, specifier }));
  });

/** Relative, package-imports (`#`), absolute, and URL-scheme specifiers (`node:`, `data:`, `file:`, `C:\`) name no package. */
const nonPackageSpecifier = /^(?:[.#/]|[a-z][a-z0-9+.-]*:)/iu;
/** `@scope/name` or `name`; a subpath after it is dropped. */
const packageNamePrefix = /^(?:@[^/]+\/)?[^@/][^/]*/u;

/** The package name an import specifier resolves through, or `undefined` for anything that is not a bare specifier. */
export const packageNameOf = (specifier: string): string | undefined =>
  nonPackageSpecifier.test(specifier) || isBuiltin(specifier) ? undefined : packageNamePrefix.exec(specifier)?.[0];

/** Protocols the workspace manager rewrites to registry versions at publish time. */
const publishTimeRewritten = /^(?:npm|workspace|catalog):/u;

/**
 * Everything npm fetches as `git` or `remote`, or reads from disk: the forms
 * npm 12 refuses by default (`allow-git=none`, `allow-remote=none`) so a
 * consumer's `npm install` of the published package fails before any code
 * runs. Semver ranges and dist-tags never match: they contain no `:`, no
 * `/`, and never start with `.`, `/`, or `~`.
 */
const nonRegistrySpecifier = new RegExp([
  String.raw`^(?:git\+[a-z]+|git|github|gitlab|bitbucket|gist|https?|file|link|portal):`,
  String.raw`^[^\s@]+@[^\s:]+:`, // scp-style git@host:path
  String.raw`^[a-z]:[\\/]`, // Windows drive path
  String.raw`^[./~]`, // relative, absolute, or home path
  String.raw`^[^\s@/]+/[^\s/]+$`, // owner/repo[#ref] GitHub shorthand
].join('|'), 'iu');

/** Whether npm resolves this dependency specifier through a package registry. */
export const isRegistrySpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim();
  return publishTimeRewritten.test(trimmed) || !nonRegistrySpecifier.test(trimmed);
};

const javaScriptSuffix = /\.(?:[cm]?js)$/u;

/**
 * A `require("…")` call with a literal argument. The ESM lexer reports
 * `import` forms only; CommonJS payloads a consumer prebuilt reach the
 * package through `require`. A match inside a comment or string can only
 * mark a dependency as imported, never as unused, so the pattern errs
 * toward keeping a declaration.
 */
const requireCall = /\brequire\s*\(\s*(["'])((?:(?!\1)[^\\\n]|\\.)+)\1\s*\)/gu;

const packageNamesIn = async (path: string): Promise<readonly string[]> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    // npm listed the file; only its absence is a benign inconsistency.
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const source = bytes.toString('utf8');
  let imports: readonly ModuleImport[];
  try {
    imports = await readModuleImports(source, { check: 'lexed', sha256: sha256Hex(bytes) });
  } catch {
    // Syntax is another gate's concern; skipping can only keep a declaration.
    imports = [];
  }
  return [
    ...imports.filter((record) => record.kind !== 'meta').map((record) => record.specifier),
    ...Array.from(source.matchAll(requireCall), (match) => match[2]),
  ].flatMap((specifier) => {
    const name = specifier === undefined ? undefined : packageNameOf(specifier);
    return name === undefined ? [] : [name];
  });
};

/**
 * Every package name the packed JavaScript imports or requires, read from
 * the bytes npm would publish.
 */
export const importedPackageNames = async (options: {
  readonly paths: readonly string[];
  readonly projectRoot: string;
}): Promise<ReadonlySet<string>> => {
  const projectRoot = resolve(options.projectRoot);
  const names = await Promise.all(options.paths
    .filter((path) => javaScriptSuffix.test(path))
    .map((path) => packageNamesIn(resolve(projectRoot, path))));
  return new Set(names.flat());
};
