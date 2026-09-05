import { expect, it } from '@rstest/core';

import { createMcpAppConsentAuthority } from '../src/dev/mcp-apps/mcp-app-sandbox.ts';
import {
  createMcpAppBridge,
  type McpAppBridgeBindingOperations,
  type McpAppBridgeHost,
  type McpAppBridgeMessage,
  type McpAppBridgeRequestId,
} from '../src/dev/mcp-apps/mcp-app-bridge.ts';
import type { McpAppBinding, McpAppJsonValue } from '../src/dev/mcp-apps/mcp-app-binding-service.ts';

interface HeldOperation {
  readonly signal: AbortSignal | undefined;
  reject(error: Error): void;
  resolve(value: McpAppJsonValue): void;
}

interface BridgeFixture {
  readonly binding: McpAppBinding;
  readonly calls: Array<{
    readonly arguments: McpAppJsonValue | undefined;
    readonly bindingId: string;
    readonly name: string;
    readonly signal: AbortSignal | undefined;
  }>;
  readonly heldCalls: HeldOperation[];
  readonly heldReads: HeldOperation[];
  readonly host: McpAppBridgeHost;
  readonly operations: McpAppBridgeBindingOperations;
  readonly reads: Array<{
    readonly bindingId: string;
    readonly signal: AbortSignal | undefined;
    readonly uri: string;
  }>;
  readonly sent: McpAppBridgeMessage[];
}

const bindingFor = (): McpAppBinding => ({
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
});

const fixtureFor = (options: {
  readonly host?: Partial<McpAppBridgeHost>;
  readonly holdCalls?: boolean;
  readonly holdReads?: boolean;
} = {}): BridgeFixture => {
  const calls: BridgeFixture['calls'] = [];
  const heldCalls: HeldOperation[] = [];
  const heldReads: HeldOperation[] = [];
  const reads: BridgeFixture['reads'] = [];
  const sent: McpAppBridgeMessage[] = [];
  const defaultResource: McpAppJsonValue = {
    contents: [{
      mimeType: 'text/html;profile=mcp-app',
      text: '<main>forecast</main>',
      uri: 'ui://weather/forecast.html',
    }],
  };
  const hold = (bucket: HeldOperation[], signal: AbortSignal | undefined): Promise<McpAppJsonValue> =>
    new Promise<McpAppJsonValue>((resolve, reject) => {
      bucket.push({ reject, resolve, signal });
    });
  const host: McpAppBridgeHost = {
    capabilities: { openLinks: {}, serverResources: {}, serverTools: {} },
    context: { availableDisplayModes: ['inline', 'fullscreen'], displayMode: 'inline', theme: 'light' },
    info: { name: 'agent-bundle', version: '0.1.0' },
    onDisplayMode: async (mode) => mode,
    onDownload: async () => undefined,
    onMessage: async () => ({ isError: false }),
    onModelContext: async () => undefined,
    onOpenLink: async () => undefined,
    ...options.host,
  };
  const operations: McpAppBridgeBindingOperations = {
    callTool: async (bindingId, request, signal) => {
      calls.push({ arguments: request.arguments, bindingId, name: request.name, signal });
      if (options.holdCalls) return hold(heldCalls, signal);
      return { content: [{ text: `called ${request.name}`, type: 'text' }] };
    },
    closeBinding: async () => true,
    readResource: async (bindingId, request, signal) => {
      reads.push({ bindingId, signal, uri: request.uri });
      if (options.holdReads) return hold(heldReads, signal);
      return defaultResource;
    },
  };
  return { binding: bindingFor(), calls, heldCalls, heldReads, host, operations, reads, sent };
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
});

const cancelled = (
  requestId: McpAppBridgeRequestId,
  reason?: string,
): McpAppBridgeMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/cancelled',
  params: reason === undefined ? { requestId } : { reason, requestId },
});

const readyBridge = async (fixture: BridgeFixture) => {
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => {
      fixture.sent.push(message);
      return true;
    },
  });
  expect(await bridge.receive(initialize('init:ready'))).toBe(true);
  expect(await bridge.receive(initialized())).toBe(true);
  return bridge;
};

const responsesFor = (fixture: BridgeFixture, id: McpAppBridgeRequestId): readonly McpAppBridgeMessage[] =>
  fixture.sent.filter((message) => message.id === id);

it('accepts a valid repeated ui/initialize while initializing and resets queued opening frames', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
  });

  expect(bridge.publishToolInputPartial({ city: 'Par' })).toBe(true);
  expect(await bridge.receive(initialize('init:first'))).toBe(true);
  expect(bridge.lifecycle).toBe('initializing');
  expect(bridge.publishToolInputPartial({ city: 'Pari' })).toBe(true);
  expect(await bridge.receive(initialize('init:retry'))).toBe(true);
  expect(bridge.lifecycle).toBe('initializing');
  expect(fixture.sent.at(-1)).toEqual({
    id: 'init:retry',
    jsonrpc: '2.0',
    result: {
      hostCapabilities: { openLinks: {}, serverResources: {}, serverTools: {} },
      hostContext: { availableDisplayModes: ['inline', 'fullscreen'], displayMode: 'inline', theme: 'light' },
      hostInfo: { name: 'agent-bundle', version: '0.1.0' },
      protocolVersion: '2026-01-26',
    },
  });

  expect(await bridge.receive(initialized())).toBe(true);
  expect(bridge.lifecycle).toBe('initialized');
  expect(fixture.sent.filter((message) => message.method === 'ui/notifications/tool-input-partial')).toEqual([]);
  expect(fixture.sent.slice(-2)).toEqual([
    { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris', units: 'metric' } } },
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 21 } },
    },
  ]);
});

it('rejects an invalid repeated ui/initialize during initializing without leaving the handshake', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
  });
  expect(await bridge.receive(initialize('init:valid'))).toBe(true);
  expect(await bridge.receive({
    id: 'init:bad',
    jsonrpc: '2.0',
    method: 'ui/initialize',
    params: { appCapabilities: {}, appInfo: { name: 'weather-view', version: '1.0.0' }, protocolVersion: '1999-01-01' },
  })).toBe(true);
  expect(bridge.lifecycle).toBe('initializing');
  expect(fixture.sent.at(-1)).toEqual({
    error: { code: -32602, message: 'ui/initialize requires protocol version 2026-01-26.' },
    id: 'init:bad',
    jsonrpc: '2.0',
  });
  expect(await bridge.receive(initialized())).toBe(true);
  expect(bridge.lifecycle).toBe('initialized');
});

it('resets queued opening frames on initialized re-init the same way as an initializing retry', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
  });
  expect(await bridge.receive(initialize('init:first'))).toBe(true);
  expect(await bridge.receive(initialized())).toBe(true);
  expect(bridge.publishHostContextChanged({ theme: 'dark' })).toBe(true);
  expect(await bridge.receive(initialize('init:rebind'))).toBe(true);
  expect(bridge.lifecycle).toBe('initializing');
  expect(await bridge.receive(initialized())).toBe(true);
  expect(fixture.sent.filter((message) => message.method === 'ui/notifications/host-context-changed')).toEqual([
    { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
  ]);
  expect(fixture.sent.filter((message) => message.method === 'ui/notifications/tool-input')).toHaveLength(2);
  expect(fixture.sent.filter((message) => message.method === 'ui/notifications/tool-result')).toHaveLength(2);
});

it('ignores cancellation before the App is initialized and never treats cancelled as a request', async () => {
  const fixture = fixtureFor();
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    host: fixture.host,
    operations: fixture.operations,
    send: (message) => (fixture.sent.push(message), true),
  });
  expect(await bridge.receive(cancelled('never-started', 'aborted'))).toBe(false);
  expect(await bridge.receive(initialize('init:cancel-early'))).toBe(true);
  expect(await bridge.receive(cancelled('init:cancel-early'))).toBe(false);
  expect(await bridge.receive({
    id: 'cancelled-as-request',
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'cancelled-as-request' },
  })).toBe(false);
  expect(await bridge.receive(initialized())).toBe(true);
  expect(fixture.sent.some((message) => message.error !== undefined)).toBe(false);
});

it('rejects malformed cancelled notifications without aborting a live request', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const bridge = await readyBridge(fixture);
  const pending = bridge.receive({
    id: 'call:live',
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'refresh-weather' },
  });
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBe(false);
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })).toBe(false);
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: { forged: true } } })).toBe(false);
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { reason: ' ', requestId: 'call:live' } })).toBe(false);
  expect(await bridge.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { reason: 1, requestId: 'call:live' } })).toBe(false);
  expect(fixture.heldCalls).toHaveLength(1);
  expect(fixture.heldCalls[0]?.signal?.aborted).toBe(false);
  fixture.heldCalls[0]?.resolve({ content: [{ text: 'survived', type: 'text' }] });
  expect(await pending).toBe(true);
  expect(responsesFor(fixture, 'call:live')).toEqual([
    { id: 'call:live', jsonrpc: '2.0', result: { content: [{ text: 'survived', type: 'text' }] } },
  ]);
});

it('accepts a well-formed cancelled notification for an unknown request id as a no-op', async () => {
  const fixture = fixtureFor();
  const bridge = await readyBridge(fixture);
  const before = fixture.sent.length;
  expect(await bridge.receive(cancelled(null))).toBe(true);
  expect(await bridge.receive(cancelled(0, 'aborted'))).toBe(true);
  expect(await bridge.receive(cancelled('missing', 'timeout'))).toBe(true);
  expect(fixture.sent).toHaveLength(before);
  expect(fixture.calls).toEqual([]);
});

it('cancels a running tools/call, aborts the binding signal, and drops a late result', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const bridge = await readyBridge(fixture);
  const pending = bridge.receive({
    id: 7,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { city: 'Lyon' }, name: 'refresh-weather' },
  });
  expect(fixture.heldCalls).toHaveLength(1);
  expect(await bridge.receive(cancelled(7, 'timeout'))).toBe(true);
  expect(fixture.heldCalls[0]?.signal?.aborted).toBe(true);
  expect(fixture.heldCalls[0]?.signal?.reason).toEqual(new Error('timeout'));
  fixture.heldCalls[0]?.resolve({ content: [{ text: 'late', type: 'text' }] });
  expect(await pending).toBe(false);
  expect(responsesFor(fixture, 7)).toEqual([]);
  expect(await bridge.receive({ id: 8, jsonrpc: '2.0', method: 'ping' })).toBe(true);
  expect(responsesFor(fixture, 8)).toEqual([{ id: 8, jsonrpc: '2.0', result: {} }]);
});

it('cancels a running resources/read and does not respond after a late resource body', async () => {
  const fixture = fixtureFor({ holdReads: true });
  const bridge = await readyBridge(fixture);
  const pending = bridge.receive({
    id: 'read:live',
    jsonrpc: '2.0',
    method: 'resources/read',
    params: { uri: 'ui://weather/forecast.html' },
  });
  expect(await bridge.receive(cancelled('read:live', 'aborted'))).toBe(true);
  expect(fixture.heldReads[0]?.signal?.aborted).toBe(true);
  fixture.heldReads[0]?.resolve({
    contents: [{ mimeType: 'text/html;profile=mcp-app', text: '<main>late</main>', uri: 'ui://weather/forecast.html' }],
  });
  expect(await pending).toBe(false);
  expect(responsesFor(fixture, 'read:live')).toEqual([]);
});

it('cancels a tools/call before consent so a later approval cannot execute it', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const authority = createMcpAppConsentAuthority({ now: () => 1_000 });
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    consentAuthority: authority,
    host: fixture.host,
    operations: fixture.operations,
    profile: 'portable',
    send: (message) => (fixture.sent.push(message), true),
  });
  await bridge.receive(initialize('init:consent-cancel'));
  await bridge.receive(initialized());
  expect(await bridge.receive({
    id: 'tool:consent',
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { city: 'Paris' }, name: 'refresh-weather' },
  })).toBe(true);
  const challenge = authority.pending().find((candidate) => candidate.request.capability === 'call-tool');
  expect(challenge).toBeDefined();
  expect(fixture.calls).toEqual([]);
  expect(await bridge.receive(cancelled('tool:consent', 'aborted'))).toBe(true);
  expect(authority.pending()).toEqual([]);
  expect(await bridge.decideConsent(challenge?.id ?? '', true)).toBe(false);
  expect(fixture.calls).toEqual([]);
  expect(responsesFor(fixture, 'tool:consent')).toEqual([]);
});

it('cancels a privileged host action while its consent challenge is pending', async () => {
  const links: string[] = [];
  const fixture = fixtureFor({
    host: {
      onOpenLink: async (url) => {
        links.push(url);
      },
    },
  });
  const authority = createMcpAppConsentAuthority({ now: () => 1_000 });
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    consentAuthority: authority,
    host: fixture.host,
    operations: fixture.operations,
    profile: 'portable',
    send: (message) => (fixture.sent.push(message), true),
  });
  await bridge.receive(initialize('init:link-cancel'));
  await bridge.receive(initialized());
  await bridge.receive({
    id: 'link:pending',
    jsonrpc: '2.0',
    method: 'ui/open-link',
    params: { url: 'https://weather.example.test/forecast' },
  });
  const challenge = authority.pending().find((candidate) => candidate.request.capability === 'open-external-link');
  expect(await bridge.receive(cancelled('link:pending'))).toBe(true);
  expect(authority.pending()).toEqual([]);
  expect(await bridge.decideConsent(challenge?.id ?? '', true)).toBe(false);
  expect(links).toEqual([]);
  expect(responsesFor(fixture, 'link:pending')).toEqual([]);
});

it('does not let a cancelled consent denial produce an RPC error after the request is gone', async () => {
  const fixture = fixtureFor();
  const authority = createMcpAppConsentAuthority({ now: () => 1_000 });
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    consentAuthority: authority,
    host: fixture.host,
    operations: fixture.operations,
    profile: 'portable',
    send: (message) => (fixture.sent.push(message), true),
  });
  await bridge.receive(initialize('init:deny-after-cancel'));
  await bridge.receive(initialized());
  await bridge.receive({
    id: 'download:cancel',
    jsonrpc: '2.0',
    method: 'ui/download-file',
    params: { contents: [{ text: 'forecast', type: 'text' }] },
  });
  const challenge = authority.pending().find((candidate) => candidate.request.capability === 'download-file');
  expect(await bridge.receive(cancelled('download:cancel', 'aborted'))).toBe(true);
  expect(await bridge.decideConsent(challenge?.id ?? '', false)).toBe(false);
  expect(responsesFor(fixture, 'download:cancel')).toEqual([]);
});

it('cancels only the named in-flight request and keeps a sibling request runnable', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const bridge = await readyBridge(fixture);
  const first = bridge.receive({ id: 'call:a', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  const second = bridge.receive({ id: 'call:b', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  expect(fixture.heldCalls).toHaveLength(2);
  expect(await bridge.receive(cancelled('call:a', 'aborted'))).toBe(true);
  expect(fixture.heldCalls[0]?.signal?.aborted).toBe(true);
  expect(fixture.heldCalls[1]?.signal?.aborted).toBe(false);
  fixture.heldCalls[0]?.resolve({ content: [{ text: 'late-a', type: 'text' }] });
  fixture.heldCalls[1]?.resolve({ content: [{ text: 'kept-b', type: 'text' }] });
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(responsesFor(fixture, 'call:a')).toEqual([]);
  expect(responsesFor(fixture, 'call:b')).toEqual([
    { id: 'call:b', jsonrpc: '2.0', result: { content: [{ text: 'kept-b', type: 'text' }] } },
  ]);
});

it('rejects a duplicate running request id with one -32602 and suppresses the original result', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const bridge = await readyBridge(fixture);
  const pending = bridge.receive({ id: 'shared', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  expect(await bridge.receive({ id: 'shared', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } })).toBe(true);
  expect(fixture.heldCalls).toHaveLength(1);
  expect(fixture.heldCalls[0]?.signal?.aborted).toBe(true);
  expect(fixture.calls).toHaveLength(1);
  expect(responsesFor(fixture, 'shared')).toEqual([
    { error: { code: -32602, message: 'MCP App request id is already in flight.' }, id: 'shared', jsonrpc: '2.0' },
  ]);
  fixture.heldCalls[0]?.resolve({ content: [{ text: 'original', type: 'text' }] });
  expect(await pending).toBe(false);
  expect(responsesFor(fixture, 'shared')).toEqual([
    { error: { code: -32602, message: 'MCP App request id is already in flight.' }, id: 'shared', jsonrpc: '2.0' },
  ]);
});

it('rejects a duplicate consent-pending request id with one -32602 and drops the original challenge', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const authority = createMcpAppConsentAuthority({ now: () => 1_000 });
  const bridge = createMcpAppBridge({
    binding: fixture.binding,
    consentAuthority: authority,
    host: fixture.host,
    operations: fixture.operations,
    profile: 'portable',
    send: (message) => (fixture.sent.push(message), true),
  });
  await bridge.receive(initialize('init:duplicate-consent'));
  await bridge.receive(initialized());
  expect(await bridge.receive({
    id: 'shared-consent',
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { city: 'Paris' }, name: 'refresh-weather' },
  })).toBe(true);
  const challenge = authority.pending().find((candidate) => candidate.request.capability === 'call-tool');
  expect(challenge).toBeDefined();
  expect(fixture.calls).toEqual([]);
  expect(await bridge.receive({
    id: 'shared-consent',
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { city: 'Lyon' }, name: 'refresh-weather' },
  })).toBe(true);
  expect(authority.pending()).toEqual([]);
  expect(await bridge.decideConsent(challenge?.id ?? '', true)).toBe(false);
  expect(fixture.calls).toEqual([]);
  expect(responsesFor(fixture, 'shared-consent')).toEqual([
    { error: { code: -32602, message: 'MCP App request id is already in flight.' }, id: 'shared-consent', jsonrpc: '2.0' },
  ]);
});

it('aborts in-flight work on re-init so a late result cannot answer the rebound App', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const bridge = await readyBridge(fixture);
  const pending = bridge.receive({ id: 'call:stale', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  expect(await bridge.receive(initialize('init:rebound'))).toBe(true);
  expect(bridge.lifecycle).toBe('initializing');
  expect(fixture.heldCalls[0]?.signal?.aborted).toBe(true);
  fixture.heldCalls[0]?.resolve({ content: [{ text: 'stale', type: 'text' }] });
  expect(await pending).toBe(false);
  expect(responsesFor(fixture, 'call:stale')).toEqual([]);
  expect(await bridge.receive(initialized())).toBe(true);
  expect(responsesFor(fixture, 'call:stale')).toEqual([]);
});

it('aborts in-flight requests on force close and still suppresses their late replies', async () => {
  const fixture = fixtureFor({ holdCalls: true });
  const bridge = await readyBridge(fixture);
  const pending = bridge.receive({ id: 'call:closing', jsonrpc: '2.0', method: 'tools/call', params: { name: 'refresh-weather' } });
  const closing = bridge.forceClose();
  expect(fixture.heldCalls[0]?.signal?.aborted).toBe(true);
  fixture.heldCalls[0]?.resolve({ content: [{ text: 'after-close', type: 'text' }] });
  expect(await pending).toBe(false);
  await closing;
  expect(responsesFor(fixture, 'call:closing')).toEqual([]);
});

it('does not let cancellation bypass host security or execute a tool the App did not start', async () => {
  const fixture = fixtureFor();
  const bridge = await readyBridge(fixture);
  expect(await bridge.receive(cancelled('binding-app'))).toBe(true);
  expect(await bridge.receive({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'tools/call', reason: 'aborted' },
  })).toBe(true);
  expect(fixture.calls).toEqual([]);
  expect(await bridge.receive({
    id: 'scalar-tool',
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: 'Paris', name: 'refresh-weather' },
  })).toBe(true);
  expect(fixture.calls).toEqual([]);
  expect(responsesFor(fixture, 'scalar-tool')).toEqual([
    { error: { code: -32602, message: 'tools/call requires a name and finite JSON arguments.' }, id: 'scalar-tool', jsonrpc: '2.0' },
  ]);
});
