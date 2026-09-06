import {
  createRsbuild,
  mergeRsbuildConfig,
  rspack,
  type RsbuildConfig,
  type RsbuildPlugin,
  type Rspack,
} from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { DiagnosticError, freezeDiagnostics, type Diagnostic } from '../core/diagnostics.ts';
import type { AgentBundleToolsConfig, NormalizedMcpApp } from '../core/types.ts';
import { stableJson } from '../core/digest.ts';
import { MAX_APP_HTML_BYTES } from '../core/mcp-app-limits.ts';
import { escapeRegExp } from '../core/strings.ts';
import type { AgentBundleMeta } from '../meta.ts';
import { appRuntimePath, appRuntimeSpecifier } from './app-runtime.ts';
import type { CompilationEvidence, CompileResult } from './compile-result.ts';
import { composeToolsLayers, frameworkInvariantLayer } from './compose-layers.ts';
import { ArtifactDependencyAuditPlugin } from './dependency-audit-plugin.ts';
import { listArtifactFiles, resolveArtifactDestination } from './emit.ts';
import { viewSelfContainmentDiagnostics } from './external-policy.ts';
import {
  mcpAppBundlerFailureDiagnostic,
  mcpAppCompileErrorDiagnostics,
  mcpAppCompileWarningDiagnostics,
  mcpAppReadableFallbackDiagnostic,
  mcpAppSizeDiagnostic,
  type McpAppCompileMode,
  type McpAppDiagnosticContext,
  type McpAppOutputSize,
} from './mcp-app-diagnostics.ts';
import {
  assertGeneratedModulesRootAbsent,
  generatedMetaModulePath,
  generatedMetaModuleSource,
  generatedModulesRoot,
  metaModuleSpecifier,
  virtualModulesPluginConstructor,
} from './meta.ts';
import { collectBundledOutputEvidence } from './provenance.ts';
import { compileResultOf, inspectProductionConfig } from './rslib.ts';
import { runtimeIgnoredRoot } from './runtime-path.ts';

export type { McpAppCompileMode, McpAppOutputSize } from './mcp-app-diagnostics.ts';

export const mcpAppMimeType = 'text/html;profile=mcp-app';

/**
 * This engine's virtual-module plugin: the browser path checks the workspace
 * `@rsbuild/core`'s own Rspack rather than borrowing the Rslib guard (see
 * {@link virtualModulesPluginConstructor}).
 */
const rsbuildVirtualModulesPlugin = (): typeof rspack.experiments.VirtualModulesPlugin =>
  virtualModulesPluginConstructor(
    rspack,
    '@rsbuild/core',
    'serve the generated agent-bundle/meta module to browser MCP App bundles',
  );

/** One MCP App view the build will compile: the planning shape, known before the bundler runs. */
export interface PlannedMcpApp {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly mimeType: typeof mcpAppMimeType;
  readonly name: string;
  readonly output: string;
  readonly resourceUri: string;
  /** Every server serving this compiled app; several when servers share one identical declaration. */
  readonly serverIds: readonly string[];
  readonly source: string;
  readonly sourceInputs: readonly string[];
  readonly target: string;
}

/** A planned MCP App after its self-contained HTML was emitted and measured. */
export interface CompiledMcpApp extends PlannedMcpApp {
  readonly size: McpAppOutputSize;
}

export interface CompiledMcpAppsResult {
  readonly apps: readonly CompiledMcpApp[];
  readonly compileResults: readonly CompileResult[];
  /** Compile warnings (`AB4771`) and size advisories (`AB4772`) that did not fail the build; errors throw a `DiagnosticError` of `AB4770`s instead. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The stats every App environment records for the diagnostics: errors and
 * warnings (with their module traces, as Rsbuild's own reporter reads them)
 * and the complete module list with concatenated parts, which the `AB4772`
 * advisory ranks. The parts of a concatenated module are orphans of the
 * chunk graph, and without `orphanModules` Rspack collapses them — nested
 * and top-level alike — into one nameless aggregate, so the advisory could
 * name a CommonJS dependency but never the author's own ESM source.
 * Reasons, sources, and chunk membership are switched off: they are paid for
 * per module and nothing here reads them.
 */
const mcpAppStatsOptions = {
  all: false,
  assets: true,
  chunkModules: false,
  errors: true,
  moduleTrace: true,
  modules: true,
  nestedModules: true,
  orphanModules: true,
  reasons: false,
  source: false,
  warnings: true,
} as const;

/**
 * Compile-time collector: `onAfterEnvironmentCompile` fires with the
 * environment's stats even when the compile failed (the build then rejects
 * with Rspack's bare `Rspack build failed.`), so this is where the errors the
 * `AB4770`s carry come from. `logLevel` stays `silent`; these diagnostics are
 * the one channel. Added through `addPlugins` in `compileMcpApps`, never in
 * the composed profile `inspect --bundler` renders.
 */
const mcpAppStatsCollectorPlugin = (collected: Map<string, Rspack.StatsCompilation>): RsbuildPlugin => ({
  name: 'agent-bundle:mcp-app-stats',
  setup(api) {
    api.onAfterEnvironmentCompile(({ environment, stats }) => {
      if (stats === undefined) return;
      collected.set(environment.name, stats.toJson(mcpAppStatsOptions));
    });
  },
});

/**
 * The document defaults a template-less view ships and an authored template
 * keeps only where it left a gap: `lang="en"` on a root element that
 * declares no language, and a `<title>` naming the App when the document has
 * none (right after the charset declaration so the encoding stays first, else
 * right after `<head>`). Rsbuild's `html.title` already adds the title to a
 * template without one; this keeps the guarantee when a `tools.rsbuild` hatch
 * clears it. A template with its own `lang` or `<title>` is untouched.
 *
 * The title is the App name verbatim: config validation (`AB4324`) admits
 * only lowercase kebab-case names, so there is nothing to escape. A name that
 * reached the compiler another way and could break the markup is refused
 * rather than written.
 */
const withMcpAppHtmlDefaults = (html: string, appName: string): string => {
  const withLanguage = html.replace(/<html(?<attributes>[^>]*)>/iu, (rootElement, attributes: string) => (
    /\slang\s*=/iu.test(attributes) ? rootElement : `<html lang="en"${attributes}>`
  ));
  if (/<title[\s>]/iu.test(withLanguage)) return withLanguage;
  if (/[&<>"']/u.test(appName)) {
    throw new Error(`MCP App name ${JSON.stringify(appName)} is not the kebab-case name config validation guarantees.`);
  }
  const title = `<title>${appName}</title>`;
  const anchor = /<meta\s[^>]*charset\s*=[^>]*>|<head(?:\s[^>]*)?>/iu.exec(withLanguage);
  if (anchor === null) return withLanguage;
  const insertAt = anchor.index + anchor[0].length;
  return `${withLanguage.slice(0, insertAt)}${title}${withLanguage.slice(insertAt)}`;
};

const mcpAppHtmlDefaultsPlugin = (): RsbuildPlugin => ({
  name: 'agent-bundle:mcp-app-html-defaults',
  setup(api) {
    // The environment is the App: its name is the view's name.
    api.modifyHTML((html, { environment }) => withMcpAppHtmlDefaults(html, environment.name));
  },
});

/**
 * Rspack consults a consumer tsconfig `paths` entry before `resolve.alias`
 * (Rsbuild's default `prefer-tsconfig`, which is what lets a view import
 * through the author's own `paths`), so an entry for `agent-bundle/meta` would
 * shadow the generated identity module. This replacement rewrites the exact
 * specifier to the virtual module's path before resolution starts, ahead of
 * both; the alias stays as the declared mapping the inspection renders.
 */
const metaModuleReplacement = (metaModulePath: string): InstanceType<typeof rspack.NormalModuleReplacementPlugin> =>
  new rspack.NormalModuleReplacementPlugin(new RegExp(`^${escapeRegExp(metaModuleSpecifier)}$`, 'u'), metaModulePath);

const isMetaModuleReplacement = (plugin: unknown, metaModulePath: string): boolean =>
  plugin instanceof rspack.NormalModuleReplacementPlugin
  && plugin._args[0].test(metaModuleSpecifier)
  && plugin._args[1] === metaModulePath;

const appRuntimeReplacement = (runtimePath: string): InstanceType<typeof rspack.NormalModuleReplacementPlugin> =>
  new rspack.NormalModuleReplacementPlugin(new RegExp(`^${escapeRegExp(appRuntimeSpecifier)}$`, 'u'), runtimePath);

const isAppRuntimeReplacement = (plugin: unknown, runtimePath: string): boolean =>
  plugin instanceof rspack.NormalModuleReplacementPlugin
  && plugin._args[0].test(appRuntimeSpecifier)
  && plugin._args[1] === runtimePath;

const assertResolvedViewConfig = (
  inspection: Awaited<ReturnType<Awaited<ReturnType<typeof createRsbuild>>['inspectConfig']>>,
  appNames: readonly string[],
  outputRoot: string,
  metaModulePath: string,
  runtimePath: string,
): void => {
  const environments = inspection.origin.environmentConfigs;
  const bundlers = inspection.origin.bundlerConfigs;
  if (
    Object.keys(environments).length !== appNames.length ||
    bundlers.length !== appNames.length ||
    appNames.some((name) => environments[name] === undefined)
  ) {
    throw new Error('Rsbuild did not resolve one browser environment for every MCP App.');
  }
  for (const environment of Object.values(environments)) {
    if (
      // Cleaning the shared staged target root would delete sibling outputs.
      environment.output.cleanDistPath !== false ||
      environment.output.filenameHash !== false ||
      environment.output.inlineScripts !== true ||
      environment.output.inlineStyles !== true ||
      environment.output.dataUriLimit !== Number.MAX_SAFE_INTEGER ||
      environment.splitChunks !== false
    ) {
      throw new Error('Rsbuild resolved an invalid self-contained MCP App configuration.');
    }
  }
  // The compiler name is how each view's compile evidence finds its App.
  if (bundlers.map((bundler) => bundler.name).toSorted().join('\0') !== appNames.toSorted().join('\0')) {
    throw new Error('Rsbuild resolved an invalid self-contained MCP App configuration.');
  }
  for (const bundler of bundlers) {
    if (
      bundler.output?.asyncChunks !== false ||
      bundler.output.path !== outputRoot ||
      // The reserved `agent-bundle/meta` specifier must beat a consumer
      // tsconfig `paths` entry that shadows it (see `metaModuleReplacement`).
      !(bundler.plugins ?? []).some((plugin) => isMetaModuleReplacement(plugin, metaModulePath)) ||
      !(bundler.plugins ?? []).some((plugin) => isAppRuntimeReplacement(plugin, runtimePath))
    ) {
      throw new Error('Rsbuild resolved an invalid self-contained MCP App configuration.');
    }
  }
};

/**
 * Proves every planned view landed as exactly one self-contained HTML file
 * and measures it: the emitted bytes and their gzip size are what the build
 * summary reports and what the size advisory judges.
 */
const assertSelfContainedViews = async (
  compiled: readonly PlannedMcpApp[],
  outputRoot: string,
): Promise<ReadonlyMap<string, McpAppOutputSize>> => {
  const expected = new Set(compiled.map((entry) => entry.output));
  const files = await listArtifactFiles(outputRoot);
  const unexpected = files.filter((entry) => !expected.has(resolve(outputRoot, entry.path))).map((entry) => entry.path);
  if (unexpected.length > 0) {
    throw new Error(
      `Rsbuild emitted files beyond the stable self-contained MCP App HTML output: ${unexpected.join(', ')}. `
      + 'Only inline source maps keep a view self-contained; a `tools.rsbuild` output.sourceMap other than inline-source-map emits .map siblings.',
    );
  }
  if (files.length !== expected.size) {
    const emitted = new Set(files.map((entry) => resolve(outputRoot, entry.path)));
    const missing = [...expected].filter((output) => !emitted.has(output));
    throw new Error(`Rsbuild did not emit the planned MCP App HTML output: ${missing.join(', ')}.`);
  }

  const sizes = new Map<string, McpAppOutputSize>();
  for (const app of compiled) {
    const html = await readFile(app.output);
    if (/<(?:script|link)\b[^>]+(?:src|href)=/iu.test(html.toString('utf8'))) {
      throw new Error(`MCP App ${JSON.stringify(app.name)} HTML is not self-contained.`);
    }
    sizes.set(app.name, Object.freeze({ bytes: html.byteLength, gzipBytes: gzipSync(html).byteLength }));
  }
  return sizes;
};

/**
 * The compile-relevant identity of an app declaration. Server declarations
 * that agree on it describe one shared app compiled into one output; targets
 * may differ because each server selects its own hosts.
 */
const appIdentity = (app: NormalizedMcpApp): string => stableJson({
  ...(app._meta === undefined ? {} : { _meta: app._meta }),
  resourceUri: app.resourceUri,
  source: app.source,
  ...(app.template === undefined ? {} : { template: app.template }),
});

/**
 * The projections one composite root compiles apps for (#555): an app is
 * compiled once when its target set reaches any selected host, and the
 * compiled surface is attributed to the selection's identity (`target`).
 */
export interface McpAppSelection {
  readonly selected: readonly string[];
  readonly target: string;
}

export const planCompiledMcpApps = (
  apps: readonly NormalizedMcpApp[],
  options: Readonly<{ readonly outDir: string } & McpAppSelection>,
): readonly PlannedMcpApp[] => {
  const planned = new Map<string, { identity: string; serverIds: string[]; app: NormalizedMcpApp }>();
  for (const app of apps) {
    if (app.prebuilt === true || !app.targets.some((target) => options.selected.includes(target))) continue;
    const identity = appIdentity(app);
    const existing = planned.get(app.name);
    if (existing !== undefined) {
      if (existing.identity !== identity) {
        throw new Error(
          `Duplicate compiled MCP App destination ${JSON.stringify(`mcp-apps/${app.name}.html`)}; `
          + 'servers may share an app name only with an identical declaration.',
        );
      }
      if (!existing.serverIds.includes(app.serverId)) existing.serverIds.push(app.serverId);
      continue;
    }
    planned.set(app.name, { app, identity, serverIds: [app.serverId] });
  }
  return Object.freeze([...planned.values()].map(({ app, serverIds }) => Object.freeze({
    ...(app._meta === undefined ? {} : { _meta: app._meta }),
    id: app.id,
    mimeType: mcpAppMimeType,
    name: app.name,
    output: resolveArtifactDestination(resolve(options.outDir, 'mcp-apps'), `${app.name}.html`),
    resourceUri: app.resourceUri,
    serverIds: Object.freeze([...serverIds].sort((left, right) => left.localeCompare(right))),
    source: app.source,
    sourceInputs: Object.freeze([
      app.provenance.sourcePath,
      app.source,
      ...(app.template === undefined ? [] : [app.template]),
    ]),
    target: options.target,
  })));
};

/**
 * One Rsbuild instance with one environment per app compiles every view in
 * a single parallel run instead of a sequential per-app build loop. The
 * consumer escape hatch merges over this synthesized profile in the shared
 * `composeToolsLayers` order, framework invariant hook last; the
 * resolved-config assertions in `compileMcpApps` bound what the hatch may
 * change. `inspect --bundler` surfaces exactly this composition.
 */
export const composeMcpAppsRsbuildConfig = (
  sources: readonly Pick<NormalizedMcpApp, 'name' | 'source' | 'template'>[],
  options: {
    /** The project root: the bundler `context` and the root of the generated-module namespace. */
    readonly cwd: string;
    /** The project identity served to widget source as `agent-bundle/meta`. */
    readonly meta: AgentBundleMeta;
    /** Defaults to `production`; see {@link McpAppCompileMode}. */
    readonly mode?: McpAppCompileMode;
    /** Called with each view compilation's evidence once its module graph is final. */
    readonly onCompilationEvidence?: (evidence: CompilationEvidence) => void;
    readonly outDir: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): RsbuildConfig => {
  const metaModulePath = generatedMetaModulePath(options.cwd);
  const runtimePath = appRuntimePath();
  const profile: RsbuildConfig = {
    environments: Object.fromEntries(sources.map((source) => [source.name, {
      // Every view carries the React plugin, whatever its entry extension: a
      // `.ts` entry importing a `.tsx` component needs the automatic runtime
      // just as much as a `.tsx` entry, and without the plugin its JSX lowers
      // to a `React.createElement` no module has in scope.
      plugins: [pluginReact({ fastRefresh: false })],
      html: {
        inject: 'body' as const,
        mountId: 'root',
        templateParameters: ({ assetPrefix, entryName, mountId }) => ({
          assetPrefix,
          entryName,
          mountId,
        }),
        title: source.name,
        ...(source.template === undefined ? {} : { template: source.template }),
      },
      source: { entry: { [source.name]: source.source } },
    }])),
    logLevel: 'silent' as const,
    // Both compile modes build the production profile (production React, no
    // refresh runtime); development only makes the output readable.
    mode: 'production' as const,
    output: {
      dataUriLimit: Number.MAX_SAFE_INTEGER,
      distPath: { html: 'mcp-apps', root: options.outDir },
      filename: { css: '[name].css', html: '[name].html', js: '[name].js' },
      filenameHash: false,
      inlineScripts: true,
      inlineStyles: true,
      legalComments: 'inline' as const,
      // Development keeps the output readable (real identifiers, one
      // `// CONCATENATED MODULE: ./views/…` marker per module), about 2.7× the
      // production bytes. No source map in either mode: an inline map that
      // carries the sources is another ~7× (a 617 KiB ext-apps view becomes
      // 4.2 MiB), past the host bound; `tools.rsbuild.output.sourceMap` opts a
      // small view in, and only the inline forms keep it one file.
      ...(options.mode === 'development' ? { minify: false } : {}),
      sourceMap: false,
      target: 'web' as const,
      // Cursor 3.18 is the oldest currently shipped MCP App host runtime at
      // Chromium 144; Claude Desktop and Codex ship newer Chromium builds.
      // https://forum.cursor.com/t/cursor-updates-in-windows-dont-relaunch-cursor/170082
      // https://github.com/anthropics/claude-code/issues/79995
      // https://github.com/openai/codex/issues/38310
      overrideBrowserslist: ['Chrome >= 144'],
    },
    // Rsbuild's default `resolve.aliasStrategy` (`prefer-tsconfig`) stays: it
    // is what hands the author's tsconfig `paths` to the view compiler. The
    // reserved specifier wins through `metaModuleReplacement` instead.
    resolve: { dedupe: ['react', 'react-dom', 'scheduler'] },
    server: { publicDir: false },
    splitChunks: false,
  };
  const enforceInvariants = (config: Rspack.Configuration): Rspack.Configuration => {
    config.output = { ...config.output, asyncChunks: false };
    // Exact-match ($) key per the resolve.alias contract: widget source
    // imports exactly this specifier, never subpaths beneath it.
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        [`${appRuntimeSpecifier}$`]: runtimePath,
        [`${metaModuleSpecifier}$`]: metaModulePath,
      },
    };
    // Added after the hatch mutator (this hook is merged last), so a consumer
    // cannot strip the generated identity module or the dependency audit out
    // of the compiler.
    const VirtualModulesPlugin = rsbuildVirtualModulesPlugin();
    config.plugins = [
      ...(config.plugins ?? []),
      appRuntimeReplacement(runtimePath),
      metaModuleReplacement(metaModulePath),
      new VirtualModulesPlugin({ [metaModulePath]: generatedMetaModuleSource(options.meta) }),
      new ArtifactDependencyAuditPlugin(options.onCompilationEvidence ?? (() => undefined)),
    ];
    return config;
  };
  // The hatch types are this engine's own, so the layers lift unchanged.
  return mergeRsbuildConfig<RsbuildConfig>(...composeToolsLayers<RsbuildConfig>({
    invariants: frameworkInvariantLayer(enforceInvariants),
    lift: {
      rsbuild: (fragment) => fragment,
      rspack: (hatch) => ({ tools: { rspack: hatch } }),
    },
    profile,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  }));
};

/** Missing or duplicate evidence is a framework fault: Rsbuild names each environment's compiler after its App, and `assertResolvedViewConfig` pins that name. */
const assertViewsSelfContained = (
  compiled: readonly PlannedMcpApp[],
  evidence: readonly CompilationEvidence[],
  projectRoot: string,
): readonly CompilationEvidence[] => {
  const records = compiled.map((app) => {
    const records = evidence.filter((record) => record.compiler === app.name);
    const [record] = records;
    if (record === undefined || records.length !== 1) {
      throw new Error(`Expected one compilation evidence record for MCP App ${JSON.stringify(app.name)}, found ${String(records.length)}.`);
    }
    return record;
  });
  const diagnostics = records.flatMap((record, index) =>
    viewSelfContainmentDiagnostics(record, `mcp-apps/${compiled[index]!.name}.html`, projectRoot));
  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
  return Object.freeze(records);
};

/**
 * The Rsbuild instance every view of one composite root compiles through —
 * the composed profile plus the compile-time plugins the build adds beside
 * it — lowered to its resolved environments and Rspack configurations and
 * judged by {@link assertResolvedViewConfig} before anything compiles. The
 * build and `inspect --bundler` share this step, so what the inspection
 * renders is exactly what the build compiles.
 */
const lowerViews = async (
  compiled: readonly PlannedMcpApp[],
  sources: readonly Pick<NormalizedMcpApp, 'name' | 'source' | 'template'>[],
  options: Parameters<typeof composeMcpAppsRsbuildConfig>[1],
  collectedStats: Map<string, Rspack.StatsCompilation>,
): Promise<{
  readonly inspection: Awaited<ReturnType<Awaited<ReturnType<typeof createRsbuild>>['inspectConfig']>>;
  readonly rsbuild: Awaited<ReturnType<typeof createRsbuild>>;
}> => {
  const rsbuild = await createRsbuild({ cwd: options.cwd, config: composeMcpAppsRsbuildConfig(sources, options) });
  rsbuild.addPlugins([mcpAppStatsCollectorPlugin(collectedStats), mcpAppHtmlDefaultsPlugin()]);
  const inspection = await inspectProductionConfig(rsbuild);
  assertResolvedViewConfig(
    inspection,
    compiled.map((app) => app.name),
    options.outDir,
    generatedMetaModulePath(options.cwd),
    appRuntimePath(),
  );
  return { inspection, rsbuild };
};

/**
 * The lowered Rspack configuration of every planned view, in plan order,
 * from one Rsbuild instance that never builds: the same composition, mode,
 * and invariant assertions as {@link compileMcpApps}, stopping where the
 * build would start compiling. Rsbuild reads every view entry from disk
 * while resolving, exactly as the build does.
 */
export const inspectMcpAppsConfig = async (
  compiled: readonly PlannedMcpApp[],
  sources: readonly Pick<NormalizedMcpApp, 'name' | 'source' | 'template'>[],
  options: Parameters<typeof composeMcpAppsRsbuildConfig>[1],
): Promise<readonly Rspack.Configuration[]> => {
  if (compiled.length === 0) return Object.freeze([]);
  const { inspection } = await lowerViews(compiled, sources, options, new Map());
  // `assertResolvedViewConfig` has matched the compiler names to the app names.
  return Object.freeze(compiled.map((app) => inspection.origin.bundlerConfigs.find((config) => config.name === app.name)!));
};

export const compileMcpApps = async (
  apps: readonly NormalizedMcpApp[],
  options: Readonly<{
    readonly cwd: string;
    /** The project identity served to widget source as `agent-bundle/meta`. */
    readonly meta: AgentBundleMeta;
    /** Defaults to `production`; see {@link McpAppCompileMode}. */
    readonly mode?: McpAppCompileMode;
    readonly outDir: string;
    readonly tools?: AgentBundleToolsConfig;
  } & McpAppSelection>,
): Promise<CompiledMcpAppsResult> => {
  const compiled = planCompiledMcpApps(apps, { outDir: options.outDir, selected: options.selected, target: options.target });
  if (compiled.length === 0) {
    return Object.freeze({
      apps: Object.freeze([]),
      compileResults: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  }
  await assertGeneratedModulesRootAbsent(options.cwd);

  const sources = compiled.map((app) => {
    const source = apps.find((candidate) => candidate.id === app.id);
    if (source === undefined) {
      throw new Error(`MCP App ${JSON.stringify(app.id)} disappeared during compilation planning.`);
    }
    return source;
  });

  const mode: McpAppCompileMode = options.mode ?? 'production';
  const compilationEvidence: CompilationEvidence[] = [];
  const collectedStats = new Map<string, Rspack.StatsCompilation>();
  const { rsbuild } = await lowerViews(compiled, sources, {
    cwd: options.cwd,
    meta: options.meta,
    mode,
    onCompilationEvidence: (evidence) => compilationEvidence.push(evidence),
    outDir: options.outDir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  }, collectedStats);
  const contexts: readonly McpAppDiagnosticContext[] = compiled.map((app) => ({
    appName: app.name,
    entrySource: app.source,
    projectRoot: options.cwd,
  }));
  /**
   * Every Rspack error the collector recorded, as `AB4770`s; when the bundler
   * rejected without leaving a stats error (a compiler-level failure rather
   * than a module's), its own message, attributed to each App of the run.
   */
  const compileFailure = (error: unknown): DiagnosticError => {
    const fromStats = contexts.flatMap((context) =>
      mcpAppCompileErrorDiagnostics(context, collectedStats.get(context.appName)?.errors ?? []));
    if (fromStats.length > 0) return new DiagnosticError(fromStats);
    const failure = error instanceof Error ? error.message : String(error);
    return new DiagnosticError(contexts.map((context) => mcpAppBundlerFailureDiagnostic(context, failure)));
  };
  const buildViews = async (): Promise<Awaited<ReturnType<typeof rsbuild.build>>> => {
    try {
      return await rsbuild.build();
    } catch (error) {
      throw compileFailure(error);
    }
  };
  const evidenceByPath = new Map<string, readonly string[]>();
  let result: Awaited<ReturnType<typeof rsbuild.build>> | undefined;
  try {
    result = await buildViews();
    const evidence = collectBundledOutputEvidence({
      expectedAssets: compiled.map((app) => ({
        allowUnassociatedHtml: true,
        path: `mcp-apps/${app.name}.html`,
        sourceInputs: app.sourceInputs,
      })),
      // The generated identity module is virtual, but it still surfaces in
      // stats as a module under this reserved namespace.
      ignoredSourcePaths: [
        resolve(generatedModulesRoot(options.cwd)),
        runtimeIgnoredRoot(appRuntimePath()),
      ],
      projectRoot: options.cwd,
      stats: result.stats,
    });
    for (const entry of evidence) evidenceByPath.set(entry.path, entry.sourceInputs);
  } finally {
    await result?.close();
  }
  const viewEvidence = assertViewsSelfContained(compiled, compilationEvidence, options.cwd);

  const sizes = await assertSelfContainedViews(compiled, options.outDir);
  const compiledApps = Object.freeze(compiled.map((app): CompiledMcpApp => Object.freeze({
    ...app,
    size: sizes.get(app.name) ?? (() => { throw new Error(`Missing emitted size for MCP App ${JSON.stringify(app.name)}.`); })(),
    sourceInputs: evidenceByPath.get(`mcp-apps/${app.name}.html`) ?? (() => { throw new Error(`Missing bundled MCP App evidence for ${JSON.stringify(app.name)}.`); })(),
  })));
  const emittedAssets = new Set(compiledApps.map((app) => `mcp-apps/${app.name}.html`));
  const compileResults = Object.freeze(compiledApps.map((app, index) => compileResultOf(viewEvidence[index]!, {
    asset: { path: `mcp-apps/${app.name}.html`, sourceInputs: app.sourceInputs },
    cwd: options.cwd,
    dependencyRoots: new Map(),
    emittedAssets,
  })));
  /**
   * One App's advisories: its Rspack warnings, then the size advisory for
   * the document that was emitted for it — by default this compile's, or the
   * production replacement's when the fallback below swapped it in.
   */
  const appDiagnostics = (
    context: McpAppDiagnosticContext,
    index: number,
    emitted: { readonly mode: McpAppCompileMode; readonly size: McpAppOutputSize } = { mode, size: compiledApps[index]!.size },
  ): readonly Diagnostic[] => {
    const stats = collectedStats.get(context.appName);
    const size = mcpAppSizeDiagnostic(context, { modules: stats?.modules ?? [], ...emitted });
    return [
      ...mcpAppCompileWarningDiagnostics(context, stats?.warnings ?? []),
      ...(size === undefined ? [] : [size]),
    ];
  };
  const oversized = mode === 'development' ? compiledApps.filter((app) => app.size.bytes > MAX_APP_HTML_BYTES) : [];
  if (oversized.length === 0) {
    return Object.freeze({
      apps: compiledApps,
      compileResults,
      diagnostics: freezeDiagnostics(contexts.flatMap((context, index) => appDiagnostics(context, index))),
    });
  }

  // Readable output that would not render in the hosts gives way to the
  // production profile for that view, so the Workbench preview shows every
  // view `agent-bundle build` ships. The production compile lands in its own
  // directory: the staged root already holds the other views, which the
  // self-containment assertion would count as strays.
  const fallbackRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-production-'));
  let production: CompiledMcpAppsResult;
  try {
    production = await compileMcpApps(
      apps.filter((app) => oversized.some((entry) => entry.name === app.name)),
      { ...options, mode: 'production', outDir: fallbackRoot },
    );
    for (const app of oversized) {
      const replacement = production.apps.find((entry) => entry.name === app.name);
      if (replacement === undefined) {
        throw new Error(`MCP App ${JSON.stringify(app.name)} disappeared during its production fallback compile.`);
      }
      await copyFile(replacement.output, app.output);
    }
  } finally {
    await rm(fallbackRoot, { force: true, recursive: true });
  }
  const replaced = new Map(production.apps.map((app) => [app.name, app]));
  const replacementResults = new Map(production.compileResults.map((result) => [
    result.assets[0]!.path,
    result,
  ]));
  return Object.freeze({
    apps: Object.freeze(compiledApps.map((app) => {
      const replacement = replaced.get(app.name);
      return replacement === undefined ? app : Object.freeze({ ...app, size: replacement.size, sourceInputs: replacement.sourceInputs });
    })),
    compileResults: Object.freeze(compiledApps.map((app, index) =>
      replacementResults.get(`mcp-apps/${app.name}.html`) ?? compileResults[index]!)),
    // The production compile's own diagnostics are not merged: its warnings
    // are this compile's (same module graph), and each replaced App gets
    // exactly one `AB4772` here — the substitution notice when the
    // replacement fits the hosts, else the plain host-bound advisory, since a
    // notice claiming the preview renders it would be false.
    diagnostics: freezeDiagnostics(contexts.flatMap((context, index) => {
      const replacement = replaced.get(context.appName);
      if (replacement === undefined) return appDiagnostics(context, index);
      if (replacement.size.bytes > MAX_APP_HTML_BYTES) return appDiagnostics(context, index, { mode: 'production', size: replacement.size });
      const stats = collectedStats.get(context.appName);
      return [
        ...mcpAppCompileWarningDiagnostics(context, stats?.warnings ?? []),
        mcpAppReadableFallbackDiagnostic(context, {
          modules: stats?.modules ?? [],
          production: replacement.size,
          readable: compiledApps[index]!.size,
        }),
      ];
    })),
  });
};
