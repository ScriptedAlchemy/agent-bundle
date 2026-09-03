# `@agent-bundle/runtime`

Agent Document contracts and React-owned Flight execution for Agent Bundle routes.
No npm release is cut yet; install the pkg.pr.new preview of any `main` commit or pull
request — see [Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md).

The runtime executes route models through React-owned RSC/Flight behind the
`AgentRenderDispatcher` execution-host seam. Incremental Flight decoding
commits immutable `AgentDocument` snapshots as Suspense boundaries resolve
and emits the `shell | progress | replace | error | complete` render-event
stream from `dispatcher.stream()`. `dispatcher.dispatch()` stays the default
public behavior: it drains that stream and returns only the canonical final
document. The request `AbortSignal` aborts pending boundaries and closes the
stream; a post-completion producer is rejected with a typed
`handoff-required` outcome. Depth, node count, bytes, event rate, and
elapsed time are bounded on the reconciler.

Generated MCP tool calls project the live render-event stream through
`projectMcpRenderStream`: `notifications/progress` is emitted only when the
caller supplied a progress token, shell/replace stay internal, and the
request resolves to one final `CallToolResult`. Image, audio, and resource
blocks are capability-gated — unsupported rich content uses a declared
fallback or a typed `McpProjectionError`, never a silent drop. The existing
`lowerMcpResult` / `lowerHookResult` helpers remain synchronous compatibility
APIs for the operations-model path.

Task-augmented tool calls (`CreateTaskResult`, `tasks/get`, `tasks/result`,
`tasks/cancel`) are deferred, not partially implemented. The generated servers
never advertise a `tasks` capability, and a request that carries task
augmentation is processed as an ordinary `tools/call` — the fallback the
2025-11-25 Tasks utility requires of a receiver that declared no task support.
The deferral, its SDK pin, and the exact unblock condition are recorded in
[MCP conformance evidence](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/mcp-conformance.md#task-augmented-requests-deferred-2026-09-02)
and enforced by `tests/mcp-tasks-deferral.test.ts`, which fails the day the
installed SDK grows a task runtime.

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
APIs, the Agent Document contracts, `createAgentRenderDispatcher`,
`projectMcpRenderStream`, `createWarmFlightHost`, `decodeAgentFlightStream`,
and the `@agent-bundle/runtime/flight/server` render entry. The Flight-facing versions
are exact compatibility pins: React/React DOM `19.2.8` and
`react-server-dom-rspack` `0.1.0`; the proof example compiles them with
`rsbuild-plugin-rsc` `0.1.1`. The package does not own application state,
persistence, a concrete execution host, or host packaging. Node 22.19 or newer
is required.

Async server utilities and Server Components read the framework request store
with `const context = await agent()`. The store is a versioned realm singleton
installed at MCP and CLI entrypoints (and at any other real invocation via
`runAgentRequest`). Identities are `Observed<T>` — unavailable host, session,
actor, or workspace is a typed reason, never a fabricated string. The context
handle throws after the request completes. Workspace identity is deliberately
scalar: when a native envelope provides multiple `workspace_roots` and no
`cwd`, the first root is the primary workspace exposed by `agent()`; later
roots remain available only in the native event payload. `state`, `notices`,
and `providers` are reserved extension slots; provider discovery and
`useAgent()` arrive later.

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
`CallToolResult`; the `runRscCli` compatibility path never renders JSX and
instead prints the validated result as one line of JSON. Operation modules
are `.tsx` only because `render` returns JSX. (Routed `src/cli/**` commands
are the framework-mode CLI: there, `.tsx` routes do render — through the
Agent renderer's dispatcher with TTY/Markdown/`--json`/`--ndjson` output
modes — while plain `.ts` routes keep the one-JSON-line contract.) The
end-to-end walkthrough lives in
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

## Notices (optional)

`@agent-bundle/runtime/notices` is the narrow recipient-scoped notice core.
It stores detached, finite `AgentDocumentSnapshot` content in one ordinary
state-kernel definition; host wiring opens that definition with the
workspace-durable SQLite driver and passes the resulting ledger as
`runAgentRequest({ noticeLedger })`. Stateless projects import neither
subpath and ship no state or notice implementation.

Inside an authorized request, `(await agent()).notices` is a request-bound
handle with `publish()`, `read()`, `inbox()`, and `acknowledge()`. Recipients
use only observed host/session/actor/workspace axes. Publish authorization
runs before persistence, and delivery authorization runs again when a
matching event is admitted. `read()` exposes notices selected for that event
while the ledger records a receipt containing the invocation id and state
`attempted`. `acknowledge()` is recipient-matched and authorization-gated and
produces the terminal `acknowledged` state — the strongest evidenced outcome.

`publish()` accepts optional `retryBudget` (default one attempt) and
`nextAttemptAt`; both are evaluated only when a matching event is admitted —
no timer or retry worker is implied, and a retriable notice past `expiresAt`
expires instead of retaining unused attempts. Wire-level
`notifications/resources/updated` signals are recorded through the ledger's
`signalAvailability()` as availability receipts, and MCP inbox reads record
exposure receipts; neither is a delivery claim.

States are `pending | attempted | expired | unavailable | withdrawn |
acknowledged`. The ledger still does not claim `delivered` or `read` as
states: observing the recipient process is not evidence the agent saw the
content, and the `available`/`read` taxonomy rows from #99 map onto the
availability and exposure receipts. `selectNoticeDeliveryRoutes()` chooses
cross-request routes from a per-host advertisement and returns a typed
unavailable outcome when none is supported; it never fabricates a channel.

## License

Apache License 2.0. The published tarball carries the repository
[LICENSE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/LICENSE) and
[NOTICE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/NOTICE).
