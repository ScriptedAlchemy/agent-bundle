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
| `src/mcp/<server>/apps/*.{ts,tsx}` | Browser MCP App entry compiled to self-contained HTML and registered on the generated server; static `config.resourceUri` is required (`AB4812`), and two App routes of one server sharing a URI are `AB4829` (the same URI on different servers is not a collision). An optional `config.template` HTML shell resolves relative to the route module like its imports (`'./dashboard.html'`); the legacy project-root-relative form is accepted only while unambiguous (`AB4827` otherwise). Tools, resources, and prompts reference the App from their own static `config` with `appResourceUri('<app>')` from `agent-bundle/routes` or a shared `const` string literal instead of repeating the `ui://` literal. | Use a custom server or prefix the file with `_` |
| `src/scripts/<name>.ts` | Plain script compiled to `scripts/<name>.mjs` in every selected target artifact — the same pipeline explicit `scripts` entries use, with ordinary Node stdout/stderr semantics. A `scripts` entry that references the file claims it. Nested modules are hard errors (`AB4808`). A `bin` entry that references the file does **not** claim it: the module ships as both the npm bin and the artifact script (see [Which config keys claim a conventional module](#which-config-keys-claim-a-conventional-module)); export `main` or make the module self-executing, because a `default`-only module would run as the bin but ship as an inert script (`AB4738`). | Prefix a path segment with `_`, or claim the file with an explicit `scripts` entry |
| `src/scripts/<name>.tsx` | Rendered script: the async default component receives `{ argv, signal }` and renders through the Agent renderer with the CLI output contract (`--json`, `--ndjson`, TTY progress, piped Markdown). Compiles to `scripts/<name>.mjs` plus a `scripts/<name>-flight.mjs` react-server worker. The extension is the explicit, visible contract — plain `.ts` scripts are never wrapped in React behavior, and explicit `scripts` config entries stay plain regardless of extension. A `bin` entry that references a rendered script is `AB4737` unless the module exports both the default component (for the script) and a named `main` (for the bin envelope); with both, the module serves both surfaces. | Rename to `.ts`, prefix a path segment with `_`, or claim the file with an explicit `scripts` entry |
| `src/cli/**/*.{ts,tsx}` | Routed CLI commands compiled into one collision-checked command graph and one generated package executable named after `plugin.name` (superseding the `src/cli.ts` bin convention for the project), plus the same executable as `bin/<plugin-name>.mjs` in every selected host artifact whose target publishes the `cli` capability (all built-in targets). Nesting is identity: `src/cli/library/audit.ts` runs as `<bin> library audit`. Plain `.ts` commands execute directly and print one canonical JSON line; `.tsx` commands render through the dispatcher with the four output modes. | `bin: false`, `routes.cli: 'conventional'`, or prefix a path segment with `_` |
| `src/events/<family>/<event>.{ts,tsx}`, `src/events/stop.{ts,tsx}` | Semantic event route: the path is the canonical event family (`src/events/tool/after.tsx` is `tool/after`; `stop` is the one top-level family) and must be one of the admitted `canonicalAgentEvents`. The optional static `config` (`AgentEventRouteConfig`: `targets`, `tools`, `runtime: 'shared' \| 'standalone'`, `fallback`, `delivery`, `timeoutMs`) restricts hosts and selects the execution mode; the async default Server Component receives `AgentEventRouteProps<E>` (`{ canonical, native, signal }`) and returns `Agent.*` output that the selected host adapter encodes into its native hook envelope. `canonical.payload` is the family's cross-host reading of the envelope (#466) — the fields at least two hosts report (`toolName`, `toolInput`, `toolResponse`, `sessionId`, `transcriptPath`, `cwd`, `prompt`, `agentId`/`agentType`, `reentry`, …), each as `{ value, nativeKey }` naming the host key it came from and absent when the host did not send it; `E` narrows it to the route's family. The per-family field table is `agentEventPayloadFields` and the per-host key table `agentEventPayloadNativeKeys` (`routes/events.ts`), mirrored under `hooks.eventRoutes.<event>.payload` in each pinned capability table so the generated events reference documents the mapping per host. Application code never branches on host JSON or emits native hook documents; per-host support is a capability state (`supported`/`degraded`/`unavailable`/`prohibited`) surfaced by `inspect` and enforced at build time (`AB4817`, `AB4823`–`AB4825`). | Restrict `config.targets`, or prefix a path segment with `_` |
| `src/state.ts` | Project state definition: default-exports `defineState({ ... })`; generated MCP, routed-CLI, and rendered-script request scopes mount `(await agent()).state` and `.notices`. | `state: false`, or rename the file to `_state.ts` |
| `src/providers/<name>.{ts,tsx}` | Request context provider: default-exports a factory receiving `{ invocation, signal, host, session, workspace, plugin, lineage, state?, notices? }` — the request's observed identity (plugin root included) and lineage plus read-only views of the mounted state (`read`) and notice (`inbox`, `published`) handles; its value is mounted at `(await agent()).providers.<camelCaseName>` for generated MCP and event routes, projected MCP commands, plain and rendered routed CLI commands, and rendered scripts. | Prefix the file with `_` |
| `src/layout.{ts,tsx}` | Shared document layout: default-exports one component receiving `{ children, route, signal }` that renders `Agent.Result` around every rendered route — generated MCP tools, resources, and prompts, rendered routed CLI commands, projected MCP commands, and rendered scripts. Event routes are never wrapped. | Rename to `_layout.tsx` |
| `src/mcp/<server>/layout.{ts,tsx}` | Per-server layout nested inside the root layout for that generated server's routes. | Rename to `_layout.tsx`, or set `routes.servers.<server>` to a non-generated mode |

Route and package entry conventions match `.ts` and `.tsx` files exactly;
the state convention is specifically `src/state.ts`.

### Which config keys claim a conventional module

An explicit config entry that references a module under a conventional route
directory *claims* it: the module belongs to that declaration and leaves
conventional discovery. Claims are decided by the module path the entry
resolves to, so nothing is ever compiled twice into one artifact output. The
exception is `bin`: a bin compiles to `dist/bin/<name>.js`, which is disjoint
from every artifact output, and the bin envelope and the artifact-script
envelope run the same `main`, so a direct `src/scripts/<name>` child a `bin`
entry references stays a conventional script and ships on both surfaces. (A
nested `src/scripts/<dir>/<name>` module or one whose stem is not a safe route
identity — which the flat scripts artifact could not ship anyway — stays
claimed, so a bin-only entry there never turns into `AB4808` or `AB4803`.)
`inspect` shows such a module under both `packageBuild.bins` and `scripts`; no
diagnostic fires, because that is the intended "same entry, npm bin + hook
target" shape. `lib` is not an executable surface, so a `lib.entry` claims
its module like every other key.

| Config key | Claims a module under | Effect on a `src/scripts/<name>.ts` module it references |
| --- | --- | --- |
| `scripts.<name>` | every route directory | Claimed: the explicit entry ships it as `scripts/<name>.mjs`; the convention no longer applies. A *different* module under `src/scripts/` sharing the configured `<name>` is `AB4809`. |
| `hooks.<event>[].handler` | every route directory | Claimed: the module is a hook handler compiled under `hooks/`, not an artifact script. |
| `mcp.servers.<id>.entry`, `mcp.servers.<id>.apps.<app>.entry` / `.template` | every route directory | Claimed: the module is the server or App entry compiled under `mcp/` or `mcp-apps/`. |
| `lib.entry` | every route directory | Claimed: the module is the library entry compiled to `dist/<stem>.js`, not an artifact script. |
| `bin.<name>` | `src/cli/**`, `src/events/**`, `src/mcp/**`, `src/providers/*`, and any `src/scripts/**` module that is nested or unsafely named — **not** a safely named direct `src/scripts/<name>` child | Not claimed: the module ships as both `dist/bin/<name>.js` and `scripts/<name>.mjs`. The module must export `main` or be self-executing: a plain `default`-only module is `AB4738`, and a rendered `src/scripts/<name>.tsx` must export both the default component and `main`, otherwise `AB4737`. |

To ship a `src/scripts/` module as a bin only, prefix a path segment with `_`
(`src/scripts/_hauler.ts`): private segments opt the module out of discovery
while the `bin` entry still references it explicitly.

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
directory. The npm package's routed CLI bin and rendered scripts use
`$AGENT_BUNDLE_PLUGIN_ROOT/state` when present and otherwise
`$PWD/.agent-bundle/state`; the artifact-hosted routed CLI bin
(`<target>/bin/<name>.mjs`) derives the artifact root from the parent of its
own `bin/` directory instead, like the MCP worker. Each generated process
resolves that anchor exactly once (`resolvePluginRoot` from
`@agent-bundle/runtime`, #468): the state kernel, the notice ledger, the
lineage journal, and every request scope the process opens read the same
value, published as `(await agent()).plugin` — `{ root, stateRoot }` with
`source: 'native'` from `AGENT_BUNDLE_PLUGIN_ROOT` or `'derived'` from the
fallback — and handed to conventional providers as `plugin` beside
`invocation` and `signal`. An anchor still carrying an unexpanded `${…}`
token is treated as unset (reported once on stderr), never joined into a
path. Notice authorization is deliberately permissive
in generated mounting v1 (`authorized`); recipient/principal matching remains
enforced by the ledger — every generated scope mounts the request's `lineage`
on the notice principal, so `recipient.conversation` / `recipient.root` are
matched against `request.lineage` on every surface — while application
authorization policy is deferred.

Each cross-request notice route is selected from the target host's pinned
`noticeDelivery` table, exposed as `TargetAdapter.noticeDelivery` /
`TargetRegistry.noticeDelivery(target)` (a local `NoticeDeliveryAdvertisement`
shape, structurally identical to the runtime's so it types for
`selectNoticeDeliveryRoutes` without making the optional `@agent-bundle/runtime`
peer a declaration dependency); the unified `plugin` target advertises the
intersection of its three hosts, and a target with no advertisement wires no
cross-request route. The `agent-bundle://notices/inbox` resource is registered
in the server and mounted in its worker only for stateful projects whose host
advertises `mcp-inbox` (the worker still mounts the ledger so routes can
publish; only the unadvertised read surface is withheld, and the reserved name
stays reserved). For workspace-durable state only, and only when the host also
advertises `mcp-resource-updated`, the server process opens its own SQLite
handle on the notice ledger (`createGeneratedNoticeRuntime` over the same
anchor) and advertises `resources.subscribe`: a client that subscribes to the
inbox receives one `notifications/resources/updated` after a render leaves it
newly eligible pending notices, recorded on the ledger as an availability
receipt. Volatile lifetimes keep the store in the worker's heap, and a host
whose table marks the route unavailable has no consumer for the signal, so
those servers register no subscription handlers and advertise no subscribe
capability.

#### Notice redaction and retention

The generated ledger honours two policies the artifact carries as literals
(#99 acceptance item 7). The host's `noticeDelivery` advertisement is
declared once per generated module (`noticeDeliveryAdvertisement`) and passed
to both the worker's `createGeneratedRuntimeState` and the server's
`createGeneratedNoticeRuntime` / `createNoticeInboxSignaller`: each supported
row may name a `sensitivity` ceiling (`public | internal | secret`, absent
means `internal`) with dated `sensitivityEvidence`, and the ledger withholds a
notice whose author-declared `sensitivity` exceeds the ceiling of the route
about to carry it — the inbox omits it, event admission neither authorizes nor
attempts it, the signaller never announces it — recording the refusal on the
notice (`withheld[route]`) instead of moving its state. `internal` content
(the default) is passed through the runtime's secret pass on every route
before it leaves the store — `flare-redact`, an exact-pinned dependency of
`@agent-bundle/runtime`, with its default detectors and every finding replaced
whole by `[REDACTED]`; the runtime README's notices section lists the coverage
and the libraries evaluated — `public` travels as authored;
`secret` travels as authored only where the row admits it. The built-in hosts
admit `secret` on `current-response` and `next-event` and `internal` on
`mcp-inbox` and `mcp-resource-updated`; the pinned tables carry the dated
evidence and the generated notice reference page renders it.

`notices.retention` in `agent-bundle.config.ts` (`terminalTtl`, `maxTerminal`,
`maxJournalBytes`; `AB4833` when malformed or declared without `src/state.ts`)
resolves over the runtime defaults (`7d`, `500`, `16777216`) and is emitted as
`noticeRetentionPolicy` into every generated module that mounts the ledger, so
the MCP worker, the server process, the routed CLI bin, and rendered scripts
prune the same way: settled terminal notices past the TTL (or beyond the cap)
leave the ledger state on the next admitted event, and the store's journal is
compacted onto its head once it exceeds the byte bound. `inspect --state`
reports the resolved policy and whether it was declared or defaulted (the
Workbench State panel shows the same); live counts and the last compaction are
facts of one installed store, read through `AgentNoticeLedger.inspect()`.

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
with the contract `(context: AgentProviderContext) => value | Promise<value>`:

```ts
interface AgentProviderContext {
  invocation: AgentProviderInvocation;  // the surface-specific route invocation
  signal: AbortSignal;                  // the request abort signal
  host: Observed<{ name }>;             // exactly what the route reads on `await agent()`
  session: Observed<{ sessionId }>;
  workspace: Observed<{ root }>;
  plugin: Observed<{ root; stateRoot }>; // the resolved plugin root (#468)
  lineage: Observed<AgentLineage>;      // own chain plus the live `tree` (#457)
  state?: { lifetime; read(options?) }; // the mounted state handle, `read` only
  notices?: { inbox(); published() };   // the request's notice handle, reads only
}
```

`host`, `session`, `workspace`, `plugin`, and `lineage` are the same observed
values the route will read, provenance and unavailable reasons included.
`state` is present for projects that declare `src/state.ts` and `notices` for
projects whose scope mounts the notice ledger; both are the real request
handles narrowed by construction to their read paths (#459) — `inbox()` is
what is pending for this request's principal, `published()` what became of
the notices it published (#460) — so a provider can expose a derived view of
shared state — a topology, a summary, a peers list — but never dispatch a
state event or publish, acknowledge, or withdraw a notice: those stay
route-only. Providers also run outside the request's async context, so
`agent()` and `useAgent()` inside a factory throw `outside-invocation` rather
than handing it the full handle. The types ship from `agent-bundle`
(`AgentProviderContext`, `AgentProviderStateHandle`,
`AgentProviderNoticesHandle`, `AgentProviderLineage`, …) without a runtime
import; at run time the handles are the runtime's own.

Every generated request scope — the shared Flight worker behind generated MCP
and event routes, the react-server worker behind rendered routed CLI commands
and rendered scripts, and the routed-CLI executable itself for plain `.ts`
commands — executes providers once per request as the request's own provider
resolver: `runAgentRequest` freezes the identity axes, opens the notice lease
(so `notices.inbox()` is real), then runs the factories sequentially in
deterministic key order, and only then runs the route. That ordering — state
and notices mounted before providers, rather than a lazy handle that resolves
later — is what keeps the generated loop and the harness's `executeProviders`
one simple function: a provider awaits real handles, and a factory that reads
`inbox()` eagerly cannot deadlock on a lease that has not opened yet. The
returned values join the request's provider map. A thrown or rejected factory
fails the request closed, exactly as a route that throws after admission does;
expected degradation should return an honest unavailable-shaped value instead
of throwing. `invocation.kind` stays surface-specific (`tool`, `event`, `cli`,
`script`), so a provider can branch on the entry surface deliberately.
`processLifetime` is reserved for the framework-owned process identity and hit
counter, so provider filenames must not derive that key. A custom host calling
`runAgentRequest` directly may pass `providers` as the resolved record or as
the same resolver function `(request: AgentProviderRequest) => values`.

The `agent-bundle/test` harness mounts the same providers, in the same order
and with the same fail-closed semantics, for every manifest-backed helper
(`renderRoute`, `renderRouteEvents`, `invokeCli`, and the in-memory MCP
helpers), so a route test observes what the artifact would mount. A test that
wants to choose the values instead injects them through the same `context`
seam as identity axes (`renderRoute(id, { context: { providers: { library:
fixture } } })`): an explicit map is mounted verbatim and no conventional
provider module executes. A module rendered directly (no compiled manifest)
has no project to discover, so it observes only `processLifetime`. Once the
generated `.agent-bundle/routes.d.ts` augmentation declares provider keys, an
explicit `context.providers` map must carry every declared key (as must
`providers` on a direct `runAgentRequest`), so a fixture that omits a value the
route's types promise is a compile error rather than a runtime `undefined`;
omitting `context.providers` altogether stays legal and mounts the real
providers. The harness reproduces the per-executable process identity, not
per-executable module evaluation: provider modules are evaluated once per test
worker, so module-level provider state is shared across the simulated
executables of that worker and is only proven cold by the proof levels that
spawn the artifact.

### Shared layouts

A layout is the conventional composition point around every rendered route
of a project — the `layout.tsx` idea from page frameworks, applied to Agent
Documents. `src/layout.{ts,tsx}` wraps every rendered route (generated MCP
tools, resources, and prompts; rendered `src/cli/**` commands; projected MCP
commands; rendered `src/scripts/*.tsx`), and `src/mcp/<server>/layout.{ts,tsx}`
nests inside it for one generated server. Composition order is root layout,
then server layout, then the route. Event routes are host protocol responses
rather than documents for a reader, so no layout applies to them; browser
App routes are browser builds and are likewise untouched.

```tsx
// src/layout.tsx — the whole layout a consumer writes
import { Agent, type AgentLayoutProps } from '@agent-bundle/runtime';
import React from 'react';

export default function Layout({ children, route }: AgentLayoutProps) {
  return (
    <Agent.Result metadata={{ route: route.id }}>
      {children}
    </Agent.Result>
  );
}
```

The layout renders `Agent.Result` around `children`, the route's rendered
element. An `Agent.Result` that declares no `value` is a **container**: when
it directly holds a result that does carry a value — the route's own
`<Agent.Result value={...}>` — the runtime merges the two while decoding the
document. The route's value becomes the document value, its children take the
inner result's place, and `metadata` combines: two JSON objects merge key by
key with the container winning conflicts, any other shape lets the container
win outright, and a container without metadata adopts the inner one. A route
therefore keeps its result value, its `structuredContent`, and its rendered
content whether or not a layout exists; what the layout adds is the shared
shell around it — a heading, a trailing `Agent.Context` note, document
metadata. Because the MCP projector exposes root metadata as the result's
`_meta`, a layout that declares metadata does change the MCP response there;
a layout without metadata leaves `_meta` exactly as the route authored it.
Nested layouts merge bottom-up the same way. Metadata on either side must be
plain JSON: a `Date`, class instance, accessor, or cyclic value fails the
document contract under a layout exactly as it does without one.

The generated worker resolves the route's element **before** the layout chain
renders, then wraps it. That keeps failure semantics identical with and
without a layout — a route that throws rejects the whole render (CLI exit 1
with the route's message; on MCP the SDK's default `isError` tool result or a
JSON-RPC error, with no layout `_meta` — see
[What happens when a route throws](framework-mode.md#what-happens-when-a-route-throws))
instead of being downgraded to a represented `boundary` error beneath the
layout's shell. The trade-off is
deliberate: a layout cannot stream a `Suspense` fallback around `children`
while the route is still running, because the route is never a lazily
resolved Flight chunk under the layout. A `Suspense` boundary a layout places
around its **own** content streams as usual.

`route` is the stable identity baked at compile time: `id` (`tool:curator/
inspect_sources`), `kind` (`tool`, `resource`, `prompt`, `cli`, `script`),
`name` (the protocol-facing tool/resource/prompt name, the space-joined
command path, or the script name), and `serverId` for MCP kinds. `signal` is
the request abort signal. Layouts render inside the same request scope as the
route, so `await agent()` exposes the invocation, host, session, actor,
workspace, state, and provider axes exactly as it does in a route. The props
type `AgentLayoutProps` ships from `@agent-bundle/runtime` (it carries React's
`ReactNode` children); `agent-bundle` exports the React-free `AgentLayoutRoute`
and `AgentLayoutRouteKind` identity types.

The compiler validates layouts statically: a layout whose default export is
not a function, or that carries the route contract's `config`/`inputSchema`/
`resultSchema` exports, fails with `AB4830`; `.ts` and `.tsx` siblings for
one scope fail with `AB4831`; a server layout whose server declares no tool,
resource, or prompt route modules (a missing server, or one with only `apps/`)
fails with `AB4832`, while a server pinned to `custom`, `command`, or `remote`
via `routes.servers.<server>` skips its layout entirely. At run time a layout module that resolves to a
non-function default export fails the request closed before rendering. The
route-unit and projection levels of `agent-bundle/test` compose the same
layout chain the generated workers bake, so `renderRoute('tool:...')` and
`invokeMcpTool(...)` prove the composed document; rendering a module passed
directly to `renderRoute()` composes no layout, because layouts are a compiler
convention rather than a property of the module.

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
axes remain honestly unavailable. `actor` is the HTTP-authenticated MCP
client and nothing else: hook-driven event scopes observe it as unavailable
rather than receiving a fabricated value, and the framework never derives an
operator identity (a signed-in user, an email) from any host payload or
environment — hosts that send one (Cursor's `user_email`) have it passed
through inside `native` untouched and unread. Who the *conversation* is —
its parent, its root, whether it is a subagent — is the
[`lineage` axis](#conversation-lineage-requestlineage).

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

The same seam accepts `actor`, `workspace`, `lineage`, and `capabilities`;
tests can use `unavailable(...)` to pin a transport's honest absence semantics.
`invokeCli` (routed commands) and `runScript` (conventional scripts) accept the
same `context` for their rendered surfaces and open the request scope with the
surface-specific `invocation.kind` the generated executable would use.

#### Conversation lineage (`request.lineage`)

`request.lineage` is the one answer to "who is my parent, what is the root
conversation, and are we a subagent (of whom)?". It is the only place the
framework places a request in the host's conversation tree; there is no
separate operator or user identity axis, by design. `(await agent()).lineage`
is an `Observed<AgentLineage>` with one shape on every surface — event routes,
generated MCP tools, routed CLI commands, and rendered scripts:

```ts
interface AgentLineage {
  conversation: string;   // the agent whose activity this is
  root: string;           // the user-facing conversation at depth 0
  parent?: string;        // absent at the root
  depth: number;          // 0 at the root, +1 per subagent level
  generation?: string;    // Cursor generation_id, Codex turn_id, Claude prompt_id
  subagent?: { id: string; type?: string; toolCallId?: string; isParallelWorker?: boolean };
  resolution: 'native' | 'registry' | 'confirmed' | 'transcript' | 'inferred';
  tree?: AgentLineageTree;  // who else is alive, when the registry placed this request
}

interface AgentLineageTree {
  siblings: readonly AgentLineagePeer[];  // every other live conversation under the same root, any depth
  children: readonly AgentLineagePeer[];  // live conversations whose parent is this one
  roots: readonly AgentLineagePeer[];     // other live depth-0 conversations (Cursor: same workspace_roots)
}

interface AgentLineagePeer {
  conversation: string;
  depth: number;
  parent?: string;
  startedAt: string;      // when the registry saw it start
  subagent?: AgentLineageSubagent;
  resolution: AgentLineageResolution;  // the trust level of *that* node's placement
}
```

`tree` is the other half of "where am I": the live conversations around this
one, read from the same registry that placed the request (#457). It lists
only what the registry holds — no node is invented, and a stopped node is not
listed — scoped to what the conversation may see: everything alive under its
own root (`siblings`, oldest first, the root itself included for a subagent,
so a coordinator sees the whole live tree it belongs to; filter by `parent`
for same-parent siblings), its direct `children`, and the other live `roots`
(on Cursor only roots seen in the same `workspace_roots`, the rule that scopes
child binding; a Cursor child whose conversation has not spoken yet is listed
under its `subagent_id`). Each peer carries the registry's own `resolution`
for its placement, judged exactly as on a request that node itself made. The
tree is absent when the registry did not place the request: a standalone
hook, or a Codex `_meta` that names a thread the registry never saw start,
still answers "who am I" but not "who else is here". It travels as plain
frozen data, so the Flight worker receives it unchanged and route-unit tests
inject it through the same `context.lineage` seam.

`resolution` is the trust level of `parent`/`root`/`depth`: `native` — the
host named them on this payload (a Claude/Codex root, a Codex tool call's
`_meta`); `registry` — the warm runtime's registry placed the conversation
when its subagent started, matching the start to the newest unclaimed spawn
call; `confirmed` — that registry edge, and every edge above it up to the
root, was afterwards named by the host itself (Claude's `Agent` PostToolUse
carries the spawn `tool_use_id`, the caller's identity and
`tool_response.agentId`, the child); `inferred` — ordering inference the host
forced (Cursor binds a child conversation to the single pending
`subagentStart`).

Hooks are thin clients to the warm runtime, so lineage is runtime-held state:
the generated MCP process owns an **agent lineage registry**
(`@agent-bundle/runtime/lineage`), journaled through the state kernel beside
the project's own durable state (`<plugin root>/state`, definition id
`@agent-bundle/runtime/agent-lineage/v1`, bounded retention of stopped nodes
and unclaimed spawn calls). The `agent/start` and `agent/stop` families feed
it, `tool/before`/`tool/after` open and close the correlation window every
MCP call is matched against, and the registry resolves `parent`/`root`/`depth`
for every event by the id the payload carries. The observed host vocabulary
(2026-09-03, [evidence matrix](audits/2026-09-03-host-lineage-matrix.md)):

| Host | `conversation` | `root` | Parent of a new subagent | MCP call correlation |
| --- | --- | --- | --- | --- |
| Claude | `agent_id`, else `session_id` | `session_id` | the agent whose `Agent`/`Task` `PreToolUse` is the newest unclaimed spawn; confirmed by that agent's `Agent` `PostToolUse` (`tool_response.agentId` = the child) | `_meta["claudecode/toolUseId"]` = the open `PreToolUse` `tool_use_id` |
| Codex | `agent_id`, else `session_id` | `session_id` | `source.subagent.thread_spawn.parent_thread_id` (and `depth`) in the head of the thread's own rollout, which every hook names in `transcript_path` (`agent_transcript_path` on `SubagentStop`); with that file unreadable, the thread whose `spawn_agent` call is the newest unclaimed spawn | `_meta["x-codex-turn-metadata"]` carries `thread_id`, `parent_thread_id`, `session_id`, `turn_id` natively |
| Cursor | `conversation_id` | the bound root | `parent_conversation_id` on `subagentStart`; the child's fresh `conversation_id` is bound to the single pending start in the same workspace when it first speaks | the newest open `preToolUse` whose `tool_name` is `MCP:<tool>`; when several conversations have that tool open, the one whose hook `tool_input` equals the call's `arguments` (identical arguments stay `id-not-resolvable`) |

A Claude subagent is placed only when its spawning pre-tool hook
(`Agent`/`Task`) was observed, so projects that want `parent`/`depth` for
subagents route `tool/before` alongside `agent/start`; a start with no
claimable spawn — none open, or several parents with one — stays
`id-not-resolvable`, and the registry keeps what the start said (id, type,
time, and a stop that follows) as an unplaced start.

A Codex thread carries its own evidence: the rollout its payload names opens
with a `session_meta` line recording the spawning thread, the depth, and the
`agent_path`, so the registry places it from that file (`resolution:
'transcript'`, provenance `derived`) at `SubagentStart`, on the first hook of
a thread it never saw start (or held unplaced), and at `SubagentStop` — no
spawn ordering involved, and two parents with unclaimed spawns are no longer
ambiguous. The `spawn_agent` call is still claimed, by parent and by the
`agent_path` its `PostToolUse` `tool_response.task_name` carried, so
`subagent.toolCallId` is exact even for same-parent siblings. Only when the
rollout is unreadable does Codex fall back to the Claude rule (`resolution:
'registry'`), and a parent inferred that way is corrected at `SubagentStop`,
— from the child's own rollout (`agent_transcript_path`, exact parent and
depth) when it is readable by then, else from the parent rollout in
`transcript_path` (`rollout-<timestamp>-<thread id>.jsonl`); descendants move
with it.

Claude Code names no parent on any hook a subagent emits (#422; hooks
reference "Common input fields": `agent_id` and `agent_type` are the only
subagent fields), but the *parent's* `Agent` `PostToolUse` names the edge:
`tool_use_id` is the spawn call, the carrier is the parent, and
`tool_response.agentId` is the child's `agent_id` (observed on Claude Code
2.1.257 and 2.1.259, `status: "async_launched"` for a background spawn,
`status: "completed"` for a foreground one). The registry treats that hook
as the host's word on the edge, whatever it believed before:

- it confirms an edge the spawn window matched (`resolution: 'confirmed'`
  once every edge from the conversation to the root is host-named);
- it fills in which sibling came from which spawn call when several from one
  parent were claimed blind, so `subagent.toolCallId` appears after the fact;
- it places an unplaced start under the parent, as it started (time, type,
  and already stopped when its stop came first), and consumes the spawn call
  so no later start can claim it; a confirmation an unplaced start issued
  for its own children waits with it and is applied when it is placed, so a
  missed spawn hook at one level does not lose the subtree beneath it
  (replaying the 2.1.259 capture without the root's spawn `PreToolUse`
  recovers both the sequential agent and its depth-2 child from the two
  `PostToolUse` payloads alone);
- it moves a child the window filed under the wrong parent (a missed spawn
  `PreToolUse` leaves another parent's open call as the only candidate) and
  re-bases everything the child spawned meanwhile;
- it holds a child it names before that child's `SubagentStart` arrives
  (Claude fires a background spawn's `PostToolUse` first); the start then
  adds its `agent_type`.

Timing bounds what this buys a subagent's own events: a background spawn is
confirmed right after `SubagentStart`, so the child's hooks and MCP calls
resolve `confirmed`; a foreground spawn's `PostToolUse` fires only after the
child's `SubagentStop`, so that child's events resolve `registry` for their
whole life and only the tree (`snapshot()`, the Workbench) shows the
confirmation. A spawn whose response carries no `agentId` (the sub-agents
reference says the one-shot built-in Explore and Plan agents return no agent
ID to Claude) keeps the registry's own match. Nothing here derives an actor
or a user (#391); `request.lineage` stays the only identity surface (#444).
Cursor names a child only on the parent's `subagentStart` (`subagent_id` =
the parent's `Task` call id); the child's own hooks carry a fresh
`conversation_id` and nothing that points back, so the registry binds by
elimination and refuses when elimination is not possible:

- Only root-shaped Cursor events (`session/start`, `prompt/submit`, `stop`,
  `session/end`, `compact/*`, `workspace/open`) may establish a root.
- A never-seen Cursor conversation on a tool event binds to the pending
  `subagentStart` only when exactly one is pending **in its workspace**
  (`workspace_roots` digest, so two windows sharing one durable registry never
  bind each other's children). With several pending in that workspace it
  stays `id-not-resolvable` until all but one have stopped; after a registry
  restart it stays unresolved, because nothing distinguishes it from a root.
- A blind binding is undone the moment the bound conversation carries any
  root-shaped event (`prompt/submit`, `stop`, `session/end`, `compact/*`) —
  subagents never do — so a second chat tab whose prompt predates the registry
  (Cursor desktop restarts mid-conversation, and many conversations are first
  seen on a tool hook) becomes the root it is, anything it started meanwhile is
  re-rooted beneath it, and the pending child waits for its real conversation
  again. The correction runs before the event acts, so a `session/end` on a
  misbound chat retires that chat, never the parent it was filed under.

`session/end` retires the root and every descendant still
marked live; stopped nodes are pruned past the retention bound as they stop.
Redelivered payloads replay their journal entries (keys derive from the
canonical idempotency key and the payload minus receipt timestamps; a
storeless registry keeps an in-memory ledger of applied keys). A project with
several generated MCP servers attaches its event routes to one of them; the
others resolve tool calls by re-reading the shared journal, so their
`request.lineage` is populated only when the project's state is
workspace-durable — volatile and stateless multi-server projects report
`id-not-resolvable` from the servers that host no event routes.

`resolution` says which of those paths produced the answer. When none can,
the axis is `unavailable` with a typed reason: `no-subagent-events` (the
target defines no subagent families — portable), `id-not-resolvable` (the
payload names an agent the registry never saw start, e.g. a cold runtime),
`cloud-agent-no-user-hooks` (Cursor cloud agents run no user hooks),
`no-shared-runtime` (a standalone hook process holds no registry; Claude and
Codex root payloads still resolve to depth 0 from the payload alone, and a
Codex subagent payload resolves fully from the rollout it names —
`resolveStandaloneLineage`),
`unsupported-surface` (routed CLI and rendered scripts run outside any host
conversation), or `not-provided` (no registry was mounted). Per-host
capability rows live under `lineage` in each pinned capability table.

Route-unit tests inject the axis through the same context seam
(`context: { lineage: available({ conversation, root, depth: 0, resolution: 'native' }, 'native') }`);
the in-memory MCP proof level accepts a registry
(`openInMemoryMcpServer({ lineage, lineageHost })`) so hook→MCP correlation
is testable without a spawned process.

#### Terminal capability (`request.terminal`)

`(await agent()).terminal` is an `Observed<AgentTerminal>` (#511): what the
process's output streams are, computed **once per invocation by the framework
shell** with the same rules that pick the CLI output mode, so a route that
colors its own stderr or sizes its own table agrees with the framework's
rendering instead of re-probing `process.stdout` per plugin. It is information
only — never a writer — and it never changes what `Agent.*` components render.

```ts
interface AgentTerminal {
  hostSurface: 'cli' | 'mcp' | 'hook' | 'script' | 'workbench';
  stdout: AgentTerminalStream;
  stderr: AgentTerminalStream;
  sharesTarget: boolean;           // fd 1 and fd 2 name one open file (`2>&1`, one shared terminal)
}
interface AgentTerminalStream {
  kind: 'tty' | 'pipe' | 'none';   // interactive terminal | any other open descriptor | no stream for the route
  color: 'none' | 'basic' | '256' | 'truecolor';
  columns?: number;                // present for a terminal, or when COLUMNS overrides
  rows?: number;                   // present for a terminal, or when LINES overrides
}
```

The probe (`src/terminal-capability.ts`, plain Node, dependency-free, aliased
into emitted executables as `agent-bundle/terminal-capability`) reads
`isTTY`, `columns`, and `rows` off `process.stdout`/`process.stderr`, `fstat`s
the descriptors (`tty`; any other open descriptor is `pipe`; a closed one is
`none`; `sharesTarget` compares device and inode), and resolves color in the
informal standards' precedence: `FORCE_COLOR` decides outright when set
(`0`/`false` off; empty, `1`, or `true` basic; `2` 256; `3` truecolor — Node's
reading), then `CLICOLOR_FORCE` forces color on even for a pipe at the depth
`COLORTERM`/`TERM` advertise, `NO_COLOR` (any non-empty value) and `CLICOLOR=0`
force it off, `TERM=dumb` renders none, and otherwise a terminal renders at its
advertised depth while a pipe renders none. `COLUMNS`/`LINES` override the
reported size whatever the stream is. The routed CLI derives its `tty` versus
piped-Markdown mode from this same value (`stdout.kind === 'tty'`), so the two
can never disagree.

Per surface, the value the generated request scope mounts:

| Surface | `hostSurface` | `stdout` / `stderr` | Source |
| --- | --- | --- | --- |
| Routed CLI executable (`dist/bin/<name>.js`, `<target>/bin/<name>.mjs`), plain or rendered command, projected MCP command | `cli` | Probed from the executable's own process; a rendered command's worker thread receives the executable's probe, never its own pipes. Machine output owns fd 1, so `stdout` describes where the rendered document lands and `stderr` the channel a route may write to itself. | `native` |
| Rendered script (`scripts/<name>.mjs` from `src/scripts/<name>.tsx`) | `script` | Probed, as above. | `native` |
| Generated MCP server (any transport) | `mcp` | `none` on both, `color: 'none'`, `sharesTarget: false` — stdout is the protocol wire and stderr the host's log. Never probed, whatever the descriptors are. | `derived` |
| Event route (shared runtime or standalone hook process) | `hook` | `none` on both — stdout is the host's hook envelope. Never probed. | `derived` |
| Workbench lifecycle replay | `workbench` | `none` on both — the document renders into a panel. | `derived` |
| `createRscMcpServer` (the `defineRscApplication` MCP adapter) | `mcp` | `none` on both, as above. | `derived` |
| `runRscCli` (the `defineRscApplication` CLI adapter) | `cli` when the caller passes `terminal` in its options | The adapter owns no probe — the generated routed-CLI shell does — so the caller's value is mounted `native`; omitted, the axis is `unavailable` (`not-provided`). | `native` / — |
| Custom host calling `runAgentRequest` without `terminal` | — | `unavailable` (`not-provided`) | — |

Plain `main`-exporting scripts and bins have no request scope, so the
executable envelope hands them the same probe directly as the second argument
of `main` (see [The executable envelope](#the-executable-envelope-bin--scripts)).

The `agent-bundle/test` harness never probes the test runner's own streams:
`invokeCli` and `runScript` mount a deterministic synthetic value shaped by
their `tty` knob (an 80×24 `basic`-color terminal on both streams with
`sharesTarget: true`, or two `color: 'none'` pipes), `renderRoute` mounts what
the artifact's scope for that route kind would (`none` for MCP and event
routes, the piped shape for `cli` and `script` kinds), the in-memory MCP level
forwards the real server's `none`, and a plain script's `main` receives the
real child process's probe (two pipes). A test that wants other values injects
`context.terminal` through the same seam as every identity axis.

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
import type { ExecutableMainContext } from 'agent-bundle';

export const main = async (argv: readonly string[], { terminal }: ExecutableMainContext): Promise<number> => {
  if (terminal.stderr.color !== 'none') { /* paint progress on stderr */ }
  return 0;
};
```

The envelope awaits `main(process.argv.slice(2), { terminal })`, adopts a
numeric return as the process exit code, and lets an escaped rejection surface
through Node's top-level failure path (stack to stderr, exit code 1).
`terminal` is the process's [terminal capability](#terminal-capability-requestterminal)
(#511), probed once before `main` runs by the dependency-free
`agent-bundle/terminal-capability` module the envelope aliases in — plain
scripts and bins load no Effect runtime and no `@agent-bundle/runtime` for it.
Its `hostSurface` is `cli` for a package bin (`dist/bin/<name>.js`) and
`script` for an artifact script (`scripts/<name>.mjs`); a module shipped on
both surfaces sees the surface it was launched from. A `main` declared with
one parameter keeps working — the second argument is simply unread.
Self-executing modules (no `main` export) bundle directly, byte for byte —
existing Scripts keep their behavior and receive no probe.

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
[Diagnostics](diagnostics.md#route-graph-state-layout-and-provider-conventions-ab4800ab4832-ab4940ab4942)), generates nested
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

When the module's `inputSchema` rejects the parsed argv, the shell reports
each issue in CLI terms rather than the raw schema issue JSON (#465): one
line per issue naming the argument as typed (`--max-files` for a named
option, `<root>` for a positional, `--input.<path>` for a projected MCP
command, `input` when no single argument is at fault), the expectation, and
the received value as canonical JSON, followed by the command's exact usage
line and the `--help` hint, all on stderr:

```text
Invalid value for --max-files: expected number <= 55000; received 300000.
Usage: curator doctor [options] <root>
Run 'curator doctor --help' for usage.
```

Under `--json` stdout stays empty and stderr carries exactly one canonical
line, `{"error":{"code":"CLI_INPUT_INVALID","issues":[{"expected":...,
"message":...,"received":...,"target":...}],"usage":"Usage: ..."}}`; under
`--ndjson` the stdout stream carries one `type: "error"` event with the same
`error` object (plus the joined `message`) at `sequence: 0`. The exit code
is 2 in every mode.

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

#### The routed CLI inside host artifacts

The package bin only reaches users who install the npm package. Hooks,
skills, and script routes ship with the **host artifact**, so the build also
emits the same compiled command graph into every selected target whose
adapter publishes the `cli` capability — all built-in targets (`claude`,
`codex`, `cursor`, `portable`, `plugin`), because the artifact root is
already a plain directory Node executes `mcp/` and `scripts/` files from:

```text
artifact/<target>/
  bin/<plugin-name>.mjs           # the routed CLI: node bin/<plugin-name>.mjs <command> [args]
  bin/<plugin-name>-flight.mjs    # react-server worker, present when any command renders
  scripts/<name>.mjs
  mcp/…
```

The artifact bin is a self-contained ESM module with no shebang or
executable bit — invoke it as `node <plugin-root>/bin/<plugin-name>.mjs
<args>`, exactly like `scripts/*.mjs`. Help, argv parsing, output modes,
exit codes, and signals are identical to the package bin. One deliberate
difference: workspace-durable state without a host-supplied
`AGENT_BUNDLE_PLUGIN_ROOT` anchors on the **artifact root** (the parent of
`bin/`, the same fallback the generated MCP worker beside it uses) rather
than `$PWD/.agent-bundle/state`, so a co-installed CLI and server observe
one store. The npm package bin keeps its `cwd` fallback.

Reaching the bin from the other surfaces:

- **Skills and hooks** use the plugin-root token
  (`agent-bundle:path:plugin-root`, or a host spelling such as
  `${CLAUDE_PLUGIN_ROOT}`), lowered per host exactly like MCP entries:
  `${CLAUDE_PLUGIN_ROOT}/bin/<plugin-name>.mjs` in Claude Skill Markdown and
  hook commands, `${PLUGIN_ROOT}/…` in Codex hooks, `${CURSOR_PLUGIN_ROOT}/…`
  in Cursor hooks. Only Claude documents Skill Markdown interpolation, so a
  skill that spells the token is a Claude-only skill (`AB3008` elsewhere);
  skills for other hosts describe the path relative to the plugin root
  instead.
- **Script routes** use the sibling convention: from the compiled
  `scripts/<name>.mjs`, the bin is `new URL('../bin/<plugin-name>.mjs',
  import.meta.url)`, so a plain `src/scripts/<name>.ts` can
  `spawn(process.execPath, [fileURLToPath(binUrl), ...argv])` and forward
  stdio. `import.meta.url` is rewritten to the artifact location by the
  bundle, never left pointing at `src/`.

`inspect` accounts for the bin as one `cli` component per target (selected,
or skipped with the host's `cli` capability judgment), `inspect --bundler`
dumps each target's `bin/` composition beside its scripts, and the artifact
manifest records both files with `bundle` provenance naming every command
route. Artifact validation admits the `bin/` layout only for adapters that
declare it (`cliBin`); because the compiler emits the CLI at exactly
`bin/<plugin-name>.mjs`, an adapter that publishes a supported `cli`
capability without that layout, or with a `cliBin` layout naming another
directory or omitting `.mjs`, is rejected at registration. A target without the
capability omits the bin and reports `AB4765`; a host-emitted file at the
same path (a Claude `claude.bin` directory shipping `<plugin-name>.mjs`) is
`AB4766`. The package build's `dist/bin/<plugin-name>.js` is unchanged.

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

Every rendered route — generated MCP tool, resource, or prompt, projected MCP
command, rendered `src/cli/**` command — runs inside one render session whose
wall clock defaults to `DEFAULT_AGENT_RENDER_LIMITS.maxElapsedMs` (60 s). A
route whose legitimate work runs longer declares `config.render:
{ maxElapsedMs }` (#454): a positive integer of milliseconds up to
`MAX_ROUTE_RENDER_ELAPSED_MS` (24 hours), `AB4835` otherwise. The value is read
statically with the rest of `config`; the generated MCP server passes it to
the dispatcher per call (`AgentRenderDispatch.limits`), the compiled command
carries it into the generated CLI executable (a projected command inherits
its tool's), and the route-unit and `mcp-in-memory` harnesses apply it over
the `limits` a test passes as the dispatcher's base. A plain `.ts` command
has no render session and rejects the key. The budget bounds only the
framework's session: the host's tool-call deadline still applies, so a long
route keeps reporting progress, which the projector forwards as
`notifications/progress` for the whole call.

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
the consumer module evaluates (installed by the shell's first import, its
stdio prelude — see below), the factory call, raw `process.stdout.write`
restored for protocol frames, `StdioServerTransport` construction and
connect, SIGINT → exit 130, SIGTERM → exit 143, stdin EOF → exit 0 (so the
client can respawn), transport-close → exit 0, a 5-second bounded shutdown
race against wedged transports, and heartbeat/activity logging on stderr
(5-minute interval, 60-second activity throttle, labeled with the server
name).

Self-connecting entries — modules that construct and connect a transport at
top level without a default export — keep today's behavior byte for byte: no
lifecycle shell and no operator `.env` layer (#469); an entry that wants the
layer calls `applyOperatorEnv` from `agent-bundle/launch-env` itself,
passing its own declared `env` block as `manifestEnv` if a passed-through
manifest default should yield to the file as it does in the generated shell.
That module is aliased into every stdio entry, shell or not, so the import is
inlined from this package rather than resolved through the plugin's own
`node_modules`, and a `tools` hatch can never externalize it.

Every served tool call is one ordinary `tools/call`: optional
`notifications/progress` while the caller's progress token is live, then one
final `CallToolResult`. The operation-based `createRscMcpServer` shell above
advertises no `tasks` capability and processes a task-augmented request as an
ordinary one, as the `2025-11-25` Tasks utility requires of a receiver without
the capability. Generated route servers (`src/mcp/<server>/tools/*.tsx`) serve
the utility for tool routes that declare `config.execution.taskSupport`: a
`tools/call` carrying `params.task` answers with a `CreateTaskResult`, the
Flight render continues behind the task, `tasks/get` reports status and the
last render progress, `tasks/result` blocks for the same `CallToolResult` the
ordinary call returns, `tasks/cancel` interrupts the render through its
`AbortSignal`, and `tasks/list` lists the session's tasks (see
[Long-running tools: tasks](https://scriptedalchemy.github.io/agent-bundle/guide/authoring/mcp#long-running-tools-tasks)
and [MCP conformance evidence](./mcp-conformance.md#task-augmented-requests-served-2026-09-04)).

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
involved. Outside Agent Bundle compilation the published module throws the
`AB4760` diagnostic rather than reporting a fabricated identity — a plugin
slug exists only in the config, and a runtime guess at it would silently
disagree with the artifact. A release build refuses a project with no release
version at all (`AB4013`), so a compiled artifact never carries the
development fallback.

Tests are not outside the compiler: `agentBundleRstest()` and
`agentBundleBrowserRstest()` (`agent-bundle/rstest`) alias the specifier to
`.agent-bundle/test/meta.mjs`, a module generated by the same
`generatedMetaModuleSource` the build injects, fed from the same compiler
pass's plugin identity. A source module importing `agent-bundle/meta` therefore
loads under any Rstest pool built from the preset — plain unit tests, the
route-unit level, `renderRoute`, and `invokeCli` alike — with the identity
`package.json` and `agent-bundle.config.ts` declare. A custom runner that
does not use the preset must add the same alias; the `AB4760` recovery text
spells it out (see [Diagnostics](diagnostics.md#build-time-identity-outside-the-compiler-ab4760)).

Rendered skills are not outside it either (#440): `src/skills/<name>/SKILL.tsx`
evaluates during discovery, before any bundle exists, and the skill loader
aliases the specifier to the same generated module fed from the identity
normalization is about to stamp into the model (`plugin.name`, the
`package.json` axes, the resolved version). A skill that prints `version`
prints the one its artifact manifest reports, under `validate`, `build`,
`inspect`, dev, the Workbench's source documents, and `inspectWorkbenchSurface`.

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
hatch customizes *how code compiles*, never *what the artifact promises*. The
framework's own profile keeps the same promise: `output.autoExternal` is
`false`, `bundle: true`, `splitChunks: false`, and no `externals` are added, so
Rslib's `node` target leaves only Node built-ins (and `pnpapi`) external, and
`AB6005` fails any bare specifier that is not a Node built-in in every compiled
module — host-pack modules and the package build's `dist` bundles alike — so
the hatch cannot externalize a dependency on the author's behalf. Run-time
path references are kept the same way: a `new URL(…, import.meta.url)` or
`new Worker(new URL(…))` in consumer or generated code names a file beside the
artifact, so the invariant layer turns the bundler's URL and worker asset
processing off after the hatch and the expression reaches the artifact
verbatim.

The hatch merges *beside* the framework profile, not over it: `plugins`
arrays concatenate, and Rsbuild's plugin manager appends every plugin it is
handed without deduping by name. So a `tools.rsbuild.plugins` entry that
re-adds a plugin the framework already registers — `@rsbuild/plugin-react`
(`rsbuild:react`), carried by every synthesized Rslib entry and every MCP
App view — would run it twice. `agent-bundle validate`
reports that as `AB4724` (an error, like the other `tools` shape checks) with
the plugin and package name; remove the entry, the framework already
registers it.

The hatch executes on one bundler engine. Artifact scripts, MCP entries,
hook wrappers, and the package build compile through Rslib; MCP App views
compile through `@rsbuild/core`; and agent-bundle pins `@rsbuild/core` inside
the range its `@rslib/core` accepts, so a consumer installs a single
`@rsbuild/core`, a single `@rspack/core`, and a single native Rspack binding
(a packed-consumer test holds that line). That engine is agent-bundle's
dependency, not the consumer's: a class imported from a separately installed
`@rspack/core` can have a different identity than the engine executing the
config. So a hatch must never construct plugins or run `instanceof` checks
against an imported `@rspack/core`. Use instead the utils argument
Rslib/Rsbuild pass to `tools.rspack` mutator functions —
`tools: { rspack: (config, { rspack }) => { ... } }` — which always hands the
engine's own `rspack` object.

### `agent-bundle inspect` component accounting

```sh
agent-bundle inspect [--target <t>] [--json]
```

Every inspection plan accounts for each host component the project declares
— skills, commands, rules, config-declared hooks, filesystem event routes,
LSP servers, MCP servers, MCP Apps, and scripts — as either `selected`
(emitted for that target) or `skipped` (omitted), in one deterministic order.
Each component carries its canonical `kind` (`AgentComponentKind`); event
routes report as `event-route`, judged by the host's row for their canonical
event (`event:session/start`, …), separately from `hook`, and Claude-declared
`claude.lspServers` entries report as `lsp` against every target's `lsp` row.
A skipped component names its cause: `excluded-by-targets`
when the author's `targets` left the host out, or `unsupported-capability` when
the host's pinned capability table does not support the surface. Components
that need a host capability carry that target's own four-state judgment as
`capability` — `{ name, state: 'supported', evidence }` for emitted surfaces,
or `{ name, state: 'degraded' | 'unavailable' | 'prohibited', reason }` — so
the JSON explains why a Cursor rule is absent from a Claude bundle in the
host's words rather than the compiler's. An adapter that publishes no row for
a needed capability reads as an honest `unavailable`, never a silent pass.
Scripts need no host capability and carry none. A selected component that
uses a feature the target cannot express (a command frontmatter field on
Cursor, for example) carries `omittedFeatures`: one entry per omitted feature
with the host's `<kind>.<feature>` row, matching the `AB4908` / `AB4928`
warnings `validate` reports (see
[Component feature sets](framework-mode.md#component-feature-sets)). Every
plan also carries `kinds`: one entry per canonical kind, in kind order, with the target's own
row for that kind (`capability`) and the counts of selected and skipped
components of it — so a host with no `lsp`, `native-diagnostics`,
`native-extension`, or `agent` surface says so in its own words even when the
project declares none of them (`script` and `event-route` carry no kind-level
row; event routes are judged per component). The human output prints one line
per target (`<target>: N component(s) selected, M omitted`) followed by each
omission and its reason, then `kinds this host cannot emit:` listing every
kind whose row is not `supported`. The full matrix is in
[Host components](framework-mode.md#host-components).

### `agent-bundle inspect --bundler`

```sh
agent-bundle inspect --bundler [--target <t>] [--json]
```

Dumps the synthesized bundler configuration for every output the build
composes — artifact scripts, MCP entries, hook wrappers, the per-target MCP
Apps Rsbuild config, and the `dist/` package build — exactly as the build
lowers it: in production mode whatever `NODE_ENV` says, the framework profile
with the consumer `tools` hatch merged over it and the invariant hook appended
last (functions render as `[function <name>]`). Entries the framework wraps also carry the generated
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

Installed packs get the same layer and the same order without `mcp run`
(#469): every artifact shell that runs plugin code — the stdio MCP entry of a
factory-exporting server (a self-connecting entry has no shell), the hook
wrappers that execute handlers or render standalone, and the artifact CLI
`bin/<name>.mjs` — applies `agent-bundle/launch-env` (`src/launch-env.ts`,
plain Node, inlined into the bundle) at startup. It reads `<plugin
root>/.env` then `.env.local`, where the plugin root is the expanded
`AGENT_BUNDLE_PLUGIN_ROOT` or the shell's parent directory, or the files
`AGENT_BUNDLE_ENV_FILE` names (platform-delimited list; `none` disables the
layer); it fills only variables the host did not set, never logs a value,
treats a missing file as the normal case and an unreadable one as skipped.
The dotenv grammar has no `${VAR}` interpolation. Under `mcp run` the plugin
root is the project root, so the shell's pass is a no-op; `--env-file` and
`--no-env` are handed down as `AGENT_BUNDLE_ENV_FILE` so the shell follows the
operator's choice. The npm package bin reads no pack file. Doctor reports the
presence and variable count of each file (`AB7331`).

Two details keep the installed order equal to the `mcp run` table above:

- **Manifest env stays lowest.** A host merges the server's manifest `env`
  block into the child environment before launch, so the child cannot tell a
  manifest default from a host export by looking at `process.env`. The stdio
  entry's layer module therefore embeds the server's declared `env` block
  (normalized, path tokens unexpanded) as `manifestEnv`, and
  `applyOperatorEnv` reserves a present variable only when its value differs
  from that default: a passed-through default yields to the file, a host or
  operator export is kept. The accepted ambiguity: an operator export equal to
  the manifest default reads as the default and yields too. A default carrying
  a path token never equals its host-expanded value and is always kept — this
  covers the injected `AGENT_BUNDLE_PLUGIN_ROOT`. Hook wrappers and the CLI
  bin have no manifest env and embed none. The host manifests are unchanged;
  hosts still show `env` in their UIs.
- **The layer precedes every consumer module.** Rspack inlines the modules of
  a single-chunk bundle into one scope, evaluates all of them before the
  entry module's own body, and places a dynamic import's target ahead of the
  static ones — so neither a statement in the shell body nor an awaited
  `import()` after it runs before a consumer module's top level. The layer is
  instead a generated virtual module that each shell imports first, and the
  server module, hook handler, routes, providers, and state definition are
  static imports after it; ESM import order is what the bundler preserves.
  Hook wrappers and the CLI bin import the env-only layer
  (`agent-bundle/launch-env-layer`, `src/build/launch-env-shell.ts`); they
  legitimately write stdout. The stdio MCP shell imports its prelude instead
  (`agent-bundle/stdio-prelude`, `src/build/entry-shell.ts`), which calls
  `redirectConsoleToStderr` from `agent-bundle/mcp-entry` and then applies
  the layer — stdout is the protocol wire there, and the same ordering
  argument means only an earlier import can put the guard ahead of a
  `console.log` or `process.stdout.write` at the server module's top level.
  The guard has one implementation: while a guard is installed,
  `redirectConsoleToStderr` returns it instead of stacking a second, whatever
  `process.stdout.write` has become since, so `runGeneratedStdioMcpEntry`
  adopts the prelude's guard and restores the real stdout from it before
  serving; a wrapper a consumer module installed over `process.stdout.write`
  at module scope wrapped the redirect, not the protocol stream, and is
  discarded at that point with one stderr line saying so (stdout is the
  protocol channel; wrapping it is unsupported). Restoring clears the
  installed guard, so a later call installs anew.
  A consumer `package.json` declaring `"sideEffects": false` would let the
  bundler drop either bare import, so the build marks generated modules
  side-effectful (`src/build/rslib.ts`). Module-level `process.env` reads in
  plugin code see the composed environment, and module-level stdout writes in
  a server module land on stderr.

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

## `agent-bundle serve-app`

```sh
agent-bundle serve-app <server>/<app> [--artifact <path>] [--target <target>]
  [--tool <name>] [--input <json> | --input-file <path>] [--port <port>]
  [--profile <profile>] [--allow <capability>]... [--open]
  [--env-file <path>]... [--no-env] [--plugin-root <path>]
```

Serves one built MCP App standalone in a browser, outside any MCP host and
without the Workbench. The command launches the App's packed MCP server
through exactly the `mcp run` launcher above (same manifest resolution, same
three-layer environment, same durable-state anchors), binds the App to that
one session through the Workbench's own MCP App host stack
(`McpAppBindingService` → `McpAppPreviewService` → `McpAppRoutes`, the
loopback sandbox proxy, the consent authority, `McpAppBridge`), calls the
App's tool once so it opens populated, and prints the loopback URL. It runs
in the foreground until SIGINT/SIGTERM, or until the server exits on its own,
which is reported as one `AB5000` diagnostic with exit code 1. Without
`--artifact`, a throwaway artifact is built into a staging directory beside
the project root and removed when the host closes.

The host document is served on `127.0.0.1` only, at `/`, with the
authenticated `/api/mcp/...` routes behind a per-launch token plus
same-origin and loopback `Host` checks (`AB8003` / `AB8004` on refusal); the
App document runs on a second loopback origin inside the framework sandbox,
and the bridge exposes only the selected server. This is a local preview
host, not a deployment target.

`serveApp` in `agent-bundle/api` is the programmatic form (`{ url, close,
closed }`). It is a host-process API: it belongs to processes the framework
does not compile — the first-party CLI, the Workbench, tests, a plugin's own
`package.json` scripts or a hand-written `.mjs` run from the checkout — and
never to the MCP server shell. A routed CLI command inside the artifact
cannot import it: routed CLI bins are self-contained (#387), so the bundler
would inline `agent-bundle/dist/api.js` into the bin and fail on the
framework's runtime-relative module references (`Module not found: Can't
resolve '../events'`). The route graph reports such an import first, as
`AB4837` naming the module and the specifier
(`src/routes/framework-imports.ts`; the compiler-carrying entries are
`agent-bundle`, `agent-bundle/api`, `agent-bundle/config`,
`agent-bundle/eval`, `agent-bundle/rstest`, `agent-bundle/test`, and
`agent-bundle/test/browser`, matched exactly; `import type` and type-only
usage are not reported), while an external bare import (`AB6005 uses
unsupported specifier`) or a non-literal `import(spec)` (`AB6005 has a
non-literal dynamic import`) still fails artifact validation. The sanctioned
shape is `spawnServeApp` from `agent-bundle/serve-app-command`
(`src/serve-app-command.ts`, #558) — plain Node with no dependencies, so the
bundler inlines it into the self-contained executable the way it inlines
`agent-bundle/launch-env`. It lowers the `serveApp` options to `serve-app`
argv (`serveAppArgv`; every `ServeAppOptions` key except the host-process-only
`logger`, `registry`, `openBrowser`, `targets`, and `timeoutMs`), resolves the
framework CLI from the `agent-bundle` package installed at or above `root`
(`locateFrameworkCli`, through `src/core/dependency-manifest.ts`), spawns it
with the child's stdout piped and its stderr inherited, relays every stdout
line to stderr so the routed CLI keeps stdout for its result, resolves once
the child prints the ready line `MCP App <app> at <url> (tool <tool>; Ctrl-C
stops the server)` — the CLI writes it and the helper parses it through one
module, `src/serve-app/command-contract.ts` — and turns the route `signal`
into the child's `SIGTERM`. The result is `{ app, url, tool, server, port,
pid, closed, close() }`; failures are `ServeAppCommandError` with `code`
`framework-not-installed`, `artifact-missing`, `spawn-failed`,
`exited-before-ready` (carrying the child's `exit`), `aborted`, or
`stop-failed` (the running child refused the signal `close()` or the abort
sent; it is still running). It is a
checkout command: an installed host pack has neither `node_modules/agent-bundle`
nor the artifact, and the first two codes say so before anything is spawned.
The worked example is in the MCP Apps guide, "Serving an App standalone".
