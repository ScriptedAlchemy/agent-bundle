# Framework mode

Agent Bundle has one newcomer model:

1. **Authored source lives under `src/`.** For MCP, put one
   module at `src/mcp/<server>/{tools,resources,prompts}/<name>.tsx`; its path
   is its identity. Skills, commands, rules, scripts, routes, and state use
   their conventional `src/` roots, including `src/skills/<name>/SKILL.md`,
   `src/commands/*.md`, and `src/rules/*.mdc`. Top-level `assets/` holds
   static resources, and `agent-bundle.config.ts` stays at the project root.
2. **One small flat config.** `agent-bundle.config.ts` holds project identity,
   targets, and policy that no route file can own.
3. **JSX = rendering.** An executable route is one async default Server
   Component. It does the work and returns `Agent.*`; there is no public
   `execute`/`render` split.
4. **Opt in to context.** Call `await agent()` inside that component only when
   host, session, actor, workspace, capability, or state context is needed.

The complete conventional config is usually:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: { description: 'Evidence-backed project tools.', name: 'my-plugin', version: '0.1.0' },
  targets: ['portable', 'codex', 'claude'],
});
```

A tool is one file:

```tsx
// src/mcp/runtime/tools/status.tsx
import React from 'react';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Read runtime status.',
} satisfies ToolConfig;
export const inputSchema = z.object({ verbose: z.boolean().optional() }).strict();
export const resultSchema = z.object({ status: z.literal('ready') }).strict();

export default async function Status({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  if (input.verbose) await agent();
  const result = { status: 'ready' as const };
  return <Agent.Result value={result}><Agent.Text>Runtime is ready.</Agent.Text></Agent.Result>;
}
```

The compiler statically reads `config`, imports schemas and implementations
only into generated entries, installs `runAgentRequest`, and derives the real
MCP server from the route graph. Each call renders through a warm internal
Flight dispatcher and lowers the final Agent Document to legal MCP output.
Flight is an implementation transport inside the generated runtime, never a
public host wire protocol.

Everything else is power-tier reference: custom/remote server modes and
collision recovery are in [Entry conventions](entry-conventions.md); accepted
static metadata, generated `.agent-bundle/routes.d.ts`, and diagnostics are in
[Diagnostics](diagnostics.md). Handwritten `src/mcp/<server>.ts`,
`defineOperation`, and `createRscMcpServer` remain supported escape hatches;
the handwritten `runRscCli` compatibility path still serializes validated
results and never renders JSX. Routed `src/cli/**` commands and
`src/scripts/**` scripts follow one sentence: `.tsx` renders through the
Agent renderer (TTY progress, piped Markdown, `--json`, `--ndjson`); `.ts`
is plain.

## Config reference

### `output`

`output` controls where the host artifact root lives; it never changes the
framework-owned layout inside each target:

```ts
export default defineConfig({
  plugin: { ... },
  output: {
    distPath: 'artifact',
  },
});
```

`output.distPath` defaults to `dist`. A CLI `--output <path>` overrides the
configured path, so precedence is CLI `--output`, then `output.distPath`, then
`dist`; existing projects are unchanged. The configured directory is excluded
from project source snapshots (as `dist` always was), ignored by the dev
watcher, and used by Workbench host discovery and doctor drift checks.

Config values must be non-empty, project-root-contained relative POSIX paths.
A malformed `output` block or non-string/empty `distPath` reports `AB4707`;
absolute paths, backslashes, `.`, empty segments, and `..` traversal report
`AB4708`; reserved first segments (`.agent-bundle`,
`.git`, `node_modules`, and `src`) report `AB4709`. Projects with package
`bin` or `lib` entries must keep host artifacts separate from the npm package
build at `dist/` (`AB4706`); `output: { distPath: 'artifact' }` provides that
separation without a CLI flag.

The name follows Rsbuild/Rslib's `output.distPath`, but Agent Bundle accepts
only the string shorthand, not Rsbuild 2.x's per-asset `DistPathConfig` for
such paths as JavaScript, CSS, and SVG subdirectories.
`output.filename` templates, `output.assetPrefix`, and `output.cleanDistPath`
are also deliberately deferred: host packs have a framework-owned
`<target>/skills|mcp|scripts|assets/...` layout content-addressed by the
artifact manifest. Unlike machine-local Rsbuild config, the hashed, portable
release-identity config rejects absolute paths. The per-invocation CLI
`--output` flag can override the configured relative artifact root, but it is
subject to the same project-root containment check; absolute and external
output roots are unsupported.

## Distribution

`agent-bundle build` makes each target directory independently distributable.
Every target includes `INSTALL.md` generated with its real plugin and
marketplace names. Claude and Codex bundles include local marketplace manifests
and install through their public plugin CLIs; Cursor bundles use the documented
`~/.cursor/plugins/local/<name>` location because Cursor exposes marketplace
management but no non-interactive plugin install verb.

The `portable` target emits the [Agent Plugins open standard](https://agent-plugins.org)
(specification 1.0.0), with schema hashes and the specification repository
revision pinned in `src/adapters/schemas/portable/PROVENANCE.json`. Cursor loads
this format natively alongside Cursor Plugins; Codex, VS Code, GitHub Copilot,
Kiro, and ChatGPT are native clients too. Claude Code consumes the standard
only through CLI translation, so its dedicated target remains necessary. The
standard packages only skills and MCP servers, leaving rules, commands, and
hooks honestly unavailable on the portable target. A dogfood proof against the
real Cursor IDE plugin loader (discovery, skill listing, MCP launch, and three
observed Cursor 3.18.25 placeholder-expansion conformance gaps) is recorded in
`docs/audits/2026-09-02-agent-plugins-cursor-ide-proof.md`.

The framework CLI performs those same operations:

```sh
agent-bundle install claude --from artifact/claude --scope user
agent-bundle install codex --from artifact/codex
agent-bundle install cursor --from artifact/cursor
```

Cursor-compatible `cursor`, `portable`, and multi-host `plugin` targets also
include a standalone `install.mjs`. Its staged copy is idempotent for identical
content and refuses version or content collisions. It never invokes sudo or
changes PATH. Artifact validation rejects a built-in target whose required
install surface is missing.
