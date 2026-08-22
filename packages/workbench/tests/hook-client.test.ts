import { expect, it } from '@rstest/core';

import { HookClient } from '../src/hooks/hook-client.ts';
import { recordingFetch, type RecordedRequest } from './support/recording-fetch.ts';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const simulation = {
  binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
  canonicalIntent: { event: 'sessionStart', hook: 'hook:session-start', input: { cwd: '/workspace' } },
  canonicalResult: { additionalContext: 'Ready' },
  hostMapping: {
    canonicalEvent: 'sessionStart',
    nativeEvent: 'SessionStart',
    nativeProjection: 'deterministic',
    nativeSelector: 'SessionStart',
    target: 'claude',
    wrapperPath: 'claude/hooks/session-start.mjs',
  },
  nativeInput: { cwd: '/workspace', hook_event_name: 'SessionStart' },
  nativeOutput: { hookSpecificOutput: { hookEventName: 'SessionStart' } },
  replay: {
    binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
    input: { cwd: '/workspace' },
  },
};

it('lists epoch-bound hooks over the same foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const client = new HookClient({
    fetch: recordingFetch(calls, () => response({
      hooks: [{
        binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
        hook: { event: 'sessionStart', id: 'hook:session-start', name: 'session-start', path: 'claude/hooks/session-start.mjs', target: 'claude' },
      }],
    })),
  });

  await expect(client.list({ epochId: 'epoch-1', target: 'claude' })).resolves.toMatchObject([
    { binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' } },
  ]);
  expect(calls).toEqual([{
    body: undefined,
    method: 'GET',
    token: 'foreground-token',
    url: '/api/hooks?epochId=epoch-1&target=claude',
  }]);
});

it('omits an unselected target from the hook list query', async () => {
  const calls: RecordedRequest[] = [];
  const client = new HookClient({ fetch: recordingFetch(calls, () => response({ hooks: [] })) });

  await expect(client.list({ epochId: 'epoch-1' })).resolves.toEqual([]);
  expect(calls[0]?.url).toBe('/api/hooks?epochId=epoch-1');
});

it('passes a cancellation signal to an epoch-bound hook list', async () => {
  const calls: RecordedRequest[] = [];
  const client = new HookClient({ fetch: recordingFetch(calls, () => response({ hooks: [] })) });
  const controller = new AbortController();

  await client.list({ epochId: 'epoch-1' }, controller.signal);

  expect(calls[0]?.signal).toBe(controller.signal);
});

it('posts inline canonical input as a simulation and returns the simulation', async () => {
  const calls: RecordedRequest[] = [];
  const client = new HookClient({ fetch: recordingFetch(calls, () => response({ simulation })) });

  await expect(client.simulate({
    epochId: 'epoch-1',
    hook: 'hook:session-start',
    input: { inline: { cwd: '/workspace' } },
    target: 'claude',
  })).resolves.toMatchObject({ binding: { epochId: 'epoch-1' } });
  expect(calls).toEqual([{
    body: { epochId: 'epoch-1', hook: 'hook:session-start', input: { inline: { cwd: '/workspace' } }, target: 'claude' },
    method: 'POST',
    token: 'foreground-token',
    url: '/api/hooks/simulations',
  }]);
});

it('posts a saved replay back unchanged', async () => {
  const calls: RecordedRequest[] = [];
  const client = new HookClient({ fetch: recordingFetch(calls, () => response({ simulation })) });

  await client.replay(simulation.replay);

  expect(calls[0]?.url).toBe('/api/hooks/replays');
  expect(calls[0]?.body).toEqual(simulation.replay);
});

it('returns route diagnostics instead of a simulation', async () => {
  const client = new HookClient({
    fetch: recordingFetch([], () => response({
      diagnostics: [{
        code: 'hook.playground.target.unsupported',
        event: 'sessionStart',
        message: 'Hook playground cannot map target "codex".',
        severity: 'error',
        target: 'codex',
      }],
    })),
  });

  await expect(client.simulate({
    epochId: 'epoch-1',
    hook: 'hook:session-start',
    input: { inline: {} },
    target: 'codex',
  })).resolves.toMatchObject({ diagnostics: [{ code: 'hook.playground.target.unsupported' }] });
});

it('rejects surplus fields throughout the hook list wire DTO', async () => {
  const listedHook = {
    binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
    hook: { event: 'sessionStart', id: 'hook:session-start', name: 'session-start', path: 'claude/hooks/session-start.mjs', target: 'claude' },
  };
  const malformed = [
    { hooks: [], schemaVersion: 1 },
    { hooks: [{ ...listedHook, version: 1 }] },
    { hooks: [{ ...listedHook, binding: { ...listedHook.binding, schemaVersion: 1 } }] },
    { hooks: [{ ...listedHook, hook: { ...listedHook.hook, version: 1 } }] },
  ];

  for (const body of malformed) {
    const client = new HookClient({ fetch: recordingFetch([], () => response(body)) });

    await expect(client.list({ epochId: 'epoch-1' })).rejects.toMatchObject({ code: 'AB8033' });
  }
});

it('rejects surplus fields throughout the hook simulation wire DTO', async () => {
  const diagnostic = {
    code: 'hook.playground.target.unsupported',
    event: 'sessionStart',
    message: 'Hook playground cannot map target "codex".',
    severity: 'error',
    target: 'codex',
  };
  const malformed = [
    { simulation, schemaVersion: 1 },
    { diagnostics: [diagnostic], version: 1 },
    { diagnostics: [{ ...diagnostic, schemaVersion: 1 }] },
    { simulation: { ...simulation, version: 1 } },
    { simulation: { ...simulation, binding: { ...simulation.binding, schemaVersion: 1 } } },
    { simulation: { ...simulation, canonicalIntent: { ...simulation.canonicalIntent, version: 1 } } },
    { simulation: { ...simulation, hostMapping: { ...simulation.hostMapping, schemaVersion: 1 } } },
    { simulation: { ...simulation, replay: { ...simulation.replay, version: 1 } } },
    { simulation: { ...simulation, replay: { ...simulation.replay, binding: { ...simulation.replay.binding, schemaVersion: 1 } } } },
  ];

  for (const body of malformed) {
    const client = new HookClient({ fetch: recordingFetch([], () => response(body)) });

    await expect(client.simulate({
      epochId: 'epoch-1',
      hook: 'hook:session-start',
      input: { inline: {} },
      target: 'claude',
    })).rejects.toMatchObject({ code: 'AB8033' });
  }
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const client = new HookClient({
    fetch: recordingFetch([], () => response({
      diagnostic: { code: 'AB8032', message: 'Hook playground request has an invalid shape.' },
    }, 400)),
  });

  await expect(client.list({ epochId: 'epoch-1' })).rejects.toMatchObject({
    code: 'AB8032',
    message: 'Hook playground request has an invalid shape.',
  });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const client = new HookClient({ fetch: recordingFetch([], () => response({}, 503)) });

  await expect(client.list({ epochId: 'epoch-1' })).rejects.toMatchObject({
    code: 'AB8033',
    message: 'Hook playground request failed with HTTP 503.',
  });
});
