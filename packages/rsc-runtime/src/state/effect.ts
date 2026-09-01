import { Effect } from 'effect';

import { AgentStateError } from './contract.js';

/**
 * Lifts synchronous kernel work into the typed state error channel.
 * Expected fail-closed conditions remain AgentStateError failures; any other
 * throw is an implementation defect and stays in Effect's defect channel.
 */
export const stateEffect = <A>(
  evaluate: () => A,
): Effect.Effect<A, AgentStateError> =>
  Effect.try({
    catch: (error) => error,
    try: evaluate,
  }).pipe(
    Effect.catch((error) =>
      error instanceof AgentStateError
        ? Effect.fail(error)
        : Effect.die(error),
    ),
  );
