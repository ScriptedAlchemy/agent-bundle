import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Hex } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readFileBytes, runWithPlatform } from '../effect/platform.ts';
import { artifactDiagnostic as diagnostic, artifactDiagnosticRecoveries } from './artifact-diagnostics.ts';
import type { ArtifactFile } from './emit.ts';
import { isAllowedExternalRequest } from './external-policy.ts';
import { readModuleImports, type ModuleImport, type ModuleSyntaxCheck } from './module-imports.ts';

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

const resolveJavaScriptImport = async (options: {
  readonly artifactRoot: string;
  readonly files: ReadonlyMap<string, ArtifactFile>;
  /** The importing module, relative to `artifactRoot`. */
  readonly importer: string;
  /** How diagnostics name the importer (see `reportedRoot`). */
  readonly reportedImporter: string;
  readonly specifier: string;
  readonly validJson: ReadonlySet<string>;
}): Promise<{ readonly diagnostic?: Diagnostic; readonly module?: string }> => {
  const importer = options.reportedImporter;
  if (isAllowedExternalRequest(options.specifier)) return {};
  if (!options.specifier.startsWith('.') && !options.specifier.startsWith('file:')) {
    return { diagnostic: graphDiagnostic(importer, `uses unsupported specifier ${JSON.stringify(options.specifier)}.`) };
  }

  let url: URL;
  try {
    url = new URL(options.specifier, pathToFileURL(resolve(options.artifactRoot, options.importer)));
  } catch {
    return { diagnostic: graphDiagnostic(importer, `uses invalid specifier ${JSON.stringify(options.specifier)}.`) };
  }
  if (url.protocol !== 'file:' || url.search.length > 0 || url.hash.length > 0) {
    return { diagnostic: graphDiagnostic(importer, `uses unsupported specifier ${JSON.stringify(options.specifier)}.`) };
  }

  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return { diagnostic: graphDiagnostic(importer, `uses invalid file URL ${JSON.stringify(options.specifier)}.`) };
  }
  if (artifactPathFor(options.artifactRoot, path) === undefined) {
    return { diagnostic: graphDiagnostic(importer, `resolves outside the artifact root: ${JSON.stringify(options.specifier)}.`) };
  }

  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    return { diagnostic: graphDiagnostic(importer, `is missing ${JSON.stringify(options.specifier)}.`) };
  }
  if (!metadata.isFile()) {
    return { diagnostic: graphDiagnostic(importer, `does not resolve to a regular file: ${JSON.stringify(options.specifier)}.`) };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    return { diagnostic: graphDiagnostic(importer, `is missing ${JSON.stringify(options.specifier)}.`) };
  }
  const artifactPath = artifactPathFor(options.artifactRoot, canonicalPath);
  if (artifactPath === undefined) {
    return { diagnostic: graphDiagnostic(importer, `resolves outside the artifact root: ${JSON.stringify(options.specifier)}.`) };
  }
  if (!options.files.has(artifactPath)) {
    return { diagnostic: graphDiagnostic(importer, `is not listed in the artifact manifest: ${JSON.stringify(options.specifier)}.`) };
  }
  if (jsonModuleSuffix.test(artifactPath)) {
    return options.validJson.has(artifactPath)
      ? {}
      : { diagnostic: graphDiagnostic(importer, `references invalid JSON ${JSON.stringify(options.specifier)}.`) };
  }
  if (!javaScriptModuleSuffix.test(artifactPath)) {
    return { diagnostic: graphDiagnostic(importer, `uses unsupported target ${JSON.stringify(options.specifier)}.`) };
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
    // Keyed by the digest of the bytes just read — not the inspection's — so
    // a module rewritten between the two is never answered from the cache,
    // while the same bytes scanned earlier in this process are not lexed twice.
    let imports: readonly ModuleImport[];
    try {
      imports = await readModuleImports(bytes.toString('utf8'), { check, sha256: sha256Hex(bytes) });
    } catch {
      diagnostics.push(graphDiagnostic(reported(path), 'has invalid syntax.'));
      visiting.delete(path);
      visited.add(path);
      return;
    }
    for (const imported of imports) {
      if (imported.kind === 'meta') continue;
      if (imported.specifier === undefined) {
        diagnostics.push(graphDiagnostic(reported(path), 'has a non-literal dynamic import.'));
        continue;
      }
      const resolved = await resolveJavaScriptImport({
        artifactRoot,
        files,
        importer: path,
        reportedImporter: reported(path),
        specifier: imported.specifier,
        validJson: options.validJson,
      });
      if (resolved.diagnostic !== undefined) diagnostics.push(resolved.diagnostic);
      else if (resolved.module !== undefined) await validateModule(resolved.module);
    }
    visiting.delete(path);
    visited.add(path);
  };

  for (const path of [...files.keys()].filter((path) => javaScriptModuleSuffix.test(path)).sort((left, right) => left.localeCompare(right))) {
    await validateModule(path);
  }
  return Object.freeze(diagnostics);
};
