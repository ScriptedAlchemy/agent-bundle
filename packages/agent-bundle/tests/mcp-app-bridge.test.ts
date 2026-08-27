import { Buffer } from 'node:buffer';

import { expect, it } from '@rstest/core';

import {
  createMcpAppBridge,
  type McpAppBridgeBindingOperations,
  type McpAppBridgeHost,
  type McpAppBridgeMessage,
  type McpAppBridgeRequestId,
} from '../src/dev/mcp-apps/mcp-app-bridge.ts';
import type { McpAppBinding, McpAppJsonValue } from '../src/dev/mcp-apps/mcp-app-binding-service.ts';

interface BridgeFixture {
  readonly binding: McpAppBinding;
  readonly calls: Array<{ readonly arguments: McpAppJsonValue | undefined; readonly bindingId: string; readonly name: string }>;
  readonly closes: string[];
  readonly reads: Array<{ readonly bindingId: string; readonly uri: string }>;
  readonly sent: McpAppBridgeMessage[];
  readonly host: McpAppBridgeHost;
  readonly operations: McpAppBridgeBindingOperations;
}

const bindingFor = (overrides: Partial<McpAppBinding> = {}): McpAppBinding => ({
  epochId: 'epoch-app',
  id: 'binding-app',
  input: { city: 'Paris', units: 'metric' },
  previewProfile: 'portable',
  resourceUri: 'ui://weather/forecast.html',
  result: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } },
  serverName: 'weather',
  sessionId: 'session-weather',
  target: 'portable',
  toolDefinition: {
    _meta: { ui: { resourceUri: 'ui://weather/forecast.html' } },
    inputSchema: { type: 'object' },
    name: 'show-weather',
  },
  toolName: 'show-weather',
  ...overrides,
});

const fixtureFor = (options: {
  readonly binding?: McpAppBinding;
  readonly host?: Partial<McpAppBridgeHost>;
  readonly resource?: McpAppJsonValue;
} = {}): BridgeFixture => {
  const calls: Array<{ arguments: McpAppJsonValue | undefined; bindingId: string; name: string }> = [];
  const closes: string[] = [];
  const reads: Array<{ bindingId: string; uri: string }> = [];
  const sent: McpAppBridgeMessage[] = [];
  const defaultResource: McpAppJsonValue = {
    contents: [{
      _meta: { ui: { csp: { connectDomains: ['https://api.weather.test'] }, permissions: { geolocation: {} } } },
      mimeType: 'text/html;profile=mcp-app',
      text: '<main>forecast</main>',
      uri: 'ui://weather/forecast.html',
    }],
  };
  const host: McpAppBridgeHost = {
    capabilities: { openLinks: {}, serverResources: {}, serverTools: {} },
    context: { availableDisplayModes: ['inline', 'fullscreen'], displayMode: 'inline', theme: 'light' },
    info: { name: 'agent-bundle', version: '0.1.0' },
    onDisplayMode: async (mode) => mode === 'fullscreen' ? 'fullscreen' : 'inline',
    onLog: async () => undefined,
    onMessage: async () => ({ isError: false }),
    onModelContext: async () => undefined,
    onOpenLink: async () => undefined,
    onSizeChanged: async () => undefined,
    ...options.host,
  };
  const operations: McpAppBridgeBindingOperations = {
    callTool: async (bindingId, request) => {
      calls.push({ arguments: request.arguments, bindingId, name: request.name });
      return { content: [{ text: `called ${request.name}`, type: 'text' }] };
    },
    closeBinding: async (bindingId) => {
      closes.push(bindingId);
      return true;
    },
    readResource: async (bindingId, request) => {
      reads.push({ bindingId, ...request });
      return options.resource ?? defaultResource;
    },
  };
  return { binding: options.binding ?? bindingFor(), calls, closes, host, operations, reads, sent };
};

const initialize = (id: McpAppBridgeRequestId): McpAppBridgeMessage => ({
  id,
  jsonrpc: '2.0',
  method: 'ui/initialize',
  params: {
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    appInfo: { name: 'weather-view', version: '1.0.0' },
    protocolVersion: '2026-01-26',
  },
});

const initialized = (): McpAppBridgeMessage => ({
  jsonrpc: '2.0',
  method: 'ui/notifications/initialized',
  params: {},
});

it('preserves the stable Apps handshake and delays original tool data until initialized', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => {
      fixture.sent.push(message);
      return true;
    },
  });

  expect(bridge.publishToolInputPartial({ city: 'Par' })).toBe(true);
  expect(fixture.sent).toEqual([]);
  expect(await bridge.receive(initialize('init:weather'))).toBe(true);
  expect(fixture.sent).toEqual([{
    id: 'init:weather',
    jsonrpc: '2.0',
    result: {
      hostCapabilities: { openLinks: {}, serverResources: {}, serverTools: {} },
      hostContext: { availableDisplayModes: ['inline', 'fullscreen'], displayMode: 'inline', theme: 'light' },
      hostInfo: { name: 'agent-bundle', version: '0.1.0' },
      protocolVersion: '2026-01-26',
    },
  }]);

  expect(await bridge.receive(initialized())).toBe(true);
  expect(fixture.sent).toEqual([
    fixture.sent[0]!,
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input-partial', params: { arguments: { city: 'Par' } } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris', units: 'metric' } } },
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } },
    },
  ]);
  expect(bridge.publishToolInputPartial({ city: 'Paris' })).toBe(false);
  expect(bridge.lifecycle).toBe('initialized');
});

it('accepts the stable parameterless initialized notification before flushing host traffic', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });

  expect(bridge.publishToolInputPartial({ city: 'Par' })).toBe(true);
  await bridge.receive(initialize('init:no-params'));
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })).toBe(true);
  expect(fixture.sent.slice(-3)).toEqual([
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input-partial', params: { arguments: { city: 'Par' } } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris', units: 'metric' } } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } } },
  ]);
});

it('keeps blocked host traffic in FIFO order until the transport is explicitly flushed', async () => {
  const fixture = fixtureFor();
  let accepting = true;
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => {
      if (!accepting) return false;
      fixture.sent.push(message);
      return true;
    },
  });

  expect(bridge.publishToolInputPartial({ city: 'Par' })).toBe(true);
  await bridge.receive(initialize('init:backpressure'));
  accepting = false;
  await bridge.receive(initialized());
  expect(bridge.publishHostContextChanged({ theme: 'dark' })).toBe(true);
  expect(fixture.sent).toHaveLength(1);

  accepting = true;
  expect(bridge.flushHostTraffic()).toBe(true);
  expect(fixture.sent.slice(-4)).toEqual([
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input-partial', params: { arguments: { city: 'Par' } } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris', units: 'metric' } } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } } },
    { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
  ]);
});

it('does not let later host notifications overtake a blocked app request response', async () => {
  const fixture = fixtureFor();
  let accepting = true;
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => {
      if (!accepting) return false;
      fixture.sent.push(message);
      return true;
    },
  });
  await bridge.receive(initialize('init:response-backpressure'));
  await bridge.receive(initialized());

  accepting = false;
  expect(await bridge.receive({ id: 'blocked-ping', jsonrpc: '2.0', method: 'ping' })).toBe(true);
  expect(bridge.publishHostContextChanged({ theme: 'dark' })).toBe(true);
  accepting = true;

  expect(bridge.flushHostTraffic()).toBe(true);
  expect(fixture.sent.slice(-2)).toEqual([
    { id: 'blocked-ping', jsonrpc: '2.0', result: {} },
    { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
  ]);
});

it('rejects malformed stable app-info icons before starting the handshake', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });

  expect(await bridge.receive({
    id: 'bad-app-icon',
    jsonrpc: '2.0',
    method: 'ui/initialize',
    params: {
      appCapabilities: {},
      appInfo: { icons: [{ sizes: ['64x64'], src: 42 }], name: 'weather-view', version: '1.0.0' },
      protocolVersion: '2026-01-26',
    },
  })).toBe(true);
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32602, message: 'ui/initialize requires protocol version 2026-01-26.' },
    id: 'bad-app-icon',
    jsonrpc: '2.0',
  });
  expect(bridge.lifecycle).toBe('created');
});

it('rejects malformed content annotations and resource-link icons before invoking the message callback', async () => {
  let messages = 0;
  const fixture = fixtureFor({ host: { onMessage: async () => { messages += 1; } } });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:nested-content'));
  await bridge.receive(initialized());

  expect(await bridge.receive({
    id: 'bad-content-nesting',
    jsonrpc: '2.0',
    method: 'ui/message',
    params: {
      content: [{
        annotations: { audience: ['user'], priority: 2 },
        icons: [{ src: 'https://weather.example.test/icon.svg', theme: 'neon' }],
        name: 'forecast',
        type: 'resource_link',
        uri: 'resource://weather/forecast',
      }],
      role: 'user',
    },
  })).toBe(true);
  expect(messages).toBe(0);
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32602, message: 'ui/message requires a user role and valid MCP content blocks.' },
    id: 'bad-content-nesting',
    jsonrpc: '2.0',
  });
});

it('requires stable annotation timestamps to include an ISO offset', async () => {
  let messages = 0;
  const fixture = fixtureFor({ host: { onMessage: async () => { messages += 1; } } });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:annotation-offset'));
  await bridge.receive(initialized());

  await bridge.receive({
    id: 'bad-annotation-offset',
    jsonrpc: '2.0',
    method: 'ui/message',
    params: { content: [{ annotations: { lastModified: '2026-01-01T00:00:00' }, text: 'Forecast', type: 'text' }], role: 'user' },
  });

  expect(messages).toBe(0);
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32602, message: 'ui/message requires a user role and valid MCP content blocks.' },
    id: 'bad-annotation-offset',
    jsonrpc: '2.0',
  });
});

it('rejects host tool metadata whose JSON Schemas are not object-rooted', () => {
  const fixture = fixtureFor({
    host: {
      context: {
        toolInfo: {
          id: 'call:weather',
          tool: { inputSchema: { type: 'array' }, name: 'show-weather', outputSchema: { type: 'string' } },
        },
      },
    },
  });

  expect(() => createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: () => true })).toThrow('MCP App host context must use stable MCP Apps field values.');
});

it('forwards only same-binding app-visible tools and resources while retaining request ids', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => {
      fixture.sent.push(message);
      return true;
    },
  });
  await bridge.receive(initialize('init:interactive'));
  await bridge.receive(initialized());

  expect(await bridge.receive({
    id: null,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { city: 'Lyon' }, name: 'refresh-weather' },
  })).toBe(true);
  expect(await bridge.receive({
    id: 0,
    jsonrpc: '2.0',
    method: 'resources/read',
    params: { uri: 'resource://weather/forecast' },
  })).toBe(true);
  expect(await bridge.receive({ id: 2, jsonrpc: '2.0', method: 'ping', params: {} })).toBe(true);

  expect(fixture.calls).toEqual([{ arguments: { city: 'Lyon' }, bindingId: 'binding-app', name: 'refresh-weather' }]);
  expect(fixture.reads).toEqual([{ bindingId: 'binding-app', uri: 'resource://weather/forecast' }]);
  expect(fixture.sent.slice(-3)).toEqual([
    { id: null, jsonrpc: '2.0', result: { content: [{ text: 'called refresh-weather', type: 'text' }] } },
    { id: 0, jsonrpc: '2.0', result: { contents: [{
      _meta: { ui: { csp: { connectDomains: ['https://api.weather.test'] }, permissions: { geolocation: {} } } },
      mimeType: 'text/html;profile=mcp-app', text: '<main>forecast</main>', uri: 'ui://weather/forecast.html',
    }] } },
    { id: 2, jsonrpc: '2.0', result: {} },
  ]);
});

it('handles standard host actions and rejects malformed app requests without forwarding them', async () => {
  const seen: string[] = [];
  const fixture = fixtureFor({
    host: {
      onDisplayMode: async (mode) => {
        seen.push(`display:${mode}`);
        return 'fullscreen' as const;
      },
      onLog: async (event) => {
        seen.push(`log:${event.level}`);
      },
      onMessage: async (event) => {
        seen.push(`message:${event.role}`);
        return { isError: false };
      },
      onModelContext: async () => {
        seen.push('context');
      },
      onOpenLink: async (url) => {
        seen.push(`link:${url}`);
      },
      onSizeChanged: async (size) => {
        seen.push(`size:${size.width}x${size.height}`);
      },
    },
  });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:actions'));
  await bridge.receive(initialized());

  await bridge.receive({ id: 'link-id', jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://weather.example.test/forecast' } });
  await bridge.receive({ id: 'message-id', jsonrpc: '2.0', method: 'ui/message', params: { content: [{ text: 'Refresh weather', type: 'text' }], role: 'user' } });
  await bridge.receive({ id: 'display-id', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
  await bridge.receive({ id: 'context-id', jsonrpc: '2.0', method: 'ui/update-model-context', params: { structuredContent: { selected: 'Paris' } } });
  await bridge.receive({ jsonrpc: '2.0', method: 'notifications/message', params: { data: { detail: 'updated' }, level: 'info' } });
  await bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 120, width: 320 } });
  expect(await bridge.receive({ id: 'bad-link', jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'javascript:alert(1)' } })).toBe(true);

  expect(seen).toEqual([
    'link:https://weather.example.test/forecast',
    'message:user',
    'display:fullscreen',
    'context',
    'log:info',
    'size:320x120',
  ]);
  expect(fixture.sent.slice(-5)).toEqual([
    { id: 'link-id', jsonrpc: '2.0', result: {} },
    { id: 'message-id', jsonrpc: '2.0', result: { isError: false } },
    { id: 'display-id', jsonrpc: '2.0', result: { mode: 'fullscreen' } },
    { id: 'context-id', jsonrpc: '2.0', result: {} },
    { error: { code: -32602, message: 'ui/open-link requires an http: or https: URL.' }, id: 'bad-link', jsonrpc: '2.0' },
  ]);
  expect(fixture.calls).toEqual([]);
});

it('enforces declared App capabilities without rejecting a parameterless standard ping', async () => {
  let displayCalls = 0;
  const fixture = fixtureFor({
    host: {
      onDisplayMode: async () => {
        displayCalls += 1;
        return 'inline' as const;
      },
    },
  });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:strict'));
  await bridge.receive(initialized());

  await bridge.receive({ id: 'scalar-tool', jsonrpc: '2.0', method: 'tools/call', params: { arguments: 'Paris', name: 'refresh-weather' } });
  await bridge.receive({ id: 'undeclared-display', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'pip' } });
  await bridge.receive({ id: 'plain-ping', jsonrpc: '2.0', method: 'ping' });

  expect(fixture.calls).toEqual([]);
  expect(displayCalls).toBe(0);
  expect(fixture.sent.slice(-3)).toEqual([
    { error: { code: -32602, message: 'tools/call requires a name and finite JSON arguments.' }, id: 'scalar-tool', jsonrpc: '2.0' },
    { error: { code: -32602, message: 'ui/request-display-mode must be declared by the App.' }, id: 'undeclared-display', jsonrpc: '2.0' },
    { id: 'plain-ping', jsonrpc: '2.0', result: {} },
  ]);
});

it('updates host display-mode negotiation only after publishing a valid host-context change', async () => {
  const requested: string[] = [];
  const fixture = fixtureFor({
    host: {
      onDisplayMode: async (mode) => {
        requested.push(mode);
        return mode;
      },
    },
  });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:display-negotiation'));
  await bridge.receive(initialized());

  expect(bridge.publishHostContextChanged({ availableDisplayModes: ['inline'] })).toBe(true);
  await bridge.receive({ id: 'removed-fullscreen', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
  await bridge.receive({ id: 'never-app-pip', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'pip' } });
  expect(bridge.publishHostContextChanged({ availableDisplayModes: ['inline', 'fullscreen'] })).toBe(true);
  await bridge.receive({ id: 'restored-fullscreen', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });

  expect(requested).toEqual(['fullscreen']);
  expect(fixture.sent).toContainEqual(
    { error: { code: -32602, message: 'ui/request-display-mode is not available from this host.' }, id: 'removed-fullscreen', jsonrpc: '2.0' },
  );
  expect(fixture.sent.slice(-3)).toEqual([
    { error: { code: -32602, message: 'ui/request-display-mode must be declared by the App.' }, id: 'never-app-pip', jsonrpc: '2.0' },
    { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { availableDisplayModes: ['inline', 'fullscreen'] } },
    { id: 'restored-fullscreen', jsonrpc: '2.0', result: { mode: 'fullscreen' } },
  ]);
});

it('rejects a host frame that exceeds the configured queued-byte budget before sending it', () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    maxQueuedHostMessageBytes: 256,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
  });

  expect(bridge.publishToolInputPartial({ payload: 'x'.repeat(2_048) })).toBe(false);
  expect(fixture.sent).toEqual([]);
});

it('fails closed after a permanently blocked full input so a would-succeed result cannot escape', async () => {
  const fixture = fixtureFor();
  let inputAttempts = 0;
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    maxQueuedHostMessageBytes: 4_096,
    operations: fixture.operations,
    send: (message) => {
      if (message.method === 'ui/notifications/tool-input') {
        inputAttempts += 1;
        return inputAttempts > 3;
      }
      fixture.sent.push(message);
      return true;
    },
  });

  await bridge.receive(initialize('init:permanent-block'));
  await bridge.receive(initialized());

  expect(bridge.flushHostTraffic()).toBe(false);
  expect(bridge.flushHostTraffic()).toBe(false);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(bridge.lifecycle).toBe('closed');
  expect(fixture.closes).toEqual(['binding-app']);
  expect(bridge.flushHostTraffic()).toBe(false);
  expect(fixture.sent.some((message) => message.method === 'ui/notifications/tool-input' || message.method === 'ui/notifications/tool-result')).toBe(false);
});

it('rejects malformed JSON-RPC envelopes and payloads before executing host callbacks', async () => {
  let openLinkCalls = 0;
  const fixture = fixtureFor({ host: { onOpenLink: async () => { openLinkCalls += 1; } } });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:envelope'));
  await bridge.receive(initialized());

  expect(await bridge.receive({ id: 'mixed', jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://weather.example.test' }, result: {} })).toBe(false);
  expect(await bridge.receive({ id: 'bad-content', jsonrpc: '2.0', method: 'ui/message', params: { content: [{ text: 42, type: 'text' }], role: 'user' } })).toBe(true);

  expect(openLinkCalls).toBe(0);
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32602, message: 'ui/message requires a user role and valid MCP content blocks.' },
    id: 'bad-content',
    jsonrpc: '2.0',
  });
  expect(() => createMcpAppBridge({
    binding: fixture.binding,
    host: { ...fixture.host, context: { theme: 'sepia' } },
    operations: fixture.operations,
    send: () => true,
  })).toThrow('MCP App host context must use stable MCP Apps field values.');
  expect(() => createMcpAppBridge({
    binding: fixture.binding,
    host: { ...fixture.host, capabilities: { serverTools: { listChanged: 'yes' } } },
    operations: fixture.operations,
    send: () => true,
  })).toThrow('MCP App host context must use stable MCP Apps field values.');
  expect(() => createMcpAppBridge({
    binding: fixture.binding,
    host: { ...fixture.host, context: { toolInfo: { id: {}, tool: { name: 'show-weather' } } } },
    operations: fixture.operations,
    send: () => true,
  })).toThrow('MCP App host context must use stable MCP Apps field values.');

  fixture.operations.callTool = async () => ({ content: [{ text: 42, type: 'text' }] }) as unknown as McpAppJsonValue;
  await bridge.receive({ id: 'bad-result', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32000, message: 'MCP App tool call returned an invalid result.' },
    id: 'bad-result',
    jsonrpc: '2.0',
  });
});

it('rejects malformed stable capability, resource, logging, and host-context shapes before they cross the bridge', async () => {
  const fixture = fixtureFor({
    host: {
      onLog: async () => {
        throw new Error('malformed logging notification reached the host callback');
      },
    },
  });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });

  expect(await bridge.receive({
    id: 'bad-capability',
    jsonrpc: '2.0',
    method: 'ui/initialize',
    params: {
      appCapabilities: { tools: { listChanged: 'yes' } },
      appInfo: { name: 'weather-view', version: '1.0.0' },
      protocolVersion: '2026-01-26',
    },
  })).toBe(true);
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32602, message: 'ui/initialize requires protocol version 2026-01-26.' },
    id: 'bad-capability',
    jsonrpc: '2.0',
  });

  await bridge.receive(initialize('init:schemas'));
  await bridge.receive(initialized());
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })).toBe(false);
  expect(bridge.publishHostContextChanged({ availableDisplayModes: ['inline', 'sepia'] })).toBe(false);

  fixture.operations.readResource = async () => ({
    contents: [{ _meta: { ui: { csp: { connectDomains: ['https://api.weather.test', 42] } } }, text: '<main>bad</main>', uri: 'resource://weather/bad' }],
  }) as unknown as McpAppJsonValue;
  expect(await bridge.receive({ id: 'bad-read', jsonrpc: '2.0', method: 'resources/read', params: { uri: 'resource://weather/bad' } })).toBe(true);
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32000, message: 'MCP App resource read returned an invalid result.' },
    id: 'bad-read',
    jsonrpc: '2.0',
  });

  const malformedResource = fixtureFor({
    resource: {
      contents: [{
        _meta: { ui: { domain: 42 } },
        mimeType: 'text/html;profile=mcp-app',
        text: '<main>bad metadata</main>',
        uri: 'ui://weather/forecast.html',
      }],
    },
  });
  await expect(createMcpAppBridge({ binding: malformedResource.binding, host: malformedResource.host, operations: malformedResource.operations, send: () => true }).loadResource()).resolves.toMatchObject({
    kind: 'fallback',
    reason: 'invalid-resource',
  });
});

it('rejects callback-returned display modes outside the App and host declarations', async () => {
  const fixture = fixtureFor({ host: { onDisplayMode: async () => 'pip' as const } });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:display-response'));
  await bridge.receive(initialized());

  await bridge.receive({ id: 'display-response', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32000, message: 'Host returned a display mode outside the negotiated declarations.' },
    id: 'display-response',
    jsonrpc: '2.0',
  });
});

it('suppresses an invalid display-mode error when force close wins the callback race', async () => {
  let resolveDisplay: ((mode: 'pip') => void) | undefined;
  const fixture = fixtureFor({
    host: {
      onDisplayMode: () => new Promise<'pip'>((resolve) => {
        resolveDisplay = resolve;
      }),
    },
  });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  await bridge.receive(initialize('init:late-display'));
  await bridge.receive(initialized());

  const pending = bridge.receive({ id: 'late-display', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
  const closing = bridge.forceClose();
  resolveDisplay?.('pip');

  await expect(pending).resolves.toBe(false);
  await closing;
  expect(fixture.sent.some((message) => message.id === 'late-display')).toBe(false);
});

it('loads only the canonical HTML UI resource and returns a frozen structured fallback otherwise', async () => {
  const blobFixture = fixtureFor({
    resource: {
      contents: [
        { mimeType: 'text/html;profile=mcp-app', text: '<main>wrong uri</main>', uri: 'ui://weather/other.html' },
        {
          _meta: { ui: { csp: { resourceDomains: ['https://cdn.weather.test'] } } },
          blob: Buffer.from('<main>from base64</main>', 'utf8').toString('base64'),
          mimeType: 'text/html;profile=mcp-app',
          uri: 'ui://weather/forecast.html',
        },
      ],
    },
  });
  const bridge = createMcpAppBridge({ binding: blobFixture.binding, host: blobFixture.host, operations: blobFixture.operations, send: () => true });
  const resource = await bridge.loadResource();
  expect(resource).toEqual({
    csp: { resourceDomains: ['https://cdn.weather.test'] },
    html: '<main>from base64</main>',
    kind: 'resource',
  });
  expect(Object.isFrozen(resource)).toBe(true);
  expect(blobFixture.reads).toEqual([{ bindingId: 'binding-app', uri: 'ui://weather/forecast.html' }]);

  const noncanonical = bindingFor({
    resourceUri: 'ui://weather/flat.html',
    toolDefinition: { _meta: { 'openai/outputTemplate': 'ui://weather/legacy.html', 'ui/resourceUri': 'ui://weather/flat.html' }, name: 'show-weather' },
  });
  const fallbackFixture = fixtureFor({ binding: noncanonical });
  const fallback = await createMcpAppBridge({ binding: fallbackFixture.binding, host: fallbackFixture.host, operations: fallbackFixture.operations, send: () => true }).loadResource();
  expect(fallback).toEqual({
    input: { city: 'Paris', units: 'metric' },
    kind: 'fallback',
    reason: 'missing-canonical-resource-uri',
    result: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } },
  });
  expect(Object.isFrozen(fallback)).toBe(true);
  expect(fallbackFixture.reads).toEqual([]);
});

it('queues host context and cancellation in protocol order without also sending the original result', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });

  expect(bridge.publishHostContextChanged({ theme: 'dark' })).toBe(true);
  expect(bridge.publishToolCancelled('user-dismissed')).toBe(true);
  await bridge.receive(initialize('init:cancelled'));
  await bridge.receive(initialized());

  expect(fixture.sent).toEqual([
    fixture.sent[0]!,
    { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris', units: 'metric' } } },
    { jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: { reason: 'user-dismissed' } },
  ]);
  expect(fixture.sent.some((message) => message.method === 'ui/notifications/tool-result')).toBe(false);
});

it('releases an uninitialized binding immediately without sending resource teardown traffic', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
    teardownTimeoutMs: 10,
  });

  await bridge.close({ id: 'unused-before-ready' });
  expect(fixture.sent).toEqual([]);
  expect(fixture.closes).toEqual(['binding-app']);
  expect(bridge.lifecycle).toBe('closed');
});

it('retains a retryable closing state and surfaces a structured binding-release failure', async () => {
  let attempts = 0;
  const fixture = fixtureFor();
  fixture.operations.closeBinding = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient binding release failure');
    return true;
  };
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: () => true });

  await expect(bridge.forceClose()).rejects.toMatchObject({ code: 'binding-close-failed', operation: 'closeBinding' });
  expect(bridge.lifecycle).toBe('closing');
  expect(attempts).toBe(1);
  await bridge.forceClose();
  expect(bridge.lifecycle).toBe('closed');
  expect(attempts).toBe(2);
});

it('invalidates resource resolution that races with force close', async () => {
  let resolveRead: ((value: McpAppJsonValue) => void) | undefined;
  const fixture = fixtureFor();
  const defaultRead = fixture.operations.readResource;
  fixture.operations.readResource = async () => new Promise<McpAppJsonValue>((resolve) => {
    resolveRead = resolve;
  });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: () => true });
  const pending = bridge.loadResource();
  await bridge.forceClose();
  resolveRead?.(await defaultRead('binding-app', { uri: 'ui://weather/forecast.html' }));

  await expect(pending).resolves.toEqual({
    input: { city: 'Paris', units: 'metric' },
    kind: 'fallback',
    reason: 'bridge-closed',
    result: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } },
  });
});

it('bounds resource teardown, releases only the binding, and suppresses in-flight replies after close', async () => {
  let resolveTool: ((value: McpAppJsonValue) => void) | undefined;
  const fixture = fixtureFor();
  fixture.operations.callTool = async () => new Promise<McpAppJsonValue>((resolve) => {
    resolveTool = resolve;
  });
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
    teardownTimeoutMs: 10,
  });
  await bridge.receive(initialize('init:close'));
  await bridge.receive(initialized());
  const pending = bridge.receive({ id: 'call:pending', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  const closing = bridge.close({ id: 'teardown:fixed', reason: 'user-dismissed' });
  expect(bridge.close({ id: 'different-id' })).toBe(closing);
  expect(fixture.sent.at(-1)).toEqual({ id: 'teardown:fixed', jsonrpc: '2.0', method: 'ui/resource-teardown', params: { reason: 'user-dismissed' } });

  resolveTool?.({ content: [{ text: 'late', type: 'text' }] });
  await pending;
  await closing;
  expect(fixture.sent.some((message) => message.id === 'call:pending')).toBe(false);
  expect(fixture.closes).toEqual(['binding-app']);
  expect(bridge.lifecycle).toBe('closed');
  expect(await bridge.receive({ id: 'after-close', jsonrpc: '2.0', method: 'ping', params: {} })).toBe(false);
});

it('deep-snapshots caller-owned binding and host values before exposing them to the app', async () => {
  const mutableInput = { city: 'Paris', nested: { day: 'today' } };
  const mutableContext = { theme: 'light' as const, styles: { variables: { '--font-sans': 'system-ui' } } };
  const fixture = fixtureFor({ binding: bindingFor({ input: mutableInput }), host: { context: mutableContext } });
  const bridge = createMcpAppBridge({ binding: fixture.binding, host: fixture.host, operations: fixture.operations, send: (message) => (fixture.sent.push(message), true) });
  mutableInput.nested.day = 'tomorrow';
  mutableContext.styles.variables['--font-sans'] = 'unsafe';
  await bridge.receive(initialize('init:immutable'));
  await bridge.receive(initialized());

  expect(fixture.sent).toContainEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris', nested: { day: 'today' } } } });
  expect(fixture.sent[0]).toMatchObject({ result: { hostContext: { styles: { variables: { '--font-sans': 'system-ui' } } } } });
});
