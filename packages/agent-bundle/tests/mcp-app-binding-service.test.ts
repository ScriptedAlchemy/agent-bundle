import { expect, it } from '@rstest/core';

import {
  McpAppBindingService,
  selectMcpAppResourceUri,
  type McpAppJsonValue,
  type McpAppSessionAuthority,
  type McpAppSessionLease,
  type McpAppToolDefinition,
} from '../src/dev/mcp-app-binding-service.ts';

interface SessionFixture {
  readonly calls: Array<{ readonly arguments: McpAppJsonValue | undefined; readonly name: string }>;
  readonly reads: string[];
  readonly releases: number[];
  readonly sessionCloseCalls: number[];
  createLease(): McpAppSessionLease;
  closeSession(): Promise<void>;
}

const appTool: McpAppToolDefinition = {
  _meta: {
    ui: { resourceUri: 'ui://weather/forecast.html' },
  },
  inputSchema: { type: 'object' },
  name: 'show-weather',
};

const createSessionFixture = (): SessionFixture => {
  const closeListeners = new Set<(reason?: unknown) => Promise<void> | void>();
  const calls: Array<{ readonly arguments: McpAppJsonValue | undefined; readonly name: string }> = [];
  const reads: string[] = [];
  const releases: number[] = [];
  const sessionCloseCalls: number[] = [];

  return {
    calls,
    reads,
    releases,
    sessionCloseCalls,
    createLease: () => {
      const leaseIndex = releases.length;
      releases.push(0);
      return {
        release: async () => {
          releases[leaseIndex] += 1;
        },
        session: {
          callTool: async ({ arguments: toolArguments, name }) => {
            calls.push({ arguments: toolArguments, name });
            return { content: [{ text: `called ${name}`, type: 'text' }] };
          },
          identity: {
            epochId: 'epoch-app',
            serverName: 'weather',
            sessionId: 'session-weather',
            target: 'portable',
          },
          listBridgeResources: async () => [
            { appVisible: true, uri: 'resource://weather/forecast' },
            { appVisible: false, uri: 'resource://weather/private' },
          ],
          listBridgeTools: async () => [
            { appVisible: true, name: 'refresh-weather' },
            { appVisible: false, name: 'delete-weather' },
          ],
          readResource: async ({ uri }) => {
            reads.push(uri);
            return { contents: [{ text: uri, type: 'text' }] };
          },
        },
        subscribeSessionClosed: (listener) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
      };
    },
    closeSession: async () => {
      sessionCloseCalls.push(1);
      await Promise.all([...closeListeners].map((listener) => listener(new Error('session control closed'))));
    },
  };
};

const authorityFor = (fixture: SessionFixture): McpAppSessionAuthority => ({
  acquireAppLease: async (sessionId) => {
    if (sessionId !== 'session-weather') throw new Error(`Unknown session ${sessionId}.`);
    return fixture.createLease();
  },
});

it('selects only the standard ui resource URI and snapshots an immutable app binding', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppBindingService({ sessionAuthority: authorityFor(fixture) });
  const input: McpAppJsonValue = { location: { city: 'Paris' } };
  const result: McpAppJsonValue = { content: [{ text: 'Sunny', type: 'text' }] };

  expect(selectMcpAppResourceUri(appTool)).toBe('ui://weather/forecast.html');
  expect(selectMcpAppResourceUri({
    _meta: { 'openai/outputTemplate': 'ui://legacy/template.html' },
    name: 'legacy-template',
    ui: { resourceUri: 'ui://flat/template.html' },
  })).toBeUndefined();
  expect(selectMcpAppResourceUri({
    _meta: { ui: { resourceUri: 'https://example.test/not-an-mcp-app' } },
    name: 'web-template',
  })).toBeUndefined();

  const binding = await service.createBinding({
    input,
    previewProfile: 'chatgpt',
    result,
    sessionId: 'session-weather',
    tool: appTool,
  });
  (input as { location: { city: string } }).location.city = 'Changed after binding';
  (result as { content: Array<{ text: string; type: string }> }).content[0]!.text = 'Changed after binding';

  expect(binding).toMatchObject({
    epochId: 'epoch-app',
    previewProfile: 'chatgpt',
    resourceUri: 'ui://weather/forecast.html',
    serverName: 'weather',
    sessionId: 'session-weather',
    target: 'portable',
    toolName: 'show-weather',
  });
  expect(binding.id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(binding.input).toEqual({ location: { city: 'Paris' } });
  expect(binding.result).toEqual({ content: [{ text: 'Sunny', type: 'text' }] });
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.isFrozen(binding.input)).toBe(true);
  expect(Object.isFrozen((binding.input as { readonly location: object }).location)).toBe(true);
  await expect(service.createBinding({
    input: {},
    previewProfile: 'portable',
    result: {},
    sessionId: 'session-weather',
    tool: { _meta: { 'openai/outputTemplate': 'ui://legacy/template.html' }, name: 'legacy-template' },
  })).rejects.toThrow('standard _meta.ui.resourceUri');
});

it('authorizes bridge operations from the opaque binding against only app-visible session capabilities', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppBindingService({ sessionAuthority: authorityFor(fixture) });
  const binding = await service.createBinding({
    input: {},
    previewProfile: 'claude',
    result: {},
    sessionId: 'session-weather',
    tool: appTool,
  });

  await expect(service.callTool(binding.id, { arguments: { force: true }, name: 'refresh-weather' })).resolves.toEqual({
    content: [{ text: 'called refresh-weather', type: 'text' }],
  });
  await expect(service.readResource(binding.id, { uri: 'resource://weather/forecast' })).resolves.toEqual({
    contents: [{ text: 'resource://weather/forecast', type: 'text' }],
  });
  await expect(service.callTool(binding.id, { arguments: {}, name: 'delete-weather' })).rejects.toThrow('not app-visible');
  await expect(service.readResource(binding.id, { uri: 'resource://weather/private' })).rejects.toThrow('not app-visible');
  await expect(service.callTool('session-weather', { arguments: {}, name: 'refresh-weather' })).rejects.toThrow('Unknown MCP App binding');
  expect(fixture.calls).toEqual([{ arguments: { force: true }, name: 'refresh-weather' }]);
  expect(fixture.reads).toEqual(['resource://weather/forecast']);
});

it('releases each app lease once while invalidating every binding on explicit session close', async () => {
  const fixture = createSessionFixture();
  const teardownCalls: string[] = [];
  const service = new McpAppBindingService({
    sessionAuthority: authorityFor(fixture),
    teardownTimeoutMs: 5,
  });
  const first = await service.createBinding({
    input: {},
    onTeardown: async () => {
      teardownCalls.push('first');
    },
    previewProfile: 'portable',
    result: {},
    sessionId: 'session-weather',
    tool: appTool,
  });
  const second = await service.createBinding({
    input: {},
    onTeardown: () => new Promise<void>(() => undefined),
    previewProfile: 'portable',
    result: {},
    sessionId: 'session-weather',
    tool: appTool,
  });

  await expect(Promise.all([service.closeBinding(first.id), service.closeBinding(first.id)])).resolves.toEqual([true, false]);
  await fixture.closeSession();

  expect(service.get(first.id)).toBeUndefined();
  expect(service.get(second.id)).toBeUndefined();
  expect(await service.closeBinding(second.id)).toBe(false);
  expect(fixture.releases).toEqual([1, 1]);
  expect(fixture.sessionCloseCalls).toEqual([1]);
  expect(teardownCalls).toEqual(['first']);
});
