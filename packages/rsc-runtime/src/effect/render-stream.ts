import { Effect, Latch } from 'effect';

import {
  createAgentRenderEventSequence,
  type AgentRenderEvent,
  type AgentRenderEventInput,
} from '../agent-document.js';
import { toRuntimeError } from './boundary.js';

/**
 * Flight-byte demand latch. After the shell event is produced, further
 * Flight chunks wait until the public event stream is being pulled. The
 * pull hooks are sync because they fire from a web ReadableStream.
 */
export interface FlightDemand {
  readonly markShell: Effect.Effect<void>;
  readonly notePull: () => void;
  readonly notePullEnd: () => void;
  readonly wait: Effect.Effect<void>;
}

export const createFlightDemand = (): FlightDemand => {
  const pulling = Latch.makeUnsafe(false);
  let shellEmitted = false;
  return {
    markShell: Effect.sync(() => {
      shellEmitted = true;
    }),
    notePull() {
      pulling.openUnsafe();
    },
    notePullEnd() {
      pulling.closeUnsafe();
    },
    wait: Effect.suspend(() => (shellEmitted ? pulling.await : Effect.void)),
  };
};

export const emitBoundRenderEvent = (
  sequence: ReturnType<typeof createAgentRenderEventSequence>,
  input: AgentRenderEventInput,
): Effect.Effect<AgentRenderEvent, Error> =>
  Effect.try({
    catch: (error) => toRuntimeError(error),
    try: () => sequence.emit(input),
  });
