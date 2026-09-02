# Effect conventions (Wave 3.5)

Effect lives only in internals. The public authoring surface stays Promise +
zod: `await agent()`, route modules, `defineState`, every subpath export, and
generated artifact signatures. Effect never appears in user-facing types,
docs, or examples' user code. The four-concept newcomer ledger is untouched.

## Pin and vendored source

| Surface | Pin |
| --- | --- |
| npm `effect` | **`4.0.0-rc.112`** (exact). Latest published `rc` dist-tag on 2026-09-01. The Wave 3.5 brief named `4.0.0-rc.113`; that version was not on the registry. Re-pin chores take the next published RC. |
| Vendored tree | `repos/effect` via `git subtree` from [Effect-TS/effect](https://github.com/Effect-TS/effect.git) `main` (v4). Squash commit tracks `packages/effect` version **4.0.0-rc.112**. |

Application code imports the npm package. Never import from `repos/**`.

Read `repos/effect/LLMS.md` before writing Effect code. Refresh
`agent-patterns/effect-*.md` when the subtree moves.

## Boundary module

Each Effect-consuming package has exactly one `src/effect/boundary.ts`:

- [`packages/rsc-runtime/src/effect/boundary.ts`](../packages/rsc-runtime/src/effect/boundary.ts) — runtime + state kernel internals.
- [`packages/agent-bundle/src/effect/boundary.ts`](../packages/agent-bundle/src/effect/boundary.ts) — the dev seam (Stage 3). Maps interruption to `AbortError` and rethrows the dev seam's typed contracts (`CodedError` subclasses, `DiagnosticError`) unchanged.

The boundary owns:

- `runPromise` / `runSync` (plus `runPromiseExit` where a caller branches on `Exit`)
- `AbortSignal` ↔ interruption (`interruptWhenAborted`, `scopedAbortSignal`, `signal` on `runPromise`)
- mapping the Effect error channel onto the existing typed Error contracts

Ad-hoc `Effect.runPromise` / `Effect.runSync` (and `runFork` / `runCallback`
siblings) outside those files is a review-fail. rslint
`effect-boundary/no-ad-hoc-run` enforces it.

## Generator style

From `repos/effect/LLMS.md` (v4):

- Inline Effect code: `Effect.gen` + `yield*`.
- Reusable functions: `Effect.fnUntraced` on library hot paths;
  `Effect.fn("name")` when a tracing span is useful. The name string matches
  the function name.
- Do not write functions whose only job is to wrap and return `Effect.gen`.
- Attach extra behaviour with combinators (or extra `Effect.fn` arguments),
  not a `.pipe` after `Effect.fn`.
- Always `return yield*` when raising an error so TypeScript sees the rest of
  the function as unreachable.

Services: declare `class X extends Context.Service<X, Shape>()("pkg/path/X")`.
`serviceNotAsClass` is a language-service warning. Do not use variable-style
`Context.Service` assignments.

## Error mapping

zod stays at every schema boundary (MCP SDK interop; recorded G-decisions).
**Effect Schema is deferred** (re-evaluated 2026-09-01 for wire contracts; see
[Effect Schema wire contracts](#effect-schema-wire-contracts-schema-projections))
— do not introduce `Schema.TaggedError` on the public or MCP-facing contracts.
Internals keep the existing classes.

| Effect channel | Runtime contract |
| --- | --- |
| Success `A` | Promise resolves `A` |
| Fail `AgentRequestError` | rethrow (`invalid-invocation`, `outside-invocation`, `request-closed`, `store-version-conflict`) |
| Fail `AgentContractError` | rethrow (document / event / elapsed bounds) |
| Fail `AgentNoticeError` | rethrow (`aborted`, `invalid-input`, `request-closed`, `unauthorized`) |
| Fail `AgentStateError` | rethrow. Matched by `error.name` in the root boundary so `./state/contract` never enters the package-root graph. |
| Fail other `Error` | rethrow |
| Fail non-Error | `new Error(String(value))` |
| Interrupt only (`Cause.hasInterruptsOnly`) | `DOMException` `AbortError` |
| Die defect | rethrow if `Error`, else wrap |

`Observed` unavailable reasons and other fail-closed unions stay as they are
on the Promise edge. Do not widen public error types to satisfy Effect.

## Scope rules

- Resources: `Effect.acquireRelease` (or `acquireDisposable` for
  `Disposable` / `AsyncDisposable`).
- Close a scope with `Effect.scoped` / `Effect.scopedWith`. Do not leak
  `Scope` into a public Promise signature.
- Layers compose services. `Layer.scoped` when the layer needs `Scope`.
- Host `AbortSignal` at a Promise edge goes on `runPromise(..., { signal })`.
  Inside Effect, `interruptWhenAborted` or `yield* scopedAbortSignal`.

## Test helpers

Use `effect-rstest` when a test can return an Effect directly: `it.effect`
provides `TestClock` and `TestConsole`, while `it.live` keeps real services for
host I/O. Use `layer` for a shared service graph and scoped acquisition for
test resources. Keep ordinary rstest tests for Promise-only public APIs and
keep boundary-runner assertions on the package boundary they are testing.

## Streams and concurrency

Stage 2 uses Effect `Stream` for the #145 dispatcher: Flight bytes via
`Stream.unfold` that waits for event-stream demand *before* `reader.read()`,
pending boundaries via `Stream.paginate`, contract bounds as the emit stage
(`boundRenderEventStream` / `createAgentRenderEventSequence`), and progress
via `Stream.merge` + `takeUntil(complete)` (not `Stream.callback` — a failed
callback producer does not fail the stream). A `Latch` opened from the
public event-stream pull gates Flight bytes after the shell. Host
`AbortSignal` becomes `Stream.interruptWhen` + `abortToInterrupt` at the
public edge. Pattern files:

- [agent-patterns/effect-stream.md](../agent-patterns/effect-stream.md)
- [agent-patterns/effect-scope.md](../agent-patterns/effect-scope.md)
- [agent-patterns/effect-concurrency.md](../agent-patterns/effect-concurrency.md)
- [agent-patterns/effect-errors.md](../agent-patterns/effect-errors.md)

## Stage 3 (dev seam) outcomes

One subsystem per PR, all behind unchanged Promise APIs and wire contracts
(#158 boundary, #159 MCP session lifecycles, #160 rebuild scheduler,
#161 EpochStore). Leaf filesystem/SDK helpers stay imperative and are
identity-lifted through `src/effect/lift.ts`; the orchestration —
lifecycles, mutual exclusion, coalescing, compensation, failure
aggregation — is Effect.

**`ProjectEventHub` (the SSE hub) stays imperative.** Its public contract is
*synchronous* re-entrant fan-out: `publish` delivers to listeners in the same
turn (foreground shutdown depends on tombstone frames reaching socket buffers
before one `setImmediate`, `foreground-server.ts` documents the invariant),
`subscribe` replays retained history plus replay-gap frames synchronously,
and listener failures remove the subscription mid-dispatch. Effect `PubSub`
is an asynchronous fan-out structure; fiber-delivered events would change
that observable contract, and driving a `PubSub` through unsafe synchronous
drains would re-implement today's dispatch loop with none of Effect's
guarantees. Revisit only if the hub's consumers ever move onto fibers
end-to-end.

### Stage 3 helped / hurt addendum

Helped:

- `Semaphore.make(1)` + `withPermit` replaces hand-rolled mutual exclusion
  where admission order is not observable, including the process-wide
  per-project lease mutex map in the epoch store. It bounds access and
  releases the permit when the guarded effect exits; the public API does not
  guarantee FIFO waiter admission. Keep an explicit queue and ordering test
  wherever submission order is part of the contract.
- `Deferred` gives coalesced rebuild waiters one shared completion;
  `Effect.onExit` sits exactly where a `.finally` drain hook sat.
- `Effect.forEach(..., { concurrency: 'unbounded' })` with per-element
  `Effect.exit` is the exact analogue of `Promise.allSettled` for
  settle-then-aggregate teardown contracts (`McpSessionServiceCloseError`,
  `EpochCleanupError`, publication rollback `AggregateError`).
- `Effect.gen({ self: this }, function* (this: X) { ... })` keeps `#private`
  member access inside class-internal Effect programs.
- `Effect.acquireRelease` + a transferred-ownership flag models "release on
  failure only until the constructed resource takes ownership" (MCP session
  open chain).

Hurt / gotchas:

- Effect finalizers are infallible by type. Teardown contracts that
  *propagate* cleanup failures (the dev seam's last-failure-wins `finally`
  chains, the staging-root removal that replaces the publish outcome) must be
  explicit effect sequences — capture the attempt's `Exit`, run the cleanup,
  then unwrap — never scope finalizers.
- Bare `Effect.tryPromise(fn)` wraps rejections in `Cause.UnknownError`;
  always route through `src/effect/lift.ts` so typed dev errors and raw
  rejection values (`AbortSignal.reason`) cross the boundary untouched.
- Synchronous admission windows are load-bearing: same-turn rebuild
  coalescing and session-close invalidation must not move inside a fiber.
  Construct `Semaphore`/`Deferred` with the boundary's `runSync` and keep the
  admission bookkeeping synchronous.

## Stage 4 (#99 notice ledger) outcome

The optional notice ledger composes state-kernel reads and dispatches inside
Effect programs, runs publish- and delivery-time authorization on the typed
error channel, and crosses back to the public Promise API only through the
runtime boundary. It adopts no unstable Effect modules and starts no fibers,
timers, or workers between invocations.

## Workbench browser state (#105 phase 1)

The Workbench (`packages/workbench`) is an internal React client, never a
published API surface; its dist ships inside the `agent-bundle` package as
static assets.

Exact-pin `effect` + `@effect/atom-react` (synchronized with the repo's effect
pin, currently `4.0.0-rc.112`) are allowed there, but only in dedicated
browser-state modules (`src/runtime/agent-document-atoms.ts`,
`src/routes/route-editor-atoms.ts`, and `src/discovery/discovery-atoms.ts`).
The discovery module owns report loading plus ephemeral live-probe consent
and result state. Atoms live in `effect/unstable/reactivity`; React bindings come from
`@effect/atom-react`.

- No `Atom` or `AsyncResult` types in DTOs, public exports, or examples —
  atoms consume the strictly-decoded outputs of the existing zod clients and
  never replace wire contracts.
- One root `RegistryProvider` mounted in the app shell (`src/main.tsx`); the
  module-level default registry is never used.
- Components never call `Effect.run*` — the registry owns effect execution;
  components interact through the `@effect/atom-react` hooks only (rslint
  `effect-boundary/no-ad-hoc-run` already enforces the run ban).
- Imperative clients (`ProjectClient`, `RuntimeClient`, `AgentDocumentClient`,
  …) stay the lifecycle authorities; atoms are read-side caches over their
  decoded outputs.
- Known caveat: `4.0.0-rc.112` has a stream-backed derived-atom disposal bug
  (fixed upstream post-rc.112, unpublished) — no stream-backed derived atoms
  in the Workbench until a re-pin past the fix; the root `RegistryProvider`
  (not the default registry) avoids the reported React case.
- Every effect re-pin must bump `@effect/atom-react` to the same RC in the
  same chore, re-run the Workbench disposal regression test, and re-measure
  the Workbench production bundle (the rsbuild build emits the size table).

## Effect platform services (@effect/platform-node)

Evaluated 2026-09-01 against `effect@4.0.0-rc.112` +
`@effect/platform-node@4.0.0-rc.112`; **decision = not adopted** this RC
cycle (missing `lstat`/`O_NOFOLLOW`/inode primitives for hardened fs
protocols; `runMain` cannot express the 130/143 signal-distinct exit
contract); revisit at GA.

Effect platform services are optional inside Effect-native internals, not a
blanket replacement for `node:fs` or `node:path`. Use them when portable
ordinary I/O materially improves service substitution or scoped ownership, and
provide only the narrow `NodeFileSystem`/`NodePath` layers at an existing
Effect boundary. Keep raw Node APIs for compiler and generated-entry code,
synchronous SQLite setup, `lstat`/`O_NOFOLLOW`, inode/link identity,
directory-fsync and atomic-publication protocols, transferred resource
ownership, or bespoke process exit contracts. Map `PlatformError` to the
existing typed contract at one boundary. Use scoped temporary paths only in
tests already Effect-native; do not convert Promise-contract tests solely for
fixture cleanup. Treat `layerNoop` as a selective stub, not an in-memory
filesystem.

## Effect Schema wire contracts (Schema projections)

Evaluated 2026-09-01 against `effect@4.0.0-rc.112` for the wire-contract
seams (dev-server DTO routes ↔ Workbench strict decoders, IPC #209, native
event envelope #279); **decision = not adopted** this RC cycle. In rc.112,
`Schema`, `SchemaAST`, and `SchemaParser` are stable top-level modules, not
`effect/unstable/*`. The `Schema.toType` / `Schema.toEncoded` projections are
present and match the current v4 docs: their signatures operate over
`Schema.Constraint`, preserve checks, and use the same `decodeUnknown*` parse
family. Revisit at Effect GA or the first time a wire contract genuinely
diverges between its encoded and decoded sides.

The projections currently have nothing to bridge on the audited JSON DTO
routes: timestamps are strings, there are no `Date`, `bigint`, `Map`, `Set`,
or transformations, and the encoded and type sides are structurally
identical. That claim does not cover every export under `contracts/*`.
`McpSessionTraceEntry.occurredAt` preserves a numeric Unix timestamp, and
`DevRuntimeAsset.body` carries a `Uint8Array` through `contracts/runtime.ts`;
neither is one of the audited JSON DTO routes. `toType` / `toEncoded` would
therefore be near-identity at the audited seams. The real dual maintenance —
contract types plus separately hand-written Workbench decoders — is a
single-source-of-truth problem that the pinned zod can already solve with
`z.infer`; it does not require a second schema runtime.

Strictness is also call-site-fragile. Effect Schema rejects unknown keys only
through the per-decode `onExcessProperty: "error"` parse option, whose default
is `"ignore"`, rather than carrying exact-key rejection on the schema value
like `z.strictObject`. After the PR #121 exact-key regression, strictness must
travel with the schema value instead of being re-asserted at every decode
site.

zod cannot leave: MCP SDK interop and the public authoring surface keep it
pinned, so Schema would add a second schema runtime to the Workbench browser
bundle. Measured on the Workbench toolchain (rsbuild/rspack all-in-one,
minified, rc.112), a minimal strict `Struct` decode adds +46.5 kB minified /
+14.6 kB gzip on top of the already-shipped atoms runtime. Standalone
fixtures measure Effect Schema at 101.5 kB / 33.4 kB gzip versus zod at
62.4 kB / 16.8 kB gzip.

The diagnostics do not fit these seams either. Workbench clients deliberately
collapse decode failures into single AB-coded errors such as `AB8233` and
`AB8063`, so `SchemaIssue` / `Formatter` trees add nothing there.
`config/validate.ts` contains business-rule diagnostics — AB code, severity,
and recovery per rule — rather than shape validation.

zod stays at every wire/schema boundary under the existing G-decisions, and
the hand-rolled exact-key guards stay. If a future contract needs real
encoded/decoded divergence shared by server and client, pilot Schema plus
projections on that single contract before any wider adoption.

## Banned modules and APIs

- `Effect.runPromise` / `runSync` / `runFork` / `runCallback` (and `*With` /
  `*Exit` siblings) outside `src/effect/boundary.ts`.
- Imports from `repos/**`.
- Effect Schema on public or zod boundaries.
- `@effect/vitest` — this repo uses rstest.
- `NodeRuntime.runMain` / `BunRuntime` as a substitute for the boundary.
- Ad-hoc `ManagedRuntime` outside a boundary module.
- `effect/unstable/*` until listed below (Stages 2, 3, and the #99 notice ledger listed none).

## Unstable-module adoptions

Re-pin chores re-verify every row. Stage 2 adopts none: Flight is a React
binary stream, not Ndjson/SchemaBinary, and no other `effect/unstable/*`
module fits the dispatcher rewrite. Stage 3 also adopts none: the dev seam
needed only stable `Semaphore`, `Deferred`, `Scope`, and `Exit`.
The #99 notice ledger also adopts none: it needs only stable `Effect` and
`forEach` over the existing Promise-returning state authority. Declined rows
record evaluated-and-rejected surfaces; see [Effect platform
services](#effect-platform-services-effectplatform-node) and [Effect Schema
wire contracts](#effect-schema-wire-contracts-schema-projections).

| Module | Adopted in | Re-verify |
| --- | --- | --- |
| `effect/unstable/reactivity` (+ `@effect/atom-react` bindings) | Workbench Agent Document panel (#105 phase 1) and route editor (#105 phase 2) | re-pin bumps @effect/atom-react in lockstep; re-run disposal regression + bundle measurement; stream-backed derived atoms stay banned until the rc.112 disposal fix ships |
| `@effect/platform-node` (`NodeFileSystem` / `NodePath`) | **declined** (2026-09-01) | revisit at Effect GA; re-pin re-evaluates lstat/O_NOFOLLOW/inode primitives + `runMain` 130/143 exit contract |
| `Schema` / `SchemaAST` / `SchemaParser` projections (`toType` / `toEncoded`) for wire contracts | **declined** (2026-09-01) | revisit at Effect GA or on the first encoded/decoded-divergent wire contract; re-pin re-checks the projections API and the `onExcessProperty` parse-option default |

## Language service

`tsconfig.base.json` loads `@effect/language-service` (via `@effect/tsgo`).
`outdatedApi` and `serviceNotAsClass` are warnings. `npx @effect/tsgo setup`
is the official installer; this repo pins the plugin config in
`tsconfig.base.json` so the same rules apply to every package that extends it.
`.vscode/settings.json` enables the TypeScript 7 / tsgo workspace SDK
(`js/ts.experimental.useTsgo`). We do not add a `prepare` hook that runs
`effect-tsgo patch` — that mutates `typescript` on every install. Re-run
`npx @effect/tsgo setup --non-interactive` during a re-pin if the editor
wiring drifts.

## Cold-start budget

Generated stdio hooks run under host deadlines. Stage 0 baseline (generated
`claude` SessionStart hook, bare `node <hook>` process, 7 samples, Node
v22.23.1, 2026-09-01): **median 39.74 ms**, min 36.41 ms, max 43.06 ms.
Adding the `effect` dependency changed no generated artifact — no runtime
entry (`index.js`, `state.js`, `state/sqlite.js`, `plugin.js`) imports it
until Stage 1+. Machine-readable copy:
[effect-cold-start-baseline.json](effect-cold-start-baseline.json). Stage 2
must not regress it: `pnpm bench:hook-cold-start -- --check`.

## Re-pin chore

1. Bump the exact `effect` version in `packages/rsc-runtime/package.json`.
2. Synchronize `@effect/atom-react` in `packages/workbench/package.json` to
   the same RC; re-run the Workbench disposal regression test and production
   bundle measurement (rsbuild size table).
3. `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash`.
4. Re-read `repos/effect/LLMS.md` and refresh `agent-patterns/effect-*.md`.
5. Re-verify every unstable-module row and the language-service diagnostics.
6. Re-run the hook cold-start check.
