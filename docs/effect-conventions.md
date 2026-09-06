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
| `website` TypeScript | Native **`7.0.2`** runs `tsc`; the `typescript-6` alias stays on **`6.0.3`** for TypeDoc, Twoslash, and `rspress.config.ts` compiler-API calls. `.pnpmfile.cjs` turns those plugins' TypeScript peers into dependencies, and the scoped overrides in `pnpm-workspace.yaml` isolate them from TypeScript 7. Re-pin chores update the alias and overrides together. |

Application code imports the npm package. Never import from `repos/**`.

Read `repos/effect/LLMS.md` before writing Effect code. Refresh
`agent-patterns/effect-*.md` when the subtree moves.

## Boundary module

Each Effect-consuming package has exactly one `src/effect/boundary.ts`:

- [`packages/rsc-runtime/src/effect/boundary.ts`](../packages/rsc-runtime/src/effect/boundary.ts) — runtime + state kernel internals.
- [`packages/agent-bundle/src/effect/boundary.ts`](../packages/agent-bundle/src/effect/boundary.ts) — the dev seam (Stage 3). Maps interruption to `AbortError` and rethrows the dev seam's typed contracts (`CodedError` / `YieldableCodedError` subclasses, `DiagnosticError`) unchanged.
- [`packages/create-agent-bundle/src/effect/boundary.ts`](../packages/create-agent-bundle/src/effect/boundary.ts) — the scaffolder (FileSystem phase 1). Rethrows `UsageError` / `Error` unchanged; unwraps `PlatformError` to its Node cause.

The boundary owns:

- `runPromise` / `runSync` (a caller that branches on `Exit` wraps its program in `Effect.exit`)
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

### Yieldable framework errors (`Data.Error`, decided 2026-09-03)

Framework-process error classes — the ones raised inside Effect programs in
the dev seam and the eval service whose declarations no package export
reaches (today: `DevCoordinatorCloseError`, `RuntimeMcpRegistryError` /
`RuntimeMcpRegistryCloseError`, `RuntimeGenerationStoreError` /
`RuntimeGenerationStoreCloseError`, `DevRuntimeProviderLoadError`,
`ScriptPlaygroundFailure` / `ScriptPlaygroundAbortError`,
`LifecycleReplayRequestError`, `ArtifactInspectionServiceError`,
`HookSimulationAbortError` / `HookSimulationTerminationError`,
`CodexEvalHarnessError`, `SmokeStepError`) — extend the yieldable bases in
[`packages/agent-bundle/src/effect/errors.ts`](../packages/agent-bundle/src/effect/errors.ts):
`YieldableFrameworkError` (the `Data.Error` twin of `Error`, same
`(message?, options?)` constructor) and `YieldableCodedError<TCode>` (the
twin of `CodedError`, same `(name, code, message, options?)` constructor and
`code` field). A program raises one with `return yield* new X(...)`;
`Effect.fail(new X(...))` still works and existing call sites were not
churned. Untagged on purpose: `Schema.TaggedError` stays deferred, `catchTag`
is not the goal, and recovery keeps using `Effect.catch` + `instanceof` /
`error.code`.

What does not change: `instanceof Error` / `instanceof X`, `.name`,
`.message`, `.code`, `.cause`, `.stack`, the boundary's identity-preserving
rethrow (`isTypedDevError` matches the string `code`), `JSON.stringify`,
`stableJson`, `{ ...error }`, and `util.inspect`. rc.112 `Data.Error` would
otherwise change the last four — its prototype `toJSON` spreads the
constructor fields (`message`, `cause`) into the JSON and its
`[nodejs.util.inspect.custom]` prints that instead of the stack — so the
base shadows both with non-functions and installs `cause` non-enumerable;
`tests/effect-errors.test.ts` pins byte-identical output against the plain
twin. Migration is mechanical per file: swap the `extends` clause, import
the base; constructors and call sites stay.

Carve-outs — these stay on plain `Error` / `CodedError`, and a class that
moves into one of these positions moves back:

- **Effect-free entry graphs.** `src/effect/errors.ts` imports `effect`.
  `CodedError` (`core/errors.ts`) and `DiagnosticError`
  (`core/diagnostics.ts`) sit on `agent-bundle/config` (`CapabilityStateError`),
  `agent-bundle/meta` and `agent-bundle/rstest` (`MetaUnavailableError`), the
  host MCP proxy (`DevLockError`), and the CLI's `--help` / `--version` path
  (`cli.test.ts` fails the trivial invocations that resolve an `effect`
  module, #530). Measured: the base swap would put a static `effect` import
  on all five entries. `McpAppBridgeCloseError` stays plain for the same
  reason (`agent-bundle/rstest` and `agent-bundle/test/browser` reach it).
- **The public declaration graph.** Any class whose declaration file a
  `package.json` export's `types` reaches — not only classes that are
  themselves exported. A consumer's `tsc` resolves every `.d.ts` the entry
  imports, so `class X extends YieldableCodedError` in a reachable file
  makes `effect` a type dependency of the package (`public-api.test.ts`'s
  root-declaration consumer failed exactly this way with `McpSessionError`
  migrated: `dev/mcp-session/mcp-session-types.d.ts` is reached from `.` and
  `./api` through the dev types). That keeps plain: everything exported from
  an entry (`Agent*` and `McpProjectionError` in `@agent-bundle/runtime`,
  `CliUsageError` / `CliInputError`, `EventRuntimeTransportError`,
  `Eval*Error` on `agent-bundle/eval`, `EvalServiceError`, `AgentTestError`,
  `BrowserAppTestError`, `UsageError` in `create-agent-bundle`) and the
  dev-seam classes the root / `api` / `eval` declaration graphs reach
  (`McpSessionError` and its stale-epoch / close siblings,
  `EpochStoreError` and the epoch cleanup / durability errors,
  `ProjectEventHubError`, `HostMcpEpochDriftError`, `AgentApiCloseError`,
  `DevLogServiceError`, `DevServerStartError` /
  `DevServerLifecycleCloseError`, `ForegroundServer*Error`,
  `DevRuntimeUnavailableError` / `DevRuntimeGenerationConflictError`,
  `PlaygroundService*Error` / `PlaygroundSessionCloseError`,
  `HookPlaygroundCloseError`, `McpProbeTargetNotFoundError`,
  `McpAppRuntimePreviewError`, `SkillDocumentError`,
  `InspectorLauncherError`, `EvalRunEvent*Error`, and
  `EvalServiceBackgroundFailureOverflowError`). The `@agent-bundle/runtime`
  `plugin` entry also has no `effect` import today.
  `public-api.test.ts` "keeps every public declaration graph free of effect"
  walks each export's emitted `.d.ts` graph and fails on any `effect`
  import; a class is eligible for the yieldable base only while that test
  stays green with it migrated.
- **Emitted artifacts.** Hook wrappers, CLI bins, and the framework MCP
  shell bundle `src/effect/boundary.ts` (plain `CodedError`); the raw stdio
  MCP server and `install.mjs` carry no Effect at all. Measured on the
  `examples/host-test` build: all 66 emitted files byte-identical in size
  before and after the migration.
  `tests/emitted-artifact-effect-surface.test.ts` (integration lane, reads
  the built `dist`) pins that no emitted file contains the yieldable base,
  the Effect-free classes stay Effect-free, and hook wrappers keep the plain
  `CodedError`.
- **Workbench** client errors (`AB82xx`): browser code; `effect` is allowed
  only in the atom modules.

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
- `scopedAbortSignal` is `Effect.abortSignal`, which in rc.112 is exactly
  `acquireRelease(sync(() => new AbortController()), c => sync(() => c.abort()))`
  mapped to `.signal`: it aborts only when the owning scope closes, always
  with no reason, and never hands out the controller. A contract that must
  abort *with a reason* on a caller's request (the MCP session's `cancel()`
  and close-time `#cancelAll`, whose reason reaches the SDK rejection) owns
  its `AbortController` as the scoped resource instead — `acquireRelease`
  admits the slot and returns the controller, release aborts it and frees
  the slot, and the host signal is joined with `AbortSignal.any` (#512,
  `dev/mcp-session/mcp-session.ts` `#admitRequest`). That is the same
  shape as `Effect.abortSignal`, not a bare `new AbortController()` inside
  `Effect.gen`.
- `agent-patterns/effect-scope.md` § AbortSignal once cited a
  language-service rule, `abortControllerInEffect`, that does not exist in
  `@effect/language-service@0.87.2` (corrected in the pattern; kept here so a
  re-pin re-checks it). The `*InEffect*` rules that ship are `cryptoRandomUUIDInEffect`,
  `globalConsoleInEffect`, `globalDateInEffect`, `globalErrorInEffectCatch`,
  `globalErrorInEffectFailure`, `globalFetchInEffect`, `globalRandomInEffect`,
  `globalTimersInEffect`, `lazyPromiseInEffectSync`, `processEnvInEffect`,
  `schemaSyncInEffect`, `tryCatchInEffectGen`, and `unknownInEffectCatch`.
  No rule flags a raw `AbortController`; review enforces the bullet above.

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
(`emitBoundRenderEvent` / `createAgentRenderEventSequence`), and progress
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

- Scope finalizers are infallible by type — `Effect.acquireRelease` takes a
  `release: (a, exit) => Effect<unknown, never, R>` and `Effect.addFinalizer`
  an `Effect<void, never, R>` — so a release that can fail cannot even be
  written there. `Effect.acquireUseRelease`'s `release` and `Effect.onExit`
  / `Effect.ensuring` handlers are **not** infallible: rc.112 types them
  `Effect<void, E3, R3>` and merges a failing handler into the result
  (`combineFinalizerCause` → `Cause.combine(useCause, handlerCause)`). That
  merged cause is first-failure-wins once it reaches the boundary:
  `Cause.squash` returns the *first* `Fail` reason, which is the `use`
  failure, and the cleanup failure is dropped. Teardown contracts that
  *propagate* cleanup failures last-failure-wins (the dev seam's `finally`
  chains, `DevCoordinatorCloseError` in `dev/coordinator.ts` #513, the IPC
  claim release and socket removal in `events/ipc.ts` #516, the staging-root
  removal that replaces the publish outcome) are therefore explicit effect
  sequences — `Effect.exit` on the attempt, run the cleanup, aggregate,
  then unwrap — under `Effect.uninterruptibleMask` where the original
  `finally` was uninterruptible. Neither scope finalizers nor
  `acquireUseRelease` express that ordering.
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

Re-evaluated 2026-09-03 against `effect@4.0.0-rc.112` +
`@effect/platform-node@4.0.0-rc.112`; **decision = adopted for ordinary
filesystem I/O and path operations** (the 2026-09-01 decline is superseded).
`FileSystem.FileSystem` and `Path.Path` from the `effect` package are the
sanctioned way for framework code to touch the filesystem. The Node
implementations come from `@effect/platform-node` (`NodeServices.layer`) in
`create-agent-bundle`, which bundles its dependencies, and from
`@effect/platform-node-shared` (the package that implements
`NodeFileSystem` / `NodePath` / `NodeChildProcessSpawner` / `NodeStdio` /
`NodeTerminal` / `NodeCrypto`; `@effect/platform-node`'s modules are
re-exports of it) in `agent-bundle`, which every consumer installs:
`@effect/platform-node@rc.112` would add `undici`, `mime`, and — through a
non-optional `redis` peer that npm auto-installs — a Redis client (+23 MB,
+17 packages) to each consumer install. `agent-bundle`'s `platformLayer`
composes the same six services the same way `NodeServices.layer` does. The
`ws` / `@types/ws` / `@types/node` dependencies of `platform-node-shared`
(≈4 MB) do land in consumer installs. The API gap that
motivated the decline is still real and is what the keep-raw list below
encodes: the pinned `FileSystem` has no `lstat`, `OpenFlag` accepts only
string flags (no `O_NOFOLLOW`), and there is no directory fsync.
`NodeRuntime.runMain` stays banned (the 130/143 signal-distinct exit
contract). The same package's `Terminal` and `Stdio` services are adopted for
the first-party CLI's user-facing text — see
[Terminal and Stdio](#terminal-and-stdio-user-facing-cli-text).

### Adopt

- Ordinary reads, writes, `mkdir`, `readDirectory`, `stat`, `exists`,
  `remove`, `rename`, `copy` in code that already runs (or is being moved)
  inside an Effect program: `yield* FileSystem.FileSystem`, then the method.
  `readDirectory` returns names only — `stat(...).type === 'Directory'`
  replaces `Dirent.isDirectory()`.
- `Path.Path` for `join` / `resolve` / `dirname` / `fromFileUrl` in the same
  modules. `fromFileUrl` fails with `BadArgument`; `Effect.orDie` it when the
  URL is built from `import.meta.url`.
- Temporary directories whose lifetime ends with the enclosing operation:
  in `agent-bundle`, `withTempDirectory(options, use)` from
  `src/effect/platform.ts`, the bracket that reproduces `mkdtemp` +
  `try`/`finally` `rm(dir, { recursive: true, force: true })` exactly —
  `force`, cleanup failure as a typed `PlatformError` that wins over the
  operation's failure, cleanup on interruption. Not
  `fs.makeTempDirectoryScoped` in library code: the rc.112 finalizer removes
  without `force` and `orDie`s, so an operation that deleted its own staging
  directory would fail an already successful call, and a real cleanup error
  would surface as the `PlatformError` wrapper (scope finalizers cannot fail
  typed).   Tests may use `makeTempDirectoryScoped` for fixtures.
  Same shape for a staging *file*: `ensuringRemoved(path, use)` is the
  `try`/`finally` `rm(path, { force: true })` bracket behind
  `withTempDirectory`; `routes/typegen.ts` uses it around its
  write-then-rename of `.agent-bundle/routes.d.ts`.
  **Not** when ownership of the directory is
  transferred to a longer-lived object (the MCP session plugin-data dir in
  `dev/mcp-session/mcp-session-service.ts`): a scoped temp is removed when
  the scope closes, which is too early there.
- File handles whose use is bounded by one program: scoped `open`.
- Text reads: `readFileString(path)` / `readFileBytes(path)` from
  `src/effect/platform.ts`, not `fs.readFileString`. The service method
  decodes through `TextDecoder`, which drops a leading UTF-8 BOM; Node's
  `readFile(path, 'utf8')` keeps it as U+FEFF, and the migrated sites parse
  JSON and digest what they read, so the bytes must decode as before.
  `isPlatformErrno(error, ...codes)` is the `isErrno` check for a failure
  that may still be wrapped in a `PlatformError`, for programs that branch
  on `ENOENT` / `ENOTDIR` / `ELOOP` the way their `try`/`catch` did.
- Mixed modules: when one function pairs a link-identity check (`lstat`,
  `realpath`, `Dirent.isDirectory()`, `O_NOFOLLOW`, `dev`/`ino`) with
  ordinary reads, the ordinary reads move to the service and the identity
  check stays on `node:fs` with a one-line comment at the site. Do not
  replace `lstat` with `stat` to finish the migration: `stat` follows the
  link, and every one of those checks exists to refuse it.
- Layer wiring: one composition root per process. The scaffolder provides
  `NodeServices.layer` immediately before its boundary's `runPromise`
  (`src/scaffold-cli.ts`, loaded by `runCli` only once a scaffold is
  requested); `agent-bundle`'s public API functions provide `platformLayer`
  through `runWithPlatform`; the first-party CLI's root is the
  `makeCliTerminal(services)` in `src/effect/cli-runtime.ts` (today
  `NodeTerminal` + `NodeStdio`, built on the first command write, see
  [Terminal and Stdio](#terminal-and-stdio-user-facing-cli-text)) and widens
  to `platformLayer` there when CLI code adopts the filesystem services; the
  dev server has one `makeScopedEffectRuntime(platformLayer)`, created
  inside `startDevServer` (never at module top level — `effect` is a CLI
  cold-start cost) and disposed from the returned session's `close` after
  every service has closed (`createDevPlatformRuntime` in
  `src/dev/platform-run.ts`). Every dev service takes the runtime as an
  optional `platformRuntime` constructor option typed as `DevPlatformRuntime`
  (`src/dev/platform-runtime.ts`), a deliberately Effect-free handle with only
  `close()`: service options sit on the package's public declaration graph,
  which `public-api.test.ts` keeps free of `effect` imports. The service's
  implementation resolves the handle to its `PlatformRun` edge with
  `platformRunOf(options.platformRuntime)` (`runWithPlatform`'s signature
  over the long-lived runtime, `PlatformError` unwrapped the same way);
  absent a handle, `platformRunOf` returns `runWithPlatform`, so the services
  stay usable on their own. Both modules live under `dev/`, not in
  `platform.ts` — that module is bundled into the emitted installer, which
  stays byte-identical. Never provide a platform layer deep inside library
  code.
- Errors: `PlatformError` flows through the Effect error channel and is
  mapped once, at the boundary, onto the existing contract. Where a
  user-facing AB#### diagnostic already exists for the failure, map to it
  without changing the code or message. Where the contract is "print the
  Node error" (the scaffolder), unwrap `PlatformError.cause` to the
  `ErrnoException` so messages stay byte-identical.
- Tests: `FileSystem.layerNoop({ ...overrides })` for call/result/error
  protocol tests — its defaults fail with `NotFound` or die, so override
  every operation the code under test performs. Keep real temp directories
  (`makeTempDirectoryScoped` under `it.effect` / `it.live`) for anything
  about symlinks, permissions, atomic rename, SQLite, or packed executables.
  Do not convert Promise-contract tests solely for fixture cleanup.

### Keep raw (`node:fs` / `node:path`) — explicit carve-outs

- `core/durable-fs.ts` and everything that publishes through it: epoch
  store, playground stores, eval run-store, dev-lock, receipts. They need
  `lstat`, `O_NOFOLLOW`, inode identity, directory fsync, `wx` exclusive
  create, and same-filesystem atomic rename.
- `install/*` and `doctor`: `lstat` containment walks, symlink refusal,
  same-fs staging, `wx` receipt creation, atomic rename. Ordinary stage
  directories there move to `makeTempDirectoryScoped` only once the
  installer body itself is Effect-native.
- `events/ipc.ts` inode locks (`open` with `wx` + `stat` identity + Linux
  start time).
- `eval/workspace-diff.ts`: hashes through an `O_NOFOLLOW` descriptor and
  compares its `dev`/`ino`/`nlink` with the discovering `lstat`; `opendir`
  for `Dirent` kinds. `build/validate-artifact.ts` `snapshotManifest`
  (`lstat` / read / `lstat` `dev`/`ino` identity), the `lstat` rows in
  `pack-inventory.ts`, `eval/artifact.ts`, `eval/fixtures.ts`,
  `eval/graders.ts`, and the `Dirent`-typed listings in `eval/codex-plugins.ts`
  and `host-contracts/*` `symlinkDiagnostics` (a symlinked directory is not a
  directory to them). `declaration-diagnostics.ts`'s synchronous `existsSync`
  probe beside `createRequire`'s synchronous resolution.
- Synchronous SQLite setup (`rsc-runtime/src/state/sqlite.ts`).
- Dev-server durable protocols and identity checks: `dev/epoch-store.ts`,
  `dev/dev-lock.ts`, `dev/runtime-generation-store.ts`'s publish path
  (`wx` manifest, non-recursive `mkdir`, `rename`, `lstat`-verified assets;
  only its manifest / asset reads and recursive `mkdir`s are programs),
  `dev/playground/native-playground-service.ts`'s catalog publication
  (`link` / `open` / `rename` / `lstat`, rollback quarantine),
  `dev/host-install-manager.ts`'s `lstat` rows, `mkdtemp` + `cp`
  (`verbatimSymlinks`, `errorOnExist`) staging and atomic `rename` swap,
  `dev/eval/eval-service.ts`'s `O_NOFOLLOW` evidence reader, the
  `lstat` / `realpath` containment in `dev/skill-document-service.ts` and
  `dev/project-service.ts`, `dev/package-build-service.ts`'s `rmdir`
  pruning (no `FileSystem` equivalent with its "not empty" contract), and
  `dev/playground/mcp-probe-service.ts`'s retrying teardown `rm`
  (`maxRetries` / `retryDelay` have no `FileSystem.remove` option), and
  `dev/playground/lifecycle-replay-service.ts`'s synchronous `existsSync`
  probe.
- `dev/watcher.ts`: chokidar stays. `FileSystem.watch` is a thin `fs.watch`
  with create/update/remove only — no `ignored` callbacks, readiness, or the
  other event kinds — and the watcher's `dev:ino` signatures need `stat`
  semantics we do not want to change.
- Synchronous config/discovery on the compiler and cold-start path
  (`config/validate.ts`, `config/conventional-entry.ts`,
  `core/project-context.ts`), Rspack/rslib compiler I/O (`build/rslib.ts`),
  and Rspack loader/plugin hot paths.
- Every **emitted** artifact: generated hook wrappers
  (`adapters/hook-contract.ts`), `build/entry-shell.ts` shells, `bin/*.mjs`
  templates, and the installer surface strings (`install/surface.ts`). They
  must not depend on an Effect runtime at run time (see the cold-start
  budget).

### Boundary modules

`packages/create-agent-bundle/src/effect/boundary.ts` is the scaffolder's
sole run edge (phase 1 pilot): `runPromise` rethrows `UsageError` and plain
`Error` unchanged and unwraps `PlatformError` to its Node cause.
`src/scaffold-cli.ts` provides `NodeServices.layer` once; `src/index.ts`
(`runCli`) parses argv, answers `--help` and flag errors itself, and loads
that module with a dynamic `import()` only for an actual scaffold. Measured
on rc.112 (bundled by Rslib, `node` target): the bundle grew from 73.7 kB to
456.8 kB with `NodeServices.layer` (264.7 kB with only `NodeFileSystem` +
`NodePath`); packed tarball 33.0 kB → 110.2 kB. Rslib splits the dynamic
import into its own chunk (`dist/scaffold-cli.js`, 447.5 kB; the argv layer
is 10.8 kB), so `--help` no longer evaluates it: cold start ≈40 ms before
`NodeServices.layer`, ≈65 ms with it evaluated eagerly (the 2026-09-03
regression, ≈69 ms on the 2026-09-03 re-measurement below), ≈40 ms with the
split. `undici` is not pulled into the bundle.

`packages/agent-bundle/src/effect/platform.ts` owns the framework's platform
layer: `platformLayer` (the `NodeServices` union composed from
`@effect/platform-node-shared`), `withTempDirectory`, `ensuringRemoved`,
`unwrapPlatformError`, `isPlatformErrno`, `readFileString` /
`readFileBytes`, and `runWithPlatform`, which provides the layer and
unwraps `PlatformError` before handing off to `boundary.ts`'s `runPromise`.
It is the only module that imports `effect/PlatformError` at run time
(`import type` is erased and fine): `boundary.ts` is bundled into every
emitted hook wrapper, and the error class would drag `Data.TaggedError`
into each one (measured: +12 kB per hook). Phase-1 callers are the
throwaway artifact in `api.ts` (`listMcp` / `invokeMcp` / `runMcp` /
`listHooks` / `simulateHook` without `artifact`) and the Codex validator's
schema-generation directory, both through `withTempDirectory`, and
`routes/typegen.ts`'s `writeRouteTypesProgram` (the atomic `routes.d.ts`
publish, through `ensuringRemoved`; `writeRouteTypes` keeps its Promise
signature via `runWithPlatform`). Phase 2 (ordinary-I/O modules, behind
command dispatch, 2026-09-03) moved the ordinary reads, copies, and temp
directories of `host-contracts/{claude,cursor,portable}-plugin-validation.ts`
and `native-codex-contract.ts`, `services/{hook-service,mcp-service,mcp-run}.ts`
(the MCP client's plugin-data directory is a `withTempDirectory` bracket;
`mcp-run`'s SIGINT/SIGTERM forwarding is a scoped `acquireRelease`), the
`eval/*` harness readers, `fixtures.ts` materialization and the Codex trial
home, and the post-build readers `build/validate-artifact*.ts`,
`pack-inventory.ts` — each through `runWithPlatform` at its existing
Promise signature, with the link-identity checks kept raw per the
carve-outs above. The sibling `routes/graph.ts` reads stay raw:
`compileRouteGraph` is the compiler/cold-start discovery path, and lifting
only its two async reads would add an Effect runtime per compile for
nothing. Emitted artifacts, hook wrappers, compiler hot paths, and the
modules `cli.ts` loads eagerly never import this module (`cli.test.ts`
fails if `--version` / `--help` resolve an `effect` module). The dev server
(phase 2, second PR, 2026-09-03) runs on one
`makeScopedEffectRuntime(platformLayer)` created in `startDevServer`
(`dev/platform-run.ts`) and handed to every service as the Effect-free
`platformRuntime` handle (`dev/platform-runtime.ts`), resolved to its edge
with `platformRunOf`: the ordinary reads, temp directories, and removals of
`dev/project-service.ts`, `package-build-service.ts`,
`host-install-manager.ts`, `skill-document-service.ts`,
`workbench-assets.ts`, `runtime-provider-loader.ts`,
`playground/{hook,host-discovery,mcp-probe,native,script}-playground-service.ts`,
and `eval/eval-service.ts`. `runtime-generation-store.ts` reads through
`FileSystem` too but on `runWithPlatform`: providers construct it through
the public `createRuntimeGenerationStore` factory, whose effect-free options
contract (`runtime-store-contracts.ts`, exported from `agent-bundle/api`)
has no session runtime to hand it. Two directories outlive their call and are
therefore not `withTempDirectory` brackets: the MCP session's plugin-data
directory is acquired into its own session-lifetime `Scope` whose only
finalizer removes it — the session closes that scope from `close()`, and
until the session exists the open scope's release closes it instead — and
the script playground's workspace lease keeps `close` as a separate step so
a removal failure is reported in the result's `cleanupFailures`, not in
place of the script's outcome.

### Terminal and Stdio: user-facing CLI text

Adopted 2026-09-03 for the first-party `agent-bundle` CLI (`src/cli.ts`); the
Node implementations come from `@effect/platform-node-shared@4.0.0-rc.112`,
the same dependency `platform.ts` builds `platformLayer` from (never
`@effect/platform-node`, for the consumer-footprint reason above).
`effect/Terminal` is the sanctioned way to touch stdin/stdout for
**user-facing command output**: human command output and the Workbench
startup URL line go through `Terminal.display`, and any future interactive
prompt goes through `terminal.readLine` (EOF surfaces as
`Terminal.QuitError`, so a prompt must handle it). `Terminal.display` is
stdout-only; **diagnostics** (the canonical JSON diagnostics document) go
through `Stdio.stderr()`, and **machine output** (`--json`, stable JSON
lines) goes through `Stdio.stdout()` so its bytes stay exact. The helpers
live in `src/effect/terminal.ts` (`display`, `writeStderr`, `writeStdout`).
**Argv-layer text** — Commander's `--help`, `--version`, and argv errors —
is the one exception: it is written synchronously to the process streams
before any command runs (see the cold-start budget below).

Cold-start budget (measured 2026-09-03, Node v22.23.2, 30 runs, median wall
time of the built `bin/agent-bundle.js`; `node -e 0` is ≈28 ms on the same
machine): `--version` ≈60 ms before the adoption, ≈300 ms with the runtime
built eagerly in `runCli`, ≈60 ms with the lazy runtime; `--help` the same;
`validate` on `examples/host-test` unchanged (≈1.7–2.3 s, dominated by the
compiler). Where the +240 ms went: loading the `effect` module graph
(≈300 ms for the `effect` barrel in an unbundled process; ≈100 ms of it is
`effect/Terminal` alone, and the minimal `effect/Effect` + `Layer` +
`Stream` + `Terminal` + `Stdio` + `ManagedRuntime` subpath set still costs
≈240 ms) plus ≈10 ms for the two platform-node-shared subpaths.
Constructing the runtime is not the cost: `Layer.mergeAll` +
`ManagedRuntime.make` + the first `runPromise` that builds the layer total
≈6 ms. Memoizing the runtime therefore buys nothing; not loading the modules
is the whole fix.

Wiring rules:

- Provide the process-backed layers **once**, at the CLI composition root,
  through one `makeCliTerminal(services)` from `src/effect/cli-runtime.ts`
  (a `makeScopedEffectRuntime(nodeCliServices)` behind Promise-shaped
  `display` / `writeStdout` / `writeStderr` / `close`), and close it when
  the command finishes (a foreground `dev` session keeps it until the
  session closes). No other module provides `NodeTerminal.layer` /
  `NodeStdio.layer`.
- **Build it lazily.** `src/cli.ts` imports `cli-runtime.ts` type-only and
  loads it with a dynamic `import()` on the first command write, after
  Commander has parsed argv. `cli-runtime.ts` is the only module that pulls
  `effect`, `effect/Terminal`, `effect/Stdio`, and the platform-node-shared
  layers into the CLI process; `--version`, `--help`, and argv errors must
  never reach it. `packages/agent-bundle/tests/cli.test.ts` proves this by
  running the built CLI under a `module.registerHooks` resolve recorder
  (`tests/support/record-module-loads.mjs`) and asserting no `effect` or
  `@effect/platform-node-shared` URL resolves for those three invocations
  (and that a real command does load them). The same dynamic-import pattern
  already keeps `./api.ts` out of the trivial path.
- Commander writes its own text (help, version, argv errors) synchronously
  through `configureOutput` to `CliOutput.argvText` (default: the process
  streams). It only writes before aborting parsing, so it never interleaves
  with Effect-written command output, and routing it through
  `Terminal.display` would load the runtime for exactly the invocations the
  budget protects.
- `nodeCliServices` is `Layer.mergeAll(NodeTerminal.layer, NodeStdio.layer)`
  from the `@effect/platform-node-shared/NodeTerminal` and `/NodeStdio`
  subpaths, not the whole `platformLayer`: the CLI does not use
  child-process, crypto, or filesystem services, and loading them measured
  at roughly +400 ms on top.
- The scaffolder (`packages/create-agent-bundle/src/index.ts`) follows the
  same split: `runCli` parses flags and writes `--help` (stdout) and flag
  errors (stderr) synchronously to its `CliStreams` (default: the process
  streams), then loads `src/scaffold-cli.ts` — the `NodeServices.layer`
  root, the scaffold program, and Clack — with a dynamic `import()`. Clack
  stays the prompt renderer and is not replaced by `readLine`.
- Keep `display` text explicit about line endings (`\n`); the service writes
  what it is given.
- Tests provide a capture layer plus capture argv sinks
  (`tests/support/cli-terminal.ts`: `Terminal.make({ display })` +
  `Stdio.layerTest({ stdout, stderr })` + `argvText`) through
  `runCli(args, { argvText, services })`; they never spy on
  `process.stdout`. The scaffolder's `tests/cli-text.test.ts` passes capture
  `CliStreams` to `runCli`.
- **Protocol stdout stays raw.** MCP stdio JSON-RPC (`mcp-entry.ts`,
  `mcp run`), hook result JSON (`adapters/hook-contract.ts`), the emitted
  routed-CLI shell (`cli-entry.ts`'s `writeOut`/`writeErr` ports and the
  `entry-shell.ts` bin template), installers (`install/surface.ts`), and
  child/worker stderr forwarding keep their direct
  `process.stdout`/`process.stderr` adapters: emitted artifacts must not carry
  a platform runtime, and byte-exact protocol frames are not terminal text.
- **The route-facing terminal capability is plain Node, not `Terminal`.**
  `request.terminal` (#511) — TTY-ness, color depth, and `columns`/`rows` per
  output stream, reported to routes, rendered scripts, and `main`-envelope
  executables — is probed by the dependency-free `src/terminal-capability.ts`
  (aliased into emitted executables as `agent-bundle/terminal-capability`)
  because those artifacts must not carry the Effect runtime; the first-party
  CLI mounts no route request scope, so it has nothing to read from the
  `Terminal` service for it. `Terminal.columns`/`rows` remain the first-party
  CLI's own way to size its human output. Rules and the per-surface table:
  [Terminal capability](entry-conventions.md#terminal-capability-requestterminal).

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
| `@effect/platform-node` (`NodeServices.layer`, `create-agent-bundle`) and `@effect/platform-node-shared` (`agent-bundle`'s `platformLayer`); `FileSystem` / `Path` services live in `effect` | **adopted** (2026-09-03) for ordinary I/O — `create-agent-bundle` scaffolder and the `agent-bundle` temp directories in `api.ts` / the Codex validator (phase 1); host-contracts validators, `services/*`, `eval/*`, and the post-build readers (phase 2, ordinary-I/O modules, 2026-09-03); the dev server's services on one session-scoped runtime created in `startDevServer` (phase 2, dev server, 2026-09-03); see [Effect platform services](#effect-platform-services-effectplatform-node) for the keep-raw list and the consumer-footprint reason for the split | re-pin bumps both in lockstep with `effect`; re-check whether `@effect/platform-node` still forces a `redis` peer (if it stops, `agent-bundle` can move to `NodeServices.layer`); re-check whether `lstat` / `O_NOFOLLOW` / directory fsync landed (would shrink the keep-raw list) and the `runMain` 130/143 exit contract |
| `@effect/platform-node-shared` (`NodeTerminal` / `NodeStdio`) + `effect/Terminal`, `effect/Stdio` | first-party CLI command output, diagnostics, and machine output (`src/cli.ts`, `src/effect/terminal.ts`, `src/effect/cli-runtime.ts`), loaded lazily on the first command write (2026-09-03); Commander's help/version/argv-error text and the scaffolder's `--help` / flag-error text stay on synchronous process writes for the cold-start budget | re-pin re-checks `Terminal.display` stays stdout-only, `readLine` EOF → `QuitError`, the `Stdio` sink contract, and re-measures `agent-bundle --version` startup against the recorded ≈60 ms (`cli.test.ts` fails the build if the trivial invocations resolve an `effect` module) |
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

1. Bump the exact `effect` version in `packages/rsc-runtime/package.json`,
   `packages/agent-bundle/package.json`, `packages/workbench/package.json`,
   and `packages/create-agent-bundle/package.json`.
2. Synchronize `@effect/atom-react` in `packages/workbench/package.json` and
   `@effect/platform-node` in `packages/create-agent-bundle/package.json` and
   `@effect/platform-node-shared` in `packages/agent-bundle/package.json` to
   the same RC; re-run the Workbench disposal regression test and production
   bundle measurement (rsbuild size table), and re-measure the scaffolder
   bundle (`pnpm --filter create-agent-bundle build` prints the size table).
3. `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash`.
4. Re-read `repos/effect/LLMS.md` and refresh `agent-patterns/effect-*.md`.
5. Re-verify every unstable-module row and the language-service diagnostics.
6. Re-run the hook cold-start check.

## Open decisions (maintainer)

Divergences between the vendored guidance (`repos/effect/LLMS.md`, read-only)
and what the repo does today. Recorded, not decided; each
row names the two positions and what a decision would touch. Until a row is
resolved the current repo practice stands, and new code follows it.

- **`isRecord` vs `Predicate`.** `LLMS.md` § Predicate says never to write
  helpers like `isRecord` and to use the `Predicate` module. The repo's
  shared guards are `core/strict-json.ts` `isRecord` / `isJsonRecord` /
  `isPlainRecord` and `workbench/src/client-helpers.ts` `isRecord`, but the
  divergence is wider than two helpers: fifteen modules define their own
  private `isRecord` with the same `typeof === 'object' && !== null &&
  !Array.isArray` body (`mcp-server-runtime.ts`, `build/pack-inventory.ts`,
  `install/{install,doctor,cursor-agent-plugins-launch}.ts`,
  `host-contracts/{claude,cursor,portable}-plugin-validation.ts`,
  `adapters/portable-mcp-rules.ts`, `dev/host-install-manager.ts`,
  `dev/mcp-app-runtime-binding-service.ts`,
  `dev/mcp-apps/{mcp-app-bridge,mcp-app-host-profiles,mcp-app-routes}.ts`,
  `workbench/src/mcp/mcp-app-preview.tsx`), seven more alias a shared guard
  under the local name, and five emit the same one-liner as a string into
  generated hook / proxy / sandbox source that intentionally imports nothing
  (`adapters/hook-contract.ts`, `install/surface.ts`,
  `dev/runtime-client-surface-proxy.ts`, `dev/mcp-apps/mcp-app-sandbox.ts`).
  Roughly 400 call sites in total, against about a dozen
  `Predicate.isObject` uses (the install lane). rc.112 `Predicate` has no
  `isRecord`; `Predicate.isObject` is the closest match (`{}`-typed, excludes
  arrays), and `Predicate.isObjectOrArray` includes arrays. Options: declare
  the `core/strict-json.ts` guards the sanctioned spelling, fold the private
  copies into them, and say so here (their `Readonly<Record<string, unknown>>`
  narrowing is what the decoders index into); or migrate the lot to
  `Predicate.isObject` in one mechanical chore and re-verify the cold-start
  budget for hooks that would newly import `effect/Predicate`. Either way
  the emitted-string copies stay: generated host-side JS has no `effect`
  import by design.
- **`Data.Error` for internal class errors — decided 2026-09-03: adopt,
  internals only.** The rule and its carve-outs live in
  [Yieldable framework errors](#yieldable-framework-errors-dataerror-decided-2026-09-03).
  Summary: framework-process error classes in Effect-native modules extend
  `YieldableFrameworkError` / `YieldableCodedError`
  (`packages/agent-bundle/src/effect/errors.ts`, thin subclasses of rc.112
  `Data.Error` that keep the `Error` / `CodedError` constructor shapes and
  restore plain-`Error` `toJSON` / `util.inspect`), so programs write
  `return yield* new X(...)`. `Schema.TaggedError` stays deferred. Plain
  `Error` / `CodedError` remain for the bases on Effect-free entry graphs
  (`CodedError`, `DiagnosticError`, `DevLockError`, `McpAppBridgeCloseError`
  — the swap was measured to add a static `effect` import to
  `agent-bundle/config`, `meta`, `rstest`, the CLI `--help` path, and the host
  MCP proxy), every class on a public declaration graph — exported from a
  package entry (the `Agent*` classes included) or merely reached by one
  through the emitted `.d.ts` files (`McpSessionError`, `EpochStoreError`,
  `ProjectEventHubError`, …), because `Cause.YieldableError` would make
  `effect` a type dependency for consumers; `public-api.test.ts` walks every
  export's declaration graph and pins it —
  emitted artifacts (66 `examples/host-test` files byte-identical in size
  before/after; the +12 kB figure was `effect/PlatformError`'s
  `Schema.TaggedError`, not `Data.Error`, which lives in the Effect core the
  wrappers already bundle), and Workbench client errors. The boundary's
  identity-preserving rethrow table is unchanged.

## Parked toolchain follow-ups

Toolchain pins that are deliberately held back are tracked here. Only the
`repos/effect` subtree update is coupled to the Effect RC re-pin (see
`AGENTS.md`); every other row has its own independent trigger. Each row
records the pin, the exact registry state observed when the row was written
(`npm view <pkg> dist-tags` / `versions`), and the trigger that turns the row
into a chore. Re-verify every row during a re-pin, but never delay or bundle a
row whose trigger has already fired: do that upgrade in its own chore PR as
soon as the trigger fires and retire the row.

| Recorded | Pin (where) | Observed registry state | Trigger / action |
| --- | --- | --- | --- |
| 2026-09-03 | `effect-rstest` **pkg.pr.new preview `e5f8d5f`** (`https://pkg.pr.new/ScriptedAlchemy/effect-rstest@e5f8d5f`) — `packages/agent-bundle`, `packages/rsc-runtime`, `packages/create-agent-bundle` devDependencies (three pins). Needs a real release pin once published. | `npm view effect-rstest versions`: **E404 — not published to npm** (no versions, no dist-tags). | First npm publish of `effect-rstest`. Replace all three preview URLs with the exact published version, refresh `pnpm-lock.yaml`, re-run `pnpm test:unit` (`it.effect` / `it.live` suites). |
| 2026-09-03 | `effect` **`4.0.0-rc.112`** (`packages/agent-bundle`, `packages/rsc-runtime`, `packages/workbench`, `packages/create-agent-bundle`), `@effect/atom-react` `4.0.0-rc.112` (`packages/workbench`), `@effect/platform-node` `4.0.0-rc.112` (`packages/create-agent-bundle`), `@effect/platform-node-shared` `4.0.0-rc.112` (`packages/agent-bundle`), `@effect/language-service` `0.87.2` and `@effect/tsgo` `0.39.0` (root). Auto re-pin in lockstep + `repos/effect` subtree + Workbench atom phase 4 unblock (stream-backed derived atoms) once the post-rc.112 disposal fix ships. | `npm view effect dist-tags`: `rc` **`4.0.0-rc.112`** (unchanged), `beta` `4.0.0-beta.107`, `latest` `3.22.1`. `@effect/atom-react`: `rc` `4.0.0-rc.112`. `@effect/language-service`: `latest` `0.87.2`. `@effect/tsgo`: `latest` `0.39.1` (patch ahead of the `0.39.0` pin; rides the lockstep chore). | `effect@rc` advances past `4.0.0-rc.112`. Run the re-pin chore steps 1–6 above, bumping `effect`, `@effect/atom-react`, `@effect/language-service`, and `@effect/tsgo` together, then lift the stream-backed derived-atom ban in the Workbench if the disposal fix is in the new RC. |
| 2026-09-03 | Agent Plugins specification **`1.0.0`** — `packages/agent-bundle/src/adapters/schemas/portable/{plugin,mcp}.schema.json` + `PROVENANCE.json` (spec repo `agentplugins/agent-plugins-spec` @ `ff8ab5e392cc87bd88d87c060815a87490e51003`, 2026-08-19), portable `adapterRevision` `1.8.0`, pins in `tests/adapter-metadata.test.ts`. Spec watch for #426; not an npm pin, so re-verify with `curl`/`gh api`, not `npm view`. | Live `https://agent-plugins.org/schemas/1.0.0/{plugin,mcp}.schema.json` rehash to the pinned sha256 (1805 / 3408 bytes). Repo `main` HEAD unchanged at the pinned commit; **no tags, no GitHub releases**. `spec/1.1.0.md` is "Status: Working Draft" (started 2026-08-15, `a2afd7ec`); in-repo `schemas/1.1.0/*.schema.json` differ from 1.0.0 only in the `$id`/`const`/`description` version strings; `https://agent-plugins.org/schemas/1.1.0/*.schema.json` → 404. Observed latest published version: **1.0.0**. | `spec/1.1.0.md` (or later) flips to "Published" **and** `agent-plugins.org/schemas/<version>/` serves both schemas. Re-pin under `schemas/portable/` with a dated `PROVENANCE.json` (sha/bytes/date/commit), bump the portable `adapterRevision`, refresh the metadata pins, run `pnpm test:unit` (portable adapter + plugin-validation suites) and `pnpm test:host-install:build`, and add a capability row per additive field. |
