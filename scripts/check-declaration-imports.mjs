/**
 * Release gate for the type declarations a package ships: every `.d.ts` in
 * the tarball may only reference modules a consumer can resolve — the
 * package's own packed files, Node built-ins, and packages named in its
 * `dependencies`, `peerDependencies`, or `optionalDependencies`.
 *
 * Rslib's per-file `dts: true` emits one declaration per source module, so
 * the pack carries internals nothing under `exports` reaches. A declaration
 * that imports a devDependency (`zod`, `typescript-5`) is latent while it is
 * internal and becomes a consumer type error (`skipLibCheck: false`) the
 * moment a re-export makes it reachable; attw only follows entry points and
 * publint reads the manifest, so neither reports it. This script reads the
 * whole inventory instead:
 *
 *   - a violation in a declaration reachable from `exports` (or `types`) is
 *     an error and fails the gate;
 *   - a violation in an internal declaration is a warning, so the debt stays
 *     visible on every release run; `--strict` makes it an error too.
 *
 * Usage: node scripts/check-declaration-imports.mjs [--strict] <package-dir>...
 *
 * The inventory is `npm pack --dry-run --json` — the files a publish would
 * ship — and each listed declaration is read from the package directory,
 * which is what npm copies into the tarball verbatim.
 */
import { execFile as executeFile } from 'node:child_process';
import { readFile as readFileFromDisk } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { packOutputFromJson } from './npm-pack-json.mjs';

const execFile = promisify(executeFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isDeclarationPath = (path) => /\.d\.[mc]?ts$/u.test(path);

/** `@scope/name/sub/path` → `@scope/name`; `name/sub` → `name`. */
export const packageNameOf = (specifier) => {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

const isIdentifierStart = (character) => /[A-Za-z_$]/u.test(character);
const isIdentifierPart = (character) => /[\w$]/u.test(character);

const referenceDirective =
  /^\/\/\/\s*<reference\s+(?<attribute>types|path|lib|no-default-lib)\s*=\s*(?<quote>["'])(?<value>[^"']*)\k<quote>/u;

/**
 * Splits a declaration file into the tokens the specifier scan needs — words,
 * string literals, and single-character punctuation — dropping comments (a
 * JSDoc line that reads `from 'driver'` is prose, not an import) and keeping
 * triple-slash `<reference>` directives aside. Template literals are skipped
 * whole: a module specifier is never a template.
 */
const tokenizeDeclaration = (text) => {
  const tokens = [];
  const directives = [];
  let line = 1;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const lineEnd = text.indexOf('\n', index);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const directive = referenceDirective.exec(text.slice(index, end));
      if (directive?.groups !== undefined) {
        directives.push({ attribute: directive.groups.attribute, line, value: directive.groups.value });
      }
      index = end;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      line += (text.slice(index, end).match(/\n/gu) ?? []).length;
      index = end;
      continue;
    }
    if (character === '"' || character === "'") {
      let end = index + 1;
      let value = '';
      while (end < text.length && text[end] !== character && text[end] !== '\n') {
        if (text[end] === '\\') {
          value += text[end + 1] ?? '';
          end += 2;
          continue;
        }
        value += text[end];
        end += 1;
      }
      tokens.push({ kind: 'string', line, value });
      index = end + 1;
      continue;
    }
    if (character === '`') {
      let end = index + 1;
      while (end < text.length && text[end] !== '`') {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '\n') line += 1;
        end += 1;
      }
      tokens.push({ kind: 'template', line, value: '' });
      index = end + 1;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < text.length && isIdentifierPart(text[end])) end += 1;
      tokens.push({ kind: 'word', line, value: text.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: 'punctuation', line, value: character });
    index += 1;
  }
  return { directives, tokens };
};

/**
 * The module specifiers a declaration file resolves: `import`/`export … from`,
 * `import x = require()`, inline `import("x")` types, side-effect imports, and
 * `/// <reference types|path>` directives. `declare module "x"` declares a
 * module rather than resolving one and is not reported.
 */
export const declarationSpecifiers = (text) => {
  const { directives, tokens } = tokenizeDeclaration(text);
  const specifiers = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'string') return;
    const previous = tokens[index - 1];
    const before = tokens[index - 2];
    const afterFrom = previous?.kind === 'word' && previous.value === 'from';
    const afterImportKeyword = previous?.kind === 'word' && previous.value === 'import';
    const insideCall = previous?.kind === 'punctuation'
      && previous.value === '('
      && before?.kind === 'word'
      && (before.value === 'import' || before.value === 'require');
    if (afterFrom || afterImportKeyword || insideCall) {
      specifiers.push({ kind: 'import', line: token.line, specifier: token.value });
    }
  });
  for (const directive of directives) {
    if (directive.attribute === 'types') {
      specifiers.push({ kind: 'types-reference', line: directive.line, specifier: directive.value });
    } else if (directive.attribute === 'path') {
      specifiers.push({ kind: 'path-reference', line: directive.line, specifier: directive.value });
    }
  }
  return specifiers;
};

const normalizePackedPath = (target) => posix.normalize(target).replace(/^\.\//u, '');

/**
 * Declaration files a consumer's TypeScript enters the package through: every
 * `.d.ts` target under `exports` (any condition, any depth) plus the legacy
 * top-level `types`/`typings`.
 */
const declarationRoots = (manifest) => {
  const roots = [];
  const visit = (entry, target) => {
    if (typeof target === 'string') {
      if (isDeclarationPath(target)) roots.push({ entry, path: normalizePackedPath(target) });
    } else if (Array.isArray(target)) {
      for (const item of target) visit(entry, item);
    } else if (isRecord(target)) {
      for (const [key, value] of Object.entries(target)) visit(key.startsWith('.') ? key : entry, value);
    }
  };
  visit('.', manifest.exports);
  for (const field of ['types', 'typings']) {
    if (typeof manifest[field] === 'string') visit(field, manifest[field]);
  }
  return roots;
};

/**
 * Packed paths TypeScript would try for a relative specifier written in a
 * declaration: `./x.js`, `./x.ts` (tsgo keeps the source extension), and
 * `./x.tsx` map to `x.d.ts`, `.mjs`/`.mts` to `.d.mts`, `.cjs`/`.cts` to
 * `.d.cts`; an extensionless specifier tries the file then the directory
 * index; a `.json` or explicit declaration path is taken as written.
 */
const relativeTargets = (fromPath, specifier) => {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (isDeclarationPath(base) || base.endsWith('.json')) return [base];
  const extension = /\.([cm]?)[jt]sx?$/u.exec(base);
  if (extension !== null) {
    return [`${base.slice(0, -extension[0].length)}.d.${extension[1]}ts`];
  }
  return ['', '/index'].flatMap((suffix) => ['ts', 'mts', 'cts'].map((flavor) => `${base}${suffix}.d.${flavor}`));
};

const declaredPackages = (manifest) => ({
  dev: new Set(Object.keys(manifest.devDependencies ?? {})),
  runtime: new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]),
});

/** `node` → `@types/node`; `@scope/name` → `@types/scope__name` (DefinitelyTyped's mangling). */
const typesPackageOf = (name) => (name.startsWith('@')
  ? `@types/${name.slice(1).replace('/', '__')}`
  : `@types/${name}`);

const hasScheme = (specifier) => /^[a-z][a-z0-9+.-]*:/iu.test(specifier);

/**
 * Classifies one specifier against the manifest and the tarball. Returns
 * `undefined` when a consumer resolves it, otherwise the violation reason and
 * message.
 */
const classifySpecifier = ({ declared, manifest, packed, path, specifier }) => {
  const { kind, specifier: target } = specifier;
  if (kind === 'path-reference' || target.startsWith('./') || target.startsWith('../')) {
    const candidates = kind === 'path-reference'
      ? [posix.normalize(posix.join(posix.dirname(path), target))]
      : relativeTargets(path, target);
    if (candidates.some((candidate) => packed.has(candidate))) return undefined;
    return {
      message: `no packed declaration for "${target}" (tried ${candidates.join(', ')})`,
      reason: 'missing-target',
    };
  }
  if (kind === 'types-reference') {
    const candidates = [target, typesPackageOf(target)];
    if (candidates.some((candidate) => declared.runtime.has(candidate))) return undefined;
    const dev = candidates.find((candidate) => declared.dev.has(candidate));
    return dev === undefined
      ? {
          message: `references types "${target}" — neither "${target}" nor "${typesPackageOf(target)}" is declared in `
            + 'dependencies, peerDependencies, or optionalDependencies',
          reason: 'undeclared',
        }
      : { message: `references types "${target}" — "${dev}" is a devDependency, so consumers do not install it`, reason: 'dev-dependency' };
  }
  if (target.startsWith('#')) {
    return isRecord(manifest.imports) && Object.keys(manifest.imports).length > 0
      ? undefined
      : { message: `imports "${target}" — the manifest has no "imports" map to resolve it`, reason: 'subpath-import' };
  }
  if (target.startsWith('/') || (hasScheme(target) && !target.startsWith('node:'))) {
    return { message: `imports "${target}" — an absolute path or URL cannot resolve in a consumer install`, reason: 'unresolvable' };
  }
  if (isBuiltin(target)) return undefined;
  const name = packageNameOf(target);
  if (name === manifest.name || declared.runtime.has(name)) return undefined;
  return declared.dev.has(name)
    ? { message: `imports "${target}" — "${name}" is a devDependency, so consumers do not install it`, reason: 'dev-dependency' }
    : {
        message: `imports "${target}" — "${name}" is not declared in dependencies, peerDependencies, or optionalDependencies`,
        reason: 'undeclared',
      };
};

/**
 * Checks every packed declaration against the manifest. `errors` are
 * violations a consumer can reach from `exports`/`types` (plus export targets
 * missing from the tarball); `warnings` are violations in internal
 * declarations no entry point reaches.
 */
export const declarationImportViolations = ({ declarations, manifest, packedPaths }) => {
  const packed = new Set(packedPaths.map(normalizePackedPath));
  const declared = declaredPackages(manifest);
  const specifiersByPath = new Map(declarations.map(({ path, text }) => [normalizePackedPath(path), declarationSpecifiers(text)]));
  const roots = declarationRoots(manifest);
  const errors = [];
  const warnings = [];

  const reachable = new Map();
  const pending = [];
  for (const root of roots) {
    if (!packed.has(root.path)) {
      errors.push({
        message: `exports["${root.entry}"] points at ${root.path}, which is not in the tarball`,
        path: root.path,
        reachableFrom: root.entry,
        reason: 'export-target-missing',
        specifier: root.path,
      });
      continue;
    }
    if (!reachable.has(root.path)) {
      reachable.set(root.path, root.entry);
      pending.push(root.path);
    }
  }
  while (pending.length > 0) {
    const path = pending.pop();
    const entry = reachable.get(path);
    for (const specifier of specifiersByPath.get(path) ?? []) {
      const relative = specifier.kind === 'path-reference'
        || specifier.specifier.startsWith('./')
        || specifier.specifier.startsWith('../');
      if (!relative) continue;
      const candidates = specifier.kind === 'path-reference'
        ? [posix.normalize(posix.join(posix.dirname(path), specifier.specifier))]
        : relativeTargets(path, specifier.specifier);
      const target = candidates.find((candidate) => specifiersByPath.has(candidate));
      if (target !== undefined && !reachable.has(target)) {
        reachable.set(target, entry);
        pending.push(target);
      }
    }
  }

  for (const [path, specifiers] of specifiersByPath) {
    for (const specifier of specifiers) {
      const verdict = classifySpecifier({ declared, manifest, packed, path, specifier });
      if (verdict === undefined) continue;
      const reachableFrom = reachable.get(path);
      const violation = {
        line: specifier.line,
        message: verdict.message,
        path,
        reachableFrom,
        reason: verdict.reason,
        specifier: specifier.specifier,
      };
      (reachableFrom === undefined ? warnings : errors).push(violation);
    }
  }
  const byLocation = (left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0);
  return {
    declarationCount: specifiersByPath.size,
    errors: errors.sort(byLocation),
    reachable: new Set(reachable.keys()),
    roots,
    warnings: warnings.sort(byLocation),
  };
};

/** Reads every declaration the inventory lists from the package directory and checks it. */
export const checkPackedDeclarations = async ({ manifest, packageDirectory, packedPaths, readFile = readFileFromDisk }) => {
  const declarations = await Promise.all(packedPaths
    .filter((path) => isDeclarationPath(path))
    .map(async (path) => ({ path, text: await readFile(join(packageDirectory, path), 'utf8') })));
  return declarationImportViolations({ declarations, manifest, packedPaths });
};

/** The paths `npm pack` would ship for the package, selected by name from the workspace-aware output. */
export const packedPaths = async (packageDirectory, manifest) => {
  const { stdout } = await execFile(npm, ['pack', '--dry-run', '--json'], {
    cwd: packageDirectory,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  const files = packOutputFromJson(stdout, manifest.name).files;
  if (!Array.isArray(files)) {
    throw new TypeError(`npm pack --dry-run --json for ${manifest.name} listed no files.`);
  }
  return files.map((file) => file.path);
};

export const formatDeclarationImportReport = (name, report, { strict = false } = {}) => {
  const failing = strict ? [...report.errors, ...report.warnings] : report.errors;
  const advisory = strict ? [] : report.warnings;
  const lines = [
    `${name}: ${String(report.declarationCount)} packed declarations, ${String(report.reachable.size)} reachable from `
      + `${String(report.roots.length)} export entries; ${String(failing.length)} errors, ${String(advisory.length)} warnings`,
  ];
  const location = (violation) => (violation.line === undefined ? violation.path : `${violation.path}:${String(violation.line)}`);
  for (const violation of failing) {
    const via = violation.reachableFrom === undefined ? 'internal declaration' : `reachable from exports["${violation.reachableFrom}"]`;
    lines.push(`  error   ${location(violation)} ${violation.message} (${via})`);
  }
  for (const violation of advisory) {
    lines.push(`  warning ${location(violation)} ${violation.message} (internal declaration; no export reaches it)`);
  }
  return lines;
};

const parseArguments = (argv) => {
  const options = { packageDirectories: [], strict: false };
  for (const argument of argv) {
    if (argument === '--strict') options.strict = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown argument: ${argument}`);
    else options.packageDirectories.push(argument);
  }
  if (options.packageDirectories.length === 0) {
    throw new Error('Usage: node scripts/check-declaration-imports.mjs [--strict] <package-dir>...');
  }
  return options;
};

/** Runs the gate for each package directory; resolves to the process exit code. */
export const runCheckDeclarationImports = async ({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  inventory = packedPaths,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) => {
  const options = parseArguments(argv);
  let failed = false;
  for (const directory of options.packageDirectories) {
    const packageDirectory = resolve(cwd, directory);
    const manifest = JSON.parse(await readFileFromDisk(join(packageDirectory, 'package.json'), 'utf8'));
    const paths = await inventory(packageDirectory, manifest);
    const report = await checkPackedDeclarations({ manifest, packageDirectory, packedPaths: paths });
    for (const line of formatDeclarationImportReport(manifest.name, report, options)) log(line);
    if (report.errors.length > 0 || (options.strict && report.warnings.length > 0)) failed = true;
  }
  return failed ? 1 : 0;
};

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runCheckDeclarationImports();
}
