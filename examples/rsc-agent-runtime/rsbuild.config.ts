import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  defineConfig,
  type RsbuildConfig,
  type RsbuildDevServer,
  type RsbuildPlugin,
  type Rspack,
} from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { Layers, pluginRSC } from 'rsbuild-plugin-rsc';

import { emitRuntimeArtifacts } from './src/build/emit-artifacts.js';

/**
 * MCP App hosts are Chromium (Electron). Floor is Chrome 144 — the oldest
 * currently shipped host researched 2026-09-05:
 * Cursor 3.18.25 About reports Electron 40.10.3 / Chromium 144.0.7559.236
 * (https://forum.cursor.com/t/electron-run-as-node-issue-is-back-in-ide/170182).
 * Cursor 3.19.7 is Chromium 148
 * (https://forum.cursor.com/t/regression-in-3-19-7-on-ubuntu-high-ram-usage-and-renderer-exits-fixed-by-downgrading-to-3-18-25/170546);
 * Claude Desktop 1.34493.1 ships Electron 42.9.2
 * (https://desktopinsights.com/apps/claude), the same Electron 42 line Cursor
 * reports as Chromium 148; ChatGPT/Codex Desktop 26.820.60940 reports
 * Chromium 151.0.7922.170 (https://github.com/openai/codex/issues/41035).
 */
export const rscRuntimeBrowserHost = Object.freeze(['chrome >= 144'] as const);

/**
 * The compiler App is an opaque srcdoc child (`hmr: false`) and the
 * runtime-surface outer document owns the one HMR socket. Fast Refresh
 * would inject a refresh runtime into a self-contained HTML document that
 * must never receive a browser HMR credential. The Flight widget is client
 * JS, not a refreshable SPA.
 */
export const rscRuntimeReactPluginOptions = Object.freeze({ fastRefresh: false } as const);

/**
 * A completed development cohort that Rspack rejected. The observer receives
 * it through `failAttempt(…, 'source-build')` carrying the cohort's stats
 * JSON — errors, children, module traces — and renders them itself (see
 * `src/dev/compile-diagnostics.ts`); this config stays free of the framework
 * API so a plain `rsbuild build` never loads it.
 */
export class RscRuntimeCompileError extends Error {
  readonly stats: Rspack.StatsCompilation;

  constructor(stats: Rspack.StatsCompilation) {
    super('RSC runtime compile reported errors.');
    this.name = 'RscRuntimeCompileError';
    this.stats = stats;
  }
}

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
    /**
     * Allocates the monotonic identity for one completed MultiStats cohort.
     * Called at the start of every global completion callback, in completion
     * order, so identity never depends on pairing with `onBeforeDevCompile`.
     */
    beginCompletedCohort(): string;
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
     * Advisory pre-compile observation. It owns no identity, queue, or
     * activation barrier, and it must never throw or block a compile. The
     * session may use it as a bounded collapse hint (briefly holding an
     * in-flight activation so the observed compile's completed cohort can
     * supersede it), but a missing completion can only delay one activation
     * by that bounded grace - never wedge or fail it.
     */
    observeCompileStart(): void;
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

const appOutputContentHash = (stats: Rspack.Stats): string | undefined => {
  try {
    const assets = [...stats.compilation.getAssets()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const hash = createHash('sha256');
    hash.update(`${assets.length}:`);
    for (const asset of assets) {
      const name = Buffer.from(asset.name);
      const content = asset.source.buffer();
      hash.update(`${name.byteLength}:`);
      hash.update(name);
      hash.update(`${content.byteLength}:`);
      hash.update(content);
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
};

const runtimeAppReloadPlugin = (
  onAppReload: NonNullable<RscRuntimeRsbuildConfigOptions['onAppReload']>,
): RsbuildPlugin => {
  let devServer: RsbuildDevServer | undefined;
  let lastAppOutput: string | undefined;
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
        lastAppOutput = undefined;
      });
      api.onCloseDevServer(() => {
        devServer = undefined;
        lastAppOutput = undefined;
      });
      api.onAfterEnvironmentCompile(({ environment, isFirstCompile, stats }) => {
        if (devServer === undefined || environment.name !== 'app' || stats === undefined || stats.hasErrors()) return;
        // Rspack stats hashes can change across watch completions whose
        // emitted App bytes are identical. The complete asset set is the
        // browser-visible identity; an unreadable set remains unidentifiable
        // and reloads at least once without clobbering the retained identity.
        const output = appOutputContentHash(stats);
        if (output !== undefined) {
          if (lastAppOutput === output) return;
          lastAppOutput = output;
        }
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

/**
 * The App environment ships each entry as exactly one self-contained HTML
 * document (the framework's MCP App compiler invariant): scripts, styles,
 * licence comments, and every asset inline, no sibling files. The resolved
 * configuration is checked before the compiler exists, and the emitted asset
 * set after inlining, so a config drift fails the compile instead of quietly
 * emitting a sibling file the host never serves.
 */
const selfContainedAppPlugin = (): RsbuildPlugin => ({
  name: 'agent-bundle:rsc-runtime-self-contained-app',
  setup(api) {
    api.onBeforeCreateCompiler(({ bundlerConfigs }) => {
      const config = api.getNormalizedConfig({ environment: 'app' });
      const bundler = bundlerConfigs.find((candidate) => candidate.name === 'app');
      if (
        config.output.inlineScripts !== true ||
        config.output.inlineStyles !== true ||
        config.output.dataUriLimit !== Number.MAX_SAFE_INTEGER ||
        config.output.legalComments !== 'inline' ||
        config.output.filenameHash !== false ||
        config.splitChunks !== false ||
        bundler?.output?.asyncChunks !== false
      ) {
        throw new Error('RSC runtime App environment resolved an invalid self-contained configuration.');
      }
    });
    // `report` runs after Rsbuild's `rsbuild:inline-chunk` deletes the inlined
    // script and style assets at `summarize`, so what remains is what lands on
    // disk. A compilation error (rather than a thrown hook) is what
    // `stats.hasErrors()` sees: the production build rejects and the dev
    // session reports the stray files through its `AB8206` diagnostic.
    api.processAssets({ environments: ['app'], stage: 'report' }, ({ assets, compilation, compiler }) => {
      const stray = Object.keys(assets).filter((name) => !name.endsWith('.html')).sort();
      if (stray.length === 0) return;
      compilation.errors.push(new compiler.webpack.WebpackError(
        `RSC runtime App environment emitted files beyond its self-contained HTML documents: ${stray.join(', ')}`,
      ));
    });
  },
});

const runtimeCompileObserverPlugin = (
  observer: NonNullable<RscRuntimeRsbuildConfigOptions['onCompile']>,
): RsbuildPlugin => {
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
        // silence the completed-cohort failure lane.
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
        // Rsbuild documents global hook order, but not a stable cycle
        // identity, callback cardinality under coalesced invalidations, or
        // one-to-one before/after pairing when MultiCompiler children
        // invalidate at different times. Pre-compile observation is therefore
        // advisory only: no identity, queue, or activation barrier may derive
        // from this hook.
        observer.observeCompileStart();
      });
      api.onAfterDevCompile(async ({ stats }) => {
        // Each completed MultiStats cohort is the authoritative monotonic
        // identity: the observer allocates the next ordinal per completion
        // callback, in completion order. There is no queue pairing this
        // callback with onBeforeDevCompile, so coalesced, missing,
        // duplicated, or reordered global callbacks cannot associate Stats
        // with an older observation.
        const attemptId = observer.beginCompletedCohort();
        let snapshot: RscRuntimeCompileSnapshot | undefined;
        try {
          if (stats.hasErrors()) {
            capturedCohort = undefined;
            // The console is not the diagnostic channel (development runs
            // Rsbuild silent, see `logLevel` below): the Rspack errors ride
            // the failure into the session's `AB8206` diagnostic, which
            // renders them as `file:line:col: message` lines.
            observer.failAttempt(
              attemptId,
              new RscRuntimeCompileError(stats.toJson({ all: false, children: true, errors: true, moduleTrace: true })),
              'source-build',
            );
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
    // Provider session vs packaged artifacts: development compiles React and
    // react-server-dom as their development variants (warnings, readable
    // identifiers). `rsbuild build --mode production` and the default export
    // stay production so Flight payloads and App HTML stay the compact
    // surface hosts load. Topology (dev entries, compiler roots) still
    // follows `options.mode`.
    mode: options.mode,
    // Compile errors reach consumers as diagnostics: the dev session's
    // `AB8206` carries every Rspack error, so Rsbuild's own console output —
    // which would print the same errors to the provider's stderr — is
    // silenced there; a production `rsbuild build` rejects, and its console
    // shows the errors (only those) since no diagnostic channel exists.
    logLevel: development ? 'silent' : 'error',
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
      pluginReact(rscRuntimeReactPluginOptions),
      pluginRSC({ environments: { server: 'rsc', client: 'widget' } }),
      emitRuntimeManifest(),
      selfContainedAppPlugin(),
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
          overrideBrowserslist: [...rscRuntimeBrowserHost],
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
        // Self-contained documents, asserted by `selfContainedAppPlugin`: every
        // script, style, licence comment, and asset of any size is inlined,
        // and nothing may split into a sibling chunk or file.
        output: {
          cleanDistPath: false,
          dataUriLimit: Number.MAX_SAFE_INTEGER,
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
          }),
          filenameHash: false,
          inlineScripts: true,
          inlineStyles: true,
          legalComments: 'inline',
          overrideBrowserslist: [...rscRuntimeBrowserHost],
          target: 'web',
        },
        source: {
          entry: {
            'edit-timeline-v1': './src/widget/index.tsx',
            standalone: './src/widget/index.tsx',
          },
        },
        splitChunks: false,
        tools: {
          rspack: {
            name: 'app',
            module: { parser: { javascript: { dynamicImportMode: 'eager' } } },
            output: { asyncChunks: false },
          },
        },
      },
    },
  };
};

export default defineConfig(createRscRuntimeRsbuildConfig({ mode: 'production' }));
