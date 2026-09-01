# `@agent-bundle/runtime`

Small React primitives for producing Agent Bundle hook and MCP protocol results with JSX.
No npm release is cut yet; install the pkg.pr.new preview of any `main` commit or pull
request — see [Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md).

The runtime package does **not yet execute React Server Components or
Flight**. Its current lowerers form a synchronous React-element protocol DSL —
an *MCP result DSL*: `lowerMcpResult` walks an
element tree, calling your function components as it goes, and lowers it
into a plain MCP `CallToolResult`. `lowerHookResult` lowers a `Hook.Result`
tree into a native `PostToolUse` output the same way, except that it
resolves only the `Hook` elements themselves — a hook tree returned from
your own component is rejected. Nothing streams components, hydrates, or
holds server component state.

```tsx
import { Mcp, lowerMcpResult } from '@agent-bundle/runtime';

const result = lowerMcpResult(
  <Mcp.Result structuredContent={{ status: 'ready' }}>
    <Mcp.Text>Ready.</Mcp.Text>
  </Mcp.Result>,
);
```

The package also exports the protocol-oriented `Agent.*` vocabulary and the
versioned `AgentDocument`/`AgentRenderEvent` contracts. `createAgentDocument`
detaches and freezes a v1 document, enforcing finite depth, node-count, and
byte limits. `createAgentRenderEventSequence` assigns monotonic sequence
numbers to `shell | progress | replace | error | complete`, applies event
bounds, and rejects post-completion writes with a typed `handoff-required`
error. These contracts land beside the existing `Hook`/`Mcp` lowerers; those
synchronous compatibility APIs remain operative.

The package exports `Hook`, `Mcp`, `Agent`, both lowerers, the request-store
APIs, and the Agent Document contracts. It does not yet own application state,
transport, persistence, or host packaging. React 19 is a peer dependency and
Node 22.19 or newer is required.

Async server utilities and Server Components read the framework request store
with `const context = await agent()`. The store is a versioned realm singleton
installed at MCP and CLI entrypoints (and at any other real invocation via
`runAgentRequest`). Identities are `Observed<T>` — unavailable host, session,
actor, or workspace is a typed reason, never a fabricated string. The context
handle throws after the request completes. `state`, `notices`, and `providers`
are reserved extension slots; provider discovery and `useAgent()` arrive later.

Structured MCP metadata and content are copied through a strict finite-JSON
boundary before being returned, so later caller mutations do not alter a result.
The copy follows MCP SDK wire semantics for `undefined`: object properties whose
value is `undefined` are dropped and `undefined` array elements lower to `null`,
exactly as `JSON.stringify` serializes them. Values that cannot round-trip as
JSON — cycles, accessors, sparse arrays, non-finite numbers, non-plain objects —
are still rejected, and the error names the offending key path.

## Applications

Structure — targets, skills, scripts, MCP servers, MCP apps — lives in
`agent-bundle.config.ts` and file conventions; JSX renders. That split is the
whole authoring model, described on one screen in
[Framework mode](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/framework-mode.md).
The `@agent-bundle/runtime/plugin` entry defines the application's runtime
identity and typed operation catalog once and derives its CLI commands and
MCP tool registrations from that one registry:

```tsx
import { defineOperation, defineRscApplication } from '@agent-bundle/runtime/plugin';
import { Mcp } from '@agent-bundle/runtime';
import { z } from 'zod';

const inputSchema = z.object({}).strict();
const resultSchema = z.object({ status: z.literal('ready') }).strict();

const status = defineOperation({
  cli: {
    name: 'status',
    parse: () => ({}),
    summary: 'Read status.',
    usage: 'status',
  },
  execute: async () => ({ status: 'ready' as const }),
  id: 'status',
  inputSchema,
  mcp: {
    _meta: { ui: { resourceUri: 'ui://example/status.html' } },
    description: 'Read status.',
    name: 'runtime_status',
    readOnly: true,
    server: 'runtime',
    title: 'Runtime status',
  },
  render: (result) => (
    <Mcp.Result structuredContent={result}>
      <Mcp.Text>Ready.</Mcp.Text>
    </Mcp.Result>
  ),
  resultSchema,
});

export const application = defineRscApplication({
  name: 'example',
  operations: [status],
  version: '1.0.0',
});
```

An operation is a host-neutral use-case definition, not a CLI command: the
shared core (`id`, `inputSchema`, `execute`, `resultSchema`) is what both
projections run — `inputSchema.parse` → `execute` → `resultSchema.parse` —
while `cli` and `mcp` are optional per-surface declarations. `render` is
required on every operation but consumed only by the MCP projection, where
`lowerMcpResult` synchronously lowers its element tree into the
`CallToolResult`; the CLI never renders JSX and instead prints the
validated result as one line of JSON. Operation modules are `.tsx` only
because `render` returns JSX. The end-to-end walkthrough lives in
[Framework mode](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/framework-mode.md).

Use `runRscCli(application, argv)` in the conventional `src/cli.ts` entry and
`createRscMcpServer(application, 'runtime')` in the conventional
`src/mcp/runtime.ts` entry. Operation inputs, implementations, output
validation, and result renderers cannot drift between the two surfaces, and
`defineRscApplication` rejects duplicate operation ids, CLI commands, and MCP
tools up front. The server name passed to `createRscMcpServer` selects the
operations whose `mcp.server` matches; the server's structural declaration
(entry, targets, apps) belongs to `agent-bundle.config.ts`.

The optional `mcp.title` and `mcp._meta` ride the tool listing verbatim —
`_meta: { ui: { resourceUri } }` is how MCP Apps hosts bind a tool to its
widget. `createRscMcpServer` registers exactly the annotation hints an
operation declares (`readOnly`, plus `destructive` / `idempotent` /
`openWorld` when present); absent hints stay absent on the wire, where they
keep their MCP-spec default semantics.

The widget behind that `resourceUri` is structure, so it is declared in
`agent-bundle.config.ts` under the owning server — `mcp.servers.<id>.apps.<name>`
with an `entry`, the matching `resourceUri`, and optional `template`, `targets`,
and `_meta`. Agent Bundle compiles each view into a self-contained HTML resource
and hands it to the server through `import apps from 'agent-bundle/mcp-apps'`.
`createRscMcpServer` registers tools only, so serving that resource remains an
explicit `registerResource` call on the server it returns.

This layer intentionally does not own transport persistence, and operations
never receive implicit storage: application state is an opt-in kernel behind
its own subpath, described next.

## State (optional)

`@agent-bundle/runtime/state` is the event-sourced Agent state kernel
([#98](https://github.com/ScriptedAlchemy/agent-bundle/issues/98)). Stateless
projects never import the subpath and ship none of it. Stateful applications
declare typed events and a pure reducer once, and every mutation flows through
`dispatch` with a caller-owned idempotency key:

```ts
import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

export const editTimeline = defineState({
  id: 'my-plugin/edit-timeline',
  lifetime: 'workspace-durable',
  schema: z.object({ edits: z.array(EditSchema) }).strict(),
  initial: { edits: [] },
  events: { editRecorded: EditSchema },
  reduce: (state, event) => ({ edits: [...state.edits, event.payload] }),
});
```

Every state declares one explicit lifetime — `request` (discarded with the
invocation), `process` (a warm runtime's heap; lost on restart by definition),
`workspace-durable` (survives restarts for one workspace), or `external` (an
application-provided authority). Nothing infers durability from the presence
of an MCP process: hosts restart, multiply, or omit it.

The kernel owns monotonic revisions, exact-revision snapshot reads,
idempotency-key replay (a committed key returns its committed result; the same
key with a different payload is a typed `idempotency-conflict`),
compare-and-swap via `expectedRevision`, deterministic resets, explicit
versioned migrations, and polling change cursors — subscriptions across
short-lived processes are polling, and the kernel promises nothing stronger.
Corruption fails closed with typed errors, and error messages never embed
state or payload contents.

Host wiring opens a store from a driver and installs a request-bound handle on
the reserved context slot, so routes read
`const { state } = await agent()` and call
`state.dispatch(event, payload, { idempotencyKey })`. The in-memory driver
(`createMemoryStateDriver`) serves the two volatile lifetimes and doubles as
the test stand-in; it is never durable. The workspace-durable driver ships on
`node:sqlite` behind `@agent-bundle/runtime/state/sqlite`. Any driver —
including external ones — must pass the exported conformance suite
(`stateDriverConformanceCases`); a disconnected adapter is not a completed
integration.
