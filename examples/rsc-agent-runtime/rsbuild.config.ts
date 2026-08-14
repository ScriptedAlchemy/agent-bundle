import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { Layers, pluginRSC } from 'rsbuild-plugin-rsc';

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginRSC({
      environments: { server: 'rsc', client: 'widget' },
    }),
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
        },
      },
      output: {
        cleanDistPath: false,
        distPath: { root: 'dist/widget' },
        filename: { js: '[name].js' },
        target: 'web',
      },
    },
  },
});
