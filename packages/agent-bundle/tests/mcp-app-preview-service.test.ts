import { expect, it } from '@rstest/core';

import type { McpAppBinding, McpAppJsonValue } from '../src/dev/mcp-app-binding-service.ts';
import {
  McpAppPreviewService,
  type McpAppPreviewBindingAuthority,
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

const authorityFor = (options: {
  readonly closeBinding?: () => Promise<boolean>;
  readonly resource?: McpAppJsonValue;
} = {}): McpAppPreviewBindingAuthority => ({
  callTool: async () => ({}),
  closeBinding: options.closeBinding ?? (async () => true),
  createBinding: async () => binding,
  readResource: async () => options.resource ?? resourceResponse(),
});

const serviceFor = (bindingAuthority: McpAppPreviewBindingAuthority, options: {
  readonly host?: { readonly onMessage?: (event: unknown) => Promise<void> | void };
  readonly maxActionBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly maxOutboundMessages?: number;
  readonly maxQueuedActions?: number;
} = {}) => new McpAppPreviewService({
  bindingAuthority,
  host: options.host,
  hostInfo: { name: 'agent-bundle', version: '0.1.0' },
  hostOrigin: 'http://127.0.0.1:43123',
  sandboxProxy: { origin: 'http://127.0.0.1:43124', relay: { maxMessageBytes: 1_024, maxQueuedMessages: 2 } },
  ...options,
});

const createPreview = (service: McpAppPreviewService) => service.create({
  consent: { permissions: { geolocation: {} } },
  host,
  input: originalInput,
  previewProfile: 'portable',
  result: originalResult,
  sessionId: 'session-weather',
  toolName: 'show-weather',
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
  });

  const preview = await service.create({
    consent: { permissions: { geolocation: {} } },
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
    toolName: 'show-weather',
  })]);
  expect(reads).toEqual([{ bindingId: 'binding-weather', uri: 'ui://weather/forecast.html' }]);
  expect(preview.binding).toBe(binding);
  expect(preview.profile).toMatchObject({
    kind: 'apps',
    permissions: { geolocation: {} },
    resourceUri: 'ui://weather/forecast.html',
  });
  expect(preview.resource).toEqual({
    csp: { connectDomains: ['https://api.weather.test'] },
    html: '<main>Forecast</main>',
    kind: 'resource',
    permissions: { geolocation: {} },
  });
  expect(preview.frame).toMatchObject({
    allow: 'geolocation',
    sandbox: 'allow-scripts allow-same-origin',
    targetOrigin: 'http://127.0.0.1:43124',
  });
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

it('drains every preview and reports all release failures together', async () => {
  let closes = 0;
  const service = serviceFor(authorityFor({
    closeBinding: async () => {
      closes += 1;
      throw new Error(`close ${closes}`);
    },
  }));
  await createPreview(service);

  await expect(service.closeAll()).rejects.toThrow('MCP App preview shutdown failed.');
  expect(service.get(binding.id)).toBeUndefined();
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
