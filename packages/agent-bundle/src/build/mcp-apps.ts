import { createRsbuild, mergeRsbuildConfig, type RsbuildConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import type { AgentBundleToolsConfig, NormalizedMcpApp } from '../core/types.ts';
import { stableJson } from '../core/digest.ts';
import { listArtifactFiles, resolveArtifactDestination } from './emit.ts';
import { collectBundledOutputEvidence } from './provenance.ts';

export const mcpAppMimeType = 'text/html;profile=mcp-app';

export interface CompiledMcpApp {
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

const assertSelfContainedViews = async (
  compiled: readonly CompiledMcpApp[],
  outputRoot: string,
): Promise<void> => {
  const expected = new Set(compiled.map((entry) => entry.output));
  const files = await listArtifactFiles(outputRoot);
  if (files.length !== expected.size || files.some((entry) => !expected.has(resolve(outputRoot, entry.path)))) {
    throw new Error('Rsbuild emitted files beyond the stable self-contained MCP App HTML output.');
  }

  for (const app of compiled) {
    const html = await readFile(app.output, 'utf8');
    if (/<(?:script|link)\b[^>]+(?:src|href)=/iu.test(html)) {
      throw new Error(`MCP App ${JSON.stringify(app.name)} HTML is not self-contained.`);
    }
  }
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

export const planCompiledMcpApps = (
  apps: readonly NormalizedMcpApp[],
  options: { readonly outDir: string; readonly target: string },
): readonly CompiledMcpApp[] => {
  const planned = new Map<string, { identity: string; serverIds: string[]; app: NormalizedMcpApp }>();
  for (const app of apps.filter((candidate) => candidate.targets.includes(options.target))) {
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
 * consumer escape hatch merges over this synthesized profile with the
 * framework invariant hook appended last; the resolved-config assertions in
 * `compileMcpApps` bound what the hatch may change. `inspect --bundler`
 * surfaces exactly this composition.
 */
export const composeMcpAppsRsbuildConfig = (
  sources: readonly Pick<NormalizedMcpApp, 'name' | 'source' | 'template'>[],
  options: { readonly outDir: string; readonly tools?: AgentBundleToolsConfig },
): RsbuildConfig => {
  const profile = {
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
      cleanDistPath: false,
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
  const enforceInvariants = (config: { output: { asyncChunks?: boolean } }): void => {
    config.output.asyncChunks = false;
  };
  return mergeRsbuildConfig(
    profile as never,
    ...(options.tools?.rsbuild === undefined ? [] : [options.tools.rsbuild as never]),
    ...(options.tools?.rspack === undefined ? [] : [{ tools: { rspack: options.tools.rspack } } as never]),
    { tools: { rspack: enforceInvariants } } as never,
  ) as RsbuildConfig;
};

export const compileMcpApps = async (
  apps: readonly NormalizedMcpApp[],
  options: {
    readonly cwd: string;
    readonly outDir: string;
    readonly target: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): Promise<readonly CompiledMcpApp[]> => {
  const compiled = planCompiledMcpApps(apps, { outDir: options.outDir, target: options.target });
  if (compiled.length === 0) {
    return compiled;
  }

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
      projectRoot: options.cwd,
      stats: result.stats,
    });
    for (const entry of evidence) evidenceByPath.set(entry.path, entry.sourceInputs);
  } finally {
    await result?.close();
  }

  await assertSelfContainedViews(compiled, options.outDir);
  return Object.freeze(compiled.map((app) => Object.freeze({
    ...app,
    sourceInputs: evidenceByPath.get(`mcp-apps/${app.name}.html`) ?? (() => { throw new Error(`Missing bundled MCP App evidence for ${JSON.stringify(app.name)}.`); })(),
  })));
};
