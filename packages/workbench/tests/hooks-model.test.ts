import { expect, it } from '@rstest/core';

import type {
  HookPlaygroundHook,
  HookPlaygroundSimulation,
} from '../../agent-bundle/src/dev/playground/hook-playground-service.ts';
import {
  canonicalHookInput,
  canonicalHookInputFor,
  canonicalIntentRowsFor,
  hookOptionKeyFor,
  hookOptionsFor,
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

it('orders hook options deterministically and keys them by target and hook', () => {
  const options = hookOptionsFor(hooks);

  expect(options.map((option) => option.key)).toEqual(['claude/hook:session-start', 'claude/hook:stop']);
  expect(options.map((option) => option.label)).toEqual(['Session start · Claude', 'Stop · Claude']);
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

it('provides event-shaped canonical documents for each Hook event', () => {
  expect(canonicalHookInput('sessionStart')).toEqual({
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    source: 'workbench',
    transcriptPath: '/workspace/transcript.json',
  });
  expect(canonicalHookInput('beforeTool')).toEqual({
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    toolInput: {},
    toolName: 'shell',
    toolUseId: 'workbench-preview-tool',
    transcriptPath: '/workspace/transcript.json',
  });
  expect(canonicalHookInput('afterTool')).toEqual({
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    toolInput: {},
    toolName: 'shell',
    toolResponse: {},
    toolUseId: 'workbench-preview-tool',
    transcriptPath: '/workspace/transcript.json',
  });
  expect(canonicalHookInput('stop')).toEqual({
    cwd: '/workspace',
    lastAssistantMessage: 'Workbench preview completed.',
    sessionId: 'workbench-preview',
    stopHookActive: false,
    transcriptPath: '/workspace/transcript.json',
  });
  expect(canonicalHookInputFor('sessionStart')).toEqual(canonicalHookInput('sessionStart'));
  expect(canonicalHookInputFor('unknown-event')).toBeUndefined();
});
