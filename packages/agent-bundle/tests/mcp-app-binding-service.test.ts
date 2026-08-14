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
  createLease(): McpAppSessionLease & {
    watchSessionClosed(listener: (reason?: unknown) => Promise<void> | void): {
      readonly closed: boolean;
      readonly unsubscribe: () => void;
    };
  };
  closeSession(): Promise<void>;
}

const appTool: McpAppToolDefinition = {
  _meta: {
    ui: { resourceUri: 'ui://weather/forecast.html' },
  },
  inputSchema: { type: 'object' },
  name: 'show-weather',
};

const createSessionFixture = (options: { readonly closeBeforeObservation?: boolean } = {}): SessionFixture => {
  const closeListeners = new Set<(reason?: unknown) => Promise<void> | void>();
  const calls: Array<{ readonly arguments: McpAppJsonValue | undefined; readonly name: string }> = [];
  const reads: string[] = [];
  const releases: number[] = [];
  const sessionCloseCalls: number[] = [];
  let sessionClosed = false;

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
            if (name === 'round-trip') return toolArguments ?? null;
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
            { appVisible: true, definition: appTool, name: 'show-weather' },
            { appVisible: true, definition: { name: 'refresh-weather' }, name: 'refresh-weather' },
            { appVisible: true, definition: { name: 'round-trip' }, name: 'round-trip' },
            { appVisible: false, definition: { name: 'delete-weather' }, name: 'delete-weather' },
          ],
          readResource: async ({ uri }) => {
            reads.push(uri);
            return { contents: [{ text: uri, type: 'text' }] };
          },
        },
        watchSessionClosed: (listener: (reason?: unknown) => Promise<void> | void) => {
          if (options.closeBeforeObservation) {
            sessionClosed = true;
            return { closed: true, unsubscribe: () => undefined };
          }
          closeListeners.add(listener);
          return { closed: sessionClosed, unsubscribe: () => closeListeners.delete(listener) };
        },
      };
    },
    closeSession: async () => {
      sessionCloseCalls.push(1);
      sessionClosed = true;
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

it('rejects forged tool metadata instead of binding a UI from another leased session', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppBindingService({ sessionAuthority: authorityFor(fixture) });

  await expect(service.createBinding({
    input: {},
    previewProfile: 'portable',
    result: {},
    sessionId: 'session-weather',
    tool: {
      ...appTool,
      _meta: { ui: { resourceUri: 'ui://different-server/forged.html' } },
    },
  })).rejects.toThrow('does not match the leased session tool');
  expect(fixture.releases).toEqual([1]);
});

it('does not return a live binding across the acquire-to-observe session close gap', async () => {
  const fixture = createSessionFixture({ closeBeforeObservation: true });
  const service = new McpAppBindingService({ sessionAuthority: authorityFor(fixture) });

  await expect(service.createBinding({
    input: {},
    previewProfile: 'portable',
    result: {},
    sessionId: 'session-weather',
    tool: appTool,
  })).rejects.toThrow('closed before its App binding completed');
  expect(fixture.releases).toEqual([1]);
});

it('round-trips immutable bridge JSON and rejects bridge operations after session close', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppBindingService({ sessionAuthority: authorityFor(fixture) });
  const binding = await service.createBinding({
    input: {},
    previewProfile: 'portable',
    result: {},
    sessionId: 'session-weather',
    tool: appTool,
  });

  const argumentsValue: McpAppJsonValue = { nested: { value: 'round-trip' } };
  const echoed = await service.callTool(binding.id, { arguments: argumentsValue, name: 'round-trip' });
  expect(echoed).toEqual({ nested: { value: 'round-trip' } });
  expect(Object.getPrototypeOf(echoed)).toBe(Object.prototype);
  await fixture.closeSession();
  await expect(service.callTool(binding.id, { arguments: {}, name: 'round-trip' })).rejects.toThrow('Unknown MCP App binding');
  await expect(service.readResource(binding.id, { uri: 'resource://weather/forecast' })).rejects.toThrow('Unknown MCP App binding');
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
