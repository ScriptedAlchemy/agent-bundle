import { describe, expect, it } from '@rstest/core';

import {
  assertCurrentMcpAppDocumentPolicy,
  isCurrentMcpAppDocumentPolicy,
  McpAppClient,
  type McpAppPreviewCreateRequest,
} from '../src/mcp/mcp-app-client.ts';
import { ProjectClient, type EventSourceLike, type EventSourceMessage } from '../src/project-client.ts';

const request: McpAppPreviewCreateRequest = Object.freeze({
  host: Object.freeze({
    availableDisplayModes: Object.freeze(['inline']),
    containerDimensions: Object.freeze({ height: 400, width: 640 }),
    deviceCapabilities: Object.freeze({}),
    displayMode: 'inline',
    locale: 'en-US',
    platform: 'web',
    safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
    styles: Object.freeze({}),
    theme: 'light',
    timeZone: 'UTC',
    userAgent: 'Agent Bundle Workbench',
  }),
  input: Object.freeze({ city: 'Berlin' }),
  previewProfile: 'portable',
  result: Object.freeze({ content: Object.freeze([]) }),
  toolName: 'weather',
});

const preview = Object.freeze({
  bindingId: 'binding-weather',
  frame: Object.freeze({
    allow: '',
    policy: Object.freeze({
      contentSecurityPolicy: "default-src 'none'",
      iframeAllow: '',
      permissionsPolicy: 'camera=()',
    }),
    referrerPolicy: 'no-referrer',
    relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 4 }),
    sandbox: 'allow-scripts allow-same-origin',
    src: 'http://127.0.0.1:43124/#sandbox-configuration',
    targetOrigin: 'http://127.0.0.1:43124',
  }),
  profile: Object.freeze({ kind: 'apps' }),
  resource: Object.freeze({ html: '<main>Weather</main>', kind: 'resource' }),
});

const runtimeMetadata = Object.freeze({
  extensions: Object.freeze({ claude: Object.freeze({}), openai: Object.freeze({}) }),
  provenance: Object.freeze({}),
  raw: Object.freeze({}),
  standard: Object.freeze({}),
});

const runtimePolicy = Object.freeze({
  allow: 'camera',
  approvedPermissions: Object.freeze({ camera: Object.freeze({}) }),
  revision: 1,
  warnings: Object.freeze([]),
});

const runtimePreview = Object.freeze({
  binding: Object.freeze({
    definitionDigest: 'definition-a', evidence: 'simulated', id: 'runtime-binding', profileId: 'portable',
    profileVersion: 'agent-bundle:mcp-apps:2026-01-26', registryRevision: 3,
    runVector: Object.freeze({ runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 }),
    serverDigest: 'server-a', serverName: 'weather', sessionId: 'runtime-session-a', sessionRevision: 2,
    target: 'portable', transportDigest: 'transport-a',
  }),
  clientSurface: Object.freeze({ bootstrapUrl: 'http://127.0.0.1:43124/app-bootstrap', origin: 'http://127.0.0.1:43124', webSocketPath: '/rsbuild-hmr' }),
  documentPolicy: runtimePolicy,
  kind: 'apps',
  metadata: Object.freeze({ resource: runtimeMetadata, result: runtimeMetadata, tool: runtimeMetadata }),
  operations: Object.freeze([]),
  profile: Object.freeze({
    bootstrap: Object.freeze({ kind: 'none' }),
    configExtensions: Object.freeze({ entries: Object.freeze([]), sourceRevision: 'source-a' }),
    descriptor: Object.freeze({ claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }),
    hostContext: Object.freeze({
      availableDisplayModes: Object.freeze(['inline']), containerDimensions: Object.freeze({ height: 720, width: 1024 }),
      deviceCapabilities: Object.freeze({}), displayMode: 'inline', locale: 'en-US', platform: 'agent-bundle-workbench',
      safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), styles: Object.freeze({}), theme: 'light', timeZone: 'UTC', toolInfo: Object.freeze({}), userAgent: 'agent-bundle-runtime-mcp-app/1',
    }),
    kind: 'apps', metadata: runtimeMetadata, permissions: Object.freeze({ camera: Object.freeze({}) }), resourceUri: 'ui://weather/app.html', warnings: Object.freeze([]),
  }),
  resource: Object.freeze({ html: '<main>Weather</main>', permissions: Object.freeze({ camera: Object.freeze({}) }) }),
  result: Object.freeze({ appVisible: Object.freeze({}), isError: false, modelVisible: Object.freeze({}) }),
  session: Object.freeze({
    binding: Object.freeze({
      definitionDigest: 'definition-a', registryRevision: 3, serverDigest: 'server-a', serverName: 'weather',
      sessionId: 'runtime-session-a', sessionRevision: 2, target: 'portable', transportDigest: 'transport-a',
    }),
    connection: Object.freeze({ capabilities: Object.freeze({ tools: Object.freeze({}) }), protocolEra: 'modern', protocolVersion: '2026-01-26', server: Object.freeze({ name: 'weather', version: '1.0.0' }) }),
    state: 'ready',
  }),
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

class RuntimeEventSource implements EventSourceLike {
  closed = false;
  readonly #listeners = new Map<string, (event: EventSourceMessage) => void>();

  addEventListener(type: string, listener: (event: EventSourceMessage) => void): void {
    this.#listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, value: unknown, sequence: number | ''): void {
    this.#listeners.get(type)?.({ data: JSON.stringify(value), lastEventId: String(sequence) });
  }
}

const flushEvents = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('MCP App browser client', () => {
  it('uses only the closed runtime App routes and rotates one trusted policy per binding', async () => {
    const calls: Array<readonly [string, RequestInit | undefined]> = [];
    const nextPolicy = Object.freeze({ ...runtimePolicy, allow: 'camera; geolocation', revision: 2 });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding') return init?.method === 'DELETE'
        ? json({ closed: true })
        : json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding/operations') return json({ result: {
        operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 2, value: { tools: [] },
        vector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 },
      } });
      if (String(input) === '/api/runtime/apps/runtime-binding/consents') return json({
        challenge: { expiresAt: 31_000, id: 'consent-a', request: { actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera' } },
        documentPolicy: runtimePolicy,
      });
      if (String(input) === '/api/runtime/apps/runtime-binding/consents/consent-a') return json({ documentPolicy: nextPolicy });
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch }) as McpAppClient & {
      closeRuntime(bindingId: string): Promise<void>;
      createRuntime(request: unknown): Promise<unknown>;
      createRuntimeConsent(bindingId: string, request: unknown): Promise<unknown>;
      currentDocumentPolicy(bindingId: string): Readonly<{ readonly bindingId: string; readonly snapshot: Readonly<{ readonly revision: number }> }>;
      decideRuntimeConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<unknown>;
      getRuntime(bindingId: string): Promise<unknown>;
      operateRuntime(bindingId: string, operation: unknown): Promise<unknown>;
    };

    await expect(runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).resolves.toMatchObject({ binding: { id: 'runtime-binding' }, kind: 'apps' });
    const initialPolicy = runtime.currentDocumentPolicy('runtime-binding');
    await expect(runtime.getRuntime('runtime-binding')).resolves.toMatchObject({ binding: { id: 'runtime-binding' } });
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).resolves.toMatchObject({ operationId: 'operation-a' });
    await expect(runtime.createRuntimeConsent('runtime-binding', {
      actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera',
    })).resolves.toMatchObject({ challenge: { id: 'consent-a' } });
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-a', 'allow-once')).resolves.toMatchObject({ documentPolicy: { revision: 2 } });
    const currentPolicy = runtime.currentDocumentPolicy('runtime-binding');
    expect(currentPolicy).not.toBe(initialPolicy);
    expect(currentPolicy).toMatchObject({ bindingId: 'runtime-binding', snapshot: { revision: 2 } });
    await expect(runtime.closeRuntime('runtime-binding')).resolves.toBeUndefined();
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow();

    expect(calls.map(([path]) => path)).toEqual([
      '/api/project/session',
      '/api/runtime/apps',
      '/api/runtime/apps/runtime-binding',
      '/api/runtime/apps/runtime-binding/operations',
      '/api/runtime/apps/runtime-binding/consents',
      '/api/runtime/apps/runtime-binding/consents/consent-a',
      '/api/runtime/apps/runtime-binding',
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    expect(calls[2]?.[1]?.method).toBeUndefined();
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toEqual({ kind: 'tools/list' });
    expect(JSON.parse(String(calls[4]?.[1]?.body))).toEqual({
      actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera',
    });
    expect(JSON.parse(String(calls[5]?.[1]?.body))).toEqual({ decision: 'allow-once' });
    expect(calls[6]?.[1]?.method).toBe('DELETE');
  });

  it('rejects runtime previews that expose configuration values, private vectors, or mismatched stable session identities', async () => {
    const malformed = (mutate: (preview: Record<string, unknown>) => void): typeof globalThis.fetch => (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      mutate(copy);
      return json({ preview: copy });
    }) as typeof globalThis.fetch;

    const privateVector = new McpAppClient({ fetch: malformed((preview) => {
      ((preview.binding as Record<string, unknown>).runVector as Record<string, unknown>).providerSessionId = 'private-provider';
    }) });
    await expect(privateVector.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });

    const leakedConfig = new McpAppClient({ fetch: malformed((preview) => {
      const profile = preview.profile as Record<string, unknown>;
      const config = profile.configExtensions as Record<string, unknown>;
      config.entries = [{ configured: true, id: 'extension:codex', key: 'codex', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'codex', value: { nativeHooks: 'private' } }];
    }) });
    await expect(leakedConfig.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });

    const mismatchedSession = new McpAppClient({ fetch: malformed((preview) => {
      (((preview.session as Record<string, unknown>).binding as Record<string, unknown>).sessionRevision = 99);
    }) });
    await expect(mismatchedSession.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });
  });

  it('uses a connected ProjectClient for exact runtime invalidations and revokes stale policy handles', async () => {
    const stream = new RuntimeEventSource();
    let streamCount = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json({ status: { artifact: { state: 'missing' } } });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') return json({ closed: true });
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({
      events: () => {
        streamCount += 1;
        return stream;
      },
      fetch: fetch as typeof globalThis.fetch,
    });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    const invalidations: unknown[] = [];
    const unsubscribe = runtime.subscribeInvalidations((details) => invalidations.push(details));
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const policy = runtime.currentDocumentPolicy('runtime-binding');
    expect(isCurrentMcpAppDocumentPolicy(runtime, policy)).toBe(true);
    expect(assertCurrentMcpAppDocumentPolicy(runtime, policy)).toBe(policy);

    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: { type: 'runtime.app.updated', details: { bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' } },
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    expect(streamCount).toBe(1);
    expect(invalidations).toEqual([{ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }]);
    expect(isCurrentMcpAppDocumentPolicy(runtime, policy)).toBe(false);
    expect(() => assertCurrentMcpAppDocumentPolicy(runtime, policy)).toThrow('Runtime MCP App document policy is no longer current.');
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    stream.emit('replay.gap', { earliestAvailableSequence: 3, latestDroppedSequence: 2, requestedAfterSequence: 1, type: 'replay.gap' }, '');
    await flushEvents();
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    unsubscribe();
    project.close();
  });

  it('creates a binding-scoped preview without putting the foreground credential in its URL or request payload', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({ lifecycle: 'created', preview });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.create('session-weather', request)).resolves.toEqual(preview);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['/api/project/session', { credentials: 'same-origin' }]);
    expect(calls[1]?.[0]).toBe('/api/mcp/sessions/session-weather/apps');
    expect(calls[1]?.[1]).toMatchObject({ method: 'POST' });
    const headers = new Headers(calls[1]?.[1]?.headers);
    expect(headers.get('x-agent-bundle-session')).toBe('foreground-secret');
    expect(String(calls[1]?.[0])).not.toContain('foreground-secret');
    expect(String(calls[1]?.[1]?.body)).not.toContain('foreground-secret');
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      host: request.host, input: request.input, previewProfile: request.previewProfile, result: request.result, toolName: request.toolName,
    });
  });

  it('forwards one binding message through the authenticated route and exposes only the returned frames', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({
        accepted: true,
        actions: [],
        lifecycle: 'initialized',
        messages: [{ id: 'ping-1', jsonrpc: '2.0', result: {} }],
      });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    const message = Object.freeze({ id: 'ping-1', jsonrpc: '2.0' as const, method: 'ping', params: Object.freeze({}) });

    await expect(client.message('binding-weather', message)).resolves.toEqual({
      accepted: true,
      lifecycle: 'initialized',
      messages: [{ id: 'ping-1', jsonrpc: '2.0', result: {} }],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toBe('/api/mcp/apps/binding-weather/messages');
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ message });
  });

  it('lists server-created consent challenges and returns a fresh server snapshot without a grant', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const refreshed = Object.freeze({
      ...preview,
      frame: Object.freeze({
        ...preview.frame,
        allow: 'geolocation',
        documentPolicy: Object.freeze({
          allow: 'geolocation',
          approvedPermissions: Object.freeze({ geolocation: Object.freeze({}) }),
          revision: 2,
          warnings: Object.freeze([]),
        }),
      }),
    });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (init?.method === 'POST') return json({ approved: true, lifecycle: 'initialized', messages: [], preview: refreshed });
      return json({ challenges: [{ expiresAt: 31_000, id: 'consent-1', request: { capability: 'geolocation', scope: 'document' } }], lifecycle: 'initialized' });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.consentChallenges('binding-weather')).resolves.toEqual([{
      expiresAt: 31_000,
      id: 'consent-1',
      request: { capability: 'geolocation', scope: 'document' },
    }]);
    await expect(client.decideConsent('binding-weather', 'consent-1', true)).resolves.toMatchObject({
      approved: true,
      messages: [],
      preview: { frame: { allow: 'geolocation', documentPolicy: { revision: 2 } } },
    });
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ approved: true, challengeId: 'consent-1' });
    expect(String(calls[2]?.[1]?.body)).not.toContain('grant-');
  });

  it('closes with a teardown frame then forgets the memory credential before its force-delete fallback', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (init?.method === 'DELETE') return json({ closed: true, lifecycle: 'closed' });
      return json({
        actions: [],
        lifecycle: 'closing',
        message: { id: 'close-1', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} },
      });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.close('binding-weather', { id: 'close-1', reason: 'MCP App frame unmounted.' })).resolves.toEqual({
      lifecycle: 'closing',
      message: { id: 'close-1', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} },
    });
    await expect(client.forceClose('binding-weather')).resolves.toBe(true);

    expect(calls.map(([path]) => path)).toEqual([
      '/api/project/session',
      '/api/mcp/apps/binding-weather/close',
      '/api/project/session',
      '/api/mcp/apps/binding-weather',
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ id: 'close-1', reason: 'MCP App frame unmounted.' });
    expect(calls[3]?.[1]?.method).toBe('DELETE');
  });

  it('preserves a raw App frame that contains an own __proto__ JSON property', async () => {
    const rawFrame = JSON.parse('{"id":"proto-1","jsonrpc":"2.0","result":{"__proto__":{"ordinary":true}}}') as unknown;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({ accepted: true, actions: [], lifecycle: 'initialized', messages: [rawFrame] });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    const result = await client.message('binding-weather', { id: 'proto-1', jsonrpc: '2.0', method: 'ping' });
    const frame = result.messages[0] as Readonly<Record<string, unknown>>;
    const payload = frame.result as Readonly<Record<string, unknown>>;

    expect(Object.hasOwn(payload, '__proto__')).toBe(true);
    expect(payload['__proto__']).toEqual({ ordinary: true });
    expect(Object.getPrototypeOf(payload)).toBeNull();
  });

  it('rejects a preview frame whose proxy target origin is the authenticated foreground origin', async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: preview.frame!.targetOrigin, token: 'foreground-secret' });
      return json({ lifecycle: 'created', preview });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.create('session-weather', request)).rejects.toThrow(
      'Foreground MCP App frame must use a distinct proxy origin.',
    );
  });

  it('classifies a malformed successful route body as an invalid route response', async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return new Response('{', { headers: { 'content-type': 'application/json' }, status: 200 });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.message('binding-weather', { id: 'bad-body', jsonrpc: '2.0', method: 'ping' })).rejects.toMatchObject({ code: 'AB8019' });
  });

  it('surfaces a structured non-2xx diagnostic without reclassifying it as a route-shape error', async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({ diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' } }, 404);
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.message('binding-weather', { id: 'not-found', jsonrpc: '2.0', method: 'ping' })).rejects.toMatchObject({
      code: 'AB8022',
      message: 'MCP App preview is not available.',
    });
  });
});
