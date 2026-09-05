# @agent-bundle/runtime

## 0.1.0

### Minor Changes

- 833e48f: Close out #99 acceptance item 7 with a notice redaction contract and a retention policy. `notices.publish()` accepts `sensitivity: 'public' | 'internal' | 'secret'` (default `internal`); each host's `noticeDelivery` row may name a dated `sensitivity` ceiling, and the ledger, inbox resource (`agent-bundle://notices/inbox`, which now reports `sensitivity` and `disclosure`), event admission, and `resources/updated` signaller withhold a notice above the route's ceiling, recording the refusal as `withheld[route]` on the notice; `internal` content is redacted on every route by `flare-redact@1.6.1`, a new exact-pinned runtime dependency of `@agent-bundle/runtime` (default detectors — provider tokens, JWTs, PEM keys, `Bearer`/`Basic` headers, URL credentials, credential assignments, e-mail addresses, cards — plus credential-shaped member names, every finding replaced whole by `[REDACTED]`; assignment values shorter than four characters and OpenAI keys longer than 64 characters are outside the pinned detectors — publish those as `secret`; `redactSecretText`, `redactNoticeDocument`, `containsSecretText`, `noticeRedactionPlaceholder`, `resolveNoticeDisclosure`, `AGENT_NOTICE_ROUTE_SHAPES` from `@agent-bundle/runtime/notices`). `notices.retention: { terminalTtl, maxTerminal, maxJournalBytes }` in `agent-bundle.config.ts` (validated as `AB4833`, shown by `inspect --state` and the Workbench State panel) prunes settled terminal notices on admitted events and compacts the ledger journal past its byte bound through the new `AgentNoticeLedger.retain()` / `inspect()` and the state kernel's `AgentStateStore.compact()` / `inspect()` (a `compact` journal record and `AgentStateChange` kind; a compacted SQLite store moves to kernel format 2). Built-in hosts admit `secret` on `current-response` / `next-event` and `internal` on `mcp-inbox` / `mcp-resource-updated` (adapter revisions bumped). Breaking: `AgentStateStore` implementations must add `compact()` and `inspect()`, `AgentNoticeLedger` gains `retain()` / `inspect()`, `AgentNoticeDelivery` gains `disclosure`, and `AgentStateChange` / `AgentStateJournalRecord` gain the `compact` kind. The aliased `mcp-server-runtime.d.ts` no longer imports from `@agent-bundle/runtime/notices` (`GeneratedNoticeDeliveryBinding` is spelled locally). (#437)
- 12526a8: Framework mode (RFC #63), runtime side — **breaking removals**. The
  structural JSX layer is gone: the `AgentBundle`, `Skill`, `Script`,
  `McpServer`, `McpApp`, and `Operation` elements, `defineRscAgentBundle`, and
  the `RscAgentBundleApplication` type are removed outright. Structure —
  targets, skills, scripts, servers, apps — is declared in
  `agent-bundle.config.ts` and file conventions; JSX remains only where
  something is rendered (`Mcp.*`/`Hook.*` results, rendered skill bodies).
  Their replacement is `defineRscApplication({ name, version, description?,
  operations })`: a flat, JSX-free declaration of the runtime identity and the
  typed operation catalog, rejecting duplicate operation ids, CLI commands, and
  MCP tools. `runRscCli` and `createRscMcpServer` now consume this flattened
  application — `createRscMcpServer(application, serverName)` selects the
  operations whose `mcp.server` matches and throws for a name no operation
  references. The `agent-bundle` peer dependency is dropped; the package no
  longer imports config types at all.
- 67730f4: Publish the reusable RSC protocol runtime and allow generated executables to
  bundle declared pnpm workspace packages without treating dependency source as
  authored project provenance.
- 23ee0f5: Deliver notices over the `mcp-resource-updated` route from generated MCP servers with a workspace-durable state lifetime: accept `resources/subscribe` / `resources/unsubscribe` for the reserved inbox resource `AGENT_NOTICE_INBOX_URI`, advertise `resources.subscribe` only when that wiring is active, and send each subscribed session at most one `notifications/resources/updated` per newly eligible pending notice — honouring `nextAttemptAt`, bounded per notice by `retryBudget` across restarts, never duplicated across concurrent server processes over one store, detached from the render that triggered it and coalesced behind a pending write so a slow subscriber never delays a tool result nor grows a queue, abandoned (never awaited) by server teardown when its write or ledger call cannot settle (`closeTimeoutMs` bounds the close-time receipt drain), and recorded as an `availability` receipt (never a delivery claim) that the inbox projection exposes beside `exposure`. Fail subscriptions closed when the store is unreadable; volatile lifetimes advertise no subscription capability. Use the new exports `createNoticeInboxSignaller`, `AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS`, `AGENT_NOTICE_STATE_VERSION`, and the `AgentNoticeError` code `reservation-lost` from `@agent-bundle/runtime/notices`, and `createGeneratedNoticeRuntime` plus `GeneratedRuntimeState.noticeLedger()` from `@agent-bundle/runtime/mount`. Update implementers of `AgentNoticeLedger`: the interface now requires `reserveAvailability()` and `releaseAvailability()`, and `AgentNotice` gains the optional `availabilityReservation` field (breaking). Existing workspace-durable notice stores migrate in place to schema version 2 on first open, with no data loss. (#376)
- f81ff04: Rename the preview runtime package from `@agent-bundle/rsc-runtime` to
  `@agent-bundle/runtime`. Update workspace consumers, documentation, paired
  pkg.pr.new URL derivation, and preview publishing guidance for the new name.
- 62138ef: Require provider fixtures wherever conventional providers do not run (breaking for provider-enabled projects that omitted them). Once a project's generated `.agent-bundle/routes.d.ts` augmentation declares provider keys, `runAgentRequest`'s `providers` (`AgentRequestProvidersInit`), the `renderRoute` / `invokeCli` / in-memory MCP harness `options` argument (`HarnessOptionsArguments`), and its `context.providers` (`RenderRouteContextInit`) become required, so a handler typed against `(await agent()).providers.<key>` never observes an unchecked `undefined` from a custom scope or a route-unit test; provider-free projects are unchanged. Make `agent-bundle inspect` project only the four-state contract fields of adapter-owned capability rows into component accounting, so extension fields on JavaScript or third-party adapters cannot shadow the canonical capability name or break `inspect --json`. (#409)
- 77aadd2: `RscMcpDefinition` gains optional listing-level `title` and `_meta` slots;
  `defineOperation` preserves them (with the same JSON wire-boundary
  validation as result lowering, deep-frozen) and `createRscMcpServer`
  forwards both verbatim into tool registration, so MCP Apps hosts can bind
  widgets through `_meta.ui.resourceUri` (#43). The server factory also stops
  synthesizing annotation defaults: it emits exactly the hints an operation
  declares (`readOnly`, plus `destructive` / `idempotent` / `openWorld` when
  present), because an absent hint carries MCP-spec default semantics on the
  wire that a synthesized `false` silently rewrote.
- 43a39ad: Add the conventional shared layout module: `src/layout.{ts,tsx}` default-exports one component receiving `{ children, route, signal }` (`AgentLayoutProps` from `@agent-bundle/runtime`, with `AgentLayoutRoute` and `AgentLayoutRouteKind`) and wraps every rendered route — generated MCP tools, resources, and prompts, rendered `src/cli/**` commands, projected MCP commands, and rendered `src/scripts/*.tsx` — while `src/mcp/<server>/layout.{ts,tsx}` nests inside it for one generated server; event routes and App routes are never wrapped, servers pinned to `custom`, `command`, or `remote` skip their layout, and a project without a layout renders byte-identical MCP, CLI, and script output with an unchanged route-graph digest (generated worker source changes as in every release). `agent-bundle inspect --routes` lists layouts, `agent-bundle/test` (`renderRoute`, cli-dispatch, mcp-in-memory) composes the same chain the artifact bakes, and validation fails closed with `AB4830` (layout contract), `AB4831` (duplicate layout scope), and `AB4832` (orphaned server layout). Breaking for typed consumers: `AgentBundleTestManifest` gains the required `layouts` field and the test registry version is now 5. In `@agent-bundle/runtime`, `decodeAgentDocument` now treats an `Agent.Result` without a `value` as a container that adopts the value of the valued result it directly holds and merges plain-JSON object `metadata` with the container winning — a behavior change for documents that previously nested a valued result under a valueless root — so a layout shell leaves the route's result value, `structuredContent`, and content unchanged, while metadata a layout declares is projected as MCP `_meta` (#396)

### Patch Changes

- 4155831: Serve task-augmented MCP tool calls (the MCP `2025-11-25` Tasks utility) from generated route servers: a tool route that declares `config.execution.taskSupport: 'optional' | 'required'` (validated as `AB4836`, advertised in `tools/list`) answers a `tools/call` carrying `params.task` with a `CreateTaskResult` while the render continues behind the task; `tasks/get` reports status and the last render progress, `tasks/result` returns the same `CallToolResult` an ordinary call produces, `tasks/cancel` interrupts the render, and `tasks/list` lists the session's tasks. Clients that never ask for a task see no change; a server whose tools never opted in advertises no `tasks` capability. The Workbench MCP page runs a tool as a task, polls it, fetches its result, and cancels it; `agent-bundle/test`'s `openInMemoryMcpServer` client drives the same lifecycle. The host capability tables gain an `mcp.tasks` row recording whether each pinned host issues task-augmented calls. `@agent-bundle/runtime`'s operation-based `createRscMcpServer` is unchanged — no `tasks` capability, ordinary processing — and its README now records that instead of the lifted deferral (#550)
- 2841419: Make `request.lineage` the only identity-adjacent surface — parent conversation, root, and the parent-of-subagent chain — and stop reading operator identity anywhere: the Cursor `workspaceOpen` event-route validator no longer inspects `user_email` (the field passes through inside `native` untouched), and `actor` is documented as the HTTP-authenticated MCP client only. Bind a never-seen Cursor conversation to a pending `subagentStart` only when exactly one is pending in the same `workspace_roots`, and undo a blind binding (re-rooting anything started beneath it) when that conversation later carries a root-only event such as `beforeSubmitPrompt`, so a chat tab whose prompt predates the registry resolves as a root instead of another conversation's subagent. (#444)
- 42539ff: Take Claude Code's own word for a subagent's parent: the parent's `Agent` `PostToolUse` carries the spawn `tool_use_id` and `tool_response.agentId`, the child's `agent_id`, so the lineage registry behind `request.lineage` now confirms the edge it matched from spawn-call ordering, fills in `subagent.toolCallId` for siblings it had claimed blind, places a `SubagentStart` no spawn window could (none open, or two parents with one — the start's id, type, time, stop, and any confirmations it issued for its own children are kept meanwhile, so a missed spawn hook at one level does not lose the subtree beneath it), moves a child it had filed under the wrong parent and re-bases that child's descendants, and holds a child the host names before its start arrives. Add `'confirmed'` to `AgentLineageResolution` (`@agent-bundle/runtime`, `RequestLineageProvenance` in `agent-bundle`): a subagent's `parent`/`root`/`depth` resolve `confirmed` once every edge up to the root is host-named — right after `SubagentStart` for a background spawn, after `SubagentStop` for a foreground one — and stay `registry` otherwise. The Claude capability table's `lineage.parent`/`lineage.depth` rows record the confirmation and its timing, and the generated hosts page gains a "Conversation lineage" section rendered from every host's `lineage` rows. (#422)
- 10e217e: Resolve `request.lineage` for concurrent Cursor MCP calls by their arguments. Cursor's `tools/call` `_meta` names no conversation, so a generated MCP server correlated a call only through the open `MCP:<tool>` pre-tool hook and reported `id-not-resolvable` whenever several conversations had the same tool open. The pre-tool hook's `tool_input` is the call's arguments verbatim, so the lineage registry now records their digest on each open window (`inputDigest`) and the generated server passes the call's raw wire arguments (captured before schema parsing, so input defaults never make two calls look alike) to `resolveToolCall`; a concurrent call with different arguments resolves (`resolution: inferred`, provenance `derived`), identical arguments still refuse, a window recorded without a digest stays in contention, and a single open conversation is unaffected. (#483)
- adb25b4: Project an `Agent.Progress` node streamed in a `Suspense` fallback (any `shell`/`replace` document) to `notifications/progress` when the MCP request carries `_meta.progressToken`, under the same monotonic `progress` rule as `progress.report()` so a re-streamed fallback or an explicit report of the same step is never duplicated; the rendered CLI's interactive TTY draws its in-place progress line from the same streamed node. A fallback alone is now enough on both surfaces; `announce()`-style shims that repeat the fallback message through `progress.report()` are unnecessary. Fixes #448. (#498)
- 43d787f: Let a rendered route declare its own render budget: `config.render: { maxElapsedMs }` on `ToolConfig`, `ResourceConfig`, `PromptConfig`, and `CliRouteConfig` raises (or lowers) the 60-second `maxElapsedMs` of that route's render session, validated at build time as a positive integer of milliseconds up to `MAX_ROUTE_RENDER_ELAPSED_MS` (24 hours, exported from `agent-bundle`) — `AB4835` otherwise, including on a plain `.ts` command, which has no render session. The generated MCP server applies it per `tools/call`, `resources/read`, and `prompts/get` while still forwarding every progress report as `notifications/progress`; the compiled command carries it into the generated CLI executable (`CompiledCliCommand.render`, inherited by `routes.mcpCommands` projections); `renderRoute` and `openInMemoryMcpServer` apply it over the `limits` a test passes as the dispatcher's base. `AgentRenderDispatch.limits` layers per-dispatch limits over `createAgentRenderDispatcher`'s. Defaults are unchanged. Fixes #454. (#526)
- a69673b: Expose the live agent tree to routes: `(await agent()).lineage.value.tree` — `{ siblings, children, roots }` of `AgentLineagePeer` (`{ conversation, depth, parent?, startedAt, subagent?, resolution }`) — lists every other live conversation under the request's root (any depth, the root itself included for a subagent), the request's live children, and the other live root conversations (on Cursor, only those seen in the same `workspace_roots`), read at resolve time from the same lineage registry that placed the request on every surface it feeds (event routes, generated MCP tool calls correlated through a hook window or a Codex `_meta`). Nothing is invented: stopped conversations are not listed, each peer carries the registry's own `resolution` for its placement, and the tree is absent when the registry did not place the request (a standalone hook, or a `_meta` naming a thread the registry never saw start). New exported types `AgentLineageTree` and `AgentLineagePeer`; `AgentLineage.tree` is optional, so existing readers and injected `context.lineage` fixtures are unchanged. (#544)
- a2d1795: Address a notice to one agent conversation or to a whole conversation tree: `AgentRecipient` gains `conversation` (matches `request.lineage.conversation` exactly) and `root` (matches every request whose `request.lineage.root` is that id), matched in conjunction with the existing `actor` / `host` / `session` / `workspace` axes at admission, inbox reads, `resources/updated` eligibility, and acknowledgement. `AgentNoticePrincipal` gains an optional `lineage`, which every generated surface (event routes, MCP tools, routed CLI, rendered scripts) now mounts; a principal built without it, or with unresolved lineage, never matches a lineage-addressed recipient and otherwise behaves exactly as before. The ledger journals only `{ conversation, root }` of the admitting lineage as an additive optional field — no state-definition version bump, journals written before the axes replay unchanged. `notices.publish()` rejects blank `conversation` / `root` with `invalid-input`. `examples/worktree-proximity` addresses its proximity notices to the other actor's conversation instead of its worktree. (#458)
- 017961f: Hand conventional `src/providers/<name>` factories the request they run for: `AgentProviderContext` (`agent-bundle`) gains `host`, `session`, `workspace`, and `lineage` beside `plugin` — the same observed axes the route reads on `await agent()`, provenance and the lineage's live `tree` included — plus read-only `state` (`lifetime`, `read()`) and `notices` (`inbox()`, `published()`) views of the mounted handles; `dispatch`, `publish`, and `acknowledge` stay route-only, and `agent()`/`useAgent()` inside a factory throw `outside-invocation`. New exported types `AgentProviderObserved`, `AgentProviderHostIdentity`, `AgentProviderSessionIdentity`, `AgentProviderWorkspaceIdentity`, `AgentProviderLineage`, `AgentProviderLineageTree`, `AgentProviderLineagePeer`, `AgentProviderLineageSubagent`, `AgentProviderLineageResolution`, `AgentProviderStateHandle`, `AgentProviderStateSnapshot`, `AgentProviderNoticesHandle`, `AgentProviderNotice`, `AgentProviderNoticeState`, `AgentProviderNoticeRecipient`, `AgentProviderNoticePublisher`, `AgentProviderNoticeAttempt`, `AgentProviderNoticeWithholding`; `AgentProviderObservedPluginRoot` is now `AgentProviderObserved<AgentProviderPluginRoot>`. Every generated request scope (Flight worker, rendered CLI/script worker, plain routed CLI) and the `agent-bundle/test` harness now run providers as the request's own resolver — after `runAgentRequest` freezes the identity axes and opens the notice lease, before the route. `@agent-bundle/runtime`: `runAgentRequest` accepts `providers` as an `AgentProviderResolver` `(request: AgentProviderRequest) => values` beside the plain record; new exported types `AgentProviderRequest`, `AgentProviderResolver`, `AgentProviderStateHandle`, `AgentProviderNoticesHandle`. Existing factories that destructure `{ invocation, plugin, signal }` are unchanged. (#459)
- a391791: Let a publisher read what became of its own notices: `(await agent()).notices.published()` returns the notices the current principal published, in every ledger state (`pending`, `attempted`, `acknowledged`, `expired`, `unavailable`, `withdrawn`) with their receipts. `publish()` records the publishing request's observed identity on the notice as `AgentNotice.publisher` (`actor`, `host`, `session`, `workspace`, and `conversation` from `request.lineage`); a reader is the publisher when it resolves the same lineage conversation, or — for a publisher recorded without lineage — when every recorded axis matches. The view records nothing on the ledger, is judged per notice under the new authorization `phase: 'published'`, discloses content under the default `internal` ceiling, and never returns another publisher's or any recipient's notices. `publisher` is an additive optional field (no state-definition version bump). `examples/worktree-proximity`'s `coordinator/status` reports the calling agent's published-notice counts by state. (#460)
- 5d5c9c9: Expose the resolved plugin root on the request context: `(await agent()).plugin` is an observed `{ root, stateRoot }` — `source: 'native'` from an expanded `AGENT_BUNDLE_PLUGIN_ROOT`, `'derived'` from the shell's fallback (the artifact root, or `$PWD/.agent-bundle` for the npm bin) — and conventional providers receive the same value as `plugin` beside `invocation` and `signal` (`AgentProviderContext.plugin`). Every generated shell (MCP entry and Flight worker, routed CLI executable and render worker, hook wrappers) now resolves the anchor once through the new `resolvePluginRoot` export of `@agent-bundle/runtime` and mounts its SQLite state, notice ledger, and lineage journal on that one `stateRoot`, so `plugin.stateRoot` is the directory they use by construction; an unexpanded `${…}` token is treated as unset and reported once on stderr instead of being joined into a path. `renderRoute`, `invokeCli`, `runScript`, and `openInMemoryMcpServer` publish the axis the same way and accept `context.plugin`; `createGeneratedRouteMcpServer` takes `pluginRoot`. `AGENT_REQUEST_STORE_VERSION` is 4. Fixes #468. (#532)
- 9551498: Expose the process's terminal capability to routes and scripts as `(await agent()).terminal`, so a plugin that paints its own stderr or sizes its own output no longer probes `process.stdout.isTTY`, `columns`, or `FORCE_COLOR` itself. The new `Observed<AgentTerminal>` axis reports `hostSurface` (`cli`, `mcp`, `hook`, `script`, `workbench`), a `stdout` and `stderr` stream each with `kind` (`tty`, `pipe`, `none`), `color` (`none`, `basic`, `256`, `truecolor`), and `columns`/`rows` when known, plus `sharesTarget` (fd 1 and fd 2 name one file). Routed CLI executables (plain, rendered, and projected MCP commands) and rendered scripts probe their process once — honouring `FORCE_COLOR`, `CLICOLOR_FORCE`, `NO_COLOR`, `CLICOLOR=0`, `TERM=dumb`, `COLORTERM`/`TERM` depth, and `COLUMNS`/`LINES` overrides — and select their `tty` or piped output mode from that same value; generated MCP servers, event routes, and Workbench replays report `none` on both streams and never guess. The executable envelope passes the same value to plain `main` scripts and bins as `main(argv, { terminal })` (`ExecutableMainContext` from `agent-bundle`); a one-parameter `main` keeps working. `runGeneratedCliEntry` and `runGeneratedRenderedScript` (`agent-bundle/cli-entry`) accept `terminal` and hand it to `execute`, `render`, and `createSession`; `runRscCli` accepts `terminal` in its options and `createRscMcpServer` mounts the MCP value. In `agent-bundle/test`, the `tty` knob of `invokeCli` and `runScript` shapes a deterministic synthetic terminal, `renderRoute` and the in-memory MCP level mount what the artifact would, and `context.terminal` injects any other value. Fixes #511 (#534)
- 6b74fc6: Adopt effect-rstest for Effect-native tests and scoped test resources.
- 6c8b1a8: Add the versioned immutable Agent Document, bounded sequence-numbered render
  events, the protocol-oriented `Agent.*` vocabulary, and discriminated render
  invocation props while retaining the existing synchronous MCP and hook lowerers.
- 7404daa: Interrupt `projectMcpRenderStream` promptly when its `signal` was already aborted between composition and start: the Effect boundary bridge re-checks `signal.aborted` after subscribing, so a pre-aborted projection rejects instead of hanging. (#164)
- 7404daa: Close the `@agent-bundle/runtime/state/sqlite` connection through an infallible finalizer again: a close failure on the success path surfaces as a defect, and on the failing path the original failure stays the reported cause. (#208)
- 7404daa: Validate runtime operation inputs, state conformance, and the notice inbox route with `zod` 4.5.4 instead of 4.4.3 (fixes an upstream default-factory misfire during cycle walks); `@agent-bundle/runtime` installs pull the updated dependency. (#304)
- 7404daa: Speed up `agent-bundle build` and the dev server by reading each route module once per build instead of once per surface, caching prepared statements in the `@agent-bundle/runtime/state/sqlite` driver, and bounding directory-walk concurrency; keep `node:*` imports out of the Workbench browser bundle by moving the MCP App consent-capability vocabulary to a browser-safe module. (#348)
- 4daf388: Bound the Flight EOF wait by the render deadline and cancel stalled Flight
  sources when the elapsed-time limit is exceeded.
- 3c963e9: Configure sqlite state storage under the busy timeout: `createSqliteStateDriver` now retries the `PRAGMA journal_mode = WAL` switch on the first open of a state file for up to `busyTimeoutMs` while another process holds the write lock (SQLite never routes that read-to-write lock upgrade through `busy_timeout`), so two processes opening one workspace-durable state file no longer fail with `unavailable` / `database is locked` during setup. Extended SQLite result codes (`SQLITE_BUSY_*`, `SQLITE_CORRUPT_*`) now map to the same typed `unavailable` / `corrupt` errors as their primary codes (#567)
- 766e824: Docs-only clarification of the operation/JSX model (#88). The published
  README now states explicitly that the package is **not** a React Server
  Components renderer or runtime and that no Flight transport is involved: it
  is a synchronous React-element protocol DSL (an "MCP result DSL") whose
  `lowerMcpResult`/`lowerHookResult` walk an element tree and lower it into
  plain protocol results. The README also spells out the operation model — an
  operation is a host-neutral use-case definition whose shared core
  (`id`/`inputSchema`/`execute`/`resultSchema`) runs identically under the CLI
  and MCP projections, `render` is consumed only by MCP, and the CLI prints
  validated JSON — and the npm `description` field no longer claims "React
  Server Component primitives". No runtime code or export surface changes.
- 48c89c1: Resolve a Codex subagent's `request.lineage` parent and depth from the thread's own rollout instead of spawn ordering: the registry reads the `session_meta` head of the rollout every hook payload names in `transcript_path` (`agent_transcript_path` on `SubagentStop`), places the thread with the new `resolution: 'transcript'` (provenance `derived`), matches the `spawn_agent` call to the child by `agent_path`, and corrects an inferred parent at `SubagentStop` from the parent rollout it names. Standalone hooks gain `resolveStandaloneLineage` for the same read. The Codex capability table's `lineage.parent` and `lineage.depth` rows move to `supported`. Refs #423 (#480)
- 98cc244: Remove nineteen unreferenced modules left behind by extractions that never
  rewired their callers, collapse the surviving duplicated helpers onto their
  canonical owners, and fix the three defects that drift had caused: the
  Workbench Logs view now shows `lifecycle.replay.started`, `.completed`, and
  `.failed` Dev Log records and records carrying `routeId` (the browser log
  client's private copy of the `agent-bundle/contracts/dev-logs` vocabulary had
  omitted them); the Workbench now subscribes to `dev.host.sync` project events,
  which `project-client` had left out of its SSE listener list; and the
  Playground trace store redacts with the shared `core/credentials` classifier,
  which adds the provider environment-variable patterns its local copy lacked.
  `@agent-bundle/runtime` drops the internal, never-exported
  `expectCanonicalPayload` helper from `state/contract`. No public export, route,
  diagnostic code, or runtime behavior changes otherwise. (#451)
- 75e1a53: Deslop pass over the Wave 1 delta: `config/normalize.ts` reuses the shared `core/freeze.ts` `deepFreeze` instead of a local copy, the internal `configClaimedSources` helper is no longer exported, the dev-lock URL publication settles through one named cleanup, and the rsc-runtime CLI binding drops a redundant `Object.freeze` (the request store snapshots and freezes capabilities itself). No behavior changes.
- 43abb2d: Accept an optional `now` time source on `createAgentRenderEventSequence` and run the render dispatcher's `maxElapsedMs` deadline — the event sequence's elapsed check and the pending-boundary deadline sleep — against one injectable clock, so a Flight render's deadline can be driven by a test clock instead of wall-clock time. Add a `timers` option (`McpProbeTimers`) to the Workbench MCP probe service so its total-budget timeout, bounded teardown wait, and detached plugin-data cap can be scheduled without real timers; production behavior is unchanged. (#434)
- 88eb4b9: Add the optional recipient-scoped notice ledger behind the new `./notices`
  subpath. It persists detached Agent Document snapshots through the existing
  state kernel, exposes only the evidenced v1 states (`pending`, `attempted`,
  `expired`, `unavailable`, `withdrawn`), performs publish- and delivery-time
  authorization, and records next-event attempts with invocation receipts.
  Stateless package-root and plugin consumers ship none of the ledger.
- d691cdb: Rewrite the runtime dispatcher internals on Effect v4 behind the unchanged
  `dispatch()` / `stream()` Promise and ReadableStream edges. Flight decode is
  an Effect Stream with native pull backpressure; invocation-local boundary
  reconciliation and contract bounds are stream stages; host AbortSignal is
  honored at the public edge via the boundary interruption bridges.
- b4afb74: Pin Effect 4 (`effect@4.0.0-rc.112`) for Wave 3.5 internals and add the
  runtime-only `src/effect/boundary.ts` Promise edge. Public authoring stays
  Promise + zod; Effect is not part of the published API.
- 3e891ac: Rewrite the state-kernel driver internals on Effect v4 behind the unchanged
  public API: `Scope`/`Layer` own sqlite connection and BEGIN IMMEDIATE
  transaction lifecycles (`acquireUseRelease` commit/rollback), and the kernel's
  fail-closed states ride a typed `AgentStateError` error channel mapped back at
  the boundary module. `defineState`/`dispatch`/`read`/`changes`/`reset` still
  return the same Promise shapes and reject with the same typed errors; root and
  plugin entries still ship zero kernel or effect bytes.
- 8b75a6c: Cleanup pass over the Wave 3.5 Effect migration: harden the sqlite
  connection and Flight reader finalizers against masking the original
  failure, consolidate the state drivers' duplicated pending-open lifecycle
  tracking, remove the dead epoch lease registry and unused `runSyncExit`
  boundary exports, and trim migration-narration comments. No public API or
  behavior change.
- aad35b3: Add React-owned final-only Flight execution behind the public render-dispatcher
  and execution-host seam. Decode intrinsic `Agent.*` output into one immutable
  Agent Document and propagate request cancellation without changing the existing
  synchronous MCP lowerer path.
- d63dd3b: Keep next-event notice admission deterministic across invocation replays,
  scope replayed deliveries to the matching principal, exclude notices created
  after an event started, and interrupt delivery authorization when the request
  is aborted.
- 02d2e37: Execute conventional `src/providers/*.{ts,tsx}` factories once per generated
  MCP or event request and mount their values at
  `(await agent()).providers.<camelCaseKey>`. Provider execution is deterministic,
  sequential, abort-aware, and fail-closed; duplicate, reserved, and invalid
  provider exports report `AB4940`–`AB4942`.
  
  Export `AgentRenderInvocation` as a type from the runtime package root so
  provider authoring types do not require an internal import.
- e131071: Mount the #98 state kernel and #99 notice ledger into generated request
  scopes (#233). `@agent-bundle/runtime/mount` exports
  `createGeneratedRuntimeState`, which owns the project state store and the
  notice ledger over one driver and returns typed-failing handles when that
  driver cannot open. `createWarmFlightHost` accepts optional `runtimeState`
  ownership so the warm host closes the generated owner with the process.
  Conventional `src/state.ts` default-exports `defineState({ ... })` with
  statically extracted literal `id` and `lifetime` (`AB4818`–`AB4820`);
  `state: false` opts out. Generated MCP flight workers, routed CLI bins, and
  rendered workers and scripts mount `state` and `noticeLedger` into every
  request scope — memory driver for `request`/`process` lifetimes,
  `node:sqlite` at the `AGENT_BUNDLE_PLUGIN_ROOT`-anchored `state/` root for
  `workspace-durable`, and a cwd `.agent-bundle/state` fallback for package
  bins. Event invocations run notice admission once in the render scope with
  invocation identity forwarded from the host process. Stateless projects
  emit none of this. The test harness auto-mounts declared state at
  route-unit level, and `openInMemoryMcpServer` accepts a state owner.
- 941aa08: Fail closed instead of replaying unrecoverable legacy state with a newer
  reducer, recover journal-head results from the materialized sqlite head, and
  preserve lifecycle errors while closing every open sqlite store.
- 2e91ea1: Add the async `MarkdownContent` component and the `renderToMarkdown` /
  `renderToMarkdownStream` exports to `@agent-bundle/runtime`, so routes author
  rich Markdown blocks — headings, lists, GFM tables, task lists, nested async
  components, escaped text — as JSX lowered into `Agent.Markdown` instead of
  hand-concatenated strings. The renderer behind them, `rsc-markdown-stream`, is
  now a package of this repository and is published from it (it was previously
  only installable from its git URL), so `@agent-bundle/runtime` depends on it
  by version. `agent-bundle build` now follows symlinked (workspace) dependencies
  transitively when attributing bundle provenance, resolving each one the way
  Node does, so a project whose linked dependency links another package —
  including one hoisted to an ancestor `node_modules` — no longer fails with
  `AB5000`, and a dependency that links back onto the project never hides the
  project's own sources from provenance. (#344)
- f469376: License: Apache-2.0 (previously unspecified/MIT-declared); LICENSE and NOTICE
  shipped in the tarball. Every package manifest now declares
  `"license": "Apache-2.0"`, the build copies the repository LICENSE and NOTICE
  into each publishable package, and `pnpm audit:release` fails if any
  publishable tarball is missing either file or the license field.
- 77aadd2: `lowerMcpResult` now follows MCP SDK wire semantics for `undefined` inside
  `structuredContent` and `_meta`: object properties whose value is `undefined`
  are dropped and `undefined` array elements lower to `null`, exactly as
  `JSON.stringify` serializes them (#44). Handlers written against SDK
  serialization no longer fail at runtime when an optional field stays
  `undefined` on some input path. Every other strict rejection — cycles,
  accessors, sparse arrays, non-finite numbers, non-plain objects — is
  preserved, and the JSON-boundary error now names the offending key path
  instead of a fixed message.
- ed44cd5: Add the standards-compatible MCP progress/final projector and warm-runtime
  fail-closed host. Generated tool calls emit `notifications/progress` only when
  the caller supplied a token, return one `CallToolResult`, and refuse silent
  rich-content drops, epoch mismatch, and a missing or restarted runtime.
- 055edf1: Record the dated deferral of task-augmented MCP tool calls (`CreateTaskResult`,
  `tasks/get`, `tasks/result`, `tasks/cancel`): the installed MCP SDK ships only
  the `2025-11-25` task wire vocabulary with no task runtime, and the
  `2026-07-28` revision moves tasks into an extension. Generated servers stay
  fail-closed — no `tasks` capability is advertised and task-augmented requests
  are processed as ordinary calls — and a sentinel test pins the audited SDK
  version so the deferral cannot go stale silently.
- 56b77db: Fixes found while re-porting a real external plugin onto route mode
  (#380, #381, #383):
  
  - A `mcp.servers.<id>` declaration for a route-generated server now
    **augments** that server — `env`, `args`, `targets`, `apps`, and
    `transport: 'stdio'` apply — instead of failing `AB4304`/`AB4322`. Redeclaring
    `entry`, `command`, or `url` beside `routes.servers.<id>: 'generated'` is
    the new precise `AB4340` error; without an explicit mode it stays `AB4800`.
  - `Agent.Result metadata` projects to `CallToolResult._meta` (an object,
    JSON-snapshotted like `structuredContent`; a non-object fails the projection
    closed with `McpProjectionError('invalid-result-metadata')`). The
    `mcp-in-memory` harness result exposes `_meta`.
  - Generated tools advertise `outputSchema` only when the route's
    `resultSchema` describes an object; text-only routes (for example
    `resultSchema = z.undefined()`) advertise none and return no
    `structuredContent`, as the MCP specification requires.
  - The `typescript-5` parser alias is bundled into the package instead of
    shipped as a dependency, so `npm install agent-bundle` never links a `tsc`
    bin over the consumer's own TypeScript.
- 78cc1fb: Add the #99 stage-4 delivery substrate to the notice ledger: recipient-scoped explicit `acknowledge()` (new `acknowledged` state, the strongest evidenced outcome), optional `retryBudget`/`nextAttemptAt` publish fields with re-attempt semantics evaluated only on admitted events (never an implied timer), a `signalAvailability()` ledger verb recording wire-level `resources/updated` signals as availability receipts (never delivery), and the pure delivery-route selector over per-host advertisements with a typed unavailable outcome. `delivered` remains deliberately absent from the state union because no pinned host supplies cross-actor delivery evidence (2026-09-02 survey on #99); pre-existing durable notices replay unchanged because the new fields are optional and never materialized by parse.
- 6a2b341: Fix two #99 stage-4 review findings: retriable attempted notices past `expiresAt` now expire instead of retaining unused attempts, and `acknowledge()` rejects invocations that started before the notice existed so durable acknowledgement receipts can never predate `createdAt`. The package README's Notices section now describes the current handle surface, states, receipts, retry semantics, and route selector.
- dee724f: Type project-defined context providers without a compiler change per
  provider. `AgentProviderValues` is now an augmentable interface (string index
  of `unknown` plus the optional framework-owned `processLifetime`, exported as
  `AgentProcessLifetime`), and the generated `.agent-bundle/routes.d.ts`
  declares `AgentBundleProviders` / `ProviderKey` / `ProviderValue<Key>` from
  each conventional `src/providers/*` factory's awaited return type and augments
  `@agent-bundle/runtime` so `(await agent()).providers.<key>` observes that
  type. Provider-free graphs emit no augmentation; a graph with providers but no
  executable routes keeps the declaration file.
- ef1bcdf: Expose a recipient-scoped, read-only notice inbox through generated stateful
  MCP servers. Inbox reads record bounded availability and observed re-read
  evidence without acknowledging notices or marking delivery attempted; stateless
  projects emit no inbox resource or related runtime imports.
- 7abd6b5: Finalize progress reporters on setup and stream interruption with an abort
  outcome, and surface Flight reader cancellation failures that do not mask an
  earlier stream failure.
- 9df37f8: Narrow the documented CLI claim to the `runRscCli` compatibility path: it
  still serializes the validated result as one JSON line and never invokes
  `render`, while routed `src/cli/**` `.tsx` commands render through the Agent
  renderer's dispatcher (#102 stage 3). Documentation and pin-test wording
  only; no runtime behavior changes.
- 21af4ce: Add `request.lineage` to `AgentRequestContext` on every surface (event routes, generated MCP tools, routed CLI, rendered scripts): `{ conversation, root, parent?, depth, generation?, subagent?, resolution }` resolved by the new runtime-held agent lineage registry (`@agent-bundle/runtime/lineage`, journaled through the state kernel beside workspace-durable project state) that the `agent/start`/`agent/stop` and `tool/before`/`tool/after` families feed, with hook→MCP correlation from Claude `claudecode/toolUseId`, Codex `x-codex-turn-metadata`, and Cursor's open `MCP:<tool>` pre-tool hook. Unavailable lineage carries a typed reason (`no-subagent-events`, `id-not-resolvable`, `cloud-agent-no-user-hooks`, `no-shared-runtime`, `unsupported-surface`, `not-provided`); every pinned capability table gains dated `lineage` rows, the Workbench Lifecycles view shows the lineage axis and chain, and `openInMemoryMcpServer` accepts `lineage`/`lineageHost`. Claude `PostToolUse` event routes and `afterTool` hooks now accept the plain-string `tool_response` that MCP tools deliver (any present JSON value, as on Codex) instead of failing with `native tool_response must be an object`; no diagnostic codes are added or changed. (#421)
- b3c12f3: Add the versioned realm-singleton request store, `await agent()`, and
  Observed identities (#95 Wave 1). MCP and CLI entrypoints install a closed
  request lease so `execute` can read the same `AgentInvocation` (kind
  `tool` | `event` | `cli` | `script` | `workbench`) without a daemon or
  durable state. `state`, `notices`, and `providers` are reserved extension
  slots; a captured handle throws after the request completes.
- 77aadd2: `defineRscAgentBundle` element trees can declare MCP Apps first-class:
  `<McpApp>` children of `<McpServer>` lower into the owning server's
  `mcp.servers[<name>].apps` record (#42), so `application.config` stays the
  single source of truth for widget-bearing plugins instead of a config-side
  splice. App names, entries, templates, `ui://` resource URIs, target
  subsets, and JSON `_meta` are validated during lowering; app `targets`
  default to the owning server's targets. The same `<McpApp>` may be declared
  on several servers when the definitions are identical — the shared-app case
  the compiler now supports — while conflicting redeclarations and resource
  URIs spread across different app names are rejected.
- cf94ccc: Published-metadata fix: the `react-server-components` keyword is removed from
  `packages/rsc-runtime/package.json`. #89 rewrote the `description` in that same
  file to state that the package is a React-element result DSL rather than a
  React Server Components renderer, but left the keyword asserting the opposite,
  so the npm manifest contradicted itself and the registry surfaced the package
  against RSC-renderer searches it cannot serve. The remaining keywords —
  `agent-bundle` and `mcp` — describe what the package actually is. No runtime
  code, export surface, or package name changes; the name is tracked separately.
- baed7d8: Drop `@modelcontextprotocol/sdk` 1.x from `@agent-bundle/runtime`'s dependencies: the `CallToolResult` type now comes from `@modelcontextprotocol/server` 2.x, so installing the runtime no longer pulls the 1.x SDK's express, hono, jose, cors, and ajv trees. `lowerMcpResult` and `documentToCallToolResult` return the new exported `McpCallToolResult` (content blocks per `McpContentBlock`, `_meta` and `structuredContent` as JSON objects), which is assignable to both SDK lines' `CallToolResult`; `attachMcpStructuredContent` is generic over its input, so a result typed by either SDK line comes back as the type it went in. Build every public entry in one module graph: each error class is defined once in the package, so `instanceof AgentStateError` holds for errors raised through `@agent-bundle/runtime/state`, `/state/sqlite`, `/mount`, `/lineage`, and `/notices` (the previous build shipped a second `AgentStateError` inside the sqlite entry), while `node:sqlite` still loads only through `/state/sqlite`. Expose `./package.json` in `exports` and mark the `@rspack/core` peer optional — no runtime entry imports it. `pnpm lint:release` now runs `attw --profile esm-only` and `scripts/check-declaration-imports.mjs` on the packed runtime tarball too. (#571)
- 7e447b5: Build on Rslib 1.0 and Rsbuild 2.2 so a project installs one Rspack engine and one native
  binding instead of two; `create-agent-bundle` templates pin `@rstest/core` 0.11.12. Plugin
  builds stay self-contained (`output.autoExternal: false`, Node builtins the only externals) and
  keep `new URL(…, import.meta.url)` and `new Worker(new URL(…))` expressions verbatim.
  `agent-bundle inspect --bundler` lowers in production mode regardless of `NODE_ENV` and shows the
  new `bundlerChain` invariant beside `tools.rspack`. Published `.d.ts` files (`agent-bundle`,
  `@agent-bundle/runtime`) now import their siblings with `.js` specifiers; every `exports` entry
  resolves as before. (#575)
- 853872e: Expose warm-runtime availability and add a read-only event IPC status verb
  that carries runtime identity through Doctor and Workbench discovery.
- 99eb375: Enforce Agent Document bounds during JSON and Flight decode walks, bound live
  progress by downstream demand, close the progress queue on setup failure, and
  convert synchronous host throws into stream failures.
- 9dc12bc: Add the seven v1 semantic event-route descriptors and the `Agent.Context`
  document vocabulary used for immediate host guidance.
- e3fee71: Add fail-closed size, time, and retention budgets to the optional Agent state
  kernel. `defineState` now resolves configurable runtime policy defaults, and
  the memory and SQLite drivers enforce identical typed `budget-exceeded`
  semantics without changing reads or replay of committed history.
- d024e81: Add the optional Agent state kernel contract (#98 v1) behind the new
  `./state` subpath: `defineState({ schema, initial, events, reduce })` with
  the explicit lifetime taxonomy (`request` | `process` | `workspace-durable`
  | `external`), typed `AgentStateError` codes, monotonic revisions,
  exact-revision reads, idempotency-key replay/conflict, compare-and-swap,
  explicit versioned migrations, and polling change cursors. Ships the
  volatile in-memory driver (request/process lifetimes; never durable), the
  request-bound handle that fills the reserved `state` slot on
  `AgentRequestContext`, and the driver conformance suite every driver —
  including external ones — must pass. Stateless projects import none of it.
- f45ae75: Ship the workspace-durable state driver on `node:sqlite` (#98 v1, G3)
  behind the dedicated `./state/sqlite` subpath: WAL journal mode with full
  synchronous durability, every commit in one immediate transaction
  (idempotency lookup, compare-and-swap, reducer, journal append, head update
  commit atomically), cross-process writers serialized on the database lock
  with a bounded busy timeout, explicit migrations on open, and corruption
  failing closed with typed errors. The driver passes the same conformance
  suite as the in-memory driver, plus cross-process proofs: two independent
  processes updating one store, and a SIGKILLed writer never leaving a
  successful-but-corrupt state. The subpath split keeps `node:sqlite` (and
  its ExperimentalWarning) away from volatile-state and stateless consumers,
  and the package now declares `"sideEffects": false` so bundlers can
  tree-shake unused kernel exports.
- ae7722c: Preserve durable state across the sqlite filename transition, recover legacy
  journal results before schema migrations rebase history, keep reset
  idempotency inputs unchanged while migrating their committed results, make
  in-memory migrations atomic, and surface sqlite close failures on otherwise
  successful shutdown.
- 48cdcd2: State kernel review follow-ups from #142/#149. Both drivers now consult the
  idempotency key before running the reducer, so a committed key replays its
  stored result even when the reducer would fail against the current head; the
  committed result is stored per key (event journal rows now persist their
  post-commit state) and rides the migration chain, so replay survives schema
  migrations instead of failing `revision-unavailable`. The sqlite driver
  verifies storage on open — journal continuity (a hand-deleted intermediate
  row fails closed) and the materialized head against journal replay (a
  schema-valid but hand-edited head fails closed) — and derives database file
  names from a sha-256 hash of the complete definition id, so ids that share a
  sanitized prefix no longer collide onto one file. Sparse arrays are rejected
  at the JSON boundary instead of silently canonicalizing like dense ones. The
  shared conformance suite pins the corrected semantics for every driver.
- 33f8651: Add incremental Flight decoding and an invocation-local Suspense reconciler.
  `dispatcher.stream()` emits bounded `shell | progress | replace | error | complete`
  events with stable-within-invocation boundary IDs, real backpressure, and
  AbortSignal cancellation; `dispatcher.dispatch()` remains the default final-only
  public API so existing generated entries keep working.
- 979738e: Expose the transport-installed `AgentRequestContext` as optional
  `context.request` to `defineOperation` handlers while preserving the same
  request handle returned by `agent()`. Identity axes remain honest `Observed`
  values with typed unavailable reasons when a transport cannot know them.
  
  Document `await agent()` as the route-component context contract and the
  `renderRoute(..., { context })` identity-injection seam for tests. Business
  input cannot override host, session, actor, workspace, or capability context.
- ad3bd24: Type `renderRoute` and `renderRouteEvents` (`agent-bundle/test`) against the project's own routes: the generated `.agent-bundle/routes.d.ts` registers each route's harness contract on the new `Register` interface of `@agent-bundle/runtime`, so a string-literal route id is checked against the compiled ids, `input` is typed from the route's `inputSchema` (an event route's `{ canonical, native }` payload), and `result` from its `resultSchema` (`undefined` for event routes). Add `Register`, `RegisteredRoutes`, `RegisteredRouteContract`, `RegisteredRouteId`, `RegisteredRouteInput`, and `RegisteredRouteResult` to `@agent-bundle/runtime`, and `RouteTargetConstraint`, `RouteTargetInput`, and `RouteTargetResult` to `agent-bundle/test`; a program without the generated file keeps the previous `string` / `unknown` types. (#456)
- 746a7ac: Add `useAgent()` to `@agent-bundle/runtime`, the synchronous convenience over `await agent()` for Server Components and server utilities that cannot await. It returns the identical request handle from the same realm-singleton store under the same lease rules — `outside-invocation` when no request is in the async context, `request-closed` on a handle captured from a completed request — and never suspends, because the handle is already resolved in the request's async context. (#402)
- 45feab5: Carry the route registration that `.agent-bundle/routes.d.ts` places on `@agent-bundle/runtime`'s `Register` through the rest of the public API, not only `renderRoute`, the way TanStack Router's one `Register` reaches `Link to`, `useNavigate`, and `RoutesByPath`. In `agent-bundle/test`, `invokeMcpTool` and `getMcpPrompt` now check a literal wire name against the registered tool/prompt names and type `input` from that route — of the literal `server` when one is passed, which is itself checked against the compiled server names (`McpInvocationOptions<Input, Server>`, `McpRouteNameConstraint`, `McpRouteInput`, `McpServerConstraint`, `McpRouteServer`); the `fixtures` of `runContractMatrix`, `runPackedContractMatrix`, `runDevEpochContractMatrix`, and `runInstalledHostContractMatrix` type each registered key's `input`, `inputs`, `cancellation.input`, and lifecycle transitions (`ContractRouteFixtures`, `ContractRouteFixture<Input>`, `ContractLifecycleFixture<Input>`, `ContractLifecycleTransition<Input>`) while MCP App keys and dynamic records stay legal; and `invokeCli` reports `CliInvocation.routeId` as a `RegisteredRouteId` (`argv` is unchanged). In `agent-bundle/eval`, `expectMcpCall` and `expectNoMcpCall` check a literal `tool` against the registered tools of a literal project `server` (`ExpectMcpCallOptions`, `ExpectNoMcpCallOptions`, `EvalMcpToolConstraint`); third-party servers stay free. `@agent-bundle/runtime` adds `RegisteredMcpRouteKind`, `RegisteredMcpServerName`, `RegisteredMcpRouteName`, and `RegisteredMcpRouteId` for the server and protocol names a registered id encodes. Type-only: nothing changes at run time, and every surface keeps its `string`/`unknown` shape when no project has registered. (#494)
- Updated dependencies [2e91ea1]
- Updated dependencies [8c8907e]
  - rsc-markdown-stream@0.1.1
