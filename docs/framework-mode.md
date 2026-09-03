# Framework mode

Agent Bundle has one newcomer model:

1. **Authored source lives under `src/`.** For MCP, put one
   module at `src/mcp/<server>/{tools,resources,prompts}/<name>.tsx`; its path
   is its identity. Skills, commands, rules, scripts, routes, and state use
   their conventional `src/` roots, including `src/skills/<name>/SKILL.md`,
   `src/commands/*.md`, and `src/rules/*.mdc`. Top-level `assets/` holds
   static resources, and `agent-bundle.config.ts` stays at the project root.
2. **One small flat config.** `agent-bundle.config.ts` holds project identity,
   targets, and policy that no route file can own. The release version is
   not repeated there: `package.json` is the single version source
   (`plugin.version` is deprecated; see [Diagnostics](diagnostics.md#release-identity-ab4001-ab4008ab4011-ab4013)).
3. **JSX = rendering.** An executable route is one async default Server
   Component. It does the work and returns `Agent.*`; there is no public
   `execute`/`render` split.
4. **Opt in to context.** Call `await agent()` inside that component only when
   host, session, actor, workspace, capability, or state context is needed.

The complete conventional config is usually:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: { description: 'Evidence-backed project tools.', name: 'my-plugin' },
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

## Request context and providers

Every generated request scope — MCP tools, resources, and prompts, event
routes, plain and rendered routed CLI commands, rendered scripts, and Workbench
replay — installs the same typed `AgentRequestContext`. `await agent()`
returns the invocation plus `Observed` `host`, `session`, `actor`, and
`workspace` axes (an `available` value with its provenance, or a typed
`unavailable` reason — never a fabricated string), request capabilities,
progress, the request signal, and the `state`, `notices`, and `providers`
slots. The handle is request-scoped: it survives `await`, two concurrent
requests never observe each other, and reading a captured handle after the
request closes throws a typed `AgentRequestError`.

A **context provider** contributes one request-scoped value without touching
the compiler. Each `src/providers/<name>.{ts,tsx}` module default-exports a
factory receiving the public `AgentProviderContext` (`{ invocation, signal }`
from `agent-bundle`) and its value mounts at
`(await agent()).providers.<camelCaseName>`:

```ts
// src/providers/library.ts
import type { AgentProviderContext } from 'agent-bundle';

export interface LibraryContext { readonly stages: readonly string[]; readonly surface: string }

export default async function library({ invocation }: AgentProviderContext): Promise<LibraryContext> {
  return { stages: ['discover', 'curate'], surface: invocation.kind };
}
```

Providers run once per request in deterministic key order before the request
scope opens; a thrown factory fails that request closed, so return an honest
unavailable-shaped value for expected degradation. The compiler validates the
default export (`AB4940`), unique keys (`AB4941`), and the reserved
framework-owned `processLifetime` key (`AB4942`).

The generated `.agent-bundle/routes.d.ts` declares `AgentBundleProviders`
(`ProviderKey`, `ProviderValue<Key>`) from each factory's resolved return type
and augments `@agent-bundle/runtime`'s `AgentProviderValues`, so
`(await agent()).providers.library` is a `LibraryContext` with no cast once
the file is part of the project's TypeScript program (add
`".agent-bundle/routes.d.ts"` to `tsconfig.json` `include`). Undeclared keys
stay `unknown`. Route-unit and CLI-dispatch tests inject fixture values through
`renderRoute(id, { context: { providers: { library } } })`; the harness never
executes provider modules on a test's behalf.

### What reaches the MCP wire

The final Agent Document of a tool route lowers to one `CallToolResult`:

| Route surface | Wire effect |
| --- | --- |
| `Agent.Text`, `Agent.Markdown`, `Agent.Context`, `Agent.Json` children | Ordered `content` text blocks (`Agent.Json` as its JSON text). |
| `Agent.Image`, `Agent.Audio`, `Agent.Resource` | Native `image`, `audio`, and `resource_link` blocks; a host without that capability fails the projection closed unless a text fallback is selected. |
| `Agent.Result value` | `structuredContent` when the value is a JSON object; a non-object value emits none and is never wrapped. |
| `Agent.Result metadata` | `CallToolResult._meta`. It must be a JSON object (snapshotted through the same wire boundary as `structuredContent`); anything else fails the projection closed with `McpProjectionError('invalid-result-metadata')`. Listing-level `_meta` still comes from static `config._meta`, so the MCP Apps convention stamps `_meta.ui.resourceUri` on both halves. |
| `Agent.Error code message` | `isError: true` plus one text block `[<code>] <message>`. The wire has no error-code field, so the code is deliberately kept in the text (the routed CLI prints the same `**[code]** message` form); choose codes that read well to the model. |
| `resultSchema` | `outputSchema` in `tools/list` **only when the schema describes an object** (`z.object`, `z.record`, a discriminated union of objects). The MCP specification requires every result of a tool that declares `outputSchema` to carry `structuredContent`, so a text-only route declares `resultSchema = z.undefined()` (or any non-object schema), advertises no `outputSchema`, and returns no `structuredContent`. An object schema keeps the SDK's fail-closed output validation on every call. |

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

## Skills: convention, override, and rendered documents

`src/skills/<name>/SKILL.md` ships with no declaration. Config wins,
conventions fill: declaring `skills:` replaces the directory convention
entirely, and validation reports `AB4734` for any conventional skill directory
the explicit list leaves uncovered. Skills at the removed top-level
`skills/<name>/` location are an `AB4736` error unless explicit `skills`
config claims them.

A skill whose document is generated (power tier, never required) puts
`SKILL.tsx` (or `SKILL.ts`) in the skill directory instead of `SKILL.md`. The
module default-exports a component (sync or async) and exports a `frontmatter`
record; the build renders the tree to Markdown and emits the same
`skills/<name>/SKILL.md` artifact every host consumes.

```tsx
// src/skills/deploy-checklist/SKILL.tsx
export const frontmatter = {
  description: 'Deployment checklist.',
  name: 'deploy-checklist',
};

export default () => (
  <>
    <h1>Deploy checklist</h1>
    <p>Verify each step <strong>in order</strong>.</p>
  </>
);
```

The renderer supports a documented element subset (`h1`–`h6`, `p`,
`ul`/`ol`/`li`, `strong`/`b`, `em`/`i`, `code`, `pre`, `blockquote`, `a`,
`hr`, `br`, fragments, strings and numbers) and rejects anything outside it by
name (`AB3005`), never a silent approximation; a module that fails to load or
lacks the two exports reports `AB3003`/`AB3004`. Components may import
project code, so the document can be computed from the same sources the
plugin ships. A hand-authored `SKILL.md` in the same directory always wins
(`AB4735`).

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

## Live development into hosts

`agent-bundle dev` is the webpack-HMR analog for plugins that are installed
and in use in a real host. Three pieces make a rebuild reach the host without
the host ever seeing a disconnect:

1. **A stable host-facing proxy.** `agent-bundle dev proxy --root <project>
   --server <name> [--target <host>]` is the thin stdio process a host spawns
   and holds. It forwards the developed plugin's MCP surface from the dev
   server's `/mcp/host/<serverName>` endpoint. On every adopted epoch the dev
   server opens and primes a session on the new generated server, promotes it
   behind the same connection, emits `notifications/tools/list_changed` (and
   the resources/prompts equivalents the catalog advertises), lets in-flight
   calls finish against the epoch they started on, then drains the old
   session. A failed build changes nothing; a vanished epoch or stopped dev
   server fails closed (`AB8024` / `AB8025`).
2. **Installed-host re-sync.** `agent-bundle dev --install-host <claude|codex|cursor>`
   installs a marked development variant through the ordinary installer once,
   pointing the host's MCP document at the proxy, then re-syncs hooks, Skills,
   and MCP Apps into the host's own layout on every adopted epoch with atomic
   generation swaps and rollback (`AB7202`). Hooks are spawned per event, so
   they pick up the new epoch on their next invocation.
3. **A contract gate on adoption.** Declaring `dev.contracts` in
   `agent-bundle.config.ts` runs the generated contract matrix against each
   published epoch through an epoch-pinned generated stdio session before any
   host-facing surface adopts it. A failing epoch stays inactive for hosts,
   is reported on the `dev.contract.status` project event (`AB7210` for an
   invalid declaration, `AB7211` for violations), and appears in the
   Workbench Overview's **Host adoption** section beside the published
   build. Playground sessions stay independently epoch-pinned.

The package README's [Developer workbench](../packages/agent-bundle/README.md#developer-workbench)
section carries the exact commands, install layouts, and event payloads;
[Diagnostics](diagnostics.md) lists every code on this path.

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
hooks honestly unavailable on the portable target. The standard's manifest
metadata (`author`, `homepage`, `repository`, `license`, `keywords`) and
reverse-domain `extensions` are authored under the `portable` config key and
land in the root `plugin.json`; omitting them leaves the manifest exactly as
before. Emitted bytes are validated against the pinned schemas and the
normative text at plan time, after every build, under
`validate --artifact --host-validation`, and by `doctor` for installed Cursor
local plugins that declare the standard's `$schema`
(`AB6035`–`AB6038`, `AB7320`; see `docs/diagnostics.md`). A dogfood proof
against the real Cursor IDE plugin loader (discovery, skill listing, MCP
launch, and three observed Cursor 3.18.25 placeholder-expansion conformance
gaps) is recorded in `docs/audits/2026-09-02-agent-plugins-cursor-ide-proof.md`.

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
