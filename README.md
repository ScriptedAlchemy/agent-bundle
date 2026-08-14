# agent-bundle

`agent-bundle` compiles one Agent Bundle project into portable, Codex, and Claude Code artifacts. It discovers skills, validates a typed configuration, bundles local JavaScript/TypeScript entry points, and writes the host-specific metadata needed by each selected target.

It requires Node.js 22.19 or later.

## Install and build

Install the package in the project that owns the plugin:

```sh
npm install --save-dev agent-bundle
agent-bundle build --root . --output artifact
```

The implemented commands are:

- `agent-bundle build` validates source and writes an artifact.
- `agent-bundle inspect` displays the normalized source configuration and target plans.
- `agent-bundle validate` validates source; `agent-bundle validate --artifact <dir>` validates a previously built artifact without reading source configuration.
- `agent-bundle mcp list` and `agent-bundle mcp invoke` operate a local artifact MCP server.
- `agent-bundle hooks list` and `agent-bundle hooks simulate` inspect and simulate generated hooks.

`inspect` is intentionally a source/config-plan command; run it before source removal. Artifact-only inspection is the validation contract (`validate --artifact`).

There are no development-server, visual workbench, or evaluation commands in the published CLI. The design documents describe possible future work, not shipped behavior. A later evaluation harness is designed to reuse an already signed-in host subscription/session and never accept or store API keys; it is not part of this release.

## Configuration

Create `agent-bundle.config.ts` at the project root. `defineConfig` is available from `agent-bundle/config` for type checking:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: {
    name: 'review-tools',
    version: '1.0.0',
    description: 'Review helpers for an agent host.',
  },
  targets: ['portable', 'codex', 'claude'],
  skills: ['skills/*'],
  scripts: {
    report: './src/report.ts',
    bootstrap: { entry: './scripts/bootstrap.sh', targets: ['codex', 'claude'] },
    migrate: './scripts/migrate.py',
  },
  hooks: {
    sessionStart: { handler: './src/session-start.ts' },
  },
  mcp: {
    servers: {
      local: {
        entry: './src/mcp.ts',
        apps: {
          dashboard: {
            entry: './views/dashboard.ts',
            resourceUri: 'ui://review-tools/dashboard-v1.html',
            targets: ['portable'],
            _meta: { ui: { prefersBorder: true } },
          },
        },
      },
      remote: {
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
      },
    },
  },
});
```

`scripts` is a record: its key is the stable output name and each value is either an entry path or `{ entry, targets? }`. JavaScript-family entries (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`) are bundled. Shell and Python entries (`.sh`, `.bash`, `.py`) are copied byte-for-byte and keep the source permission mode. Every target receives selected scripts at `scripts/<name>.mjs` for bundled entries or `scripts/<name><source-extension>` for copied entries.

Skills follow the Agent Skills directory layout and may contain references and binary assets. Local MCP server entries and hook handlers are bundled. A local MCP App may import its generated browser resource list with `import apps from 'agent-bundle/mcp-apps'`; the generated resource uses the configured `resourceUri` and metadata.

The compiler rejects unsafe output names, unsupported extensions, nonexistent or escaping source paths, unknown targets, and output collisions before it stages an artifact. It does not call Codex, Claude, or another host CLI, and it does not require API keys.

## Artifact contract

Artifacts use stable, unhashed script output names. A representative tree is:

```text
artifact/
  agent-bundle.manifest.json
  agent-bundle.hooks.json
  portable/
    plugin.json
    scripts/<name>.mjs
    skills/<skill>/...
    mcp.json
    mcp-apps/<app>.html
  codex/
    .codex-plugin/plugin.json
    .mcp.json
    scripts/<name>.mjs
    hooks/<name>.mjs
  claude/
    .claude-plugin/plugin.json
    .mcp.json
    scripts/<name>.mjs
    hooks/<name>.mjs
```

`agent-bundle.manifest.json` records each emitted file's path, byte length, and SHA-256 digest. This allows `validate --artifact` and artifact operations to run after the source project is no longer present.

Portable artifacts contain portable plugin, skills, MCP, and App-resource files. Codex and Claude artifacts contain their respective native metadata and generated hook wrappers. Terminal hosts can use normal MCP tools and resources; visual rendering of an MCP App depends on the host supporting the standard resource metadata.
