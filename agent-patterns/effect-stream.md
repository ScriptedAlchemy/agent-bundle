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

## What to avoid

- `for await` over a stream you already have as `Stream` — use `mapEffect` /
  `runForEach`.
- Encoding/decoding JSON by hand when `Stream.pipeThroughChannel` +
  `effect/unstable/encoding` (Ndjson / SchemaBinary) would do. Unstable
  encoding is **not** adopted in Stage 0; list it in
  `docs/effect-conventions.md` before first use.
- Constructing `new ReadableStream` to paper over missing backpressure.
- Calling `Effect.runPromise` on each chunk. Consume with `Stream.run*`
  inside Effect, one `runPromise` at the boundary.
