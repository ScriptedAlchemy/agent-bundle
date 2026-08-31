// Rslib re-exports its own Rsbuild/Rspack stack (values and types alike);
// installing @rspack/core separately risks version conflicts
// (https://rslib.rs/api/javascript-api/core).
import { createRslib, mergeRslibConfig, type LibConfig, type Rspack } from '@rslib/core';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isErrno } from '../core/errors.ts';
import type { AgentBundleToolsConfig } from '../core/types.ts';
import { mcpEntryRuntimeSpecifier } from './entry-shell.ts';
import { collectBundledOutputEvidence, type BundledOutputEvidence } from './provenance.ts';

export interface RslibVirtualModule {
  readonly name: string;
  readonly source: string;
}

export interface RslibEntry {
  /**
   * Module specifiers aliased onto existing on-disk modules (e.g. the
   * mcp-entry runtime shell). Applied as exact-match (`$`) bundler aliases —
   * generated code imports exactly these specifiers — and reserved: the
   * consumer tools hatch may not externalize them.
   */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Raw JS banner prepended to the emitted bundle (e.g. a bin shebang). */
  readonly banner?: string;
  /** Emit type declarations for this entry's program. Defaults to false. */
  readonly dts?: boolean;
  readonly name: string;
  readonly outputRelativePath: string;
  readonly source: string;
  readonly sourceInputs: readonly string[];
  /** TypeScript project driving declaration generation and compiler options. */
  readonly tsconfigPath?: string;
  readonly virtualModules?: readonly RslibVirtualModule[];
  readonly virtualSource?: string;
}

type RslibInstance = Awaited<ReturnType<typeof createRslib>>;
type RslibLibConfig = LibConfig;
type RslibToolsRspack = NonNullable<NonNullable<LibConfig['tools']>['rspack']>;

interface RslibDependencies {
  readonly createRslib?: (options: Parameters<typeof createRslib>[0]) => Promise<Pick<RslibInstance, 'build' | 'inspectConfig'>>;
}

/**
 * The reserved directory (under each build's output root) where generated
 * module sources — wrapper entries and registry modules — are materialized
 * as real files for the duration of one Rslib build. Materialized files are
 * excluded from authored-source provenance and removed after the build, so
 * they never reach a published artifact.
 */
const generatedModulesDirname = '.agent-bundle-virtual';

/**
 * The tools escape hatch is typed against the workspace `@rsbuild/core` (the
 * engine of the MCP Apps path), while this build path executes under the
 * Rsbuild/Rspack copies nested in `@rslib/core` (the dual-engine reality
 * documented on {@link AgentBundleToolsConfig}). These two functions are the
 * single deliberate crossing between those type universes; everything else
 * in this module stays inside Rslib's own types.
 */
const asRslibEnvironmentFragment = (
  fragment: NonNullable<AgentBundleToolsConfig['rsbuild']>,
): Omit<RslibLibConfig, 'id'> => fragment as Omit<RslibLibConfig, 'id'>;
const asRslibRspackHatch = (
  hatch: NonNullable<AgentBundleToolsConfig['rspack']>,
): RslibToolsRspack => hatch as RslibToolsRspack;

const entryLibId = (entry: Pick<RslibEntry, 'name'>): string => `agent-bundle-${entry.name}`;

// join (not resolve) so `inspect --bundler`'s tokenized output roots
// (`<output>/<target>`) stay tokens instead of resolving against the cwd.
const generatedEntryModulePath = (outputRoot: string, entry: RslibEntry): string =>
  join(outputRoot, generatedModulesDirname, `${entry.name}-entry.mjs`);

const materializedVirtualModules = (
  outputRoot: string,
  entry: RslibEntry,
): readonly { readonly name: string; readonly path: string; readonly source: string }[] =>
  (entry.virtualModules ?? []).map((module, index) => ({
    ...module,
    path: join(outputRoot, generatedModulesDirname, `${entry.name}-${index}.mjs`),
  }));

/** Every generated module one entry materializes to disk for its build. */
const plannedGeneratedModules = (
  entry: RslibEntry,
  outputRoot: string,
): readonly { readonly path: string; readonly source: string }[] => [
  ...(entry.virtualSource === undefined
    ? []
    : [{ path: generatedEntryModulePath(outputRoot, entry), source: entry.virtualSource }]),
  ...materializedVirtualModules(outputRoot, entry).map(({ path, source }) => ({ path, source })),
];

/**
 * The module specifiers one entry's emitted bundle must inline: the runtime
 * shell alias targets and generated registry modules, plus the mcp-entry
 * runtime specifier itself (public API even for hand-rolled entries). A
 * consumer tools hatch externalizing any of these would break the
 * self-contained artifact contract.
 */
const reservedSpecifiers = (entry: RslibEntry): readonly string[] => Object.freeze([...new Set([
  mcpEntryRuntimeSpecifier,
  ...Object.keys(entry.aliases ?? {}),
  ...(entry.virtualModules ?? []).map((module) => module.name),
])]);

const reservedExternalError = (specifier: string): Error => new Error(
  `The tools escape hatch must not externalize the reserved specifier ${JSON.stringify(specifier)}; `
  + 'generated executables stay self-contained.',
);

/**
 * Finds a reserved specifier that a statically inspectable `externals` value
 * (string, RegExp, object map, or arrays thereof) would externalize. An
 * object entry whose value is `false` explicitly opts out of
 * externalization, so it is not a violation. Function externals cannot be
 * inspected here; {@link guardReservedExternals} intercepts those at build
 * time and the post-build residual-import scan fails closed behind both.
 */
const reservedExternalsViolation = (externals: unknown, reserved: readonly string[]): string | undefined => {
  if (externals === undefined || externals === null) return undefined;
  if (Array.isArray(externals)) {
    for (const item of externals) {
      const violation = reservedExternalsViolation(item, reserved);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (typeof externals === 'string') return reserved.includes(externals) ? externals : undefined;
  if (externals instanceof RegExp) return reserved.find((specifier) => externals.test(specifier));
  if (typeof externals === 'object') {
    return Object.entries(externals).find(([key, value]) => reserved.includes(key) && value !== false)?.[0];
  }
  return undefined;
};

/** A function external's non-result: not externalized, resolution continues. */
const isExternalizedResult = (result: unknown): boolean => result !== undefined && result !== false;

/**
 * Wraps every function-form external so that resolving a reserved specifier
 * as external fails the build instead of silently breaking the
 * self-contained artifact. Merely consulting the function for a reserved
 * request stays legal (the engine consults every external for every
 * request); only a positive externalization is a violation. Both the
 * callback and the promise calling conventions are preserved, including the
 * arity the engine uses to distinguish them. Violations are also reported
 * through `onViolation`, because an error delivered inside the external
 * factory surfaces only as a generic bundler failure — the caller uses the
 * report to raise the actionable diagnostic.
 */
const guardReservedExternals = (
  externals: unknown,
  reserved: readonly string[],
  onViolation: (specifier: string) => void,
): unknown => {
  if (Array.isArray(externals)) return externals.map((item) => guardReservedExternals(item, reserved, onViolation));
  if (typeof externals !== 'function') return externals;
  const external = externals as (
    data: { readonly request?: string },
    callback?: (error?: Error | null, result?: unknown, type?: string) => void,
  ) => unknown;
  const reservedRequestOf = (data: { readonly request?: string }): string | undefined =>
    typeof data.request === 'string' && reserved.includes(data.request) ? data.request : undefined;
  if (external.length <= 1) {
    return async (data: { readonly request?: string }): Promise<unknown> => {
      const result = await external(data);
      const request = reservedRequestOf(data);
      if (request !== undefined && isExternalizedResult(result)) {
        onViolation(request);
        throw reservedExternalError(request);
      }
      return result;
    };
  }
  return (
    data: { readonly request?: string },
    callback: (error?: Error | null, result?: unknown, type?: string) => void,
  ): unknown => external(data, (error, result, type) => {
    const request = reservedRequestOf(data);
    if ((error === undefined || error === null) && request !== undefined && isExternalizedResult(result)) {
      onViolation(request);
      callback(reservedExternalError(request));
      return;
    }
    callback(error, result, type);
  });
};

/**
 * Finds an alias key (from rslib defaults or the consumer hatch) that could
 * capture a reserved specifier: an exact key for the specifier, its
 * exact-match (`$`) form, or a prefix key covering it. The framework's own
 * reserved aliases are exempted by the caller.
 */
const reservedAliasViolation = (
  alias: Readonly<Record<string, unknown>> | undefined,
  reserved: readonly string[],
  frameworkKeys: ReadonlySet<string>,
): string | undefined => Object.keys(alias ?? {}).find((key) => {
  if (frameworkKeys.has(key)) return false;
  const exact = key.endsWith('$');
  const base = exact ? key.slice(0, -1) : key;
  return reserved.some((specifier) => specifier === base || (!exact && specifier.startsWith(`${base}/`)));
});

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const residualReservedImportPattern = (reserved: readonly string[]): RegExp =>
  new RegExp(`(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*(["'])(?:${reserved.map(escapeForRegExp).join('|')})\\1`, 'u');

/**
 * Fail-closed self-containment check on the emitted bundles themselves:
 * no reserved specifier may survive bundling as a live import. This catches
 * externalization paths the static invariant cannot see (function-form
 * `externals` from the consumer tools hatch).
 */
const assertNoResidualReservedImports = async (
  entries: readonly RslibEntry[],
  outputRoot: string,
): Promise<void> => {
  await Promise.all(entries.map(async (entry) => {
    const pattern = residualReservedImportPattern(reservedSpecifiers(entry));
    const bundle = await readFile(resolve(outputRoot, entry.outputRelativePath), 'utf8');
    if (pattern.test(bundle)) {
      throw new Error(
        `Generated executable ${JSON.stringify(entry.outputRelativePath)} is not self-contained: `
        + 'a reserved module specifier survived bundling. The tools escape hatch must not externalize '
        + `${reservedSpecifiers(entry).map((specifier) => JSON.stringify(specifier)).join(', ')}.`,
      );
    }
  }));
};

const declaredDependencyRoots = async (cwd: string): Promise<readonly string[]> => {
  let bytes: string;
  try {
    bytes = await readFile(resolve(cwd, 'package.json'), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    throw error;
  }
  const manifest = JSON.parse(bytes) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  const roots = await Promise.all([...names].map(async (name) => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) return undefined;
    try {
      return await realpath(resolve(cwd, 'node_modules', ...name.split('/')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  return Object.freeze(roots.filter((root): root is string => root !== undefined));
};

interface InspectedBundlerConfig {
  readonly externals?: unknown;
  readonly name?: string;
  readonly output?: { readonly asyncChunks?: boolean; readonly path?: string };
  readonly resolve?: { readonly alias?: unknown };
  readonly target?: false | string | readonly string[];
}

const aliasRecordOf = (config: InspectedBundlerConfig): Readonly<Record<string, unknown>> | undefined => {
  const alias = config.resolve?.alias;
  return typeof alias === 'object' && alias !== null ? alias as Readonly<Record<string, unknown>> : undefined;
};

const assertExecutableConfig = (
  entries: readonly RslibEntry[],
  inspection: {
    readonly bundlerConfigs: readonly InspectedBundlerConfig[];
    readonly environmentConfigs: Readonly<Record<string, unknown>>;
  },
  outputRoot: string,
): void => {
  if (
    inspection.bundlerConfigs.length !== entries.length ||
    Object.keys(inspection.environmentConfigs).length !== entries.length
  ) {
    throw new Error('Rslib did not resolve one environment for every generated executable.');
  }
  for (const entry of entries) {
    const id = entryLibId(entry);
    if (inspection.environmentConfigs[id] === undefined) {
      throw new Error('Rslib did not resolve one environment for every generated executable.');
    }
    // Rslib documents lib.id as the generated environment key and names each
    // Rspack config after it; array position carries no documented meaning.
    const matches = inspection.bundlerConfigs.filter((config) => config.name === id);
    if (matches.length !== 1) {
      throw new Error('Rslib did not resolve one environment for every generated executable.');
    }
    const config = matches[0]!;
    const target = Array.isArray(config.target) ? config.target : [config.target];
    if (config.output?.asyncChunks !== false || config.output.path !== outputRoot || !target.some((value) => value === 'node')) {
      throw new Error('Rslib resolved an invalid generated executable configuration.');
    }
    const expectedAliases = {
      ...entry.aliases,
      ...Object.fromEntries(materializedVirtualModules(outputRoot, entry)
        .map((module) => [module.name, module.path])),
    };
    const alias = aliasRecordOf(config);
    const frameworkAliasKeys = new Set(Object.keys(expectedAliases).map((name) => `${name}$`));
    for (const [name, moduleTarget] of Object.entries(expectedAliases)) {
      if (alias?.[`${name}$`] !== moduleTarget) {
        throw new Error('Rslib resolved a generated executable environment without its reserved module aliases.');
      }
    }
    const reserved = reservedSpecifiers(entry);
    const aliasViolation = reservedAliasViolation(alias, reserved, frameworkAliasKeys);
    if (aliasViolation !== undefined) {
      throw new Error(
        `The tools escape hatch must not alias the reserved specifier matched by ${JSON.stringify(aliasViolation)}; `
        + 'generated executables resolve reserved modules through the framework aliases.',
      );
    }
    const violation = reservedExternalsViolation(config.externals, reserved);
    if (violation !== undefined) throw reservedExternalError(violation);
  }
};

/**
 * Composes the full Rslib lib config for one synthesized entry: the
 * framework profile, the consumer `tools` escape hatch merged over it
 * (Rslib's "raw user config highest" priority), and the invariant enforcer
 * hook appended last, all composed with Rslib's own `mergeRslibConfig`
 * keyed by the synthesized lib id. `buildWithRslib` lowers exactly this
 * composition and `inspect --bundler` surfaces it, so the two can never
 * drift.
 */
export const composeEntryLibConfig = (
  entry: RslibEntry,
  options: {
    /** Receives reserved specifiers that a function-form external resolved at build time. */
    readonly onReservedExternal?: (specifier: string) => void;
    readonly outputRoot: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): LibConfig => {
  const libId = entryLibId(entry);
  const virtualSource = entry.virtualSource;
  const virtualModules = materializedVirtualModules(options.outputRoot, entry);
  const aliases = entry.aliases ?? {};
  const reserved = reservedSpecifiers(entry);
  const frameworkAliasKeys = new Set([
    ...Object.keys(aliases).map((name) => `${name}$`),
    ...virtualModules.map((module) => `${module.name}$`),
  ]);
  const enforceInvariants = (config: Rspack.Configuration): Rspack.Configuration => {
    config.output = { ...config.output, asyncChunks: false };
    const aliasViolation = reservedAliasViolation(
      config.resolve?.alias as Readonly<Record<string, unknown>> | undefined,
      reserved,
      frameworkAliasKeys,
    );
    if (aliasViolation !== undefined) {
      throw new Error(
        `The tools escape hatch must not alias the reserved specifier matched by ${JSON.stringify(aliasViolation)}; `
        + 'generated executables resolve reserved modules through the framework aliases.',
      );
    }
    if (virtualModules.length > 0 || Object.keys(aliases).length > 0) {
      config.resolve = {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          // Exact-match ($) keys per the resolve.alias contract: generated
          // code imports exactly these specifiers, never subpaths beneath.
          ...Object.fromEntries(Object.entries(aliases).map(([name, target]) => [`${name}$`, target])),
          ...Object.fromEntries(virtualModules.map((module) => [`${module.name}$`, module.path])),
        },
      };
    }
    const violation = reservedExternalsViolation(config.externals, reserved);
    if (violation !== undefined) throw reservedExternalError(violation);
    if (config.externals !== undefined) {
      // Function externals resolve requests at build time, so they are
      // guarded there rather than inspected here.
      config.externals = guardReservedExternals(
        config.externals,
        reserved,
        options.onReservedExternal ?? (() => undefined),
      ) as typeof config.externals;
    }
    return config;
  };
  const profile: RslibLibConfig = {
    id: libId,
    autoExternal: false,
    ...(entry.banner === undefined ? {} : { banner: { js: entry.banner } }),
    bundle: true,
    dts: entry.dts === true,
    format: 'esm',
    // Copied projects can share one node_modules tree, so a cache keyed
    // by this stable library id would give concurrent builds one lock.
    performance: {
      buildCache: false,
    },
    // Rsbuild 2.x deprecated performance.chunkSplit 'all-in-one'; the
    // documented migration is top-level splitChunks: false, which also
    // guards against the node-target splitting default added in v2.2.
    splitChunks: false,
    syntax: 'es2022',
    output: {
      cleanDistPath: false,
      distPath: { root: options.outputRoot },
      filename: { js: entry.outputRelativePath },
      filenameHash: false,
      legalComments: 'none',
      minify: false,
      sourceMap: false,
      target: 'node',
    },
    source: {
      entry: {
        [entry.name]: virtualSource === undefined ? entry.source : generatedEntryModulePath(options.outputRoot, entry),
      },
      ...(entry.tsconfigPath === undefined ? {} : { tsconfigPath: entry.tsconfigPath }),
    },
  };
  const merged = mergeRslibConfig(
    { lib: [profile] },
    options.tools?.rsbuild === undefined
      ? undefined
      : { lib: [{ ...asRslibEnvironmentFragment(options.tools.rsbuild), id: libId }] },
    options.tools?.rspack === undefined
      ? undefined
      : { lib: [{ id: libId, tools: { rspack: asRslibRspackHatch(options.tools.rspack) } }] },
    { lib: [{ id: libId, tools: { rspack: enforceInvariants } }] },
  );
  const lib = merged.lib?.[0];
  if (merged.lib?.length !== 1 || lib === undefined) {
    throw new Error(`Rslib config composition did not merge one lib entry for ${JSON.stringify(libId)}.`);
  }
  return lib;
};

export const buildWithRslib = async (options: {
  readonly cwd: string;
  readonly entries: readonly RslibEntry[];
  /** Extra module roots excluded from authored-source evidence (e.g. the aliased runtime shell). */
  readonly ignoredSourcePaths?: readonly string[];
  /** 'error' lets declaration-generation failures reach the consumer's terminal. */
  readonly logLevel?: 'error' | 'silent';
  readonly outputRoot: string;
  /** The consumer escape hatch, merged last-but-bounded into every synthesized entry. */
  readonly tools?: AgentBundleToolsConfig;
}, dependencies: RslibDependencies = {}): Promise<readonly BundledOutputEvidence[]> => {
  if (options.entries.length === 0) {
    return Object.freeze([]);
  }
  const dependencyRoots = await declaredDependencyRoots(options.cwd);

  // Generated wrapper entries and registry modules become real files for the
  // duration of the build — the stable, documented alternative to serving
  // them through the experimental VirtualModulesPlugin — and are removed
  // before artifact listing/publication.
  const generatedModulesRoot = resolve(options.outputRoot, generatedModulesDirname);
  const generatedModules = options.entries.flatMap((entry) => plannedGeneratedModules(entry, options.outputRoot));
  let result: Awaited<ReturnType<RslibInstance['build']>> | undefined;
  try {
    if (generatedModules.length > 0) {
      await mkdir(generatedModulesRoot, { recursive: true });
      await Promise.all(generatedModules.map((module) => writeFile(module.path, module.source, 'utf8')));
    }

    const reservedExternalViolations: string[] = [];
    const rslib = await (dependencies.createRslib ?? createRslib)({
      cwd: options.cwd,
      config: {
        logLevel: options.logLevel ?? 'silent',
        lib: options.entries.map((entry) => composeEntryLibConfig(entry, {
          onReservedExternal: (specifier) => reservedExternalViolations.push(specifier),
          outputRoot: options.outputRoot,
          ...(options.tools === undefined ? {} : { tools: options.tools }),
        })),
      },
    });

    const inspection = await rslib.inspectConfig();
    assertExecutableConfig(options.entries, inspection.origin, options.outputRoot);
    try {
      result = await rslib.build();
    } catch (error) {
      // A violation raised inside the external factory reaches here only as
      // a generic bundler failure; surface the actionable diagnostic.
      if (reservedExternalViolations.length > 0) throw reservedExternalError(reservedExternalViolations[0]!);
      throw error;
    }
    if (reservedExternalViolations.length > 0) throw reservedExternalError(reservedExternalViolations[0]!);
    const evidence = collectBundledOutputEvidence({
      expectedAssets: options.entries.map((entry) => ({
        path: entry.outputRelativePath,
        sourceInputs: entry.sourceInputs,
      })),
      ignoredSourcePaths: [
        generatedModulesRoot,
        ...(options.ignoredSourcePaths ?? []),
        ...dependencyRoots,
      ],
      projectRoot: options.cwd,
      stats: result.stats,
    });
    await assertNoResidualReservedImports(options.entries, options.outputRoot);
    return evidence;
  } finally {
    try {
      await result?.close();
    } finally {
      await rm(generatedModulesRoot, { force: true, recursive: true });
    }
  }
};
