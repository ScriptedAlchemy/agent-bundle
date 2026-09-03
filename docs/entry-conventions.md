# Entry conventions and the framework-owned package build

agent-bundle is the build product for agent plugins the way Rslib is for
libraries: one `agent-bundle.config.ts`, one CLI, framework-owned entry
lifecycles, and a single blessed escape hatch into the bundler. This document
is the contract for the package build (`bin` / `lib`), the entry-file
conventions, the generated entry shells, and the `tools` escape hatch.
[Framework mode](framework-mode.md) is the one-screen authoring model these
conventions serve: structure in config and conventions, JSX only for
rendering.

## The package build

`agent-bundle build` always emits host artifacts. When the project declares
`bin`/`lib` (or provides them by convention), the CLI build also produces the
node-consumable package build under `dist/` — the outputs `package.json`
`bin` and `exports` point at:

| Config | Output | Notes |
| --- | --- | --- |
| `bin: { '<name>': './src/cli.ts' }` | `dist/bin/<name>.js` | Self-executing ESM bundle, `#!/usr/bin/env node` shebang, executable bit. |
| `lib: { entry: './src/index.ts', dts: true }` | `dist/<stem>.js` + `dist/**/*.d.ts` | Single-entry ESM profile, node target, es2022 syntax. |

- When package outputs and at least one Claude, Codex, or Cursor host pack are
  built inside the project, the framework also emits one self-contained
  package-relative installer. It is `dist/bin/<plugin-name>.js` when that name
  is free, otherwise `dist/bin/<plugin-name>-install.js`; if both are occupied,
  a numeric suffix (`-install-2`, `-install-3`, …) guarantees a free name.
  Declare the matching `package.json` `bin` value. Its grammar is
  `install <host> [--scope <scope>] [--json]`; help lists only built hosts.
  The baked URL resolves the shipped artifact directory from `import.meta.url`,
  never the caller's working directory, and delegates to the same
  `installBundle` implementation as `agent-bundle install`.
- `agent-bundle prepack [--root <root>] [--output <artifact>] [--json]` runs
  the release build and `npm pack --dry-run --json --ignore-scripts`, then
  gates the exact package/artifact inventory, manifest hashes, package bin
  targets, and release-version agreement. With no `--output`, prepack uses
  configured `output.distPath` when present and otherwise writes artifacts to
  `artifact/`, leaving the package build in `dist/`. Use it as an npm `prepack`
  script; `--ignore-scripts` prevents recursion and npm install never runs the
  host installer.
- The package build runs for `agent-bundle build` (CLI, or
  `build({ packageOutputs: true })` through the API) and inside the
  `agent-bundle dev` rebuild loop (see “Dev-watch of the package build”
  below). Other programmatic artifact operations — temporary artifacts,
  evals — never write `dist/`.
- Outputs are staged and published atomically, and their provenance
  (bytes, SHA-256, sorted project-relative source inputs) is reported on the
  build result exactly like artifact files.
- `dist` is a mandatory-ignored directory: package outputs never enter
  project source snapshots or skill/asset discovery.
- An artifact `--output` that overlaps `dist` is rejected (`AB4706`).
- The `lib` profile is deliberately thin. A package that needs a multi-format
  library matrix (UMD, multiple entries, per-format tsconfig) has outgrown the
  profile and genuinely wants Rslib — that is the one case where a second
  bundler config remains, by choice.

### Declarations

`lib.dts` defaults to `true`. Declaration generation resolves `typescript`
from the project (add it as a devDependency) and compiles the lib entry's
source directory as its own program: compiler options come from the project
`tsconfig.json` (via `extends`), `rootDir` is pinned to the entry's directory,
and only that subtree is included — test files never fail or pollute the
package build. Declarations land flat under `dist/`, one `.d.ts` per source
module.

## Entry-file conventions

Conventions fill the config when it is silent; config always wins. Discovered
entries carry `provenance.kind: 'conventional'` in the normalized model.

| Convention | Meaning | Opt out |
| --- | --- | --- |
| `src/cli.ts` | Package bin named after `plugin.name` (skipped when the name is not a safe output name). | `bin: false` |
| `src/index.ts` | Library output with declarations. | `lib: false` |
| `src/mcp/<server-id>.ts` | Stdio entry for the declared MCP server `<server-id>` that names no `entry`, `command`, or `url`. | Declare `entry` explicitly |
| `src/mcp/<server>/{tools,resources,prompts}/*.{ts,tsx}` | Generated MCP server routes; path supplies identity and each executable module supplies static `config`, schemas, and one async default Server Component. | Set `routes.servers.<server>` to `custom`, `command`, or `remote` |
| `src/mcp/<server>/apps/*.{ts,tsx}` | Browser MCP App entry compiled to self-contained HTML and registered on the generated server; static `config.resourceUri` is required. | Use a custom server or prefix the file with `_` |
| `src/scripts/<name>.ts` | Plain script compiled to `scripts/<name>.mjs` in every selected target artifact — the same pipeline explicit `scripts` entries use, with ordinary Node stdout/stderr semantics. A `scripts` entry that references the file claims it. Nested modules are hard errors (`AB4808`). | Prefix a path segment with `_`, or claim the file with an explicit `scripts` entry |
| `src/scripts/<name>.tsx` | Rendered script: the async default component receives `{ argv, signal }` and renders through the Agent renderer with the CLI output contract (`--json`, `--ndjson`, TTY progress, piped Markdown). Compiles to `scripts/<name>.mjs` plus a `scripts/<name>-flight.mjs` react-server worker. The extension is the explicit, visible contract — plain `.ts` scripts are never wrapped in React behavior, and explicit `scripts` config entries stay plain regardless of extension. | Rename to `.ts`, prefix a path segment with `_`, or claim the file with an explicit `scripts` entry |
| `src/cli/**/*.{ts,tsx}` | Routed CLI commands compiled into one collision-checked command graph and one generated package executable named after `plugin.name` (superseding the `src/cli.ts` bin convention for the project). Nesting is identity: `src/cli/library/audit.ts` runs as `<bin> library audit`. Plain `.ts` commands execute directly and print one canonical JSON line; `.tsx` commands render through the dispatcher with the four output modes. | `bin: false`, `routes.cli: 'conventional'`, or prefix a path segment with `_` |
| `src/events/<family>/<event>.{ts,tsx}`, `src/events/stop.{ts,tsx}` | Semantic event route: the path is the canonical event family (`src/events/tool/after.tsx` is `tool/after`; `stop` is the one top-level family) and must be one of the admitted `canonicalAgentEvents`. The optional static `config` (`AgentEventRouteConfig`: `targets`, `tools`, `runtime: 'shared' \| 'standalone'`, `fallback`, `delivery`, `timeoutMs`) restricts hosts and selects the execution mode; the async default Server Component receives `AgentEventRouteProps` (`{ canonical, native, signal }`) and returns `Agent.*` output that the selected host adapter encodes into its native hook envelope. Application code never branches on host JSON or emits native hook documents; per-host support is a capability state (`supported`/`degraded`/`unavailable`/`prohibited`) surfaced by `inspect` and enforced at build time (`AB4817`, `AB4823`–`AB4825`). | Restrict `config.targets`, or prefix a path segment with `_` |
| `src/state.ts` | Project state definition: default-exports `defineState({ ... })`; generated MCP, routed-CLI, and rendered-script request scopes mount `(await agent()).state` and `.notices`. | `state: false`, or rename the file to `_state.ts` |
| `src/providers/<name>.{ts,tsx}` | Request context provider: default-exports a factory receiving `{ invocation, signal }`; its value is mounted at `(await agent()).providers.<camelCaseName>` for generated MCP and event routes, projected MCP commands, plain and rendered routed CLI commands, and rendered scripts. | Prefix the file with `_` |

Route and package entry conventions match `.ts` and `.tsx` files exactly;
the state convention is specifically `src/state.ts`.

### Config beside a route-generated MCP server

A `mcp.servers.<server>` block whose `<server>` the route graph compiles in
`generated` mode does not redeclare the server — its entry is the route
modules — it **augments** it. This is the precedence table for one generated
server (config wins, conventions fill):

| Field | Source of truth | Config declaration |
| --- | --- | --- |
| Entry, transport (`stdio`), `cwd` (plugin root) | `src/mcp/<server>/{tools,resources,prompts}/*` and the generated stdio shell | `entry`, `command`, or `url` is `AB4340` under `routes.servers.<server>: 'generated'` and `AB4800` without an explicit mode; `transport: 'stdio'` is accepted, any other transport is `AB4308`; `cwd` is `AB4309`; `headers` is `AB4310`. |
| `env` | — | Applied verbatim beneath the injected plugin-root anchor (`AB4312` shape rules). |
| `args` | The content-hashed entry path | Appended after the entry path (`AB4311` shape rules). |
| `targets` | The project's selected targets | Replaces the default selection (`AB4305` shape rules). |
| `apps` | `src/mcp/<server>/apps/*` routes | Config-side Apps are compiled and registered on the generated server beside the route-declared ones (`AB432x` rules; `AB4334` checks App targets against the declared server targets). The route-declared Apps take part in the collision checks: reusing a route App's name is `AB4325`, reusing its `resourceUri` under another name is `AB4330`. |

Provenance stays `conventional` (the first route module) because the routes
supply the entry; `inspect` shows the merged `env`, `args`, and `targets`.
Setting `routes.servers.<server>` to `custom`, `command`, or `remote` turns the
same block back into an ordinary server declaration and omits the routes.

### Generated state mounting

The compiler parses `src/state.ts` without executing it and requires one
`export default defineState({ ... })` call whose `id` and `lifetime` are
string literals. Generated mounting currently supports `request`, `process`,
and `workspace-durable`; `external` remains embedder-owned driver wiring.
Volatile lifetimes use the memory driver. Request lifetime opens and releases
fresh project and notice stores per invocation; process lifetime shares them
for the generated worker or executable process.

Workspace-durable generated MCP workers store under
`$AGENT_BUNDLE_PLUGIN_ROOT/state`. If that host-provided anchor is absent,
the worker derives the artifact root from the parent of its own `mcp/`
directory. Routed CLI bins and rendered scripts use
`$AGENT_BUNDLE_PLUGIN_ROOT/state` when present and otherwise
`$PWD/.agent-bundle/state`. Notice authorization is deliberately permissive
in generated mounting v1 (`authorized`); recipient/principal matching remains
enforced by the ledger, while application authorization policy is deferred.

#### State mutation budgets

`defineState({ ... })` accepts an optional `budgets` runtime policy. Omitted
fields resolve to these fail-closed defaults:

- `maxEventBytes: 262_144` — UTF-8 bytes in the canonical JSON of each
  schema-validated event payload.
- `maxStateBytes: 1_048_576` — UTF-8 bytes in the canonical JSON of the
  initial state and each event, reset, or migration result.
- `maxRevisions: 100_000` — total journal revisions admitted for
  caller-initiated events and resets.
- `maxCommitMs: 5_000` — wall-clock milliseconds from mutation validation
  start until the commit is ready to append.

Each override must be an integer of at least 1. A definition whose initial
state exceeds its state cap is rejected as `invalid-definition`; a mutation
that exceeds any cap fails typed `budget-exceeded` and commits nothing.
Raise the corresponding field in `budgets` to admit a larger or slower
mutation or retain more revisions.

Budgets are runtime policy, not persisted state metadata. The same storage
may be reopened with different caps. Lowering a cap never breaks reads,
change cursors, or exact-revision replay of already-committed history.
Kernel-generated migration commits still enforce `maxStateBytes`, but are
exempt from `maxRevisions` and `maxCommitMs` so a full journal cannot brick
an otherwise valid migration.

### Request context providers (power tier)

Each direct child of `src/providers/` derives its key by camel-casing the file
stem: for example, `src/providers/project-auth.ts` mounts at
`(await agent()).providers.projectAuth`. Every module default-exports a factory
with the contract `(context: { invocation, signal }) => value |
Promise<value>`, where `invocation` is the current route invocation and
`signal` is its request abort signal.

Every generated request scope — the shared Flight worker behind generated MCP
and event routes, the react-server worker behind rendered routed CLI commands
and rendered scripts, and the routed-CLI executable itself for plain `.ts`
commands — executes providers once per request, sequentially in deterministic
key order, before entering `runAgentRequest`. The returned values join the
request's provider map. A thrown or rejected factory fails the request closed;
expected degradation should return an honest unavailable-shaped value instead
of throwing. `invocation.kind` stays surface-specific (`tool`, `event`, `cli`,
`script`), so a provider can branch on the entry surface deliberately.
`processLifetime` is reserved for the framework-owned process identity and hit
counter, so provider filenames must not derive that key.

Route-unit and CLI-dispatch tests inject provider values through the same
`context` seam as identity axes (`renderRoute(id, { context: { providers:
{ library: fixture } } })`); the harness never executes conventional provider
modules, so a test chooses exactly the values a component observes. Once the
generated `.agent-bundle/routes.d.ts` augmentation declares provider keys, the
harness `options` and its `context.providers` become required (as does
`providers` on a direct `runAgentRequest`), so omitting a fixture the route's
types promise is a compile error rather than a runtime `undefined`.

### Handler request context

Conventional route components receive only their surface props, such as
`{ input, signal }`. They read transport-owned request context with
`await agent()` from `@agent-bundle/runtime` — or, in a synchronous component
or utility, `useAgent()`, which returns the identical handle under the same
lease rules without suspending. The handle exposes the
invocation plus `host`, `session`, `actor`, and `workspace` identity axes.
Each identity axis is `Observed`: transports publish an `available` value and
source when they know it, or `unavailable` with a typed reason when they do
not. Generated MCP request scopes observe the negotiated client identity as a
native host, derive workspace from the server process working directory, and
use native transport session and HTTP authentication data when supplied. Bare
stdio supplies neither a session id nor HTTP actor authentication, so those
axes remain honestly unavailable. Generated event scopes currently mount no
actor principal, so event routes observe actor as unavailable rather than
receiving a fabricated value.

Handlers authored with `defineOperation` receive the same handle as optional
`context.request` in the second `execute` argument:

```ts
const status = defineOperation({
  // ...
  execute: async (input, context) => {
    const request = context.request;
    // request is the identical handle returned by await agent() in this invocation.
    return inspect(input, request);
  },
});
```

The runtime supplies `context.request` inside `runAgentRequest`; direct
operation calls outside a request scope leave it absent. Transport context is
separate from validated business input, so fields named `host`, `session`, or
similar inside `input` cannot override request identity.

Route-unit tests inject identity through the harness context seam:

```ts
import { available } from '@agent-bundle/runtime';
import { renderRoute } from 'agent-bundle/test';

await renderRoute('tool:curator/status', {
  context: {
    host: available({ name: 'test-host' }, 'native'),
    session: available({ sessionId: 'test-session' }, 'native'),
  },
  input: { subject: 'library' },
});
```

The same seam accepts `actor`, `workspace`, and `capabilities`; tests can use
`unavailable(...)` to pin a transport's honest absence semantics.

### Migration nudges

Source validation reports **informational** nudges (never errors — migrations
stay optional) when a project exhibits a pre-convention pattern: `AB4730` for
a self-connecting stdio entry that a default-exported factory would upgrade
to the framework lifecycle shell, and `AB4731`/`AB4732`/`AB4733` when
`src/cli.ts`, `src/index.ts`, or `src/mcp/<server-id>.ts` exists but explicit
configuration shadows it. `bin: false` / `lib: false` opt-outs stay silent.
See `docs/diagnostics.md` for each trigger and how to adopt or silence it.

## Generated entry shells

A route-mode MCP surface emits a public lifecycle entry plus one warm internal
Flight worker. The entry owns `runAgentRequest`, session/actor binding, the
final Agent Document dispatcher, legal MCP projection, resource/prompt
registration, and compiled App resources. The worker exists solely to isolate
React's `react-server` condition and is reused until that MCP process closes;
raw Flight bytes never cross the public MCP wire.

The framework also provides the entry files consumers used to write by hand
(react-router's provided-entry trick). Every generated shell imports the
consumer module by absolute path and is bundled through the same Rslib
synthesis and invariant assertions as all generated executables.

### The executable envelope (bin + Scripts)

A `bin` entry — or an artifact `Script` — whose module exports `main` (or a
default function for bin entries) receives the generated process envelope:

```ts
// src/cli.ts — the whole CLI entry a consumer writes
export const main = async (argv: readonly string[]): Promise<number> => {
  // ...
  return 0;
};
```

The envelope awaits `main(process.argv.slice(2))`, adopts a numeric return as
the process exit code, and lets an escaped rejection surface through Node's
top-level failure path (stack to stderr, exit code 1). Self-executing modules
(no `main` export) bundle directly, byte for byte — existing Scripts keep
their behavior.

### The routed CLI shell (#102 stages 2-3)

A generated-mode `src/cli/**` surface compiles into one framework-generated
executable instead of a hand-written `src/cli.ts` dispatcher. A plain command
route is one module:

```ts
// src/cli/inspect.ts — the whole command a consumer writes
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

export const config = {
  description: 'Inspect a bounded source tree without changing it.',
  positionals: ['root'],
} satisfies CliRouteConfig;
export const inputSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).optional(),
  root: z.string().min(1),
}).strict();
export const resultSchema = z.object({ /* ... */ }).strict();

export default async function inspect({ input, signal }: CliRouteProps<typeof inputSchema>) {
  // ... do the work ...
  return result;
}
```

The compiler statically projects `inputSchema` onto argv (the bounded grammar
and every policy rule are documented in
[Diagnostics](diagnostics.md#route-graph-state-and-provider-conventions-ab4800ab4822-ab4940ab4942)), generates nested
help (`--help` at every level, `--version` at the root), and emits
`dist/bin/<plugin-name>.js` with the shebang and executable bit through the
same Rslib synthesis as every other bin. At run time the shell resolves the
command path, parses and coerces argv, validates through the module's own
zod schemas, executes the default function inside the typed Agent request
context (`invocation.kind: 'cli'`), writes one canonical JSON line to
stdout, and maps exit codes deterministically (0 success or the result's
`exitCode` under `config.exitCode: 'result'`; 1 execution failure; 2 usage
or input failure; 130/143 on SIGINT/SIGTERM, which reach the route's
`AbortSignal`). `--json` is accepted on every command; plain commands
already emit the canonical JSON document. Routed CLI projects need
`@agent-bundle/runtime` as a dependency — the generated executable installs
the request context through it.

A `.tsx` command route swaps the default function for an async default
Server Component with the same `{ input, signal }` props and renders through
the runtime dispatcher's public `stream()` against a sibling
`dist/bin/<plugin-name>-flight.mjs` react-server worker (one warm worker per
invocation; raw Flight bytes never reach the terminal). The four output
modes: an interactive TTY updates progress in place and prints the final
document as Markdown; piped output emits exactly one final Markdown document
with no partial fallbacks; `--json` emits the canonical validated final
value; `--ndjson` emits the sequence-numbered render-event stream — an
Agent Bundle CLI/script output dialect, not MCP JSON-RPC, and never written
as non-MCP bytes to an MCP server's stdout. Diagnostics stay on stderr;
machine output owns stdout. Rendered scripts
(`src/scripts/<name>.tsx`) share the same shell and output contract with
`{ argv, signal }` component props and status-derived exit codes.

#### Project generated MCP tools into the CLI (power tier)

`routes.mcpCommands` adds tools from generated MCP servers to the same command
graph and executable, including projects with no `src/cli/**` routes:

```ts
export default defineConfig({
  routes: {
    mcpCommands: {
      include: ['curator:*'],
      exclude: ['curator:apply_*'],
    },
  },
});
```

`true` selects every eligible tool. Object-form `include` defaults to every
eligible tool when omitted; `exclude` removes matches afterward. Patterns
match the `<server>:<tool>` identity and support only literal text plus `*`
(zero or more characters). Every declared pattern must match at least one
eligible tool; `include: []` and misspellings fail with `AB4822`, whose
diagnostic lists the available identities. Excluding every selected tool is
legal.

Each projected tool runs as `<plugin-bin> <server> <tool>` with the protocol
tool name preserved verbatim. Its only input option is
`--input '<one JSON object>'`; omission supplies `{}`, while invalid JSON,
arrays, `null`, and scalars exit 2 before route execution. A tool is read-only
only when its static MCP annotations explicitly set `readOnlyHint: true`.
Every other tool is mutation-capable and fails closed unless `--yes` is
present. Help and `agent-bundle inspect --routes` expose the source server,
tool, and confirmation policy, and collisions with custom command paths,
groups, or aliases fail with `AB4813`.

A tool whose validated result carries an integer `exitCode` can declare
`config.exitCode: 'result'`; projection preserves that policy so represented
domain failures exit nonzero. Other projected tools retain the success-status
policy and exit zero only for a successful rendered document.

This is an in-house projection over the compiled route graph, per gate G7; it
does not depend on MCPorter or introduce a second command model. MCPorter can
still be pointed independently at the generated MCP server when a live-server
client is desired.

### The stdio MCP lifecycle shell

An MCP server entry that **default-exports a server factory** is served under
the framework lifecycle:

```ts
// src/mcp/curator.ts — the whole stdio entry a consumer writes
import { createRscMcpServer } from '@agent-bundle/runtime/plugin';
import { application } from '../application.js';

export default () => createRscMcpServer(application, 'curator');
```

The generated shell provides, in order: console-to-stderr redirection before
the consumer module evaluates, the factory call, raw `process.stdout.write`
restored for protocol frames, `StdioServerTransport` construction and
connect, SIGINT → exit 130, SIGTERM → exit 143, stdin EOF → exit 0 (so the
client can respawn), transport-close → exit 0, a 5-second bounded shutdown
race against wedged transports, and heartbeat/activity logging on stderr
(5-minute interval, 60-second activity throttle, labeled with the server
name).

Self-connecting entries — modules that construct and connect a transport at
top level without a default export — keep today's behavior byte for byte.

Every served tool call is one ordinary `tools/call`: optional
`notifications/progress` while the caller's progress token is live, then one
final `CallToolResult`. The shell advertises no `tasks` capability and
processes a task-augmented request as an ordinary one; task-augmented calls
are deferred until the MCP SDK ships a task runtime (see
[MCP conformance evidence](./mcp-conformance.md#task-augmented-requests-deferred-2026-09-02)).

The same lifecycle is public API for hand-rolled entries:

```ts
import { redirectConsoleToStderr, runStdioServer } from 'agent-bundle/mcp-entry';
```

Export detection is a static scan of the entry source (comment-, string-, and
template-safe). The generated shells re-verify the export shape at runtime
with a clear error.

### Workbench lifecycle replay provenance

The Workbench Lifecycles view exposes the request context used for each
deterministic replay. Host, session, actor, and workspace are separate
observed axes beside invocation kind, operation, surface, and host-contract
revision. Values parsed from the checked-in or pasted native receipt use the
`receipt` source — never `native`, because a Workbench replay is not evidence
that the named host dispatched the event. A missing session, actor, or
workspace remains visibly `unavailable` with its typed reason.

The same projected axes are mounted into the route request scope before
rendering, so `await agent()` and the Workbench evidence panel describe one
context rather than parallel snapshots. User-edited business input cannot
replace these axes.

## `agent-bundle/meta` — build-time release identity

Plugin code reads its own identity from the framework instead of maintaining
a hand-written `src/lib/version.ts`:

```ts
import meta, { name, packageName, packageVersion, version } from 'agent-bundle/meta';
```

`version` is the resolved plugin version: the authored `plugin.version` when
declared, otherwise the `package.json` version. `name` is the host-native
plugin slug — never the npm package name. `packageName` and `packageVersion`
are the validated npm axes, `undefined` for an unpackaged development
project. Every value is exactly what artifact manifests, `inspect`, and dev
status report for the same build.

The compiler replaces the specifier in **every** compiled surface: artifact
scripts, the routed CLI, MCP entries, hook wrappers, and the package build
(all through Rslib), plus browser MCP App view bundles (through Rsbuild). The
module is a reserved specifier, so the `tools` hatch cannot externalize it,
and no emitted bundle can still carry an unresolved import of it.

Types ship with the package export, so no generated declaration file is
involved. Outside Agent Bundle compilation the published module throws rather
than reporting a fabricated identity — a plugin slug exists only in the
config, and a runtime guess at it would silently disagree with the artifact.
A release build refuses a project with no release version at all (`AB4013`),
so a compiled artifact never carries the development fallback.

## Prebuilt payloads — package what you compiled yourself

Some projects legitimately own their compilation — a coordinated
multi-environment bundler topology the per-entry `tools` hatch cannot
express — but still want framework-owned host packaging (manifests, hook
documents, env anchors, provenance, validation). The `payload` block
declares already-built directory trees the build packages **as-is**, and the
`{ prebuilt: ... }` marker points MCP entries and hook handlers at files
inside them:

```ts
export default defineConfig({
  payload: {
    // key = artifact-root destination directory, value = the built tree
    app: './dist/app',
    runtime: { source: './dist/runtime', targets: ['claude', 'codex'] },
  },
  mcp: {
    servers: {
      timeline: {
        entry: { prebuilt: './dist/runtime/mcp/stdio.js' },
        transport: 'stdio',
      },
    },
  },
  hooks: {
    afterTool: [{
      args: ['--host', 'claude'],
      handler: { prebuilt: './dist/runtime/hook/index.js' },
      targets: ['claude'],
      tools: ['file.write'],
    }],
  },
});
```

- **Stable paths, not content-hashing.** Every payload file keeps its exact
  relative path under the destination directory. The framework did not
  compile these files, so it cannot rewrite the references inside them —
  sibling chunk imports, worker entries resolved from `import.meta.url` —
  and hosts, manuals, and tests pin the entry paths. Integrity stays
  content-addressed anyway: each payload file lands in the artifact manifest
  with its SHA-256 and the `prebuilt` file kind, and the payload files hash
  into `project.sourceInputs`, so the project revision changes whenever the
  payload bytes do.
- **The same adapter lowering.** A prebuilt MCP entry normalizes to a
  command-shaped stdio server whose first argument is the payload path
  anchored on the plugin-root token, so every target renders it natively
  (`${CLAUDE_PLUGIN_ROOT}/runtime/mcp/stdio.js`, Codex's `./runtime/…` with
  `cwd: "./"`, `${PLUGIN_ROOT}/…`), the `AGENT_BUNDLE_PLUGIN_ROOT` env
  anchor is injected as usual, and artifact validation confirms the
  referenced file is present and manifested. A prebuilt hook emits its
  native command as `node "<root>/<payload path>" <args…>` — one config
  declaration replaces a hand-rolled `hooks/hooks.json` per host. Prebuilt
  hook `args` (for example `--host claude`) accept shell-safe strings only.
- **Prebuilt means opaque.** Payload files are exempt from generated-output
  content validation (bundled-ESM import graphs, strict generated JSON) but
  remain hash-locked to the manifest. Declaration provenance is recorded as
  `kind: 'prebuilt'`. Hooks with prebuilt handlers are packaged like native
  hook documents: they do not compile wrappers and do not appear in the
  simulatable hook index. MCP Apps declared on a prebuilt server stay a
  development surface (the Workbench compiles them live); the build assumes
  the payload already serves the resource.
- **Ordering.** Run your own build before `agent-bundle build`: a missing or
  empty payload is a validation warning (`AB4743`/`AB4745`) so `dev` works
  from a clean checkout, but `agent-bundle build` refuses it
  (`AB4747`/`AB4748`). Payload directories must not overlap the artifact
  `--output` root (`AB4749`) — with payloads under `dist/`, pass an output
  like `dist/plugins`. See `docs/diagnostics.md` for the full `AB474x`
  table.

`examples/rsc-agent-runtime` is the reference consumer: its Rsbuild build
owns a three-environment RSC compilation, and `agent-bundle build` packages
the resulting `dist/runtime` and `dist/app` trees into the Claude, Codex,
and portable artifacts.

## `tools` — THE escape hatch

`tools.rsbuild` (an Rsbuild environment-config fragment) and `tools.rspack`
(an Rspack config object, mutator function, or array — Rslib semantics) merge
**last** into every bundler config agent-bundle synthesizes: artifact scripts,
MCP entries, hook wrappers, MCP App views, and the package build. This mirrors
Rslib's user-config-highest priority and Rspress's `builderConfig` position,
and it is the reason a consumer never needs a second bundler config file.

The hatch is bounded: the framework invariant hook runs after the consumer's
`tools.rspack`, and the resolved-config assertions still run after the merge.
A hatch value that breaks an artifact contract (async chunks, output roots,
self-containment) fails the build with a hard diagnostic instead of silently
overriding the contract. Reserved module specifiers are protected the same
way: a hatch that externalizes `agent-bundle/mcp-entry` or a generated
module specifier (`agent-bundle/meta`, or a registry specifier such as
`agent-bundle/mcp-apps`) fails the build with a hard diagnostic — at config inspection for statically visible `externals`,
and through a post-build scan of the emitted bundle for function-form
`externals` — because generated executables must stay self-contained. The
hatch customizes *how code compiles*, never *what the artifact promises*.

The hatch executes under two different bundler engine copies. Artifact
scripts, MCP entries, hook wrappers, and the package build compile through
Rslib, which runs the Rsbuild/Rspack versions nested inside `@rslib/core`
(currently the 2.1.x line); MCP App views compile through the
workspace-pinned `@rsbuild/core` (currently 2.2.x), until Rslib catches up to
the Rsbuild 2.2 line. So a hatch must never construct plugins or run
`instanceof` checks against an imported `@rspack/core`: a class imported from
a separately installed `@rspack/core` has a different identity than whichever
engine executes the config. Use instead the utils argument Rslib/Rsbuild pass
to `tools.rspack` mutator functions —
`tools: { rspack: (config, { rspack }) => { ... } }` — which always hands the
engine's own `rspack` object.

### `agent-bundle inspect` component accounting

```sh
agent-bundle inspect [--target <t>] [--json]
```

Every inspection plan accounts for each host component the project declares
— skills, commands, rules, hooks, MCP servers, MCP Apps, and scripts — as
either `selected` (emitted for that target) or `skipped` (omitted), in one
deterministic order. A skipped component names its cause: `excluded-by-targets`
when the author's `targets` left the host out, or `unsupported-capability` when
the host's pinned capability table does not support the surface. Components
that need a host capability carry that target's own four-state judgment as
`capability` — `{ name, state: 'supported', evidence }` for emitted surfaces,
or `{ name, state: 'degraded' | 'unavailable' | 'prohibited', reason }` — so
the JSON explains why a Cursor rule is absent from a Claude bundle in the
host's words rather than the compiler's. An adapter that publishes no row for
a needed capability reads as an honest `unavailable`, never a silent pass.
Scripts need no host capability and carry none. The human output prints one
line per target (`<target>: N component(s) selected, M omitted`) followed by
each omission and its reason.

### `agent-bundle inspect --bundler`

```sh
agent-bundle inspect --bundler [--target <t>] [--json]
```

Dumps the synthesized bundler configuration for every output the build
composes — artifact scripts, MCP entries, hook wrappers, the per-target MCP
Apps Rsbuild config, and the `dist/` package build — exactly as the build
lowers it: the framework profile with the consumer `tools` hatch merged over
it and the invariant hook appended last (functions render as
`[function <name>]`). Entries the framework wraps also carry the generated
wrapper module source (`generatedEntry`). The composition comes from the same
functions the build uses, so the dump cannot drift from what compiles.

Nothing is redacted (this is a local debugging surface), but two build-time
values are replaced with stable tokens so output is deterministic for one
project: the artifact output root (chosen per build) appears as
`<output>/<target>`, and the synthesized declaration tsconfig (a temporary
file generated per package build) appears as `<generated-dts-tsconfig>`. The
package build's output root appears as its published destination, `dist`,
although each real build stages outputs before publishing them atomically.
Resolved post-bundler internals stay Rslib's domain; this surfaces
agent-bundle's own composition, which is where the `tools` hatch lands.

## Dev-watch of the package build

`agent-bundle dev` rebuilds the `dist/` bin and lib outputs inside the same
debounced, serialized rebuild pass that publishes artifact epochs, with a
provenance-based incremental boundary: after a successful package build, the
sorted source inputs of every emitted file (recorded from bundler stats) are
kept, and the next rebuild is skipped unless an invalidated path was one of
those inputs, the configuration file, `package.json`, or `tsconfig.json`
changed, the rebuild identity changed — the normalized `bin`/`lib`
declaration plus the `tools` escape hatch, with hatch functions compared by
source text — the invalidation was manual or initial, or the previous
package build failed. When every package entry disappears within a live
session (entries removed or opted out), the outputs that session previously
published are removed; outputs from earlier sessions are untouched, matching
`agent-bundle build`. A package build failure never invalidates the
committed artifact epoch — it surfaces as one `AB7103` warning on the
succeeded attempt and retries on the next invalidation. The boundary this
does **not** cover: a brand-new file that changes module resolution without
touching a tracked input is picked up on the next tracked change, not
instantly.

## `agent-bundle mcp run`

```sh
agent-bundle mcp run --server <name> --target <target> [--artifact <path>]
  [--env-file <path>]... [--no-env] [--plugin-root <path>]
```

Runs one built stdio MCP server in the foreground with inherited stdio: the
content-hashed generated entry is resolved from the target's MCP manifest
(the job previously solved with bash launchers parsing `mcp.json`), path
tokens are resolved through the target adapter, and the child's exit code is
forwarded (SIGINT/SIGTERM forward to the child). Without `--artifact`, a
temporary artifact is built first.

### Launch environment

The runner loads the project-root `.env` set by default — rsbuild's `loadEnv`
conventions (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`, with
`--mode` selecting the variants) — so operator credentials configured for the
plugin reach a bare `mcp run` without a wrapper script. This is a
launch-time-only layer: the framework's programmatic Rslib builds never pass
`loadEnv` to `createRslib`, so `agent-bundle build` and the package build read
no `.env` file at all, and nothing from `.env` can leak into a compiled
artifact. `--env-file <path>` (repeatable, Node's `--env-file` dialect, later
files win) replaces the conventional set with exactly the named files, and
`--no-env` skips the layer entirely; a named file that cannot be read is an
error, never a silent skip.

The child environment is composed from three layers. This table is the
canonical precedence order (highest wins):

| Precedence | Layer | Contents |
| --- | --- | --- |
| 3 (highest) | Operator `process.env` | The real environment `mcp run` was started with. An exported variable always wins. |
| 2 | `.env` file layer | The conventional project-root set, or the explicit `--env-file` list in order. Fills gaps only; never beats an exported variable. |
| 1 (lowest) | Manifest env | Entries declared in the server config plus the injected plugin-root anchor, path tokens expanded. |

### Durable-state anchors

Under `mcp run` the artifact is an ephemeral build product, so both
durable-state anchors point at the project root: state anchored on the
plugin-data token persists under `.agent-bundle/mcp-run/<target>/<server>`,
and plugin-root tokens in *env values* — including the injected
`AGENT_BUNDLE_PLUGIN_ROOT` anchor — expand to the project root itself.
Targets without token interpolation (Codex serializes the anchor as a `./`
path) re-anchor their relative env values against the same durable root.
`args` and `cwd` stay artifact-rooted (the first argument is the
content-hashed bundle inside the target root). `--plugin-root <path>`
overrides the env-anchor root, e.g. point it at `artifact/<target>` for a
byte-faithful rehearsal of a copied-artifact launch; under a host install the
anchor still means the durable install root, exactly as before.
