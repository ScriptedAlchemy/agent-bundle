import { lstat, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Hex } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readFileBytes, runWithPlatform } from '../effect/platform.ts';
import { artifactDiagnostic as diagnostic, artifactDiagnosticRecoveries } from './artifact-diagnostics.ts';
import type { ArtifactFile } from './emit.ts';
import { readModuleImports, type ModuleImport, type ModuleSyntaxCheck } from './module-imports.ts';
import { scanModuleLoads, type ComputedModuleLoad, type LiteralModuleLoad } from './module-loads.ts';

/**
 * `AB6005`: the JavaScript modules an artifact — or a package build's staged
 * `dist` — ships resolve nothing from outside their tree but Node built-ins.
 * Every listed `.js`/`.mjs` module is walked, and every `.js`/`.mjs` module
 * a walked one reaches: its `import` records as the ES-module lexer reports
 * them, static and dynamic, and its recognised loads as `scanModuleLoads`
 * reports them — `require(…)`, `require.resolve(…)`,
 * `createRequire(…)(…)`/`.resolve(…)` (factory written out,
 * namespace-qualified, or aliased), a loader bound by
 * `const|let|var name = createRequire(…)` then called, and
 * `import.meta.resolve(…)`; optional `?.(` and a trailing comma count the
 * same. Compiled bundles and the framework-generated modules parsed in full
 * are read the same way; prebuilt payload modules are opaque consumer output
 * and are not walked. A relative or `file:` specifier, imported or loaded,
 * must name a listed regular `.js`/`.mjs` module inside the tree, which is
 * walked in turn, or listed valid JSON (host packs only), which is accepted
 * as a terminal and is not walked; a bare name that is not a built-in, a
 * non-literal specifier, or a loader name used as a value (argument, array
 * element, object-literal value, ternary branch, return/arrow value,
 * assignment right-hand side, export — not a binding position: parameter,
 * `catch`, destructuring pattern, import specifier) is a finding.
 */

const javaScriptModuleSuffix = /\.(?:m?js)$/u;
const generatedJavaScriptRecovery = artifactDiagnosticRecoveries.AB6005;

const jsonModuleSuffix = /\.json$/u;

const artifactPathFor = (root: string, path: string): string | undefined => {
  const artifactPath = relative(root, path).replaceAll('\\', '/');
  return artifactPath === '' || artifactPath === '..' || artifactPath.startsWith('../') || isAbsolute(artifactPath)
    ? undefined
    : artifactPath;
};

const graphDiagnostic = (importer: string, message: string): Diagnostic => diagnostic(
  'AB6005',
  `Generated JavaScript import from ${JSON.stringify(importer)} ${message}`,
  importer,
  undefined,
  generatedJavaScriptRecovery,
);

/**
 * How a load names itself in an `AB6005` message — the call as written, its
 * argument the literal specifier or `…` when computed: `require("left-pad")`,
 * `mk(…).resolve(…)`, `load("left-pad"), a createRequire(…) loader`,
 * `import.meta.resolve(…)`.
 */
const loadCall = (load: LiteralModuleLoad | ComputedModuleLoad): string => {
  const argument = load.kind === 'literal' ? JSON.stringify(load.specifier) : '…';
  switch (load.form) {
    case 'require': return `${load.loader}(${argument})`;
    case 'require.resolve': return `${load.loader}.resolve(${argument})`;
    case 'createRequire': return `${load.loader}(…)(${argument})`;
    case 'createRequire.resolve': return `${load.loader}(…).resolve(${argument})`;
    case 'bound-loader': return `${load.loader}(${argument}), a createRequire(…) loader`;
    case 'bound-loader.resolve': return `${load.loader}.resolve(${argument}), a createRequire(…) loader`;
    case 'import.meta.resolve': return `${load.loader}.resolve(${argument})`;
    default: {
      const exhaustive: never = load.form;
      return exhaustive;
    }
  }
};

/**
 * Where one specifier of a walked module leads: nowhere to walk (a built-in
 * or valid JSON), a listed module to walk next, or a diagnostic. An import's
 * message names the specifier alone; a load's (`via`) names the call it is
 * the argument of, so `is missing "./driver.cjs"` becomes `is missing
 * "./driver.cjs" in require("./driver.cjs")`.
 */
const resolveJavaScriptImport = async (options: {
  readonly artifactRoot: string;
  readonly files: ReadonlyMap<string, ArtifactFile>;
  /** The importing module, relative to `artifactRoot`. */
  readonly importer: string;
  /** How diagnostics name the importer (see `reportedRoot`). */
  readonly reportedImporter: string;
  readonly specifier: string;
  readonly validJson: ReadonlySet<string>;
  /** The load call the specifier is the argument of (`loadCall`), when it is a load's rather than an import's. */
  readonly via?: string;
}): Promise<{ readonly diagnostic?: Diagnostic; readonly module?: string }> => {
  const importer = options.reportedImporter;
  const specifier = JSON.stringify(options.specifier);
  const failure = (message: string): { readonly diagnostic: Diagnostic } => ({
    diagnostic: graphDiagnostic(importer, options.via === undefined ? `${message}.` : `${message} in ${options.via}.`),
  });
  if (isBuiltin(options.specifier)) return {};
  if (!options.specifier.startsWith('.') && !options.specifier.startsWith('file:')) {
    return failure(`uses unsupported specifier ${specifier}`);
  }

  let url: URL;
  try {
    url = new URL(options.specifier, pathToFileURL(resolve(options.artifactRoot, options.importer)));
  } catch {
    return failure(`uses invalid specifier ${specifier}`);
  }
  if (url.protocol !== 'file:' || url.search.length > 0 || url.hash.length > 0) {
    return failure(`uses unsupported specifier ${specifier}`);
  }

  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return failure(`uses invalid file URL ${specifier}`);
  }
  if (artifactPathFor(options.artifactRoot, path) === undefined) {
    return failure(`resolves outside the artifact root: ${specifier}`);
  }

  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    return failure(`is missing ${specifier}`);
  }
  if (!metadata.isFile()) {
    return failure(`does not resolve to a regular file: ${specifier}`);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    return failure(`is missing ${specifier}`);
  }
  const artifactPath = artifactPathFor(options.artifactRoot, canonicalPath);
  if (artifactPath === undefined) {
    return failure(`resolves outside the artifact root: ${specifier}`);
  }
  if (!options.files.has(artifactPath)) {
    return failure(`is not listed in the artifact manifest: ${specifier}`);
  }
  if (jsonModuleSuffix.test(artifactPath)) {
    return options.validJson.has(artifactPath) ? {} : failure(`references invalid JSON ${specifier}`);
  }
  if (!javaScriptModuleSuffix.test(artifactPath)) {
    return failure(`uses unsupported target ${specifier}`);
  }
  return { module: artifactPath };
};

export const validateJavaScriptModules = async (options: {
  readonly artifactRoot: string;
  /**
   * Modules the framework compiled (manifest kind `bundle`), checked at
   * `bundleSyntaxCheck`; every other module is parsed in full (`parsed`).
   */
  readonly bundledPaths?: ReadonlySet<string>;
  /** How a bundled module's syntax is checked; `lexed` unless a caller knows the bundler output may have been rewritten. */
  readonly bundleSyntaxCheck?: ModuleSyntaxCheck;
  readonly files: readonly ArtifactFile[];
  readonly manifestFiles?: ReadonlySet<string>;
  /** Prebuilt payload files: opaque consumer outputs excluded from graph validation. */
  readonly prebuiltPaths?: ReadonlySet<string>;
  /**
   * POSIX directory under which diagnostics name the validated modules, for
   * a tree validated before it is published under another path: the package
   * build walks its staged output and reports `dist/bin/<name>.js`, the path
   * a consumer sees, rather than the stage-relative `bin/<name>.js`. Absent
   * for the artifact, whose diagnostics name artifact-relative paths.
   */
  readonly reportedRoot?: string;
  readonly validJson: ReadonlySet<string>;
}): Promise<readonly Diagnostic[]> => {
  const artifactRoot = await realpath(options.artifactRoot);
  const files = new Map(options.files
    .filter((file) => options.manifestFiles === undefined || options.manifestFiles.has(file.path))
    .map((file) => [file.path, file]));
  const reported = (path: string): string => (options.reportedRoot === undefined ? path : `${options.reportedRoot}/${path}`);
  const diagnostics: Diagnostic[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const validateModule = async (path: string): Promise<void> => {
    if (visited.has(path) || visiting.has(path)) return;
    if (options.prebuiltPaths?.has(path) === true) {
      visited.add(path);
      return;
    }
    visiting.add(path);
    const check = options.bundledPaths?.has(path) === true ? options.bundleSyntaxCheck ?? 'lexed' : 'parsed';
    let bytes: Buffer;
    try {
      bytes = await runWithPlatform(readFileBytes(resolve(artifactRoot, path)));
    } catch {
      diagnostics.push(graphDiagnostic(reported(path), 'cannot be read.'));
      visiting.delete(path);
      visited.add(path);
      return;
    }
    // Both readers are keyed by the digest of the bytes just read — not the
    // inspection's — so a module rewritten between the two is never answered
    // from a cache, while the same bytes read earlier in this process are
    // neither lexed nor scanned twice.
    const source = bytes.toString('utf8');
    const sha256 = sha256Hex(bytes);
    let imports: readonly ModuleImport[];
    try {
      imports = await readModuleImports(source, { check, sha256 });
    } catch {
      diagnostics.push(graphDiagnostic(reported(path), 'has invalid syntax.'));
      visiting.delete(path);
      visited.add(path);
      return;
    }
    const follow = async (specifier: string, via?: string): Promise<void> => {
      const resolved = await resolveJavaScriptImport({
        artifactRoot,
        files,
        importer: path,
        reportedImporter: reported(path),
        specifier,
        validJson: options.validJson,
        ...(via === undefined ? {} : { via }),
      });
      if (resolved.diagnostic !== undefined) diagnostics.push(resolved.diagnostic);
      else if (resolved.module !== undefined) await validateModule(resolved.module);
    };
    for (const imported of imports) {
      if (imported.kind === 'meta') continue;
      if (imported.specifier === undefined) {
        diagnostics.push(graphDiagnostic(reported(path), 'has a non-literal dynamic import.'));
        continue;
      }
      await follow(imported.specifier);
    }
    // The loads the lexer does not report, held to the import rules: a literal
    // specifier resolves like an import's (a built-in passes, a relative one
    // is walked), a computed one and a loader passed on as a value are findings.
    for (const load of scanModuleLoads(source, { sha256 })) {
      switch (load.kind) {
        case 'literal':
          await follow(load.specifier, loadCall(load));
          break;
        case 'computed':
          diagnostics.push(graphDiagnostic(reported(path), `loads a non-literal specifier through ${loadCall(load)}.`));
          break;
        case 'reference':
          diagnostics.push(graphDiagnostic(
            reported(path),
            `passes ${load.form === 'require' ? load.loader : `${load.loader}, a createRequire(…) loader,`} on as a value instead of calling it.`,
          ));
          break;
        default: {
          const exhaustive: never = load;
          return exhaustive;
        }
      }
    }
    visiting.delete(path);
    visited.add(path);
  };

  for (const path of [...files.keys()].filter((path) => javaScriptModuleSuffix.test(path)).sort((left, right) => left.localeCompare(right))) {
    await validateModule(path);
  }
  return Object.freeze(diagnostics);
};
