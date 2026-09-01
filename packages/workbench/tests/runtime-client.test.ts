import { expect, it } from '@rstest/core';

import type {
  DevRuntimeRun,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import { ForegroundRouteClient, ForegroundRouteClientError, McpRouteClient } from '../src/mcp/mcp-route-client.ts';
import { ProjectClient } from '../src/project-client.ts';
import { RuntimeClient, RuntimeClientError } from '../src/runtime-client.ts';

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly url: string;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

const vector = Object.freeze({
  artifactEpochId: 'epoch-a',
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
});

const status = Object.freeze({
  activeVector: vector,
  descriptor: Object.freeze({ environmentVariables: [], id: 'rsc', label: 'RSC', schemaVersion: 1 as const }),
  diagnostics: Object.freeze([]),
  hmrReady: true,
  lastGoodVector: vector,
  state: 'active' as const,
}) satisfies DevRuntimeStatus;

const surface = Object.freeze({
  fixtures: Object.freeze([{ id: 'fixture-a', label: 'Fixture A' }]),
  id: 'app-weather',
  kind: 'mcp-app' as const,
  label: 'Weather App',
  readOnly: false,
  targets: Object.freeze(['portable']),
}) satisfies DevRuntimeSurface;

const run = (id = 'run-a', startedAt = '2026-08-15T12:00:00.000Z'): DevRuntimeRun => Object.freeze({
  completedAt: '2026-08-15T12:00:01.000Z',
  fixtureId: 'fixture-a',
  id,
  input: Object.freeze({ city: 'London' }),
  result: Object.freeze({
    agentVisible: Object.freeze({ summary: 'Sunny' }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }) }),
    trace: Object.freeze([]),
    tree: Object.freeze([]),
  }),
  startedAt,
  status: 'succeeded',
  surfaceId: 'app-weather',
  target: 'portable',
  vector,
});

const json = (body: unknown, statusCode = 200): Response => Response.json(body, { status: statusCode });

/** Mirrors the server-issued per-listener foreground session bootstrap. */
const foregroundSession = Object.freeze({
  cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a',
  origin: 'http://localhost',
  token: 'foreground-token',
});
const projectStatus = Object.freeze({
  artifact: Object.freeze({ state: 'missing' as const }),
  build: Object.freeze({ state: 'idle' as const }),
  source: Object.freeze({ diagnostics: Object.freeze([]), state: 'unknown' as const }),
});

const deferred = <Value>(): Deferred<Value> => {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const runtimeFetch = (options: {
  readonly asset?: Response;
  readonly document?: Response;
  readonly flight?: Response;
  readonly runs?: readonly DevRuntimeRun[];
  readonly status?: DevRuntimeStatus | null;
} = {}): { readonly fetch: typeof fetch; readonly requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  return Object.freeze({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
      if (url === '/api/runtime/status') return json({ status: options.status === undefined ? status : options.status });
      if (url === '/api/runtime/surfaces') return json({ surfaces: [surface] });
      if (url === '/api/project/session') return json(foregroundSession);
      if (url === '/api/runtime/runs?limit=50' && init?.method === undefined) return json({ providerSessionId: 'provider-a', runs: options.runs ?? [run()] });
      if (url === '/api/runtime/runs' && init?.method === 'POST') return json({ run: run('run-created') });
      if (url === '/api/runtime/runs/run%20a') return json({ run: run('run a') });
      if (url === '/api/runtime/runs/run%20a/replay' && init?.method === 'POST') return json({ run: run('run-replayed') });
      if (url === '/api/runtime/state/reset' && init?.method === 'POST') return json({ state: { stateStoreId: 'state-a', stateVersion: 2 } });
      if (url === '/api/runtime/runs/run%20a/flight' && init?.method === undefined) {
        return options.flight ?? new Response(new Uint8Array([70, 76]), { headers: { 'content-type': 'application/octet-stream' } });
      }
      if (url === '/api/runtime/runs/run%20a/document' && init?.method === undefined) {
        return options.document ?? json({
          events: [{
            document: {
              root: { children: [{ kind: 'text', text: 'Ready' }], kind: 'result' },
              status: 'success',
              version: 1,
            },
            sequence: 0,
            type: 'complete',
          }],
        });
      }
      if (url === '/api/runtime/assets/app-weather/assets/weather%20app.js?generation=generation%20a') {
        return options.asset ?? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/javascript' } });
      }
      throw new Error(`Unexpected route request ${url}.`);
    },
    requests,
  });
};

it('performs only the public status request when runtime is unavailable', async () => {
  const fixture = runtimeFetch({ status: null });

  await expect(new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch })).bootstrap()).resolves.toEqual({ kind: 'unavailable' });
  expect(fixture.requests.map((request) => request.url)).toEqual(['/api/runtime/status']);
  expect(fixture.requests[0]?.headers.get('x-agent-bundle-session')).toBeNull();
});

const foreignStatus = (field: 'activeVector' | 'lastGoodVector'): DevRuntimeStatus => Object.freeze({
  ...status,
  [field]: Object.freeze({ ...vector, providerSessionId: 'provider-other' }),
});

const rejectsForeignStatusVector = async (field: 'activeVector' | 'lastGoodVector'): Promise<void> => {
  let foreign = false;
  const fixture = runtimeFetch();
  const client = new RuntimeClient(new ForegroundRouteClient({
    fetch: async (input, init) => String(input) === '/api/runtime/status' && foreign
      ? json({ status: foreignStatus(field) })
      : fixture.fetch(input, init),
  }));

  await expect(client.bootstrap()).resolves.toMatchObject({ kind: 'available', providerSessionId: 'provider-a' });
  foreign = true;
  await expect(client.bootstrap()).rejects.toMatchObject({ code: 'AB8206' });
  const requestCount = fixture.requests.length;
  await expect(client.readRun('run-a')).rejects.toMatchObject({ code: 'AB8201' });
  expect(fixture.requests).toHaveLength(requestCount);
};

it('rejects a foreign active runtime status vector and clears cached provider authority', async () => {
  await rejectsForeignStatusVector('activeVector');
});

it('rejects a foreign last-good runtime status vector and clears cached provider authority', async () => {
  await rejectsForeignStatusVector('lastGoodVector');
});

it('rejects absolute, protocol-relative, credentialed, and fragmented protected routes before foreground authentication', async () => {
  const requests: string[] = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => {
      requests.push(String(input));
      return json(foregroundSession);
    },
  });

  for (const path of [
    'https://localhost/api/runtime/runs',
    '//localhost/api/runtime/runs',
    'https://token@localhost/api/runtime/runs',
    '/api/runtime/runs#fragment',
    'api/runtime/runs',
  ]) {
    await expect(foreground.protectedResponse(path)).rejects.toBeInstanceOf(ForegroundRouteClientError);
  }
  expect(requests).toEqual([]);
});

it('passes the exact runtime MCP operation cancellation signal to the authenticated route fetch', async () => {
  const abort = new AbortController();
  let observed: AbortSignal | undefined;
  const client = new McpRouteClient({
    fetch: async (input, init) => {
      const path = String(input);
      if (path === '/api/project/session') return json(foregroundSession);
      if (path === '/api/runtime/mcp/sessions/runtime-session-a/rpc') {
        observed = init?.signal as AbortSignal | undefined;
        return json({ result: {
          operationId: 'runtime-operation-a', sessionId: 'runtime-session-a', sessionRevision: 3, value: [], vector,
        } });
      }
      throw new Error(`Unexpected route request ${path}.`);
    },
  });

  await expect(client.executeRuntime('runtime-session-a', {
    expectedSessionRevision: 3,
    kind: 'list-tools',
  }, abort.signal)).resolves.toMatchObject({ operationId: 'runtime-operation-a' });
  expect(observed).toBe(abort.signal);
});

it('bootstraps available runtime history through one shared foreground authentication session', async () => {
  const fixture = runtimeFetch();
  const foreground = new ForegroundRouteClient({ fetch: fixture.fetch });
  const first = new RuntimeClient(foreground);
  const second = new RuntimeClient(foreground);

  const [left, right] = await Promise.all([first.bootstrap(), second.bootstrap()]);

  expect(left).toMatchObject({ kind: 'available', providerSessionId: 'provider-a', status, surfaces: [surface] });
  expect(right).toMatchObject({ kind: 'available', providerSessionId: 'provider-a', status, surfaces: [surface] });
  expect(fixture.requests.filter((request) => request.url === '/api/project/session')).toHaveLength(1);
  expect(fixture.requests.filter((request) => request.url === '/api/runtime/runs?limit=50')).toHaveLength(2);
  expect(fixture.requests.filter((request) => request.url === '/api/runtime/runs?limit=50').every(
    (request) => request.headers.get('x-agent-bundle-session') === 'foreground-token',
  )).toBe(true);
  expect(Object.isFrozen((left as Extract<typeof left, { readonly kind: 'available' }>).history)).toBe(true);
  expect(Object.isFrozen((left as Extract<typeof left, { readonly kind: 'available' }>).history[0]!)).toBe(true);
});

it('shares one injected foreground bootstrap across MCP, Runtime, and Project clients and invalidates it without stale holders', async () => {
  const requests: RecordedRequest[] = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') return json(foregroundSession);
      if (url === '/api/mcp/sessions/session-a') {
        return json({
          session: {
            binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
            connection: {},
            id: 'session-a',
            timeoutMs: 5_000,
          },
        });
      }
      if (url === '/api/runtime/status') return json({ status });
      if (url === '/api/runtime/surfaces') return json({ surfaces: [surface] });
      if (url === '/api/runtime/runs?limit=50') return json({ providerSessionId: 'provider-a', runs: [run()] });
      if (url === '/api/project/rebuild') return json({ status: projectStatus });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });
  const mcp = new McpRouteClient({ foreground });
  const runtime = new RuntimeClient(foreground);
  const project = new ProjectClient({ foreground });

  await Promise.all([mcp.session('session-a'), runtime.bootstrap(), project.rebuild(['skills/review/SKILL.md'])]);
  expect(requests.filter((request) => request.url === '/api/project/session')).toHaveLength(1);

  mcp.forgetAuthentication();
  mcp.forgetAuthentication();
  await project.rebuild(['skills/review/SKILL.md']);
  expect(requests.filter((request) => request.url === '/api/project/session')).toHaveLength(2);

  project.close();
  project.close();
  await new ProjectClient({ foreground }).rebuild(['skills/review/SKILL.md']);
  expect(requests.filter((request) => request.url === '/api/project/session')).toHaveLength(2);
});

it('fences an in-flight Project rebuild when root shutdown invalidates foreground authentication', async () => {
  const session = deferred<Response>();
  const requests: RecordedRequest[] = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') return session.promise;
      if (url === '/api/project/rebuild') return json({ status });
      throw new Error(`Unexpected route request ${url}.`);
    },
  });
  const client = new ProjectClient({ foreground });

  const rebuilding = client.rebuild(['skills/review/SKILL.md']);
  client.close();
  foreground.forgetAuthentication();
  session.resolve(json(foregroundSession));

  await expect(rebuilding).rejects.toBeInstanceOf(Error);
  expect(requests.map((request) => request.url)).toEqual(['/api/project/session']);
  expect(requests[0]?.headers.get('x-agent-bundle-session')).toBeNull();
});

it('keeps a newer foreground bootstrap when an invalidated bootstrap rejects', async () => {
  const sessions: Deferred<Response>[] = [];
  const requests: RecordedRequest[] = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ body: init?.body?.toString(), headers: new Headers(init?.headers), url });
      if (url === '/api/project/session') {
        const session = deferred<Response>();
        sessions.push(session);
        return session.promise;
      }
      return json({ route: url });
    },
  });

  const first = foreground.protectedJson('/api/foreground/first');
  foreground.forgetAuthentication();
  const second = foreground.protectedJson('/api/foreground/second');
  expect(sessions).toHaveLength(2);

  sessions[0]?.reject(new Error('first bootstrap failed'));
  await expect(first).rejects.toThrow('first bootstrap failed');

  const third = foreground.protectedJson('/api/foreground/third');
  expect(sessions).toHaveLength(2);
  sessions[1]?.resolve(json(foregroundSession));

  await expect(second).resolves.toEqual({ route: '/api/foreground/second' });
  await expect(third).resolves.toEqual({ route: '/api/foreground/third' });
  expect(requests.filter((request) => request.url === '/api/project/session')).toHaveLength(2);
});

it('rejects every runtime mutation and protected read before an available bootstrap without sending a request', async () => {
  const fixture = runtimeFetch();
  const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));

  await expect(client.createRun({ input: {}, surfaceId: 'app-weather', target: 'portable' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(client.readRun('run a')).rejects.toMatchObject({ code: 'AB8201' });
  await expect(client.replayRun({ mode: 'exact', runId: 'run a' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(client.resetState({ stateStoreId: 'state-a' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(client.readAsset({ path: ['assets', 'weather app.js'], runtimeGenerationId: 'generation a', surfaceId: 'app-weather' })).rejects.toMatchObject({ code: 'AB8201' });
  expect(fixture.requests).toEqual([]);
});

it('clears previously bootstrapped provider authority when status becomes unavailable', async () => {
  const fixture = runtimeFetch();
  let unavailable = false;
  const client = new RuntimeClient(new ForegroundRouteClient({
    fetch: async (input, init) => String(input) === '/api/runtime/status' && unavailable
      ? json({ status: null })
      : fixture.fetch(input, init),
  }));

  await expect(client.bootstrap()).resolves.toMatchObject({ kind: 'available', providerSessionId: 'provider-a' });
  unavailable = true;
  await expect(client.bootstrap()).resolves.toEqual({ kind: 'unavailable' });
  const requestCount = fixture.requests.length;

  await expect(client.readRun('run a')).rejects.toMatchObject({ code: 'AB8201' });
  expect(fixture.requests).toHaveLength(requestCount);
});

it('rejects invalid runtime history before it can enter browser state', async () => {
  const cases = [
    Object.freeze(Array.from({ length: 51 }, (_, index) => run(`run-${index}`, `2026-08-15T12:${String(index).padStart(2, '0')}:00.000Z`))),
    Object.freeze([run('duplicate'), run('duplicate')]),
    Object.freeze([{ ...run('foreign'), vector: { ...vector, providerSessionId: 'provider-other' } } as DevRuntimeRun]),
    Object.freeze([run('older', '2026-08-15T11:00:00.000Z'), run('newer', '2026-08-15T12:00:00.000Z')]),
    Object.freeze([run('run/not-an-opaque-id')]),
  ];

  for (const runs of cases) {
    const fixture = runtimeFetch({ runs });
    await expect(new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch })).bootstrap()).rejects.toMatchObject({ code: 'AB8206' });
  }
});

it('uses the exact imported request bodies and encoded opaque runtime paths', async () => {
  const fixture = runtimeFetch();
  const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));

  await client.bootstrap();
  await client.createRun({ expectedGenerationId: 'generation-a', fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'app-weather', target: 'portable' });
  await client.readRun('run a');
  await client.replayRun({ expectedGenerationId: 'generation-a', mode: 'exact', runId: 'run a' });
  await client.resetState({ expectedGenerationId: 'generation-a', seed: { city: 'London' }, stateStoreId: 'state-a' });
  await expect(client.readAsset({ path: ['assets', 'weather app.js'], runtimeGenerationId: 'generation a', surfaceId: 'app-weather' })).resolves.toBeInstanceOf(Blob);
  await expect(client.readRunFlight('run a')).resolves.toBeInstanceOf(Blob);

  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/runs/run%20a');
  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/runs/run%20a/flight');
  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/runs/run%20a/replay');
  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/assets/app-weather/assets/weather%20app.js?generation=generation%20a');
  expect(fixture.requests.find((request) => request.url === '/api/runtime/runs')?.body).toBe(
    '{"expectedGenerationId":"generation-a","fixtureId":"fixture-a","input":{"city":"London"},"surfaceId":"app-weather","target":"portable"}',
  );
  expect(fixture.requests.find((request) => request.url.endsWith('/replay'))?.body).toBe(
    '{"expectedGenerationId":"generation-a","mode":"exact","runId":"run a"}',
  );
});

it('rejects foreign provider runs after authoritative bootstrap before they can replace current evidence', async () => {
  const fixture = runtimeFetch();
  const foreign = Object.freeze({ ...run('foreign-run'), vector: Object.freeze({ ...vector, providerSessionId: 'provider-other' }) }) as DevRuntimeRun;
  const client = new RuntimeClient(new ForegroundRouteClient({
    fetch: async (input, init) => String(input) === '/api/runtime/runs' && init?.method === 'POST'
      ? json({ run: foreign })
      : fixture.fetch(input, init),
  }));

  await client.bootstrap();
  await expect(client.createRun({ input: {}, surfaceId: 'app-weather', target: 'portable' })).rejects.toMatchObject({ code: 'AB8206' });
});

it('surfaces a complete sanitized generation conflict without retrying the protected mutation', async () => {
  let runs = 0;
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/runtime/status') return json({ status });
      if (url === '/api/runtime/surfaces') return json({ surfaces: [surface] });
      if (url === '/api/project/session') return json(foregroundSession);
      if (url === '/api/runtime/runs?limit=50') return json({ providerSessionId: 'provider-a', runs: [run()] });
      if (url === '/api/runtime/runs' && init?.method === 'POST') {
        runs += 1;
        return json({ diagnostic: { code: 'AB8204', details: { actualGenerationId: 'generation-b' }, message: 'Generation changed.', phase: 'provider-lifecycle', secret: 'must-not-leak' } }, 409);
      }
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  const client = new RuntimeClient(foreground);
  await client.bootstrap();
  await expect(client.createRun({ input: {}, surfaceId: 'app-weather', target: 'portable' })).rejects.toEqual(
    new RuntimeClientError({ code: 'AB8204', details: { actualGenerationId: 'generation-b' }, message: 'Generation changed.', phase: 'provider-lifecycle' }),
  );
  expect(runs).toBe(1);
});

it('rejects oversized, untyped, or unsupported protected assets', async () => {
  const oversized = new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/javascript' } });
  const missingType = new Response(new Uint8Array([1]));
  const unsupportedType = new Response(new Uint8Array([1]), { headers: { 'content-type': 'text/plain' } });

  for (const asset of [oversized, missingType, unsupportedType]) {
    const fixture = runtimeFetch({ asset });
    const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));
    await client.bootstrap();
    await expect(client.readAsset({
      path: ['assets', 'weather app.js'],
      runtimeGenerationId: 'generation a',
      surfaceId: 'app-weather',
    })).rejects.toMatchObject({ code: 'AB8206' });
  }
});

it('rejects oversized or mistyped protected Flight payloads', async () => {
  const oversized = new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/octet-stream' } });
  const wrongType = new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/json' } });
  for (const flight of [oversized, wrongType]) {
    const fixture = runtimeFetch({ flight });
    const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));
    await client.bootstrap();
    await expect(client.readRunFlight('run a')).rejects.toMatchObject({ code: 'AB8206' });
  }
});

it('rejects Flight reads before an authoritative provider bootstrap', async () => {
  const fixture = runtimeFetch();
  const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));
  await expect(client.readRunFlight('run a')).rejects.toMatchObject({ code: 'AB8201' });
});

it('reads strict Agent Document events through the protected provider authority', async () => {
  const fixture = runtimeFetch();
  const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));
  await client.bootstrap();

  await expect(client.readRunDocument('run a')).resolves.toMatchObject([
    { sequence: 0, type: 'complete' },
  ]);
  expect(fixture.requests.at(-1)?.url).toBe('/api/runtime/runs/run%20a/document');
});

it('preserves own __proto__ keys as immutable prototype-inert JSON snapshots', async () => {
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => String(input) === '/public'
      ? new Response('{"__proto__":{"polluted":true},"nested":{"__proto__":{"nested":true}}}', { headers: { 'content-type': 'application/json' } })
      : json(foregroundSession),
  });
  const publicSnapshot = await foreground.publicJson('/public') as Readonly<Record<string, unknown>>;
  const source = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"nested":true}}}');
  const base = run('run-proto');
  if (base.status !== 'succeeded') throw new Error('Expected succeeded fixture run.');
  const poisoned = Object.freeze({ ...base, input: source, result: Object.freeze({ ...base.result, agentVisible: source }) }) as DevRuntimeRun;
  const fixture = runtimeFetch({ runs: [poisoned] });
  const runtime = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));
  const bootstrapped = await runtime.bootstrap();
  if (bootstrapped.kind !== 'available') throw new Error('Expected available runtime.');
  const runtimeSnapshot = bootstrapped.history[0]!;

  for (const value of [publicSnapshot, runtimeSnapshot.input, runtimeSnapshot.result?.agentVisible] as const) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object snapshot.');
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    const nested = (value as Readonly<Record<string, unknown>>).nested as object;
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
  }
});

it('derives Flight downloads from the validated run ID and rejects mismatched provider metadata', async () => {
  const base = run('run a');
  if (base.status !== 'succeeded') throw new Error('Expected succeeded fixture run.');
  const matching = Object.freeze({
    ...base,
    result: Object.freeze({
      ...base.result,
      flight: Object.freeze({ bytes: 12, downloadPath: '/api/runtime/runs/run%20a/flight', preview: 'Flight', truncated: false }),
    }),
  }) as DevRuntimeRun;
  const matchingClient = new RuntimeClient(new ForegroundRouteClient({ fetch: runtimeFetch({ runs: [matching] }).fetch }));
  const matchingBootstrap = await matchingClient.bootstrap();
  const matchingRun = matchingBootstrap.kind === 'available' ? matchingBootstrap.history[0] : undefined;
  if (matchingRun?.status !== 'succeeded') throw new Error('Expected available succeeded Flight run.');
  expect(matchingRun.result.flight?.downloadPath).toBe('/api/runtime/runs/run%20a/flight');

  const mismatched = Object.freeze({
    ...matching,
    result: Object.freeze({
      ...base.result,
      flight: Object.freeze({ bytes: 12, downloadPath: 'https://invalid.example/flight', preview: 'Flight', truncated: false }),
    }),
  }) as DevRuntimeRun;
  const mismatchedClient = new RuntimeClient(new ForegroundRouteClient({ fetch: runtimeFetch({ runs: [mismatched] }).fetch }));
  await expect(mismatchedClient.bootstrap()).rejects.toMatchObject({ code: 'AB8206' });
});
