import { defineConfig, type RsbuildPlugin } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { Layers, pluginRSC } from 'rsbuild-plugin-rsc';

import { emitRuntimeArtifacts } from './src/build/emit-artifacts.js';

const emitRuntimeManifest = (): RsbuildPlugin => ({
  apply: 'build',
  name: 'emit-rsc-agent-runtime-manifest',
  setup(api) {
    api.onAfterBuild(async ({ environments }) => {
      await emitRuntimeArtifacts(environments.rsc.distPath);
    });
  },
});

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginRSC({
      environments: { server: 'rsc', client: 'widget' },
    }),
    emitRuntimeManifest(),
  ],
  environments: {
    rsc: {
      source: {
        entry: {
          'hook/index': './src/hook/cli.ts',
          'rsc/index': {
            import: './src/rsc/worker.tsx',
            layer: Layers.rsc,
          },
          'mcp/stdio': './src/mcp/stdio.ts',
          'mcp/http': './src/mcp/http.ts',
        },
      },
      tools: {
        rspack: {
          module: {
            rules: [
              {
                parser: { importMeta: { url: false } },
                test: /[\\/]src[\\/]flight[\\/]request-render\.ts$/,
              },
            ],
          },
        },
      },
      output: {
        cleanDistPath: false,
        distPath: { root: 'dist' },
        filename: { js: '[name].js' },
        target: 'node',
      },
    },
    widget: {
      source: {
        entry: {
          'hook/index': './src/rsc/client-anchor.ts',
          'rsc/index': './src/rsc/client-anchor.ts',
          'mcp/stdio': './src/rsc/client-anchor.ts',
          'mcp/http': './src/rsc/client-anchor.ts',
        },
      },
      output: {
        cleanDistPath: false,
        distPath: { root: 'dist/widget' },
        filename: { js: '[name].js' },
        target: 'web',
      },
    },
    app: {
      html: {
        inject: 'body',
      },
      output: {
        cleanDistPath: false,
        distPath: { root: 'dist/app' },
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
          module: {
            parser: {
              javascript: {
                dynamicImportMode: 'eager',
              },
            },
          },
        },
      },
    },
  },
});
