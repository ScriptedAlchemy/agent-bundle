import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';

import { sha256Hex } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readModuleImports, rememberedModuleImports } from './module-imports.ts';

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

const javaScriptSuffix = /\.(?:[cm]?js)$/u;

/**
 * A `require("…")` call with a literal argument. The ESM lexer reports
 * `import` forms only; CommonJS payloads a consumer prebuilt reach the
 * package through `require`. A match inside a comment or string can only
 * mark a dependency as imported, never as unused, so the pattern errs
 * toward keeping a declaration.
 */
const requireCall = /\brequire\s*\(\s*(["'])((?:(?!\1)[^\\\n]|\\.)+)\1\s*\)/gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The package name an import specifier resolves through, or `undefined` for anything that is not a bare specifier. */
export const packageNameOf = (specifier: string): string | undefined => {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(specifier) && !specifier.startsWith('@')) return undefined;
  if (isBuiltin(specifier)) return undefined;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 && segments[1] !== '' ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0] === '' ? undefined : segments[0];
};

/**
 * Whether npm resolves this dependency specifier through a package registry.
 * Everything else — git and GitHub shorthands, remote tarballs, local paths
 * and links — is a `git` or `remote` fetch, which npm 12 refuses by default
 * (`allow-git=none`, `allow-remote=none`), so a consumer's `npm install` of
 * the published package fails before any code runs. `workspace:` protocols
 * are rewritten to versions by the workspace manager at publish time and
 * are treated as registry specifiers.
 */
export const isRegistrySpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim();
  if (trimmed === '' || trimmed.startsWith('npm:') || trimmed.startsWith('workspace:')) return true;
  if (/^(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|portal:)/iu.test(trimmed)) return false;
  if (trimmed.startsWith('.') || trimmed.startsWith('/') || trimmed.startsWith('~')) return false;
  // `owner/repo`, `owner/repo#ref`: the GitHub shorthand. Semver ranges and
  // dist-tags never contain a slash.
  if (/^[^\s@/]+\/[^\s/]+$/u.test(trimmed)) return false;
  return true;
};

export const declaredDependencies = (packageDocument: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] =>
  Object.freeze(installedDependencyFields.flatMap((field) => {
    const value = packageDocument[field];
    if (!isRecord(value)) return [];
    return Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, specifier]) => Object.freeze({ field, name, specifier }));
  }));

/**
 * Every package name the packed JavaScript imports or requires, read from
 * the bytes npm would publish. Files the lexer rejects are skipped: syntax
 * is another gate's concern, and skipping can only keep a declaration.
 */
export const importedPackageNames = async (options: {
  readonly paths: readonly string[];
  readonly projectRoot: string;
}): Promise<ReadonlySet<string>> => {
  const names = new Set<string>();
  const projectRoot = resolve(options.projectRoot);
  for (const path of options.paths) {
    if (!javaScriptSuffix.test(path)) continue;
    let bytes: Buffer;
    try {
      bytes = await readFile(resolve(projectRoot, path));
    } catch {
      continue;
    }
    const source = bytes.toString('utf8');
    const sha256 = sha256Hex(bytes);
    let imports = rememberedModuleImports('lexed', sha256) ?? rememberedModuleImports('parsed', sha256);
    if (imports === undefined) {
      try {
        imports = await readModuleImports(source, { check: 'lexed', sha256 });
      } catch {
        imports = Object.freeze([]);
      }
    }
    for (const record of imports) {
      if (record.kind === 'meta' || record.specifier === undefined) continue;
      const name = packageNameOf(record.specifier);
      if (name !== undefined) names.add(name);
    }
    for (const match of source.matchAll(requireCall)) {
      const name = packageNameOf(match[2]!);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
};

const quoteAll = (values: readonly string[]): string => values.map((value) => JSON.stringify(value)).join(', ');

/**
 * `AB7014`: an installed-dependency field names packages no packed
 * JavaScript imports. The framework bundles every dependency into its
 * outputs, so such a declaration only makes every consumer's `npm install`
 * fetch build-time packages — and fail outright when one of them is a git
 * or remote specifier.
 *
 * `AB7015`: an installed-dependency field resolves a package outside a
 * registry. npm 12 refuses `git` and `remote` fetches by default, so the
 * published package cannot be installed.
 */
export const packDependencyDiagnostics = async (options: {
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly packedPaths: readonly string[];
  readonly projectRoot: string;
}): Promise<readonly Diagnostic[]> => {
  const declared = declaredDependencies(options.packageDocument);
  if (declared.length === 0) return Object.freeze([]);
  const imported = await importedPackageNames({ paths: options.packedPaths, projectRoot: options.projectRoot });
  const diagnostics: Diagnostic[] = [];

  const unused = declared.filter((dependency) => !imported.has(dependency.name));
  for (const field of installedDependencyFields) {
    const names = unused.filter((dependency) => dependency.field === field).map((dependency) => dependency.name).sort();
    if (names.length === 0) continue;
    diagnostics.push(Object.freeze({
      code: 'AB7014',
      message: `package.json ${field} names packages no packed JavaScript imports: ${quoteAll(names)}. `
        + 'Every consumer installs them for nothing; the emitted outputs already inline what they use.',
      recovery: 'Move build-only packages to devDependencies, or import the package from a packed module if a consumer needs it at runtime.',
      severity: 'error',
    }));
  }

  const nonRegistry = declared
    .filter((dependency) => !isRegistrySpecifier(dependency.specifier))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const field of installedDependencyFields) {
    const entries = nonRegistry.filter((dependency) => dependency.field === field);
    if (entries.length === 0) continue;
    diagnostics.push(Object.freeze({
      code: 'AB7015',
      message: `package.json ${field} resolves packages outside a registry: ${entries.map((dependency) =>
        `${JSON.stringify(dependency.name)} -> ${JSON.stringify(dependency.specifier)}`).join(', ')}. `
        + 'npm 12 refuses git and remote fetches by default (allow-git, allow-remote), so consumers cannot install the package.',
      recovery: 'Depend on a published registry version, or bundle the package and declare it under devDependencies.',
      severity: 'error',
    }));
  }

  return Object.freeze(diagnostics);
};
