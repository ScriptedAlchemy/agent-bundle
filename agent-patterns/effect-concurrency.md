# Effect concurrency patterns

Source: `repos/effect/packages/effect/src/Fiber.ts`, `Semaphore.ts`,
`Latch.ts`, `Queue.ts`, `PubSub.ts`, `Deferred.ts`, and `Effect.ts`
(`forkChild`, `forEach`, `all`, `raceFirst`). Refresh when the subtree moves.

Waves 4–6 grow the biggest concurrency surfaces (hook thin-clients under
host deadlines, MCP progress projector, notices ledger, warm-runtime
lifecycle). Build those Effect-native from day one behind Promise edges.

## Fibers

- `yield* Effect.forkChild(effect)` — structured child of the current fiber.
- `Fiber.await` / `Fiber.join` / `Fiber.interrupt` — observe or cancel.
- Prefer exported Fiber functions over `interruptUnsafe` / `pollUnsafe`.
- Forked work that owns a resource must be forked *into a scope*
  (`forkScoped` / `Layer.scoped`) so interruption closes the resource.

Host `AbortSignal` still exists at the edges (`dispatch()` / `stream()`).
Do not thread extra internal signals once the program is an Effect; interrupt
the fiber (`Stream.interruptWhen` + `abortToInterrupt`). `Latch.makeUnsafe`
is the legal sync bridge when a web `ReadableStream.pull` must open demand
for an Effect stream — do not invent a second AbortSignal for that.

## Bounded work

| Primitive | Use |
| --- | --- |
| `Semaphore.make(n)` + `withPermits(k)(effect)` | Cap concurrent rebuilds, hook clients, sqlite writers. |
| `Latch.make(open?)` | Gate a coalesced rebuild (Stage 3). `makeUnsafe` only when you already hold a sync context. |
| `Queue.bounded(n)` / `Queue.unbounded()` | Single-consumer work queue. Downstream pull applies backpressure. |
| `PubSub.bounded(n)` / `unbounded` | Fan-out. Stage 3 SSE hub: one publisher, many subscribers, identical wire contract (sequence numbers, replay-gap frames). |
| `Deferred.make<A, E>()` | One-shot wait (handshake, first event, shutdown). |

`Effect.forEach(items, fn, { concurrency })` beats a hand-rolled worker pool.
`Effect.all` for a fixed tuple of effects.

## Racing and cancellation

- `Effect.raceFirst(a, b)` — first to complete wins; the loser is interrupted.
- `interruptWhenAborted(effect, signal)` — host deadline into a race with
  `Effect.interrupt`.
- Do not `Promise.race` around Effects. Race inside Effect, `runPromise` once.

## What to avoid

- Hidden shared `let` / `Map` mutation for in-flight work. Use `Ref`,
  `Queue`, or `PubSub`.
- Starting a fiber and dropping the handle (leaks). Hold it in a `Scope` or
  `Fiber` you join/interrupt.
- Using `PubSub` when consumers should compete (that's a `Queue`).
- Using `Queue` when every subscriber needs every event (that's `PubSub`).
- Coalescing rebuilds with debounce timers (`setTimeout`) — `Latch` +
  fiber, not host timers (`globalTimersInEffect`).
