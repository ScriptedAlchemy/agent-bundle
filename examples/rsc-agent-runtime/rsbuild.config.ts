import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defineConfig, type RsbuildConfig, type RsbuildDevServer, type RsbuildPlugin } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { Layers, pluginRSC } from 'rsbuild-plugin-rsc';

import { emitRuntimeArtifacts } from './src/build/emit-artifacts.js';

export interface RscRuntimeCompileSnapshot {
  readonly acceptCompilerAssetCheckpoint?: () => void;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly discardCompilerAssetCheckpoint?: () => void;
  readonly preparedRevision: string;
  readonly rscCohortRevision: number;
  readonly sourceRevision: string;
}

export type RscRuntimeActivationOutcome = 'activated' | 'failed';
export type RscRuntimeCompileFailureKind = 'provider-lifecycle' | 'source-build';

export interface RscRuntimeRsbuildConfigOptions {
  readonly compilerRoot?: string;
  readonly mode: 'development' | 'production';
  /** Receives the App environment's server-only Rsbuild HMR credential. */
  readonly onAppWebSocketToken?: (input: Readonly<{
    readonly path: string;
    readonly token: string;
  }>) => void;
  readonly onCompile?: Readonly<{
    beforeAttempt(): string;
    capture(input: {
      readonly attemptId: string;
      readonly cohortChanged: boolean;
      readonly hasErrors: boolean;
      readonly sourceRevision: string;
    }): Promise<RscRuntimeCompileSnapshot | undefined>;
    /** Queues provider activation but never blocks the Rsbuild compile hook. */
    enqueue(snapshot: RscRuntimeCompileSnapshot): unknown;
    failAttempt(attemptId: string, error: unknown, kind: RscRuntimeCompileFailureKind): void;
  }>;
}

const runtimeAppHmrTokenPlugin = (
  capture: NonNullable<RscRuntimeRsbuildConfigOptions['onAppWebSocketToken']>,
): RsbuildPlugin => {
  let devServer: RsbuildDevServer | undefined;
  let lastAppCompilation: object | string | undefined;
  return {
    name: 'agent-bundle:rsc-runtime-app-hmr-token',
    setup(api) {
      api.onAfterCreateCompiler(({ environments }) => {
        const app = environments.app;
        const token = app?.webSocketToken;
        if (typeof token !== 'string') throw new Error('RSC runtime App compiler did not expose an HMR credential.');
        const path = app?.config.dev.client.path;
        if (typeof path !== 'string') throw new Error('RSC runtime App compiler did not expose a normalized HMR path.');
        capture(Object.freeze({ path, token }));
      });
      api.onBeforeStartDevServer(({ server }) => {
        devServer = server;
        lastAppCompilation = undefined;
      });
      api.onCloseDevServer(() => {
        devServer = undefined;
        lastAppCompilation = undefined;
      });
      api.onAfterEnvironmentCompile(({ environment, isFirstCompile, stats }) => {
        if (devServer === undefined || environment.name !== 'app' || stats === undefined || stats.hasErrors()) return;
        const compilation = typeof stats.hash === 'string' && stats.hash.length > 0 ? stats.hash : stats;
        if (lastAppCompilation === compilation) return;
        lastAppCompilation = compilation;
        if (isFirstCompile) return;
        devServer?.environments.app.hot.send('full-reload');
      });
    },
  };
};

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
  let capturedCohort: Readonly<{ readonly activationSequence: number; readonly sourceRevision: string }> | undefined;
  let nextActivationSequence = 0;
  return {
    name: 'agent-bundle:rsc-runtime-compile-observer',
    setup(api) {
      api.onBeforeDevCompile(() => {
        // Rsbuild documents global hook order, but not one before/after pair
        // per MultiCompiler cohort. FIFO pairing is only empirical in 2.2.1;
        // reject identities that cannot be paired unambiguously, while
        // retaining legitimate overlapping before callbacks in FIFO order.
        const attemptId = observer.beforeAttempt();
        if (pendingAttemptIds.includes(attemptId)) {
          const pairingError = new Error(`RSC runtime compile produced duplicate pending attempt identity ${JSON.stringify(attemptId)}.`);
          for (const unmatchedAttemptId of [...pendingAttemptIds, attemptId]) {
            observer.failAttempt(unmatchedAttemptId, pairingError, 'provider-lifecycle');
          }
          pendingAttemptIds.length = 0;
          throw pairingError;
        }
        pendingAttemptIds.push(attemptId);
      });
      api.onAfterDevCompile(async ({ stats }) => {
        const attemptId = pendingAttemptIds.shift();
        if (attemptId === undefined) {
          throw new Error('RSC runtime compile completed without a matching attempt.');
        }
        let snapshot: RscRuntimeCompileSnapshot | undefined;
        try {
          if (stats.hasErrors()) {
            capturedCohort = undefined;
            observer.failAttempt(attemptId, new Error('RSC runtime compile reported errors.'), 'source-build');
            return;
          }
          const json = stats.toJson({ all: false, children: true, hash: true });
          const cohortHashes = new Map<'rsc' | 'widget', string>();
          // Rspack documents optional Stats child names, but Rsbuild does not
          // promise they equal environment keys. We explicitly name each
          // compiler below; the name-based cohort match is otherwise only an
          // empirical Rsbuild 2.2.1 behavior.
          for (const child of json.children ?? []) {
            if (child.name !== 'rsc' && child.name !== 'widget') continue;
            if (typeof child.hash !== 'string' || child.hash.length === 0) {
              throw new Error(`RSC runtime ${child.name} compilation has no hash.`);
            }
            if (cohortHashes.has(child.name)) {
              throw new Error(`RSC runtime compile contains duplicate ${child.name} stats.`);
            }
            cohortHashes.set(child.name, child.hash);
          }
          if (cohortHashes.size !== 2 || !cohortHashes.has('rsc') || !cohortHashes.has('widget')) {
            throw new Error('RSC runtime compile requires exactly one RSC and widget stats child.');
          }
          const hashes = (['rsc', 'widget'] as const).map((name) => [name, cohortHashes.get(name) as string]);
          const sourceRevision = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
          snapshot = await observer.capture({
            attemptId,
            cohortChanged: sourceRevision !== capturedCohort?.sourceRevision,
            hasErrors: false,
            sourceRevision,
          });
          if (snapshot !== undefined) {
            const activationSequence = ++nextActivationSequence;
            capturedCohort = Object.freeze({ activationSequence, sourceRevision });
            let queued: unknown;
            try {
              queued = observer.enqueue(snapshot);
            } catch (error) {
              if (capturedCohort?.activationSequence === activationSequence) capturedCohort = undefined;
              throw error;
            }
            const completion = queued instanceof Promise
              ? queued as Promise<RscRuntimeActivationOutcome>
              : Promise.resolve(undefined);
            snapshot.acceptCompilerAssetCheckpoint?.();
            void completion.then((outcome) => {
              if (outcome === 'activated' || outcome === undefined) return;
              if (capturedCohort?.activationSequence === activationSequence) capturedCohort = undefined;
            }, () => {
              if (capturedCohort?.activationSequence === activationSequence) capturedCohort = undefined;
            });
          }
        } catch (error) {
          try {
            snapshot?.discardCompilerAssetCheckpoint?.();
          } catch {
            // The original capture/enqueue error remains the attempted failure cause.
          }
          observer.failAttempt(attemptId, error, 'provider-lifecycle');
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
    // The runtime flavor is a pinned contract: react and react-server-dom
    // compile as their production variants, so Flight payloads stay compact
    // model rows without development debug/timing frames. This was
    // previously implicit — some in-process bundler run (for example the
    // dev artifact epoch compiling MCP entries) had already set NODE_ENV to
    // "production" before this config compiled. With prebuilt host
    // packaging nothing else compiles first, so the flavor must not float
    // with ambient NODE_ENV. `options.mode` keeps selecting the compile
    // topology (dev entries, compiler roots) independently of this flavor.
    mode: 'production',
    ...(development ? {
      dev: { writeToDisk: true },
      // Port 0 lets the OS assign the listener. Rsbuild's default (3000 with an
      // incrementing probe) makes every concurrent runtime session on a host
      // race for the same first candidate, which surfaces as EADDRINUSE when
      // suites run in parallel. Consumers read the resolved port back from
      // `rsbuild.context.devServer`.
      server: { host: '127.0.0.1', port: 0, printUrls: false },
    } : {}),
    plugins: [
      pluginReact(),
      pluginRSC({ environments: { server: 'rsc', client: 'widget' } }),
      emitRuntimeManifest(),
      ...(options.onAppWebSocketToken === undefined ? [] : [runtimeAppHmrTokenPlugin(options.onAppWebSocketToken)]),
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
            name: 'rsc',
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
        // Rsbuild 2.2 enabled sync chunk splitting for node targets by
        // default. Worker-spawning modules here resolve sibling entries from
        // their own preserved `import.meta.url`, so hoisting them into a
        // shared chunk at the dist root breaks those relative paths.
        splitChunks: false,
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
        tools: {
          rspack: { name: 'widget' },
        },
      },
      app: {
        ...(development ? {
          dev: {
            // The trusted runtime-surface outer document owns the one HMR
            // socket.  The compiler App itself runs in an opaque srcdoc child
            // and must never receive a browser HMR credential or connection.
            hmr: false,
            liveReload: false,
          },
        } : {}),
        html: { inject: 'body' },
        output: {
          cleanDistPath: false,
          distPath: {
            ...(development ? {} : { js: './' }),
            root: root('app', 'dist/app'),
          },
          ...(development ? {} : {
            filename: {
              assets: '[name][ext]',
              css: '[name].css',
              js: '[name].js',
            },
            filenameHash: false,
            legalComments: 'linked',
          }),
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
            name: 'app',
            module: { parser: { javascript: { dynamicImportMode: 'eager' } } },
          },
        },
      },
    },
  };
};

export default defineConfig(createRscRuntimeRsbuildConfig({ mode: 'production' }));
