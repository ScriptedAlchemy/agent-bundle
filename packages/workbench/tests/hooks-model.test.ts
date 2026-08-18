import { expect, it } from '@rstest/core';

import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundSimulation,
} from '../../agent-bundle/src/dev/hook-playground-service.ts';
import {
  canonicalIntentRowsFor,
  hookOptionKeyFor,
  hookOptionsFor,
  hookPlaygroundViewFor,
  hostMappingRowsFor,
} from '../src/hooks/hooks-model.ts';

const hooks: readonly HookPlaygroundHook[] = [
  {
    binding: { epochId: 'epoch-1', hook: 'hook:stop', target: 'claude' },
    hook: { event: 'stop', id: 'hook:stop', name: 'stop', path: 'claude/hooks/stop.mjs', target: 'claude' },
  },
  {
    binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
    hook: { event: 'sessionStart', id: 'hook:session-start', name: 'session-start', path: 'claude/hooks/session-start.mjs', target: 'claude', timeout: 30 },
  },
];

const simulation: HookPlaygroundSimulation = {
  binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
  canonicalIntent: {
    event: 'sessionStart',
    hook: 'hook:session-start',
    input: { cwd: '/workspace', sessionId: 'session-1', source: 'startup', transcriptPath: '/workspace/transcript.jsonl' },
  },
  canonicalResult: { additionalContext: 'Ready' },
  hostMapping: {
    canonicalEvent: 'sessionStart',
    matcher: 'startup',
    nativeEvent: 'SessionStart',
    nativeProjection: 'deterministic',
    nativeSelector: 'SessionStart',
    target: 'claude',
    wrapperPath: 'claude/hooks/session-start.mjs',
  },
  nativeInput: { cwd: '/workspace', hook_event_name: 'SessionStart', session_id: 'session-1' },
  nativeOutput: { hookSpecificOutput: { additionalContext: 'Ready', hookEventName: 'SessionStart' } },
  replay: {
    binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
    input: { cwd: '/workspace', sessionId: 'session-1', source: 'startup', transcriptPath: '/workspace/transcript.jsonl' },
  },
};

const diagnostics: HookPlaygroundDiagnosticResult = {
  diagnostics: [{
    code: 'hook.playground.target.unsupported',
    event: 'sessionStart',
    message: 'Hook playground cannot map target "codex" for canonical event "sessionStart".',
    severity: 'error',
    target: 'codex',
  }],
};

it('orders hook options deterministically and keys them by target and hook', () => {
  const options = hookOptionsFor(hooks);

  expect(options.map((option) => option.key)).toEqual(['claude/hook:session-start', 'claude/hook:stop']);
  expect(options[0]).toMatchObject({ event: 'sessionStart', path: 'claude/hooks/session-start.mjs', timeout: 30 });
  expect(options[1]?.timeout).toBeUndefined();
  expect(Object.isFrozen(options)).toBe(true);
  expect(hookOptionKeyFor({ epochId: 'epoch-2', hook: 'hook:stop', target: 'codex' })).toBe('codex/hook:stop');
});

it('derives canonical intent and host mapping rows from a simulation', () => {
  expect(canonicalIntentRowsFor(simulation.canonicalIntent)).toEqual([
    { label: 'Canonical event', value: 'sessionStart' },
    { label: 'Hook', value: 'hook:session-start' },
  ]);
  expect(hostMappingRowsFor(simulation.hostMapping)).toEqual([
    { label: 'Target', value: 'claude' },
    { label: 'Canonical event', value: 'sessionStart' },
    { label: 'Native event', value: 'SessionStart' },
    { label: 'Native selector', value: 'SessionStart' },
    { label: 'Matcher', value: 'startup' },
    { label: 'Wrapper path', value: 'claude/hooks/session-start.mjs' },
    { label: 'Native projection', value: 'deterministic' },
  ]);
});

it('omits the matcher row when the emitted manifest declares none', () => {
  const rows = hostMappingRowsFor({
    canonicalEvent: 'sessionStart',
    nativeEvent: 'SessionStart',
    nativeProjection: 'deterministic',
    nativeSelector: 'SessionStart',
    target: 'claude',
    wrapperPath: 'claude/hooks/session-start.mjs',
  });

  expect(rows.map((row) => row.label)).not.toContain('Matcher');
});

it('derives a simulated view with every canonical and native trace section', () => {
  const view = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: simulation, selectedKey: 'claude/hook:session-start' });

  expect(view.state).toBe('simulated');
  expect(view.summary).toContain('epoch-1');
  expect(view.selected?.key).toBe('claude/hook:session-start');
  expect(view.canonicalInput).toEqual(simulation.canonicalIntent.input);
  expect(view.nativeInput).toEqual(simulation.nativeInput);
  expect(view.nativeOutput).toEqual(simulation.nativeOutput);
  expect(view.canonicalResult).toEqual(simulation.canonicalResult);
  expect(view.replay).toEqual(simulation.replay);
  expect(view.diagnostics).toEqual([]);
  expect(Object.isFrozen(view)).toBe(true);
});

it('keeps a simulation without a canonical result explicit', () => {
  const view = hookPlaygroundViewFor({
    epochId: 'epoch-1',
    hooks,
    result: { ...simulation, canonicalResult: undefined, nativeOutput: undefined },
    selectedKey: undefined,
  });

  expect(view.state).toBe('simulated');
  expect(view.canonicalResult).toBeUndefined();
  expect(view.nativeOutput).toBeUndefined();
});

it('surfaces returned diagnostics instead of a simulation', () => {
  const view = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: diagnostics, selectedKey: undefined });

  expect(view.state).toBe('diagnostics');
  expect(view.diagnostics).toEqual(diagnostics.diagnostics);
  expect(view.replay).toBeUndefined();
  expect(view.mapping).toEqual([]);
});

it('reports the ready, empty, and no-active-epoch states', () => {
  const ready = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: undefined, selectedKey: undefined });
  const empty = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks: [], result: undefined, selectedKey: undefined });
  const missing = hookPlaygroundViewFor({ epochId: undefined, hooks: [], result: undefined, selectedKey: undefined });

  expect(ready.state).toBe('ready');
  expect(ready.selected?.key).toBe('claude/hook:session-start');
  expect(empty.state).toBe('empty');
  expect(empty.selected).toBeUndefined();
  expect(empty.summary).toContain('no generated hooks');
  expect(missing.state).toBe('no-epoch');
  expect(missing.summary).toContain('No artifact epoch is active');
});
