import { describe, expect, it } from '@rstest/core';

import { runtimeAppMessageLimits } from '../../agent-bundle/src/dev/runtime-app-message-limits.ts';

import {
  assertCurrentMcpAppDocumentPolicy,
  isCurrentMcpAppDocumentPolicy,
  McpAppClient as McpAppClientImplementation,
  type McpAppConsentChallenge,
  type McpAppPreviewCreateRequest,
} from '../src/mcp/mcp-app-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { createRuntimeConsentQueue } from '../src/mcp/runtime-consent-queue.ts';
import { ProjectClient, type EventSourceLike, type EventSourceMessage } from '../src/project-client.ts';

const foregroundCookieName = 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef';
const missingProjectStatusResponse = Object.freeze({
  status: Object.freeze({
    artifact: Object.freeze({ state: 'missing' }),
    build: Object.freeze({ state: 'idle' }),
    source: Object.freeze({ diagnostics: Object.freeze([]), state: 'unknown' }),
  }),
});

const withCanonicalForegroundSession = (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await fetch(input, init);
    if (String(input) !== '/api/project/session' || !response.ok) return response;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    const record = body as Readonly<Record<string, unknown>>;
    if (
      body === null
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.keys(record).length !== 2
      || !Object.hasOwn(record, 'origin')
      || !Object.hasOwn(record, 'token')
      || typeof record.origin !== 'string'
      || typeof record.token !== 'string'
    ) {
      return response;
    }
    return Response.json(
      { cookieName: foregroundCookieName, instanceId: 'foreground-instance-a', origin: record.origin, token: record.token },
      { headers: response.headers, status: response.status, statusText: response.statusText },
    );
  };

class McpAppClient extends McpAppClientImplementation {
  constructor(options: Readonly<{
    readonly fetch: typeof globalThis.fetch;
    readonly foreground?: ForegroundRouteClient;
    readonly projectClient?: Pick<ProjectClient, 'subscribeEvents'>;
  }>) {
    super({
      foreground: options.foreground ?? new ForegroundRouteClient({ fetch: withCanonicalForegroundSession(options.fetch) }),
      ...(options.projectClient === undefined ? {} : { projectClient: options.projectClient }),
    });
  }
}

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
  allow: '',
  approvedPermissions: Object.freeze({}),
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
      deviceCapabilities: Object.freeze({}), displayMode: 'inline', locale: 'en-US', platform: 'web',
      safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), styles: Object.freeze({}), theme: 'light', timeZone: 'UTC', toolInfo: Object.freeze({}), userAgent: 'agent-bundle-runtime-mcp-app/1',
    }),
    kind: 'apps', metadata: runtimeMetadata, permissions: Object.freeze({ camera: Object.freeze({}), geolocation: Object.freeze({}) }), resourceUri: 'ui://weather/app.html', warnings: Object.freeze([]),
  }),
  resource: Object.freeze({ html: '<main>Weather</main>', permissions: Object.freeze({ camera: Object.freeze({}), geolocation: Object.freeze({}) }) }),
  result: Object.freeze({ appVisible: Object.freeze({ content: Object.freeze([]) }), isError: false, modelVisible: Object.freeze({}) }),
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

const streamedResponse = (body: string, headers: Readonly<Record<string, string>> = {}, chunks = 1): Response => {
  const bytes = new TextEncoder().encode(body);
  const width = Math.max(1, Math.ceil(bytes.byteLength / chunks));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += width) {
        controller.enqueue(bytes.slice(offset, Math.min(bytes.byteLength, offset + width)));
      }
      controller.close();
    },
  }), { headers: { 'content-type': 'application/json', ...headers }, status: 200 });
};

const eventually = async (predicate: () => boolean, timeout = 300): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
};

const runtimeAppUpdated = (details: Readonly<{
  readonly bindingId: string;
  readonly reason: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly state: 'revoked';
}>) => Object.freeze({
  details: Object.freeze({ ...details }),
  mcpSessionId: details.sessionId,
  mcpSessionRevision: details.sessionRevision,
  providerSessionId: 'provider-session-a',
  type: 'runtime.app.updated' as const,
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

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason?: unknown): void;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (reason) => rejectPromise?.(reason),
    resolve: (value) => resolvePromise?.(value),
  };
};

describe('MCP App browser client', () => {
  for (const [description, body] of [
    ['a versioned payload', { cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', schemaVersion: 1, token: 'foreground-secret' }],
    ['an unexpected payload field', { cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', scope: 'workbench', token: 'foreground-secret' }],
    ['a malformed payload', { cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123' }],
  ] as const) {
    it(`rejects ${description} from the shared foreground session bootstrap`, async () => {
      const routePaths: string[] = [];
      const client = new McpAppClient({
        fetch: (async (input) => {
          if (String(input) === '/api/project/session') return json(body);
          routePaths.push(String(input));
          return json({ accepted: true, lifecycle: 'initialized', messages: [] });
        }) as typeof globalThis.fetch,
      });

      await expect(client.message('binding-weather', { id: 'session-body', jsonrpc: '2.0', method: 'ping' })).rejects.toMatchObject({ code: 'AB8019' });
      expect(routePaths).toEqual([]);
    });
  }

  it('uses only the closed runtime App routes and rotates one trusted policy per binding', async () => {
    const calls: Array<readonly [string, RequestInit | undefined]> = [];
    const nextPolicy = Object.freeze({
      ...runtimePolicy,
      allow: 'camera',
      approvedPermissions: Object.freeze({ camera: Object.freeze({}) }),
      revision: 2,
    });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
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
      if (String(input) === '/api/runtime/apps/runtime-binding/consents/consent-a') return json({
        documentPolicy: nextPolicy,
        grant: { authorizationId: 'authorization-a', bindingId: 'runtime-binding', capability: 'camera', challengeId: 'consent-a', scope: 'document' },
      });
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch }) as McpAppClient & {
      closeRuntime(bindingId: string): Promise<void>;
      createRuntime(request: unknown): Promise<unknown>;
      createRuntimeConsent(bindingId: string, request: unknown, signal?: AbortSignal): Promise<unknown>;
      currentDocumentPolicy(bindingId: string): Readonly<{ readonly bindingId: string; readonly snapshot: Readonly<{ readonly revision: number }> }>;
      decideRuntimeConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny', signal?: AbortSignal): Promise<unknown>;
      getRuntime(bindingId: string): Promise<unknown>;
      operateRuntime(bindingId: string, operation: unknown, signal?: AbortSignal): Promise<unknown>;
    };

    await expect(runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).resolves.toMatchObject({ binding: { id: 'runtime-binding' }, kind: 'apps' });
    const initialPolicy = runtime.currentDocumentPolicy('runtime-binding');
    await expect(runtime.getRuntime('runtime-binding')).resolves.toMatchObject({ binding: { id: 'runtime-binding' } });
    const operationAbort = new AbortController();
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' }, operationAbort.signal)).resolves.toMatchObject({ operationId: 'operation-a' });
    const createConsentAbort = new AbortController();
    await expect(runtime.createRuntimeConsent('runtime-binding', {
      actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera',
    }, createConsentAbort.signal)).resolves.toMatchObject({ challenge: { id: 'consent-a' } });
    const decideConsentAbort = new AbortController();
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-a', 'allow-once', decideConsentAbort.signal)).resolves.toMatchObject({ documentPolicy: { revision: 2 } });
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
    expect(calls[3]?.[1]?.signal).toBe(operationAbort.signal);
    expect(JSON.parse(String(calls[4]?.[1]?.body))).toEqual({
      actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera',
    });
    expect(calls[4]?.[1]?.signal).toBe(createConsentAbort.signal);
    expect(JSON.parse(String(calls[5]?.[1]?.body))).toEqual({ decision: 'allow-once' });
    expect(calls[5]?.[1]?.signal).toBe(decideConsentAbort.signal);
    expect(calls[6]?.[1]?.method).toBe('DELETE');
  });

  it('abandons cancelled runtime consent challenges before a late decision can dispatch or replay', async () => {
    const decisionPaths: string[] = [];
    let nextConsent = 0;
    let holdDecision = false;
    let failDecision = false;
    const request = Object.freeze({
      actionFingerprint: 'fingerprint-a', capability: 'call-tool' as const, details: Object.freeze({ arguments: Object.freeze({}), name: 'forecast' }),
      scope: 'action' as const, summary: 'Call MCP App tool',
    });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (path === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding/consents') return json({
        challenge: { expiresAt: 31_000, id: `consent-${++nextConsent}`, request }, documentPolicy: runtimePolicy,
      });
      if (path.startsWith('/api/runtime/apps/runtime-binding/consents/')) {
        decisionPaths.push(path);
        if (holdDecision) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          });
        }
        if (failDecision) throw new Error('decision transport failed');
        const consentId = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
        const decision = JSON.parse(String(init?.body)) as Readonly<{ readonly decision: 'allow-once' | 'deny' }>;
        return json({
          documentPolicy: runtimePolicy,
          ...(decision.decision === 'allow-once' ? {
            grant: { authorizationId: `authorization-${consentId}`, bindingId: 'runtime-binding', capability: 'call-tool', challengeId: consentId, scope: 'action' },
          } : {}),
        });
      }
      throw new Error(`Unexpected request ${path}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch }) as McpAppClient & {
      abandonRuntimeConsent(bindingId: string, consentId: string): void;
    };
    const queue = createRuntimeConsentQueue(() => undefined);
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

    for (let index = 0; index < 2; index += 1) {
      const created = await runtime.createRuntimeConsent('runtime-binding', request);
      const abort = new AbortController();
      const promptChallenge: McpAppConsentChallenge = Object.freeze({
        expiresAt: created.challenge.expiresAt,
        id: created.challenge.id,
        request: Object.freeze({}),
      });
      const prompting = queue.request(promptChallenge, abort.signal);
      const reason = new DOMException(`Prompt ${index} cancelled.`, 'AbortError');
      abort.abort(reason);
      await expect(prompting).rejects.toBe(reason);
      expect(runtime.abandonRuntimeConsent).toBeTypeOf('function');
      runtime.abandonRuntimeConsent('runtime-binding', created.challenge.id);
      await expect(runtime.decideRuntimeConsent('runtime-binding', created.challenge.id, 'allow-once')).rejects.toMatchObject({ code: 'AB8015' });
    }
    expect(decisionPaths).toEqual([]);

    const denied = await runtime.createRuntimeConsent('runtime-binding', request);
    await expect(runtime.decideRuntimeConsent('runtime-binding', denied.challenge.id, 'deny')).resolves.toEqual({ documentPolicy: runtimePolicy });

    holdDecision = true;
    const abortedDecision = await runtime.createRuntimeConsent('runtime-binding', request);
    const decisionAbort = new AbortController();
    const deciding = runtime.decideRuntimeConsent('runtime-binding', abortedDecision.challenge.id, 'allow-once', decisionAbort.signal);
    await eventually(() => decisionPaths.length === 2);
    const decisionReason = new DOMException('Decision cancelled.', 'AbortError');
    decisionAbort.abort(decisionReason);
    await expect(deciding).rejects.toBe(decisionReason);
    await expect(runtime.decideRuntimeConsent('runtime-binding', abortedDecision.challenge.id, 'allow-once')).rejects.toMatchObject({ code: 'AB8015' });

    holdDecision = false;
    failDecision = true;
    const failedDecision = await runtime.createRuntimeConsent('runtime-binding', request);
    await expect(runtime.decideRuntimeConsent('runtime-binding', failedDecision.challenge.id, 'deny')).rejects.toThrow('decision transport failed');
    await expect(runtime.decideRuntimeConsent('runtime-binding', failedDecision.challenge.id, 'deny')).rejects.toMatchObject({ code: 'AB8015' });
    expect(decisionPaths).toHaveLength(3);
  });

  it('admits only exact, frozen App-visible CallToolResults before installing a runtime policy', async () => {
    const richResult = {
      _meta: { 'io.modelcontextprotocol/ui': { invocationId: 'invocation-weather' } },
      content: [
        { _meta: { emphasis: 'high' }, annotations: { audience: ['assistant'], lastModified: '2026-08-16T00:00:00Z', priority: 0.8 }, text: 'Sunny', type: 'text' },
        { annotations: { audience: ['user'] }, data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        { data: 'aGVsbG8=', mimeType: 'audio/wav', type: 'audio' },
        { annotations: { priority: 0.5 }, icons: [{ mimeType: 'image/svg+xml', sizes: ['16x16'], src: 'https://example.test/weather.svg', theme: 'light' }], name: 'forecast', type: 'resource_link', uri: 'resource://weather/forecast' },
        { annotations: { lastModified: '2026-08-16T00:00:00Z' }, resource: { _meta: { source: 'runtime' }, text: 'Forecast', uri: 'resource://weather/forecast' }, type: 'resource' },
        { resource: { blob: 'aGVsbG8=', mimeType: 'text/plain', uri: 'resource://weather/blob' }, type: 'resource' },
      ],
      isError: false,
      structuredContent: { forecast: { temperature: 22, unit: 'C' } },
    };
    const validPreview = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
    validPreview.result = {
      appVisible: richResult,
      isError: false,
      modelVisible: { content: richResult.content, structuredContent: richResult.structuredContent },
    };
    const runtimeFor = (payload: unknown): McpAppClient => new McpAppClient({ fetch: (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: payload });
      throw new Error(`Unexpected request ${String(input)}.`);
    }) as typeof globalThis.fetch });

    const valid = runtimeFor(validPreview);
    const admitted = await valid.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    expect(admitted).toMatchObject({
      result: {
        appVisible: richResult,
        isError: false,
      },
    });
    const appVisible = admitted.result.appVisible as Readonly<{ readonly content: readonly object[]; readonly structuredContent: Readonly<{ readonly forecast: object }> }>;
    expect(Object.isFrozen(appVisible)).toBe(true);
    expect(Object.isFrozen(appVisible.content)).toBe(true);
    expect(Object.isFrozen(appVisible.structuredContent.forecast)).toBe(true);

    const malformed = [
      (result: Record<string, unknown>) => { delete (result.appVisible as Record<string, unknown>).content; },
      (result: Record<string, unknown>) => { (result.appVisible as Record<string, unknown>).extra = true; },
      (result: Record<string, unknown>) => { (result.appVisible as Record<string, unknown>).content = [{ text: 'missing type' }]; },
      (result: Record<string, unknown>) => { (result.appVisible as Record<string, unknown>).content = [{ extra: true, text: 'extra field', type: 'text' }]; },
      (result: Record<string, unknown>) => { (result.appVisible as Record<string, unknown>)._meta = []; },
      (result: Record<string, unknown>) => { (result.appVisible as Record<string, unknown>).structuredContent = []; },
      (result: Record<string, unknown>) => { (result.appVisible as Record<string, unknown>).isError = 'no'; },
      (result: Record<string, unknown>) => { ((result.appVisible as Record<string, unknown>).content as Record<string, unknown>[])[0]!.annotations = { audience: ['assistant'], unexpected: true }; },
      (result: Record<string, unknown>) => {
        const icons = ((result.appVisible as Record<string, unknown>).content as Record<string, unknown>[])[3]!.icons as unknown[];
        (icons[0] as Record<string, unknown>).unexpected = true;
      },
      (result: Record<string, unknown>) => { ((result.appVisible as Record<string, unknown>).content as Record<string, unknown>[])[4]!.resource = { uri: 'resource://weather/empty' }; },
      (result: Record<string, unknown>) => { ((result.appVisible as Record<string, unknown>).content as Record<string, unknown>[])[4]!.resource = { blob: 'aGVsbG8=', text: 'Forecast', uri: 'resource://weather/both' }; },
    ];
    for (const mutate of malformed) {
      const payload = JSON.parse(JSON.stringify(validPreview)) as Record<string, unknown>;
      mutate(payload.result as Record<string, unknown>);
      const rejected = runtimeFor(payload);
      await expect(rejected.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });
      expect(() => rejected.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    }
  });

  it('rejects hostless ui resource URIs before installing a runtime document policy', async () => {
    for (const resourceUri of ['ui:/weather/app.html', 'ui:///weather/app.html']) {
      const malformed = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      (malformed.profile as Record<string, unknown>).resourceUri = resourceUri;
      const client = new McpAppClient({ fetch: (async (input: string | URL | Request) => {
        if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
        if (String(input) === '/api/runtime/apps') return json({ preview: malformed });
        throw new Error(`Unexpected request ${String(input)}.`);
      }) as typeof globalThis.fetch });

      await expect(client.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });
      expect(() => client.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    }
  });

  it('retains one exact trusted policy after a failed runtime close and revokes it only after a validated retry', async () => {
    let closeAttempts = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') {
        closeAttempts += 1;
        return closeAttempts === 1 ? json({ diagnostic: { code: 'AB8204', message: 'close not yet accepted' } }, 409) : json({ closed: true });
      }
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const policy = runtime.currentDocumentPolicy('runtime-binding');

    await expect(runtime.closeRuntime('runtime-binding')).rejects.toMatchObject({ code: 'AB8204' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(policy);
    expect(isCurrentMcpAppDocumentPolicy(runtime, policy)).toBe(true);

    await expect(runtime.closeRuntime('runtime-binding')).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(isCurrentMcpAppDocumentPolicy(runtime, policy)).toBe(false);
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
  });

  it('keeps manual-close cleanup admitted after its matching runtime invalidation', async () => {
    const stream = new RuntimeEventSource();
    const firstClose = deferred<Response>();
    const failedClose = deferred<Response>();
    let closeAttempts = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') {
        closeAttempts += 1;
        if (closeAttempts === 1) return firstClose.promise;
        if (closeAttempts === 2) return failedClose.promise;
        return json({ closed: true });
      }
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    const revoked = (sequence: number) => stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: {
        details: { bindingId: 'runtime-binding', reason: 'manual-close', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' },
        mcpSessionId: 'runtime-session-a',
        mcpSessionRevision: 2,
        providerSessionId: 'provider-session-a',
        type: 'runtime.app.updated',
      },
      sequence,
      type: 'runtime.event',
    }, sequence);

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const first = runtime.closeRuntime('runtime-binding');
    await Promise.resolve();
    revoked(1);
    await flushEvents();
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    firstClose.resolve(json({ closed: true }));
    await expect(first).resolves.toBeUndefined();

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const failed = runtime.closeRuntime('runtime-binding');
    await Promise.resolve();
    revoked(2);
    await flushEvents();
    failedClose.resolve(json({ diagnostic: { code: 'AB8204', message: 'close pending' } }, 409));
    await expect(failed).rejects.toMatchObject({ code: 'AB8204' });
    await expect(runtime.closeRuntime('runtime-binding')).resolves.toBeUndefined();
    expect(closeAttempts).toBe(3);
    project.close();
  });

  it('settles a dispatched runtime close after its matching session restart revokes the binding', async () => {
    const stream = new RuntimeEventSource();
    const closeResponse = deferred<Response>();
    let closeAttempts = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') {
        closeAttempts += 1;
        return closeResponse.promise;
      }
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

    const closing = runtime.closeRuntime('runtime-binding');
    await Promise.resolve();
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }),
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    closeResponse.resolve(json({ diagnostic: { code: 'AB8022', message: 'Runtime MCP App preview was revoked.' } }, 410));

    await expect(closing).resolves.toBeUndefined();
    expect(closeAttempts).toBe(1);
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    project.close();
  });

  it('does not dispatch a held runtime close after its session restarts before authentication completes', async () => {
    const stream = new RuntimeEventSource();
    const bootstrap = deferred<Response>();
    const protectedPaths: string[] = [];
    let holdBootstrap = false;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') {
        return holdBootstrap
          ? bootstrap.promise
          : json({ cookieName: foregroundCookieName, instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      }
      if (path === '/api/project/status') return json(missingProjectStatusResponse);
      protectedPaths.push(path);
      if (path === '/api/runtime/apps' && init?.method === 'POST') return json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') {
        return json({ diagnostic: { code: 'AB8022', message: 'Runtime MCP App preview was revoked.' } }, 410);
      }
      throw new Error(`Unexpected request ${path}.`);
    };
    const foreground = new ForegroundRouteClient({ fetch: fetch as typeof globalThis.fetch });
    const project = new ProjectClient({ events: () => stream, foreground });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, foreground, projectClient: project });
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    protectedPaths.length = 0;
    foreground.forgetAuthentication();
    holdBootstrap = true;

    const closing = runtime.closeRuntime('runtime-binding');
    await Promise.resolve();
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }),
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    bootstrap.resolve(json({ cookieName: foregroundCookieName, instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' }));

    await expect(closing).resolves.toBeUndefined();
    expect(protectedPaths).toEqual([]);
    project.close();
  });

  it('retains a restarted dispatched runtime close for an ordinary 500 retry', async () => {
    const stream = new RuntimeEventSource();
    const firstClose = deferred<Response>();
    let closeAttempts = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') {
        closeAttempts += 1;
        return closeAttempts === 1
          ? firstClose.promise
          : json({ diagnostic: { code: 'AB8022', message: 'Runtime MCP App preview was revoked.' } }, 410);
      }
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

    const first = runtime.closeRuntime('runtime-binding');
    await Promise.resolve();
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }),
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    firstClose.resolve(json({ diagnostic: { code: 'AB7001', message: 'temporary close failure' } }, 500));
    await expect(first).rejects.toMatchObject({ code: 'AB7001' });

    await expect(runtime.closeRuntime('runtime-binding')).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    project.close();
  });

  it('fails closed when a runtime App invalidation envelope has mismatched or unexpected fields', async () => {
    const stream = new RuntimeEventSource();
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    const invalidation = { bindingId: 'runtime-binding', reason: 'manual-close', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' as const };

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: Object.freeze({ ...runtimeAppUpdated(invalidation), mcpSessionRevision: 3 }),
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-b' });
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:01.000Z',
      payload: Object.freeze({ ...runtimeAppUpdated(invalidation), unexpected: true }),
      sequence: 2,
      type: 'runtime.event',
    }, 2);
    await flushEvents();
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    project.close();
  });

  it('does not fence a new runtime preview when a late manual-close event revokes an absent binding', async () => {
    const stream = new RuntimeEventSource();
    const secondCreate = deferred<Response>();
    const secondCreateStarted = deferred<void>();
    const previewB = JSON.parse(JSON.stringify(runtimePreview)) as {
      binding: { id: string; sessionId: string };
      session: { binding: { sessionId: string } };
    };
    previewB.binding.id = 'runtime-binding-b';
    previewB.binding.sessionId = 'runtime-session-b';
    previewB.session.binding.sessionId = 'runtime-session-b';
    let creates = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
      if (String(input) === '/api/runtime/apps') {
        creates += 1;
        if (creates === 1) return json({ preview: runtimePreview });
        secondCreateStarted.resolve();
        return secondCreate.promise;
      }
      if (String(input) === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') return json({ closed: true });
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    await runtime.closeRuntime('runtime-binding');
    const createB = runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-b' });
    void createB.catch(() => undefined);
    await secondCreateStarted.promise;
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'manual-close', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }),
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    secondCreate.resolve(json({ preview: previewB }));

    await expect(createB).resolves.toMatchObject({ binding: { id: 'runtime-binding-b', sessionId: 'runtime-session-b' } });
    project.close();
  });

  it('rejects a created runtime preview when its exact binding is revoked while the response is pending', async () => {
    const stream = new RuntimeEventSource();
    const createResponse = deferred<Response>();
    const createStarted = deferred<void>();
    const previewB = JSON.parse(JSON.stringify(runtimePreview)) as {
      binding: { id: string; sessionId: string };
      session: { binding: { sessionId: string } };
    };
    previewB.binding.id = 'runtime-binding-b';
    previewB.binding.sessionId = 'runtime-session-b';
    previewB.session.binding.sessionId = 'runtime-session-b';
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
      if (String(input) === '/api/runtime/apps') {
        createStarted.resolve();
        return createResponse.promise;
      }
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    const createB = runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-b' });
    void createB.catch(() => undefined);
    await createStarted.promise;
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z',
      payload: runtimeAppUpdated({ bindingId: 'runtime-binding-b', reason: 'manual-close', sessionId: 'runtime-session-b', sessionRevision: 2, state: 'revoked' }),
      sequence: 1,
      type: 'runtime.event',
    }, 1);
    await flushEvents();
    createResponse.resolve(json({ preview: previewB }));

    await expect(createB).rejects.toMatchObject({ code: 'AB8015' });
    expect(() => runtime.currentDocumentPolicy('runtime-binding-b')).toThrow('Runtime MCP App document policy is not available.');
    project.close();
  });

  it('accepts newer public operation vectors only for the bound stable session', async () => {
    let operation: unknown = {
      operationId: 'operation-newer', sessionId: 'runtime-session-a', sessionRevision: 2, value: { tools: [] },
      vector: { runtimeGenerationId: 'generation-b', sourceRevision: 'source-b', stateVersion: 3 },
    };
    let previewPayload: unknown = (() => {
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      copy.operations = [{
        kind: 'tools/list', operationId: 'trace-newer', sessionId: 'runtime-session-a', sessionRevision: 2,
        vector: { runtimeGenerationId: 'generation-b', sourceRevision: 'source-b', stateVersion: 3 },
      }];
      return copy;
    })();
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: previewPayload });
      if (String(input) === '/api/runtime/apps/runtime-binding/operations') return json({ result: operation });
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    const preview = await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    expect(preview.operations).toMatchObject([{ sessionId: 'runtime-session-a', sessionRevision: 2, vector: { runtimeGenerationId: 'generation-b', sourceRevision: 'source-b', stateVersion: 3 } }]);
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).resolves.toMatchObject({ vector: { runtimeGenerationId: 'generation-b', sourceRevision: 'source-b', stateVersion: 3 } });

    for (const mismatch of [
      { ...operation as Record<string, unknown>, sessionId: 'runtime-session-other' },
      { ...operation as Record<string, unknown>, sessionRevision: 3 },
    ]) {
      operation = mismatch;
      await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).rejects.toMatchObject({ code: 'AB8019' });
    }

    const malformedTrace = JSON.parse(JSON.stringify(previewPayload)) as Record<string, unknown>;
    ((malformedTrace.operations as Record<string, unknown>[])[0]!).sessionRevision = 3;
    previewPayload = malformedTrace;
    await expect(new McpAppClient({ fetch: fetch as typeof globalThis.fetch }).createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });
  });

  it('caps streamed runtime App operation results before finite JSON admission', async () => {
    const maximumBytes = runtimeAppMessageLimits.hostToAppBytes;
    const operationFor = (text: string) => ({
      result: {
        operationId: 'operation-bounded',
        sessionId: 'runtime-session-a',
        sessionRevision: 2,
        value: { content: [{ text, type: 'text' }] },
        vector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 },
      },
    });
    const bodyFor = (text: string): string => JSON.stringify(operationFor(text));
    const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
    const fixedBytes = utf8Bytes(bodyFor(''));
    const exactBody = bodyFor('x'.repeat(maximumBytes - fixedBytes));
    const underBody = bodyFor('x'.repeat(maximumBytes - fixedBytes - 1));
    const multibyteBody = bodyFor('é'.repeat(Math.floor((maximumBytes - fixedBytes - 1) / 2)));
    expect(utf8Bytes(exactBody)).toBe(maximumBytes);
    expect(utf8Bytes(underBody)).toBe(maximumBytes - 1);
    expect(utf8Bytes(multibyteBody)).toBeLessThanOrEqual(maximumBytes);
    expect(utf8Bytes(multibyteBody)).toBeGreaterThan(maximumBytes - 3);

    let operationResponse: Response = streamedResponse(underBody, { 'content-length': String(utf8Bytes(underBody)) }, 3);
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding/operations') return operationResponse;
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).resolves.toMatchObject({ operationId: 'operation-bounded' });
    operationResponse = streamedResponse(exactBody, { 'content-length': String(maximumBytes) }, 7);
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).resolves.toMatchObject({ operationId: 'operation-bounded' });
    operationResponse = streamedResponse(multibyteBody, { 'content-length': String(utf8Bytes(multibyteBody)) }, 5);
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).resolves.toMatchObject({ operationId: 'operation-bounded' });

    operationResponse = new Response('{}', { headers: { 'content-length': String(maximumBytes + 1) }, status: 200 });
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).rejects.toMatchObject({ code: 'AB8019' });
    operationResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maximumBytes));
        controller.enqueue(Uint8Array.of(0));
        controller.close();
      },
    }), { headers: { 'content-type': 'application/json' }, status: 200 });
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).rejects.toMatchObject({ code: 'AB8019' });

    let deep: unknown = true;
    for (let depth = 0; depth < 33; depth += 1) deep = { nested: deep };
    operationResponse = streamedResponse(JSON.stringify({
      result: {
        operationId: 'operation-deep', sessionId: 'runtime-session-a', sessionRevision: 2, value: deep,
        vector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 },
      },
    }));
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).rejects.toMatchObject({ code: 'AB8019' });
    operationResponse = streamedResponse(JSON.stringify({
      result: {
        operationId: 'operation-nodes', sessionId: 'runtime-session-a', sessionRevision: 2,
        value: { values: Array.from({ length: 4_097 }, () => true) },
        vector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 },
      },
    }));
    await expect(runtime.operateRuntime('runtime-binding', { kind: 'tools/list' })).rejects.toMatchObject({ code: 'AB8019' });
  });

  it('keeps the prior policy current when a consent success has an invalid sibling or route identity', async () => {
    const approvedPolicy = Object.freeze({ allow: 'camera', approvedPermissions: Object.freeze({ camera: Object.freeze({}) }), revision: 2, warnings: Object.freeze([]) });
    const runtimeFor = (created: unknown, decided: unknown): McpAppClient => new McpAppClient({ fetch: (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding/consents') return json(created);
      if (String(input) === '/api/runtime/apps/runtime-binding/consents/consent-a') return json(decided);
      throw new Error(`Unexpected request ${String(input)}.`);
    }) as typeof globalThis.fetch });
    const consent = { actionFingerprint: 'fingerprint-a', capability: 'camera' as const, details: {}, scope: 'document' as const, summary: 'Use camera' };
    const malformedChallenge = { challenge: { expiresAt: 31_000, id: 'consent-a', request: { actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document' } }, documentPolicy: approvedPolicy };
    const validChallenge = { challenge: { expiresAt: 31_000, id: 'consent-a', request: consent }, documentPolicy: runtimePolicy };

    const malformedCreate = runtimeFor(malformedChallenge, { documentPolicy: runtimePolicy });
    await malformedCreate.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const initial = malformedCreate.currentDocumentPolicy('runtime-binding');
    await expect(malformedCreate.createRuntimeConsent('runtime-binding', consent)).rejects.toMatchObject({ code: 'AB8019' });
    expect(malformedCreate.currentDocumentPolicy('runtime-binding')).toBe(initial);
    expect(isCurrentMcpAppDocumentPolicy(malformedCreate, initial)).toBe(true);

    for (const [decision, response] of [
      ['allow-once', { documentPolicy: approvedPolicy, grant: { authorizationId: 'authorization-a', bindingId: 'runtime-binding', capability: 'camera', challengeId: 'consent-other', scope: 'document' } }],
      ['deny', { documentPolicy: approvedPolicy, grant: { authorizationId: 'authorization-a', bindingId: 'runtime-binding', capability: 'camera', challengeId: 'consent-a', scope: 'document' } }],
    ] as const) {
      const runtime = runtimeFor(validChallenge, response);
      await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
      const policy = runtime.currentDocumentPolicy('runtime-binding');
      await runtime.createRuntimeConsent('runtime-binding', consent);
      await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-a', decision)).rejects.toMatchObject({ code: 'AB8019' });
      expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(policy);
      expect(isCurrentMcpAppDocumentPolicy(runtime, policy)).toBe(true);
    }
  });

  it('admits document policies only when allow and approved permissions match the bound resource', async () => {
    const invalidPreview = new McpAppClient({ fetch: (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      copy.documentPolicy = { allow: 'camera; microphone', approvedPermissions: { camera: {} }, revision: 2, warnings: [] };
      return json({ preview: copy });
    }) as typeof globalThis.fetch });
    await expect(invalidPreview.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });

    const invalidConsent = new McpAppClient({ fetch: (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding/consents') return json({
        challenge: { expiresAt: 31_000, id: 'consent-a', request: { actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera' } },
        documentPolicy: { allow: 'camera; microphone', approvedPermissions: { camera: {}, microphone: {} }, revision: 2, warnings: [] },
      });
      throw new Error(`Unexpected request ${String(input)}.`);
    }) as typeof globalThis.fetch });
    await invalidConsent.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const current = invalidConsent.currentDocumentPolicy('runtime-binding');
    await expect(invalidConsent.createRuntimeConsent('runtime-binding', {
      actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera',
    })).rejects.toMatchObject({ code: 'AB8019' });
    expect(invalidConsent.currentDocumentPolicy('runtime-binding')).toBe(current);
  });

  it('keeps the higher current policy when overlapping consent responses settle out of revision order', async () => {
    const lowerResponse = deferred<Response>();
    const higherResponse = deferred<Response>();
    const challenges = [
      { expiresAt: 31_000, id: 'consent-camera', request: { actionFingerprint: 'act-camera', capability: 'camera', details: {}, scope: 'document', summary: 'Allow camera?' } },
      { expiresAt: 31_000, id: 'consent-low', request: { actionFingerprint: 'act-low', capability: 'geolocation', details: {}, scope: 'document', summary: 'Allow geolocation?' } },
      { expiresAt: 31_000, id: 'consent-high', request: { actionFingerprint: 'act-high', capability: 'geolocation', details: {}, scope: 'document', summary: 'Allow geolocation?' } },
    ];
    let consentCalls = 0;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (path === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding/consents') return json({ challenge: challenges[consentCalls++]!, documentPolicy: consentCalls === 1 ? runtimePolicy : { allow: 'camera', approvedPermissions: { camera: {} }, revision: 2, warnings: [] } });
      if (path.endsWith('/consent-camera')) return json({ documentPolicy: { allow: 'camera', approvedPermissions: { camera: {} }, revision: 2, warnings: [] }, grant: { authorizationId: 'authorization-camera', bindingId: 'runtime-binding', capability: 'camera', challengeId: 'consent-camera', scope: 'document' } });
      if (path.endsWith('/consent-low')) return lowerResponse.promise;
      if (path.endsWith('/consent-high')) return higherResponse.promise;
      throw new Error(`Unexpected request ${path}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    const camera = { actionFingerprint: 'fingerprint-a', capability: 'camera' as const, details: {}, scope: 'document' as const, summary: 'Use camera' };
    const geolocation = { actionFingerprint: 'fingerprint-b', capability: 'geolocation' as const, details: {}, scope: 'document' as const, summary: 'Use location' };
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    await runtime.createRuntimeConsent('runtime-binding', camera);
    await runtime.decideRuntimeConsent('runtime-binding', 'consent-camera', 'allow-once');
    await runtime.createRuntimeConsent('runtime-binding', geolocation);
    await runtime.createRuntimeConsent('runtime-binding', geolocation);
    const lower = runtime.decideRuntimeConsent('runtime-binding', 'consent-low', 'allow-once');
    const higher = runtime.decideRuntimeConsent('runtime-binding', 'consent-high', 'allow-once');
    await Promise.resolve();
    higherResponse.resolve(json({ documentPolicy: { allow: 'camera; geolocation', approvedPermissions: { camera: {}, geolocation: {} }, revision: 3, warnings: [] }, grant: { authorizationId: 'authorization-high', bindingId: 'runtime-binding', capability: 'geolocation', challengeId: 'consent-high', scope: 'document' } }));
    await expect(higher).resolves.toMatchObject({ documentPolicy: { revision: 3 } });
    const current = runtime.currentDocumentPolicy('runtime-binding');
    lowerResponse.resolve(json({ documentPolicy: { allow: 'camera', approvedPermissions: { camera: {} }, revision: 2, warnings: [] }, grant: { authorizationId: 'authorization-low', bindingId: 'runtime-binding', capability: 'geolocation', challengeId: 'consent-low', scope: 'document' } }));
    await expect(lower).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(current);
    expect(current.snapshot.revision).toBe(3);
    expect(isCurrentMcpAppDocumentPolicy(runtime, current)).toBe(true);
  });

  it('reuses only semantic same-revision document policies', async () => {
    let responsePolicy: unknown = { allow: 'camera', approvedPermissions: { camera: {} }, revision: 2, warnings: [] };
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding') {
        const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
        copy.documentPolicy = responsePolicy;
        return json({ preview: copy });
      }
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

    await runtime.getRuntime('runtime-binding');
    const current = runtime.currentDocumentPolicy('runtime-binding');
    await runtime.getRuntime('runtime-binding');
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(current);

    for (const changed of [
      { allow: 'camera ', approvedPermissions: { camera: {} }, revision: 2, warnings: [] },
      { allow: 'camera; geolocation', approvedPermissions: { camera: {}, geolocation: {} }, revision: 2, warnings: [] },
      { allow: 'camera', approvedPermissions: { camera: {} }, revision: 2, warnings: [{ code: 'permission-not-consented', value: 'camera' }] },
    ]) {
      responsePolicy = changed;
      await expect(runtime.getRuntime('runtime-binding')).rejects.toMatchObject({ code: 'AB8019' });
      expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(current);
      expect(isCurrentMcpAppDocumentPolicy(runtime, current)).toBe(true);
    }
  });

  it('reuses an already-approved document consent only at its current policy revision', async () => {
    const previewWithPolicy = (documentPolicy: unknown): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      copy.documentPolicy = documentPolicy;
      return copy;
    };
    const policy = (revision: number) => ({ allow: 'camera', approvedPermissions: { camera: {} }, revision, warnings: [] });
    const challenge = (id: string) => ({
      expiresAt: 31_000,
      id,
      request: {
        actionFingerprint: `act-${id}`,
        capability: 'camera',
        details: { resourceUri: 'ui://weather/app.html' },
        scope: 'document',
        summary: 'Allow MCP App weather to use camera?',
      },
    });
    const grant = (id: string) => ({
      authorizationId: `authorization-${id}`,
      bindingId: 'runtime-binding',
      capability: 'camera',
      challengeId: id,
      scope: 'document',
    });
    let consentResponse: unknown;
    let decisionResponse: unknown;
    let getResponsePolicy: unknown = runtimePolicy;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (path === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding') return json({ preview: previewWithPolicy(getResponsePolicy) });
      if (path === '/api/runtime/apps/runtime-binding/consents') return json(consentResponse);
      if (path.startsWith('/api/runtime/apps/runtime-binding/consents/')) return json(decisionResponse);
      throw new Error(`Unexpected request ${path}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    const cameraRequest = {
      actionFingerprint: 'browser-camera',
      capability: 'camera' as const,
      details: {},
      scope: 'document' as const,
      summary: 'Use local camera',
    };
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

    consentResponse = { challenge: challenge('consent-camera-first'), documentPolicy: runtimePolicy };
    await runtime.createRuntimeConsent('runtime-binding', cameraRequest);
    decisionResponse = { documentPolicy: policy(2), grant: grant('consent-camera-first') };
    await runtime.decideRuntimeConsent('runtime-binding', 'consent-camera-first', 'allow-once');
    const cameraPolicy = runtime.currentDocumentPolicy('runtime-binding');

    consentResponse = { challenge: challenge('consent-camera-repeat'), documentPolicy: policy(2) };
    await runtime.createRuntimeConsent('runtime-binding', cameraRequest);
    decisionResponse = { documentPolicy: policy(2), grant: grant('consent-camera-repeat') };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-camera-repeat', 'allow-once')).resolves.toMatchObject({ documentPolicy: { revision: 2 } });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    consentResponse = { challenge: challenge('consent-camera-malformed'), documentPolicy: policy(2) };
    await runtime.createRuntimeConsent('runtime-binding', cameraRequest);
    decisionResponse = { documentPolicy: policy(3), grant: grant('consent-camera-malformed') };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-camera-malformed', 'allow-once')).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    getResponsePolicy = policy(2);
    await runtime.getRuntime('runtime-binding');
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);
  });

  it('binds document-policy transitions to stored canonical runtime consents', async () => {
    const previewWithPolicy = (documentPolicy: unknown): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      copy.documentPolicy = documentPolicy;
      return copy;
    };
    for (const policy of [
      { allow: '', approvedPermissions: {}, revision: 2, warnings: [] },
      { allow: 'camera', approvedPermissions: { camera: {} }, revision: 1, warnings: [] },
      { allow: 'camera', approvedPermissions: {}, revision: 1, warnings: [] },
    ]) {
      const invalid = new McpAppClient({ fetch: (async (input: string | URL | Request) => {
        if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
        return json({ preview: previewWithPolicy(policy) });
      }) as typeof globalThis.fetch });
      await expect(invalid.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });
    }

    const cameraRequest = { actionFingerprint: 'browser-fingerprint', capability: 'camera' as const, details: { privateCandidate: true }, scope: 'document' as const, summary: 'Use local camera' };
    const actionRequest = { actionFingerprint: 'browser-action', capability: 'call-tool' as const, details: { name: 'forecast' }, scope: 'action' as const, summary: 'Call forecast' };
    let consentResponse: unknown;
    let decisionResponse: unknown;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (String(input) === '/api/runtime/apps/runtime-binding/consents') return json(consentResponse);
      if (String(input).startsWith('/api/runtime/apps/runtime-binding/consents/')) return json(decisionResponse);
      throw new Error(`Unexpected request ${String(input)}.`);
    };
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    const challenge = (id: string, capability: 'camera' | 'call-tool' | 'geolocation', scope: 'action' | 'document') => ({
      expiresAt: 31_000,
      id,
      request: { actionFingerprint: `act-${id}`, capability, details: { resourceUri: 'ui://weather/app.html' }, scope, summary: `Allow MCP App weather to use ${capability}?` },
    });
    const policy = (revision: number, approvedPermissions: Record<string, unknown>) => ({
      allow: Object.keys(approvedPermissions).map((key) => ({ camera: 'camera', geolocation: 'geolocation' } as Record<string, string>)[key]!).join('; '),
      approvedPermissions,
      revision,
      warnings: [],
    });

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const initial = runtime.currentDocumentPolicy('runtime-binding');
    consentResponse = { challenge: challenge('consent-camera', 'camera', 'document'), documentPolicy: runtimePolicy };
    await expect(runtime.createRuntimeConsent('runtime-binding', cameraRequest)).resolves.toMatchObject({ challenge: { id: 'consent-camera', request: { actionFingerprint: 'act-consent-camera', details: { resourceUri: 'ui://weather/app.html' } } } });
    decisionResponse = {
      documentPolicy: policy(2, { camera: {} }),
      grant: { authorizationId: 'authorization-camera', bindingId: 'runtime-binding', capability: 'camera', challengeId: 'consent-camera', scope: 'document' },
    };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-camera', 'allow-once')).resolves.toMatchObject({ documentPolicy: { revision: 2 } });
    const cameraPolicy = runtime.currentDocumentPolicy('runtime-binding');
    expect(cameraPolicy).not.toBe(initial);
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-camera', 'allow-once')).rejects.toMatchObject({ code: 'AB8015' });

    consentResponse = { challenge: challenge('consent-deny', 'camera', 'document'), documentPolicy: policy(2, { camera: {} }) };
    await runtime.createRuntimeConsent('runtime-binding', cameraRequest);
    decisionResponse = { documentPolicy: policy(3, { camera: {}, geolocation: {} }) };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-deny', 'deny')).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    consentResponse = { challenge: challenge('consent-action', 'call-tool', 'action'), documentPolicy: policy(2, { camera: {} }) };
    await runtime.createRuntimeConsent('runtime-binding', actionRequest);
    decisionResponse = {
      documentPolicy: policy(3, { camera: {}, geolocation: {} }),
      grant: { authorizationId: 'authorization-action', bindingId: 'runtime-binding', capability: 'call-tool', challengeId: 'consent-action', scope: 'action' },
    };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-action', 'allow-once')).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    consentResponse = { challenge: challenge('consent-invalid-scope', 'camera', 'action'), documentPolicy: policy(2, { camera: {} }) };
    await expect(runtime.createRuntimeConsent('runtime-binding', cameraRequest)).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    consentResponse = { challenge: challenge('consent-mismatch', 'camera', 'document'), documentPolicy: policy(2, { camera: {} }) };
    await runtime.createRuntimeConsent('runtime-binding', cameraRequest);
    decisionResponse = {
      documentPolicy: policy(3, { camera: {}, geolocation: {} }),
      grant: { authorizationId: 'authorization-mismatch', bindingId: 'runtime-binding', capability: 'geolocation', challengeId: 'consent-mismatch', scope: 'document' },
    };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-mismatch', 'allow-once')).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    consentResponse = { challenge: challenge('consent-no-change', 'geolocation', 'document'), documentPolicy: policy(2, { camera: {} }) };
    await runtime.createRuntimeConsent('runtime-binding', { ...cameraRequest, capability: 'geolocation', summary: 'Use local location' });
    decisionResponse = {
      documentPolicy: policy(2, { camera: {} }),
      grant: { authorizationId: 'authorization-no-change', bindingId: 'runtime-binding', capability: 'geolocation', challengeId: 'consent-no-change', scope: 'document' },
    };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-no-change', 'allow-once')).rejects.toMatchObject({ code: 'AB8019' });
    expect(runtime.currentDocumentPolicy('runtime-binding')).toBe(cameraPolicy);

    consentResponse = { challenge: challenge('consent-geolocation', 'geolocation', 'document'), documentPolicy: policy(2, { camera: {} }) };
    await runtime.createRuntimeConsent('runtime-binding', { ...cameraRequest, capability: 'geolocation', summary: 'Use local location' });
    decisionResponse = {
      documentPolicy: policy(3, { camera: {}, geolocation: {} }),
      grant: { authorizationId: 'authorization-geolocation', bindingId: 'runtime-binding', capability: 'geolocation', challengeId: 'consent-geolocation', scope: 'document' },
    };
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-geolocation', 'allow-once')).resolves.toMatchObject({ documentPolicy: { revision: 3 } });
  });

  it('fences every runtime route before dispatch when bootstrap authority becomes stale', async () => {
    const stream = new RuntimeEventSource();
    let bootstrap: Deferred<Response> | undefined;
    const protectedPaths: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') return bootstrap?.promise ?? json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (path === '/api/project/status') return json(missingProjectStatusResponse);
      protectedPaths.push(path);
      if (path === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding') return init?.method === 'DELETE' ? json({ closed: true }) : json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding/operations') return json({ result: { operationId: 'operation-a', sessionId: 'runtime-session-a', sessionRevision: 2, value: {}, vector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 } } });
      if (path === '/api/runtime/apps/runtime-binding/consents') return json({ challenge: { expiresAt: 31_000, id: 'consent-a', request: { actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera' } }, documentPolicy: runtimePolicy });
      if (path === '/api/runtime/apps/runtime-binding/consents/consent-a') return json({ documentPolicy: runtimePolicy });
      throw new Error(`Unexpected request ${path}.`);
    };
    const foreground = new ForegroundRouteClient({ fetch: withCanonicalForegroundSession(fetch as typeof globalThis.fetch) });
    const project = new ProjectClient({ events: () => stream, foreground });
    await project.connect(() => undefined);
    const request = { actionFingerprint: 'fingerprint-a', capability: 'camera' as const, details: {}, scope: 'document' as const, summary: 'Use camera' };
    let sequence = 0;
    const exactInvalidation = async (): Promise<void> => {
      sequence += 1;
      stream.emit('runtime.event', {
        occurredAt: '2026-08-16T00:00:00.000Z',
        payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }),
        sequence,
        type: 'runtime.event',
      }, sequence);
      await flushEvents();
    };
    const gap = async (): Promise<void> => {
      sequence += 1;
      stream.emit('replay.gap', { earliestAvailableSequence: sequence + 1, latestDroppedSequence: sequence, requestedAfterSequence: sequence - 1, type: 'replay.gap' }, '');
      await flushEvents();
    };
    const seed = async (challenge = false): Promise<McpAppClient> => {
      bootstrap = undefined;
      const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, foreground, projectClient: project });
      await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
      if (challenge) await runtime.createRuntimeConsent('runtime-binding', request);
      foreground.forgetAuthentication();
      return runtime;
    };
    const fence = async (runtime: McpAppClient, work: () => Promise<unknown>, invalidate: () => void | Promise<void>): Promise<void> => {
      protectedPaths.length = 0;
      bootstrap = deferred<Response>();
      const pending = work();
      void pending.catch(() => undefined);
      await Promise.resolve();
      await invalidate();
      bootstrap.resolve(json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' }));
      await expect(pending).rejects.toMatchObject({ code: 'AB8015' });
      expect(protectedPaths).toEqual([]);
      bootstrap = undefined;
    };

    const creating = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, foreground, projectClient: project });
    await fence(creating, () => creating.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' }), () => creating.disposeRuntime());
    const getting = await seed();
    await fence(getting, () => getting.getRuntime('runtime-binding'), () => gap());
    const operating = await seed();
    await fence(operating, () => operating.operateRuntime('runtime-binding', { kind: 'tools/list' }), () => exactInvalidation());
    const consenting = await seed();
    await fence(consenting, () => consenting.createRuntimeConsent('runtime-binding', request), () => consenting.disposeRuntime());
    const deciding = await seed(true);
    await fence(deciding, () => deciding.decideRuntimeConsent('runtime-binding', 'consent-a', 'deny'), () => gap());
    const closing = await seed();
    await fence(closing, () => closing.closeRuntime('runtime-binding'), () => closing.disposeRuntime());
    project.close();
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

    const mismatchedGeneration = new McpAppClient({ fetch: malformed((preview) => {
      ((preview.binding as Record<string, unknown>).runVector as Record<string, unknown>).runtimeGenerationId = 'generation-other';
    }) });
    await expect(mismatchedGeneration.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });

    const mismatchedProfile = new McpAppClient({ fetch: malformed((preview) => {
      const binding = preview.binding as Record<string, unknown>;
      binding.profileId = 'chatgpt';
      binding.profileVersion = 'agent-bundle:chatgpt-sim:1';
      const profile = preview.profile as Record<string, unknown>;
      profile.descriptor = { claimsRealHostParity: false, evidence: 'simulated', id: 'chatgpt', label: 'ChatGPT Simulation', version: 'agent-bundle:chatgpt-sim:1' };
    }) });
    await expect(mismatchedProfile.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toMatchObject({ code: 'AB8019' });
  });

  it('admits only canonical closed-registry configuration inspection rows', async () => {
    const previewWithEntries = (entries: readonly unknown[]): typeof globalThis.fetch => (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      ((copy.profile as Record<string, unknown>).configExtensions as Record<string, unknown>).entries = entries;
      return json({ preview: copy });
    }) as typeof globalThis.fetch;
    const entry = (key: 'portable' | 'codex' | 'claude', sourcePath: string): Record<string, unknown> => ({
      configured: true, id: `extension:${key}`, key, provenance: { kind: 'config', sourcePath }, target: key,
    });
    const request = { expectedGenerationId: 'generation-a', profileId: 'portable' as const, runId: 'run-a' };

    await expect(new McpAppClient({ fetch: previewWithEntries([
      entry('portable', 'agent-bundle.config.ts'), entry('codex', 'config/codex.ts'), entry('claude', '<external-config>'),
    ]) }).createRuntime(request)).resolves.toMatchObject({ binding: { id: 'runtime-binding' } });

    for (const entries of [
      [{ configured: true, id: 'extension:openai', key: 'openai', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'openai' }],
      [entry('codex', 'agent-bundle.config.ts'), entry('codex', 'config/codex.ts')],
      [entry('codex', '../agent-bundle.config.ts')], [entry('codex', './agent-bundle.config.ts')],
      [entry('codex', 'config\\codex.ts')], [entry('codex', 'file:///agent-bundle.config.ts')],
    ]) {
      await expect(new McpAppClient({ fetch: previewWithEntries(entries) }).createRuntime(request)).rejects.toMatchObject({ code: 'AB8019' });
    }
  });

  it('preserves independent bounded configuration provenance revisions without weakening the closed registry', async () => {
    const previewWithConfigSource = (sourceRevision: unknown): typeof globalThis.fetch => (async (input: string | URL | Request) => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      const copy = JSON.parse(JSON.stringify(runtimePreview)) as Record<string, unknown>;
      ((copy.profile as Record<string, unknown>).configExtensions as Record<string, unknown>).sourceRevision = sourceRevision;
      return json({ preview: copy });
    }) as typeof globalThis.fetch;
    const runtimeRequest = { expectedGenerationId: 'generation-a', profileId: 'portable' as const, runId: 'run-a' };

    await expect(new McpAppClient({ fetch: previewWithConfigSource('source-project-config-b') }).createRuntime(runtimeRequest))
      .resolves.toMatchObject({ profile: { configExtensions: { sourceRevision: 'source-project-config-b' } } });

    for (const sourceRevision of ['', 'source\0project', null, 42]) {
      await expect(new McpAppClient({ fetch: previewWithConfigSource(sourceRevision) }).createRuntime(runtimeRequest))
        .rejects.toMatchObject({ code: 'AB8019' });
    }
  });

  it('uses a connected ProjectClient for exact runtime invalidations and revokes stale policy handles', async () => {
    const stream = new RuntimeEventSource();
    let streamCount = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (String(input) === '/api/project/status') return json(missingProjectStatusResponse);
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
      payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }),
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
    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const malformedPolicy = runtime.currentDocumentPolicy('runtime-binding');
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:01.000Z', payload: 'not-a-runtime-event', sequence: 4, type: 'runtime.event',
    }, 4);
    await flushEvents();
    expect(isCurrentMcpAppDocumentPolicy(runtime, malformedPolicy)).toBe(false);
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    unsubscribe();
    project.close();
  });

  it('invalidates runtime authority nonterminally for a replacement foreground instance', async () => {
    let projectListener: Parameters<ProjectClient['subscribeEvents']>[0] | undefined;
    const projectEvents: Pick<ProjectClient, 'subscribeEvents'> = {
      subscribeEvents(listener) {
        projectListener = listener;
        return () => {
          if (projectListener === listener) projectListener = undefined;
        };
      },
    };
    const heldGet = deferred<Response>();
    const heldClose = deferred<Response>();
    let getRequests = 0;
    let closeRequests = 0;
    let consentDecisions = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') {
        return json({
          cookieName: foregroundCookieName,
          instanceId: 'foreground-instance-a',
          origin: 'http://127.0.0.1:43123',
          token: 'foreground-secret',
        });
      }
      if (path === '/api/runtime/apps') return json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') {
        closeRequests += 1;
        return heldClose.promise;
      }
      if (path === '/api/runtime/apps/runtime-binding') {
        getRequests += 1;
        return heldGet.promise;
      }
      if (path === '/api/runtime/apps/runtime-binding/consents') {
        return json({
          challenge: {
            expiresAt: 31_000,
            id: 'consent-before-replacement',
            request: {
              actionFingerprint: 'fingerprint-a',
              capability: 'camera',
              details: {},
              scope: 'document',
              summary: 'Use camera',
            },
          },
          documentPolicy: runtimePolicy,
        });
      }
      if (path === '/api/runtime/apps/runtime-binding/consents/consent-before-replacement') {
        consentDecisions += 1;
        return json({ documentPolicy: runtimePolicy });
      }
      throw new Error(`Unexpected request ${path}.`);
    };
    const foreground = new ForegroundRouteClient({ fetch: fetch as typeof globalThis.fetch });
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, foreground, projectClient: projectEvents });
    const invalidations: unknown[] = [];
    runtime.subscribeInvalidations((details) => invalidations.push(details));

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const stalePolicy = runtime.currentDocumentPolicy('runtime-binding');
    await runtime.createRuntimeConsent('runtime-binding', {
      actionFingerprint: 'fingerprint-a',
      capability: 'camera',
      details: {},
      scope: 'document',
      summary: 'Use camera',
    });
    projectListener?.({
      occurredAt: '2026-08-19T10:00:00.000Z',
      payload: runtimeAppUpdated({
        bindingId: 'foreign-binding',
        reason: 'session-restarted',
        sessionId: 'foreign-session',
        sessionRevision: 1,
        state: 'revoked',
      }),
      sequence: 20,
      type: 'runtime.event',
    });
    const staleGet = runtime.getRuntime('runtime-binding');
    const staleClose = runtime.closeRuntime('runtime-binding');
    void staleGet.catch(() => undefined);
    void staleClose.catch(() => undefined);
    await eventually(() => getRequests === 1 && closeRequests === 1);

    runtime.resetRuntimeForForegroundReplacement();

    expect(isCurrentMcpAppDocumentPolicy(runtime, stalePolicy)).toBe(false);
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    heldGet.resolve(json({ preview: runtimePreview }));
    heldClose.resolve(json({ closed: true }));
    await expect(staleGet).rejects.toMatchObject({ code: 'AB8015' });
    await expect(staleClose).rejects.toMatchObject({ code: 'AB8015' });

    await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-b' });
    await expect(runtime.decideRuntimeConsent('runtime-binding', 'consent-before-replacement', 'deny'))
      .rejects.toMatchObject({ code: 'AB8015' });
    expect(consentDecisions).toBe(0);
    projectListener?.({
      occurredAt: '2026-08-19T10:00:01.000Z',
      payload: runtimeAppUpdated({
        bindingId: 'runtime-binding',
        reason: 'session-restarted',
        sessionId: 'runtime-session-a',
        sessionRevision: 2,
        state: 'revoked',
      }),
      sequence: 1,
      type: 'runtime.event',
    });
    expect(invalidations).toHaveLength(2);
    expect(() => runtime.currentDocumentPolicy('runtime-binding')).toThrow('Runtime MCP App document policy is not available.');
    await expect(runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-c' }))
      .resolves.toMatchObject({ binding: { id: 'runtime-binding' } });
    runtime.disposeRuntime();
  });

  it('rejects every late runtime response after its authority is invalidated or disposed', async () => {
    const stream = new RuntimeEventSource();
    let mode: 'create' | 'get' | 'consent' | 'decision' | 'ready' = 'ready';
    let pending: Deferred<Response> | undefined;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (path === '/api/project/status') return json(missingProjectStatusResponse);
      if (path === '/api/runtime/apps') return mode === 'create' ? pending!.promise : json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') return json({ closed: true });
      if (path === '/api/runtime/apps/runtime-binding') return mode === 'get' ? pending!.promise : json({ preview: runtimePreview });
      if (path === '/api/runtime/apps/runtime-binding/consents') return mode === 'consent' ? pending!.promise : json({
        challenge: { expiresAt: 31_000, id: 'consent-a', request: { actionFingerprint: 'fingerprint-a', capability: 'camera', details: {}, scope: 'document', summary: 'Use camera' } },
        documentPolicy: runtimePolicy,
      });
      if (path === '/api/runtime/apps/runtime-binding/consents/consent-a') return mode === 'decision' ? pending!.promise : json({ documentPolicy: runtimePolicy });
      throw new Error(`Unexpected request ${path}.`);
    };
    const project = new ProjectClient({ events: () => stream, fetch: fetch as typeof globalThis.fetch });
    await project.connect(() => undefined);
    const runtime = new McpAppClient({ fetch: fetch as typeof globalThis.fetch, projectClient: project });
    const create = () => runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
    const consent = { actionFingerprint: 'fingerprint-a', capability: 'camera' as const, details: {}, scope: 'document' as const, summary: 'Use camera' };

    mode = 'create'; pending = deferred<Response>();
    const lateCreate = create();
    void lateCreate.catch(() => undefined);
    await Promise.resolve();
    stream.emit('replay.gap', { earliestAvailableSequence: 2, latestDroppedSequence: 1, requestedAfterSequence: 0, type: 'replay.gap' }, '');
    pending.resolve(json({ preview: runtimePreview }));
    await expect(lateCreate).rejects.toMatchObject({ code: 'AB8015' });

    mode = 'ready'; await create();
    mode = 'get'; pending = deferred<Response>();
    const lateGet = runtime.getRuntime('runtime-binding');
    void lateGet.catch(() => undefined);
    await Promise.resolve();
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:00.000Z', payload: runtimeAppUpdated({ bindingId: 'runtime-binding', reason: 'session-restarted', sessionId: 'runtime-session-a', sessionRevision: 2, state: 'revoked' }), sequence: 2, type: 'runtime.event',
    }, 2);
    await flushEvents();
    pending.resolve(json({ preview: runtimePreview }));
    await expect(lateGet).rejects.toMatchObject({ code: 'AB8015' });

    mode = 'ready'; await create();
    mode = 'consent'; pending = deferred<Response>();
    const lateConsent = runtime.createRuntimeConsent('runtime-binding', consent);
    void lateConsent.catch(() => undefined);
    await Promise.resolve();
    stream.emit('runtime.event', {
      occurredAt: '2026-08-16T00:00:01.000Z', payload: { type: 'runtime.app.updated', extra: true }, sequence: 3, type: 'runtime.event',
    }, 3);
    await flushEvents();
    pending.resolve(json({ challenge: { expiresAt: 31_000, id: 'consent-a', request: consent }, documentPolicy: runtimePolicy }));
    await expect(lateConsent).rejects.toMatchObject({ code: 'AB8015' });

    mode = 'ready'; await create();
    mode = 'decision'; pending = deferred<Response>();
    const lateDecision = runtime.decideRuntimeConsent('runtime-binding', 'consent-a', 'allow-once');
    void lateDecision.catch(() => undefined);
    await Promise.resolve();
    await runtime.closeRuntime('runtime-binding');
    pending.resolve(json({ documentPolicy: runtimePolicy }));
    await expect(lateDecision).rejects.toMatchObject({ code: 'AB8015' });

    mode = 'create'; pending = deferred<Response>();
    const disposedCreate = create();
    void disposedCreate.catch(() => undefined);
    await Promise.resolve();
    runtime.disposeRuntime();
    pending.resolve(json({ preview: runtimePreview }));
    await expect(disposedCreate).rejects.toMatchObject({ code: 'AB8015' });
    await expect(create()).rejects.toMatchObject({ code: 'AB8015' });
    project.close();
  });

  it('creates a binding-scoped preview without putting the foreground credential in its URL or request payload', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
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

  it('closes with a teardown frame and preserves the shared credential for its force-delete fallback', async () => {
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
      '/api/mcp/apps/binding-weather',
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ id: 'close-1', reason: 'MCP App frame unmounted.' });
    expect(calls[2]?.[1]?.method).toBe('DELETE');
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
