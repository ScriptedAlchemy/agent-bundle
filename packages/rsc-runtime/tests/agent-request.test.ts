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
  useAgent,
} from '../src/index.js';
import {
  AGENT_REQUEST_STORE_VERSION as pluginStoreVersion,
  AgentRequestError as PluginAgentRequestError,
  agent as pluginAgent,
  runAgentRequest as pluginRunAgentRequest,
  useAgent as pluginUseAgent,
} from '../src/plugin.js';

const STORE_SYMBOL = Symbol.for('@agent-bundle/runtime/request-store');

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
      expect(context.terminal).toEqual(unavailable());
      expect(Object.hasOwn(context.host, 'value')).toBe(false);
    });
  });

  it('exposes the mounted terminal capability as a frozen Observed axis (#511)', async () => {
    const terminal = {
      hostSurface: 'cli' as const,
      sharesTarget: true,
      stderr: { color: 'basic' as const, columns: 120, kind: 'tty' as const, rows: 40 },
      stdout: { color: 'basic' as const, columns: 120, kind: 'tty' as const, rows: 40 },
    };
    await runAgentRequest({ ...init('cli'), terminal: available(terminal, 'native') }, async () => {
      const context = await agent();
      expect(context.terminal).toEqual({ source: 'native', state: 'available', value: terminal });
      if (context.terminal.state !== 'available') throw new Error('expected an available terminal');
      expect(Object.isFrozen(context.terminal.value)).toBe(true);
      expect(Object.isFrozen(context.terminal.value.stdout)).toBe(true);
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

  it('snapshots plain Observed inputs at the request boundary so caller mutation cannot leak', async () => {
    const hostValue = { name: 'claude' };
    const host = { state: 'available' as const, source: 'native' as const, value: hostValue };
    const roots = ['/tmp/project'];
    const filesystem = { state: 'available' as const, source: 'native' as const, value: { roots } };
    const command = { state: 'unavailable' as const, reason: 'not-provided' as const };
    const capabilities = {
      command,
      filesystem,
      network: { state: 'unavailable' as const, reason: 'not-provided' as const },
      projectRoot: { state: 'unavailable' as const, reason: 'not-provided' as const },
    };

    await runAgentRequest({
      capabilities,
      host,
      invocation: { kind: 'tool' },
    }, async () => {
      hostValue.name = 'mutated';
      roots.push('/tmp/other');
      (host as { state: string }).state = 'unavailable';
      (command as { reason: string }).reason = 'unauthenticated';

      const context = await agent();
      expect(context.host).toEqual({ source: 'native', state: 'available', value: { name: 'claude' } });
      expect(context.capabilities.filesystem).toEqual({
        source: 'native',
        state: 'available',
        value: { roots: ['/tmp/project'] },
      });
      expect(context.capabilities.command).toEqual({ reason: 'not-provided', state: 'unavailable' });
      expect(Object.isFrozen(context.host)).toBe(true);
      if (context.host.state === 'available') {
        expect(Object.isFrozen(context.host.value)).toBe(true);
      }
      if (context.capabilities.filesystem.state === 'available') {
        expect(Object.isFrozen(context.capabilities.filesystem.value.roots)).toBe(true);
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

  it('returns the identical handle synchronously through useAgent() under the same lease rules', async () => {
    let captured: ReturnType<typeof useAgent> | undefined;
    await runAgentRequest(init('tool', 'sync'), async () => {
      const synchronous = useAgent();
      captured = synchronous;
      expect(synchronous).toBe(await agent());
      expect(synchronous.invocation.id).toBe('sync');
      await Promise.resolve();
      expect(useAgent()).toBe(synchronous);
    });
    // After runAgentRequest() settles the caller's async context is restored,
    // so a fresh useAgent() call is `outside-invocation` — the same code
    // agent() rejects with. Only the handle captured inside the request (or a
    // continuation that retained its closed lease) reports `request-closed`.
    expect(() => useAgent()).toThrow(AgentRequestError);
    try {
      useAgent();
      throw new Error('expected useAgent() outside an invocation to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'outside-invocation' });
    }
    expect(() => captured?.invocation).toThrow(AgentRequestError);
    try {
      void captured?.invocation;
      throw new Error('expected the captured handle to be closed');
    } catch (error) {
      expect(error).toMatchObject({ code: 'request-closed' });
    }
  });

  it('resolves a providers function over a read-only request view, after the notice lease opens and outside any request context (#459)', async () => {
    const events: string[] = [];
    const stateHandle = {
      changes: async () => { throw new Error('unreachable'); },
      dispatch: async () => { events.push('dispatch'); throw new Error('unreachable'); },
      lifetime: 'workspace-durable' as const,
      read: async (options?: { readonly revision?: number }) => ({ revision: options?.revision ?? 7, state: { notes: [] } }),
    };
    const ledger = {
      openRequest: async (request: { readonly invocation: { readonly id: string } }) => {
        events.push(`open:${request.invocation.id}`);
        return {
          close: () => { events.push('close'); },
          handle: {
            acknowledge: async () => { throw new Error('unreachable'); },
            inbox: async () => { events.push('inbox'); return []; },
            publish: async () => { throw new Error('unreachable'); },
            read: async () => [],
          },
        };
      },
    };
    let view: Record<string, unknown> | undefined;
    let inside: unknown;
    const result = await runAgentRequest({
      ...init('event', 'evt-1'),
      host: available({ name: 'claude' }, 'native'),
      lineage: available({ conversation: 'root', depth: 0, resolution: 'native', root: 'root', tree: { children: [], roots: [], siblings: [] } }, 'native'),
      noticeLedger: ledger as never,
      providers: async (request) => {
        events.push('providers');
        view = request as unknown as Record<string, unknown>;
        try {
          useAgent();
          inside = 'reachable';
        } catch (error) {
          inside = error instanceof AgentRequestError ? error.code : error;
        }
        const snapshot = await request.state!.read({ revision: 3 });
        const pending = await request.notices!.inbox();
        return { topology: { pending: pending.length, revision: snapshot.revision, siblings: request.lineage.state === 'available' ? request.lineage.value.tree?.siblings.length : undefined } };
      },
      state: stateHandle as never,
    }, async () => {
      events.push('operation');
      return (await agent()).providers;
    });

    // Order: lease open → providers → operation → lease close; the resolver saw the real inbox.
    expect(events).toEqual(['open:evt-1', 'providers', 'inbox', 'operation', 'close']);
    expect(result).toEqual({ topology: { pending: 0, revision: 3, siblings: 0 } });
    expect(Object.isFrozen(result)).toBe(true);
    // The view is frozen, carries exactly the read-only members, and the handles are narrowed by construction.
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.keys(view!).sort()).toEqual(['host', 'lineage', 'notices', 'session', 'signal', 'state', 'workspace']);
    expect(Object.keys(view!['state'] as object).sort()).toEqual(['lifetime', 'read']);
    expect(Object.keys(view!['notices'] as object)).toEqual(['inbox']);
    expect(view!['host']).toEqual(available({ name: 'claude' }, 'native'));
    expect(view!['session']).toEqual(unavailable());
    // Providers never observe a request handle, so no write path is reachable through `agent()`.
    expect(inside).toBe('outside-invocation');
  });

  it('keeps a providers function outside an enclosing request context, and fails the request closed when it rejects', async () => {
    let inside: unknown;
    await runAgentRequest(init('tool', 'outer'), async () => {
      const outer = await agent();
      expect(outer.invocation.id).toBe('outer');
      await runAgentRequest({
        ...init('tool', 'inner'),
        providers: () => {
          try {
            inside = useAgent().invocation.id;
          } catch (error) {
            inside = error instanceof AgentRequestError ? error.code : error;
          }
          return {};
        },
      }, async () => undefined);
      // The outer context is intact once the inner request settles.
      expect((await agent()).invocation.id).toBe('outer');
    });
    expect(inside).toBe('outside-invocation');

    let closed = false;
    let ran = false;
    await expect(runAgentRequest({
      ...init('tool'),
      noticeLedger: {
        openRequest: async () => ({ close: () => { closed = true; }, handle: {} }),
      } as never,
      providers: async () => { throw new Error('ffprobe is not installed'); },
    }, async () => { ran = true; })).rejects.toThrow('ffprobe is not installed');
    expect(ran).toBe(false);
    expect(closed).toBe(true);
    // A plain record is still mounted as before.
    expect(await runAgentRequest({ ...init('tool'), providers: { library: 'x' } }, async () => (await agent()).providers)).toEqual({ library: 'x' });
  });

  it('re-exports the request store from the plugin entry', () => {
    expect(pluginUseAgent).toBe(useAgent);
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
        terminal: context.terminal.state === 'available'
          ? `${context.terminal.source} ${context.terminal.value.hostSurface}/${context.terminal.value.stdout.kind}/${context.terminal.value.stderr.kind}`
          : `unavailable:${context.terminal.reason}`,
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
      terminal: z.string(),
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
      // The adapter owns no probe: without a caller-supplied terminal the axis is honestly absent (#511).
      terminal: 'unavailable:not-provided',
    });
    await expect(agent()).rejects.toMatchObject({ code: 'outside-invocation' });

    const probed: string[] = [];
    await runRscCli(application, ['status'], {
      terminal: {
        hostSurface: 'cli',
        sharesTarget: true,
        stderr: { color: 'basic', columns: 80, kind: 'tty', rows: 24 },
        stdout: { color: 'basic', columns: 80, kind: 'tty', rows: 24 },
      },
      write: (value) => probed.push(value),
    });
    expect(JSON.parse(probed.join(''))).toMatchObject({ terminal: 'native cli/tty/tty' });
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
      // An MCP server has no terminal, whatever its descriptors are (#511).
      terminal: 'derived mcp/none/none',
    });
    await expect(agent()).rejects.toMatchObject({ code: 'outside-invocation' });
  });
});
