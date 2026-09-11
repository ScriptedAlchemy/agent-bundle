import { expect, it } from '@rstest/core';

import {
  createEventTracer,
  eventTraceEventKinds,
  eventTraceExecution,
  eventTraceObserver,
  eventTracePhases,
  installEventTraceObserver,
  summarizeEventTraceError,
  type EventTraceErrorSummary,
  type EventTraceEvent,
  type EventTraceEventKind,
  type EventTraceExecution,
  type EventTracePhase,
} from '../src/events/trace.ts';
import {
  createEventTracer as runtimeCreateEventTracer,
  eventTraceExecution as runtimeEventTraceExecution,
  summarizeEventTraceError as runtimeSummarizeEventTraceError,
} from '../src/events/project.ts';
import {
  createEventTracer as apiCreateEventTracer,
  eventTraceExecution as apiEventTraceExecution,
  summarizeEventTraceError as apiSummarizeEventTraceError,
} from '../src/api.ts';
import {
  createEventTracer as rootCreateEventTracer,
  eventTraceExecution as rootEventTraceExecution,
  summarizeEventTraceError as rootSummarizeEventTraceError,
  type EventTraceEvent as RootEventTraceEvent,
  type EventTraceObserver as RootEventTraceObserver,
} from '../src/index.ts';

const execution: EventTraceExecution = eventTraceExecution({
  event: 'tool/before',
  executionId: 'exec-1',
  host: 'claude',
  nativeEvent: 'PreToolUse',
});

/** A deterministic monotonic clock: every read advances by `step`. */
const ticking = (step = 10) => {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
};

const collect = () => {
  const events: EventTraceEvent[] = [];
  return {
    events,
    observer: (event: EventTraceEvent) => { events.push(event); },
  };
};

/** Compile-time proof the union stays exhaustive: adding a kind fails here until handled. */
const phaseOf = (event: EventTraceEvent): EventTracePhase => {
  switch (event.kind) {
    case 'handler.start':
    case 'handler.outcome':
      return 'handler';
    case 'execute.start':
      return 'execute';
    case 'providers.start':
    case 'providers.finish':
      return 'providers';
    case 'render.start':
    case 'render.finish':
      return 'render';
    case 'failure':
      return event.phase;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

const describePhase = (phase: EventTracePhase): string => {
  switch (phase) {
    case 'handler':
      return 'gate';
    case 'execute':
      return 'deferred route load';
    case 'providers':
      return 'provider materialization';
    case 'render':
      return 'route render';
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
};

it('freezes the execution identity and mints an id when none is given', () => {
  expect(Object.isFrozen(execution)).toBe(true);
  expect(execution).toEqual({
    event: 'tool/before',
    executionId: 'exec-1',
    host: 'claude',
    nativeEvent: 'PreToolUse',
  });
  const minted = eventTraceExecution({ event: 'stop', host: 'codex', nativeEvent: 'stop' });
  const again = eventTraceExecution({ event: 'stop', host: 'codex', nativeEvent: 'stop' });
  expect(minted.executionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(minted.executionId).not.toBe(again.executionId);
  expect(() => eventTraceExecution({ event: 'stop', executionId: '', host: 'codex', nativeEvent: 'stop' }))
    .toThrow(/executionId/u);
  expect(() => eventTraceExecution({ event: 'stop', host: '', nativeEvent: 'stop' }))
    .toThrow(/host/u);
  expect(() => eventTraceExecution({ event: 'stop', host: 'codex', nativeEvent: ' ' }))
    .toThrow(/nativeEvent/u);
});

it('enumerates every kind and phase the union carries', () => {
  const kinds: readonly EventTraceEventKind[] = eventTraceEventKinds;
  expect([...kinds].sort()).toEqual([
    'execute.start',
    'failure',
    'handler.outcome',
    'handler.start',
    'providers.finish',
    'providers.start',
    'render.finish',
    'render.start',
  ]);
  expect([...eventTracePhases]).toEqual(['handler', 'execute', 'providers', 'render']);
  for (const phase of eventTracePhases) {
    expect(describePhase(phase)).toEqual(expect.any(String));
  }
  expect(Object.isFrozen(eventTraceEventKinds)).toBe(true);
  expect(Object.isFrozen(eventTracePhases)).toBe(true);
});

it('emits a complete executing trace with monotonic sequence, timestamps, and phase durations', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: ticking(), observer });
  expect(tracer.enabled).toBe(true);
  expect(tracer.execution).toBe(execution);

  tracer.handlerStart();
  tracer.handlerOutcome({ outcome: 'render', module: './before.view.js', data: null });
  tracer.executeStart('standalone');
  tracer.providersStart();
  tracer.providersFinish(2);
  tracer.renderStart();
  tracer.renderFinish();

  expect(events.map((event) => event.kind)).toEqual([
    'handler.start',
    'handler.outcome',
    'execute.start',
    'providers.start',
    'providers.finish',
    'render.start',
    'render.finish',
  ]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(events.map((event) => event.at)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  expect(events.map(phaseOf)).toEqual([
    'handler',
    'handler',
    'execute',
    'providers',
    'providers',
    'render',
    'render',
  ]);
  for (const event of events) {
    expect(event.phase).toBe(phaseOf(event));
    expect(event.execution).toBe(execution);
    expect(Object.isFrozen(event)).toBe(true);
  }
  expect(events[1]).toEqual({
    at: 20,
    durationMs: 10,
    execution,
    kind: 'handler.outcome',
    outcome: 'render',
    phase: 'handler',
    sequence: 1,
  });
  expect(events[2]).toMatchObject({ kind: 'execute.start', runtime: 'standalone' });
  expect(events[4]).toMatchObject({ count: 2, durationMs: 10, kind: 'providers.finish' });
  expect(events[6]).toMatchObject({ durationMs: 10, kind: 'render.finish' });
});

it('measures overlapping providers as one aggregate phase', () => {
  const { events, observer } = collect();
  let now = 0;
  const tracer = createEventTracer({ execution, now: () => now, observer });

  tracer.providersStart();
  now = 10;
  tracer.providersStart();
  now = 20;
  tracer.providersFinish(1);
  now = 30;
  tracer.providersFinish(1);

  expect(events).toEqual([
    { at: 0, execution, kind: 'providers.start', phase: 'providers', sequence: 0 },
    { at: 30, count: 2, durationMs: 30, execution, kind: 'providers.finish', phase: 'providers', sequence: 1 },
  ]);
});

it('uses the process observer for framework-created tracers and restores it safely', () => {
  const { events, observer } = collect();
  const dispose = installEventTraceObserver(observer);
  expect(eventTraceObserver()).toBe(observer);
  const tracer = createEventTracer({ execution, now: ticking() });
  expect(tracer.enabled).toBe(true);
  tracer.handlerStart();
  expect(events).toHaveLength(1);
  dispose();
  expect(eventTraceObserver()).toBeUndefined();
  expect(createEventTracer({ execution }).enabled).toBe(false);
});

it('observes framework-created tracers when the process observer is installed after creation', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: ticking() });
  expect(tracer.enabled).toBe(false);

  const dispose = installEventTraceObserver(observer);
  expect(tracer.enabled).toBe(true);
  tracer.handlerStart();
  dispose();
  expect(tracer.enabled).toBe(false);
  tracer.handlerOutcome({ outcome: 'render', module: './before.view.js', data: null });

  expect(events.map((event) => event.kind)).toEqual(['handler.start']);
});

it('summarizes gate results without carrying the reason text', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: ticking(), observer });
  tracer.handlerStart();
  tracer.handlerOutcome({ outcome: 'deny', reason: 'blocked command' });
  expect(events[1]).toMatchObject({ kind: 'handler.outcome', outcome: 'deny' });
  expect(JSON.stringify(events[1])).not.toContain('blocked command');

  const second = collect();
  const other = createEventTracer({ execution, now: ticking(), observer: second.observer });
  other.handlerOutcome({ outcome: 'continue' });
  expect(second.events[0]).toMatchObject({ kind: 'handler.outcome', outcome: 'continue', sequence: 0 });
  expect(second.events[0]).not.toHaveProperty('durationMs');
});

it('omits a duration when the matching start was never observed', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: ticking(), observer });
  tracer.providersFinish(0);
  tracer.renderFinish();
  expect(events[0]).toEqual({
    at: 10,
    count: 0,
    execution,
    kind: 'providers.finish',
    phase: 'providers',
    sequence: 0,
  });
  expect(events[1]).toEqual({ at: 20, execution, kind: 'render.finish', phase: 'render', sequence: 1 });
});

it('records a terminal failure with an error-safe summary and then goes quiet', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: ticking(), observer });
  tracer.handlerStart();
  tracer.executeStart('shared');
  tracer.renderStart();
  const error = Object.assign(new Error('worker exited'), { code: 'E_WORKER', stack: 'secret stack' });
  tracer.failure('render', error);
  expect(tracer.closed).toBe(true);
  expect(events.at(-1)).toEqual({
    at: 40,
    durationMs: 30,
    error: { code: 'E_WORKER', message: 'worker exited', name: 'Error' },
    execution,
    kind: 'failure',
    phase: 'render',
    sequence: 3,
  });
  expect(JSON.stringify(events.at(-1))).not.toContain('secret stack');

  const length = events.length;
  tracer.renderFinish();
  tracer.failure('render', new Error('again'));
  tracer.handlerStart();
  expect(events).toHaveLength(length);
});

it('closes before delivering a terminal failure to a reentrant observer', () => {
  const events: EventTraceEvent[] = [];
  let reenter = (): void => {};
  const tracer = createEventTracer({
    execution,
    now: ticking(),
    observer: (event) => {
      events.push(event);
      if (event.kind === 'failure') reenter();
    },
  });
  reenter = () => tracer.renderStart();
  tracer.failure('execute', new Error('failed'));
  expect(events.map((event) => event.kind)).toEqual(['failure']);
});

it('measures a failure from the trace start when it has one and omits it otherwise', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: ticking(), observer });
  tracer.failure('handler', new TypeError('gate threw'));
  expect(events[0]).toEqual({
    at: 10,
    error: { message: 'gate threw', name: 'TypeError' },
    execution,
    kind: 'failure',
    phase: 'handler',
    sequence: 0,
  });
});

it('summarizes arbitrary thrown values without throwing and bounds the message', () => {
  const expectFrozenSummary = (summary: EventTraceErrorSummary): void => {
    expect(Object.isFrozen(summary)).toBe(true);
  };
  const plain = summarizeEventTraceError(new RangeError('out of range'));
  expect(plain).toEqual({ message: 'out of range', name: 'RangeError' });
  expectFrozenSummary(plain);

  const coded = summarizeEventTraceError(Object.assign(new Error('coded'), { code: 'ENOENT' }));
  expect(coded).toEqual({ code: 'ENOENT', message: 'coded', name: 'Error' });
  expect(summarizeEventTraceError(Object.assign(new Error('numeric'), { code: 42 }))).toEqual({
    message: 'numeric',
    name: 'Error',
  });

  expect(summarizeEventTraceError('a string')).toEqual({ message: 'a string', name: 'NonError' });
  expect(summarizeEventTraceError(undefined)).toEqual({ message: 'undefined', name: 'NonError' });
  expect(summarizeEventTraceError(null)).toEqual({ message: 'null', name: 'NonError' });
  expect(summarizeEventTraceError({ toString: () => { throw new Error('nope'); } })).toEqual({
    message: '[unprintable]',
    name: 'NonError',
  });
  const hostile = new Error('hostile');
  Object.defineProperty(hostile, 'message', { get: () => { throw new Error('trap'); } });
  Object.defineProperty(hostile, 'name', { get: () => { throw new Error('trap'); } });
  expect(summarizeEventTraceError(hostile)).toEqual({ message: '[unprintable]', name: 'Error' });

  const long = summarizeEventTraceError(new Error('x'.repeat(2_000)));
  expect(long.message).toHaveLength(512);
  expect(long.message.endsWith('…')).toBe(true);
  const unnamed = new Error('anonymous');
  Object.defineProperty(unnamed, 'name', { value: '' });
  expect(summarizeEventTraceError(unnamed).name).toBe('Error');
});

it('is a no-op when no observer is present', () => {
  let reads = 0;
  const tracer = createEventTracer({
    execution,
    now: () => { reads += 1; return reads; },
  });
  expect(tracer.enabled).toBe(false);
  expect(tracer.closed).toBe(false);
  tracer.handlerStart();
  tracer.handlerOutcome({ outcome: 'render', module: './before.view.js', data: null });
  tracer.executeStart('shared');
  tracer.providersStart();
  tracer.providersFinish(1);
  tracer.renderStart();
  tracer.renderFinish();
  tracer.failure('render', new Error('ignored'));
  expect(reads).toBe(0);
  expect(tracer.closed).toBe(true);
});

it('never lets an observer exception, mutation, or re-entry reach the caller', () => {
  const seen: EventTraceEvent[] = [];
  let tracer = createEventTracer({ execution, now: ticking(), observer: () => { throw new Error('observer bug'); } });
  expect(() => {
    tracer.handlerStart();
    tracer.handlerOutcome({ outcome: 'render', module: './before.view.js', data: null });
    tracer.executeStart('shared');
    tracer.providersStart();
    tracer.providersFinish(0);
    tracer.renderStart();
    tracer.renderFinish();
    tracer.failure('render', new Error('late'));
  }).not.toThrow();

  tracer = createEventTracer({
    execution,
    now: ticking(),
    observer: (event) => {
      seen.push(event);
      expect(() => { (event as { sequence: number }).sequence = 99; }).toThrow(TypeError);
      expect(() => { (event.execution as { host: string }).host = 'other'; }).toThrow(TypeError);
      // Re-entering the tracer from inside the observer must not corrupt ordering.
      if (event.kind === 'handler.start') tracer.renderStart();
    },
  });
  tracer.handlerStart();
  tracer.handlerOutcome({ outcome: 'continue' });
  expect(seen.map((event) => [event.kind, event.sequence])).toEqual([
    ['handler.start', 0],
    ['render.start', 1],
    ['handler.outcome', 2],
  ]);
});

it('never lets a broken clock reach the caller', () => {
  const { events, observer } = collect();
  const tracer = createEventTracer({ execution, now: () => { throw new Error('clock'); }, observer });
  expect(() => { tracer.handlerStart(); }).not.toThrow();
  expect(events).toHaveLength(0);
  expect(tracer.enabled).toBe(true);
});

it('is production-importable from the runtime, api, and root entries', () => {
  expect(runtimeCreateEventTracer).toBe(createEventTracer);
  expect(runtimeEventTraceExecution).toBe(eventTraceExecution);
  expect(runtimeSummarizeEventTraceError).toBe(summarizeEventTraceError);
  expect(apiCreateEventTracer).toBe(createEventTracer);
  expect(apiEventTraceExecution).toBe(eventTraceExecution);
  expect(apiSummarizeEventTraceError).toBe(summarizeEventTraceError);
  expect(rootCreateEventTracer).toBe(createEventTracer);
  expect(rootEventTraceExecution).toBe(eventTraceExecution);
  expect(rootSummarizeEventTraceError).toBe(summarizeEventTraceError);
  const observer: RootEventTraceObserver = (event: RootEventTraceEvent) => { phaseOf(event); };
  expect(rootCreateEventTracer({ execution, observer }).enabled).toBe(true);
});
