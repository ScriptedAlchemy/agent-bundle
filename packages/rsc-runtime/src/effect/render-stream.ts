import { Effect, Latch, Stream } from 'effect';

import {
  createAgentRenderEventSequence,
  type AgentRenderEvent,
  type AgentRenderEventInput,
  type AgentRenderLimits,
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

/**
 * Contract bounds as a stream stage: sequence numbers, elapsed / rate /
 * count / event-bytes, document snapshot bounds (depth / nodes / bytes),
 * and handoff-required after complete. Uses the same stepper as
 * `createAgentRenderEventSequence` so the #140 tests stay the source of
 * truth.
 */
export const boundRenderEventStream = (
  limits?: Partial<AgentRenderLimits>,
): <E, R>(
  stream: Stream.Stream<AgentRenderEventInput, E, R>,
) => Stream.Stream<AgentRenderEvent, E | Error, R> => {
  const sequence = createAgentRenderEventSequence(limits);
  return <E, R>(stream: Stream.Stream<AgentRenderEventInput, E, R>) =>
    Stream.mapEffect(stream, (input) =>
      Effect.try({
        catch: (error) => toRuntimeError(error),
        try: () => sequence.emit(input),
      }),
    );
};

export const emitBoundRenderEvent = (
  sequence: ReturnType<typeof createAgentRenderEventSequence>,
  input: AgentRenderEventInput,
): Effect.Effect<AgentRenderEvent, Error> =>
  Effect.try({
    catch: (error) => toRuntimeError(error),
    try: () => sequence.emit(input),
  });
