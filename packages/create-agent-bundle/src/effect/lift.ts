import { Effect } from 'effect';

import { toCliError } from './boundary.ts';

/**
 * Lifts for the scaffolder's remaining Promise/sync helpers (gunzip,
 * `JSON.parse`, the package-manager child process, the Clack prompts). The
 * thrown/rejected value stays identity-preserved when it already is an
 * `Error` — the CLI's `UsageError` contract crosses `src/effect/boundary.ts`
 * untouched — and anything else is normalized to one, so the fail channel is
 * typed `Error`, never `unknown`.
 */

export const liftPromise = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ catch: toCliError, try: evaluate });

export const liftTry = <A>(evaluate: () => A): Effect.Effect<A, Error> =>
  Effect.try({ catch: toCliError, try: evaluate });
