import type { ChildProcess } from 'node:child_process';

import { Effect, type Scope } from 'effect';

/**
 * SIGINT/SIGTERM forwarding to the child for as long as the wait runs. A
 * scoped resource: the listeners come off when the scope closes, however
 * the wait ends — the `try`/`finally` this replaces. Its own module so that
 * `mcp-run.ts` imports it for the implementation only and the public
 * `mcp-run.d.ts` carries no Effect-typed export (`public-api.test.ts` walks
 * the declaration graph for `effect`).
 */
export const forwardingSignals = (child: ChildProcess): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onSigint = (): void => { child.kill('SIGINT'); };
      const onSigterm = (): void => { child.kill('SIGTERM'); };
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
      return { onSigint, onSigterm };
    }),
    (listeners) => Effect.sync(() => {
      process.off('SIGINT', listeners.onSigint);
      process.off('SIGTERM', listeners.onSigterm);
    }),
  ).pipe(Effect.asVoid);
