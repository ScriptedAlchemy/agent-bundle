import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  DEFAULT_AGENT_RENDER_LIMITS,
  decodeAgentFlightStream,
} from '@agent-bundle/runtime';
import {
  ProjectEventHub,
  startForegroundServer,
  type DevRuntimeAsset,
  type DevRuntimeRun,
  type DevRuntimeSession,
  type DevRuntimeStatus,
  type DevRuntimeSurface,
  type ProjectStatus,
} from '../src/dev/index.ts';

const projectStatus = (): ProjectStatus => ({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
});

const vector = Object.freeze({
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'g1',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
});

const surface = Object.freeze({
  defaultTarget: 'claude',
  fixtures: [Object.freeze({ id: 'after-edit', label: 'After edit' })],
  id: 'hook.after-edit',
  kind: 'hook' as const,
  label: 'After edit',
  readOnly: false,
  targets: ['claude', 'codex'],
} satisfies DevRuntimeSurface);

const succeededRun = Object.freeze({
  completedAt: '2026-08-15T00:00:01.000Z',
  id: 'run-a',
  input: { path: 'src/a.ts' },
  result: {
    agentVisible: { text: 'done' },
    state: { identity: { stateStoreId: 'state-a', stateVersion: 1 } },
    trace: [],
    tree: [],
  },
  startedAt: '2026-08-15T00:00:00.000Z',
  status: 'succeeded' as const,
  surfaceId: 'hook.after-edit',
  target: 'claude',
  vector,
} satisfies DevRuntimeRun);

const runtimeStatus = Object.freeze({
  activeVector: vector,
  descriptor: {
    environmentVariables: [],
    id: 'provider-a',
    label: 'Provider A',
    schemaVersion: 1,
  },
  diagnostics: [],
  hmrReady: false,
  state: 'active' as const,
} satisfies DevRuntimeStatus);

class MemoryRuntime implements DevRuntimeSession {
  readonly mcpRegistry = {} as DevRuntimeSession['mcpRegistry'];
  readonly invocations: unknown[] = [];
  readonly providerSessionId: string = 'provider-a';
  readonly #flight: Uint8Array;
  #run: DevRuntimeRun = succeededRun;

  constructor(flight: Uint8Array = Uint8Array.from([70, 76, 73, 71, 72, 84])) {
    this.#flight = flight;
  }

  clientSurface(): undefined { return undefined; }
  async close(): Promise<void> {}
  async invoke(request: Parameters<DevRuntimeSession['invoke']>[0]): Promise<DevRuntimeRun> {
    this.invocations.push(request);
    if (request.expectedGenerationId !== undefined && request.expectedGenerationId !== 'g1') {
      const { DevRuntimeGenerationConflictError } = await import('../src/dev/index.ts');
      throw new DevRuntimeGenerationConflictError(request.expectedGenerationId, 'g1');
    }
    this.#run = Object.freeze({ ...succeededRun, input: request.input, target: request.target });
    return this.#run;
  }
  async readAsset(): Promise<DevRuntimeAsset | undefined> {
    return { body: new Uint8Array([1, 2, 3]), contentType: 'application/javascript; charset=utf-8' };
  }
  async readRunFlight(runId: string): Promise<DevRuntimeAsset | undefined> {
    return runId === this.#run.id
      ? { body: this.#flight, contentType: 'application/octet-stream' }
      : undefined;
  }
  async reconcilePreparedRuntime(): Promise<void> {}
  async replay(): Promise<DevRuntimeRun> { return this.#run; }
  async resetState(): Promise<{ readonly stateStoreId: string; readonly stateVersion: number }> {
    return { stateStoreId: 'state-a', stateVersion: 2 };
  }
  run(runId: string): DevRuntimeRun | undefined { return runId === this.#run.id ? this.#run : undefined; }
  runs(limit: number): readonly DevRuntimeRun[] { return [this.#run].slice(0, limit); }
  status(): DevRuntimeStatus { return runtimeStatus; }
  surfaces(): readonly DevRuntimeSurface[] { return [surface]; }
}

class StartingRuntime extends MemoryRuntime {
  readonly providerSessionId = 'provider-starting';

  override runs(): readonly DevRuntimeRun[] { return []; }

  override status(): DevRuntimeStatus {
    return {
      descriptor: runtimeStatus.descriptor,
      diagnostics: [],
      hmrReady: false,
      state: 'starting',
    };
  }
}

class ForeignRunRuntime extends MemoryRuntime {
  readonly providerSessionId = 'provider-a';

  override runs(): readonly DevRuntimeRun[] {
    return [{ ...succeededRun, vector: { ...vector, providerSessionId: 'foreign-provider' } }];
  }

  override async invoke(): Promise<DevRuntimeRun> {
    return { ...succeededRun, vector: { ...vector, providerSessionId: 'foreign-provider' } };
  }

  override async replay(): Promise<DevRuntimeRun> {
    return { ...succeededRun, vector: { ...vector, providerSessionId: 'foreign-provider' } };
  }
}

const coordinator = Object.freeze({
  async close(): Promise<void> {},
  async rebuild(): Promise<void> {},
  async start(): Promise<void> {},
  status: projectStatus,
});

const start = async (
  runtime?: DevRuntimeSession,
  testing?: Parameters<typeof startForegroundServer>[0]['testing'],
) => {
  const options = {
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    runtime,
    sessionToken: 'runtime-session-token',
    testing,
  } as Parameters<typeof startForegroundServer>[0] & { readonly runtime?: DevRuntimeSession };
  return startForegroundServer(options);
};

const authenticated = (server: Awaited<ReturnType<typeof startForegroundServer>>) => ({
  origin: server.url,
  'x-agent-bundle-session': server.sessionToken,
});

interface RuntimeRouteMatrixCase {
  readonly acceptedMethod: string;
  readonly acceptedPath: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly invalidMethod: string;
  readonly queryPath: string;
}

const renderReadyFlight = async (): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const worker = spawn(
    process.execPath,
    ['--conditions=react-server', join(import.meta.dirname, '../../rsc-runtime/tests/flight-render-worker.mjs')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const chunks: Buffer[] = [];
  let error = '';
  worker.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  worker.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); });
  worker.once('error', reject);
  worker.once('close', (code) => {
    if (code !== 0) {
      reject(new Error(`Flight render worker exited with ${String(code)}: ${error}`));
      return;
    }
    resolve(new Uint8Array(Buffer.concat(chunks)));
  });
  worker.stdin.end(`${JSON.stringify({ fixture: 'ready' })}\n`);
});

const realAgentDocumentRuntime = async () => ({
  DEFAULT_AGENT_RENDER_LIMITS,
  decodeAgentFlightStream,
});

const emptyAgentDocumentRuntime = async () => ({
  DEFAULT_AGENT_RENDER_LIMITS,
  decodeAgentFlightStream: () => new ReadableStream({
    start(controller) {
      controller.close();
    },
  }),
});

it('keeps public runtime capability summaries empty when the optional runtime is absent', async () => {
  const server = await start();
  try {
    await expect(fetch(`${server.url}/api/runtime/status`).then((response) => response.json())).resolves.toEqual({ status: null });
    await expect(fetch(`${server.url}/api/runtime/surfaces`).then((response) => response.json())).resolves.toEqual({ surfaces: [] });
    const privateResponse = await fetch(`${server.url}/api/runtime/runs`, { headers: authenticated(server) });
    expect(privateResponse.status).toBe(404);
    await expect(privateResponse.json()).resolves.toEqual({
      diagnostic: { code: 'AB8201', message: 'Development runtime is not available.' },
    });
  } finally {
    await server.close();
  }
});

it('requires the foreground session capability for every runtime input, trace, and Flight byte', async () => {
  const runtime = new MemoryRuntime();
  const server = await start(runtime);
  try {
    const publicStatus = await fetch(`${server.url}/api/runtime/status`);
    expect(publicStatus.status).toBe(200);
    await expect(publicStatus.json()).resolves.toEqual({ status: runtimeStatus });

    const unauthenticated = await fetch(`${server.url}/api/runtime/runs?limit=50`);
    expect(unauthenticated.status).toBe(403);

    const invoked = await fetch(`${server.url}/api/runtime/runs`, {
      body: JSON.stringify({
        expectedGenerationId: 'g1',
        fixtureId: 'after-edit',
        input: { path: 'src/a.ts' },
        surfaceId: 'hook.after-edit',
        target: 'claude',
      }),
      headers: { ...authenticated(server), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toEqual({ run: expect.objectContaining({ surfaceId: 'hook.after-edit', target: 'claude' }) });
    expect(runtime.invocations).toEqual([{
      expectedGenerationId: 'g1',
      fixtureId: 'after-edit',
      input: { path: 'src/a.ts' },
      surfaceId: 'hook.after-edit',
      target: 'claude',
    }]);

    await expect(fetch(`${server.url}/api/runtime/runs?limit=50`, { headers: authenticated(server) }).then((response) => response.json())).resolves.toEqual({
      providerSessionId: 'provider-a',
      runs: [expect.objectContaining({ id: 'run-a' })],
    });

    const flight = await fetch(`${server.url}/api/runtime/runs/run-a/flight`, { headers: authenticated(server) });
    expect(flight.headers.get('cache-control')).toBe('no-store');
    expect(flight.headers.get('content-type')).toBe('application/octet-stream');
    await expect(flight.arrayBuffer()).resolves.toEqual(Uint8Array.from([70, 76, 73, 71, 72, 84]).buffer);

    const document = await fetch(`${server.url}/api/runtime/runs/run-a/document`);
    expect(document.status).toBe(403);
  } finally {
    await server.close();
  }
});

it('decodes stored Flight into bounded Agent Document events in the foreground process', async () => {
  const server = await start(new MemoryRuntime(await renderReadyFlight()), {
    loadAgentDocumentRuntime: realAgentDocumentRuntime,
  });
  try {
    const response = await fetch(`${server.url}/api/runtime/runs/run-a/document`, { headers: authenticated(server) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          document: {
            root: {
              children: [{ kind: 'markdown', text: '# Ready' }],
              kind: 'result',
            },
            status: 'success',
            value: { ready: true },
            version: 1,
          },
          sequence: 0,
          type: 'shell',
        },
        {
          document: {
            root: {
              children: [{ kind: 'markdown', text: '# Ready' }],
              kind: 'result',
            },
            status: 'success',
            value: { ready: true },
            version: 1,
          },
          sequence: 1,
          type: 'complete',
        },
      ],
    });
  } finally {
    await server.close();
  }
});

it('returns honest diagnostics when the Agent runtime is absent or stored Flight cannot decode', async () => {
  const absent = await start(new MemoryRuntime(), {
    loadAgentDocumentRuntime: async () => {
      throw new Error('Cannot find package @agent-bundle/runtime');
    },
  });
  try {
    const response = await fetch(`${absent.url}/api/runtime/runs/run-a/document`, { headers: authenticated(absent) });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8207',
        message: 'Agent Document decoding requires the optional @agent-bundle/runtime peer.',
      },
    });
  } finally {
    await absent.close();
  }

  const invalid = await start(new MemoryRuntime(), {
    loadAgentDocumentRuntime: async () => ({
      DEFAULT_AGENT_RENDER_LIMITS,
      decodeAgentFlightStream: () => {
        throw new Error('invalid Flight');
      },
    }),
  });
  try {
    const response = await fetch(`${invalid.url}/api/runtime/runs/run-a/document`, { headers: authenticated(invalid) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8208',
        message: 'Stored Flight could not be decoded as an Agent Document.',
      },
    });
  } finally {
    await invalid.close();
  }
});

it('rejects malformed, stale, undeclared, and excessive runtime inputs at the fixed boundary', async () => {
  const server = await start(new MemoryRuntime());
  try {
    const headers = authenticated(server);
    const invalidTarget = await fetch(`${server.url}/api/runtime/runs`, {
      body: JSON.stringify({ input: {}, surfaceId: 'hook.after-edit', target: 'portable' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(invalidTarget.status).toBe(400);

    const stale = await fetch(`${server.url}/api/runtime/runs`, {
      body: JSON.stringify({ expectedGenerationId: 'g0', input: {}, surfaceId: 'hook.after-edit', target: 'claude' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      diagnostic: { code: 'AB8204', message: 'Expected runtime generation "g0" is not active.' },
    });

    const duplicateLimit = await fetch(`${server.url}/api/runtime/runs?limit=1&limit=2`, { headers });
    expect(duplicateLimit.status).toBe(400);

    const wrongType = await fetch(`${server.url}/api/runtime/runs`, {
      body: '{}', headers, method: 'POST',
    });
    expect(wrongType.status).toBe(415);

    const tooLarge = await fetch(`${server.url}/api/runtime/runs`, {
      body: JSON.stringify({ input: 'x'.repeat(64 * 1024), surfaceId: 'hook.after-edit', target: 'claude' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tooLarge.status).toBe(413);

    const traversal = await fetch(`${server.url}/api/runtime/assets/hook.after-edit/%2e%2e/main.js?generation=g1`, { headers });
    expect(traversal.status).toBe(400);
  } finally {
    await server.close();
  }
});

it('accepts only the literal method and query matrix for every runtime route', async () => {
  const server = await start(new MemoryRuntime(), { loadAgentDocumentRuntime: emptyAgentDocumentRuntime });
  const privateHeaders = authenticated(server);
  const jsonHeaders = { ...privateHeaders, 'content-type': 'application/json' };
  const root = server.url;
  const routes: readonly RuntimeRouteMatrixCase[] = [
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/status', headers: undefined, invalidMethod: 'POST', queryPath: '/api/runtime/status?extra=1&extra=2' },
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/surfaces', headers: undefined, invalidMethod: 'POST', queryPath: '/api/runtime/surfaces?extra=1&extra=2' },
    { acceptedMethod: 'POST', acceptedPath: '/api/runtime/runs', body: JSON.stringify({ input: {}, surfaceId: 'hook.after-edit', target: 'claude' }), headers: jsonHeaders, invalidMethod: 'PATCH', queryPath: '/api/runtime/runs?extra=1&extra=2' },
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/runs?limit=1', headers: privateHeaders, invalidMethod: 'PATCH', queryPath: '/api/runtime/runs?limit=1&limit=2' },
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/runs/run-a', headers: privateHeaders, invalidMethod: 'POST', queryPath: '/api/runtime/runs/run-a?extra=1&extra=2' },
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/runs/run-a/flight', headers: privateHeaders, invalidMethod: 'POST', queryPath: '/api/runtime/runs/run-a/flight?extra=1&extra=2' },
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/runs/run-a/document', headers: privateHeaders, invalidMethod: 'POST', queryPath: '/api/runtime/runs/run-a/document?extra=1&extra=2' },
    { acceptedMethod: 'POST', acceptedPath: '/api/runtime/runs/run-a/replay', body: JSON.stringify({ mode: 'exact', runId: 'run-a' }), headers: jsonHeaders, invalidMethod: 'GET', queryPath: '/api/runtime/runs/run-a/replay?extra=1&extra=2' },
    { acceptedMethod: 'POST', acceptedPath: '/api/runtime/state/reset', body: JSON.stringify({ stateStoreId: 'state-a' }), headers: jsonHeaders, invalidMethod: 'GET', queryPath: '/api/runtime/state/reset?extra=1&extra=2' },
    { acceptedMethod: 'GET', acceptedPath: '/api/runtime/assets/hook.after-edit/main.js?generation=g1', headers: privateHeaders, invalidMethod: 'HEAD', queryPath: '/api/runtime/assets/hook.after-edit/main.js?generation=g1&generation=g2' },
  ];

  try {
    for (const route of routes) {
      const accepted = await fetch(`${root}${route.acceptedPath}`, {
        ...(route.body === undefined ? {} : { body: route.body }),
        ...(route.headers === undefined ? {} : { headers: route.headers }),
        method: route.acceptedMethod,
      });
      expect(accepted.status).toBe(200);

      const wrongMethod = await fetch(`${root}${route.acceptedPath}`, {
        ...(route.headers === undefined ? {} : { headers: route.headers }),
        method: route.invalidMethod,
      });
      expect(wrongMethod.status).toBe(405);

      const wrongQuery = await fetch(`${root}${route.queryPath}`, {
        ...(route.body === undefined ? {} : { body: route.body }),
        ...(route.headers === undefined ? {} : { headers: route.headers }),
        method: route.acceptedMethod,
      });
      expect(wrongQuery.status).toBe(400);
    }
  } finally {
    await server.close();
  }
});

it('keeps a controller-owned provider identity available before the first generation exists', async () => {
  const server = await start(new StartingRuntime());
  try {
    const response = await fetch(`${server.url}/api/runtime/runs`, { headers: authenticated(server) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ providerSessionId: 'provider-starting', runs: [] });
  } finally {
    await server.close();
  }
});

it('rejects provider responses that cross a stable provider boundary or replay a different path run', async () => {
  const server = await start(new ForeignRunRuntime());
  try {
    const headers = { ...authenticated(server), 'content-type': 'application/json' };
    const invocation = await fetch(`${server.url}/api/runtime/runs`, {
      body: JSON.stringify({ input: {}, surfaceId: 'hook.after-edit', target: 'claude' }),
      headers,
      method: 'POST',
    });
    expect(invocation.status).toBe(500);

    const history = await fetch(`${server.url}/api/runtime/runs`, { headers: authenticated(server) });
    expect(history.status).toBe(500);

    const replay = await fetch(`${server.url}/api/runtime/runs/run-a/replay`, {
      body: JSON.stringify({ mode: 'exact', runId: 'run-a' }),
      headers,
      method: 'POST',
    });
    expect(replay.status).toBe(500);

    const replayPathMismatch = await fetch(`${server.url}/api/runtime/runs/run-a/replay`, {
      body: JSON.stringify({ mode: 'exact', runId: 'run-b' }),
      headers,
      method: 'POST',
    });
    expect(replayPathMismatch.status).toBe(400);
  } finally {
    await server.close();
  }
});
