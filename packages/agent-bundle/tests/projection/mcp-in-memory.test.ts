import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from '@rstest/core';
import { createMemoryStateDriver, defineState, type AgentStateDriver } from '@agent-bundle/runtime/state';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';
import { z } from 'zod';

import stateDefinition from '../../fixtures/route-harness/src/state.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import {
  getMcpPrompt,
  invokeMcpTool,
  listMcpSurface,
  openInMemoryMcpServer,
  readMcpResource,
} from '../../src/test/mcp.ts';

/**
 * The `mcp-in-memory` proof level: the real generated MCP server, registered
 * by the same `mcp-server-runtime` module a built artifact runs, driven by a
 * real MCP SDK client over the SDK's in-memory transport pair.
 *
 * What a green run here does NOT prove: that a process starts, that stdio
 * framing is clean, or that a packed tarball contains the entry. Those are
 * the `packed-stdio` level's claims (packed-stdio-projection.test.ts).
 */
describe('the in-memory MCP projection level', () => {
  it('registers every compiled route kind on the real generated server', async () => {
    const surface = await listMcpSurface();

    expect(surface.tools).toEqual(['catalog', 'context', 'echo', 'journal', 'lifecycle', 'mutation-probe', 'publish-notice', 'strict-report', 'ticket', 'unavailable', 'wait']);
    expect(surface.prompts).toEqual(['summarize']);
    expect(surface.resources).toEqual(['harness://notes']);
    expect(surface.provenance).toMatchObject({
      proofLevel: 'mcp-in-memory',
      routeIds: [
        'prompt:harness/summarize',
        'resource:harness/notes',
        'tool:harness/catalog',
        'tool:harness/context',
        'tool:harness/echo',
        'tool:harness/journal',
        'tool:harness/lifecycle',
        'tool:harness/mutation-probe',
        'tool:harness/publish-notice',
        'tool:harness/strict-report',
        'tool:harness/ticket',
        'tool:harness/unavailable',
        'tool:harness/wait',
      ],
      serverName: 'harness',
    });
  });

  it('projects a rendered Agent Document into the protocol content the server returns', async () => {
    const invocation = await invokeMcpTool('echo', {
      context: { workspace: { source: 'native', state: 'available', value: { root: '/tmp/harness-library' } } as never },
      input: { message: 'two files ready' },
    });

    expect(invocation.isError).toBe(false);
    expect(invocation.content).toEqual([
      { text: '# Echo\n\ntwo files ready', type: 'text' },
      { text: 'workspace: /tmp/harness-library', type: 'text' },
    ]);
    expect(invocation.structuredContent).toEqual({
      message: 'two files ready',
      operationId: 'tool:harness/echo',
      workspace: '/tmp/harness-library',
    });
    expect(invocation.provenance.proofLevel).toBe('mcp-in-memory');
  });

  it('reports transport identity without accepting lookalike input fields', async () => {
    const invocation = await invokeMcpTool('context', {
      input: { host: 'spoofed-host', session: 'spoofed-session' },
    });

    expect(invocation.structuredContent).toEqual({
      actor: { reason: 'not-provided', state: 'unavailable' },
      host: {
        source: 'native',
        state: 'available',
        value: { name: 'agent-bundle-in-memory-projection' },
      },
      session: { reason: 'not-provided', state: 'unavailable' },
      workspace: {
        source: 'derived',
        state: 'available',
        value: { root: process.cwd() },
      },
    });
  });

  it('projects Agent.Result metadata to the result _meta beside the listing _meta', async () => {
    await using session = await openInMemoryMcpServer();

    const listed = await session.client.listTools();
    expect(listed.tools.find((tool) => tool.name === 'strict-report')).toMatchObject({
      _meta: { ui: { resourceUri: 'ui://route-harness/panel.html' } },
      outputSchema: { type: 'object' },
    });
    const invocation = await invokeMcpTool('strict-report', { input: { reportId: 'meta-1' } });
    expect(invocation._meta).toEqual({ ui: { resourceUri: 'ui://route-harness/panel.html' } });
    expect(invocation.structuredContent).toEqual({ reportId: 'meta-1', summary: 'summary for meta-1' });
    const echo = await invokeMcpTool('echo', { input: { message: 'no metadata' } });
    expect(echo._meta).toBeUndefined();
  });

  it('carries a represented error to the protocol as isError rather than a transport failure', async () => {
    const invocation = await invokeMcpTool('unavailable');

    expect(invocation.isError).toBe(true);
    expect(invocation.content).toContainEqual(expect.objectContaining({ type: 'text' }));
    expect(invocation.structuredContent).toEqual({ available: false });
  });

  it('resolves a suspended boundary before the server projects the result', async () => {
    const invocation = await invokeMcpTool('catalog', { input: { genre: 'mystery' } });

    expect(invocation.content).toEqual([
      { text: 'catalog: mystery', type: 'text' },
      { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
    ]);
    expect(invocation.structuredContent).toEqual({ genre: 'mystery', titles: ['Piranesi', 'Solaris'] });
  });

  it('reads a compiled resource route by its configured URI', async () => {
    const read = await readMcpResource('harness://notes');

    expect(read.contents).toEqual([
      { mimeType: 'text/markdown', text: '# Notes for harness://notes', uri: 'harness://notes' },
    ]);
    expect(read.provenance.proofLevel).toBe('mcp-in-memory');
  });

  it('gets a compiled prompt route with the arguments the client sent', async () => {
    const prompt = await getMcpPrompt('summarize', { input: { note: 'chapter one' } });

    expect(prompt.messages).toEqual([
      { content: { text: 'Summarize chapter one', type: 'text' }, role: 'user' },
    ]);
  });

  it('reuses one connected session for every call a suite makes', async () => {
    await using session = await openInMemoryMcpServer();

    const [first, second] = await Promise.all([
      session.client.callTool({ arguments: { message: 'first' }, name: 'echo' }),
      session.client.callTool({ arguments: { message: 'second' }, name: 'echo' }),
    ]);

    expect(first).toMatchObject({ structuredContent: { message: 'first' } });
    expect(second).toMatchObject({ structuredContent: { message: 'second' } });
  });

  it('mounts and tears down optional state with the in-memory warm host', async () => {
    const inner = createMemoryStateDriver({ lifetime: 'process' });
    let opens = 0;
    let closes = 0;
    const driver: AgentStateDriver = {
      ...inner,
      close: async () => {
        closes += 1;
        await inner.close();
      },
      open: async (definition) => {
        opens += 1;
        return inner.open(definition);
      },
    };
    const definition = defineState({
      events: { changed: z.object({ value: z.string() }).strict() },
      id: 'mcp-in-memory/state',
      initial: { value: '' },
      lifetime: 'process',
      reduce: (_state, event) => ({ value: event.payload.value }),
      schema: z.object({ value: z.string() }).strict(),
    });
    const session = await openInMemoryMcpServer({ state: { definition, driver } });
    try {
      await session.client.callTool({ arguments: { message: 'stateful' }, name: 'echo' });
      expect(opens).toBe(2);
    } finally {
      await session.close();
    }
    expect(closes).toBe(1);
  });

  it('persists journal state and publishes a pending notice through one mounted session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-state-'));
    const session = await openInMemoryMcpServer({
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    });
    try {
      await expect(session.client.callTool({
        arguments: { note: 'protocol proof' },
        name: 'journal',
      })).resolves.toMatchObject({
        structuredContent: {
          entries: [{ note: 'protocol proof' }],
          revision: 1,
        },
      });
      await expect(session.client.callTool({
        arguments: {},
        name: 'journal',
      })).resolves.toMatchObject({
        structuredContent: {
          entries: [{ note: 'protocol proof' }],
          revision: 1,
        },
      });
      await expect(session.client.callTool({
        arguments: { message: 'next event', recipientSession: 'proof-session' },
        name: 'publish-notice',
      })).resolves.toMatchObject({
        structuredContent: {
          noticeId: expect.any(String),
          state: 'pending',
        },
      });
    } finally {
      await session.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('injects the recipient-scoped notice inbox only for stateful servers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-inbox-'));
    const sessionIdentity = (sessionId: string) => ({
      source: 'native' as const,
      state: 'available' as const,
      value: { sessionId },
    });
    try {
      const first = await openInMemoryMcpServer({
        context: { session: sessionIdentity('s1') },
        state: {
          definition: stateDefinition,
          driver: createSqliteStateDriver({ root }),
        },
      });
      try {
        await first.client.callTool({
          arguments: { message: 'recipient notice', recipientSession: 's1' },
          name: 'publish-notice',
        });
        const resources = await first.client.listResources();
        expect(resources.resources.map((resource) => resource.uri)).toContain('agent-bundle://notices/inbox');
        const read = await first.client.readResource({ uri: 'agent-bundle://notices/inbox' });
        const content = read.contents[0];
        if (content === undefined || !('text' in content)) throw new TypeError('Expected text inbox content');
        const projection = JSON.parse(content.text) as {
          notices: readonly Readonly<Record<string, unknown>>[];
        };
        expect(projection.notices).toEqual([expect.objectContaining({
          content: {
            root: { kind: 'text', text: 'recipient notice' },
            status: 'success',
            version: 1,
          },
          exposure: expect.objectContaining({ channel: 'mcp-inbox', count: 1 }),
          state: 'pending',
        })]);
      } finally {
        await first.close();
      }

      for (const context of [{ session: sessionIdentity('s2') }, {}]) {
        const other = await openInMemoryMcpServer({
          context,
          state: {
            definition: stateDefinition,
            driver: createSqliteStateDriver({ root }),
          },
        });
        try {
          const read = await other.client.readResource({ uri: 'agent-bundle://notices/inbox' });
          const content = read.contents[0];
          if (content === undefined || !('text' in content)) throw new TypeError('Expected text inbox content');
          expect(JSON.parse(content.text)).toEqual({ notices: [] });
        } finally {
          await other.close();
        }
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }

    expect((await listMcpSurface()).resources).not.toContain('agent-bundle://notices/inbox');
  });

  // Issue #369: task-augmented tool calls are deferred until the MCP SDK ships
  // a task runtime (docs/mcp-conformance.md). Until then the generated server
  // must stay fail-closed — no `tasks` capability claim — and must process a
  // task-augmented request as an ordinary one, which is what the 2025-11-25
  // Tasks utility requires of a receiver that declared no task support.
  it('never advertises the MCP Tasks capability', async () => {
    await using session = await openInMemoryMcpServer();

    const capabilities = session.client.getServerCapabilities();
    expect(capabilities).toMatchObject({ tools: expect.any(Object) });
    expect(Object.hasOwn(capabilities ?? {}, 'tasks')).toBe(false);
  });

  it('processes a task-augmented tools/call as an ordinary request', async () => {
    await using session = await openInMemoryMcpServer();

    const result = await session.client.request({
      method: 'tools/call',
      params: { arguments: { message: 'deferred' }, name: 'echo', task: { ttl: 60_000 } },
    });

    expect(result).toMatchObject({ structuredContent: { message: 'deferred' } });
    for (const key of ['task', 'taskId', 'status', 'createdAt', 'ttl', 'pollInterval']) {
      expect(Object.hasOwn(result, key)).toBe(false);
    }
  });

  // Compile-time half of the #369 sentinel: the SDK's spec-method handler
  // overload rejects task methods today. When a release admits them, this
  // directive becomes unused, `pnpm typecheck` fails, and the deferral in
  // docs/mcp-conformance.md must be re-audited. Never invoked at runtime.
  const typedTaskSurfaceSentinel = (server: McpServer): void => {
    // @ts-expect-error tasks/get is 2025-11-25 wire vocabulary without an SDK runtime.
    server.server.setRequestHandler('tasks/get', async () => ({}));
  };
  void typedTaskSurfaceSentinel;

  it('leaves the browser App surface off the in-memory server', async () => {
    const surface = await listMcpSurface();

    expect(surface.resources).not.toContain('ui://route-harness/panel.html');
    expect(surface.provenance.routeIds).not.toContain('app:harness/panel');
  });

  it('names the compiled servers when the requested one does not exist', async () => {
    const error = await listMcpSurface({ server: 'missing' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('server-not-found');
    expect((error as AgentTestError).message).toContain('harness');
    expect((error as AgentTestError).message).toContain('recovery:');
  });
});
