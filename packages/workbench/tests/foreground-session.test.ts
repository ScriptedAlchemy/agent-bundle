import { expect, it } from '@rstest/core';

import {
  decodeForegroundSession,
  ForegroundSessionAuthority,
  type ForegroundSessionSnapshot,
  ForegroundTransport,
} from '../src/foreground-session.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const session = (instanceId = 'foreground-instance-a', token = 'test-session-token'): Response => json({
  instanceId,
  origin: 'http://foreground.test',
  token,
});

const invalidSessionBodies: readonly [string, unknown][] = [
  ['a legacy two-field payload', { origin: 'http://foreground.test', token: 'test-session-token' }],
  ['a versioned payload', { instanceId: 'foreground-instance-a', origin: 'http://foreground.test', schemaVersion: 1, token: 'test-session-token' }],
  ['an unexpected payload field', { instanceId: 'foreground-instance-a', origin: 'http://foreground.test', scope: 'workbench', token: 'test-session-token' }],
  ['a malformed payload', { instanceId: 'foreground-instance-a', origin: 'http://foreground.test' }],
];

it('decodes the exact instance-aware foreground bootstrap envelope', () => {
  const decoded = decodeForegroundSession({
    instanceId: 'foreground-instance-a',
    origin: 'http://foreground.test',
    token: 'test-session-token',
  });

  expect(decoded).toEqual({
    instanceId: 'foreground-instance-a',
    origin: 'http://foreground.test',
    token: 'test-session-token',
  });
  expect(Object.isFrozen(decoded)).toBe(true);
});

const invalidInstanceIds: readonly [string, string][] = [
  ['an empty identity', ''],
  ['a blank identity', '   '],
  ['an identity with leading whitespace', ' foreground-instance-a'],
  ['an identity with trailing whitespace', 'foreground-instance-a '],
  ['an identity longer than 128 characters', 'a'.repeat(129)],
];

for (const [description, instanceId] of invalidInstanceIds) {
  it(`rejects ${description} from the central foreground session decoder`, () => {
    expect(decodeForegroundSession({
      instanceId,
      origin: 'http://foreground.test',
      token: 'test-session-token',
    })).toBeUndefined();
  });
}

it('accepts a 128-character opaque instance identity', () => {
  const instanceId = 'a'.repeat(128);

  expect(decodeForegroundSession({
    instanceId,
    origin: 'http://foreground.test',
    token: 'test-session-token',
  })).toMatchObject({ instanceId });
});

it('shares one initial bootstrap and freezes its generation-zero snapshot', async () => {
  let bootstrapCalls = 0;
  let resolveBootstrap: ((response: Response) => void) | undefined;
  const authority = new ForegroundSessionAuthority({
    fetch: async () => {
      bootstrapCalls++;
      return await new Promise<Response>((resolve) => { resolveBootstrap = resolve; });
    },
  });

  const first = authority.snapshot();
  const second = authority.snapshot();
  expect(bootstrapCalls).toBe(1);
  expect(first).toBe(second);
  if (resolveBootstrap === undefined) throw new Error('Expected foreground session bootstrap.');
  resolveBootstrap(session());

  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  expect(firstSnapshot).toBe(secondSnapshot);
  expect(firstSnapshot).toEqual({
    generation: 0,
    instanceId: 'foreground-instance-a',
    origin: 'http://foreground.test',
    token: 'test-session-token',
  });
  expect(Object.isFrozen(firstSnapshot)).toBe(true);
});

const invalidAuthorityBootstraps: readonly [string, unknown, string | undefined][] = [
  ['an empty instance identity', { instanceId: '', origin: 'http://foreground.test', token: 'test-session-token' }, undefined],
  ['an origin with a path', { instanceId: 'foreground-instance-a', origin: 'http://foreground.test/not-an-origin', token: 'test-session-token' }, undefined],
  ['an origin different from the browser', { instanceId: 'foreground-instance-a', origin: 'http://foreground.test', token: 'test-session-token' }, 'http://browser.test'],
];

for (const [description, body, browserOrigin] of invalidAuthorityBootstraps) {
  it(`does not snapshot ${description}`, async () => {
    const authority = new ForegroundSessionAuthority({
      browserOrigin,
      fetch: async () => json(body),
    });

    await expect(authority.snapshot()).rejects.toThrow();
  });
}

it('refreshes credentials without advancing generation until the server instance changes', async () => {
  const responses = [
    session('foreground-instance-a', 'first-token'),
    session('foreground-instance-a', 'rotated-token'),
    session('foreground-instance-b', 'restart-token'),
  ];
  const authority = new ForegroundSessionAuthority({
    fetch: async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected foreground session bootstrap.');
      return response;
    },
  });

  const initial = await authority.snapshot();
  const rotated = await authority.refresh();
  const restarted = await authority.refresh();

  expect(initial).toMatchObject({ generation: 0, instanceId: 'foreground-instance-a', token: 'first-token' });
  expect(rotated).toMatchObject({ generation: 0, instanceId: 'foreground-instance-a', token: 'rotated-token' });
  expect(restarted).toMatchObject({ generation: 1, instanceId: 'foreground-instance-b', token: 'restart-token' });
  await expect(authority.snapshot()).resolves.toBe(restarted);
});

it('keeps a newer refreshed snapshot when an older bootstrap completes afterward', async () => {
  let bootstrapCalls = 0;
  let resolveOlder: ((response: Response) => void) | undefined;
  let resolveNewer: ((response: Response) => void) | undefined;
  const authority = new ForegroundSessionAuthority({
    fetch: async () => {
      bootstrapCalls++;
      if (bootstrapCalls === 1) return session('foreground-instance-a', 'initial-token');
      if (bootstrapCalls === 2) return await new Promise<Response>((resolve) => { resolveOlder = resolve; });
      if (bootstrapCalls === 3) return await new Promise<Response>((resolve) => { resolveNewer = resolve; });
      throw new Error('Unexpected foreground session bootstrap.');
    },
  });

  await authority.snapshot();
  const older = authority.refresh();
  const newer = authority.refresh();
  if (resolveOlder === undefined || resolveNewer === undefined) throw new Error('Expected concurrent foreground bootstraps.');
  resolveNewer(session('foreground-instance-c', 'newer-token'));
  const newerSnapshot = await newer;
  resolveOlder(session('foreground-instance-b', 'older-token'));
  await older;

  await expect(authority.snapshot()).resolves.toBe(newerSnapshot);
  await expect(authority.snapshot()).resolves.toMatchObject({
    generation: 1,
    instanceId: 'foreground-instance-c',
    token: 'newer-token',
  });
});

const staleFailureCompletions: readonly [string, (resolve: (response: Response) => void, reject: (error: Error) => void) => void][] = [
  ['a network failure', (_resolve, reject) => reject(new Error('Foreground server disconnected.'))],
  ['malformed JSON', (resolve) => resolve(new Response('{', { headers: { 'content-type': 'application/json' } }))],
  ['an invalid origin', (resolve) => resolve(json({
    instanceId: 'foreground-instance-b',
    origin: 'http://foreground.test/not-an-origin',
    token: 'older-token',
  }))],
  ['an invalid schema', (resolve) => resolve(json({ origin: 'http://foreground.test', token: 'older-token' }))],
];

for (const [description, completeStaleBootstrap] of staleFailureCompletions) {
  it(`returns the newer snapshot when an older refresh completes with ${description}`, async () => {
    let bootstrapCalls = 0;
    let completeOlder: (() => void) | undefined;
    const authority = new ForegroundSessionAuthority({
      fetch: async () => {
        bootstrapCalls++;
        if (bootstrapCalls === 1) return session('foreground-instance-a', 'initial-token');
        if (bootstrapCalls === 2) {
          return await new Promise<Response>((resolve, reject) => {
            completeOlder = () => completeStaleBootstrap(resolve, reject);
          });
        }
        if (bootstrapCalls === 3) return session('foreground-instance-c', 'newer-token');
        throw new Error('Unexpected foreground session bootstrap.');
      },
    });

    await authority.snapshot();
    const older = authority.refresh();
    const newerSnapshot = await authority.refresh();
    if (completeOlder === undefined) throw new Error('Expected an older foreground bootstrap.');
    completeOlder();

    await expect(older).resolves.toBe(newerSnapshot);
    await expect(authority.snapshot()).resolves.toBe(newerSnapshot);
  });
}

it('does not apply an older success after a newer refresh fails', async () => {
  let bootstrapCalls = 0;
  let rejectNewer: ((error: Error) => void) | undefined;
  let resolveOlder: ((response: Response) => void) | undefined;
  const authority = new ForegroundSessionAuthority({
    fetch: async () => {
      bootstrapCalls++;
      if (bootstrapCalls === 1) return session('foreground-instance-a', 'initial-token');
      if (bootstrapCalls === 2) return await new Promise<Response>((resolve) => { resolveOlder = resolve; });
      if (bootstrapCalls === 3) return await new Promise<Response>((_resolve, reject) => { rejectNewer = reject; });
      throw new Error('Unexpected foreground session bootstrap.');
    },
  });

  const initial = await authority.snapshot();
  const older = authority.refresh();
  const newer = authority.refresh();
  if (rejectNewer === undefined || resolveOlder === undefined) throw new Error('Expected concurrent foreground bootstraps.');
  rejectNewer(new Error('Foreground server disconnected.'));
  await expect(newer).rejects.toThrow('Foreground server disconnected.');
  resolveOlder(session('foreground-instance-b', 'older-token'));

  await expect(older).resolves.toBe(initial);
  await expect(authority.snapshot()).resolves.toBe(initial);
});

for (const [description, body] of invalidSessionBodies) {
  it(`rejects ${description} from the foreground session bootstrap`, async () => {
    const routePaths: string[] = [];
    const transport = new ForegroundTransport({
      errorFor: (code, message) => Object.assign(new Error(message), { code }),
      fallbackCode: 'AB8093',
      fetch: async (input) => {
        if (String(input) === '/api/project/session') return json(body);
        routePaths.push(String(input));
        return json({ ok: true });
      },
      label: 'Dev Log',
    });

    await expect(transport.request('/api/logs')).rejects.toMatchObject({ code: 'AB8093' });
    expect(routePaths).toEqual([]);
  });
}

it('does not issue an aborted request after it waits for cached session bootstrap', async () => {
  let resolveSession: ((response: Response) => void) | undefined;
  const routePaths: string[] = [];
  const transport = new ForegroundTransport({
    errorFor: (code, message) => Object.assign(new Error(message), { code }),
    fallbackCode: 'AB8093',
    fetch: async (input) => {
      const path = String(input);
      if (path.includes('/api/project/session')) {
        return await new Promise<Response>((resolve) => { resolveSession = resolve; });
      }
      routePaths.push(path);
      return json({ ok: true });
    },
    label: 'Dev Log',
  });
  const first = transport.request('/api/logs/first');
  const controller = new AbortController();
  const second = transport.request('/api/logs/second', { signal: controller.signal });
  if (resolveSession === undefined) throw new Error('Expected foreground session acquisition.');
  controller.abort();
  resolveSession(session());

  await expect(first).resolves.toBeInstanceOf(Response);
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(routePaths).toEqual(['/api/logs/first']);
});
