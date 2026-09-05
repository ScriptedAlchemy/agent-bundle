import { expect, it } from '@rstest/core';

import {
  executeEventPreflight,
  eventFamilyAllowsPreflightDeny,
  validateEventPreflightResult,
  type EventPreflight,
  type EventPreflightContext,
} from '../src/events/preflight.ts';
import { projectEventPreflightResult } from '../src/events/projection.ts';
import {
  canonicalAgentEvents,
  eventFamilyAllowsPreflightDeny as publicEventFamilyAllowsPreflightDeny,
  validateEventPreflightResult as publicValidateEventPreflightResult,
  type CanonicalAgentEvent,
  type EventPreflightContext as PublicEventPreflightContext,
  type EventPreflightResult as PublicEventPreflightResult,
} from '../src/routes/public.ts';
import {
  eventFamilyAllowsPreflightDeny as rootEventFamilyAllowsPreflightDeny,
  validateEventPreflightResult as rootValidateEventPreflightResult,
} from '../src/index.ts';

/** Families whose existing projection emits a blocking deny on at least one host. */
const familiesThatAllowDeny = [
  'tool/before',
  'stop',
  'agent/start',
  'agent/stop',
  'prompt/submit',
  'compact/before',
  'permission/request',
  'model-switch/before',
  'config/change',
  'task/create',
  'agent/idle',
] as const satisfies readonly CanonicalAgentEvent[];

/**
 * Families that are observation-only or ignore deny on every host — the
 * portable intersection of `projectEventDocument`, not a host-specific copy.
 */
const familiesThatRejectDeny = [
  'session/start',
  'tool/after',
  'workspace/open',
  'session/end',
  'tool/failure',
  'compact/after',
  'permission/denied',
  'stop/failure',
  'file/change',
  'task/complete',
  'model-switch/after',
] as const satisfies readonly CanonicalAgentEvent[];

it('classifies deny legality for every canonical event family', () => {
  expect([...familiesThatAllowDeny, ...familiesThatRejectDeny].sort()).toEqual(
    [...canonicalAgentEvents].sort(),
  );
  for (const event of familiesThatAllowDeny) {
    expect(eventFamilyAllowsPreflightDeny(event)).toBe(true);
  }
  for (const event of familiesThatRejectDeny) {
    expect(eventFamilyAllowsPreflightDeny(event)).toBe(false);
  }
});

it('validates execute and continue results without a host decision', () => {
  expect(validateEventPreflightResult('execute', 'tool/before')).toBe('execute');
  expect(validateEventPreflightResult({ outcome: 'continue' }, 'tool/after')).toEqual({
    outcome: 'continue',
  });
  expect(Object.isFrozen(validateEventPreflightResult({ outcome: 'continue' }, 'session/start'))).toBe(true);
});

it('validates a denying result only when the family admits deny and the reason is nonempty', () => {
  expect(validateEventPreflightResult({ outcome: 'deny', reason: 'blocked command' }, 'tool/before')).toEqual({
    outcome: 'deny',
    reason: 'blocked command',
  });
  expect(() => validateEventPreflightResult({ outcome: 'deny' }, 'tool/before'))
    .toThrow(/requires a nonempty reason when outcome is deny/u);
  expect(() => validateEventPreflightResult({ outcome: 'deny', reason: '' }, 'stop'))
    .toThrow(/requires a nonempty reason when outcome is deny/u);
  expect(() => validateEventPreflightResult({ outcome: 'deny', reason: '   ' }, 'prompt/submit'))
    .toThrow(/requires a nonempty reason when outcome is deny/u);
});

it('rejects deny on observation-only families instead of copying host projection', () => {
  for (const event of familiesThatRejectDeny) {
    expect(() => validateEventPreflightResult({ outcome: 'deny', reason: 'no' }, event))
      .toThrow(new RegExp(`${event.replace('/', '\\/')} cannot deny`, 'u'));
  }
});

it('rejects unsupported preflight fields and results', () => {
  expect(() => validateEventPreflightResult(undefined, 'tool/before'))
    .toThrow(/Event preflight result/u);
  expect(() => validateEventPreflightResult('continue', 'tool/before'))
    .toThrow(/Event preflight result/u);
  expect(() => validateEventPreflightResult({ outcome: 'allow' }, 'tool/before'))
    .toThrow(/not supported/u);
  expect(() => validateEventPreflightResult({ outcome: 'ask' }, 'tool/before'))
    .toThrow(/not supported/u);
  expect(() => validateEventPreflightResult({ outcome: 'execute' }, 'tool/before'))
    .toThrow(/not supported/u);
  expect(() => validateEventPreflightResult({ outcome: 'continue', reason: 'x' }, 'tool/before'))
    .toThrow(/unsupported field/u);
  expect(() => validateEventPreflightResult(
    { outcome: 'deny', reason: 'blocked', updatedInput: {} },
    'tool/before',
  )).toThrow(/unsupported field/u);
  expect(() => validateEventPreflightResult({ outcome: 'continue', extra: true }, 'tool/before'))
    .toThrow(/unsupported field/u);
});

it('runs a gate with frozen cheap context and validates before returning', async () => {
  const context = {
    canonical: { event: 'tool/before' },
    host: { name: 'claude', nativeEvent: 'PreToolUse' },
    signal: new AbortController().signal,
    terminal: { interactive: false },
  } as unknown as EventPreflightContext<'tool/before'>;
  const result = await executeEventPreflight(
    (received) => {
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.host)).toBe(true);
      expect(received.host).toEqual({ name: 'claude', nativeEvent: 'PreToolUse' });
      return { outcome: 'deny', reason: 'blocked' };
    },
    context,
  );
  expect(result).toEqual({ outcome: 'deny', reason: 'blocked' });
  expect(Object.isFrozen(result)).toBe(true);
});

it('honors the framework-owned abort signal before and after an asynchronous gate', async () => {
  const controller = new AbortController();
  const context = {
    canonical: { event: 'tool/before' },
    host: { name: 'cursor', nativeEvent: 'preToolUse' },
    signal: controller.signal,
    terminal: { interactive: false },
  } as unknown as EventPreflightContext<'tool/before'>;
  await expect(executeEventPreflight(async () => {
    controller.abort(new Error('deadline elapsed'));
    return 'execute' as const;
  }, context)).rejects.toThrow(/deadline elapsed/u);
});

it('projects a gate decision through the rendered event outcome rules', () => {
  expect(projectEventPreflightResult(
    { outcome: 'continue' },
    'tool/before',
    'claude',
    'PreToolUse',
  )).toBeUndefined();
  expect(projectEventPreflightResult(
    { outcome: 'deny', reason: 'blocked' },
    'tool/before',
    'claude',
    'PreToolUse',
  )).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked',
    },
  });
});

it('re-exports the preflight contract through the public production path', () => {
  expect(publicValidateEventPreflightResult).toBe(validateEventPreflightResult);
  expect(publicEventFamilyAllowsPreflightDeny).toBe(eventFamilyAllowsPreflightDeny);
  expect(rootValidateEventPreflightResult).toBe(validateEventPreflightResult);
  expect(rootEventFamilyAllowsPreflightDeny).toBe(eventFamilyAllowsPreflightDeny);
  const result: PublicEventPreflightResult = publicValidateEventPreflightResult('execute', 'tool/before');
  const context: PublicEventPreflightContext = {} as EventPreflightContext;
  const authoring: EventPreflight = () => result;
  expect(result).toBe('execute');
  expect(authoring(context)).toBe('execute');
});
