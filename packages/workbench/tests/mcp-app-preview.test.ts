import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import {
  createMcpAppPreviewController,
  McpAppPreview,
  McpAppPreviewFrame,
  type McpAppFrameRelayFactory,
  type McpAppPreviewClient,
  type McpAppRuntimePreviewProps,
  type McpAppPreviewState,
} from '../src/mcp/mcp-app-preview.tsx';
import type {
  McpAppClient,
  McpAppHostContext,
  McpAppJsonValue,
  McpAppPreview as Preview,
  McpAppPreviewCreateRequest,
  McpAppRuntimeClient,
  McpAppTrustedDocumentPolicy,
  McpAppRelayFrame,
  McpAppRouteClose,
  McpAppRouteMessages,
} from '../src/mcp/mcp-app-client.ts';
import type { McpAppFrameIframe, McpAppFrameRelayOptions, McpAppFrameWindow } from '../src/mcp/mcp-app-frame.tsx';
import type { McpAppPreviewAppsSnapshot } from '../../agent-bundle/src/dev/mcp-app-runtime-preview-service.ts';
import type { RuntimeAppBridgeFactory } from '../src/inspector/adapter/runtime-app-bridge.ts';

const host: McpAppHostContext = Object.freeze({
  availableDisplayModes: Object.freeze(['inline']),
  containerDimensions: Object.freeze({ height: 480, width: 640 }),
  deviceCapabilities: Object.freeze({}),
  displayMode: 'inline',
  locale: 'en-US',
  platform: 'web',
  safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
  styles: Object.freeze({}),
  theme: 'light',
  timeZone: 'Etc/UTC',
  userAgent: 'Agent Bundle Workbench',
});

const frame: McpAppRelayFrame = Object.freeze({
  allow: '',
  policy: Object.freeze({
    contentSecurityPolicy: "default-src 'none'",
    iframeAllow: '',
    permissionsPolicy: 'camera=()',
  }),
  referrerPolicy: 'no-referrer',
  relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 4 }),
  sandbox: 'allow-scripts allow-same-origin',
  src: 'http://127.0.0.1:43124/#mcp-app-preview',
  targetOrigin: 'http://127.0.0.1:43124',
});

const resource: McpAppJsonValue = Object.freeze({
  csp: Object.freeze({ connectDomains: Object.freeze(['https://api.example.test']) }),
  html: '<main>Forecast</main>',
  kind: 'resource',
  permissions: Object.freeze({}),
});

const preview = (overrides: Partial<Preview> = {}): Preview => Object.freeze({
  bindingId: 'binding-weather',
  frame,
  profile: Object.freeze({ kind: 'apps', profile: 'portable', resourceUri: 'ui://weather/forecast.html' }),
  resource,
  ...overrides,
});

const documentFrame = (revision: number): McpAppRelayFrame => Object.freeze({
  ...frame,
  allow: 'geolocation',
  documentPolicy: Object.freeze({
    allow: 'geolocation',
    approvedPermissions: Object.freeze({ geolocation: Object.freeze({}) }),
    revision,
    warnings: Object.freeze([]),
  }),
});

const closed = (): McpAppRouteClose => Object.freeze({ lifecycle: 'closed' });
const messages = (): McpAppRouteMessages => Object.freeze({ accepted: true, lifecycle: 'initialized', messages: Object.freeze([]) });

const fakeClient = (result: Promise<Preview>) => {
  const creates: McpAppPreviewCreateRequest[] = [];
  const forceClosed: string[] = [];
  const client: McpAppPreviewClient = {
    async close() { return closed(); },
    async create(_sessionId, request) {
      creates.push(request);
      return result;
    },
    async forceClose(bindingId) {
      forceClosed.push(bindingId);
      return true;
    },
    async message() { return messages(); },
  };
  return { client, creates, forceClosed };
};

const iframe = (): McpAppFrameIframe => Object.freeze({
  contentWindow: Object.freeze({ postMessage: () => undefined }),
});

const browserWindow: McpAppFrameWindow = Object.freeze({
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const deferred = <Value>() => {
  let reject: (reason?: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const runtimePreview = Object.freeze({
  binding: Object.freeze({
    definitionDigest: 'definition-weather',
    evidence: 'simulated' as const,
    id: 'runtime-binding-weather',
    profileId: 'portable' as const,
    profileVersion: 'agent-bundle:mcp-apps:2026-01-26' as const,
    registryRevision: 3,
    runVector: Object.freeze({ runtimeGenerationId: 'generation-weather', sourceRevision: 'source-weather', stateVersion: 1 }),
    serverDigest: 'server-weather',
    serverName: 'weather',
    sessionId: 'runtime-session-weather',
    sessionRevision: 2,
    target: 'weather',
    transportDigest: 'transport-weather',
  }),
  clientSurface: Object.freeze({ bootstrapUrl: 'http://127.0.0.1:43124/runtime-app', origin: 'http://127.0.0.1:43124', webSocketPath: '/rsbuild-hmr' as const }),
  documentPolicy: Object.freeze({ allow: '', approvedPermissions: Object.freeze({}), revision: 1, warnings: Object.freeze([]) }),
  kind: 'apps' as const,
  metadata: Object.freeze({ resource: Object.freeze({}), result: Object.freeze({}), tool: Object.freeze({}) }),
  operations: Object.freeze([]),
  profile: Object.freeze({
    bootstrap: Object.freeze({ kind: 'none' as const, script: undefined }),
    configExtensions: Object.freeze({ entries: Object.freeze([]), sourceRevision: 'source-weather' }),
    descriptor: Object.freeze({ claimsRealHostParity: false as const, evidence: 'simulated' as const, id: 'portable' as const, label: 'Portable MCP Apps' as const, version: 'agent-bundle:mcp-apps:2026-01-26' as const }),
    hostContext: Object.freeze({ availableDisplayModes: Object.freeze(['inline']), containerDimensions: Object.freeze({ height: 480, width: 640 }), deviceCapabilities: Object.freeze({}), displayMode: 'inline', locale: 'en-US', platform: 'web', safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }), styles: Object.freeze({}), theme: 'light' as const, timeZone: 'UTC', toolInfo: Object.freeze({}), userAgent: 'agent-bundle-runtime-mcp-app/1' }),
    kind: 'apps' as const,
    metadata: Object.freeze({}),
    permissions: Object.freeze({}),
    resourceUri: 'ui://weather/app.html',
    warnings: Object.freeze([]),
  }),
  resource: Object.freeze({ html: '<main>Weather</main>', permissions: Object.freeze({}) }),
  result: Object.freeze({ appVisible: Object.freeze({}), isError: false, modelVisible: Object.freeze({}) }),
  session: Object.freeze({
    binding: Object.freeze({ definitionDigest: 'definition-weather', registryRevision: 3, serverDigest: 'server-weather', serverName: 'weather', sessionId: 'runtime-session-weather', sessionRevision: 2, target: 'weather', transportDigest: 'transport-weather' }),
    connection: Object.freeze({ capabilities: Object.freeze({ resources: Object.freeze({}), tools: Object.freeze({}) }), protocolEra: 'modern' as const, protocolVersion: '2026-01-26', server: Object.freeze({ name: 'weather', version: '1.0.0' }) }),
    state: 'ready' as const,
  }),
}) as unknown as McpAppPreviewAppsSnapshot;

const runtimeClient = (value: Partial<McpAppRuntimeClient> & Readonly<Record<string, unknown>>): McpAppClient & McpAppRuntimeClient =>
  Object.freeze({
    subscribeInvalidations: () => () => undefined,
    ...value,
  }) as unknown as McpAppClient & McpAppRuntimeClient;

const runtimeProps = (client: McpAppClient & McpAppRuntimeClient, createBridgeFactory: McpAppRuntimePreviewProps['createBridgeFactory']): McpAppRuntimePreviewProps => Object.freeze({
  client,
  createBridgeFactory,
  kind: 'runtime' as const,
  profile: Object.freeze({ claimsRealHostParity: false, evidence: 'simulated' as const, id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }),
  profileId: 'portable',
  run: Object.freeze({
    completedAt: '2026-08-16T00:00:01.000Z',
    id: 'run-weather',
    input: Object.freeze({ city: 'Paris', nested: Object.freeze({ unit: 'celsius' }) }),
    result: Object.freeze({
      app: Object.freeze({
        mcpBinding: runtimePreview.session.binding,
        resourceUri: 'ui://weather/app.html',
        surfaceId: 'mcp.edit-weather',
      }),
      modelVisible: Object.freeze({ temperature: 22 }),
      state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'private-state', stateVersion: 1 }) }),
      trace: Object.freeze([]),
      tree: Object.freeze([]),
    }),
    startedAt: '2026-08-16T00:00:00.000Z',
    status: 'succeeded' as const,
    surfaceId: 'surface-weather',
    target: 'weather',
    vector: Object.freeze({ providerSessionId: 'private-provider', runtimeGenerationId: 'generation-weather', sourceRevision: 'source-weather', stateStoreId: 'private-state', stateVersion: 1 }),
  }),
  surface: Object.freeze({ fixtures: Object.freeze([]), id: 'surface-weather', kind: 'mcp-app' as const, label: 'Weather App', readOnly: false, targets: Object.freeze(['weather']) }),
});

const runtimePreviewFor = (profileId: 'chatgpt' | 'claude' | 'portable'): McpAppPreviewAppsSnapshot => {
  const descriptor = profileId === 'portable'
    ? Object.freeze({ claimsRealHostParity: false as const, evidence: 'simulated' as const, id: 'portable' as const, label: 'Portable MCP Apps' as const, version: 'agent-bundle:mcp-apps:2026-01-26' as const })
    : profileId === 'chatgpt'
      ? Object.freeze({ claimsRealHostParity: false as const, evidence: 'simulated' as const, id: 'chatgpt' as const, label: 'ChatGPT Simulation' as const, version: 'agent-bundle:chatgpt-sim:1' as const })
      : Object.freeze({ claimsRealHostParity: false as const, evidence: 'simulated' as const, id: 'claude' as const, label: 'Claude Simulation' as const, version: 'agent-bundle:claude-sim:1' as const });
  return Object.freeze({
    ...runtimePreview,
    binding: Object.freeze({ ...runtimePreview.binding, profileId, profileVersion: descriptor.version }),
    profile: Object.freeze({ ...runtimePreview.profile, descriptor }),
  }) as McpAppPreviewAppsSnapshot;
};

const runtimePropsFor = (
  profileId: 'chatgpt' | 'claude' | 'portable',
  client: McpAppClient & McpAppRuntimeClient,
  createBridgeFactory: McpAppRuntimePreviewProps['createBridgeFactory'],
): McpAppRuntimePreviewProps => {
  const initial = runtimeProps(client, createBridgeFactory);
  return Object.freeze({
    ...initial,
    profile: Object.freeze({
      claimsRealHostParity: false,
      evidence: 'simulated' as const,
      id: profileId,
      label: profileId === 'portable' ? 'Portable MCP Apps' : profileId === 'chatgpt' ? 'ChatGPT Simulation' : 'Claude Simulation',
      version: profileId === 'portable' ? 'agent-bundle:mcp-apps:2026-01-26' : `agent-bundle:${profileId}-sim:1`,
    }),
    profileId,
  });
};

describe('MCP App preview', () => {
  it('creates a preview from immutable tool data and starts a relay bound to the exact sandbox frame', async () => {
    const input: McpAppJsonValue = Object.freeze({ city: 'Paris', nested: Object.freeze({ unit: 'celsius' }) });
    const result: McpAppJsonValue = Object.freeze({ temperature: 22 });
    const { client, creates, forceClosed } = fakeClient(Promise.resolve(preview()));
    const relay = { closeCalls: 0, startCalls: 0 };
    const factoryCalls: McpAppFrameRelayOptions[] = [];
    const frameRelayFactory: McpAppFrameRelayFactory = (options) => {
      factoryCalls.push(options);
      return {
        async close() { relay.closeCalls += 1; },
        start() { relay.startCalls += 1; return true; },
      };
    };
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory,
      host,
      input,
      result,
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();
    const mountedIframe = iframe();
    controller.attachFrame(mountedIframe, browserWindow);

    expect(creates).toEqual([{
      host,
      input: { city: 'Paris', nested: { unit: 'celsius' } },
      previewProfile: 'portable',
      result: { temperature: 22 },
      toolName: 'show-weather',
    }]);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen((input as { readonly nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(controller.state).toMatchObject({ phase: 'ready' });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]).toMatchObject({ bindingId: 'binding-weather', frame, resource, window: browserWindow });
    expect(factoryCalls[0]?.iframe).toBe(mountedIframe);
    expect(relay.startCalls).toBe(1);

    await controller.close();

    expect(relay.closeCalls).toBe(1);
    expect(forceClosed).toEqual([]);
  });

  it('keeps the ordinary fallback visible and closes its unused binding when no canonical App frame is available', async () => {
    const fallback: McpAppJsonValue = Object.freeze({
      input: Object.freeze({ city: 'Paris' }),
      kind: 'fallback',
      reason: 'invalid-resource',
      result: Object.freeze({ text: 'Sunny' }),
    });
    const { client, forceClosed } = fakeClient(Promise.resolve(preview({ frame: undefined, resource: fallback })));
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => { throw new Error('fallback must not start a relay'); },
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();
    await controller.close();

    expect(controller.state).toMatchObject({ fallback: { reason: 'invalid-resource' }, phase: 'fallback' });
    expect(forceClosed).toEqual(['binding-weather']);
  });

  it('refuses a sandbox frame unless its profile proves the canonical ui resource', async () => {
    const { client, forceClosed } = fakeClient(Promise.resolve(preview({
      profile: Object.freeze({ kind: 'apps', profile: 'portable' }),
    })));
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => { throw new Error('an unproven resource must not start a relay'); },
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();

    expect(controller.state).toMatchObject({ fallback: { reason: 'invalid-resource' }, phase: 'fallback' });
    expect(controller.attachFrame(iframe(), browserWindow)).toBe(false);
    await controller.close();
    expect(forceClosed).toEqual(['binding-weather']);
  });

  it('rejects malformed or noncanonical ui resource URIs before mounting a sandbox', async () => {
    for (const resourceUri of ['ui:///', 'ui://weather/../forecast.html', 'https://weather/forecast.html', 'ui:// weather/forecast.html']) {
      const { client, forceClosed } = fakeClient(Promise.resolve(preview({
        profile: Object.freeze({ kind: 'apps', profile: 'portable', resourceUri }),
      })));
      const controller = createMcpAppPreviewController({
        client,
        frameRelayFactory: () => { throw new Error('a noncanonical resource must not start a relay'); },
        host,
        input: Object.freeze({ city: 'Paris' }),
        result: Object.freeze({ text: 'Sunny' }),
        sessionId: 'session-weather',
        toolName: 'show-weather',
      });

      await controller.start();

      expect(controller.state).toMatchObject({ fallback: { reason: 'invalid-resource' }, phase: 'fallback' });
      await controller.close();
      expect(forceClosed).toEqual(['binding-weather']);
    }
  });

  it('deep-detaches JSON input and result transactionally before a preview create can observe them', async () => {
    const input = { city: 'Paris', nested: { unit: 'celsius' } } as unknown as McpAppJsonValue;
    const result = { temperature: 22 } as unknown as McpAppJsonValue;
    const { client, creates } = fakeClient(Promise.resolve(preview()));
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input,
      result,
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });
    (input as { nested: { unit: string } }).nested.unit = 'fahrenheit';
    (result as { temperature: number }).temperature = 23;

    await controller.start();

    expect(creates[0]).toMatchObject({ input: { city: 'Paris', nested: { unit: 'celsius' } }, result: { temperature: 22 } });
    expect(Object.isFrozen(creates[0]?.input)).toBe(true);
    expect(Object.isFrozen((creates[0]?.input as { readonly nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(creates[0]?.result)).toBe(true);

    const cyclic: { readonly self?: unknown } = {};
    (cyclic as { self: unknown }).self = cyclic;
    expect(() => createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input: cyclic as McpAppJsonValue,
      result: { invalid: Number.NaN } as unknown as McpAppJsonValue,
      sessionId: 'session-weather',
      toolName: 'show-weather',
    })).toThrow('JSON');
    expect(creates).toHaveLength(1);
  });

  it('rejects nested non-ordinary JSON data before preview create without reading accessors', () => {
    class CustomJsonLike {
      readonly value = 'not-json';
    }
    let accessorReads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return 'must-not-read';
      },
    });
    const invalidValues: readonly unknown[] = Object.freeze([
      new Date(0),
      new CustomJsonLike(),
      accessor,
      () => undefined,
      Symbol('not-json'),
    ]);
    const { client, creates } = fakeClient(Promise.resolve(preview()));

    for (const invalid of invalidValues) {
      for (const position of ['input', 'result'] as const) {
        expect(() => createMcpAppPreviewController({
          client,
          frameRelayFactory: () => ({ async close() {}, start: () => true }),
          host,
          input: (position === 'input' ? { nested: invalid } : { city: 'Paris' }) as McpAppJsonValue,
          result: (position === 'result' ? { nested: invalid } : { text: 'Sunny' }) as McpAppJsonValue,
          sessionId: 'session-weather',
          toolName: 'show-weather',
        })).toThrow('JSON');
      }
    }

    expect(accessorReads).toBe(0);
    expect(creates).toEqual([]);
  });

  it('rejects nested NaN and infinities independently of cyclic JSON', () => {
    const { client, creates } = fakeClient(Promise.resolve(preview()));

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createMcpAppPreviewController({
        client,
        frameRelayFactory: () => ({ async close() {}, start: () => true }),
        host,
        input: { nested: invalid } as unknown as McpAppJsonValue,
        result: Object.freeze({ text: 'Sunny' }),
        sessionId: 'session-weather',
        toolName: 'show-weather',
      })).toThrow('finite JSON numbers');
    }

    expect(creates).toEqual([]);
  });

  it('deep-detaches and freezes null-prototype JSON with an enumerable own __proto__ key', async () => {
    const originalNested = { retained: true };
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', { configurable: true, enumerable: true, value: originalNested, writable: true });
    input.city = 'Paris';
    const { client, creates } = fakeClient(Promise.resolve(preview()));
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input: input as McpAppJsonValue,
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });
    originalNested.retained = false;

    await controller.start();

    const captured = creates[0]?.input as Record<string, unknown>;
    expect(Object.getPrototypeOf(captured)).toBeNull();
    expect(Object.hasOwn(captured, '__proto__')).toBe(true);
    expect(captured.__proto__).toEqual({ retained: true });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.__proto__)).toBe(true);
  });

  it('returns shared start and close promises while creating and cleaning up once', async () => {
    const pending = deferred<Preview>();
    const { client, creates, forceClosed } = fakeClient(pending.promise);
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    const firstStart = controller.start();
    const secondStart = controller.start();
    const firstClose = controller.close();
    const secondClose = controller.close();

    expect(secondStart).toBe(firstStart);
    expect(secondClose).toBe(firstClose);
    expect(creates).toHaveLength(1);
    pending.resolve(preview());
    await Promise.all([firstStart, firstClose]);

    expect(forceClosed).toEqual(['binding-weather']);
  });

  it('isolates a throwing subscriber from fallback publication and relay cleanup', async () => {
    const { client } = fakeClient(Promise.resolve(preview()));
    let relayCloseCalls = 0;
    const observed: McpAppPreviewState['phase'][] = [];
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({
        async close() { relayCloseCalls += 1; },
        start: () => false,
      }),
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    expect(() => controller.subscribe(() => { throw new Error('display subscriber failed'); })).not.toThrow();
    controller.subscribe((state) => { observed.push(state.phase); });
    await controller.start();
    expect(controller.attachFrame(iframe(), browserWindow)).toBe(false);
    await controller.close();

    expect(observed).toEqual(['loading', 'ready', 'error']);
    expect(controller.state).toMatchObject({ fallback: { reason: 'preview-error' }, phase: 'error' });
    expect(relayCloseCalls).toBe(1);
  });

  it('commits a document-policy refresh only after the page has committed its keyed blank barrier', async () => {
    const first = preview({ frame: documentFrame(1) });
    const second = preview({ frame: documentFrame(2) });
    const { client } = fakeClient(Promise.resolve(first));
    client.decideConsent = async () => Object.freeze({ approved: true, messages: Object.freeze([]), preview: second });
    let detached = 0;
    let relayCreates = 0;
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => {
        relayCreates += 1;
        return { async close() {}, detach() { detached += 1; }, start: () => true };
      },
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();
    expect(controller.attachFrame(iframe(), browserWindow)).toBe(true);
    expect(relayCreates).toBe(1);
    await expect(controller.decideConsent('document-geolocation', true)).resolves.toBe(true);
    expect(detached).toBe(1);
    expect(controller.state).toMatchObject({ phase: 'ready', preview: { frame: { documentPolicy: { revision: 1 } } } });
    expect(controller.pendingDocumentPolicyRevision).toBe(2);
    expect(controller.commitDocumentRemount(1)).toBe(false);
    expect(controller.commitDocumentRemount(2)).toBe(true);
    expect(controller.state).toMatchObject({ phase: 'ready', preview: { frame: { documentPolicy: { revision: 2 } } } });
    expect(controller.attachFrame(iframe(), browserWindow)).toBe(true);
    expect(relayCreates).toBe(2);
    await controller.close();
  });

  it('retains the credential-owning client receiver while listing and deciding consent', async () => {
    const challenge = Object.freeze({
      expiresAt: 30_000,
      id: 'consent-tool',
      request: Object.freeze({ capability: 'call-tool' as const, details: Object.freeze({ name: 'refresh-weather' }), scope: 'action' as const, summary: 'Allow MCP App call tool?' }),
    });
    class ReceiverBoundClient implements McpAppPreviewClient {
      readonly calls: string[] = [];
      async close() { return closed(); }
      async consentChallenges(bindingId: string) {
        this.calls.push(`list:${bindingId}`);
        return Object.freeze([challenge]);
      }
      async create() { return preview(); }
      async decideConsent(bindingId: string, challengeId: string, approved: boolean) {
        this.calls.push(`decide:${bindingId}:${challengeId}:${approved}`);
        return Object.freeze({ approved, messages: Object.freeze([]), preview: preview() });
      }
      async forceClose() { return true; }
      async message() { return messages(); }
    }
    const client = new ReceiverBoundClient();
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({ async close() {}, deliverHostMessages: () => true, start: () => true }),
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();
    controller.attachFrame(iframe(), browserWindow);
    await expect(controller.consentChallenges()).resolves.toEqual([challenge]);
    await expect(controller.decideConsent(challenge.id, true)).resolves.toBe(true);
    expect(client.calls).toEqual(['list:binding-weather', 'decide:binding-weather:consent-tool:true']);
    await controller.close();
  });

  it('waits for a late preview create before force-closing its binding during unmount', async () => {
    const pending = deferred<Preview>();
    const { client, forceClosed } = fakeClient(pending.promise);
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    const starting = controller.start();
    let closeFinished = false;
    const closing = controller.close().then(() => { closeFinished = true; });
    await Promise.resolve();

    expect(closeFinished).toBe(false);
    pending.resolve(preview());
    await Promise.all([starting, closing]);

    expect(forceClosed).toEqual(['binding-weather']);
    expect(controller.state).toEqual({ phase: 'loading' });
  });

  it('reports create and relay failures with the ordinary immutable fallback before cleanup', async () => {
    const failed = fakeClient(Promise.reject(new Error('preview route failed')));
    const createFailure = createMcpAppPreviewController({
      client: failed.client,
      frameRelayFactory: () => { throw new Error('not reached'); },
      host,
      input: Object.freeze({}),
      result: Object.freeze({}),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await createFailure.start();

    expect(createFailure.state).toMatchObject({
      fallback: { input: {}, result: {} },
      message: 'preview route failed',
      phase: 'error',
    });

    const active = fakeClient(Promise.resolve(preview()));
    let relayOptions: McpAppFrameRelayOptions | undefined;
    const relayFailure = createMcpAppPreviewController({
      client: active.client,
      frameRelayFactory: (options) => {
        relayOptions = options;
        return {
        async close() { throw new Error('graceful close failed'); },
        start: () => true,
        };
      },
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });
    await relayFailure.start();
    relayFailure.attachFrame(iframe(), browserWindow);
    relayOptions?.onError?.(new Error('relay failed') as never);

    expect(relayFailure.state).toMatchObject({
      fallback: { input: { city: 'Paris' }, result: { text: 'Sunny' } },
      message: 'relay failed',
      phase: 'error',
    });
    await relayFailure.close();
    expect(active.forceClosed).toEqual(['binding-weather']);
  });

  it('creates one runtime Apps preview from frozen run evidence without entering the artifact lane', async () => {
    const creates: unknown[] = [];
    const artifactCalls: string[] = [];
    const bridgePreviews: McpAppPreviewAppsSnapshot[] = [];
    const policy: McpAppTrustedDocumentPolicy = Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy });
    const client = runtimeClient(Object.freeze({
      close: async () => { artifactCalls.push('close'); return closed(); },
      closeRuntime: async () => undefined,
      create: async () => { artifactCalls.push('create'); return preview(); },
      createRuntime: async (request: unknown) => { creates.push(request); return runtimePreview; },
      currentDocumentPolicy: () => policy,
      forceClose: async () => { artifactCalls.push('forceClose'); return true; },
      message: async () => { artifactCalls.push('message'); return messages(); },
    }));
    const factory = Object.assign(
      () => { throw new Error('the renderer has not mounted'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, (next) => {
      bridgePreviews.push(next);
      return factory;
    }));

    await controller.start();

    expect(creates).toEqual([{
      expectedGenerationId: 'generation-weather',
      profileId: 'portable',
      runId: 'run-weather',
    }]);
    expect(artifactCalls).toEqual([]);
    expect(bridgePreviews).toEqual([runtimePreview]);
    expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'ready', preview: { binding: { id: 'runtime-binding-weather' } } });
    await controller.close();
  });

  it('delivers one detached full App invocation to an admitted renderer handle', async () => {
    const input = { city: 'Paris', nested: { unit: 'celsius' } };
    const appVisible = {
      _meta: { 'io.modelcontextprotocol/ui': { invocationId: 'invocation-weather' } },
      content: [{ _meta: { emphasis: 'high' }, text: 'Sunny', type: 'text' }],
      isError: false,
      structuredContent: { forecast: { temperature: 22, unit: 'C' } },
    };
    const snapshot = {
      ...runtimePreview,
      result: {
        appVisible,
        isError: false,
        modelVisible: { ordinary: 'fallback only' },
      },
    } as McpAppPreviewAppsSnapshot;
    const sent: unknown[] = [];
    let creates = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => undefined,
      createRuntime: async () => { creates += 1; return snapshot; },
      currentDocumentPolicy: () => Object.freeze({ bindingId: snapshot.binding.id, snapshot: snapshot.documentPolicy }),
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory;
    const initial = runtimeProps(client, () => bridgeFactory);
    const props = {
      ...initial,
      run: {
        ...initial.run,
        input,
      },
    } as McpAppRuntimePreviewProps;
    const controller = createMcpAppPreviewController(props);
    input.nested.unit = 'fahrenheit';

    await controller.start();
    appVisible.content[0]!.text = 'Mutated';
    appVisible.structuredContent.forecast.temperature = 99;
    const handle = Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async (argumentsValue: unknown) => { sent.push(Object.freeze({ argumentsValue, kind: 'input' })); },
      sendToolResult: async (result: unknown) => { sent.push(Object.freeze({ kind: 'result', result })); },
      teardown: async () => undefined,
    });
    controller.runtimeRendererRef?.(handle);
    controller.runtimeRendererRef?.(null);
    controller.runtimeRendererRef?.(handle);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(creates).toBe(1);
    expect(sent).toEqual([
      { argumentsValue: { city: 'Paris', nested: { unit: 'celsius' } }, kind: 'input' },
      {
        kind: 'result',
        result: {
          _meta: { 'io.modelcontextprotocol/ui': { invocationId: 'invocation-weather' } },
          content: [{ _meta: { emphasis: 'high' }, text: 'Sunny', type: 'text' }],
          isError: false,
          structuredContent: { forecast: { temperature: 22, unit: 'C' } },
        },
      },
    ]);
    const inputDelivery = sent[0] as Readonly<{ readonly argumentsValue: Readonly<{ readonly nested: object }> }>;
    const resultDelivery = sent[1] as Readonly<{ readonly result: Readonly<{ readonly content: readonly object[]; readonly structuredContent: Readonly<{ readonly forecast: object }> }> }>;
    expect(Object.isFrozen(inputDelivery.argumentsValue)).toBe(true);
    expect(Object.isFrozen(inputDelivery.argumentsValue.nested)).toBe(true);
    expect(Object.isFrozen(resultDelivery.result)).toBe(true);
    expect(Object.isFrozen(resultDelivery.result.content)).toBe(true);
    expect(Object.isFrozen(resultDelivery.result.structuredContent.forecast)).toBe(true);
    expect(controller.state).toMatchObject({ fallback: { result: { temperature: 22 } }, kind: 'runtime', phase: 'ready' });
    await controller.close();
  });

  it('contains runtime App invocation delivery failures in the retryable renderer cleanup lifecycle', async () => {
    const order: string[] = [];
    let teardowns = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = runtimeClient(Object.freeze({
        closeRuntime: async () => { order.push('binding'); },
        createRuntime: async () => runtimePreview,
        currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      }));
      const bridgeFactory = Object.assign(
        () => { throw new Error('renderer installation is represented by its ref'); },
        { close: async () => { order.push('bridge'); } },
      ) as RuntimeAppBridgeFactory;
      const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));

      await controller.start();
      controller.runtimeRendererRef?.(Object.freeze({
        sendToolCancelled: async () => undefined,
        sendToolInput: async () => { order.push('input'); },
        sendToolResult: async () => {
          order.push('result');
          throw new Error('runtime App invocation delivery failed');
        },
        teardown: async () => {
          teardowns += 1;
          order.push(`renderer:${teardowns}`);
          if (teardowns === 1) throw new Error('renderer cleanup retry');
        },
      }));

      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

      expect(order).toEqual(['input', 'result', 'renderer:1', 'bridge', 'binding']);
      expect(controller.state).toMatchObject({ kind: 'runtime', message: 'renderer cleanup retry', phase: 'cleanup-failed' });
      expect(unhandled).toEqual([]);

      const retry = controller.close();
      expect(controller.close()).toBe(retry);
      await expect(retry).resolves.toBeUndefined();

      expect(order).toEqual(['input', 'result', 'renderer:1', 'bridge', 'binding', 'renderer:2']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('waits for held runtime App input before teardown and suppresses its late result', async () => {
    const delivery = deferred<void>();
    const order: string[] = [];
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { order.push('binding'); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => { order.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));

    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => {
        order.push('input');
        return delivery.promise;
      },
      sendToolResult: async () => { order.push('result'); },
      teardown: async () => { order.push('renderer'); },
    }));
    const closing = controller.close();
    let settled = false;
    void closing.then(() => { settled = true; });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const settledBeforeInput = settled;

    delivery.resolve();
    await closing;
    await Promise.resolve();

    expect(settledBeforeInput).toBe(false);
    expect(order).toEqual(['input', 'renderer', 'bridge', 'binding']);
  });

  it('waits for a held runtime App result before renderer teardown', async () => {
    const delivery = deferred<void>();
    const order: string[] = [];
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { order.push('binding'); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => { order.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));

    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => { order.push('input'); },
      sendToolResult: async () => {
        order.push('result');
        return delivery.promise;
      },
      teardown: async () => { order.push('renderer'); },
    }));
    await Promise.resolve();
    const closing = controller.close();
    let settled = false;
    void closing.then(() => { settled = true; });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const settledBeforeResult = settled;

    delivery.resolve();
    await closing;

    expect(settledBeforeResult).toBe(false);
    expect(order).toEqual(['input', 'result', 'renderer', 'bridge', 'binding']);
  });

  it('retains one frozen lifecycle handle across a held runtime create and closes its late binding without publishing ready state', async () => {
    const pending = deferred<McpAppPreviewAppsSnapshot>();
    const closedBindings: string[] = [];
    const client = runtimeClient(Object.freeze({
      closeRuntime: async (bindingId: string) => { closedBindings.push(bindingId); },
      createRuntime: async () => pending.promise,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => {
      throw new Error('closed creates must not construct a bridge');
    }));
    const lifecycle = controller.runtimeLifecycle;
    const secondLifecycle = controller.runtimeLifecycle;

    expect(lifecycle).toBeDefined();
    expect(lifecycle).toBe(secondLifecycle);
    expect(Object.isFrozen(lifecycle)).toBe(true);
    const started = controller.start();
    const firstClose = lifecycle?.close();
    const secondClose = controller.close();

    expect(firstClose).toBe(secondClose);
    pending.resolve(runtimePreview);
    await Promise.all([started, firstClose]);

    expect(closedBindings).toEqual(['runtime-binding-weather']);
    expect(controller.state).toEqual({ kind: 'runtime', phase: 'loading' });
  });

  it('falls back and authoritatively closes an invalid created runtime binding before any bridge factory runs', async () => {
    const invalid = Object.freeze({
      ...runtimePreview,
      kind: 'fallback' as const,
      profile: Object.freeze({ kind: 'fallback' as const, reason: 'apps-resource-invalid' as const }),
    }) as unknown as McpAppPreviewAppsSnapshot;
    const closedBindings: string[] = [];
    let bridgeFactories = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async (bindingId: string) => { closedBindings.push(bindingId); },
      createRuntime: async () => invalid,
      currentDocumentPolicy: () => { throw new Error('invalid runtime previews have no policy'); },
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => {
      bridgeFactories += 1;
      throw new Error('invalid runtime previews must not construct a bridge');
    }));

    await controller.start();

    expect(controller.state).toMatchObject({ fallback: { input: { city: 'Paris', nested: { unit: 'celsius' } }, result: { temperature: 22 } }, kind: 'runtime', phase: 'fallback' });
    expect(bridgeFactories).toBe(0);
    expect(closedBindings).toEqual(['runtime-binding-weather']);
  });

  it('tears down the runtime renderer then bridge and binding through one shared close promise', async () => {
    const order: string[] = [];
    const policy: McpAppTrustedDocumentPolicy = Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy });
    const factory = Object.assign(
      () => { throw new Error('renderer mount is represented by its ref'); },
      { close: async () => { order.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async (bindingId: string) => { order.push(`binding:${bindingId}`); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => policy,
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => factory));
    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => { order.push('renderer'); },
    }));

    const first = controller.close();
    const second = controller.close();

    expect(second).toBe(first);
    await first;
    expect(order).toEqual(['renderer', 'bridge', 'binding:runtime-binding-weather']);
  });

  it('keeps matching restart invalidation admitted through a held normal close and skips the revoked backend delete', async () => {
    const order: string[] = [];
    const rendererTeardown = deferred<void>();
    let invalidation: ((details: {
      readonly bindingId: string;
      readonly reason: 'session-restarted';
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly state: 'revoked';
    }) => void) | undefined;
    let unsubscribes = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { order.push('binding'); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      subscribeInvalidations: (listener: typeof invalidation) => {
        invalidation = listener;
        return () => { unsubscribes += 1; invalidation = undefined; };
      },
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => { order.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));
    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => { order.push('renderer'); await rendererTeardown.promise; },
    }));
    const listener = invalidation;
    if (listener === undefined) throw new Error('Expected runtime invalidation subscription.');

    const closing = controller.close();
    await expect.poll(() => order).toEqual(['renderer']);
    expect(unsubscribes).toBe(0);
    listener({
      bindingId: runtimePreview.binding.id,
      reason: 'session-restarted',
      sessionId: runtimePreview.binding.sessionId,
      sessionRevision: runtimePreview.binding.sessionRevision,
      state: 'revoked',
    });
    rendererTeardown.resolve();
    await closing;

    expect(order).toEqual(['renderer', 'bridge']);
    expect(unsubscribes).toBe(1);
  });

  it('locally closes exactly the matching revoked runtime App without a redundant backend close', async () => {
    const order: string[] = [];
    let invalidation: ((details: {
      readonly bindingId: string;
      readonly reason: 'session-restarted';
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly state: 'revoked';
    }) => void) | undefined;
    let unsubscribes = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { order.push('binding'); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      subscribeInvalidations: (listener: typeof invalidation) => {
        invalidation = listener;
        return () => { unsubscribes += 1; };
      },
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => { order.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));
    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => { order.push('renderer'); },
    }));
    await Promise.resolve();

    invalidation?.({
      bindingId: 'foreign-binding',
      reason: 'session-restarted',
      sessionId: runtimePreview.binding.sessionId,
      sessionRevision: runtimePreview.binding.sessionRevision,
      state: 'revoked',
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'ready' });

    invalidation?.({
      bindingId: runtimePreview.binding.id,
      reason: 'session-restarted',
      sessionId: runtimePreview.binding.sessionId,
      sessionRevision: runtimePreview.binding.sessionRevision,
      state: 'revoked',
    });
    await expect.poll(() => order).toEqual(['renderer', 'bridge']);

    expect(unsubscribes).toBe(1);
    expect(controller.state).toMatchObject({ fallback: { reason: 'session-restarted' }, kind: 'runtime', phase: 'error' });
    await expect(controller.close()).resolves.toBeUndefined();
    expect(order).toEqual(['renderer', 'bridge']);
    expect(unsubscribes).toBe(1);
  });

  it('locally tears down an exact runtime preview after a registry replay gap without deleting its revoked binding', async () => {
    const order: string[] = [];
    let invalidation: ((details: {
      readonly bindingId: string;
      readonly reason: 'registry-replay-gap';
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly state: 'revoked';
    }) => void) | undefined;
    let unsubscribes = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { order.push('binding'); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      subscribeInvalidations: (listener: typeof invalidation) => {
        invalidation = listener;
        return () => { unsubscribes += 1; };
      },
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => { order.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));
    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => { order.push('renderer'); },
    }));
    const listener = invalidation;
    if (listener === undefined) throw new Error('Expected runtime invalidation subscription.');

    listener({
      bindingId: 'foreign-binding',
      reason: 'registry-replay-gap',
      sessionId: runtimePreview.binding.sessionId,
      sessionRevision: runtimePreview.binding.sessionRevision,
      state: 'revoked',
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    const revoked = Object.freeze({
      bindingId: runtimePreview.binding.id,
      reason: 'registry-replay-gap' as const,
      sessionId: runtimePreview.binding.sessionId,
      sessionRevision: runtimePreview.binding.sessionRevision,
      state: 'revoked' as const,
    });
    listener(revoked);
    await expect.poll(() => order).toEqual(['renderer', 'bridge']);
    listener(revoked);
    await Promise.resolve();

    expect(order).toEqual(['renderer', 'bridge']);
    expect(unsubscribes).toBe(1);
    expect(controller.state).toMatchObject({ fallback: { reason: 'registry-replay-gap' }, kind: 'runtime', phase: 'error' });
    await expect(controller.close()).resolves.toBeUndefined();
    expect(order).toEqual(['renderer', 'bridge']);
  });

  it('retains a matching invalidation cleanup failure for the same lifecycle retry without recreating or closing its revoked binding', async () => {
    let creates = 0;
    let teardowns = 0;
    let invalidation: ((details: {
      readonly bindingId: string;
      readonly reason: 'session-restarted';
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly state: 'revoked';
    }) => void) | undefined;
    let backendCloses = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { backendCloses += 1; },
      createRuntime: async () => { creates += 1; return runtimePreview; },
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      subscribeInvalidations: (listener: typeof invalidation) => {
        invalidation = listener;
        return () => undefined;
      },
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => Object.assign(
      () => { throw new Error('renderer installation is represented by its ref'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory));
    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => {
        teardowns += 1;
        if (teardowns === 1) throw new Error('local renderer cleanup failed');
      },
    }));

    invalidation?.({
      bindingId: runtimePreview.binding.id,
      reason: 'session-restarted',
      sessionId: runtimePreview.binding.sessionId,
      sessionRevision: runtimePreview.binding.sessionRevision,
      state: 'revoked',
    });
    await expect.poll(() => controller.state.phase).toBe('cleanup-failed');
    expect(backendCloses).toBe(0);
    await expect(controller.close()).resolves.toBeUndefined();
    expect(creates).toBe(1);
    expect(teardowns).toBe(2);
    expect(backendCloses).toBe(0);
  });

  it('fences a matching invalidation delivered during runtime preview admission before bridge creation', async () => {
    let bridges = 0;
    let backendCloses = 0;
    let unsubscribes = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => { backendCloses += 1; },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      subscribeInvalidations: (listener: (details: {
        readonly bindingId: string;
        readonly reason: 'session-restarted';
        readonly sessionId: string;
        readonly sessionRevision: number;
        readonly state: 'revoked';
      }) => void) => {
        listener({
          bindingId: runtimePreview.binding.id,
          reason: 'session-restarted',
          sessionId: runtimePreview.binding.sessionId,
          sessionRevision: runtimePreview.binding.sessionRevision,
          state: 'revoked',
        });
        return () => { unsubscribes += 1; };
      },
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => {
      bridges += 1;
      throw new Error('a revoked preview must not create a bridge');
    }));

    await controller.start();

    expect(bridges).toBe(0);
    expect(backendCloses).toBe(0);
    expect(unsubscribes).toBe(1);
    expect(controller.state).toMatchObject({ fallback: { reason: 'session-restarted' }, kind: 'runtime', phase: 'error' });
  });

  it('keeps the server-selected canonical ui resource across every simulation request', async () => {
    for (const profileId of ['portable', 'chatgpt', 'claude'] as const) {
      const requests: unknown[] = [];
      const snapshot = runtimePreviewFor(profileId);
      const client = runtimeClient(Object.freeze({
        closeRuntime: async () => undefined,
        createRuntime: async (request: unknown) => { requests.push(request); return snapshot; },
        currentDocumentPolicy: () => Object.freeze({ bindingId: snapshot.binding.id, snapshot: snapshot.documentPolicy }),
      }));
      let factoryPreview: McpAppPreviewAppsSnapshot | undefined;
      const controller = createMcpAppPreviewController(runtimePropsFor(profileId, client, (preview) => {
        factoryPreview = preview;
        return Object.assign(() => { throw new Error('not mounted'); }, { close: async () => undefined }) as RuntimeAppBridgeFactory;
      }));

      await controller.start();

      expect(requests).toEqual([{ expectedGenerationId: 'generation-weather', profileId, runId: 'run-weather' }]);
      expect(factoryPreview?.profile.resourceUri).toBe('ui://weather/app.html');
      expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'ready' });
      await controller.close();
    }
  });

  it('rejects a mismatched, noncanonical, or stale created runtime snapshot before bridge construction', async () => {
    const malformed = [
      Object.freeze({ ...runtimePreview, profile: Object.freeze({ ...runtimePreview.profile, resourceUri: 'https://weather/app.html' }) }),
      Object.freeze({ ...runtimePreview, profile: Object.freeze({ ...runtimePreview.profile, resourceUri: 'ui://weather/other.html' }) }),
      Object.freeze({ ...runtimePreview, binding: Object.freeze({ ...runtimePreview.binding, sessionRevision: 3 }) }),
      Object.freeze({ ...runtimePreview, binding: Object.freeze({ ...runtimePreview.binding, runVector: Object.freeze({ ...runtimePreview.binding.runVector, runtimeGenerationId: 'generation-other' }) }) }),
    ] as const;
    for (const snapshot of malformed) {
      const closedBindings: string[] = [];
      let bridges = 0;
      const client = runtimeClient(Object.freeze({
        closeRuntime: async (bindingId: string) => { closedBindings.push(bindingId); },
        createRuntime: async () => snapshot,
        currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
      }));
      const controller = createMcpAppPreviewController(runtimeProps(client, () => {
        bridges += 1;
        return Object.assign(() => { throw new Error('invalid snapshots must not mount'); }, { close: async () => undefined }) as RuntimeAppBridgeFactory;
      }));

      await controller.start();

      expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'fallback' });
      expect(bridges).toBe(0);
      expect(closedBindings).toEqual(['runtime-binding-weather']);
    }
  });

  it('requires the exact trusted policy snapshot, selected profile version, and ready session before constructing a runtime bridge', async () => {
    const invalid = [
      Object.freeze({ ...runtimePreview, session: Object.freeze({ ...runtimePreview.session, state: 'connecting' as const }) }),
      Object.freeze({ ...runtimePreview, binding: Object.freeze({ ...runtimePreview.binding, profileVersion: 'agent-bundle:mcp-apps:other' }) }),
      Object.freeze({ ...runtimePreview, profile: Object.freeze({ ...runtimePreview.profile, descriptor: Object.freeze({ ...runtimePreview.profile.descriptor, version: 'agent-bundle:mcp-apps:other' }) }) }),
    ] as const;
    for (const snapshot of invalid) {
      const closedBindings: string[] = [];
      let policies = 0;
      let bridges = 0;
      const client = runtimeClient(Object.freeze({
        closeRuntime: async (bindingId: string) => { closedBindings.push(bindingId); },
        // Deliberately cross the typed route boundary: this preview owner must
        // still fail closed if a malformed success reaches it.
        createRuntime: async () => snapshot as unknown as McpAppPreviewAppsSnapshot,
        currentDocumentPolicy: () => {
          policies += 1;
          return Object.freeze({
            bindingId: runtimePreview.binding.id,
            snapshot: Object.freeze({ ...runtimePreview.documentPolicy, approvedPermissions: Object.freeze({ camera: Object.freeze({}) }) }),
          });
        },
      }));
      const controller = createMcpAppPreviewController(runtimeProps(client, () => {
        bridges += 1;
        return Object.assign(() => { throw new Error('untrusted previews must not mount'); }, { close: async () => undefined }) as RuntimeAppBridgeFactory;
      }));

      await controller.start();

      expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'fallback' });
      expect(policies).toBe(0);
      expect(bridges).toBe(0);
      expect(closedBindings).toEqual(['runtime-binding-weather']);
    }

    const closedBindings: string[] = [];
    let bridges = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async (bindingId: string) => { closedBindings.push(bindingId); },
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({
        bindingId: runtimePreview.binding.id,
        snapshot: Object.freeze({ ...runtimePreview.documentPolicy, approvedPermissions: Object.freeze({ camera: Object.freeze({}) }) }),
      }),
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => {
      bridges += 1;
      return Object.assign(() => { throw new Error('copied policies must not mount'); }, { close: async () => undefined }) as RuntimeAppBridgeFactory;
    }));

    await controller.start();

    expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'error' });
    expect(bridges).toBe(0);
    expect(closedBindings).toEqual(['runtime-binding-weather']);
  });

  it('fences a held runtime create before policy, bridge, renderer, or state work after close', async () => {
    const pending = deferred<McpAppPreviewAppsSnapshot>();
    const closedBindings: string[] = [];
    let policies = 0;
    let bridges = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async (bindingId: string) => { closedBindings.push(bindingId); },
      createRuntime: async () => pending.promise,
      currentDocumentPolicy: () => {
        policies += 1;
        return Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy });
      },
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => {
      bridges += 1;
      return Object.assign(() => { throw new Error('closed creates must never mount'); }, { close: async () => undefined }) as RuntimeAppBridgeFactory;
    }));
    const states: string[] = [];
    controller.subscribe((state) => { states.push(state.phase); });
    const started = controller.start();
    const firstClose = controller.close();
    const secondClose = controller.runtimeLifecycle?.close();

    expect(secondClose).toBe(firstClose);
    pending.resolve(runtimePreview);
    await Promise.all([started, firstClose]);

    expect(policies).toBe(0);
    expect(bridges).toBe(0);
    expect(closedBindings).toEqual(['runtime-binding-weather']);
    expect(states).toEqual(['loading']);
  });

  it('retains the detached renderer handle until its exact teardown succeeds', async () => {
    let teardowns = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => undefined,
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => Object.assign(
      () => { throw new Error('not mounted'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory));
    await controller.start();
    const handle = Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => {
        teardowns += 1;
        if (teardowns === 1) throw new Error('renderer teardown failed');
      },
    });
    controller.runtimeRendererRef?.(handle);
    controller.runtimeRendererRef?.(null);

    await expect(controller.close()).rejects.toThrow('renderer teardown failed');
    await expect(controller.close()).resolves.toBeUndefined();

    expect(teardowns).toBe(2);
  });

  it('deep-detaches runtime input and model-visible result before create and preserves immutable preview-error evidence', async () => {
    const input = { city: 'Paris', nested: { unit: 'celsius' } };
    const result = { temperature: 22 };
    const requests: unknown[] = [];
    const client = runtimeClient(Object.freeze({
      createRuntime: async (request: unknown) => { requests.push(request); throw new Error('runtime create failed'); },
    }));
    const props = runtimeProps(client, () => { throw new Error('not reached'); });
    const mutable = {
      ...props,
      run: {
        ...props.run,
        input,
        result: { ...props.run.result, modelVisible: result },
      },
    } as McpAppRuntimePreviewProps;
    const controller = createMcpAppPreviewController(mutable);
    input.nested.unit = 'fahrenheit';
    result.temperature = 23;

    await controller.start();

    expect(requests).toEqual([{ expectedGenerationId: 'generation-weather', profileId: 'portable', runId: 'run-weather' }]);
    expect(controller.state).toMatchObject({
      fallback: { input: { city: 'Paris', nested: { unit: 'celsius' } }, reason: 'preview-error', result: { temperature: 22 } },
      kind: 'runtime',
      phase: 'error',
    });
    const fallback = (controller.state as Extract<typeof controller.state, { readonly fallback: unknown }>).fallback;
    expect(Object.isFrozen(fallback)).toBe(true);
    expect(Object.isFrozen(fallback.input)).toBe(true);
    expect(Object.isFrozen((fallback.input as { readonly nested: object }).nested)).toBe(true);
  });

  it('captures runtime App identity before caller mutation can alter the later create admission', async () => {
    const snapshot = runtimePreview;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => undefined,
      createRuntime: async () => snapshot,
      currentDocumentPolicy: () => Object.freeze({ bindingId: snapshot.binding.id, snapshot: snapshot.documentPolicy }),
    }));
    const props = runtimeProps(client, () => Object.assign(
      () => { throw new Error('not mounted'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory);
    const successful = props.run as Extract<typeof props.run, Readonly<{ readonly status: 'succeeded' }>>;
    const mutable = {
      ...props,
      profile: { ...props.profile },
      run: {
        ...successful,
        result: {
          ...successful.result,
          app: { ...successful.result.app!, mcpBinding: { ...successful.result.app!.mcpBinding } },
        },
      },
    } as McpAppRuntimePreviewProps;
    const controller = createMcpAppPreviewController(mutable);
    const mutableRun = mutable.run as Extract<typeof mutable.run, Readonly<{ readonly status: 'succeeded' }>>;
    (mutableRun.result.app as { resourceUri: string }).resourceUri = 'https://attacker.invalid/not-an-app';
    (mutableRun.result.app?.mcpBinding as { sessionRevision: number }).sessionRevision = 999;
    (mutable.profile as { version: string }).version = 'agent-bundle:mcp-apps:attacker';

    await controller.start();

    expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'ready', preview: { profile: { resourceUri: 'ui://weather/app.html' } } });
  });

  it('retains retryable runtime cleanup failure without recreating the preview', async () => {
    let createCalls = 0;
    let closeCalls = 0;
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('runtime release failed');
      },
      createRuntime: async () => { createCalls += 1; return runtimePreview; },
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => Object.assign(
      () => { throw new Error('not mounted'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory));
    await controller.start();

    const first = controller.close();
    const joined = controller.close();

    expect(joined).toBe(first);
    await expect(first).rejects.toThrow('runtime release failed');
    expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'cleanup-failed' });
    await expect(controller.close()).resolves.toBeUndefined();
    expect(createCalls).toBe(1);
    expect(closeCalls).toBe(2);
  });

  it('retires the runtime renderer before backend policy revocation while retaining its retryable lifecycle', async () => {
    let createCalls = 0;
    let closeCalls = 0;
    const controllerRef = {} as { current: ReturnType<typeof createMcpAppPreviewController> };
    const cleanupOrder: string[] = [];
    const phasesAtBackendClose: string[] = [];
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => {
        closeCalls += 1;
        cleanupOrder.push('backend');
        phasesAtBackendClose.push(controllerRef.current.state.phase);
        if (closeCalls === 1) throw new Error('runtime policy revocation failed');
      },
      createRuntime: async () => { createCalls += 1; return runtimePreview; },
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const bridgeFactory = Object.assign(
      () => { throw new Error('renderer mount is represented by its ref'); },
      { close: async () => { cleanupOrder.push('bridge'); } },
    ) as RuntimeAppBridgeFactory;
    const controller = createMcpAppPreviewController(runtimeProps(client, () => bridgeFactory));
    controllerRef.current = controller;
    await controller.start();
    controller.runtimeRendererRef?.(Object.freeze({
      sendToolCancelled: async () => undefined,
      sendToolInput: async () => undefined,
      sendToolResult: async () => undefined,
      teardown: async () => { cleanupOrder.push('renderer'); },
    }));

    const lifecycle = controller.runtimeLifecycle;
    await expect(lifecycle?.close()).rejects.toThrow('runtime policy revocation failed');

    expect(cleanupOrder).toEqual(['renderer', 'bridge', 'backend']);
    expect(phasesAtBackendClose).toEqual(['closing']);
    expect(controller.state).toMatchObject({ kind: 'runtime', phase: 'cleanup-failed' });
    expect(controller.runtimeLifecycle).toBe(lifecycle);
    await expect(lifecycle?.close()).resolves.toBeUndefined();
    expect(phasesAtBackendClose).toEqual(['closing', 'cleanup-failed']);
    expect(createCalls).toBe(1);
  });

  it('turns renderer errors into an immutable runtime preview fallback and isolates throwing subscribers', async () => {
    const client = runtimeClient(Object.freeze({
      closeRuntime: async () => undefined,
      createRuntime: async () => runtimePreview,
      currentDocumentPolicy: () => Object.freeze({ bindingId: runtimePreview.binding.id, snapshot: runtimePreview.documentPolicy }),
    }));
    const controller = createMcpAppPreviewController(runtimeProps(client, () => Object.assign(
      () => { throw new Error('not mounted'); },
      { close: async () => undefined },
    ) as RuntimeAppBridgeFactory));
    const observed: string[] = [];
    controller.subscribe(() => { throw new Error('display failed'); });
    controller.subscribe((state) => { observed.push(state.phase); });
    await controller.start();

    controller.reportRuntimeRendererError(new Error('renderer failed'));
    await Promise.resolve();

    expect(controller.state).toMatchObject({ fallback: { reason: 'preview-error' }, kind: 'runtime', message: 'renderer failed', phase: 'error' });
    expect(observed).toEqual(['loading', 'ready', 'error']);
  });

  it('has an SSR-safe accessible loading boundary and an exact credential-free sandbox iframe', () => {
    const { client } = fakeClient(Promise.resolve(preview()));
    const loading = renderToStaticMarkup(createElement(McpAppPreview, {
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input: Object.freeze({ secret: 'foreground-secret' }),
      result: Object.freeze({}),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    }));
    const sandbox = renderToStaticMarkup(createElement(McpAppPreviewFrame, { frame }));

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain('foreground-secret');
    expect(sandbox).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(sandbox).toContain('src="http://127.0.0.1:43124/#mcp-app-preview"');
    expect(sandbox).toContain('referrerPolicy="no-referrer"');
    expect(sandbox).not.toContain('srcdoc=');
  });

});
