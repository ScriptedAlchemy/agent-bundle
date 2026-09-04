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
- Typed fail, public or Effect-free class:
  `Effect.fail(new AgentRequestError('request-closed', message))`.
- Typed fail, framework-process class (dev seam / eval service, extends
  `YieldableFrameworkError` or `YieldableCodedError` from
  `packages/agent-bundle/src/effect/errors.ts`):
  `return yield* new McpSessionError('MCP_SESSION_CLOSED', message)`.
  `Effect.fail(new McpSessionError(...))` is equally valid; do not churn
  call sites for style.
- Defect (bug): `Effect.die(defect)` — not for expected fail-closed states.
- Recover: `Effect.catch`, `Effect.catchTag` when the error is tagged.
  None of our classes are tagged (`Data.Error`, not `Data.TaggedError` or
  `Schema.TaggedError`). Catch them with `Effect.catch((error) => ...)` and
  `instanceof` / `error.name` / `error.code`.
- Inspect after run: `Exit.isSuccess` / `isFailure`, then `Cause.squash`,
  `Cause.hasInterruptsOnly`, `Cause.hasFails`, `Cause.hasDies`.

The Wave 3.5 brief defers Effect Schema. Do **not** convert `Agent*Error` to
`Schema.TaggedError` to unlock `catchTag`. Revisit only if a later wave
explicitly lifts the Schema deferral.

## Declaring a framework-process error (decided 2026-09-03)

```ts
import { YieldableCodedError, YieldableFrameworkError } from '../effect/errors.ts';

export class McpSessionError extends YieldableCodedError<McpSessionErrorCode> {
  constructor(code: McpSessionErrorCode, message: string) {
    super('McpSessionError', code, message);
  }
}

export class DevCoordinatorCloseError extends YieldableFrameworkError {
  readonly failures: readonly DevCoordinatorCloseFailure[];
  constructor(failures: readonly DevCoordinatorCloseFailure[]) {
    super('DevCoordinator could not close every resource.');
    this.name = 'DevCoordinatorCloseError';
    this.failures = failures;
  }
}
```

The bases keep the `Error` / `CodedError` constructor shapes, so migrating
an existing class is the `extends` clause plus the import. They also keep
the plain-`Error` observable shape — `JSON.stringify`, `stableJson`,
`{ ...error }`, `util.inspect`, non-enumerable `cause` — which rc.112
`Data.Error` alone would change (its prototype `toJSON` spreads the
constructor fields; its `[nodejs.util.inspect.custom]` prints that instead
of the stack). Never extend `Data.Error` directly.

Stay on plain `Error` / `CodedError` when the class is exported from a
package entry (Effect must not reach user-facing `.d.ts`), when it is
reachable from an Effect-free entry (`agent-bundle/config`, `meta`,
`rstest`, `test/browser`, the CLI `--help` path, the host MCP proxy), or
when it ships inside an emitted artifact. `docs/effect-conventions.md`
§ "Yieldable framework errors" lists the current carve-outs;
`tests/emitted-artifact-effect-surface.test.ts` and `tests/cli.test.ts`
fail if one is crossed.

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
