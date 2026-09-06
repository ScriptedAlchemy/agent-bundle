import { DiagnosticError } from '../core/diagnostics.ts';
import type { CompileResult } from './compile-result.ts';
import { selfContainmentDiagnostics } from './external-policy.ts';
import {
  buildRslibSurfaces,
  type RslibDependencies,
  type RslibRunOptions,
  type RslibSurface,
} from './rslib.ts';

export interface RslibSurfacePlan<Result> extends RslibSurface {
  readonly finish: (result: CompileResult) => Promise<Result>;
}

export const settledRslibSurface = <Result>(result: Result): RslibSurfacePlan<Result> => ({
  entries: Object.freeze([]),
  finish: async () => result,
});

const enforceSelfContainment = (
  results: readonly CompileResult[],
  diagnosticPathPrefix?: string,
): void => {
  const violations = results.flatMap((result) => selfContainmentDiagnostics(
    diagnosticPathPrefix === undefined
      ? result
      : {
        ...result,
        externals: result.externals.map((external) => ({
          ...external,
          asset: `${diagnosticPathPrefix}/${external.asset}`,
        })),
      },
  ));
  if (violations.length > 0) throw new DiagnosticError(violations);
};

export const compileRslibSurfaces = async <const Plans extends readonly RslibSurfacePlan<unknown>[]>(
  options: RslibRunOptions,
  plans: Plans,
): Promise<{
  readonly compileResults: readonly CompileResult[];
  readonly results: { readonly [Index in keyof Plans]: Plans[Index] extends RslibSurfacePlan<infer Result> ? Result : never };
}> => {
  const compileResults = await buildRslibSurfaces(options, plans);
  enforceSelfContainment(compileResults);
  const results: unknown[] = [];
  for (const [index, plan] of plans.entries()) {
    results.push(await plan.finish(compileResults[index]!));
  }
  return {
    compileResults,
    results: results as { readonly [Index in keyof Plans]: Plans[Index] extends RslibSurfacePlan<infer Result> ? Result : never },
  };
};

export const buildWithRslib = async (
  options: RslibRunOptions & RslibSurface & { readonly diagnosticPathPrefix?: string },
  dependencies: RslibDependencies = {},
): Promise<CompileResult> => {
  const { diagnosticPathPrefix, entries, ignoredSourcePaths, logLevel, ...run } = options;
  const [result] = await buildRslibSurfaces(run, [{
    entries,
    ...(ignoredSourcePaths === undefined ? {} : { ignoredSourcePaths }),
    ...(logLevel === undefined ? {} : { logLevel }),
  }], dependencies);
  enforceSelfContainment([result!], diagnosticPathPrefix);
  return result!;
};
