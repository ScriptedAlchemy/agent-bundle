// Rslib re-exports its own Rsbuild/Rspack stack (values and types alike);
// installing @rspack/core separately risks version conflicts
// (https://rslib.rs/api/javascript-api/core).
import { pluginReact } from '@rsbuild/plugin-react';
import { createRslib, mergeRslibConfig, rspack, type LibConfig, type Rspack } from '@rslib/core';
import { init, parse } from 'es-module-lexer';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isErrno } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';
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
  /** Inject the intrinsic-only RSC manifest consumed by Flight client/server packages. */
  readonly rscManifest?: true;
  /** Resolve React through its server condition for a generated Flight worker. */
  readonly reactServer?: true;
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
 * The reserved namespace (under each build's output root) whose paths
 * identify generated module sources — wrapper entries and registry modules.
 * Nothing ever writes these paths: they are guaranteed-nonexistent module
 * ids served from memory by {@link virtualModulesPluginConstructor}, chosen
 * to be deterministic for `inspect --bundler` and collision-safe across
 * entries. The namespace stays excluded from authored-source provenance.
 */
const generatedModulesDirname = '.agent-bundle-virtual';

/**
 * Generated sources ride Rspack's `experiments.VirtualModulesPlugin` instead
 * of throwaway files on disk — an accepted design decision: the experimental
 * surface is the cost of never touching the artifact tree with build-time
 * scratch files. This narrow feature check turns an upstream rename or
 * removal into an actionable diagnostic instead of an opaque resolution
 * failure deep inside a build.
 */
const virtualModulesPluginConstructor = (): typeof rspack.experiments.VirtualModulesPlugin => {
  const constructor = (rspack as { readonly experiments?: { readonly VirtualModulesPlugin?: unknown } })
    .experiments?.VirtualModulesPlugin;
  if (typeof constructor !== 'function') {
    throw new Error(
      'The Rspack engine nested in @rslib/core no longer exposes experiments.VirtualModulesPlugin, '
      + 'which agent-bundle uses to serve generated wrapper and registry modules. '
      + 'Pin @rslib/core to a version whose Rspack ships the plugin, or update agent-bundle.',
    );
  }
  return constructor as typeof rspack.experiments.VirtualModulesPlugin;
};

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

/**
 * rsbuild-plugin-dts aborts a failed declaration pass with a stackless prose
 * Error naming only the Rslib environment ("Error occurred in
 * agent-bundle-index declaration files generation.") — there is no structured
 * signal to key on, so the phrase is the contract. A build failure this does
 * not match is not a declaration failure and keeps its own reporting.
 */
export const isDeclarationGenerationFailure = (error: unknown): boolean =>
  error instanceof Error && /declaration files/iu.test(error.message);

// join (not resolve) so a tokenized output root (`<output>/<target>`) stays
// a token instead of resolving against the cwd.
const generatedEntryModulePath = (outputRoot: string, entry: RslibEntry): string =>
  join(outputRoot, generatedModulesDirname, `${entry.name}-entry.mjs`);

/** The import requests of one named entry in a lowered Rspack entry record. */
const entryImportsOf = (entryRecord: unknown, name: string): readonly string[] => {
  const description = isRecord(entryRecord) ? entryRecord[name] : undefined;
  const imports = isRecord(description) ? description.import : description;
  if (typeof imports === 'string') return [imports];
  if (Array.isArray(imports)) return imports.filter((item): item is string => typeof item === 'string');
  return [];
};

const virtualRegistryModules = (
  outputRoot: string,
  entry: RslibEntry,
): readonly { readonly name: string; readonly path: string; readonly source: string }[] =>
  (entry.virtualModules ?? []).map((module, index) => ({
    ...module,
    path: join(outputRoot, generatedModulesDirname, `${entry.name}-${index}.mjs`),
  }));

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

/**
 * Fail-closed self-containment check on the emitted bundles themselves:
 * no reserved specifier may survive bundling as a live import. This is the
 * belt behind the static externals check and the function-external guard.
 * The bundle is parsed as an ES module (the emitted format by contract), so
 * string literals or comments that merely mention a reserved specifier are
 * not violations.
 */
const assertNoResidualReservedImports = async (
  entries: readonly RslibEntry[],
  outputRoot: string,
): Promise<void> => {
  await init;
  await Promise.all(entries.map(async (entry) => {
    const reserved = reservedSpecifiers(entry);
    const bundle = await readFile(resolve(outputRoot, entry.outputRelativePath), 'utf8');
    // A bin banner shebang is legal for Node but not for the ESM lexer.
    const source = bundle.startsWith('#!') ? bundle.slice(bundle.indexOf('\n') + 1) : bundle;
    let imports: ReturnType<typeof parse>[0];
    try {
      [imports] = parse(source);
    } catch {
      throw new Error(`Generated executable ${JSON.stringify(entry.outputRelativePath)} did not parse as an ES module.`);
    }
    const residual = imports
      .map((record) => record.n)
      .find((specifier) => specifier !== undefined && reserved.includes(specifier));
    if (residual !== undefined) {
      throw new Error(
        `Generated executable ${JSON.stringify(entry.outputRelativePath)} is not self-contained: `
        + `the reserved module specifier ${JSON.stringify(residual)} survived bundling. `
        + 'The tools escape hatch must not externalize '
        + `${reserved.map((specifier) => JSON.stringify(specifier)).join(', ')}.`,
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
  readonly entry?: unknown;
  readonly externals?: unknown;
  readonly name?: string;
  readonly output?: { readonly asyncChunks?: boolean; readonly path?: string };
  readonly plugins?: readonly unknown[];
  readonly resolve?: { readonly alias?: unknown };
  readonly target?: false | string | readonly string[];
}

const aliasRecordOf = (config: InspectedBundlerConfig): Readonly<Record<string, unknown>> | undefined => {
  const alias = config.resolve?.alias;
  return typeof alias === 'object' && alias !== null ? alias as Readonly<Record<string, unknown>> : undefined;
};

interface InspectedEnvironmentConfig {
  readonly output?: { readonly cleanDistPath?: unknown };
}

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
    const environment = inspection.environmentConfigs[id] as InspectedEnvironmentConfig | undefined;
    if (environment === undefined) {
      throw new Error('Rslib did not resolve one environment for every generated executable.');
    }
    // Scripts, MCP entries, hooks, and MCP Apps build sequentially into one
    // shared staged root, so an environment that cleans its dist path would
    // delete sibling outputs already emitted there; the composed invariant
    // pins it off after the hatch merge.
    if (environment.output?.cleanDistPath !== false) {
      throw new Error('Rslib resolved a generated executable environment that would clean its own output root.');
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
    // The generated environment must retain the virtual-module source: a
    // resolved config without the plugin instance would resolve the
    // guaranteed-nonexistent generated paths against the real filesystem.
    const registryModules = virtualRegistryModules(outputRoot, entry);
    if (entry.virtualSource !== undefined || registryModules.length > 0) {
      const constructor = virtualModulesPluginConstructor();
      if (config.plugins?.some((plugin) => plugin instanceof constructor) !== true) {
        throw new Error('Rslib resolved a generated executable environment without its virtual modules.');
      }
    }
    if (entry.virtualSource !== undefined
      && !entryImportsOf(config.entry, entry.name).includes(generatedEntryModulePath(outputRoot, entry))) {
      throw new Error('Rslib resolved a generated executable environment without its generated wrapper entry.');
    }
    const expectedAliases = {
      ...entry.aliases,
      ...Object.fromEntries(registryModules.map((module) => [module.name, module.path])),
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
  const virtualModules = virtualRegistryModules(options.outputRoot, entry);
  // Every generated module this entry serves virtually during its build:
  // the wrapper entry (when present) plus the registry modules.
  const generatedModules = [
    ...(virtualSource === undefined
      ? []
      : [{ path: generatedEntryModulePath(options.outputRoot, entry), source: virtualSource }]),
    ...virtualModules,
  ];
  const aliases = entry.aliases ?? {};
  const reserved = reservedSpecifiers(entry);
  const frameworkAliasKeys = new Set([
    ...Object.keys(aliases).map((name) => `${name}$`),
    ...virtualModules.map((module) => `${module.name}$`),
  ]);
  const enforceInvariants = (config: Rspack.Configuration): Rspack.Configuration => {
    config.output = { ...config.output, asyncChunks: false };
    if (entry.rscManifest === true) {
      config.plugins = [
        ...(config.plugins ?? []),
        new rspack.DefinePlugin({ __rspack_rsc_manifest__: JSON.stringify({ clientManifest: {}, cssLinkProps: {}, entryCssFiles: {}, entryJsFiles: [], moduleLoading: { prefix: '' }, serverConsumerModuleMap: {}, serverManifest: {} }) }),
      ];
    }
    if (entry.reactServer === true) {
      config.resolve = { ...config.resolve, conditionNames: ['react-server', '...'] };
    }
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
    if (generatedModules.length > 0) {
      // Added after the hatch mutator (this hook is merged last), so a
      // consumer cannot strip the generated sources out of the compiler.
      const VirtualModulesPlugin = virtualModulesPluginConstructor();
      config.plugins = [
        ...(config.plugins ?? []),
        new VirtualModulesPlugin(Object.fromEntries(generatedModules.map((module) => [module.path, module.source]))),
      ];
    }
    if (virtualSource !== undefined) {
      // Rslib validates `source.entry` against the real filesystem before
      // Rspack exists, so the profile keys the entry on the authored program
      // and this hook redirects the lowered Rspack entry to the generated
      // wrapper's guaranteed-nonexistent virtual path, which the plugin
      // above serves from memory. Rspack resolves entries through the
      // plugin-patched input filesystem, so no real path is ever shadowed.
      const lowered = config.entry;
      if (!isRecord(lowered)) {
        throw new Error('Rslib lowered a generated executable without a keyed entry record.');
      }
      const description = lowered[entry.name];
      const wrapperImport = [generatedEntryModulePath(options.outputRoot, entry)];
      config.entry = {
        ...lowered,
        [entry.name]: isRecord(description) ? { ...description, import: wrapperImport } : wrapperImport,
      } as typeof config.entry;
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
    // Routes are authored as TSX, and the bare Rslib transform lowers JSX to
    // the classic `React.createElement` factory, which no generated entry has
    // in scope. The React plugin selects the automatic runtime, so emitted
    // modules import `react/jsx-runtime` themselves — under the react-server
    // condition for worker entries, which is what RSC rendering needs.
    plugins: [pluginReact({ fastRefresh: false })],
    // Rsbuild 2.x deprecated performance.chunkSplit 'all-in-one'; the
    // documented migration is top-level splitChunks: false, which also
    // guards against the node-target splitting default added in v2.2.
    splitChunks: false,
    syntax: 'es2022',
    output: {
      distPath: { root: options.outputRoot },
      filename: { js: entry.outputRelativePath },
      filenameHash: false,
      legalComments: 'none',
      minify: false,
      sourceMap: false,
      target: 'node',
    },
    source: {
      // Always the authored program, even when a generated wrapper is the
      // real compilation root: Rslib checks that every entry exists on disk,
      // and `enforceInvariants` redirects the lowered Rspack entry to the
      // wrapper's virtual path.
      entry: {
        [entry.name]: entry.source,
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
    // Merged last so the hatch cannot reach either invariant. Dist cleaning
    // would delete sibling entries already emitted into the shared staged
    // root, so it stays off no matter what the consumer asks for; the
    // emitted output is published atomically from a staged root instead.
    { lib: [{ id: libId, output: { cleanDistPath: false }, tools: { rspack: enforceInvariants } }] },
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
  let result: Awaited<ReturnType<RslibInstance['build']>> | undefined;
  try {
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
        // Generated wrapper/registry modules are virtual, but they still
        // surface in stats as modules under this reserved namespace.
        resolve(options.outputRoot, generatedModulesDirname),
        ...(options.ignoredSourcePaths ?? []),
        ...dependencyRoots,
      ],
      projectRoot: options.cwd,
      stats: result.stats,
    });
    await assertNoResidualReservedImports(options.entries, options.outputRoot);
    return evidence;
  } finally {
    await result?.close();
  }
};
