import { resolve } from 'node:path';

import fastGlob from 'fast-glob';

import { normalizeEvalConfig, type NormalizedEvalConfig } from './config.ts';
import { EvalDiscoveryError } from './errors.ts';
import { parseEvalSuite } from './suite.ts';
import type { EvalSuite } from './types.ts';

export interface FindEvalSuiteFilesOptions {
  readonly config?: NormalizedEvalConfig;
  readonly projectRoot: string;
}

export interface DiscoverEvalSuitesOptions extends FindEvalSuiteFilesOptions {
  /** @internal Deterministic module-loading seam for tests and alternative loaders. */
  readonly importSuiteModule?: (sourcePath: string) => Promise<unknown>;
}

export interface DiscoveredEvalSuite {
  readonly sourcePath: string;
  readonly suite: EvalSuite;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Author suites are TypeScript modules, so they are loaded through the already vendored Jiti runtime. */
const importSuiteModuleWithJiti = async (sourcePath: string): Promise<unknown> => {
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return jiti.import(sourcePath);
};

export const findEvalSuiteFiles = async (
  options: FindEvalSuiteFilesOptions,
): Promise<readonly string[]> => {
  const config = options.config ?? normalizeEvalConfig(undefined);
  const projectRoot = resolve(options.projectRoot);
  const matches = await fastGlob([...config.include], {
    absolute: true,
    cwd: projectRoot,
    dot: false,
    followSymbolicLinks: false,
    onlyFiles: true,
  });
  return Object.freeze([...new Set(matches)].sort((left, right) => left.localeCompare(right)));
};

export const loadEvalSuite = async (
  sourcePath: string,
  importSuiteModule: (path: string) => Promise<unknown> = importSuiteModuleWithJiti,
): Promise<DiscoveredEvalSuite> => {
  let moduleValue: unknown;
  try {
    moduleValue = await importSuiteModule(sourcePath);
  } catch (error) {
    throw new EvalDiscoveryError(
      'EVAL_SUITE_LOAD_FAILED',
      `Eval suite module failed to load: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath,
    );
  }
  const exported = isRecord(moduleValue) && 'default' in moduleValue ? moduleValue.default : moduleValue;
  try {
    return Object.freeze({ sourcePath, suite: parseEvalSuite(exported) });
  } catch (error) {
    throw new EvalDiscoveryError(
      'EVAL_SUITE_EXPORT_INVALID',
      `Eval suite module must default-export defineEvalSuite output: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath,
    );
  }
};

export const discoverEvalSuites = async (
  options: DiscoverEvalSuitesOptions,
): Promise<readonly DiscoveredEvalSuite[]> => {
  const files = await findEvalSuiteFiles(options);
  const discovered: DiscoveredEvalSuite[] = [];
  const names = new Map<string, string>();
  for (const sourcePath of files) {
    const entry = await loadEvalSuite(sourcePath, options.importSuiteModule);
    const previous = names.get(entry.suite.name);
    if (previous !== undefined) {
      throw new EvalDiscoveryError(
        'EVAL_SUITE_DUPLICATE',
        `Eval suites ${JSON.stringify(previous)} and ${JSON.stringify(sourcePath)} declare the same name ${JSON.stringify(entry.suite.name)}.`,
        sourcePath,
      );
    }
    names.set(entry.suite.name, sourcePath);
    discovered.push(entry);
  }
  return Object.freeze(discovered);
};
