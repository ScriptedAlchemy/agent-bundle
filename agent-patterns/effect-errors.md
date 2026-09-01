# Effect typed-error patterns

Source: `repos/effect/packages/effect/src/Cause.ts`, `Exit.ts`,
`Effect.ts` (`fail`, `catch`, `catchTag`, `die`), and
`repos/effect/LLMS.md` § Error handling. Refresh when the subtree moves.

This repo already has fail-closed typed errors. Effect's error channel maps
onto those classes at the boundary — it does not replace them.

## Existing contracts (keep)

| Class | Codes (do not widen) |
| --- | --- |
| `AgentRequestError` | `invalid-invocation`, `outside-invocation`, `request-closed`, `store-version-conflict` |
| `AgentContractError` | document / event / elapsed bounds, `handoff-required` |
| `AgentStateError` | `aborted`, `corrupt`, `idempotency-conflict`, `invalid-*`, `lifetime-mismatch`, `migration-*`, `reducer-failure`, `revision-*`, `store-closed`, `unavailable` |

`Observed<T>` unavailable reasons (`not-provided`, `unsupported-surface`,
`host-omitted`, `unauthenticated`) stay a data union, not an Effect error.

## Inside Effect

- Succeed: `Effect.succeed(value)`, `Effect.sync(() => value)`.
- Typed fail: `Effect.fail(new AgentRequestError('request-closed', message))`.
- Defect (bug): `Effect.die(defect)` — not for expected fail-closed states.
- Recover: `Effect.catch`, `Effect.catchTag` when the error is tagged.
  Our `Agent*` classes are **not** Schema tagged errors. Catch them with
  `Effect.catch((error) => ...)` and `instanceof` / `error.name`.
- Inspect after run: `Exit.isSuccess` / `isFailure`, then `Cause.squash`,
  `Cause.hasInterruptsOnly`, `Cause.hasFails`, `Cause.hasDies`.

The Wave 3.5 brief defers Effect Schema. Do **not** convert `Agent*Error` to
`Schema.TaggedError` to unlock `catchTag`. Revisit only if a later wave
explicitly lifts the Schema deferral.

## Boundary mapping

`packages/rsc-runtime/src/effect/boundary.ts`:

1. `Cause.hasInterruptsOnly` → `DOMException` `AbortError` (host cancellation).
2. `AgentRequestError` / `AgentContractError` via `instanceof`.
3. `AgentStateError` via `error.name` (no `./state/contract` import on the
   root graph).
4. Other `Error` rethrown; other values wrapped.

Callers of `runPromise` see the same types they see today.

## What to avoid

- `try` / `catch` around `Effect.gen` construction. It catches nothing
  useful; handle errors in the channel.
- Putting `unknown` or global `Error` in the fail channel
  (`unknownInEffectCatch`, `globalErrorInEffectFailure`).
- Swallowing interruption as a typed success. Cancellation is `AbortError`.
  `Stream.toReadableStream`'s `Cause.squash` is not that mapping — use the
  boundary helper.
- `Effect.runPromise` in a test to "see the error" when `runPromiseExit` +
  `Cause` is the assertion you want — still only through the boundary.
- New public error codes without updating the authoring docs and the mapping
  table in `docs/effect-conventions.md`.
