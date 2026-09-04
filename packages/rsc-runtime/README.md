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
caller supplied a progress token — for `progress.report()` events and for
`Agent.Progress` nodes streamed in a shell/replace document (a `Suspense`
fallback), under one monotonic `progress` rule so neither source duplicates
the other — shell/replace content stays internal, and the request resolves to
one final `CallToolResult`. Image, audio, and resource
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
roots remain available only in the native event payload. Synchronous Server
Components and utilities that cannot `await` call `useAgent()` instead; it
returns the identical handle from the same store under the same lease rules:
a call with no request in its async context — before a request, or after
`runAgentRequest` has settled — throws `outside-invocation`, while a handle
captured inside the request throws `request-closed` once it completes. `providers`
carries the values contributed by conventional `src/providers/*` modules, which
the `agent-bundle` compiler discovers, executes in order, and types per project;
`state` and `notices` remain reserved extension slots.

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
handle with `publish()`, `read()`, `inbox()`, and `acknowledge()`. A
recipient is the conjunction of the observed axes it names — `actor`, `host`,
`session`, `workspace`, plus the two lineage axes read from the admitting
request's `lineage`: `conversation` (exactly one agent thread,
`request.lineage.conversation`) and `root` (the root conversation and every
subagent under it, `request.lineage.root`). Every named axis must match, and
an axis the request cannot observe — including lineage the runtime could not
resolve — matches nothing, so a `conversation`-addressed notice is never
admitted on a sibling's event even though Claude and Codex give every
subagent the root `session_id`. Admissions journal the principal's lineage as
just `{ conversation, root }`; both recipient fields and that scope are
additive optional schema fields (no definition version bump), and an
admission journaled before them matches exactly what it matched then. Publish
authorization runs before persistence, and delivery authorization runs again
when a matching event is admitted. `read()` exposes notices selected for that event
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

`createNoticeInboxSignaller({ store })` is the `mcp-resource-updated` route
itself: one long-lived MCP connection's subscription to the reserved inbox
resource (`AGENT_NOTICE_INBOX_URI`). The generated server process opens its
own handle on the workspace-durable store its Flight worker mounts
(`createGeneratedNoticeRuntime` from `@agent-bundle/runtime/mount`), and
after every completed render `observe(send)` — detached from that render's
response, so a slow subscriber's wire never delays a tool result — reads the ledger, reserves the
budget slot of the subscriber's newly eligible pending notices as one
compare-and-swap against the revision it read (`reserveAvailability()` with
`expectedRevision`), sends at most one `notifications/resources/updated`, and
then finalizes the reservation into the availability receipt
(`signalAvailability()`) — or releases it (`releaseAvailability()`) when the
protocol write failed, so the receipt only ever means the write succeeded and
a failed send costs no budget. Eligibility is recipient-matched against the
subscriber's observed identity, respects `nextAttemptAt`, skips notices whose
slot another signaller currently holds (a hold older than
`AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS` counts as abandoned; a live
holder renews it under its key while its write is pending, and the reducer
refuses a renewal once another key has legitimately taken over — or once the
takeover's receipt has spent the budget and cleared the hold), and is
bounded by `retryBudget` (availability receipts per notice, durable across
restarts); because the slot is held before the wire write, two server processes
over one store can never both signal the same notice; a receipt presented by a
key that lost its hold is refused (`reservation-lost`) rather than counted, so
a stale send and a takeover send can never push a budget-one notice to two.
Ownership, not state, decides whether a receipt lands: a notice acknowledged,
expired, or withdrawn while its send was in flight still keeps the hold, so the
receipt for the send that happened is recorded on it without moving its state,
and a key that never held the slot is refused on a terminal notice too. These
reducer semantics are schema version 2 of the notice ledger
(`AGENT_NOTICE_STATE_VERSION`); a workspace-durable store journaled under
version 1 is migrated from its materialized head on first open rather than
replayed by a reducer that would disagree with it. A
send that reached the wire but whose receipt commit failed stays owed: the same
idempotent receipt is retried on the renewal cadence (renewing its hold as it
goes), before any later observation spends, and on `close()`, so a live process
cannot lose a send the wire already carried; only a process that dies while the
ledger is refusing writes leaves an unrecorded send, and its hold then lapses
after the TTL. A renewal still awaiting the ledger when a send settles is
awaited before the hold is released or finalized, so no orphan hold is
re-created behind a release. Shutdown never waits on the wire, nor on a ledger
call that has not answered: `close()` abandons a `resources/updated` write or
ledger call still pending (its outcome is unknown, so nothing is inferred from
it — no receipt, no release — and its hold lapses after the TTL), then gives
owed receipts and the store close one chance bounded by `closeTimeoutMs`
(default 5 s), so neither a subscriber that stopped reading nor a store that
stopped answering can wedge server teardown. The generated
server coalesces observations — one in flight, at most one owed — because every
observation reads the whole ledger, so renders completing behind a pending
write never queue per-render work. Exposure and availability
receipts never re-trigger a signal, so a subscribed client cannot be driven into
a refetch loop. Subscribing fails closed when the store is unreadable,
`unsubscribe()` resolves only after in-flight observations settle, and only the
workspace-durable lifetime is wired — volatile stores live in the worker's
heap, so those servers honestly advertise no `resources.subscribe`.

States are `pending | attempted | expired | unavailable | withdrawn |
acknowledged`. The ledger still does not claim `delivered` or `read` as
states: observing the recipient process is not evidence the agent saw the
content, and the `available`/`read` taxonomy rows from #99 map onto the
availability and exposure receipts. `selectNoticeDeliveryRoutes()` chooses
cross-request routes from a per-host advertisement and returns a typed
unavailable outcome when none is supported; it never fabricates a channel.

### Redaction (#99 acceptance item 7)

A notice's free text lives only in its detached `AgentDocumentSnapshot` —
`text`, `markdown`, `context`, `progress.message`, `error.message`,
`resource.name`/`uri`, and every string inside `json.value`, `result.metadata`,
and the document `value`. Recipient, priority, dedupe key, timestamps, and
receipts are identity and evidence, never prose; hosts receive them unredacted
and they must not carry secrets. The store keeps content exactly as authored;
redaction happens on egress, per route.

`publish()` accepts `sensitivity: 'public' | 'internal' | 'secret'` (default
`internal`, persisted explicitly on new notices; notices journaled before the
contract have no class and are `internal`):

- `public` — safe for any surface; delivered as authored.
- `internal` — for the recipient's own context; every route passes it through
  `redactSecretText()` first, so a credential pasted into a coordination
  message never crosses into another actor's context.
- `secret` — delivered as authored, but only over a route whose host row
  admits `secret`; otherwise it never leaves the store through that route.

Each route has a structural shape (`AGENT_NOTICE_ROUTE_SHAPES`): `mcp-inbox`,
`next-event`, `current-response`, and `directed-push` carry the document
(`body`); `host-toast` carries one bounded line (`title`, `noticeTitle()`);
`mcp-resource-updated` carries only the inbox URI (`signal`). A supported route
in an `AgentNoticeDeliveryAdvertisement` may name `sensitivity`, the most
sensitive class it carries in full, with dated `sensitivityEvidence`; an
absent ceiling means `internal`, the pre-sensitivity contract, so `secret`
notices are withheld everywhere until a host row says otherwise.
`resolveNoticeDisclosure(route, sensitivity, advertisement)` is the whole
decision: `withheld` (`route-unavailable` or `sensitivity-exceeds-route`) or
`disclosed` with `shape` and `redacted`; a row naming a ceiling outside the
vocabulary admits nothing. `createAgentNoticeLedger(store, { delivery })` and
`createNoticeInboxSignaller({ delivery })` take the host's advertisement and
validate it at construction (`validateNoticeDeliveryAdvertisement`, typed
`invalid-input`): `inbox()` omits withheld notices and hands out disclosed content
(the inbox resource projection reports `sensitivity` and
`disclosure.redacted`), event admission neither authorizes nor attempts a
withheld notice, `read()` deliveries carry `disclosure` and the disclosed
`content`, `acknowledge()` returns the notice only as the acknowledging
request's route may disclose it (an admitted event is held to `next-event`,
every other invocation to the inbox ceiling; a withheld class comes back as
the `[REDACTED]` mark, so an id learned from a redacted inbox unlocks nothing),
and the signaller never sends `resources/updated` for a notice the inbox would
withhold, recording that refusal itself through
`recordWithholding()` once per subscription. Admission stays one commit per
invocation: a retry of the same invocation id whose recomputed decision differs
(a notice published or a ceiling changed in between) replays the committed
admission instead of failing `idempotency-conflict`. Every refusal is durable evidence,
not a state change: the notice records
`withheld[route] = { count, firstAt, lastAt, reason }` and stays eligible for
a route whose row admits it. The built-in hosts admit
`secret` on `current-response` and `next-event` (the hook response returns to
the recipient's own host process) and `internal` on `mcp-inbox` and
`mcp-resource-updated` (transport-derived identity the host does not
authenticate to the plugin); `portable` has only the MCP routes.

The secret pass (`redactSecretText()`, `redactNoticeDocument()`,
`containsSecretText()`) is not written here. Which fields are prose, which
class each route may carry, and what a refusal records are this package's
policy; recognizing a credential is delegated to
[`flare-redact`](https://www.npmjs.com/package/flare-redact), a runtime
dependency pinned to an exact version (a range would let a publish change
what `internal` notices disclose without a changeset; a test keeps the pin
exact). The ledger runs it with its default detectors and default
credential-shaped member names, every finding replaced whole by `[REDACTED]`
(the library's own masks keep a hint such as `AKIA***`; a notice crossing into
another actor's context keeps nothing). Coverage: provider tokens (OpenAI,
Anthropic, AWS, GitHub, GitLab, Slack, Stripe, Google, npm, and the other
default detectors), JWTs, PEM private keys, `Bearer` / `Basic` headers,
`user:password@` URL credentials, `key=value` / `key: value` credential
assignments in any language (the whole assignment is masked, key included),
e-mail addresses (a recipient's identity is never surfaced through another
actor's notice), card numbers, and IBANs; a string held directly under a
credential-shaped member name (`password`, `token`, `apiKey`,
`authorization`, …) is masked whole regardless of content, and member names
themselves are scanned like any other string. Not redacted: paths (coordination
notices legitimately name files), numbers, base64 image and audio payloads,
and vocabulary fields (`kind`, `status`, `code`, `mimeType`). Two detector
limits at the pinned version are part of the contract, not patched here: the
assignment detector needs a value of at least four characters (`password=abc`
in free text is not a finding; the same value as `{ "password": "abc" }` is
masked by member name), and the OpenAI detector caps at 64 key characters, so
a project-scoped `sk-proj-…` key of production length (~160) is not
recognized. Authors pasting either should publish as `secret`; both are
reportable upstream fixes. A redacted document that has grown past the
Agent Document byte bound (the mark is longer than the shortest values it
replaces) is handed out as the one-line `[REDACTED]` placeholder instead
(`noticeRedactionPlaceholder(snapshot)`, the same document a withholding
route hands out, keeping the original `status` and `version`), so the bound
made at publish holds on egress. The compiler keeps its
own, older credential pass for probe and log text
(`packages/agent-bundle/src/core/credentials.ts`); the two are not held in
parity, and no vendored-code notice is involved — `flare-redact` is an
ordinary npm dependency under its own MIT license.

Libraries evaluated for the pass (September 2026), against: MIT/Apache
license, pure JS with no native dependencies and no Node-only globals (the
Workbench renders notice content in a browser bundle), a stable API with
recent releases, structured-field redaction, and a pattern pass for common
credentials:

| Package | License | Unpacked size | Last release | Module / runtime | Coverage | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `flare-redact` 1.6.1 | MIT | 949 kB (root entry a fraction; zero dependencies) | 2026-08 | ESM, Node ≥ 20, browser and edge safe | Deep object walk with sensitive-member-name masking plus 51 default text detectors (provider tokens, JWT, PEM, Bearer/Basic, URL credentials, generic assignments with a multilingual key vocabulary, e-mail, cards, IBAN); opt-in PII and high-entropy detectors left off | **Chosen**: the only candidate covering both halves in one dependency without Node-only code; young (first release 2026-07), hence the exact pin |
| `fast-redact` 3.5.0 | MIT | 93 kB | 2024-03 | CJS, zero dependencies; compiles redactors with `Function()`, so it needs `unsafe-eval` under a browser CSP | Field-path redaction of known keys only, no pattern detection, no arbitrary-depth wildcards | Not chosen: covers structured fields but has no credential pass, and notice free text needs one |
| `@sanity-labs/secret-scan` 1.1.0 | MIT | 1.1 MB | 2026-09 | ESM + CJS, zero dependencies, browser safe | 1,100+ TruffleHog-derived provider-token rules, JWT, connection strings; no generic `password=` assignments, no key-name masking, no e-mail | Not chosen: strong provider coverage but no structured-field or assignment redaction |
| `redact-pii` 3.4.0 | MIT | 462 kB | 2022-07 | CJS; depends on `lodash` and `@google-cloud/dlp` (gRPC, Node only) | PII (names, addresses, cards, phones, e-mail) with optional Google DLP | Not chosen: Node-only heavy dependency, no releases since 2022, PII rather than credentials |
| `@redact-pii/core`, `secret-scan`, `gitleaks-regexes` | — | — | — | — | — | Do not exist on npm |
| `detect-secrets` 1.0.6 | Apache-2.0 | 37 kB | 2025-10 | CJS, CLI oriented (`which`, `debug`) | Yelp-style detectors for CI and pre-commit scanning, reports rather than redacts | Not chosen: a scanner for files, not a redaction primitive |
| `secretlint` / `@secretlint/secretlint-rule-preset-recommend` 13.0.5 | MIT | 56 kB + 633 kB | 2026-08 | ESM, Node ≥ 22 | gitleaks-class rule presets through an async linting engine | Not chosen: async file-linting API and a large dependency graph for a synchronous egress pass |
| `@zapier/secret-scrubber` 1.1.6 | ISC | 22 kB | 2026-07 | CJS; uses `node:url`, `Buffer`, `process.env`, `create-hash` | Scrubs values you already know are secret from objects | Not chosen: value-driven (needs the secrets up front), Node-only, ISC |
| `is-secret` 1.2.1 | MIT | 4 kB | 2022-06 | CJS | Nine key-name regexes and one card-number regex | Not chosen: a key classifier, not a redactor |
| `scrubtext` 0.1.1 | MIT | 90 kB | 2026-06 | ESM + CJS, zero dependencies | Text-only secrets and PII, no assignment or key-name pass | Not chosen: pre-1.0, two releases, no structured input |

### Retention (#99 acceptance item 7)

Terminal notices — `expired`, `unavailable`, `withdrawn`, `acknowledged`, and
`attempted` with an exhausted retry budget (`noticeSettledAt()`) — no longer
stay in the ledger forever. `createAgentNoticeLedger(store, { retention })`
takes an `AgentNoticeRetentionPolicy` (`resolveNoticeRetentionPolicy()`
validates it; defaults are `AGENT_NOTICE_DEFAULT_RETENTION`: `terminalTtlMs`
seven days, `maxTerminal` 500, `maxJournalBytes` 16 MiB). Generated runtimes
resolve it from the project's `notices.retention` config (`AB4833` when
malformed). `retain({ at, idempotencyKey })` applies it once: settled notices
older than the TTL, plus the earliest-settled beyond the cap, leave the state
through one `pruned` event (the reducer skips any id that is live again, so a
stale decision can never drop a pending notice, and records
`retention = { lastPrunedAt, pruneRuns, prunedTotal }` on the state and
snapshot); then, when the store's retained journal exceeds `maxJournalBytes`,
the journal is compacted (`store.compact()`). Event admission runs the same
pass after it commits, under a per-invocation key, so retention rides
admitted events only — V1 implies no timer — and the prune key is
content-addressed on the selected ids, so a retry that selects the same set
replays and one that selects a different set commits its own decision instead
of an idempotency conflict. `inspect()` reports the policy, live counts by
state, the number of terminal notices, the retention summary, and the store's
`AgentStateJournalInspection`; it never returns content. A process killed
between the prune and the compaction leaves a pruned state over an unfolded
journal, which the next pass finishes; a compaction over an already-compact
journal is a no-op with no new revision.

Journal compaction is a state-kernel operation (`AgentStateStore.compact()`,
`AgentStateStore.inspect()`), available on both drivers and pinned by the
conformance suite: the head is materialized as a `compact` baseline record
that takes the next revision, every earlier record is deleted, exact reads
below the baseline become `revision-unavailable` (as below a migration), the
change cursor delivers the baseline as a `compact` discontinuity so a
subscriber positioned before it re-reads, and the idempotency keys of the
deleted records are remembered without their results — replaying one is
`revision-unavailable` (the commit happened; its result is gone) and reusing
one with a different input is still `idempotency-conflict`. On SQLite the
baseline insert, key bookkeeping, delete, head update, and the kernel-format
bump commit in one `BEGIN IMMEDIATE` transaction under `synchronous = FULL`,
so a writer killed mid-compaction leaves the full journal or the compacted
one, never a journal missing records its head needs; concurrent processes
serialize on the database lock and reopen through the same head-vs-replay
check. The first compaction moves a store to kernel format 2, which a
pre-compaction kernel refuses with a typed `corrupt` error rather than
misreading the truncated journal; a store that was never compacted stays
readable by both. The `maxRevisions` budget still counts absolute revisions:
compaction bounds bytes and terminal history, not the revision counter.

## License

Apache License 2.0. The published tarball carries the repository
[LICENSE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/LICENSE) and
[NOTICE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/NOTICE).
