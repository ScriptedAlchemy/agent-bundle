import { defineConfig } from 'agent-bundle/config';

import { projectName } from './src/project-identity.js';

// The RSC runtime and App payloads are compiled by this example's own
// multi-environment Rsbuild build (see rsbuild.config.ts); agent-bundle
// packages those prebuilt trees verbatim and generates the host manifests,
// so this file is the single declaration for both development and packaging.
export default defineConfig({
  // Kept deliberately: the empty per-target sections are not redundant with
  // `targets:` — normalization materializes each one as a `model.extensions`
  // entry with config provenance, and dropping them changes the inspect model.
  claude: {},
  codex: {},
  dev: { runtime: { provider: './src/dev/provider.ts' } },
  marketplace: true,
  mcp: {
    servers: {
      timeline: {
        apps: {
          timeline: {
            _meta: {
              'openai/widgetDescription': 'Interactive timeline of recorded file edits.',
            },
            entry: './src/widget/index.tsx',
            resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
            targets: ['portable', 'claude', 'codex'],
          },
        },
        entry: { prebuilt: './dist/runtime/mcp/stdio.js' },
        targets: ['portable', 'claude', 'codex'],
        transport: 'stdio',
      },
    },
  },
  payload: {
    app: './dist/app',
    runtime: './dist/runtime',
  },
  portable: {},
  plugin: {
    description: 'React Server Components agent runtime demonstration.',
    name: projectName,
  },
  targets: ['portable', 'claude', 'codex'],
});
