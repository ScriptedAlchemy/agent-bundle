import { expect, it } from '@rstest/core';

import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundSimulation,
} from '../../agent-bundle/src/dev/playground/hook-playground-service.ts';
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
  expect(view.summary).toContain('selected build');
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
  expect(empty.summary).toContain('no generated Hooks');
  expect(missing.state).toBe('no-epoch');
  expect(missing.summary).toContain('No successful build is available');
});

it('keeps loading and a list failure distinct from an empty hook list', () => {
  const loading = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks: [], listState: 'loading', result: undefined, selectedKey: undefined });
  const failed = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks: [], listState: 'error', result: undefined, selectedKey: undefined });

  expect(loading.state).toBe('loading');
  expect(loading.summary).not.toContain('no generated hooks');
  expect(failed.state).toBe('list-error');
  expect(failed.summary).not.toContain('no generated hooks');
});

it('returns a deeply detached frozen view without invoking response accessors', () => {
  const input: Record<string, unknown> = Object.create(null);
  const nested: Record<string, unknown> = Object.create(null);
  nested.items = [{ value: 'original' }];
  Object.defineProperty(input, '__proto__', { configurable: true, enumerable: true, value: nested, writable: true });
  input.nested = nested;
  const mutable = {
    ...simulation,
    canonicalIntent: { ...simulation.canonicalIntent, input: input as HookPlaygroundSimulation['canonicalIntent']['input'] },
    canonicalResult: { nested: { value: 'original' } },
    nativeInput: { nested: { value: 'original' } },
    nativeOutput: { nested: { value: 'original' } },
    replay: { ...simulation.replay, binding: { ...simulation.replay.binding }, input: input as HookPlaygroundSimulation['replay']['input'] },
  } as HookPlaygroundSimulation;

  const view = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: mutable, selectedKey: 'claude/hook:session-start' });
  const viewInput = view.canonicalInput as Record<string, unknown>;
  const viewNested = viewInput.nested as Record<string, unknown>;

  nested.items = [{ value: 'changed' }];
  (mutable.canonicalResult as Record<string, unknown>).nested = { value: 'changed' };

  expect(view.canonicalInput).not.toBe(input);
  expect(Object.getPrototypeOf(view.canonicalInput!)).toBeNull();
  expect(Object.hasOwn(viewInput, '__proto__')).toBe(true);
  expect(viewInput.__proto__).not.toBe(nested);
  expect(((viewNested.items as Array<Record<string, string>>)[0]?.value)).toBe('original');
  expect((view.canonicalResult?.nested as Record<string, string>).value).toBe('original');
  expect(view.replay?.binding).not.toBe(mutable.replay.binding);
  expect(view.selected?.binding).not.toBe(hooks[0]?.binding);
  expect(Object.isFrozen(viewInput)).toBe(true);
  expect(Object.isFrozen(viewInput.__proto__ as object)).toBe(true);
  expect(Object.isFrozen(viewNested.items as object)).toBe(true);

  let accessorReads = 0;
  const accessorSimulation = { ...simulation } as HookPlaygroundSimulation;
  Object.defineProperty(accessorSimulation, 'canonicalResult', {
    configurable: true,
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return { unsafe: true };
    },
  });

  expect(() => hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: accessorSimulation, selectedKey: undefined })).toThrow('accessors');
  expect(accessorReads).toBe(0);
});

it('detaches and freezes diagnostic arrays and entries', () => {
  const sourceDiagnostics: Array<{ code: 'hook.playground.event.unsupported'; event: string; message: string; severity: 'error'; target: string }> = [{
      code: 'hook.playground.event.unsupported',
      event: 'sessionStart',
      message: 'Original diagnostic',
      severity: 'error',
      target: 'codex',
    }];
  const result: HookPlaygroundDiagnosticResult = {
    diagnostics: sourceDiagnostics,
  };

  const view = hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result, selectedKey: undefined });
  sourceDiagnostics[0]!.message = 'Changed diagnostic';

  expect(view.diagnostics).not.toBe(result.diagnostics);
  expect(view.diagnostics[0]).not.toBe(result.diagnostics[0]);
  expect(view.diagnostics[0]?.message).toBe('Original diagnostic');
  expect(Object.isFrozen(view.diagnostics)).toBe(true);
  expect(Object.isFrozen(view.diagnostics[0]!)).toBe(true);
});
