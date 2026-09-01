import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import {
  AGENT_REQUEST_STORE_VERSION,
  AgentRequestError,
  agent,
  available,
  createRscMcpServer,
  defineOperation,
  defineRscApplication,
  runAgentRequest,
  runRscCli,
  unavailable,
} from '../src/index.js';
import {
  AGENT_REQUEST_STORE_VERSION as pluginStoreVersion,
  AgentRequestError as PluginAgentRequestError,
  agent as pluginAgent,
  runAgentRequest as pluginRunAgentRequest,
} from '../src/plugin.js';

const STORE_SYMBOL = Symbol.for('@agent-bundle/rsc-runtime/request-store');

const init = (kind: 'tool' | 'event' | 'cli' | 'script' | 'workbench', id?: string) => ({
  invocation: { ...(id === undefined ? {} : { id }), kind },
});

describe('agent request store', () => {
  it('exposes Observed identities, invocation kind, and reserved extension slots', async () => {
    await runAgentRequest({
      host: available({ name: 'claude' }, 'native'),
      invocation: {
        artifactEpoch: 'epoch-1',
        id: 'inv-1',
        kind: 'event',
        operationId: 'after-file-edit',
        protocolRevision: '1',
        sourceRevision: 'src-1',
        surface: 'hook/after-file-edit',
      },
      providers: { gitWorktree: { path: '/tmp/worktree' } },
      session: available({ sessionId: 'session-1' }, 'native'),
      services: { snapshot: { stateVersion: 1 } },
      workspace: available({ root: '/tmp/project' }, 'native'),
    }, async () => {
      const context = await agent();
      expect(context.invocation).toMatchObject({
        artifactEpoch: 'epoch-1',
        id: 'inv-1',
        kind: 'event',
        operationId: 'after-file-edit',
        protocolRevision: '1',
        sourceRevision: 'src-1',
        surface: 'hook/after-file-edit',
      });
      expect(context.host).toEqual({ source: 'native', state: 'available', value: { name: 'claude' } });
      expect(context.session).toEqual({ source: 'native', state: 'available', value: { sessionId: 'session-1' } });
      expect(context.actor).toEqual({ reason: 'not-provided', state: 'unavailable' });
      expect(context.workspace).toEqual({ source: 'native', state: 'available', value: { root: '/tmp/project' } });
      expect(context.capabilities.filesystem.state).toBe('unavailable');
      expect(context.capabilities.command.state).toBe('unavailable');
      expect(context.capabilities.network.state).toBe('unavailable');
      expect(context.capabilities.projectRoot.state).toBe('unavailable');
      expect(context.services).toEqual({ snapshot: { stateVersion: 1 } });
      expect(context.providers).toEqual({ gitWorktree: { path: '/tmp/worktree' } });
      expect(context.state).toBeUndefined();
      expect(context.notices).toBeUndefined();
      expect(Object.hasOwn(context, 'state')).toBe(true);
      expect(Object.hasOwn(context, 'notices')).toBe(true);
      expect(Object.hasOwn(context, 'providers')).toBe(true);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.invocation)).toBe(true);
      expect(Object.isFrozen(context.host)).toBe(true);
    });
  });

  it('uses a typed error for invalid invocation fields', async () => {
    await expect(runAgentRequest({ invocation: { id: ' ', kind: 'tool' } }, () => undefined)).rejects.toMatchObject({
      code: 'invalid-invocation',
    });
    await expect(runAgentRequest({ invocation: { id: ' ', kind: 'tool' } }, () => undefined)).rejects.toBeInstanceOf(
      AgentRequestError,
    );
  });

  it('never fabricates an identity string for a missing principal', async () => {
    await runAgentRequest(init('tool'), async () => {
      const context = await agent();
      expect(context.host).toEqual(unavailable());
      expect(context.session).toEqual(unavailable());
      expect(context.actor).toEqual(unavailable());
      expect(context.workspace).toEqual(unavailable());
      expect(Object.hasOwn(context.host, 'value')).toBe(false);
    });
  });

  it('snapshots nested capability lists so caller mutation cannot leak into the request', async () => {
    const roots = ['/tmp/project'];
    const allow = ['example.test'];
    await runAgentRequest({
      capabilities: {
        command: unavailable(),
        filesystem: available({ roots }, 'native'),
        network: available({ allow }, 'native'),
        projectRoot: unavailable(),
      },
      invocation: { kind: 'tool' },
    }, async () => {
      roots.push('/tmp/other');
      allow.push('evil.test');
      const context = await agent();
      expect(context.capabilities.filesystem).toEqual({
        source: 'native',
        state: 'available',
        value: { roots: ['/tmp/project'] },
      });
      expect(context.capabilities.network).toEqual({
        source: 'native',
        state: 'available',
        value: { allow: ['example.test'] },
      });
      if (context.capabilities.filesystem.state === 'available') {
        expect(Object.isFrozen(context.capabilities.filesystem.value.roots)).toBe(true);
      }
      if (context.capabilities.network.state === 'available') {
        expect(Object.isFrozen(context.capabilities.network.value.allow)).toBe(true);
      }
    });
  });

  it('isolates concurrent invocations including identities and provider values', async () => {
    const barrier = Promise.withResolvers<void>();
    const first = runAgentRequest({
      invocation: { id: 'a', kind: 'event' },
      providers: { edit: 'first' },
      session: available({ sessionId: 'session-a' }, 'native'),
    }, async () => {
      await barrier.promise;
      const context = await agent();
      return {
        id: context.invocation.id,
        provider: context.providers.edit,
        session: context.session.state === 'available' ? context.session.value.sessionId : 'missing',
      };
    });
    const second = runAgentRequest({
      invocation: { id: 'b', kind: 'cli' },
      providers: { edit: 'second' },
      session: available({ sessionId: 'session-b' }, 'native'),
    }, async () => {
      barrier.resolve();
      const context = await agent();
      return {
        id: context.invocation.id,
        provider: context.providers.edit,
        session: context.session.state === 'available' ? context.session.value.sessionId : 'missing',
      };
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 'a', provider: 'first', session: 'session-a' },
      { id: 'b', provider: 'second', session: 'session-b' },
    ]);
  });

  it('rejects agent() outside a real invocation', async () => {
    await expect(agent()).rejects.toMatchObject({
      code: 'outside-invocation',
      message: 'agent() used outside a real invocation',
    });
    await expect(agent()).rejects.toBeInstanceOf(AgentRequestError);
  });

  it('rejects a captured handle after the request completes', async () => {
    let handle: Awaited<ReturnType<typeof agent>> | undefined;
    await runAgentRequest(init('tool', 'closed'), async () => {
      handle = await agent();
      expect(handle.invocation.id).toBe('closed');
    });
    expect(handle).toBeDefined();
    expect(() => handle?.invocation).toThrow(AgentRequestError);
    try {
      void handle?.invocation;
      throw new Error('expected captured handle access to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'request-closed' });
    }
  });

  it('rejects escaped continuations after the request completes', async () => {
    let escaped: Promise<unknown> | undefined;
    await runAgentRequest(init('script'), () => {
      escaped = Promise.resolve().then(async () => {
        await Promise.resolve();
        return agent();
      });
      void escaped.then(() => undefined, () => undefined);
    });
    expect(escaped).toBeDefined();
    try {
      await escaped;
      throw new Error('expected escaped agent() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRequestError);
      expect(error).toMatchObject({
        code: expect.stringMatching(/^(?:request-closed|outside-invocation)$/u),
      });
    }
  });

  it('rejects a conflicting store version planted on the realm singleton', async () => {
    const globalSymbols = globalThis as typeof globalThis & Record<symbol, unknown>;
    const previous = globalSymbols[STORE_SYMBOL];
    globalSymbols[STORE_SYMBOL] = { version: AGENT_REQUEST_STORE_VERSION + 1 };
    try {
      await expect(runAgentRequest(init('tool'), () => undefined)).rejects.toBeInstanceOf(AgentRequestError);
      await expect(runAgentRequest(init('tool'), () => undefined)).rejects.toMatchObject({
        code: 'store-version-conflict',
      });
    } finally {
      if (previous === undefined) {
        delete globalSymbols[STORE_SYMBOL];
      } else {
        globalSymbols[STORE_SYMBOL] = previous;
      }
    }
  });

  it('survives await inside the request and is absent afterward', async () => {
    const seen = await runAgentRequest(init('workbench', 'awaited'), async () => {
      await Promise.resolve();
      return (await agent()).invocation.id;
    });
    expect(seen).toBe('awaited');
    await expect(agent()).rejects.toMatchObject({ code: 'outside-invocation' });
  });

  it('re-exports the request store from the plugin entry', () => {
    expect(pluginAgent).toBe(agent);
    expect(pluginRunAgentRequest).toBe(runAgentRequest);
    expect(PluginAgentRequestError).toBe(AgentRequestError);
    expect(pluginStoreVersion).toBe(AGENT_REQUEST_STORE_VERSION);
  });
});

describe('entrypoint bindings', () => {
  const status = defineOperation({
    cli: {
      name: 'status',
      parse: () => ({}),
      summary: 'Read status.',
      usage: 'status',
    },
    execute: async () => {
      const context = await agent();
      return {
        kind: context.invocation.kind,
        operationId: context.invocation.operationId,
        surface: context.invocation.surface,
      };
    },
    id: 'status',
    inputSchema: z.object({}).strict(),
    mcp: {
      description: 'Read status.',
      name: 'runtime_status',
      readOnly: true,
      server: 'runtime',
    },
    render: (result) => createElement(
      'mcp-result',
      { structuredContent: result },
      createElement('mcp-text', null, result.kind),
    ),
    resultSchema: z.object({
      kind: z.enum(['tool', 'event', 'cli', 'script', 'workbench']),
      operationId: z.string().optional(),
      surface: z.string().optional(),
    }).strict(),
  });
  const application = defineRscApplication({
    name: 'runtime',
    operations: [status],
    version: '1.0.0',
  });
  const openClients: Client[] = [];

  afterAll(async () => {
    await Promise.allSettled(openClients.map((client) => client.close()));
  });

  it('installs a cli invocation for runRscCli', async () => {
    const output: string[] = [];
    await expect(runRscCli(application, ['status'], { write: (value) => output.push(value) })).resolves.toBe(0);
    expect(JSON.parse(output.join(''))).toEqual({
      kind: 'cli',
      operationId: 'status',
      surface: 'status',
    });
    await expect(agent()).rejects.toMatchObject({ code: 'outside-invocation' });
  });

  it('installs a tool invocation for createRscMcpServer', async () => {
    const server = createRscMcpServer(application, 'runtime');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'agent-request-test', version: '0.0.0' });
    openClients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ arguments: {}, name: 'runtime_status' });
    expect(result.structuredContent).toEqual({
      kind: 'tool',
      operationId: 'status',
      surface: 'runtime_status',
    });
    await expect(agent()).rejects.toMatchObject({ code: 'outside-invocation' });
  });
});
