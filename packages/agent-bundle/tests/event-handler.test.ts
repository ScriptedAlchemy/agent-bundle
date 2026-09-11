import { expect, it } from '@rstest/core';

import {
  executeEventHandler,
  validateEventHandlerResult,
  type EventHandlerContext,
} from '../src/events/handler.ts';
import { projectEventHandlerResult } from '../src/events/projection.ts';
import { eventContracts } from '../src/routes/events.ts';
import { canonicalAgentEvents, type CanonicalAgentEvent } from '../src/routes/public.ts';

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
    expect(eventContracts[event].deny).toBe(true);
  }
  for (const event of familiesThatRejectDeny) {
    expect(eventContracts[event].deny).toBe(false);
  }
});

it('validates execute and continue results without a host decision', () => {
  expect(validateEventHandlerResult(undefined, 'tool/before')).toEqual({ outcome: 'continue' });
  expect(() => validateEventHandlerResult('execute', 'tool/before')).toThrow();
  expect(validateEventHandlerResult(
    { data: { tickets: ['cc-7'] }, module: './before.view.js', outcome: 'render' },
    'tool/after',
    './before.view.js',
  )).toEqual({ data: { tickets: ['cc-7'] }, module: './before.view.js', outcome: 'render' });
  expect(validateEventHandlerResult({ outcome: 'continue' }, 'tool/after')).toEqual({
    outcome: 'continue',
  });
  expect(Object.isFrozen(validateEventHandlerResult({ outcome: 'continue' }, 'session/start'))).toBe(true);
});

it('validates a denying result only when the family admits deny and the reason is nonempty', () => {
  expect(validateEventHandlerResult({ outcome: 'deny', reason: 'blocked command' }, 'tool/before')).toEqual({
    outcome: 'deny',
    reason: 'blocked command',
  });
  expect(() => validateEventHandlerResult({ outcome: 'deny' }, 'tool/before'))
    .toThrow(/requires a nonempty reason when outcome is deny/u);
  expect(() => validateEventHandlerResult({ outcome: 'deny', reason: '' }, 'stop'))
    .toThrow(/requires a nonempty reason when outcome is deny/u);
  expect(() => validateEventHandlerResult({ outcome: 'deny', reason: '   ' }, 'prompt/submit'))
    .toThrow(/requires a nonempty reason when outcome is deny/u);
});

it('rejects deny on observation-only families instead of copying host projection', () => {
  for (const event of familiesThatRejectDeny) {
    expect(() => validateEventHandlerResult({ outcome: 'deny', reason: 'no' }, event))
      .toThrow(new RegExp(`${event.replace('/', '\\/')} cannot deny`, 'u'));
  }
});

it('rejects unsupported handler fields and results', () => {
  expect(() => validateEventHandlerResult('continue', 'tool/before'))
    .toThrow(/Event handler result/u);
  expect(() => validateEventHandlerResult({ outcome: 'allow' }, 'tool/before'))
    .toThrow(/not supported/u);
  expect(() => validateEventHandlerResult({ outcome: 'ask' }, 'tool/before'))
    .toThrow(/not supported/u);
  expect(() => validateEventHandlerResult({ outcome: 'render', module: './before.view.js' }, 'tool/before', './before.view.js'))
    .toThrow(/JSON values/u);
  expect(() => validateEventHandlerResult({ data: new Date(), module: './before.view.js', outcome: 'render' }, 'tool/before', './before.view.js'))
    .toThrow(/JSON objects must be plain objects/u);
  expect(() => validateEventHandlerResult({ outcome: 'continue', reason: 'x' }, 'tool/before'))
    .toThrow(/unsupported field/u);
  expect(() => validateEventHandlerResult(
    { outcome: 'deny', reason: 'blocked', updatedInput: {} },
    'tool/before',
  )).toThrow(/unsupported field/u);
  expect(() => validateEventHandlerResult({ outcome: 'continue', extra: true }, 'tool/before'))
    .toThrow(/unsupported field/u);
});

it('runs a gate with frozen cheap context and validates before returning', async () => {
  const context = {
    canonical: { event: 'tool/before' },
    host: { name: 'claude', nativeEvent: 'PreToolUse' },
    signal: new AbortController().signal,
    terminal: { interactive: false },
  } as unknown as EventHandlerContext<'tool/before'>;
  const result = await executeEventHandler(
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
  } as unknown as EventHandlerContext<'tool/before'>;
  const execution = executeEventHandler(
    () => new Promise(() => undefined),
    context,
  );
  queueMicrotask(() => { controller.abort(new Error('deadline elapsed')); });
  await expect(execution).rejects.toThrow(/deadline elapsed/u);
});

it('projects a gate decision through the rendered event outcome rules', () => {
  expect(projectEventHandlerResult(
    { outcome: 'continue' },
    'tool/before',
    'claude',
    'PreToolUse',
  )).toBeUndefined();
  expect(projectEventHandlerResult(
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
