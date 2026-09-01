/**
 * Assertions over the ordered render events the runtime emits (#140).
 *
 * The default matcher is deliberately **sequence-tolerant**. #120 is the
 * lesson: a test that pinned the exact frame array failed on a second frame
 * that was entirely legitimate — a real changed generation, not a duplicate.
 * The correction there was to consume the channel monotonically over its own
 * ordinals and bound the count, and that is what these matchers do.
 * `toContainSequence` matches an ordered subsequence, so an extra `progress`
 * or `replace` frame under load never turns a green test red, while a missing
 * frame, a reordering, or a regressed sequence number still fails.
 *
 * `toHaveTypes` is the exact-array assertion, kept available and deliberately
 * not the one the documentation reaches for first.
 */
import type { AgentRenderEvent } from '@agent-bundle/runtime';

import { AgentTestError, captured } from './errors.ts';
import type { RenderedRouteProvenance } from './types.ts';

export type AgentRenderEventType = AgentRenderEvent['type'];

/** Anything that carries render events: the raw array or a harness result. */
export type RenderEventSubject =
  | readonly AgentRenderEvent[]
  | { readonly events: readonly AgentRenderEvent[]; readonly provenance?: RenderedRouteProvenance };

export interface ProgressExpectation {
  /** Every listed substring must appear in some progress message, in order. */
  readonly messages?: readonly string[];
  readonly atLeast?: number;
  readonly atMost?: number;
}

export interface RenderEventAssertions {
  /** Asserts a total event count ceiling — the #120 bound that keeps tolerance honest. */
  readonly toBeBoundedBy: (maxEvents: number) => RenderEventAssertions;
  /** Asserts exactly one terminal `complete`, and that it is last. */
  readonly toCompleteOnce: () => RenderEventAssertions;
  /** Asserts the expected types appear in order, tolerating extra events between them. */
  readonly toContainSequence: (expected: readonly AgentRenderEventType[]) => RenderEventAssertions;
  /** Asserts an `error` event, optionally with `code`. */
  readonly toHaveErrorCode: (code?: string) => RenderEventAssertions;
  /** Asserts strictly increasing sequence numbers with no repeats or regressions. */
  readonly toHaveMonotonicSequence: () => RenderEventAssertions;
  /** Asserts no `error` event was emitted. */
  readonly toHaveNoErrors: () => RenderEventAssertions;
  /** Asserts progress reporting: a count window and/or ordered message substrings. */
  readonly toHaveProgress: (expectation?: ProgressExpectation) => RenderEventAssertions;
  /** Asserts the exact event-type array. Prefer `toContainSequence` unless the exact frame set is the contract. */
  readonly toHaveTypes: (expected: readonly AgentRenderEventType[]) => RenderEventAssertions;
}

const eventsOf = (subject: RenderEventSubject): readonly AgentRenderEvent[] =>
  Array.isArray(subject) ? subject : (subject as { readonly events: readonly AgentRenderEvent[] }).events;

const provenanceOf = (subject: RenderEventSubject): RenderedRouteProvenance | undefined =>
  Array.isArray(subject) ? undefined : (subject as { readonly provenance?: RenderedRouteProvenance }).provenance;

/** The compact rendering every event failure prints: `0:shell 1:progress 2:complete`. */
const timeline = (events: readonly AgentRenderEvent[]): string =>
  events.length === 0
    ? 'no events'
    : events.map((event) => `${String(event.sequence)}:${event.type}`).join(' ');

const progressMessages = (events: readonly AgentRenderEvent[]): readonly string[] =>
  events.flatMap((event) => (event.type === 'progress' && event.message !== undefined ? [event.message] : []));

/**
 * Index of the first element at or after `from` whose type is `type`, or -1.
 * Scanning forward from the previous match is what makes the sequence
 * ordered-but-tolerant rather than a set membership check.
 */
const findFrom = (
  events: readonly AgentRenderEvent[],
  type: AgentRenderEventType,
  from: number,
): number => {
  for (let index = from; index < events.length; index += 1) {
    if (events[index]!.type === type) return index;
  }
  return -1;
};

export const expectEvents = (subject: RenderEventSubject): RenderEventAssertions => {
  const events = eventsOf(subject);
  const provenance = provenanceOf(subject);
  const fail = (message: string, details: readonly string[]): never => {
    throw new AgentTestError('assertion-failed', message, {
      details: [...details, `timeline:     ${timeline(events)}`],
      ...(provenance === undefined ? {} : { provenance }),
    });
  };

  const assertions: RenderEventAssertions = {
    toBeBoundedBy(maxEvents) {
      if (events.length > maxEvents) {
        fail('The render emitted more events than the bound allows.', [
          `expected:     at most ${String(maxEvents)} events`,
          `received:     ${String(events.length)} events`,
        ]);
      }
      return assertions;
    },
    toCompleteOnce() {
      const completions = events.filter((event) => event.type === 'complete');
      if (completions.length !== 1) {
        fail('The render did not emit exactly one terminal complete event.', [
          'expected:     exactly one complete event',
          `received:     ${String(completions.length)} complete events`,
        ]);
      }
      if (events[events.length - 1]?.type !== 'complete') {
        fail('The complete event was not the last event of the render.', [
          'expected:     complete last',
          `received:     ${String(events[events.length - 1]?.type)} last`,
        ]);
      }
      return assertions;
    },
    toContainSequence(expected) {
      let cursor = 0;
      for (const [position, type] of expected.entries()) {
        const found = findFrom(events, type, cursor);
        if (found === -1) {
          fail('The render events do not contain the expected sequence.', [
            `expected:     ${captured(expected)} in order (extra events between them are allowed)`,
            `missing:      ${JSON.stringify(type)} at expected position ${String(position)}`,
            `matched:      the first ${String(position)} expected event(s) before running out of stream`,
          ]);
        }
        cursor = found + 1;
      }
      return assertions;
    },
    toHaveErrorCode(code) {
      const errors = events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
      const matched = code === undefined ? errors : errors.filter((error) => error.code === code);
      if (matched.length === 0) {
        fail('The render emitted no matching error event.', [
          `expected:     ${code === undefined ? 'an error event' : `an error event with code ${JSON.stringify(code)}`}`,
          `received:     ${errors.length === 0 ? 'no error events' : captured(errors)}`,
        ]);
      }
      return assertions;
    },
    toHaveMonotonicSequence() {
      let previous = -1;
      for (const event of events) {
        if (event.sequence <= previous) {
          fail('The render event sequence numbers are not strictly increasing.', [
            'expected:     each event to advance the sequence',
            `received:     ${String(event.sequence)} after ${String(previous)} on a ${event.type} event`,
          ]);
        }
        previous = event.sequence;
      }
      return assertions;
    },
    toHaveNoErrors() {
      const errors = events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
      if (errors.length > 0) {
        fail('The render emitted error events.', [
          'expected:     no error events',
          `received:     ${captured(errors)}`,
        ]);
      }
      return assertions;
    },
    toHaveProgress(expectation = {}) {
      const progress = events.filter((event) => event.type === 'progress');
      const atLeast = expectation.atLeast ?? (expectation.messages === undefined ? 1 : expectation.messages.length);
      if (progress.length < atLeast) {
        fail('The render reported fewer progress events than expected.', [
          `expected:     at least ${String(atLeast)} progress events`,
          `received:     ${String(progress.length)}`,
        ]);
      }
      if (expectation.atMost !== undefined && progress.length > expectation.atMost) {
        fail('The render reported more progress events than expected.', [
          `expected:     at most ${String(expectation.atMost)} progress events`,
          `received:     ${String(progress.length)}`,
        ]);
      }
      if (expectation.messages !== undefined) {
        const messages = progressMessages(events);
        let cursor = 0;
        for (const needle of expectation.messages) {
          const found = messages.findIndex((message, index) => index >= cursor && message.includes(needle));
          if (found === -1) {
            fail('The render progress messages do not contain the expected text in order.', [
              `expected:     ${captured(expectation.messages)} in order`,
              `missing:      ${JSON.stringify(needle)}`,
              `received:     ${messages.length === 0 ? 'no progress messages' : captured(messages)}`,
            ]);
          }
          cursor = found + 1;
        }
      }
      return assertions;
    },
    toHaveTypes(expected) {
      const received = events.map((event) => event.type);
      if (received.length !== expected.length || received.some((type, index) => type !== expected[index])) {
        fail('The render event types differ from the expected exact sequence.', [
          `expected:     ${captured(expected)} exactly`,
          `received:     ${captured(received)}`,
          'note:         toContainSequence tolerates extra events; prefer it unless the exact frame set is the contract.',
        ]);
      }
      return assertions;
    },
  };
  return assertions;
};
