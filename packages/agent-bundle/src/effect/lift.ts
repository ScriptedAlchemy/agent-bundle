import { Effect } from 'effect';

/**
 * Lifts for the dev seam's existing Promise/sync helpers (Stage 3). Both keep
 * the thrown/rejected value untouched in the error channel — the dev seam's
 * typed contracts are plain `Error` subclasses that must cross
 * `src/effect/boundary.ts` identity-preserved, and several call sites
 * re-raise non-Error values (for example an `AbortSignal.reason`) verbatim.
 *
 * A bare `Effect.tryPromise(fn)` would wrap every rejection in
 * `Cause.UnknownError`; these helpers are the only sanctioned way to lift a
 * leaf helper (`docs/effect-conventions.md` § Stage 3 "Hurt / gotchas").
 */

/**
 * The raw value a lifted helper threw or rejected with. It is `unknown` by
 * contract — the lift is an identity, not a normalizer — so callers narrow it
 * where they know the helper's failure contract (`instanceof`, `isErrno`,
 * `Effect.mapError` into a typed dev error) instead of assuming a shape. The
 * boundary maps whatever reaches it: typed dev errors and `Error`s rethrow
 * as-is, other values are wrapped, interruption becomes `AbortError`.
 */
export type LiftedRejection = unknown;

/**
 * Lift a Promise-returning leaf helper. `evaluate` receives Effect's
 * interruption `AbortSignal` (aborted when the fiber is interrupted), so a
 * cancellable API can be passed the signal directly; thunks that ignore it
 * keep working unchanged.
 */
export const liftPromise = <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, LiftedRejection> =>
  Effect.tryPromise({ catch: (error): LiftedRejection => error, try: evaluate });

/** Lift a synchronous leaf helper; a throw becomes a typed failure carrying the thrown value. */
export const liftTry = <A>(evaluate: () => A): Effect.Effect<A, LiftedRejection> =>
  Effect.try({ catch: (error): LiftedRejection => error, try: evaluate });
