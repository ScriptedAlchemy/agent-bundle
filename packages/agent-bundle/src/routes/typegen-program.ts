import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Aliased: the workspace toolchain is typescript@7 (native compiler, no
// single-file parse API), and a plain `typescript` dependency here would
// shadow it for rslib's declaration generation. The alias ships the 5.x
// compiler API for config parsing only.
import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { routeTypesRelativePath } from './typegen.ts';

/** The file `tsc -p` and every editor read as the project's TypeScript program. */
const projectTsconfigFilename = 'tsconfig.json';

/**
 * The modules whose declarations the generated file augments or narrows:
 * a program that imports one of them observes the registration, and one that
 * omits the file type-checks those imports with `string` ids and `unknown`
 * input/result/provider values, silently. Route modules import
 * `@agent-bundle/runtime` (providers), App views `agent-bundle/app`, tests
 * `agent-bundle/test` and `agent-bundle/eval`.
 */
const consumerImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](?:agent-bundle\/(?:app|eval|test)|@agent-bundle\/runtime)(?:\/[^'"]*)?['"]/;

const comparablePath = (path: string): string => {
  const resolved = resolve(path);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
};

interface Program {
  readonly fileNames: readonly string[];
  readonly references: readonly string[];
  readonly tsconfigPath: string;
}

/**
 * The root file names of one tsconfig's program, resolved the way `tsc -p`
 * resolves them (`extends`, `files`, `include`, `exclude`, against the real
 * file system), plus the referenced projects a solution-style root delegates
 * to. `undefined` when the file cannot be read or parsed as a config: `tsc`
 * reports that failure itself, and a broken tsconfig has no program to be
 * missing from.
 */
const program = (tsconfigPath: string): Program | undefined => {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error !== undefined || read.config === undefined) return undefined;
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    resolve(tsconfigPath, '..'),
    undefined,
    tsconfigPath,
  );
  return {
    fileNames: parsed.fileNames,
    references: (parsed.projectReferences ?? []).map((reference) => ts.resolveProjectReferencePath(reference)),
    tsconfigPath,
  };
};

/** The root program and every program it references, transitively, each once. */
const programs = (rootTsconfigPath: string): readonly Program[] => {
  const seen = new Set<string>();
  const found: Program[] = [];
  const visit = (tsconfigPath: string): void => {
    const key = comparablePath(tsconfigPath);
    if (seen.has(key) || !existsSync(tsconfigPath)) return;
    seen.add(key);
    const resolved = program(tsconfigPath);
    if (resolved === undefined) return;
    found.push(resolved);
    resolved.references.forEach(visit);
  };
  visit(rootTsconfigPath);
  return found;
};

/** Whether one of the program's own source files imports a module the generated declaration augments. */
const consumesRegistration = (fileNames: readonly string[]): boolean =>
  fileNames.some((fileName) => !fileName.endsWith('.d.ts') && consumerImport.test(ts.sys.readFile(fileName) ?? ''));

/**
 * AB4834: the generated `.agent-bundle/routes.d.ts` registers the project's
 * route contracts and provider keys on `@agent-bundle/runtime`,
 * `agent-bundle/app`, and the harness modules, but only a TypeScript program
 * that compiles the file observes them. Reported once the declaration has
 * been published (a route-free, provider-free project has no file to include)
 * for every program of the root `tsconfig.json` — its own or, for a
 * solution-style root, any project it references, transitively — that
 * imports one of those modules and does not compile the file. A program that
 * imports none of them is not a consumer and is left alone, and a project
 * without a root `tsconfig.json` has no program to check.
 */
export const routeTypesProgramDiagnostics = (projectRoot: string): readonly Diagnostic[] => {
  const routeTypesPath = join(projectRoot, routeTypesRelativePath);
  const rootTsconfigPath = join(projectRoot, projectTsconfigFilename);
  if (!existsSync(routeTypesPath) || !existsSync(rootTsconfigPath)) return [];
  const expected = comparablePath(routeTypesPath);
  return programs(rootTsconfigPath)
    .filter((candidate) =>
      !candidate.fileNames.some((fileName) => comparablePath(fileName) === expected)
      && consumesRegistration(candidate.fileNames))
    .map((candidate) => {
      const tsconfig = relative(projectRoot, candidate.tsconfigPath).replaceAll('\\', '/');
      const include = relative(dirname(candidate.tsconfigPath), routeTypesPath).replaceAll('\\', '/');
      return {
        code: 'AB4834',
        message: `${tsconfig} imports agent-bundle/app, agent-bundle/test, agent-bundle/eval, or @agent-bundle/runtime but does not include the generated ${routeTypesRelativePath}, so that program type-checks route ids as string and input/result/provider values as unknown.`,
        recovery: `Add ${JSON.stringify(include)} to the "include" array of ${tsconfig}; agent-bundle validate, build, and dev keep the file current, and it stays gitignored.`,
        severity: 'warning',
        sourcePath: candidate.tsconfigPath,
      };
    });
};
