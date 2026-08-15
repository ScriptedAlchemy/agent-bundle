import { expect, it } from '@rstest/core';

import {
  McpAppBindingService,
  type McpAppBinding,
  type McpAppJsonValue,
  type McpAppSessionAuthority,
  type McpAppToolDefinition,
} from '../src/dev/mcp-app-binding-service.ts';
import {
  McpAppPreviewService,
  type McpAppPreviewBindingAuthority,
  type McpAppPreviewToolAuthority,
} from '../src/dev/mcp-app-preview-service.ts';

const originalInput: McpAppJsonValue = { city: 'Paris' };
const originalResult: McpAppJsonValue = { content: [{ text: 'Sunny', type: 'text' }] };

const binding: McpAppBinding = Object.freeze({
  epochId: 'epoch-weather',
  id: 'binding-weather',
  input: originalInput,
  previewProfile: 'portable',
  resourceUri: 'ui://weather/forecast.html',
  result: originalResult,
  serverName: 'weather',
  sessionId: 'session-weather',
  target: 'portable',
  toolDefinition: Object.freeze({
    _meta: Object.freeze({ ui: Object.freeze({ resourceUri: 'ui://weather/forecast.html' }) }),
    inputSchema: Object.freeze({ type: 'object' }),
    name: 'show-weather',
  }),
  toolName: 'show-weather',
});

const host = Object.freeze({
  availableDisplayModes: Object.freeze(['inline', 'fullscreen']),
  containerDimensions: Object.freeze({ height: 360, width: 640 }),
  deviceCapabilities: Object.freeze({ touch: false }),
  displayMode: 'inline',
  locale: 'en-US',
  platform: 'web',
  safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
  styles: Object.freeze({}),
  theme: 'light' as const,
  timeZone: 'UTC',
  toolInfo: Object.freeze({ tool: Object.freeze({ inputSchema: Object.freeze({ type: 'object' }), name: 'show-weather' }) }),
  userAgent: 'agent-bundle-test/1.0',
});

const initialize = Object.freeze({
  id: 'initialize-weather',
  jsonrpc: '2.0' as const,
  method: 'ui/initialize',
  params: {
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    appInfo: { name: 'weather-preview', version: '1.0.0' },
    protocolVersion: '2026-01-26',
  },
});

const initialized = Object.freeze({ jsonrpc: '2.0' as const, method: 'ui/notifications/initialized' });

const resourceResponse = (mimeType = 'text/html;profile=mcp-app'): McpAppJsonValue => ({
  contents: [{
    _meta: { ui: { csp: { connectDomains: ['https://api.weather.test'] }, permissions: { geolocation: {} } } },
    mimeType,
    text: '<main>Forecast</main>',
    uri: 'ui://weather/forecast.html',
  }],
});

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const authorityFor = (options: {
  readonly closeBinding?: () => Promise<boolean>;
  readonly resource?: McpAppJsonValue;
} = {}): McpAppPreviewBindingAuthority => ({
  callTool: async () => ({}),
  closeBinding: options.closeBinding ?? (async () => true),
  createBinding: async () => binding,
  readResource: async () => options.resource ?? resourceResponse(),
});

const toolAuthority: McpAppPreviewToolAuthority = {
  resolveTool: async () => binding.toolDefinition,
};

const serviceFor = (bindingAuthority: McpAppPreviewBindingAuthority, options: {
  readonly closeTimeoutMs?: number;
  readonly host?: { readonly onMessage?: (event: unknown) => Promise<void> | void };
  readonly maxActionBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly maxOutboundMessages?: number;
  readonly maxQueuedActions?: number;
  readonly toolAuthority?: McpAppPreviewToolAuthority;
} = {}) => new McpAppPreviewService({
  bindingAuthority,
  host: options.host,
  hostInfo: { name: 'agent-bundle', version: '0.1.0' },
  hostOrigin: 'http://127.0.0.1:43123',
  sandboxProxy: { origin: 'http://127.0.0.1:43124', relay: { maxMessageBytes: 1_024, maxQueuedMessages: 2 } },
  toolAuthority,
  ...options,
});

const createPreview = (service: McpAppPreviewService) => service.create({
  host,
  input: originalInput,
  previewProfile: 'portable',
  result: originalResult,
  sessionId: 'session-weather',
  toolName: 'show-weather',
});

const actualBindingAuthorityFor = (release: () => Promise<void>) => new McpAppBindingService({
  sessionAuthority: {
    async acquireAppLease() {
      return {
        release,
        session: {
          async callTool() {
            return {};
          },
          identity: { epochId: 'epoch-weather', serverName: 'weather', sessionId: 'session-weather', target: 'portable' },
          async listBridgeResources() {
            return [{ appVisible: true, uri: 'ui://weather/forecast.html' }];
          },
          async listBridgeTools() {
            return [{ appVisible: true, definition: binding.toolDefinition, name: 'show-weather' }];
          },
          async readResource() {
            return resourceResponse();
          },
        },
        watchSessionClosed() {
          return { closed: false, unsubscribe() {} };
        },
      };
    },
  },
});

it('creates one canonical Apps preview from its leased binding resource', async () => {
  const creates: unknown[] = [];
  const reads: Array<{ readonly bindingId: string; readonly uri: string }> = [];
  const authority: McpAppPreviewBindingAuthority = {
    async closeBinding() {
      return true;
    },
    async createBinding(options) {
      creates.push(options);
      return binding;
    },
    async readResource(bindingId, request) {
      reads.push({ bindingId, uri: request.uri });
      return {
        contents: [{
          _meta: { ui: { csp: { connectDomains: ['https://api.weather.test'] }, permissions: { geolocation: {} } } },
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>Forecast</main>',
          uri: 'ui://weather/forecast.html',
        }],
      };
    },
    async callTool() {
      return {};
    },
  };
  const service = new McpAppPreviewService({
    bindingAuthority: authority,
    hostInfo: { name: 'agent-bundle', version: '0.1.0' },
    hostOrigin: 'http://127.0.0.1:43123',
    sandboxProxy: { origin: 'http://127.0.0.1:43124', relay: { maxMessageBytes: 1_024, maxQueuedMessages: 2 } },
    toolAuthority,
  });

  const preview = await service.create({
    host,
    input: originalInput,
    previewProfile: 'portable',
    result: originalResult,
    sessionId: 'session-weather',
    toolName: 'show-weather',
  });

  expect(creates).toEqual([expect.objectContaining({
    input: { city: 'Paris' },
    onTeardown: expect.any(Function),
    previewProfile: 'portable',
    result: { content: [{ text: 'Sunny', type: 'text' }] },
    sessionId: 'session-weather',
    tool: binding.toolDefinition,
  })]);
  expect(reads).toEqual([{ bindingId: 'binding-weather', uri: 'ui://weather/forecast.html' }]);
  expect(preview.binding).toBe(binding);
  expect(preview.profile).toMatchObject({
    kind: 'apps',
    permissions: {},
    resourceUri: 'ui://weather/forecast.html',
  });
  expect(preview.resource).toEqual({
    csp: { connectDomains: ['https://api.weather.test'] },
    html: '<main>Forecast</main>',
    kind: 'resource',
    permissions: { geolocation: {} },
  });
  expect(preview.frame).toMatchObject({
    allow: '',
    sandbox: 'allow-scripts allow-same-origin',
    targetOrigin: 'http://127.0.0.1:43124',
  });
});

it('replaces browser toolInfo with the canonical leased tool definition', async () => {
  const service = serviceFor(authorityFor());
  const forgedHost = {
    ...host,
    toolInfo: { tool: { inputSchema: { type: 'object' }, name: 'browser-forged-tool' } },
  };
  await service.create({
    host: forgedHost,
    input: originalInput,
    previewProfile: 'portable',
    result: originalResult,
    sessionId: 'session-weather',
    toolName: 'show-weather',
  });

  await service.receive(binding.id, initialize);
  expect(await service.takeOutbound(binding.id)).toMatchObject([{
    id: 'initialize-weather',
    result: { hostContext: { toolInfo: { tool: binding.toolDefinition } } },
  }]);
});

it('composes with the real binding service using its canonical tool definition contract', async () => {
  let lists = 0;
  let releases = 0;
  const sessionAuthority: McpAppSessionAuthority = {
    async acquireAppLease(sessionId) {
      expect(sessionId).toBe('session-weather');
      return {
        async release() {
          releases += 1;
        },
        session: {
          async callTool() {
            return {};
          },
          identity: { epochId: 'epoch-weather', serverName: 'weather', sessionId: 'session-weather', target: 'portable' },
          async listBridgeResources() {
            return [{ appVisible: true, uri: 'ui://weather/forecast.html' }];
          },
          async listBridgeTools() {
            lists += 1;
            return [{ appVisible: true, definition: binding.toolDefinition, name: 'show-weather' }];
          },
          async readResource() {
            return resourceResponse();
          },
        },
        watchSessionClosed() {
          return { closed: false, unsubscribe() {} };
        },
      };
    },
  };
  const bindingService = new McpAppBindingService({ sessionAuthority });
  const service = serviceFor(bindingService, { toolAuthority });

  const preview = await createPreview(service);

  expect(preview.binding.toolDefinition).toEqual(binding.toolDefinition);
  expect(lists).toBe(1);
  expect(await service.forceClose(preview.binding.id)).toBe(true);
  expect(releases).toBe(1);
});

it('releases the real binding lease exactly once when a session closes during resource loading', async () => {
  const load = deferred<McpAppJsonValue>();
  const readStarted = deferred<void>();
  let releaseCount = 0;
  let closeSession: (() => Promise<void>) | undefined;
  const sessionAuthority: McpAppSessionAuthority = {
    async acquireAppLease() {
      return {
        async release() {
          releaseCount += 1;
        },
        session: {
          async callTool() {
            return {};
          },
          identity: { epochId: 'epoch-weather', serverName: 'weather', sessionId: 'session-weather', target: 'portable' },
          async listBridgeResources() {
            return [{ appVisible: true, uri: 'ui://weather/forecast.html' }];
          },
          async listBridgeTools() {
            return [{ appVisible: true, definition: binding.toolDefinition, name: 'show-weather' }];
          },
          async readResource() {
            readStarted.resolve();
            return load.promise;
          },
        },
        watchSessionClosed(listener) {
          closeSession = async () => {
            await listener('session-closed');
          };
          return { closed: false, unsubscribe() {} };
        },
      };
    },
  };
  const service = serviceFor(new McpAppBindingService({ sessionAuthority }), { toolAuthority });
  const creating = createPreview(service);
  await readStarted.promise;
  if (closeSession === undefined) throw new Error('expected a session close listener');
  await closeSession();
  load.resolve(resourceResponse());

  await expect(creating).rejects.toThrow('closed before completion');
  expect(releaseCount).toBe(1);
  expect(service.get(binding.id)).toBeUndefined();
});

it('keeps ordinary fallback usable when the canonical resource lacks the exact Apps MIME type', async () => {
  const service = serviceFor(authorityFor({ resource: resourceResponse('text/html') }));
  const preview = await createPreview(service);

  expect(preview.profile).toMatchObject({ kind: 'fallback', reason: 'apps-resource-invalid' });
  expect(preview.resource).toMatchObject({ kind: 'fallback', reason: 'invalid-resource' });
  expect(preview.frame).toBeUndefined();
  expect(service.get(binding.id)).toBe(preview);
});

it('rejects legacy-only resource metadata before it can create a preview', async () => {
  const legacyBinding: McpAppBinding = {
    ...binding,
    toolDefinition: { _meta: { 'openai/outputTemplate': 'ui://weather/legacy.html' }, name: 'show-weather' },
  };
  let releases = 0;
  const authority: McpAppPreviewBindingAuthority = {
    callTool: async () => ({}),
    closeBinding: async () => {
      releases += 1;
      return true;
    },
    createBinding: async () => legacyBinding,
    readResource: async () => resourceResponse(),
  };

  await expect(createPreview(serviceFor(authority))).rejects.toThrow('canonical standard _meta.ui.resourceUri');
  expect(releases).toBe(1);
});

it('preserves input-result FIFO order across one bounded outbound slot', async () => {
  const service = serviceFor(authorityFor(), { maxOutboundMessages: 1 });
  const preview = await createPreview(service);

  expect(await service.receive(binding.id, initialize)).toBe(true);
  expect((await service.takeOutbound(binding.id)).map((message) => message.id)).toEqual(['initialize-weather']);
  expect(await service.receive(binding.id, initialized)).toBe(true);
  expect((await service.takeOutbound(binding.id)).map((message) => message.method)).toEqual(['ui/notifications/tool-input']);
  expect((await service.takeOutbound(binding.id)).map((message) => message.method)).toEqual(['ui/notifications/tool-result']);
  expect(preview.bridge.lifecycle).toBe('initialized');
});

it('creates document permission challenges server-side and remounts only after an approved exact decision', async () => {
  const service = serviceFor(authorityFor());
  const preview = await createPreview(service);
  expect(preview.frame?.allow).toBe('');
  const challenge = service.consentChallenges(binding.id)?.find((candidate) => candidate.request.capability === 'geolocation');
  expect(challenge).toBeDefined();
  expect(service.decideConsent(binding.id, 'forged-camera', true)).toBeUndefined();
  expect(service.get(binding.id)?.frame?.allow).toBe('');
  expect(service.decideConsent(binding.id, challenge?.id ?? '', true)).toMatchObject({ capability: 'geolocation', scope: 'document' });
  expect(service.get(binding.id)?.frame?.allow).toBe('geolocation');
});

it('reuses outbound byte capacity after each drain', async () => {
  const service = serviceFor(authorityFor(), { maxOutboundBytes: 2_048 });
  await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);

  for (let index = 0; index < 48; index += 1) {
    const id = `ping-${index}`;
    expect(await service.receive(binding.id, { id, jsonrpc: '2.0', method: 'ping' })).toBe(true);
    expect((await service.takeOutbound(binding.id)).map((message) => message.id)).toEqual([id]);
  }
});

it('removes a preview and rejects subsequent actions when its leased binding closes', async () => {
  let teardown: (() => void) | undefined;
  const authority: McpAppPreviewBindingAuthority = {
    async callTool() {
      return {};
    },
    async closeBinding() {
      return false;
    },
    async createBinding(options) {
      teardown = () => void options.onTeardown?.({ binding, reason: 'session-closed' });
      return binding;
    },
    async readResource() {
      return resourceResponse();
    },
  };
  const service = serviceFor(authority);
  await createPreview(service);
  teardown?.();

  expect(service.get(binding.id)).toBeUndefined();
  expect(await service.receive(binding.id, initialize)).toBe(false);
  expect(await service.takeOutbound(binding.id)).toEqual([]);
});

it('does not publish a fallback when the leased binding closes during a resource read', async () => {
  const load = deferred<McpAppJsonValue>();
  const readStarted = deferred<void>();
  let teardown: (() => void) | undefined;
  const authority: McpAppPreviewBindingAuthority = {
    callTool: async () => ({}),
    closeBinding: async () => false,
    createBinding: async (options) => {
      teardown = () => void options.onTeardown?.({ binding, reason: 'session-closed' });
      return binding;
    },
    readResource: async () => {
      readStarted.resolve();
      return load.promise;
    },
  };
  const service = serviceFor(authority);
  const creating = createPreview(service);
  await readStarted.promise;
  teardown?.();
  load.resolve(resourceResponse());

  await expect(creating).rejects.toThrow('closed before completion');
  expect(service.get(binding.id)).toBeUndefined();
});

it('reports release failures together while retaining the failed preview for retry', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      throw new Error(`close ${closes}`);
    },
  }));
  await createPreview(service);

  const firstClose = service.closeAll();
  const secondClose = service.closeAll();
  await expect(firstClose).rejects.toThrow('MCP App preview shutdown failed.');
  await expect(secondClose).rejects.toThrow('MCP App preview shutdown failed.');
  expect(service.get(binding.id)).toBeDefined();
  expect(closes).toBe(1);
});

it('bounds queued App actions while preserving the active action', async () => {
  let completeMessage: (() => void) | undefined;
  const service = serviceFor(authorityFor(), {
    host: {
      onMessage: () => new Promise<void>((resolve) => {
        completeMessage = resolve;
      }),
    },
    maxQueuedActions: 1,
  });
  await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);
  await service.takeOutbound(binding.id);
  const message = (id: string) => ({
    id,
    jsonrpc: '2.0' as const,
    method: 'ui/message',
    params: { content: [{ text: 'Show details', type: 'text' }], role: 'user' },
  });

  const active = service.receive(binding.id, message('message-active'));
  await Promise.resolve();
  expect(await service.receive(binding.id, message('message-rejected'))).toBe(false);
  completeMessage?.();
  expect(await active).toBe(true);
  expect((await service.takeOutbound(binding.id)).map((outbound) => outbound.id)).toEqual(['message-active']);
});

it('force closes and releases a binding without waiting for a hung serialized action', async () => {
  const message = deferred<void>();
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return true;
    },
  }), {
    host: { onMessage: () => message.promise },
  });
  await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);
  const active = service.receive(binding.id, {
    id: 'message-hung',
    jsonrpc: '2.0',
    method: 'ui/message',
    params: { content: [{ text: 'Wait', type: 'text' }], role: 'user' },
  });
  await Promise.resolve();

  await expect(service.forceClose(binding.id)).resolves.toBe(true);
  expect(closes).toBe(1);
  expect(service.get(binding.id)).toBeUndefined();
  message.resolve();
  expect(await active).toBe(false);
});

it('closeAll releases a binding without waiting for a hung serialized action', async () => {
  const message = deferred<void>();
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return true;
    },
  }), {
    host: { onMessage: () => message.promise },
  });
  await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);
  const active = service.receive(binding.id, {
    id: 'message-hung-close-all',
    jsonrpc: '2.0',
    method: 'ui/message',
    params: { content: [{ text: 'Wait', type: 'text' }], role: 'user' },
  });
  await Promise.resolve();

  await expect(service.closeAll()).resolves.toBeUndefined();
  expect(closes).toBe(1);
  message.resolve();
  expect(await active).toBe(false);
});

it('coalesces concurrent graceful and force close into one binding release', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return true;
    },
  }));
  await createPreview(service);

  const graceful = service.close(binding.id, { id: 'close-weather' });
  const forced = service.forceClose(binding.id);

  await expect(Promise.all([graceful, forced])).resolves.toEqual([true, true]);
  expect(closes).toBe(1);
  expect(service.get(binding.id)).toBeUndefined();
});

it('keeps a graceful close routable until its resource-teardown acknowledgment releases the binding', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return true;
    },
  }));
  const preview = await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);

  expect(await service.close(binding.id, { id: 'teardown-weather' })).toMatchObject({
    id: 'teardown-weather',
    method: 'ui/resource-teardown',
  });
  expect(service.get(binding.id)).toBe(preview);
  expect(await service.takeOutbound(binding.id)).toEqual([]);
  expect(await service.receive(binding.id, { id: 'teardown-weather', jsonrpc: '2.0', result: {} })).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(closes).toBe(1);
  expect(service.get(binding.id)).toBeUndefined();
});

it('reserves one route-owned teardown frame when ordinary outbound traffic has filled its queue', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return true;
    },
  }), { maxOutboundMessages: 1 });
  const preview = await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, { id: 'queued-ping', jsonrpc: '2.0', method: 'ping' });

  const teardown = await service.close(binding.id, { id: 'teardown-reserved' });

  expect(teardown).toMatchObject({
    id: 'teardown-reserved',
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
  });
  expect(service.get(binding.id)).toBe(preview);
  expect(await service.takeOutbound(binding.id)).toEqual([{
    id: 'queued-ping',
    jsonrpc: '2.0',
    result: {},
  }]);
  expect(await service.receive(binding.id, { id: 'teardown-reserved', jsonrpc: '2.0', result: {} })).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(closes).toBe(1);
  expect(service.get(binding.id)).toBeUndefined();
});

it('awaits a delayed real lease release before reporting a one-slot teardown acknowledgment', async () => {
  const releaseStarted = deferred<void>();
  const releaseComplete = deferred<void>();
  let releases = 0;
  const service = serviceFor(actualBindingAuthorityFor(async () => {
    releases += 1;
    releaseStarted.resolve();
    await releaseComplete.promise;
  }), { maxOutboundMessages: 1 });
  const preview = await createPreview(service);
  await service.receive(preview.binding.id, initialize);
  await service.takeOutbound(preview.binding.id);
  await service.receive(preview.binding.id, initialized);
  await service.takeOutbound(preview.binding.id);
  await service.takeOutbound(preview.binding.id);
  await service.receive(preview.binding.id, { id: 'queued-ping', jsonrpc: '2.0', method: 'ping' });
  expect(await service.close(preview.binding.id, { id: 'teardown-delayed-release' })).toMatchObject({
    id: 'teardown-delayed-release',
    method: 'ui/resource-teardown',
  });

  const acknowledgment = service.receive(preview.binding.id, { id: 'teardown-delayed-release', jsonrpc: '2.0', result: {} });
  const duplicateAcknowledgment = service.receive(preview.binding.id, { id: 'teardown-delayed-release', jsonrpc: '2.0', result: {} });
  let acknowledged = false;
  void acknowledgment.then(() => {
    acknowledged = true;
  });
  await releaseStarted.promise;

  expect(acknowledged).toBe(false);
  expect(service.get(preview.binding.id)).toBe(preview);
  releaseComplete.resolve();
  await expect(acknowledgment).resolves.toBe(true);
  await expect(duplicateAcknowledgment).resolves.toBe(false);
  expect(releases).toBe(1);
  expect(preview.bridge.lifecycle).toBe('closed');
  expect(service.get(preview.binding.id)).toBeUndefined();
  expect(await service.takeOutbound(preview.binding.id)).toEqual([]);
});

it('reports a real failed one-slot teardown release as retryable before force close', async () => {
  let releases = 0;
  const service = serviceFor(actualBindingAuthorityFor(async () => {
    releases += 1;
    if (releases === 1) throw new Error('first release fails');
  }), { maxOutboundMessages: 1 });
  const preview = await createPreview(service);
  await service.receive(preview.binding.id, initialize);
  await service.takeOutbound(preview.binding.id);
  await service.receive(preview.binding.id, initialized);
  await service.takeOutbound(preview.binding.id);
  await service.takeOutbound(preview.binding.id);
  await service.receive(preview.binding.id, { id: 'queued-ping', jsonrpc: '2.0', method: 'ping' });
  expect(await service.close(preview.binding.id, { id: 'teardown-failed-release' })).toMatchObject({
    id: 'teardown-failed-release',
    method: 'ui/resource-teardown',
  });

  const acknowledgment = service.receive(preview.binding.id, { id: 'teardown-failed-release', jsonrpc: '2.0', result: {} });
  const duplicateAcknowledgment = service.receive(preview.binding.id, { id: 'teardown-failed-release', jsonrpc: '2.0', result: {} });

  await expect(acknowledgment).resolves.toBe(true);
  await expect(duplicateAcknowledgment).resolves.toBe(false);

  expect(releases).toBe(1);
  expect(preview.bridge.lifecycle).toBe('closing');
  expect(service.get(preview.binding.id)).toBe(preview);
  expect(await service.takeOutbound(preview.binding.id)).toEqual([{
    id: 'queued-ping',
    jsonrpc: '2.0',
    result: {},
  }]);
  await expect(service.forceClose(preview.binding.id)).resolves.toBe(true);
  expect(releases).toBe(2);
  expect(service.get(preview.binding.id)).toBeUndefined();
});

it('waits afresh for a late acknowledgment after graceful close has timed out', async () => {
  const releaseStarted = deferred<void>();
  const releaseComplete = deferred<void>();
  const service = serviceFor(actualBindingAuthorityFor(async () => {
    releaseStarted.resolve();
    await releaseComplete.promise;
  }), { closeTimeoutMs: 20, maxOutboundMessages: 1 });
  const preview = await createPreview(service);
  await service.receive(preview.binding.id, initialize);
  await service.takeOutbound(preview.binding.id);
  await service.receive(preview.binding.id, initialized);
  await service.takeOutbound(preview.binding.id);
  await service.takeOutbound(preview.binding.id);
  expect(await service.close(preview.binding.id, { id: 'teardown-late-ack' })).toMatchObject({
    id: 'teardown-late-ack',
    method: 'ui/resource-teardown',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  const acknowledgment = service.receive(preview.binding.id, { id: 'teardown-late-ack', jsonrpc: '2.0', result: {} });
  const duplicateAcknowledgment = service.receive(preview.binding.id, { id: 'teardown-late-ack', jsonrpc: '2.0', result: {} });
  let acknowledged = false;
  void acknowledgment.then(() => {
    acknowledged = true;
  });
  await releaseStarted.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 5));

  expect(acknowledged).toBe(false);
  expect(service.get(preview.binding.id)).toBe(preview);
  releaseComplete.resolve();
  await expect(acknowledgment).resolves.toBe(true);
  await expect(duplicateAcknowledgment).resolves.toBe(false);
  expect(preview.bridge.lifecycle).toBe('closed');
  expect(service.get(preview.binding.id)).toBeUndefined();
});

it('bounds a late acknowledgment release while keeping force close retryable', async () => {
  const releaseStarted = deferred<void>();
  const releaseComplete = deferred<void>();
  const service = serviceFor(actualBindingAuthorityFor(async () => {
    releaseStarted.resolve();
    await releaseComplete.promise;
  }), { closeTimeoutMs: 20, maxOutboundMessages: 1 });
  const preview = await createPreview(service);
  await service.receive(preview.binding.id, initialize);
  await service.takeOutbound(preview.binding.id);
  await service.receive(preview.binding.id, initialized);
  await service.takeOutbound(preview.binding.id);
  await service.takeOutbound(preview.binding.id);
  expect(await service.close(preview.binding.id, { id: 'teardown-bounded-late-ack' })).toMatchObject({
    id: 'teardown-bounded-late-ack',
    method: 'ui/resource-teardown',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  const acknowledgment = service.receive(preview.binding.id, { id: 'teardown-bounded-late-ack', jsonrpc: '2.0', result: {} });
  const duplicateAcknowledgment = service.receive(preview.binding.id, { id: 'teardown-bounded-late-ack', jsonrpc: '2.0', result: {} });
  let acknowledged = false;
  void acknowledgment.then(() => {
    acknowledged = true;
  });
  await releaseStarted.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(acknowledged).toBe(false);
  await expect(acknowledgment).resolves.toBe(true);
  await expect(duplicateAcknowledgment).resolves.toBe(false);

  expect(preview.bridge.lifecycle).toBe('closing');
  expect(service.get(preview.binding.id)).toBe(preview);
  const forced = service.forceClose(preview.binding.id);
  releaseComplete.resolve();
  await expect(forced).resolves.toBe(true);
  expect(preview.bridge.lifecycle).toBe('closed');
  expect(service.get(preview.binding.id)).toBeUndefined();
});

it('keeps a timed out graceful close retryable for an authoritative force close', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return true;
    },
  }), { closeTimeoutMs: 20 });
  const preview = await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);

  expect(await service.close(binding.id, { id: 'teardown-timeout' })).toMatchObject({
    id: 'teardown-timeout',
    method: 'ui/resource-teardown',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  expect(service.get(binding.id)).toBe(preview);
  await expect(service.forceClose(binding.id)).resolves.toBe(true);
  expect(closes).toBe(1);
  expect(service.get(binding.id)).toBeUndefined();
});

it('keeps a rejected graceful release retryable for an authoritative force close', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      return closes > 1;
    },
  }));
  const preview = await createPreview(service);
  await service.receive(binding.id, initialize);
  await service.takeOutbound(binding.id);
  await service.receive(binding.id, initialized);
  await service.takeOutbound(binding.id);

  expect(await service.close(binding.id, { id: 'teardown-release-failure' })).toMatchObject({
    id: 'teardown-release-failure',
    method: 'ui/resource-teardown',
  });
  expect(await service.receive(binding.id, { id: 'teardown-release-failure', jsonrpc: '2.0', result: {} })).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(closes).toBe(1);
  expect(service.get(binding.id)).toBe(preview);
  await expect(service.forceClose(binding.id)).resolves.toBe(true);
  expect(closes).toBe(2);
  expect(service.get(binding.id)).toBeUndefined();
});

it('bounds closeAll while tracking a blocked create and prevents its later publication', async () => {
  const resolvingTool = deferred<McpAppToolDefinition>();
  const toolStarted = deferred<void>();
  const service = serviceFor(authorityFor(), {
    closeTimeoutMs: 20,
    toolAuthority: {
      resolveTool: async () => {
        toolStarted.resolve();
        return resolvingTool.promise;
      },
    },
  });
  const creating = createPreview(service);
  await toolStarted.promise;

  await expect(service.closeAll()).rejects.toThrow('MCP App preview shutdown failed.');
  resolvingTool.resolve(binding.toolDefinition);
  await expect(creating).rejects.toThrow('closed before completion');
  expect(service.get(binding.id)).toBeUndefined();
});

it('aggregates a late binding release failure after closeAll has already aborted creation', async () => {
  for (const releaseFailure of [false, new Error('release rejected')]) {
    const bindingStarted = deferred<void>();
    const delayedBinding = deferred<McpAppBinding>();
    let releases = 0;
    const authority: McpAppPreviewBindingAuthority = {
      callTool: async () => ({}),
      closeBinding: async () => {
        releases += 1;
        if (releaseFailure instanceof Error) throw releaseFailure;
        return releaseFailure;
      },
      createBinding: async () => {
        bindingStarted.resolve();
        return delayedBinding.promise;
      },
      readResource: async () => resourceResponse(),
    };
    const service = serviceFor(authority, { closeTimeoutMs: 100 });
    const creating = createPreview(service);
    await bindingStarted.promise;
    const closing = service.closeAll();
    delayedBinding.resolve(binding);

    const closeFailure = await closing.catch((error: unknown) => error);
    expect(closeFailure).toBeInstanceOf(AggregateError);
    expect((closeFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'MCP App preview creation release failed for binding "binding-weather".' }),
    ]);
    await expect(creating).rejects.toThrow('closed before completion');
    expect(releases).toBe(1);
    expect(service.get(binding.id)).toBeUndefined();
  }
});
