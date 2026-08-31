import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defineConfig, type RsbuildConfig, type RsbuildDevServer, type RsbuildPlugin } from '@rsbuild/core';
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

export type RscRuntimeActivationOutcome = 'activated' | 'failed';
export type RscRuntimeCompileFailureKind = 'provider-lifecycle' | 'source-build';
export type RscRuntimeCompileEnvironmentName = 'app' | 'rsc' | 'widget';
export type RscRuntimeCompileEnvironmentHashes = Readonly<Record<RscRuntimeCompileEnvironmentName, string>>;

const compileEnvironmentNames: readonly RscRuntimeCompileEnvironmentName[] = Object.freeze(['app', 'rsc', 'widget'] as const);

const isCompileEnvironmentName = (value: string): value is RscRuntimeCompileEnvironmentName =>
  (compileEnvironmentNames as readonly string[]).includes(value);

export interface RscRuntimeRsbuildConfigOptions {
  readonly compilerRoot?: string;
  readonly mode: 'development' | 'production';
  /**
   * Provider-owned reload signal: invoked once for each later successful,
   * changed App environment compilation. This callback replaces
   * `hot.send('full-reload')`, so no consumer has to parse Rsbuild's private
   * WebSocket envelope to learn that the App surface changed.
   */
  readonly onAppReload?: () => void;
  readonly onCompile?: Readonly<{
    beforeAttempt(): string;
    capture(input: {
      readonly attemptId: string;
      readonly cohortChanged: boolean;
      readonly environmentHashes: RscRuntimeCompileEnvironmentHashes;
      readonly hasErrors: boolean;
      readonly sourceRevision: string;
    }): Promise<RscRuntimeCompileSnapshot | undefined>;
    /** Queues provider activation but never blocks the Rsbuild compile hook. */
    enqueue(snapshot: RscRuntimeCompileSnapshot): unknown;
    failAttempt(attemptId: string, error: unknown, kind: RscRuntimeCompileFailureKind): void;
    /**
     * Stages an immutable checkpoint of one environment's completed output
     * root. Awaited inside the environment compiler's `done` hook, where
     * Rsbuild blocks that compiler's next write cycle until staging
     * finishes, so the copy reads a quiescent output root.
     */
    stageEnvironmentCheckpoint(input: {
      readonly distPath: string;
      readonly environmentName: RscRuntimeCompileEnvironmentName;
      readonly statsHash: string;
    }): Promise<void>;
  }>;
}

const runtimeAppReloadPlugin = (
  onAppReload: NonNullable<RscRuntimeRsbuildConfigOptions['onAppReload']>,
): RsbuildPlugin => {
  let devServer: RsbuildDevServer | undefined;
  let lastAppCompilation: object | string | undefined;
  return {
    name: 'agent-bundle:rsc-runtime-app-reload',
    setup(api) {
      api.onAfterCreateCompiler(({ environments }) => {
        if (environments.app === undefined) {
          throw new Error('RSC runtime compiler did not expose the App environment.');
        }
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
        onAppReload();
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
      api.onAfterEnvironmentCompile(async ({ environment, stats }) => {
        // Immutable per-environment staging (#74): Rsbuild awaits this hook
        // inside the environment compiler's Rspack `done` tap, so the copy
        // reads that environment's completed writeToDisk root before its
        // next compile can rewrite it. Failed compilations, unexpected
        // environment names, and missing hashes stage nothing here; the
        // global after-compile hook is the loud failure path for those, and
        // rejecting this hook instead would skip that dispatch entirely and
        // strand the FIFO attempt pairing.
        if (stats === undefined || stats.hasErrors()) return;
        const name = environment.name;
        if (!isCompileEnvironmentName(name)) return;
        if (typeof stats.hash !== 'string' || stats.hash.length === 0) return;
        await observer.stageEnvironmentCheckpoint({
          distPath: environment.distPath,
          environmentName: name,
          statsHash: stats.hash,
        });
      });
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
          const cohortHashes = new Map<RscRuntimeCompileEnvironmentName, string>();
          // Rspack documents optional Stats child names, but Rsbuild does not
          // promise they equal environment keys. We explicitly name each
          // compiler below; the name-based cohort match is otherwise only an
          // empirical Rsbuild 2.2.1 behavior.
          for (const child of json.children ?? []) {
            if (child.name === undefined || !isCompileEnvironmentName(child.name)) continue;
            if (typeof child.hash !== 'string' || child.hash.length === 0) {
              throw new Error(`RSC runtime ${child.name} compilation has no hash.`);
            }
            if (cohortHashes.has(child.name)) {
              throw new Error(`RSC runtime compile contains duplicate ${child.name} stats.`);
            }
            cohortHashes.set(child.name, child.hash);
          }
          if (cohortHashes.size !== compileEnvironmentNames.length) {
            throw new Error('RSC runtime compile requires exactly one RSC, widget, and App stats child.');
          }
          const environmentHashes = Object.freeze(Object.fromEntries(
            compileEnvironmentNames.map((name) => [name, cohortHashes.get(name) as string]),
          )) as RscRuntimeCompileEnvironmentHashes;
          // The App environment ships through its own dev-server surface, so
          // only the rsc and widget children define the source revision that
          // decides whether a new runtime generation is needed. The App child
          // hash still selects which staged App checkpoint joins the cohort.
          const hashes = (['rsc', 'widget'] as const).map((name) => [name, cohortHashes.get(name) as string]);
          const sourceRevision = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
          snapshot = await observer.capture({
            attemptId,
            cohortChanged: sourceRevision !== capturedCohort?.sourceRevision,
            environmentHashes,
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
            void completion.then((outcome) => {
              if (outcome === 'activated' || outcome === undefined) return;
              if (capturedCohort?.activationSequence === activationSequence) capturedCohort = undefined;
            }, () => {
              if (capturedCohort?.activationSequence === activationSequence) capturedCohort = undefined;
            });
          }
        } catch (error) {
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
    // Pinned, not derived from ambient NODE_ENV: react and react-server-dom
    // must compile as their production variants so Flight payloads stay
    // compact model rows without development debug and timing frames, and so
    // the in-worker dev server serves the production surface layout its
    // session URLs are built for. `options.mode` still selects the compile
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
      ...(options.onAppReload === undefined ? [] : [runtimeAppReloadPlugin(options.onAppReload)]),
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
