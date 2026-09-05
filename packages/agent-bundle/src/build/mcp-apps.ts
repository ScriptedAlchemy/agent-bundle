import { createRsbuild, mergeRsbuildConfig, rspack, type RsbuildConfig, type Rspack } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { Diagnostic } from '../core/diagnostics.ts';
import type { AgentBundleToolsConfig, NormalizedMcpApp } from '../core/types.ts';
import { stableJson } from '../core/digest.ts';
import type { AgentBundleMeta } from '../meta.ts';
import { composeToolsLayers, frameworkInvariantLayer } from './compose-layers.ts';
import { listArtifactFiles, resolveArtifactDestination } from './emit.ts';
import {
  assertGeneratedModulesRootAbsent,
  generatedMetaModulePath,
  generatedMetaModuleSource,
  generatedModulesRoot,
  metaModuleSpecifier,
  virtualModulesPluginConstructor,
} from './meta.ts';
import { collectBundledOutputEvidence } from './provenance.ts';

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

/** The emitted size of one self-contained MCP App HTML document. */
export interface McpAppOutputSize {
  /** UTF-8 bytes of the emitted HTML as written to the artifact. */
  readonly bytes: number;
  /** Bytes of the same document after gzip, the size a compressing transport would carry. */
  readonly gzipBytes: number;
}

/** A planned MCP App after its self-contained HTML was emitted and measured. */
export interface CompiledMcpApp extends PlannedMcpApp {
  readonly size: McpAppOutputSize;
}

/**
 * Which profile the view compiler emits. `production` is the artifact
 * profile every `agent-bundle build` ships; `development` is the Workbench
 * dev-loop profile (readable output with inline source maps), still
 * self-contained.
 */
export type McpAppCompileMode = 'development' | 'production';

export interface CompiledMcpAppsResult {
  readonly apps: readonly CompiledMcpApp[];
  /** Compile warnings and advisories that did not fail the build; errors throw a `DiagnosticError` instead. */
  readonly diagnostics: readonly Diagnostic[];
}

const usesReactSyntax = (source: string): boolean => /\.[jt]sx$/iu.test(extname(source));

const assertResolvedViewConfig = (
  inspection: Awaited<ReturnType<Awaited<ReturnType<typeof createRsbuild>>['inspectConfig']>>,
  appNames: readonly string[],
  outputRoot: string,
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
  for (const bundler of bundlers) {
    if (bundler.output?.asyncChunks !== false || bundler.output.path !== outputRoot) {
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
  if (files.length !== expected.size || files.some((entry) => !expected.has(resolve(outputRoot, entry.path)))) {
    throw new Error('Rsbuild emitted files beyond the stable self-contained MCP App HTML output.');
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

export type McpAppTargetSelection =
  | Readonly<{ readonly target: string; readonly targets?: never }>
  | Readonly<{ readonly target?: never; readonly targets: Readonly<Record<string, string>> }>;

const selectedAppTarget = (
  app: NormalizedMcpApp,
  selection: McpAppTargetSelection,
): string | undefined => {
  const target = selection.target ?? selection.targets[app.id];
  return target !== undefined && app.targets.includes(target) ? target : undefined;
};

export const planCompiledMcpApps = (
  apps: readonly NormalizedMcpApp[],
  options: Readonly<{ readonly outDir: string } & McpAppTargetSelection>,
): readonly PlannedMcpApp[] => {
  const planned = new Map<string, { identity: string; serverIds: string[]; app: NormalizedMcpApp; target: string }>();
  for (const app of apps) {
    const target = selectedAppTarget(app, options);
    if (app.prebuilt === true || target === undefined) continue;
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
    planned.set(app.name, { app, identity, serverIds: [app.serverId], target });
  }
  return Object.freeze([...planned.values()].map(({ app, serverIds, target }) => Object.freeze({
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
    target,
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
    readonly outDir: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): RsbuildConfig => {
  const metaModulePath = generatedMetaModulePath(options.cwd);
  const profile: RsbuildConfig = {
    environments: Object.fromEntries(sources.map((source) => [source.name, {
      ...(usesReactSyntax(source.source) ? { plugins: [pluginReact()] } : {}),
      html: {
        inject: 'body' as const,
        ...(source.template === undefined ? {} : { template: source.template }),
      },
      source: { entry: { [source.name]: source.source } },
    }])),
    logLevel: 'silent' as const,
    mode: 'production' as const,
    output: {
      dataUriLimit: Number.MAX_SAFE_INTEGER,
      distPath: { html: 'mcp-apps', root: options.outDir },
      filename: { css: '[name].css', html: '[name].html', js: '[name].js' },
      filenameHash: false,
      inlineScripts: true,
      inlineStyles: true,
      legalComments: 'inline' as const,
      sourceMap: false,
      target: 'web' as const,
    },
    server: { publicDir: false },
    splitChunks: false,
  };
  const enforceInvariants = (config: Rspack.Configuration): Rspack.Configuration => {
    config.output = { ...config.output, asyncChunks: false };
    // Exact-match ($) key per the resolve.alias contract: widget source
    // imports exactly this specifier, never subpaths beneath it.
    config.resolve = {
      ...config.resolve,
      alias: { ...config.resolve?.alias, [`${metaModuleSpecifier}$`]: metaModulePath },
    };
    // Added after the hatch mutator (this hook is merged last), so a consumer
    // cannot strip the generated identity module out of the compiler.
    const VirtualModulesPlugin = rsbuildVirtualModulesPlugin();
    config.plugins = [
      ...(config.plugins ?? []),
      new VirtualModulesPlugin({ [metaModulePath]: generatedMetaModuleSource(options.meta) }),
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
  } & McpAppTargetSelection>,
): Promise<CompiledMcpAppsResult> => {
  const compiled = planCompiledMcpApps(apps, {
    outDir: options.outDir,
    ...(options.target === undefined ? { targets: options.targets } : { target: options.target }),
  });
  if (compiled.length === 0) {
    return Object.freeze({ apps: Object.freeze([]), diagnostics: Object.freeze([]) });
  }
  await assertGeneratedModulesRootAbsent(options.cwd);

  const sources = compiled.map((app) => {
    const source = apps.find((candidate) => candidate.id === app.id);
    if (source === undefined) {
      throw new Error(`MCP App ${JSON.stringify(app.id)} disappeared during compilation planning.`);
    }
    return source;
  });

  const rsbuild = await createRsbuild({
    cwd: options.cwd,
    config: composeMcpAppsRsbuildConfig(sources, {
      cwd: options.cwd,
      meta: options.meta,
      outDir: options.outDir,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
  });
  const inspection = await rsbuild.inspectConfig({ mode: 'production' });
  assertResolvedViewConfig(inspection, compiled.map((app) => app.name), options.outDir);
  const evidenceByPath = new Map<string, readonly string[]>();
  let result: Awaited<ReturnType<typeof rsbuild.build>> | undefined;
  try {
    result = await rsbuild.build();
    const evidence = collectBundledOutputEvidence({
      expectedAssets: compiled.map((app) => ({
        allowUnassociatedHtml: true,
        path: `mcp-apps/${app.name}.html`,
        sourceInputs: app.sourceInputs,
      })),
      // The generated identity module is virtual, but it still surfaces in
      // stats as a module under this reserved namespace.
      ignoredSourcePaths: [resolve(generatedModulesRoot(options.cwd))],
      projectRoot: options.cwd,
      stats: result.stats,
    });
    for (const entry of evidence) evidenceByPath.set(entry.path, entry.sourceInputs);
  } finally {
    await result?.close();
  }

  const sizes = await assertSelfContainedViews(compiled, options.outDir);
  const compiledApps = Object.freeze(compiled.map((app): CompiledMcpApp => Object.freeze({
    ...app,
    size: sizes.get(app.name) ?? (() => { throw new Error(`Missing emitted size for MCP App ${JSON.stringify(app.name)}.`); })(),
    sourceInputs: evidenceByPath.get(`mcp-apps/${app.name}.html`) ?? (() => { throw new Error(`Missing bundled MCP App evidence for ${JSON.stringify(app.name)}.`); })(),
  })));
  return Object.freeze({ apps: compiledApps, diagnostics: Object.freeze([]) });
};
