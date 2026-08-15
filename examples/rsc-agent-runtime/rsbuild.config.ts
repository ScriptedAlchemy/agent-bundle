import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defineConfig, type RsbuildConfig, type RsbuildPlugin } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { Layers, pluginRSC } from 'rsbuild-plugin-rsc';

import { emitRuntimeArtifacts } from './src/build/emit-artifacts.js';

export interface RscRuntimeCompileSnapshot {
  readonly attemptId: string;
  readonly candidateId: string;
  readonly preparedRevision: string;
  readonly rscCohortRevision: number;
  readonly sourceRevision: string;
}

export interface RscRuntimeRsbuildConfigOptions {
  readonly compilerRoot?: string;
  readonly mode: 'development' | 'production';
  readonly onCompile?: Readonly<{
    beforeAttempt(): string;
    capture(input: {
      readonly attemptId: string;
      readonly cohortChanged: boolean;
      readonly hasErrors: boolean;
      readonly sourceRevision: string;
    }): Promise<RscRuntimeCompileSnapshot | undefined>;
    enqueue(snapshot: RscRuntimeCompileSnapshot): void;
    failAttempt(attemptId: string, error: unknown): void;
  }>;
}

const emitRuntimeManifest = (): RsbuildPlugin => ({
  apply: 'build',
  name: 'emit-rsc-agent-runtime-manifest',
  setup(api) {
    api.onBeforeBuild(async ({ environments }) => {
      await rm(dirname(environments.rsc.distPath), { force: true, recursive: true });
    });
    api.onAfterBuild(async ({ environments }) => {
      await emitRuntimeArtifacts(environments.rsc.distPath);
    });
  },
});

const runtimeCompileObserverPlugin = (
  observer: NonNullable<RscRuntimeRsbuildConfigOptions['onCompile']>,
): RsbuildPlugin => {
  const pendingAttemptIds: string[] = [];
  let previousCapturedCohortHash: string | undefined;
  return {
    name: 'agent-bundle:rsc-runtime-compile-observer',
    setup(api) {
      api.onBeforeDevCompile(() => {
        pendingAttemptIds.push(observer.beforeAttempt());
      });
      api.onAfterDevCompile(async ({ stats }) => {
        const attemptId = pendingAttemptIds.shift();
        if (attemptId === undefined) {
          throw new Error('RSC runtime compile completed without a matching attempt.');
        }
        try {
          const json = stats.toJson({ all: false, children: true, hash: true });
          const hashes = (json.children ?? [])
            .filter((child) => child.name === 'rsc' || child.name === 'widget')
            .map((child) => [child.name === 'rsc' ? 'rsc' : 'widget', child.hash ?? ''] as const)
            .sort(([left], [right]) => left.localeCompare(right));
          const sourceRevision = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
          const snapshot = await observer.capture({
            attemptId,
            cohortChanged: sourceRevision !== previousCapturedCohortHash,
            hasErrors: stats.hasErrors(),
            sourceRevision,
          });
          if (snapshot !== undefined) {
            observer.enqueue(snapshot);
            previousCapturedCohortHash = sourceRevision;
          }
        } catch (error) {
          observer.failAttempt(attemptId, error);
        }
      });
    },
  };
};

export const createRscRuntimeRsbuildConfig = (
  options: RscRuntimeRsbuildConfigOptions,
): RsbuildConfig => {
  const development = options.mode === 'development';
  if (development && options.compilerRoot === undefined) {
    throw new TypeError('Development RSC runtime config requires compilerRoot.');
  }
  const root = (name: 'rsc' | 'widget' | 'app', productionRoot: string): string =>
    development ? join(options.compilerRoot as string, name) : productionRoot;

  return {
    ...(development ? {
      dev: { writeToDisk: true },
      server: { host: '127.0.0.1', port: 0, printUrls: false },
    } : {}),
    plugins: [
      pluginReact(),
      pluginRSC({ environments: { server: 'rsc', client: 'widget' } }),
      emitRuntimeManifest(),
      ...(options.onCompile === undefined ? [] : [runtimeCompileObserverPlugin(options.onCompile)]),
    ],
    environments: {
      rsc: {
        source: {
          entry: {
            ...(development ? { 'dev/definition': './src/dev/definition-entry.ts' } : {}),
            ...(development ? { 'dev/invoke': './src/dev/invocation-worker.ts' } : {}),
            'hook/index': './src/hook/cli.ts',
            'rsc/index': { import: './src/rsc/worker.tsx', layer: Layers.rsc },
            'mcp/stdio': './src/mcp/stdio.ts',
            'mcp/http': './src/mcp/http.ts',
          },
        },
        tools: {
          rspack: {
            module: {
              rules: [{
                parser: { importMeta: { url: false } },
                test: /[\\/]src[\\/]flight[\\/]request-render\.ts$/,
              }],
            },
          },
        },
        output: {
          cleanDistPath: false,
          distPath: { js: './', jsAsync: 'chunks', root: root('rsc', 'dist/runtime') },
          filename: { js: '[name].js' },
          manifest: 'runtime-assets.json',
          target: 'node',
        },
      },
      widget: {
        source: {
          entry: {
            ...(development ? { 'dev/definition': './src/rsc/client-anchor.ts' } : {}),
            ...(development ? { 'dev/invoke': './src/rsc/client-anchor.ts' } : {}),
            'hook/index': './src/rsc/client-anchor.ts',
            'rsc/index': './src/rsc/client-anchor.ts',
            'mcp/stdio': './src/rsc/client-anchor.ts',
            'mcp/http': './src/rsc/client-anchor.ts',
          },
        },
        output: {
          cleanDistPath: false,
          distPath: { root: root('widget', 'dist/widget') },
          filename: { js: '[name].js' },
          target: 'web',
        },
      },
      app: {
        html: { inject: 'body' },
        output: {
          cleanDistPath: false,
          distPath: { root: root('app', 'dist/app') },
          inlineScripts: true,
          inlineStyles: true,
          target: 'web',
        },
        source: {
          entry: {
            'edit-timeline-v1': './src/widget/index.tsx',
            standalone: './src/widget/index.tsx',
          },
        },
        tools: {
          rspack: {
            module: { parser: { javascript: { dynamicImportMode: 'eager' } } },
          },
        },
      },
    },
  };
};

export default defineConfig(createRscRuntimeRsbuildConfig({ mode: 'production' }));
