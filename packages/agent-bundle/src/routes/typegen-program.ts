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
 * The entries whose declarations the generated file augments or narrows:
 * a program that imports one of them observes the registration, and one that
 * omits the file type-checks those imports with `string` ids and `unknown`
 * input/result/provider values, silently. Route modules import
 * `@agent-bundle/runtime` (providers), App views `agent-bundle/app`, tests
 * `agent-bundle/test` and `agent-bundle/eval`. Exact specifiers: no other
 * entry (`agent-bundle/test/browser`, `agent-bundle/routes`) reads the
 * registration.
 */
const consumerEntries: ReadonlySet<string> = new Set(['agent-bundle/app', 'agent-bundle/eval', 'agent-bundle/test', '@agent-bundle/runtime']);

const comparablePath = (path: string): string => {
  const resolved = resolve(path);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
};

interface Program {
  readonly fileNames: readonly string[];
  /** Whether the config file itself declares `include` (not inherited through `extends`, not the `**` default). */
  readonly ownInclude: boolean;
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
  // Read before parsing: the parser writes the inherited `include` back onto the raw config.
  const ownInclude = Array.isArray((read.config as { readonly include?: unknown }).include);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    resolve(tsconfigPath, '..'),
    undefined,
    tsconfigPath,
  );
  return {
    fileNames: parsed.fileNames,
    ownInclude,
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

/**
 * Whether one of the program's root files imports an entry the generated
 * declaration augments. The scanner's import pre-processing reads static and
 * dynamic import specifiers only — a specifier in a comment or a string
 * literal is not an import — and a user's own `.d.ts` counts like any other
 * root file, since `import type` from a consumer entry reads the registration too.
 */
const consumesRegistration = (fileNames: readonly string[]): boolean =>
  fileNames.some((fileName) =>
    ts.preProcessFile(ts.sys.readFile(fileName) ?? '', true, false).importedFiles
      .some((imported) => consumerEntries.has(imported.fileName)));

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
      const include = JSON.stringify(relative(dirname(candidate.tsconfigPath), routeTypesPath).replaceAll('\\', '/'));
      // An `include` array replaces the default (`**/*`) or the inherited
      // patterns, so a config without its own must keep them when it adds one.
      const where = candidate.ownInclude
        ? `Add ${include} to the "include" array of ${tsconfig}`
        : `Add ${include} to the "include" array of the config ${tsconfig} extends, or declare an "include" array in ${tsconfig} that lists ${include} beside the patterns it compiles today (the default is "**/*")`;
      return {
        code: 'AB4834',
        message: `${tsconfig} imports agent-bundle/app, agent-bundle/test, agent-bundle/eval, or @agent-bundle/runtime but does not include the generated ${routeTypesRelativePath}, so that program type-checks route ids as string and input/result/provider values as unknown.`,
        recovery: `${where}; agent-bundle validate, build, and dev keep the file current, and it stays gitignored.`,
        severity: 'warning',
        sourcePath: candidate.tsconfigPath,
      };
    });
};
