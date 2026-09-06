import { expect, it } from '@rstest/core';

import type { HostAvailability, HostSession } from '../../agent-bundle/src/contracts/host-sessions.ts';
import {
  availabilityFor,
  defaultHostSessionSize,
  hostLabel,
  hostSessionPromptFor,
  initialHostSessionsState,
  reduceHostSessions,
  sessionStateLabel,
} from '../src/sessions/host-session-model.ts';
import { cliLeaf, eventLeaf, skillLeaf, toolLeaf } from './support/workspace-fixtures.ts';

const session = (id: string, startedAt: number, extras: Partial<HostSession> = {}): HostSession => Object.freeze({
  authority: Object.freeze({ epochId: 'epoch-1', install: '/home/dev/.codex/plugins/curator', projectRoot: '/work/curator' }),
  cols: 120,
  host: 'codex',
  id,
  rows: 32,
  startedAt,
  state: 'running',
  ...extras,
});

const hosts: readonly HostAvailability[] = Object.freeze([
  Object.freeze({ host: 'claude', launchable: true }),
  Object.freeze({ host: 'codex', launchable: false, reason: 'no dev install attached' }),
]);

it('lists newest first, replaces a record by id on every state frame, forgets, and keeps errors until the next list', () => {
  const older = session('hs_a', 1_000);
  const newer = session('hs_b', 2_000);
  const listed = reduceHostSessions(initialHostSessionsState, { hosts, sessions: [older, newer], type: 'list' });
  expect(listed.loaded).toBe(true);
  expect(listed.sessions.map((entry) => entry.id)).toEqual(['hs_b', 'hs_a']);
  expect(Object.isFrozen(listed) && Object.isFrozen(listed.sessions)).toBe(true);

  const attached = reduceHostSessions(listed, { session: session('hs_a', 1_000, { traceSessionId: 'codex-thread-1' }), type: 'session' });
  expect(attached.sessions.map((entry) => [entry.id, entry.traceSessionId])).toEqual([['hs_b', undefined], ['hs_a', 'codex-thread-1']]);

  const exited = reduceHostSessions(attached, { session: session('hs_b', 2_000, { endedAt: 2_500, exitCode: 1, state: 'exited' }), type: 'session' });
  expect(exited.sessions[0]).toMatchObject({ exitCode: 1, id: 'hs_b', state: 'exited' });

  const launched = reduceHostSessions(exited, { session: session('hs_c', 3_000, { restartOf: 'hs_b' }), type: 'session' });
  expect(launched.sessions.map((entry) => entry.id)).toEqual(['hs_c', 'hs_b', 'hs_a']);

  const forgotten = reduceHostSessions(launched, { id: 'hs_b', type: 'forget' });
  expect(forgotten.sessions.map((entry) => entry.id)).toEqual(['hs_c', 'hs_a']);

  const failed = reduceHostSessions(initialHostSessionsState, { message: 'AB8265 host sessions unavailable', type: 'error' });
  expect(failed).toMatchObject({ error: 'AB8265 host sessions unavailable', loaded: true, sessions: [] });
  expect(reduceHostSessions(failed, { session: older, type: 'session' }).error).toBeUndefined();
  expect(reduceHostSessions(failed, { hosts, sessions: [], type: 'list' }).error).toBeUndefined();
});

it('names hosts and states, resolves availability, and starts at the default size', () => {
  expect(hostLabel('claude')).toBe('Claude');
  expect(hostLabel('codex')).toBe('Codex');
  expect(sessionStateLabel('running')).toBe('Running');
  expect(sessionStateLabel('exited')).toBe('Exited');
  expect(sessionStateLabel('terminated')).toBe('Terminated');
  expect(availabilityFor(hosts, 'codex')?.reason).toBe('no dev install attached');
  expect(availabilityFor([], 'claude')).toBeUndefined();
  expect(defaultHostSessionSize).toEqual({ cols: 120, rows: 32 });
});

it('seeds the contract prompt for tool, event, and CLI leaves and none for the rest', () => {
  expect(hostSessionPromptFor(toolLeaf)).toBe(`Call the ${toolLeaf.routeId!} tool of this plugin and explain the result.`);
  expect(hostSessionPromptFor(eventLeaf)).toBe(`Trigger the ${eventLeaf.event!} hook of this plugin and explain what it did.`);
  expect(hostSessionPromptFor(cliLeaf)).toBe(`Run the ${cliLeaf.command!.path.join(' ')} command of this plugin and explain the result.`);
  expect(hostSessionPromptFor(skillLeaf)).toBeUndefined();
});
