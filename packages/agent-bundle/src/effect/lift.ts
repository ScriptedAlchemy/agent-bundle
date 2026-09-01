import { Effect } from 'effect';

/**
 * Lifts for the dev seam's existing Promise/sync helpers. Both keep the
 * thrown/rejected value untouched in the error channel — the dev seam's
 * typed contracts are plain `Error` subclasses that must cross
 * `src/effect/boundary.ts` identity-preserved, and several call sites
 * re-raise non-Error values (for example an `AbortSignal.reason`) verbatim.
 */

export const liftPromise = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ catch: (error) => error, try: evaluate });

export const liftTry = <A>(evaluate: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ catch: (error) => error, try: evaluate });
