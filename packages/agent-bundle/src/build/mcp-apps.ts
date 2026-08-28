import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import type { NormalizedMcpApp } from '../core/types.ts';
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
  readonly serverId: string;
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

export const planCompiledMcpApps = (
  apps: readonly NormalizedMcpApp[],
  options: { readonly outDir: string; readonly target: string },
): readonly CompiledMcpApp[] => {
  const names = new Set<string>();
  return Object.freeze(apps
    .filter((app) => app.targets.includes(options.target))
    .map((app) => {
      if (names.has(app.name)) {
        throw new Error(`Duplicate compiled MCP App destination ${JSON.stringify(`mcp-apps/${app.name}.html`)}.`);
      }
      names.add(app.name);
      return Object.freeze({
        ...(app._meta === undefined ? {} : { _meta: app._meta }),
        id: app.id,
        mimeType: mcpAppMimeType,
        name: app.name,
        output: resolveArtifactDestination(resolve(options.outDir, 'mcp-apps'), `${app.name}.html`),
        resourceUri: app.resourceUri,
        serverId: app.serverId,
        source: app.source,
        sourceInputs: Object.freeze([
          app.provenance.sourcePath,
          app.source,
          ...(app.template === undefined ? [] : [app.template]),
        ]),
        target: options.target,
      });
    }));
};

export const compileMcpApps = async (
  apps: readonly NormalizedMcpApp[],
  options: { readonly cwd: string; readonly outDir: string; readonly target: string },
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

  // One Rsbuild instance with one environment per app compiles every view in
  // a single parallel run instead of a sequential per-app build loop.
  const rsbuild = await createRsbuild({
    cwd: options.cwd,
    config: {
      environments: Object.fromEntries(sources.map((source) => [source.name, {
        ...(usesReactSyntax(source.source) ? { plugins: [pluginReact()] } : {}),
        html: {
          inject: 'body' as const,
          ...(source.template === undefined ? {} : { template: source.template }),
        },
        source: { entry: { [source.name]: source.source } },
      }])),
      logLevel: 'silent',
      mode: 'production',
      output: {
        cleanDistPath: false,
        dataUriLimit: Number.MAX_SAFE_INTEGER,
        distPath: { html: 'mcp-apps', root: options.outDir },
        filename: { css: '[name].css', html: '[name].html', js: '[name].js' },
        filenameHash: false,
        inlineScripts: true,
        inlineStyles: true,
        legalComments: 'inline',
        sourceMap: false,
        target: 'web',
      },
      server: { publicDir: false },
      splitChunks: false,
      tools: {
        rspack: (config) => {
          config.output.asyncChunks = false;
        },
      },
    },
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
