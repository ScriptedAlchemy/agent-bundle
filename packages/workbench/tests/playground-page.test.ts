import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from '@rstest/core';

import type { PlaygroundReplay, PlaygroundSession, PlaygroundTraceEvent } from '../../agent-bundle/src/contracts/playground.ts';
import type { PlaygroundRun } from '../../agent-bundle/src/contracts/playground.ts';
import { PlaygroundClient } from '../src/playground/playground-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { playgroundViewFor } from '../src/playground/playground-model.ts';
import {
  cancelPlaygroundRun,
  createPlaygroundCancelFlight,
  createPlaygroundCatalogLifecycle,
  createPlaygroundObservationLifecycle,
  observePlaygroundRun,
  PlaygroundNativePromptControls,
  PlaygroundPage,
  PlaygroundTraceView,
} from '../src/playground/playground-page.tsx';

const epoch = { digest: 'sha256-current', id: 'epoch-current' };
const identity = {
  epoch: { digest: 'sha256-pinned', id: 'epoch-pinned' }, fixture: { digest: 'server', id: 'server-owned-workspace' },
  invocation: { intent: { skillId: 'review' }, kind: 'skill.inspect' }, target: { digest: 'portable', name: 'portable' },
  task: { id: 'run-1', text: 'Inspect an emitted Skill.' },
};
const session: PlaygroundSession = { cleanupFailures: [], createdAt: '2026-08-14T10:00:00.000Z', id: 'session-1', identity, state: 'open' };
const event = (sequence: number): PlaygroundTraceEvent => ({
  kind: sequence === 1 ? 'epoch.bound' : 'skill.inspected', raw: { sequence }, rawEventRef: `events.jsonl#${sequence}`,
  sequence, source: sequence === 1 ? 'build' : 'skill-evidence', summary: `Event ${sequence}`, timestamp: `2026-08-14T10:00:0${sequence}.000Z`,
});

const events: readonly PlaygroundTraceEvent[] = [event(1), event(2)];

const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

it('renders every trace row with its sequence, source, kind, epoch, and raw event reference', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: ['session-1/1'], session }),
  }));

  expect(markup).toContain('events.jsonl#1');
  expect(markup).toContain('events.jsonl#2');
  expect(markup).toContain('epoch-pinned');
  expect(markup).toContain('skill.inspected');
  expect(markup).toContain('Event 2');
  expect(markup).toContain('2026-08-14T10:00:01.000Z');
});

const run: PlaygroundRun = { id: 'run-1', session };

const nativeCatalog = {
  cases: [{ id: 'case:review', label: 'Review fixture' }],
  epochId: 'epoch-current',
  fixtures: [{ id: 'fixture:empty', label: 'Empty workspace' }],
  modelPins: [{ host: 'claude' as const, id: 'pin:sonnet', label: 'Sonnet — authored pin' }],
  selections: [{ caseId: 'case:review', fixtureId: 'fixture:empty', host: 'claude' as const, modelPinId: 'pin:sonnet' }],
} as const;

const deferred = <Value,>() => {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};

const replay = (nextSession: PlaygroundSession, events: readonly PlaygroundTraceEvent[] = []): PlaygroundReplay => ({
  cursor: { afterSequence: events.at(-1)?.sequence ?? 0 }, events, session: nextSession,
});

it('renders typed server-owned operation drafts including a catalog-selected script capability', () => {
  const client = new PlaygroundClient({ foreground: foreground(async () => { throw new Error('Static rendering issues no request.'); }) });
  const markup = renderToStaticMarkup(createElement(PlaygroundPage, {
    client, epoch, onRunChange: () => undefined, run: undefined, targets: [{ digest: 'portable', name: 'portable' }],
    scripts: [{ id: 'script:review', name: 'review', target: 'portable' }],
  } as unknown as Parameters<typeof PlaygroundPage>[0]));

  expect(markup).toContain('Start run');
  expect(markup).toContain('Skill inspection');
  expect(markup).toContain('Hook simulation');
  expect(markup).toContain('MCP tool call');
  expect(markup).toContain('Script execution');
  expect(markup).toContain('Native host prompt');
  expect(markup).not.toContain('Script execution is unavailable');
  for (const forbidden of ['playground-fixture', 'playground-task', 'playground-invocation', 'playground-outcome', 'playground-epoch']) {
    expect(markup).not.toContain(forbidden);
  }
});

it('renders a compact catalog-backed native prompt grid with no browser execution or model-value input', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundNativePromptControls, {
    catalog: nativeCatalog,
    catalogError: undefined,
    catalogLoading: false,
    disabled: false,
    onCaseChange: () => undefined,
    onFixtureChange: () => undefined,
    onHostChange: () => undefined,
    onPromptChange: () => undefined,
    onModelPinChange: () => undefined,
    onTargetChange: () => undefined,
    prompt: 'Review this fixture.',
    selection: { caseId: 'case:review', epochId: 'epoch-current', fixtureId: 'fixture:empty', host: 'claude', modelPinId: 'pin:sonnet' },
    target: 'claude',
    targets: [{ digest: 'sha256-claude', name: 'claude' }],
  }));

  for (const control of [
    'playground-native-target', 'playground-native-host', 'playground-native-case', 'playground-native-fixture',
    'playground-native-model-pin', 'playground-native-prompt',
  ]) expect(markup).toContain(control);
  expect(markup).toContain('Catalog epoch: epoch-current');
  expect(markup).toContain('Sonnet — authored pin');
  for (const forbidden of ['playground-native-command', 'playground-native-cwd', 'playground-native-env', 'playground-native-model-value', 'playground-native-path']) {
    expect(markup).not.toContain(forbidden);
  }
});

it('filters the server catalog to the selected target in stable script-id order', async () => {
  const { playgroundScriptsForTarget } = await import('../src/playground/playground-page.tsx');
  expect(playgroundScriptsForTarget([
    { id: 'script:zeta', name: 'zeta', target: 'portable' },
    { id: 'script:alpha', name: 'alpha', target: 'portable' },
    { id: 'script:other', name: 'other', target: 'claude' },
  ], 'portable')).toEqual([
    { id: 'script:alpha', name: 'alpha', target: 'portable' },
    { id: 'script:zeta', name: 'zeta', target: 'portable' },
  ]);
});

it('clears a stale script selection when its target catalog changes', async () => {
  const { playgroundSelectedScriptId } = await import('../src/playground/playground-page.tsx');
  const scripts = [
    { id: 'script:review', name: 'review', target: 'portable' },
    { id: 'script:verify', name: 'verify', target: 'claude' },
  ];

  expect(playgroundSelectedScriptId('script:review', scripts, 'portable')).toBe('script:review');
  expect(playgroundSelectedScriptId('script:review', scripts, 'claude')).toBe('');
  expect(playgroundSelectedScriptId('script:missing', scripts, 'portable')).toBe('');
});

it('fails closed while inspection of a replacement epoch has not published its script catalog', async () => {
  const { playgroundScriptsForEpoch } = await import('../src/playground/playground-page.tsx');
  const catalog = {
    epochId: 'epoch-previous',
    scripts: [{ id: 'script:review', name: 'review', target: 'portable' }],
  };

  expect(playgroundScriptsForEpoch(catalog, 'epoch-previous')).toEqual(catalog.scripts);
  expect(playgroundScriptsForEpoch(catalog, 'epoch-next')).toEqual([]);
  expect(playgroundScriptsForEpoch(undefined, 'epoch-next')).toEqual([]);
});

it('constrains raw trace evidence so one capped output line cannot widen the desktop page', async () => {
  const css = await readFile(join(process.cwd(), 'packages/workbench/src/playground/playground-page.css'), 'utf8');

  expect(css).toMatch(/\.playground-json \{[^}]*box-sizing: border-box;/u);
  expect(css).toContain('max-height: 22rem;');
  expect(css).toContain('max-width: min(36rem, calc(100vw - 120px));');
  expect(css).toContain('overflow: auto;');
  expect(css).toContain('overflow-wrap: anywhere;');
  expect(css).toContain('.playground-event-card');
  expect(css).toContain('.playground-native-grid');
});

it('renders ordered durable evidence as bounded disclosure cards instead of a widening trace table', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events: [event(1), event(2)], exported: undefined, selectedRefs: ['events.jsonl#2'], session }),
  }));

  expect(markup).toContain('<details');
  expect(markup).toContain('playground-event-card');
  expect(markup).not.toContain('playground-table');
  expect(markup).toContain('events.jsonl#2');
});

it('starts exactly one synchronous cancel flight until server drain and replay settle', async () => {
  const lifecycle = createPlaygroundCancelFlight();
  const blocked = deferred<void>();
  let calls = 0;
  const first = lifecycle.start(async () => {
    calls += 1;
    await blocked.promise;
  });
  const duplicate = lifecycle.start(async () => { calls += 1; });

  expect(first.started).toBe(true);
  expect(duplicate.started).toBe(false);
  expect(duplicate.done).toBe(first.done);
  blocked.resolve();
  await first.done;
  expect(lifecycle.start(async () => { calls += 1; }).started).toBe(true);
  expect(calls).toBe(2);
});

it('invalidates a held cancel flight before a replacement run can accept its replay', async () => {
  const lifecycle = createPlaygroundCancelFlight();
  const blocked = deferred<void>();
  let accepted = false;
  const stale = lifecycle.start(async (lease) => {
    await blocked.promise;
    if (lease.current()) accepted = true;
  });

  lifecycle.invalidate();
  blocked.resolve();
  await stale.done;

  expect(stale.signal.aborted).toBe(true);
  expect(accepted).toBe(false);
});

it('lets a cancel claim supersede held observer evidence before terminal replay commits', async () => {
  const observationLifecycle = createPlaygroundObservationLifecycle();
  const observation = observationLifecycle.begin();
  const heldSession = deferred<PlaygroundSession>();
  const terminalSession: PlaygroundSession = {
    ...session,
    outcome: { status: 'cancelled' },
    state: 'finalized',
  };
  const acceptedStates: string[] = [];
  const staleCommit = heldSession.promise.then((next) => {
    if (observation.current()) acceptedStates.push(next.state);
  });
  const cancellation = createPlaygroundCancelFlight().start((lease) => cancelPlaygroundRun({
    client: {
      cancel: async () => {
        expect(observation.current()).toBe(false);
        return true;
      },
      replay: async () => replay(terminalSession, [event(1)]),
    },
    lease,
    observation: observationLifecycle,
    onEvents: () => undefined,
    onObservationRestart: () => undefined,
    onSession: (next) => acceptedStates.push(next.state),
    runId: 'run-1',
    sessionId: 'session-1',
  }));

  await cancellation.done;
  heldSession.resolve(session);
  await staleCommit;

  expect(observation.signal.aborted).toBe(true);
  expect(acceptedStates).toEqual(['finalized']);
});

it('requests a fresh observation when a current cancel attempt fails', async () => {
  const observationLifecycle = createPlaygroundObservationLifecycle();
  const original = observationLifecycle.begin();
  let replacement: ReturnType<typeof observationLifecycle.begin> | undefined;
  const cancellation = createPlaygroundCancelFlight().start((lease) => cancelPlaygroundRun({
    client: {
      cancel: async () => { throw new Error('cancel unavailable'); },
      replay: async () => replay(session),
    },
    lease,
    observation: observationLifecycle,
    onEvents: () => undefined,
    onObservationRestart: () => { replacement = observationLifecycle.begin(); },
    onSession: () => undefined,
    runId: 'run-1',
    sessionId: 'session-1',
  }));

  await expect(cancellation.done).rejects.toThrow('cancel unavailable');

  expect(original.signal.aborted).toBe(true);
  expect(replacement?.current()).toBe(true);
});

it('aborts and rejects a stale catalog completion before accepting a replacement client or epoch', () => {
  const lifecycle = createPlaygroundCatalogLifecycle();
  const clientA = {} as PlaygroundClient;
  const clientB = {} as PlaygroundClient;
  const a = lifecycle.begin({ client: clientA, epochId: 'epoch-A' });
  const b = lifecycle.begin({ client: clientB, epochId: 'epoch-B' });
  const accepted: string[] = [];

  if (a.current()) accepted.push('A');
  if (b.current()) accepted.push('B');

  expect(a.signal.aborted).toBe(true);
  expect(a.current()).toBe(false);
  expect(b.current()).toBe(true);
  expect(b.key).toEqual({ client: clientB, epochId: 'epoch-B', generation: 2 });
  expect(accepted).toEqual(['B']);
});

it('keeps a reentrant catalog replacement distinct from the outer lease that triggered it', () => {
  const lifecycle = createPlaygroundCatalogLifecycle();
  const client = {} as PlaygroundClient;
  const first = lifecycle.begin({ client, epochId: 'epoch-A' });
  let nested: ReturnType<typeof lifecycle.begin> | undefined;
  first.signal.addEventListener('abort', () => {
    nested = lifecycle.begin({ client, epochId: 'epoch-B' });
  }, { once: true });

  const outer = lifecycle.begin({ client, epochId: 'epoch-C' });

  expect(nested).toBeDefined();
  expect(nested?.key.generation).not.toBe(outer.key.generation);
  expect(nested?.current()).toBe(false);
  expect(outer.current()).toBe(true);
});

it('renders the pinned server epoch and persisted event references, not a rebuilt current epoch', () => {
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events: [event(1), event(2)], exported: undefined, selectedRefs: ['events.jsonl#2'], session }),
  }));
  expect(markup).toContain('epoch-pinned');
  expect(markup).toContain('events.jsonl#2');
  expect(markup).not.toContain('epoch-current');
});

it('renders persisted script stdout, stderr, and exit evidence from the server trace', () => {
  const scriptEvent: PlaygroundTraceEvent = {
    kind: 'script.completed',
    raw: { result: { exitCode: 17, script: 'review', stderr: 'script stderr', stdout: 'script stdout' } },
    rawEventRef: 'events.jsonl#3',
    sequence: 3,
    source: 'script',
    summary: 'Ran emitted script.',
    timestamp: '2026-08-14T10:00:03.000Z',
  };
  const markup = renderToStaticMarkup(createElement(PlaygroundTraceView, {
    view: playgroundViewFor({ epoch, events: [scriptEvent], exported: undefined, selectedRefs: [], session }),
  }));

  expect(markup).toContain('script stdout');
  expect(markup).toContain('script stderr');
  expect(markup).toContain('17');
});

it('reconnects a cleanly ended open stream from the last accepted sequence before final replay', async () => {
  const terminal: PlaygroundSession = { ...session, outcome: { status: 'passed' }, state: 'finalized' };
  const reconnectingStream = deferred<void>();
  const streamCursors: number[] = [];
  const replayCursors: number[] = [];
  const requestSignals: AbortSignal[] = [];
  const eventSnapshots: (readonly PlaygroundTraceEvent[])[] = [];
  const delays: number[] = [];
  let streamCount = 0;
  let sessionCount = 0;
  await observePlaygroundRun({
    client: {
      replay: async (_sessionId, after, signal) => {
        replayCursors.push(after ?? 0);
        requestSignals.push(signal!);
        return replay(after === 2 ? terminal : session, after === 0 ? [event(1)] : []);
      },
      session: async (_sessionId, signal) => {
        requestSignals.push(signal!);
        sessionCount += 1;
        return sessionCount === 1 ? session : terminal;
      },
      stream: (_sessionId, options) => {
        streamCursors.push(options.afterSequence ?? 0);
        streamCount += 1;
        options.onEvent(event(streamCount));
        return streamCount === 1
          ? { close: () => undefined, done: Promise.resolve() }
          : { close: () => reconnectingStream.resolve(), done: reconnectingStream.promise };
      },
    },
    onEvents: (events) => { eventSnapshots.push(events); },
    onSession: () => undefined,
    run,
    signal: new AbortController().signal,
    wait: async (milliseconds, signal) => { delays.push(milliseconds); requestSignals.push(signal); },
  });

  expect(streamCursors).toEqual([0, 1]);
  expect(replayCursors).toEqual([1, 2]);
  expect(eventSnapshots.at(-1)?.map((entry) => entry.sequence)).toEqual([1, 2]);
  expect(delays).toContain(100);
  expect(delays).toContain(250);
  expect(requestSignals.every((signal) => !signal.aborted)).toBe(true);
});

it('suppresses a replaced run after its abort signal resolves a stale replay', async () => {
  const firstReplay = deferred<PlaygroundReplay>();
  const streamDone = deferred<void>();
  const staleEvents: (readonly PlaygroundTraceEvent[])[] = [];
  const staleSessions: PlaygroundSession[] = [];
  const firstController = new AbortController();
  const first = observePlaygroundRun({
    client: {
      replay: async () => firstReplay.promise,
      session: async () => session,
      stream: () => ({ close: () => streamDone.resolve(), done: streamDone.promise }),
    },
    onEvents: (events) => { staleEvents.push(events); },
    onSession: (next) => { staleSessions.push(next); },
    run,
    signal: firstController.signal,
    wait: async () => undefined,
  });
  firstController.abort();
  firstReplay.resolve(replay(session, [event(1)]));
  await first;

  expect(staleEvents).toEqual([]);
  expect(staleSessions).toEqual([]);
});

it('closes the live stream and suppresses stale callbacks after Playground unmount aborts', async () => {
  const blockedReplay = deferred<PlaygroundReplay>();
  const streamDone = deferred<void>();
  const controller = new AbortController();
  let closeCount = 0;
  const events: (readonly PlaygroundTraceEvent[])[] = [];
  const observer = observePlaygroundRun({
    client: {
      replay: async () => blockedReplay.promise,
      session: async () => session,
      stream: () => ({ close: () => { closeCount += 1; streamDone.resolve(); }, done: streamDone.promise }),
    },
    onEvents: (next) => { events.push(next); },
    onSession: () => undefined,
    run,
    signal: controller.signal,
    wait: async () => undefined,
  });
  controller.abort();
  blockedReplay.resolve(replay(session, [event(1)]));
  await observer;

  expect(closeCount).toBe(1);
  expect(events).toEqual([]);
});

it('closes and drains the stream when final replay rejects before the run can complete', async () => {
  const terminal: PlaygroundSession = { ...session, outcome: { status: 'failed' }, state: 'finalized' };
  const streamDone = deferred<void>();
  let closeCount = 0;
  let replayCount = 0;
  let readerDrained = false;
  const observer = observePlaygroundRun({
    client: {
      replay: async () => {
        replayCount += 1;
        if (replayCount === 1) return replay(terminal);
        throw new Error('final replay failed');
      },
      session: async () => terminal,
      stream: () => ({
        close: () => { closeCount += 1; readerDrained = true; streamDone.resolve(); },
        done: streamDone.promise,
      }),
    },
    onEvents: () => undefined,
    onSession: () => undefined,
    run,
    signal: new AbortController().signal,
    wait: async () => undefined,
  });

  await expect(observer).rejects.toThrow('final replay failed');
  expect(closeCount).toBe(1);
  expect(readerDrained).toBe(true);
});

it('invalidates a queued old trace callback before replacement clears the page-owned trace', () => {
  const lifecycle = createPlaygroundObservationLifecycle();
  const old = lifecycle.begin();
  let pageTrace: readonly PlaygroundTraceEvent[];
  const queuedOldEvent = (): void => {
    if (old.current()) pageTrace = [event(1)];
  };

  lifecycle.invalidate();
  pageTrace = [];
  queuedOldEvent();

  expect(old.signal.aborted).toBe(true);
  expect(pageTrace).toEqual([]);
});
