# Effect Stream patterns

Source: `repos/effect/packages/effect/src/Stream.ts` (vendored v4, package
`4.0.0-rc.112`). Refresh when the subtree moves. Read
`repos/effect/LLMS.md` § Working with Streams first.

Stage 2 replaces the #145 pull-gated Flight `TransformStream` with Effect
`Stream`. Native pull backpressure is the point — do not re-implement a
gated reader.

## Constructors

| Need | Use | Notes |
| --- | --- | --- |
| Iterable / array | `Stream.fromIterable`, `Stream.fromArray`, `Stream.make` | Eager chunks from in-memory data. |
| One effect | `Stream.fromEffect` | Emits the success value once. |
| Poll / schedule | `Stream.fromEffectSchedule`, `Stream.tick` | Repeating effects. |
| Paginated API | `Stream.paginate` | Token → page → next token. |
| `AsyncIterable` | `Stream.fromAsyncIterable(iter, onError)` | Maps iterator throw to `E`. |
| Web `ReadableStream` | `Stream.fromReadableStream({ evaluate, onError })` | Flight bytes in. |
| Queue / PubSub | `Stream.fromQueue`, `Stream.fromPubSub`, `Stream.fromSubscription` | Fan-in. |
| Callback / DOM | `Stream.callback`, `Stream.fromEventListener` | Resume-at-most-once. |
| Empty / never | `Stream.empty`, `Stream.never` | |
| Fail | `Stream.fail`, `Stream.failCause`, `Stream.die` | Typed vs defect. |

Avoid inventing a custom pull loop. If the source is already a
`ReadableStream` or async iterable, use the constructor above.

## Combinators (stage 2+)

- Transform: `map`, `mapEffect` (effectful, concurrency option), `flatMap`,
  `switchMap` (cancel previous), `filter`, `tap`.
- Merge: `merge`, `mergeAll`, `concat`.
- Time: `timeout`, `schedule`, `repeat`.
- Resource: `Stream.scoped` — acquire inside the stream, release when it ends
  or is interrupted.
- Consume: `Stream.runCollect`, `Stream.runFold`, `runForEach` / `runForEachArray`.
- Edge out: `Stream.toReadableStream` / `toReadableStreamEffect` when a host
  still wants a web stream. That helper itself calls `Effect.runFork` — only
  legal via the package boundary if we wrap it; prefer staying on `Stream`
  until the Promise edge.

## Backpressure

Streams are pull-based. Downstream `run*` pulls chunks; producers that honor
the pull (readable streams, queues) automatically apply backpressure. Do not
add a second gate (`TransformStream` + manual pause) around an Effect stream.

## Stage 2 dispatcher lessons

- `Stream.toReadableStream` calls `runFork` and maps failures with
  `Cause.squash`. Wrap it in the package boundary (`streamToReadableStream`)
  and use `mapCause` so interrupt-only causes stay `AbortError`. `tapError`
  must error the web controller *before* scope finalizers run — a hanging
  Flight cancel otherwise hides bound-violation and abort failures.
- Never `runPromise(Fiber.interrupt)` from `ReadableStream.cancel`. That
  cancel is invoked from `acquireRelease` on the parent event fiber;
  blocking on interrupt deadlocks it. Use `runFork` and do not await it.
- React's `createFromReadableStream` still owns a web `ReadableStream`.
  Wait for event demand *then* `reader.read()` (`Stream.unfold` + Latch).
  Wait-after-`fromReadableStream` either over-pulls (fails backpressure)
  or never pulls (deadlock). Do not cancel the Flight byte stream when the
  shell root arrives — later boundaries still need those bytes. React may
  still hold the reader at scope close; `stream.cancel()` then throws
  "locked" and must be swallowed.
- `host.execute({ progress })` must run in the same turn as `stream()`.
  Lazy `Stream.unwrap` raced `resolve('a')` ("Flight worker is not running").
- `Stream.callback` is the wrong event fan-in: a failed producer does not
  fail the stream unless you `Queue.fail`. Use `Stream.merge` +
  `takeUntil(complete)` + `Queue.shutdown` on `ensuring`.
- `Stream.paginate` is the pending-boundary loop (shell → replace/error* →
  complete).
- `progress.report()` after complete must reject `handoff-required` on the
  reporter, not only on the stream — share `createAgentRenderEventSequence`.
- After a producer fail, a later `pull()` with HWM 0 must *reject*, not
  resolve. `controller.error` alone can lose the error if no read is pending.
- Flight is not Ndjson. Do not adopt `effect/unstable/encoding` for this
  pipeline.

## What to avoid

- `for await` over a stream you already have as `Stream` — use `mapEffect` /
  `runForEach`.
- Encoding/decoding JSON by hand when `Stream.pipeThroughChannel` +
  `effect/unstable/encoding` (Ndjson / SchemaBinary) would do. Unstable
  encoding is **not** adopted; list it in `docs/effect-conventions.md`
  before first use.
- Constructing `new ReadableStream` to paper over missing backpressure
  (the boundary `streamToReadableStream` is the legal web-stream edge).
- Calling `Effect.runPromise` on each chunk. Consume with `Stream.run*`
  inside Effect, one `runPromise` at the boundary.
