import { expect, it } from '@rstest/core';

import type {
  DevRuntimeRun,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { RuntimeClient, RuntimeClientError } from '../src/runtime-client.ts';

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly url: string;
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

const runtimeFetch = (options: {
  readonly asset?: Response;
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
      if (url === '/api/project/session') return json({ origin: 'http://localhost', token: 'foreground-token' });
      if (url === '/api/runtime/runs?limit=50' && init?.method === undefined) return json({ providerSessionId: 'provider-a', runs: options.runs ?? [run()] });
      if (url === '/api/runtime/runs' && init?.method === 'POST') return json({ run: run('run-created') });
      if (url === '/api/runtime/runs/run%20a') return json({ run: run('run a') });
      if (url === '/api/runtime/runs/run%20a/replay' && init?.method === 'POST') return json({ run: run('run-replayed') });
      if (url === '/api/runtime/state/reset' && init?.method === 'POST') return json({ state: { stateStoreId: 'state-a', stateVersion: 2 } });
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

it('rejects invalid runtime history before it can enter browser state', async () => {
  const cases = [
    Object.freeze(Array.from({ length: 51 }, (_, index) => run(`run-${index}`, `2026-08-15T12:${String(index).padStart(2, '0')}:00.000Z`))),
    Object.freeze([run('duplicate'), run('duplicate')]),
    Object.freeze([{ ...run('foreign'), vector: { ...vector, providerSessionId: 'provider-other' } } as DevRuntimeRun]),
    Object.freeze([run('older', '2026-08-15T11:00:00.000Z'), run('newer', '2026-08-15T12:00:00.000Z')]),
  ];

  for (const runs of cases) {
    const fixture = runtimeFetch({ runs });
    await expect(new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch })).bootstrap()).rejects.toMatchObject({ code: 'AB8206' });
  }
});

it('uses the exact imported request bodies and encoded opaque runtime paths', async () => {
  const fixture = runtimeFetch();
  const client = new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch }));

  await client.createRun({ expectedGenerationId: 'generation-a', fixtureId: 'fixture-a', input: { city: 'London' }, surfaceId: 'app-weather', target: 'portable' });
  await client.readRun('run a');
  await client.replayRun({ expectedGenerationId: 'generation-a', mode: 'exact', runId: 'run a' });
  await client.resetState({ expectedGenerationId: 'generation-a', seed: { city: 'London' }, stateStoreId: 'state-a' });
  await expect(client.readAsset({ path: ['assets', 'weather app.js'], runtimeGenerationId: 'generation a', surfaceId: 'app-weather' })).resolves.toBeInstanceOf(Blob);

  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/runs/run%20a');
  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/runs/run%20a/replay');
  expect(fixture.requests.map((request) => request.url)).toContain('/api/runtime/assets/app-weather/assets/weather%20app.js?generation=generation%20a');
  expect(fixture.requests.find((request) => request.url === '/api/runtime/runs')?.body).toBe(
    '{"expectedGenerationId":"generation-a","fixtureId":"fixture-a","input":{"city":"London"},"surfaceId":"app-weather","target":"portable"}',
  );
  expect(fixture.requests.find((request) => request.url.endsWith('/replay'))?.body).toBe(
    '{"expectedGenerationId":"generation-a","mode":"exact","runId":"run a"}',
  );
});

it('surfaces a complete sanitized generation conflict without retrying the protected mutation', async () => {
  let runs = 0;
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return json({ origin: 'http://localhost', token: 'foreground-token' });
      if (url === '/api/runtime/runs' && init?.method === 'POST') {
        runs += 1;
        return json({ diagnostic: { code: 'AB8204', details: { actualGenerationId: 'generation-b' }, message: 'Generation changed.', phase: 'provider-lifecycle', secret: 'must-not-leak' } }, 409);
      }
      throw new Error(`Unexpected route request ${url}.`);
    },
  });

  await expect(new RuntimeClient(foreground).createRun({ input: {}, surfaceId: 'app-weather', target: 'portable' })).rejects.toEqual(
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
    await expect(new RuntimeClient(new ForegroundRouteClient({ fetch: fixture.fetch })).readAsset({
      path: ['assets', 'weather app.js'],
      runtimeGenerationId: 'generation a',
      surfaceId: 'app-weather',
    })).rejects.toMatchObject({ code: 'AB8206' });
  }
});
