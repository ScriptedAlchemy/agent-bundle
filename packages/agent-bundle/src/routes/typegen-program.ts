import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Aliased: the workspace toolchain is typescript@7 (native compiler, no
// single-file parse API), and a plain `typescript` dependency here would
// shadow it for rslib's declaration generation. The alias ships the 5.x
// compiler API for config parsing only.
import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { routeTypesRelativePath } from './typegen.ts';

/** The file `tsc -p` and every editor read as the project's TypeScript program. */
const projectTsconfigFilename = 'tsconfig.json';

const comparablePath = (path: string): string => {
  const resolved = resolve(path);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
};

/**
 * The root file names of one tsconfig's program, resolved the way `tsc -p`
 * resolves them (`extends`, `files`, `include`, `exclude`, against the real
 * file system), plus the referenced projects a solution-style root delegates
 * to. `undefined` when the file cannot be read or parsed as a config: `tsc`
 * reports that failure itself, and a broken tsconfig has no program to be
 * missing from.
 */
const programRootFiles = (
  tsconfigPath: string,
): { readonly fileNames: readonly string[]; readonly references: readonly string[] } | undefined => {
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
  };
};

/**
 * AB4834: the generated `.agent-bundle/routes.d.ts` registers the project's
 * route contracts and provider keys on `@agent-bundle/runtime`, but only a
 * TypeScript program that compiles the file observes them — a program that
 * leaves it out type-checks `renderRoute` ids as `string` and `input` /
 * `result` as `unknown`, silently. Reported once the declaration has been
 * published (a route-free, provider-free project has no file to include) for a
 * project whose root `tsconfig.json` program — its own root files or, for a
 * solution-style root, one of its referenced projects — does not compile it.
 * A project without a root `tsconfig.json` has no program to check.
 */
export const routeTypesProgramDiagnostics = (projectRoot: string): readonly Diagnostic[] => {
  const routeTypesPath = join(projectRoot, routeTypesRelativePath);
  const tsconfigPath = join(projectRoot, projectTsconfigFilename);
  if (!existsSync(routeTypesPath) || !existsSync(tsconfigPath)) return [];
  const root = programRootFiles(tsconfigPath);
  if (root === undefined) return [];
  const expected = comparablePath(routeTypesPath);
  const compiles = (fileNames: readonly string[]): boolean =>
    fileNames.some((fileName) => comparablePath(fileName) === expected);
  if (compiles(root.fileNames)) return [];
  for (const reference of root.references) {
    const referenced = existsSync(reference) ? programRootFiles(reference) : undefined;
    if (referenced !== undefined && compiles(referenced.fileNames)) return [];
  }
  return [{
    code: 'AB4834',
    message: `${projectTsconfigFilename} does not include the generated ${routeTypesRelativePath}, so renderRoute and renderRouteEvents type-check route ids as string and input/result as unknown.`,
    recovery: `Add ${JSON.stringify(routeTypesRelativePath)} to the "include" array of ${projectTsconfigFilename}; agent-bundle build, dev, and validate keep the file current, and it stays gitignored.`,
    severity: 'warning',
    sourcePath: tsconfigPath,
  }];
};
