# Lane T7 — host-invoked hook receipts on the trace (#600 PR 2)

Branch `lane/wb600-pr2-t7`, worktree `/fast/projects/agent-bundle-wt/wb600-pr2-t7`.

## The seam, and why (deliverable 1)

**Chosen: (b), a slim `POST /api/trace/receipts` on the authenticated foreground
server, with two discovery paths.** (a) was checked and does not exist: the dev
artifact's event executables talk only to their *own* MCP process's event
runtime (`events/ipc.ts`, `agent-bundle/event-ipc`, `endpointId =
<revision>:<artifactRoot>`), never to anything the dev server owns. The dev
server's only channels to an attached host are the MCP proxy (`host-mcp-proxy.ts`
→ `host-mcp-routes.ts`) and the hook wrapper's own stdin/stdout, and a hook
wrapper does not go through the proxy: Claude/Codex/Cursor exec
`node <installedBundle>/hooks/<name>.mjs` directly. The shared runtime
(`mcp-server-runtime.ts` → `createEventRuntimeServer`) runs inside the dev
server *only* for `dev.host.sync` hosts whose MCP server is the one the proxy
spawned, and even then the kernel tracer for a shared-runtime request lives in
that MCP child, not in the foreground process. So the least new machinery is
one wrapper-side carrier and one route.

Discovery, in order, by the generated wrapper (`events/trace-receipt.ts`,
`resolveEventTraceReceiptEndpoint`):

1. `AGENT_BUNDLE_DEV_TRACE_URL` + `AGENT_BUNDLE_DEV_TRACE_TOKEN` — set by the dev
   server when *it* spawns a simulation (`HookService` gained an
   `environment` option; `HookReceiptAttachment.environment(url)` produces the
   pair). A real host never has these.
2. The dev install marker the dev host installer already writes at the
   installed bundle root (`.agent-bundle-dev.json`, `DEV_INSTALL_MARKER` in
   `dev/host-install-manager.ts`; the wrapper spells it as
   `DEV_INSTALL_MARKER_FILE` so the bundle does not pull the installer in —
   `hook-receipts.test.ts` pins the two equal). Its `projectRoot` names the
   project whose dev server published
   `<projectRoot>/.agent-bundle/hook-receipts.json` = `{ url, token }` (mode
   0600, replaced not overwritten, removed on close). This reuses the existing
   attach mechanism unchanged: no installer edit, no host config edit, no new
   env for real hosts.
3. Neither → `undefined` → the tracer is created without an observer
   (disabled) and the wrapper behaves exactly as before. A production install
   pays one failed `readFile` of a sibling path.

The wrapper never blocks the host on the Workbench: `send()` runs in a
`finally`, is bounded by `AbortSignal.timeout(750 ms)`, swallows every error,
and skips a body over 16 KiB. Exit code and stdout are unchanged in every path
(integration test asserts both for success and for a thrown route).

## The receipt (deliverable 2)

`EventTraceReceipt` (`events/trace-receipt.ts`), version 1:

| field | content |
| --- | --- |
| `execution` | `EventTraceExecution` — `event`, `executionId` (UUID minted per wrapper process), `host`, `nativeEvent` |
| `events` | the kernel's `EventTraceEvent`s for this execution minus their repeated `execution` (`execute.start`, `providers.*`, `render.*`, `preflight.*`, `failure` with the kernel's `EventTraceErrorSummary`) |
| `identity` | `sessionId` (`session_id`, else Cursor `conversation_id`), `conversationId` (Claude/Codex `agent_id` else `session_id`; Cursor `conversation_id`), `requestId` (`tool_use_id` / `tool_call_id`) — per `docs/entry-conventions.md` |
| `lineage` | `RequestProvenanceAxis<RequestLineageProvenance>` from the wrapper's existing `resolveStandaloneLineage` (`conversation`, `root`, `parent`, `depth`, `generation`, `resolution`, `subagent{id,type,toolCallId,isParallelWorker}`) — the runtime's `Observed<AgentLineage>` without its live `tree` |
| `startedAt` | ISO instant of `events[0]`; each event's `at` is the tracer's monotonic clock |

Never present: the native payload, `tool_input` / `tool_response`, `cwd`,
`transcript_path`, the environment, any filesystem path, the token.

Lowering (`dev/hooks/hook-receipts.ts`, `lowerHookReceipt`, pure):

- `hook.received` (status `ok`, `occurredAt = startedAt`) → then
  `hook.completed` (status `ok`, `durationMs`, `details.gate` = `deny` /
  `continue` when preflight short-circuited) or `hook.failed` (status `error`,
  `details.error` = kernel summary, `details.failedPhase`).
- `session/start` adds `session.started` after `hook.received`; `session/end`
  adds `session.ended` after the terminal entry.
- Kernel events ride as `details.events[] = { kind, phase, atMs, durationMs?,
  outcome? | runtime? | count? }` on the terminal entry — not as entries of
  their own, so a host turn reads as N hooks, not 6N rows.
- `correlation`: `executionId`, `host`, `routeId = event:<event>`,
  `sessionId`, `requestId`, `conversationId` (identity first, else the
  runtime's `lineage.value.conversation`).
- `href = applicationNodePath({ kind: 'event', event })`, no `?invocation=`.
  T5/T6: a `source: 'hook'` entry has no `RouteInvocation`; "Replay in
  workspace" should build the event fixture from `details.execution.nativeEvent`
  and the route page, not from an invocation id.

Wrapper changes (`adapters/hook-contract.ts`): both templates now build
`execution` once, `await openEventTraceReceipt(...)`, create the tracer with the
receipt's observer, call `receipt.identity(native)`, and `send()` in `finally`.
The plain wrapper traces `execute.start(<runtime>)` (again on the
shared→standalone fallback), `render.start/finish`, and `failure('execute' |
'render', …)`; `runStandalone` also hands the resolved lineage to the receipt.
The preflight wrapper keeps its existing tracer calls and gains the receipt. The
deferred executor spawned by a preflight wrapper does **not** open a receipt
(`receipt = undefined`, disabled tracer): the preflight wrapper already owns
that execution's receipt, so one host invocation yields one receipt — but that
receipt carries `lineage: { state: 'unavailable', reason: 'not-provided' }`
because lineage is resolved in the executor. Open risk below.

## `/api/lineage` (deliverable 3) — skipped, by the stated rule

`AgentLineageRegistry.snapshot()` reads the plugin's `state/` SQLite, which only
the generated MCP process opens (`@agent-bundle/runtime/state/sqlite` in the
built entry); no dev-server service opens that store today, and the wrapper's
standalone path holds no registry at all (`resolveStandaloneLineage` is
payload-derived). Opening it from the foreground would be exactly the new
cross-process store access the task said to skip. Instead every receipt carries
the resolved lineage keys, so Trace can label a group by
`correlation.conversationId` / `details.lineage.value.root` today without a
snapshot route. No change under `packages/rsc-runtime/src/agent-lineage/**`.

## Files

Added
- `packages/agent-bundle/src/core/loopback-origin.ts` — `isLoopbackHttpOrigin`
  (shared by wrapper and server; the one shape the endpoint may be).
- `packages/agent-bundle/src/events/trace-receipt.ts` — wire shape, discovery,
  `openEventTraceReceipt` recorder. Re-exported from `events/project.ts`, so it
  ships in `dist/event-project.js` = the module every wrapper imports.
- `packages/agent-bundle/src/dev/hooks/hook-receipts.ts` — `decodeHookReceipt`
  (strict, closed objects, bounded strings, kernel enums), `lowerHookReceipt`,
  `hookReceiptOutcome`, codes.
- `packages/agent-bundle/src/dev/hooks/hook-receipt-endpoint.ts` —
  `HookReceiptRoutes` (`handle(request, response): Promise<boolean>`),
  `attachHookReceipts(options): HookReceiptAttachment`.
- `packages/agent-bundle/tests/hook-receipts.test.ts` (unit, 15 tests: decoder
  rejections, lowering with a fake publisher, route auth matrix over a real
  loopback listener, endpoint file, discovery, recorder).
- `packages/agent-bundle/tests/hook-receipt-pipe.test.ts` (integration: builds a
  Claude `tool/before` + throwing `tool/after` fixture, spawns the emitted
  `hooks/*.mjs` with a native `PreToolUse` payload four ways — env, marker,
  thrown, dev server gone — and asserts the entries on a `TraceHub`).

Changed
- `packages/agent-bundle/src/adapters/hook-contract.ts` — both wrapper templates
  (above). `trace.ts` untouched; no `trace.ts` need surfaced.
- `packages/agent-bundle/src/events/project.ts` — re-exports.
- `packages/agent-bundle/src/services/hook-service.ts` — `HookServiceOptions.environment?: () => Record<string,string>`,
  merged into the wrapper child env.
- `rstest.integration-tests.ts` — registers the integration test.
- `docs/diagnostics.md` — `AB8247`–`AB8249`.

Production reachability: `trace-receipt.ts` ← `events/project.ts` (every
wrapper); `loopback-origin.ts` ← `trace-receipt.ts`; `hook-receipts.ts` ←
`hook-receipt-endpoint.ts`; **`hook-receipt-endpoint.ts` has no production
importer until T1 applies the wiring below** — that is the cross-lane seam the
task defined.

## Exported API

```ts
// packages/agent-bundle/src/dev/hooks/hook-receipt-endpoint.ts
export const attachHookReceipts: (options: {
  readonly projectRoot: string;
  readonly token?: string;        // test seam
  readonly trace: TracePublisher;
}) => HookReceiptAttachment;

export interface HookReceiptAttachment {
  readonly routes: HookReceiptRoutes;                  // handle(req, res): Promise<boolean>
  readonly token: string;
  publishEndpoint(url: string): Promise<void>;         // writes <projectRoot>/.agent-bundle/hook-receipts.json
  environment(url: string): Readonly<Record<string, string>>; // AGENT_BUNDLE_DEV_TRACE_{URL,TOKEN}
  close(): Promise<void>;                              // refuses further posts, removes the record
}
```

Option name is `trace` as the brief specifies.

## Cross-lane requests (T1 / integrator) — exact edits

`packages/agent-bundle/src/dev/workbench-server.ts`

```ts
import { attachHookReceipts } from './hooks/hook-receipt-endpoint.ts';
// where the TraceHub is constructed:
const hookReceipts = attachHookReceipts({ projectRoot: root, trace: traceHub });
let hookReceiptUrl: string | undefined;
// HookPlaygroundService construction (line ~806) — so Workbench simulations land on the trace too:
const hookPlayground = new HookPlaygroundService({
  epochStore, logger: logs, registry, platformRuntime,
  hookService: new HookService({
    environment: () => (hookReceiptUrl === undefined ? {} : hookReceipts.environment(hookReceiptUrl)),
    registry,
  }),
});
// the ForegroundCoordinator surface (line ~538):
publishServerUrl: async (url: string) => {
  await coordinator.publishServerUrl(url);
  hookReceiptUrl = url;
  await hookReceipts.publishEndpoint(url);
},
// pass to the server:
new ForegroundServer({ …, hookReceipts: hookReceipts.routes, … })
// in the close sequence, before the foreground closes:
await hookReceipts.close();
```

`packages/agent-bundle/src/dev/foreground-server.ts`

```ts
import type { HookReceiptRoutes } from './hooks/hook-receipt-endpoint.ts';
// ForegroundServerOptions:
readonly hookReceipts?: HookReceiptRoutes;
// field + constructor:
readonly #hookReceiptRoutes: HookReceiptRoutes | undefined;
this.#hookReceiptRoutes = options.hookReceipts;
// #handle, right after the host MCP routes and before every session-authorized route:
if (await this.#hookReceiptRoutes?.handle(request, response)) return;
```

The route authorizes itself (bearer token, loopback, no `Origin`); do **not**
wrap it in `#assertMutationSession` — the caller is a wrapper process with no
cookie or session header. `requestHostMatches` at the top of `#handle` still
applies and passes: the wrapper posts to the exact origin the record names.

T5 (`packages/workbench/src/trace/**`): entries arrive with `source: 'hook'`,
kinds `hook.received | hook.completed | hook.failed | session.started |
session.ended`, `details` as described above. T2: no overlap — `kernel.*`
entries from an in-process render and `hook.*` from a host share only
`executionId` semantics, never an id (different processes).

## Security posture

**Exposed:** one route, `POST /api/trace/receipts`, on the foreground dev
server, which already binds loopback only; the route re-checks
`socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` (403 `AB8247`
otherwise). **To whom:** processes on the developer's machine that hold the
per-dev-server receipt token — the generated hook wrappers of the *dev* install
(they read it from `<projectRoot>/.agent-bundle/hook-receipts.json`, written
mode 0600 by the dev server and removed on close) and hook simulations the dev
server itself spawns (token in the child's environment). **Authenticated by:**
`Authorization: Bearer <token>`, 32 random bytes base64url minted per
`attachHookReceipts` (per dev server run), compared in constant time; the
browser session cookie and `x-agent-bundle-session` header are not accepted,
and any request carrying an `Origin` header is refused, so a page in the
Workbench origin cannot post a receipt even with the token; `Content-Type` must
be JSON, the body is capped at 16 KiB before parse (413 `AB8249`), parsed
without duplicate keys, and decoded by a closed-shape validator that rejects
unknown keys, unlisted enums, and over-long strings (400 `AB8248` naming the
field). Wrapper side, the endpoint is honored only if its `url` is a serialized
loopback HTTP origin (`http://127.0.0.1:<port>` / `http://[::1]:<port>`, nothing
after the authority), so a tampered record or env cannot make a wrapper post
anywhere else. **Never sent:** the native payload, tool input/output, `cwd`,
`transcript_path`, `workspace_roots`, the environment, absolute paths, the
token itself (the receipt is what `openEventTraceReceipt` builds from ids and
kernel events only; `hook-receipt-pipe.test.ts` asserts the trace contains
neither the tool command, `tool_input`, the fixture root, nor the token). The
receipt never alters the host's permission behavior: it is posted after the
wrapper has already produced its stdout and cannot change exit code or output
(`finally`, 750 ms cap, all errors swallowed, sends at most once).

## Open risks

- A preflight-gated route's receipt has no lineage (resolved in the deferred
  executor, which deliberately opens no receipt). Fix if wanted: pass
  `executionId` to the executor on stdin and let the executor post a second,
  lineage-only receipt, or have the executor print lineage on a side channel —
  both are additions inside `hook-contract.ts`, none needed for PR 2.
- Shared-runtime executions (the MCP child's `createEventRuntimeServer`) are
  reported by the wrapper that requested them (`execute.start('shared')`, then
  the outcome), not from inside the child, so `providers.*` / `render.*` are
  absent for that path; the trace still gets received/completed/failed.
- The endpoint record lives at `<projectRoot>/.agent-bundle/hook-receipts.json`;
  `.agent-bundle` is already gitignored and in the config ignore list, and
  `dev-lock.ts` uses the same directory.
- `attachHookReceipts` has no production importer until T1 wires it
  (intentional; brief).

## Proposed changeset line (patch)

> Report host-invoked hook and event-route executions of the dev plugin to the
> Workbench trace: generated hook wrappers post a slim receipt (kernel
> `EventTraceEvent`s, execution identity, lineage keys, host/session/request
> ids — never the payload) to the authenticated dev server's
> `POST /api/trace/receipts`, discovered through the dev install marker or
> `AGENT_BUNDLE_DEV_TRACE_URL`/`AGENT_BUNDLE_DEV_TRACE_TOKEN`; lowered to
> `hook.received` / `hook.completed` / `hook.failed` (+ `session.started` /
> `session.ended`). New diagnostics `AB8247`–`AB8249`. (#PR)

## Diagnostic codes

`AB8247` refused (403 / 409 closed), `AB8248` malformed (400), `AB8249` over
16 KiB (413) — registered in `docs/diagnostics.md`. Took the top of the
`AB8240`–`AB8249` trace range to leave `AB8240`–`AB8246` for T1/T5.

## Gate

`pnpm build` ✓ · `npx tsc --noEmit` ✓ · `pnpm lint` ✓ ·
`npx rstest --config rstest.unit.config.ts tests/hook-receipts.test.ts tests/event-trace.test.ts tests/target-hook-contract.test.ts tests/hook-handler-contract.test.ts` ✓ (33) ·
`npx rstest --config rstest.integration.config.ts tests/hook-receipt-pipe.test.ts tests/generated-route-server.test.ts` ✓ (see below) ·
also `tests/hook-playground-service.test.ts tests/hooks.test.ts` ✓ (57) and the
bundling unit files (`entry-shell`, `entries`, `adapter-contract`,
`inspect-bundler`, `artifact-validator`) ✓ (58).
