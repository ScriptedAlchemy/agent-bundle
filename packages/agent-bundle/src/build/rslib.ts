// Rslib re-exports its own Rsbuild/Rspack stack (values and types alike);
// installing @rspack/core separately risks version conflicts
// (https://rslib.rs/api/javascript-api/core).
import { pluginReact } from '@rsbuild/plugin-react';
import { createRslib, mergeRslibConfig, rspack, type LibConfig, type Rspack } from '@rslib/core';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { dependencyManifestPath } from '../core/dependency-manifest.ts';
import { isErrno } from '../core/errors.ts';
import { isInsideOrEqual, posixRelativeWhenInside } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleToolsConfig } from '../core/types.ts';
import type { AgentBundleMeta } from '../meta.ts';
import type {
  CompilationEvidence,
  CompileResult,
  ExternalIR,
  ModuleIR,
} from './compile-result.ts';
import { composeToolsLayers, frameworkInvariantLayer } from './compose-layers.ts';
import { ArtifactDependencyAuditPlugin } from './dependency-audit-plugin.ts';
import { mcpEntryRuntimeSpecifier } from './entry-shell.ts';
import { classifyExternal } from './external-policy.ts';
import {
  assertGeneratedModulesRootAbsent,
  generatedMetaModulePath,
  generatedMetaModuleSource,
  generatedModulesRoot,
  metaModuleSpecifier,
  virtualModulesPluginConstructor,
} from './meta.ts';
import { collectBundledOutputEvidence } from './provenance.ts';

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
type RslibBundlerChain = Exclude<NonNullable<NonNullable<LibConfig['tools']>['bundlerChain']>, readonly unknown[]>;

/**
 * Rslib 1.x adds a module rule (its `NEW_URL_RULE`, `rslib:new-url`) whose
 * rule-level `parser.javascript.url` outranks the global parser option
 * `composeEntryLibConfig` pins off, so the rule's own option is turned off
 * too: a `new URL(…, import.meta.url)` in plugin or generated code names a
 * run-time path, not an asset to emit.
 */
const preserveResourceReferences: RslibBundlerChain = (chain) => {
  chain.module.rule('rslib:new-url').parser({ url: false });
};

/**
 * Lowers the composed lib configs to bundler configs, always as the
 * production build `rslib.build()` runs. Rslib 1.x otherwise infers the mode
 * from `NODE_ENV`, and under `development` inspects only `mf` libs — none
 * here — so `assertExecutableConfig` and `inspect --bundler` would fail. Rslib
 * writes the inspected mode back to `NODE_ENV`; the process gets its own value
 * back — set or unset — whether the inspection succeeded or threw, so a
 * development server or test runner that inspects a config is not left
 * running as `production`. (`rslib.build()` sets `production` itself when it
 * finds `NODE_ENV` unset; that is the build's business, not the inspection's.)
 */
const inspectProductionConfig = async (
  rslib: Pick<RslibInstance, 'inspectConfig'>,
): Promise<Awaited<ReturnType<RslibInstance['inspectConfig']>>> => {
  const nodeEnv = process.env.NODE_ENV;
  try {
    return await rslib.inspectConfig({ mode: 'production' });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
};
type RslibLibConfig = LibConfig;
type RslibToolsRspack = NonNullable<NonNullable<LibConfig['tools']>['rspack']>;

export interface RslibDependencies {
  readonly compilationEvidence?: readonly CompilationEvidence[];
  readonly createRslib?: (options: Parameters<typeof createRslib>[0]) => Promise<Pick<RslibInstance, 'build' | 'inspectConfig'>>;
}

/** This engine's virtual-module plugin (see {@link virtualModulesPluginConstructor}). */
const rslibVirtualModulesPlugin = (): typeof rspack.experiments.VirtualModulesPlugin =>
  virtualModulesPluginConstructor(rspack, '@rslib/core', 'serve generated wrapper and registry modules');

/**
 * The tools escape hatch is typed against the workspace `@rsbuild/core`,
 * while this build path speaks Rslib's `LibConfig`, which imports its
 * Rsbuild types through `@rslib/core`'s own dependency edge (the same
 * package today — see {@link AgentBundleToolsConfig} — but a separate type
 * universe for the compiler). These two functions are the single deliberate
 * crossing between them; everything else in this module stays inside Rslib's
 * own types.
 */
const asRslibEnvironmentFragment = (
  fragment: NonNullable<AgentBundleToolsConfig['rsbuild']>,
): Omit<RslibLibConfig, 'id'> => fragment as Omit<RslibLibConfig, 'id'>;
const asRslibRspackHatch = (
  hatch: NonNullable<AgentBundleToolsConfig['rspack']>,
): RslibToolsRspack => hatch as RslibToolsRspack;

/**
 * The Rslib lib id — and so the Rsbuild environment name and the Rspack
 * compiler name — of an entry. It derives from the artifact destination,
 * which the planner already asserts unique within a target, rather than
 * from the entry name: surfaces sharing one run may legitimately reuse a
 * name (a script authored as `hooks-flight` emits `scripts/hooks-flight.mjs`
 * beside the hook surface's standalone worker `hooks/hooks-flight.mjs`).
 * Visible only in `inspect --bundler` and bundler stats, never in emitted
 * bytes.
 */
export const entryLibId = (entry: Pick<RslibEntry, 'outputRelativePath'>): string =>
  `agent-bundle-${entry.outputRelativePath.replace(/\.[^./]+$/u, '').replaceAll('/', '-')}`;

/**
 * rsbuild-plugin-dts aborts a failed declaration pass with a stackless prose
 * Error naming only the Rslib environment ("Error occurred in
 * agent-bundle-index declaration files generation.") — there is no structured
 * signal to key on, so the phrase is the contract. A build failure this does
 * not match is not a declaration failure and keeps its own reporting.
 */
export const isDeclarationGenerationFailure = (error: unknown): boolean =>
  error instanceof Error && /declaration files/iu.test(error.message);

// Generated module paths live in the project's reserved namespace (see
// `generatedModulesDirname`), never under the per-build staged output root:
// Rspack writes module identifiers relative to the project root into the
// emitted bundles, and those bytes must not change from one build to the next.
const generatedEntryModulePath = (projectRoot: string, entry: RslibEntry): string =>
  join(generatedModulesRoot(projectRoot), `${entry.name}-entry.mjs`);

/** The import requests of one named entry in a lowered Rspack entry record. */
const entryImportsOf = (entryRecord: unknown, name: string): readonly string[] => {
  const description = isRecord(entryRecord) ? entryRecord[name] : undefined;
  const imports = isRecord(description) ? description.import : description;
  if (typeof imports === 'string') return [imports];
  if (Array.isArray(imports)) return imports.filter((item): item is string => typeof item === 'string');
  return [];
};

const virtualRegistryModules = (
  projectRoot: string,
  entry: RslibEntry,
  meta: AgentBundleMeta,
): readonly { readonly name: string; readonly path: string; readonly source: string }[] => [
  // The framework identity constant (issue #237) reaches every compiled
  // surface, so it is composed here rather than declared per entry: one
  // build stamps one identity, and every entry shares one generated module.
  {
    name: metaModuleSpecifier,
    path: generatedMetaModulePath(projectRoot),
    source: generatedMetaModuleSource(meta),
  },
  ...(entry.virtualModules ?? []).map((module, index) => ({
    ...module,
    path: join(generatedModulesRoot(projectRoot), `${entry.name}-${index}.mjs`),
  })),
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
  metaModuleSpecifier,
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
 * time.
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

const projectDependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
/** What a dependency's bundle can pull in: its devDependencies never ship. */
const runtimeDependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

const declaredDependencyNames = (manifest: Record<string, unknown>, fields: readonly string[]): readonly string[] => {
  const names = new Set<string>();
  for (const field of fields) {
    const dependencies = manifest[field];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) names.add(name);
    }
  }
  return [...names];
};

const readManifest = async (packageRoot: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
};

const isBeneathNodeModules = (path: string): boolean => path.split(sep).includes('node_modules');

/**
 * The project root as Rspack records it, so a dependency link back onto the
 * project compares equal. A directory that does not exist has no manifest and
 * therefore no dependency roots; it is kept as given rather than failing here.
 */
const canonicalProjectRoot = async (cwd: string): Promise<string> => {
  const root = resolve(cwd);
  try {
    return await realpath(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return root;
    throw error;
  }
};

/**
 * Real roots of the project's declared dependencies, followed transitively
 * through each linked dependency's own runtime dependencies. Provenance already
 * discards modules beneath a `node_modules` directory, but pnpm links workspace
 * packages by symlink and Rspack records their modules at real paths, which
 * carry no such segment: `@agent-bundle/runtime` resolved to
 * `packages/rsc-runtime` must be excluded by root, and so must the workspace
 * packages *it* depends on (`rsc-markdown-stream`), which the project never
 * declares itself. Registry packages resolve beneath `node_modules`, so their
 * trees are never walked. The project itself is never a root: a dependency
 * cycle back onto it (A → B → A) must not turn every authored module into an
 * ignored one. Only the root itself is exempt — a dependency linked from
 * inside the project (`<project>/packages/dep`, `file:./vendor/dep`) is still
 * a dependency and is excluded like any other.
 */
const declaredDependencyRoots = async (cwd: string): Promise<readonly string[]> => {
  const projectRoot = await canonicalProjectRoot(cwd);
  const roots = new Set<string>();
  const visited = new Set<string>();
  const visit = async (packageRoot: string, fields: readonly string[]): Promise<void> => {
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);
    const manifest = await readManifest(packageRoot);
    if (manifest === undefined) return;
    await Promise.all(declaredDependencyNames(manifest, fields).map(async (name) => {
      const manifestPath = await dependencyManifestPath(packageRoot, name);
      if (manifestPath === undefined) return;
      const root = await realpath(dirname(manifestPath));
      if (root === projectRoot) return;
      roots.add(root);
      if (!isBeneathNodeModules(root)) await visit(root, runtimeDependencyFields);
    }));
  };
  await visit(projectRoot, projectDependencyFields);
  return Object.freeze([...roots].sort((left, right) => left.localeCompare(right)));
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
  run: Pick<RslibRunOptions, 'cwd' | 'meta' | 'outputRoot'>,
): void => {
  const { cwd, meta, outputRoot } = run;
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
    // Every surface of a target builds into one shared staged root (MCP Apps
    // first, then the node surfaces together), so an environment that cleans
    // its dist path would delete sibling outputs already emitted there; the
    // composed invariant pins it off after the hatch merge.
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
    // reserved generated paths against the real filesystem.
    const registryModules = virtualRegistryModules(cwd, entry, meta);
    const constructor = rslibVirtualModulesPlugin();
    if (config.plugins?.some((plugin) => plugin instanceof constructor) !== true) {
      throw new Error('Rslib resolved a generated executable environment without its virtual modules.');
    }
    if (entry.virtualSource !== undefined
      && !entryImportsOf(config.entry, entry.name).includes(generatedEntryModulePath(cwd, entry))) {
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
 * Composes the full Rslib lib config for one synthesized entry in the
 * shared `composeToolsLayers` order — the framework profile, the consumer
 * `tools` escape hatch over it, the invariant enforcer hook last — with
 * Rslib's own `mergeRslibConfig` keyed by the synthesized lib id.
 * `buildWithRslib` lowers exactly this composition and `inspect --bundler`
 * surfaces it, so the two can never drift.
 */
export const composeEntryLibConfig = (
  entry: RslibEntry,
  options: {
    /** The project root: the bundler `context` and the root of the generated-module namespace. */
    readonly cwd: string;
    /** The project identity served to plugin source as `agent-bundle/meta`. */
    readonly meta: AgentBundleMeta;
    readonly onCompilationEvidence?: (evidence: CompilationEvidence) => void;
    /** Receives reserved specifiers that a function-form external resolved at build time. */
    readonly onReservedExternal?: (specifier: string) => void;
    readonly outputRoot: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): LibConfig => {
  const libId = entryLibId(entry);
  const virtualSource = entry.virtualSource;
  const virtualModules = virtualRegistryModules(options.cwd, entry, options.meta);
  // Every generated module this entry serves virtually during its build:
  // the wrapper entry (when present) plus the registry modules.
  const generatedModules = [
    ...(virtualSource === undefined
      ? []
      : [{ path: generatedEntryModulePath(options.cwd, entry), source: virtualSource }]),
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
    // Rslib 1.x treats a statically analyzable `new URL(…, import.meta.url)`
    // as a static asset to emit and `new Worker(new URL(…))` as a worker
    // entry to bundle. Generated entries spell their sibling Flight worker
    // and their artifact root exactly that way, naming files that exist only
    // in the build output, and consumer code points at run-time filesystem
    // paths beside the artifact. Both parsers stay off, as Rslib 0.x left
    // them, so every such expression survives into the artifact verbatim;
    // `preserveResourceReferences` switches Rslib's own `rslib:new-url` rule
    // off for the same reason (a rule-level parser option outranks this one).
    config.module = {
      ...config.module,
      parser: {
        ...config.module?.parser,
        javascript: { ...config.module?.parser?.javascript, url: false, worker: false },
      },
    };
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
    // Generated modules live under the project root, so a consumer
    // package.json declaring `"sideEffects": false` would otherwise let the
    // bundler drop a bare `import "agent-bundle/launch-env-layer"` (#469) as
    // an unused side-effect-free import. They exist for their side effects.
    if (generatedModules.length > 0) {
      config.module = {
        ...config.module,
        rules: [...(config.module?.rules ?? []), { include: generatedModulesRoot(options.cwd), sideEffects: true }],
      };
    }
    // Framework plugins are added after the hatch mutator (this hook is
    // merged last), so a consumer cannot strip the RSC manifest stub or the
    // generated sources out of the compiler.
    const frameworkPlugins = [
      ...(entry.rscManifest === true
        ? [new rspack.DefinePlugin({ __rspack_rsc_manifest__: JSON.stringify({ clientManifest: {}, cssLinkProps: {}, entryCssFiles: {}, entryJsFiles: [], moduleLoading: { prefix: '' }, serverConsumerModuleMap: {}, serverManifest: {} }) })]
        : []),
      ...(generatedModules.length > 0
        ? [new (rslibVirtualModulesPlugin())(Object.fromEntries(generatedModules.map((module) => [module.path, module.source])))]
        : []),
      new ArtifactDependencyAuditPlugin(options.onCompilationEvidence ?? (() => undefined)),
    ];
    config.plugins = [...(config.plugins ?? []), ...frameworkPlugins];
    if (virtualSource !== undefined) {
      // Rslib validates `source.entry` against the real filesystem before
      // Rspack exists, so the profile keys the entry on the authored program
      // and this hook redirects the lowered Rspack entry to the generated
      // wrapper's reserved virtual path, which the plugin above serves from
      // memory. Rspack resolves entries through the plugin-patched input
      // filesystem, so nothing is ever read from disk under that path.
      const lowered = config.entry;
      if (!isRecord(lowered)) {
        throw new Error('Rslib lowered a generated executable without a keyed entry record.');
      }
      const description = lowered[entry.name];
      const wrapperImport = [generatedEntryModulePath(options.cwd, entry)];
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
      // Nothing is externalized by declaration: an artifact is self-contained,
      // and AB7014/AB7015 judge the consumer's declared dependencies against
      // what the bundle actually reached.
      autoExternal: false,
      distPath: { root: options.outputRoot },
      filename: { js: entry.outputRelativePath },
      filenameHash: false,
      legalComments: 'none',
      minify: false,
      sourceMap: false,
      target: 'node',
    },
    // `externalsType` stays Rslib's ESM default (`modern-module`): a CommonJS
    // `require()` of a Node builtin inside a bundled dependency reaches the
    // artifact as the same `createRequire()` shim Rslib 0.x emitted for it
    // (`packages/agent-bundle/rslib.config.ts` has the comparison).
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
  // Every layer is keyed by the synthesized lib id so `mergeRslibConfig`
  // folds them into one lib entry in `composeToolsLayers` order.
  const invariants = frameworkInvariantLayer(enforceInvariants);
  const merged = mergeRslibConfig(...composeToolsLayers<RslibLibConfig>({
    invariants: { id: libId, ...invariants, tools: { ...invariants.tools, bundlerChain: preserveResourceReferences } },
    lift: {
      rsbuild: (fragment) => ({ ...asRslibEnvironmentFragment(fragment), id: libId }),
      rspack: (hatch) => ({ id: libId, tools: { rspack: asRslibRspackHatch(hatch) } }),
    },
    profile,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  }).map((lib) => ({ lib: [lib] })));
  const lib = merged.lib?.[0];
  if (merged.lib?.length !== 1 || lib === undefined) {
    throw new Error(`Rslib config composition did not merge one lib entry for ${JSON.stringify(libId)}.`);
  }
  return lib;
};

/**
 * One compiled surface's share of a target's Rslib run: the entries it
 * synthesizes and the module roots its authored-source evidence excludes.
 * Every surface of one target (routed CLI bin, scripts, hook wrappers, MCP
 * entries, and each one's react-server Flight worker) rides one Rslib
 * instance — one Rsbuild environment per entry, compiled by one Rspack
 * multi-compiler in parallel — instead of one sequential instance per
 * surface. Surfaces keep their own evidence exclusions and results.
 */
export interface RslibSurface {
  readonly entries: readonly RslibEntry[];
  /** Extra module roots excluded from this surface's authored-source evidence (e.g. an aliased runtime shell). */
  readonly ignoredSourcePaths?: readonly string[];
  /** 'error' lets bundler and declaration-generation failures reach the consumer's terminal. */
  readonly logLevel?: 'error' | 'silent';
}

export interface RslibRunOptions {
  readonly cwd: string;
  /** The project identity served to plugin source as `agent-bundle/meta`. */
  readonly meta: AgentBundleMeta;
  readonly outputRoot: string;
  /** The consumer escape hatch, merged last-but-bounded into every synthesized entry. */
  readonly tools?: AgentBundleToolsConfig;
}

/**
 * Lib ids key Rslib environments and `mergeRslibConfig` folds same-id libs
 * into one, so two entries of one run may not share an id. Ids derive from
 * artifact destinations the planner already rejects as duplicates, so this
 * is an internal invariant rather than a consumer-facing diagnostic.
 */
const assertDistinctLibIds = (entries: readonly RslibEntry[]): void => {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const id = entryLibId(entry);
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw new Error(
        `Rslib surfaces of one target synthesize the same lib id ${JSON.stringify(id)} for `
        + `${JSON.stringify(previous)} and ${JSON.stringify(entry.outputRelativePath)}.`,
      );
    }
    seen.set(id, entry.outputRelativePath);
  }
};

const packageNameOfResource = (resource: string): string | undefined => {
  const segments = resource.replaceAll('\\', '/').split('/');
  const nodeModules = segments.lastIndexOf('node_modules');
  if (nodeModules === -1) return undefined;
  const name = segments[nodeModules + 1];
  if (name === undefined) return undefined;
  return name.startsWith('@') && segments[nodeModules + 2] !== undefined
    ? `${name}/${segments[nodeModules + 2]}`
    : name;
};

const moduleKindOf = (
  resource: string | undefined,
  cwd: string,
  dependencyRoots: readonly string[],
): ModuleIR['kind'] => {
  if (resource !== undefined && isInsideOrEqual(generatedModulesRoot(cwd), resource)) return 'generated';
  if (
    resource !== undefined
    && (packageNameOfResource(resource) !== undefined || dependencyRoots.some((root) => isInsideOrEqual(root, resource)))
  ) {
    return 'dependency';
  }
  return 'authored';
};

/**
 * Lowers every surface's entries through one Rslib instance and returns the
 * compiler result per surface, in surface order. A surface without entries
 * contributes an empty result; with no entries at all no instance is created.
 */
export const buildRslibSurfaces = async (
  options: RslibRunOptions,
  surfaces: readonly RslibSurface[],
  dependencies: RslibDependencies = {},
): Promise<readonly CompileResult[]> => {
  const entries = surfaces.flatMap((surface) => surface.entries);
  if (entries.length === 0) {
    return Object.freeze(surfaces.map(() => Object.freeze({
      assets: Object.freeze([]),
      diagnostics: Object.freeze([]),
      externals: Object.freeze([]),
      modules: Object.freeze([]),
    })));
  }
  assertDistinctLibIds(entries);
  await assertGeneratedModulesRootAbsent(options.cwd);
  const dependencyRoots = await declaredDependencyRoots(options.cwd);

  const reservedExternalViolations: string[] = [];
  const compilationEvidence: CompilationEvidence[] = [...(dependencies.compilationEvidence ?? [])];
  const rslib = await (dependencies.createRslib ?? createRslib)({
    cwd: options.cwd,
    config: {
      // The run reports at the most verbose level any surface asks for.
      logLevel: surfaces.some((surface) => surface.logLevel === 'error') ? 'error' : 'silent',
      lib: entries.map((entry) => composeEntryLibConfig(entry, {
        cwd: options.cwd,
        meta: options.meta,
        onCompilationEvidence: (evidence) => compilationEvidence.push(evidence),
        onReservedExternal: (specifier) => reservedExternalViolations.push(specifier),
        outputRoot: options.outputRoot,
        ...(options.tools === undefined ? {} : { tools: options.tools }),
      })),
    },
  });

  const inspection = await inspectProductionConfig(rslib);
  assertExecutableConfig(entries, inspection.origin, options);
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
      expectedAssets: surfaces.flatMap((surface) => surface.entries.map((entry) => ({
        ...(surface.ignoredSourcePaths === undefined ? {} : { ignoredSourcePaths: surface.ignoredSourcePaths }),
        path: entry.outputRelativePath,
        sourceInputs: entry.sourceInputs,
      }))),
      ignoredSourcePaths: [
        // Generated wrapper/registry modules are virtual, but they still
        // surface in stats as modules under this reserved namespace.
        resolve(generatedModulesRoot(options.cwd)),
        ...dependencyRoots,
      ],
      projectRoot: options.cwd,
      stats: result.stats,
    });
    const emittedAssets = new Set(entries.map((entry) => entry.outputRelativePath));
    const evidenceByPath = new Map(evidence.map((asset) => [asset.path, asset]));
    const resultByEntry = new Map(entries.map((entry) => {
      const records = compilationEvidence.filter((record) => record.compiler === entryLibId(entry));
      const [record] = records;
      if (record === undefined || records.length !== 1) {
        throw new Error(
          `Rslib did not record exactly one compilation evidence result for ${JSON.stringify(entry.outputRelativePath)}.`,
        );
      }
      const externals = record.externals.map((external): ExternalIR => ({
        asset: entry.outputRelativePath,
        externalType: external.externalType,
        issuers: external.issuers.map((issuer) => posixRelativeWhenInside(options.cwd, issuer)),
        kind: classifyExternal(external, { asset: entry.outputRelativePath, emittedAssets }),
        request: external.request,
        userRequest: external.userRequest,
      }));
      const modules = record.modules.map((module): ModuleIR => {
        const packageName = module.resource === undefined ? undefined : packageNameOfResource(module.resource);
        return {
          asset: entry.outputRelativePath,
          identifier: module.identifier,
          kind: moduleKindOf(module.resource, options.cwd, dependencyRoots),
          ...(packageName === undefined ? {} : { package: packageName }),
          ...(module.resource === undefined ? {} : { resource: module.resource }),
        };
      });
      return [entry, Object.freeze({
        assets: Object.freeze([evidenceByPath.get(entry.outputRelativePath)!]),
        diagnostics: Object.freeze([]),
        externals: Object.freeze(externals),
        modules: Object.freeze(modules),
      })] as const;
    }));
    return Object.freeze(surfaces.map((surface) => {
      const entryResults = surface.entries.map((entry) => resultByEntry.get(entry)!);
      return Object.freeze({
        assets: Object.freeze(entryResults.flatMap((entryResult) => entryResult.assets)),
        diagnostics: Object.freeze(entryResults.flatMap((entryResult) => entryResult.diagnostics)),
        externals: Object.freeze(entryResults.flatMap((entryResult) => entryResult.externals)),
        modules: Object.freeze(entryResults.flatMap((entryResult) => entryResult.modules)),
      });
    }));
  } finally {
    await result?.close();
  }
};
