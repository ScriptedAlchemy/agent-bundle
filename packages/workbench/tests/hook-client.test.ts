import { expect, it } from '@rstest/core';

import { HookClient } from '../src/hooks/hook-client.ts';

interface RecordedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly token: string | null;
  readonly url: string;
}

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

const recordingFetch = (calls: RecordedRequest[], reply: () => Response): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
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
