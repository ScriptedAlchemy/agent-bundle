# Effect Scope patterns

Source: `repos/effect/packages/effect/src/Scope.ts`,
`repos/effect/packages/effect/src/Effect.ts` (`acquireRelease`, `scoped`,
`addFinalizer`, `abortSignal`). Refresh when the subtree moves.

Stage 1 uses `Scope` for state-driver transaction/connection lifecycles.
Stage 3 uses it for `EpochStore` staging/leases/recovery and MCP session
teardown. The public `defineState` / `state.dispatch` APIs stay Promise.

## Resource lifecycle

```ts
const connection = Effect.acquireRelease(
  Effect.sync(() => open()),
  (handle, exit) => Effect.sync(() => handle.close(exit)),
);
```

- `acquireRelease(acquire, release)` — release receives the exit so you can
  distinguish success / fail / interrupt.
- `acquireDisposable` — when the resource already implements
  `Symbol.dispose` / `Symbol.asyncDispose`.
- `addFinalizer` — extra cleanup on the current scope.
- `Effect.scoped(effect)` — provide a fresh scope and close it when `effect`
  finishes (including interruption).
- `Effect.scopedWith((scope) => ...)` — when you must hold the `Scope` value.

Finalizers run in reverse acquire order. Interruption still runs them.

## Transactions (stage-1 kernel idiom)

`Effect.acquireUseRelease` when begin/commit/rollback are one unit and the
release step branches on the exit:

```ts
Effect.acquireUseRelease(
  begin,                       // BEGIN IMMEDIATE
  () => work,
  (db, exit) => Exit.isFailure(exit)
    ? rollback
    : commit.pipe(Effect.catch((e) => rollback.pipe(Effect.andThen(Effect.fail(e))))),
);
```

A failed COMMIT must still roll back before re-raising, or the connection
holds the transaction open for the next caller.

## Layers

- `Layer.effect` for a service with no finalizer.
- `Layer.scoped` when constructing the service needs `Scope` (open a handle,
  register a lease, start a subscriber).
- `Layer.effectDiscard` for a background fiber you do not expose as a
  service (pair with `Effect.forkScoped` / `Effect.forkChild` + scope).

Do not return a live `Scope` across the Promise boundary. Close it inside
the Effect and let `runPromise` observe the result.

## AbortSignal

- Host → Effect: `runPromise(program, { signal })` or
  `interruptWhenAborted(program, signal)`.
- Effect → host: `yield* scopedAbortSignal` (`Effect.abortSignal`). The
  signal aborts when the owning scope closes. Do not keep it longer than
  that scope.

Do not allocate a raw `AbortController` inside `Effect.gen` when
`Effect.abortSignal` is the owner (language-service `abortControllerInEffect`).

## What to avoid

- `try` / `finally` around Effect construction. Construction is lazy;
  finalizers belong on the scope.
- Opening sqlite / file / network handles in `Effect.sync` without
  `acquireRelease`.
- Sharing one connection across requests without a scope (or a documented
  process-lifetime Layer).
- Importing `./state/contract` from the root runtime boundary to type
  `AgentStateError` — duck-type by `error.name` so the kernel stays off the
  package-root graph.
