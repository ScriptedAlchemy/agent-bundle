import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { specTypeSchemas as clientSchemas } from '@modelcontextprotocol/client';
import { describe, expect, it } from '@rstest/core';
import { agentNoticeStateDefinition } from '@agent-bundle/runtime/notices';
import { createMemoryStateDriver, defineState, type AgentStateDriver } from '@agent-bundle/runtime/state';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';
import { z } from 'zod';

import stateDefinition from '../../fixtures/route-harness/src/state.ts';
import { createDefaultRegistry } from '../../src/adapters/registry.ts';
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

    expect(surface.tools).toEqual(['catalog', 'context', 'echo', 'fault', 'journal', 'layout-probe', 'lifecycle', 'mutation-probe', 'plugin-root', 'publish-notice', 'strict-report', 'submit', 'ticket', 'tooling', 'unavailable', 'wait']);
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
        'tool:harness/fault',
        'tool:harness/journal',
        'tool:harness/layout-probe',
        'tool:harness/lifecycle',
        'tool:harness/mutation-probe',
        'tool:harness/plugin-root',
        'tool:harness/publish-notice',
        'tool:harness/strict-report',
        'tool:harness/submit',
        'tool:harness/ticket',
        'tool:harness/tooling',
        'tool:harness/unavailable',
        'tool:harness/wait',
      ],
      serverName: 'harness',
    });
  });

  it('composes the compiled layout chain around a tool while the route keeps its protocol result shape', async () => {
    const invocation = await invokeMcpTool('layout-probe', { input: { label: 'wired' } });

    expect(invocation.isError).toBe(false);
    // The route's own text, then the server layout's addition for this route:
    // the layout's container result merged with the route's valued result.
    expect(invocation.content).toEqual([
      { text: 'probe: wired', type: 'text' },
      { text: 'layout: tool layout-probe via mcp:harness', type: 'text' },
    ]);
    expect(invocation.structuredContent).toEqual({ label: 'wired' });
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
      lineage: { reason: 'not-provided', state: 'unavailable' },
      session: { reason: 'not-provided', state: 'unavailable' },
      // The generated server's stdout is the protocol wire: no terminal, never probed (#511).
      terminal: {
        source: 'derived',
        state: 'available',
        value: {
          hostSurface: 'mcp',
          sharesTarget: false,
          stderr: { color: 'none', kind: 'none' },
          stdout: { color: 'none', kind: 'none' },
        },
      },
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
    // The route's own metadata reaches _meta merged with the fixture's root and
    // server layout metadata (the layouts are containers, so the route's keys
    // sit beside theirs); the metadata-free echo route carries only the
    // layouts' keys. A layout-free document with no metadata projects no _meta
    // at all — pinned by mcp-projector.test.ts and generated-route-server.test.ts.
    const layoutMeta = (routeId: string) => ({
      invocation: 'tool',
      layout: 'harness',
      route: routeId,
      server: 'mcp:harness',
      shell: 'route-harness',
      wrapped: 'tool',
    });
    const invocation = await invokeMcpTool('strict-report', { input: { reportId: 'meta-1' } });
    expect(invocation._meta).toEqual({
      ...layoutMeta('tool:harness/strict-report'),
      ui: { resourceUri: 'ui://route-harness/panel.html' },
    });
    expect(invocation.structuredContent).toEqual({ reportId: 'meta-1', summary: 'summary for meta-1' });
    const echo = await invokeMcpTool('echo', { input: { message: 'no metadata' } });
    expect(echo._meta).toEqual(layoutMeta('tool:harness/echo'));
  });

  it('carries a represented error to the protocol as isError rather than a transport failure', async () => {
    const invocation = await invokeMcpTool('unavailable');

    expect(invocation.isError).toBe(true);
    expect(invocation.content).toContainEqual(expect.objectContaining({ type: 'text' }));
    expect(invocation.structuredContent).toEqual({ available: false });
  });

  describe('a tool route that throws instead of rendering Agent.Error (#492)', () => {
    it('reaches the wire as the SDK default tool error: message text, isError, no _meta, no structuredContent', async () => {
      await using session = await openInMemoryMcpServer();

      // No document exists, so nothing agent-bundle projects — layout `_meta`,
      // `structuredContent`, a `[code]` prefix — can be present. The result is
      // exactly what @modelcontextprotocol/server's `createToolError` builds
      // from the thrown error's message.
      const result = await session.client.callTool({ arguments: { mode: 'throw' }, name: 'fault' });
      expect(result).toEqual({
        content: [{ text: 'fault: route threw', type: 'text' }],
        isError: true,
      });
      expect(result).not.toHaveProperty('_meta');
      expect(result).not.toHaveProperty('structuredContent');

      // The session is still usable: the failure was a result, not a transport error.
      const ok = await session.client.callTool({ arguments: { mode: 'ok' }, name: 'fault' });
      expect(ok).toMatchObject({ structuredContent: { mode: 'ok', settled: true } });
      expect(ok).not.toHaveProperty('isError');
    });

    it('keeps the layout shell when only a nested Suspense boundary rejects: represented error with code "boundary"', async () => {
      const invocation = await invokeMcpTool('fault', { input: { mode: 'reject-boundary' } });

      // The reconciler folds the rejected boundary into the streamed document
      // as an error node, so this is the same wire shape `<Agent.Error
      // code="boundary">` would produce: layout `_meta` survives, the route's
      // value is still `structuredContent`, and the text carries the code.
      expect(invocation.isError).toBe(true);
      expect(invocation._meta).toMatchObject({ layout: 'harness', route: 'tool:harness/fault', server: 'mcp:harness' });
      expect(invocation.content).toEqual([
        { text: 'fault: reject-boundary', type: 'text' },
        { text: '[boundary] fault: boundary rejected', type: 'text' },
      ]);
      expect(invocation.structuredContent).toEqual({ mode: 'reject-boundary', settled: true });
    });
  });

  it('resolves a suspended boundary before the server projects the result', async () => {
    const invocation = await invokeMcpTool('catalog', { input: { genre: 'mystery' } });

    expect(invocation.content).toEqual([
      { text: 'catalog: mystery', type: 'text' },
      { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
    ]);
    expect(invocation.structuredContent).toEqual({ genre: 'mystery', titles: ['Piranesi', 'Solaris'] });
  });

  it('notifies the client of a streamed Agent.Progress fallback under its own progress token (#448)', async () => {
    await using session = await openInMemoryMcpServer();
    const notifications: unknown[] = [];
    session.client.setNotificationHandler('notifications/progress', (notification) => {
      notifications.push(notification.params);
    });

    // Without a token the same render produces no notification at all.
    await session.client.callTool({ arguments: { genre: 'mystery' }, name: 'catalog' });
    expect(notifications).toEqual([]);

    // The catalog route never calls `progress.report()`; the request's own
    // `_meta.progressToken` is what turns its streamed fallback into the wire
    // notification, exactly as for an explicit report.
    const result = await session.client.callTool({
      arguments: { genre: 'mystery' },
      name: 'catalog',
      _meta: { progressToken: 'tok-448' },
    });

    expect(notifications).toEqual([
      { message: 'loading mystery', progress: 0, progressToken: 'tok-448', total: 2 },
    ]);
    expect(result).toMatchObject({
      content: [
        { text: 'catalog: mystery', type: 'text' },
        { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
      ],
      structuredContent: { genre: 'mystery', titles: ['Piranesi', 'Solaris'] },
    });
  });

  describe('a tool that declares its own render budget (#454)', () => {
    // The `wait` route declares `config.render.maxElapsedMs: 120_000`. With
    // the server dispatcher's base lowered to 100ms, a 300ms hold completes
    // only because the compiled budget reached the render session; a route
    // without one (`catalog` here, held by its own Suspense boundary) is
    // still bound by the base. The projector keeps forwarding progress for
    // the whole render, which is what keeps a host's idle timer alive.
    it('renders past the base limit under its declared budget and keeps progress notifications flowing', async () => {
      await using session = await openInMemoryMcpServer({ limits: { maxElapsedMs: 100 } });
      const notifications: { readonly progress: number; readonly total?: number }[] = [];
      session.client.setNotificationHandler('notifications/progress', (notification) => {
        notifications.push({ progress: notification.params.progress, ...(notification.params.total === undefined ? {} : { total: notification.params.total }) });
      });

      const result = await session.client.callTool({
        _meta: { progressToken: 'tok-454' },
        arguments: { holdMs: 300, tickMs: 100 },
        name: 'wait',
      });

      expect(result).toMatchObject({ structuredContent: { waitedMs: 300 } });
      expect(result).not.toHaveProperty('isError');
      expect(notifications).toEqual([
        { progress: 1, total: 3 },
        { progress: 2, total: 3 },
        { progress: 3, total: 3 },
      ]);
    });

    it('still bounds a route without a declared budget by the dispatcher base', async () => {
      await using session = await openInMemoryMcpServer({ limits: { maxElapsedMs: 1 } });

      // The route reaches emit time past a 1ms budget on any machine; the
      // contract error is the SDK's default tool error on the wire.
      const result = await session.client.callTool({ arguments: { genre: 'mystery' }, name: 'catalog' });
      expect(result).toMatchObject({
        content: [{ text: expect.stringContaining('elapsed time exceeds 1ms'), type: 'text' }],
        isError: true,
      });
    });
  });

  it('publishes the plugin root the server process resolved on every tool call, and forwards a context override (#468)', async () => {
    const anchor = 'AGENT_BUNDLE_PLUGIN_ROOT';
    const previous = process.env[anchor];
    process.env[anchor] = '/installs/harness';
    try {
      // The server resolves the anchor once when it opens, exactly as the
      // generated entry does at startup; every request then observes it.
      await using session = await openInMemoryMcpServer();
      const result = await session.client.callTool({ arguments: {}, name: 'plugin-root' });
      expect(result).toMatchObject({
        structuredContent: {
          plugin: { source: 'native', state: 'available', value: { root: '/installs/harness', stateRoot: '/installs/harness/state' } },
        },
      });
    } finally {
      if (previous === undefined) delete process.env[anchor];
      else process.env[anchor] = previous;
    }

    const injected = await invokeMcpTool('plugin-root', {
      context: { plugin: { source: 'receipt', state: 'available', value: { root: '/fixture', stateRoot: '/fixture/state' } } as never },
    });
    expect(injected.structuredContent).toEqual({
      plugin: { source: 'receipt', state: 'available', value: { root: '/fixture', stateRoot: '/fixture/state' } },
    });
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

  it('discloses inbox content per sensitivity under the host advertisement: redacted, full, or withheld (#99 item 7)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-inbox-redaction-'));
    const secretText = 'Rotate token=abc123def456 at https://ops:hunter2@vault.example.test/x';
    const readInbox = async (session: Awaited<ReturnType<typeof openInMemoryMcpServer>>) => {
      const read = await session.client.readResource({ uri: 'agent-bundle://notices/inbox' });
      const content = read.contents[0];
      if (content === undefined || !('text' in content)) throw new TypeError('Expected text inbox content');
      return (JSON.parse(content.text) as { notices: readonly Readonly<Record<string, unknown>>[] }).notices;
    };
    try {
      // The claude advertisement admits `internal` on the inbox, so a secret
      // notice is withheld there while it is still admitted on next-event.
      const session = await openInMemoryMcpServer({
        context: { session: { source: 'native', state: 'available', value: { sessionId: 's1' } } },
        state: {
          definition: stateDefinition,
          driver: createSqliteStateDriver({ root }),
          noticeDelivery: createDefaultRegistry().noticeDelivery('claude'),
        },
      });
      try {
        // The fixture keys idempotency on the message, so each class gets its own text.
        for (const sensitivity of ['internal', 'public', 'secret'] as const) {
          await expect(session.client.callTool({
            arguments: { message: `${secretText} (${sensitivity})`, recipientSession: 's1', sensitivity },
            name: 'publish-notice',
          })).resolves.toMatchObject({ structuredContent: { sensitivity, state: 'pending' } });
        }
        const notices = await readInbox(session);
        const shown = notices
          .map((notice) => ({ disclosure: notice.disclosure, sensitivity: notice.sensitivity, text: (notice.content as { root: { text: string } }).root.text }))
          .toSorted((left, right) => String(left.sensitivity).localeCompare(String(right.sensitivity)));
        expect(shown).toEqual([
          {
            disclosure: { redacted: true, route: 'mcp-inbox' },
            sensitivity: 'internal',
            text: 'Rotate [REDACTED] at [REDACTED]vault.example.test/x (internal)',
          },
          {
            disclosure: { redacted: false, route: 'mcp-inbox' },
            sensitivity: 'public',
            text: `${secretText} (public)`,
          },
        ]);
      } finally {
        await session.close();
      }
      // Reading the inbox exposed the disclosed notices and recorded the
      // refusal on the withheld one; nothing was exposed for it. The store
      // keeps every notice as authored: redaction happened on egress only.
      const driver = createSqliteStateDriver({ root });
      try {
        const store = await driver.open(agentNoticeStateDefinition());
        const durable = await store.read();
        const byClass = new Map(durable.state.notices.map((notice) => [notice.sensitivity, notice]));
        expect(byClass.get('internal')?.exposure?.count).toBe(1);
        expect(byClass.get('public')?.exposure?.count).toBe(1);
        expect(byClass.get('secret')?.exposure).toBeUndefined();
        expect(byClass.get('secret')?.withheld).toEqual({
          'mcp-inbox': expect.objectContaining({ count: 1, reason: 'sensitivity-exceeds-route' }),
        });
        expect(durable.state.notices.every((notice) => (notice.content.root as { text: string }).text.startsWith(secretText))).toBe(true);
      } finally {
        await driver.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  describe('task-augmented tool calls (#369)', () => {
    const RELATED_TASK = 'io.modelcontextprotocol/related-task';
    const createTask = (
      client: Awaited<ReturnType<typeof openInMemoryMcpServer>>['client'],
      name: string,
      args: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ) => client.request({
      method: 'tools/call',
      params: { ...(meta === undefined ? {} : { _meta: meta }), arguments: args, name, task: { pollInterval: 100, ttl: 60_000 } },
    }, clientSchemas.CreateTaskResult);
    const getTask = (client: Awaited<ReturnType<typeof openInMemoryMcpServer>>['client'], taskId: string) =>
      client.request({ method: 'tasks/get', params: { taskId } }, clientSchemas.GetTaskResult);
    const getResult = (client: Awaited<ReturnType<typeof openInMemoryMcpServer>>['client'], taskId: string) =>
      client.request({ method: 'tasks/result', params: { taskId } }, clientSchemas.CallToolResult);
    const rpcError = async (promise: Promise<unknown>): Promise<{ readonly code: number; readonly message: string }> => {
      try {
        await promise;
      } catch (error) {
        const { code, message } = error as { code: number; message: string };
        return { code, message };
      }
      throw new Error('Expected the request to fail');
    };

    it('advertises the tasks capability and the compiled execution.taskSupport of the routes that opted in', async () => {
      await using session = await openInMemoryMcpServer();

      expect(session.client.getServerCapabilities()?.tasks).toEqual({ cancel: {}, list: {}, requests: { tools: { call: {} } } });
      const listed = await session.client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      expect(byName.get('wait')?.execution).toEqual({ taskSupport: 'optional' });
      expect(byName.get('catalog')?.execution).toEqual({ taskSupport: 'optional' });
      expect(byName.get('echo')?.execution).toBeUndefined();
    });

    it('returns a CreateTaskResult first and the same final CallToolResult through tasks/result', async () => {
      await using session = await openInMemoryMcpServer();

      const created = await createTask(session.client, 'wait', { holdMs: 200, tickMs: 100 });
      expect(created.task).toMatchObject({ pollInterval: 100, status: 'working', ttl: 60_000 });
      // The render is still running behind the task when the response lands.
      const early = await getTask(session.client, created.task.taskId);
      expect(early.status).toBe('working');

      const result = await getResult(session.client, created.task.taskId);
      // Content, structuredContent, and the layout `_meta` of an ordinary call,
      // plus the related-task key tasks/result must carry.
      const ordinary = await session.client.callTool({ arguments: { holdMs: 200 }, name: 'wait' });
      expect(result).toEqual({
        ...ordinary,
        _meta: { ...ordinary._meta, [RELATED_TASK]: { taskId: created.task.taskId } },
      });
      expect(result).toMatchObject({ content: [{ text: 'waited 200ms', type: 'text' }], structuredContent: { waitedMs: 200 } });
      expect(result).not.toHaveProperty('isError');
      const completed = await getTask(session.client, created.task.taskId);
      expect(completed.status).toBe('completed');
    });

    it('surfaces the render\'s progress through tasks/get, from progress.report() and from a streamed Agent.Progress fallback alike', async () => {
      await using session = await openInMemoryMcpServer();
      const notifications: unknown[] = [];
      session.client.setNotificationHandler('notifications/progress', (notification) => {
        notifications.push(notification.params);
      });

      // No progress token: the task still observes every report — the last one
      // stays on the settled task under `_meta['agent-bundle/progress']` — and
      // nothing reaches the wire as notifications/progress. (This level hands
      // the dispatcher the whole Flight payload at once, so the reports it
      // buffered before the shell arrive together with the result; the
      // mid-render `statusMessage` is pinned by tests/mcp-tasks.test.ts.)
      const reported = await createTask(session.client, 'wait', { holdMs: 300, tickMs: 100 });
      await getResult(session.client, reported.task.taskId);
      const settled = await getTask(session.client, reported.task.taskId);
      expect(settled.status).toBe('completed');
      expect(settled).not.toHaveProperty('statusMessage');
      expect(settled._meta?.['agent-bundle/progress']).toEqual({ message: 'waiting', progress: 3, total: 3 });
      expect(notifications).toEqual([]);

      // The catalog route never calls progress.report(); its Suspense fallback
      // is an Agent.Progress node the projector reads (#448), and the task
      // records it exactly as the ordinary call would have notified it — under
      // the client's own token, stamped with the related-task key.
      const streamed = await createTask(session.client, 'catalog', { genre: 'mystery' }, { progressToken: 'tok-369' });
      const result = await getResult(session.client, streamed.task.taskId);
      expect(result).toMatchObject({ structuredContent: { genre: 'mystery', titles: ['Piranesi', 'Solaris'] } });
      expect(notifications).toEqual([{
        _meta: { [RELATED_TASK]: { taskId: streamed.task.taskId } },
        message: 'loading mystery',
        progress: 0,
        progressToken: 'tok-369',
        total: 2,
      }]);
      expect((await getTask(session.client, streamed.task.taskId))._meta?.['agent-bundle/progress']).toEqual({ message: 'loading mystery', progress: 0, total: 2 });
    });

    it('cancels a working task through the render\'s own AbortSignal', async () => {
      await using session = await openInMemoryMcpServer();

      const created = await createTask(session.client, 'wait', { holdMs: 5000 });
      const cancelled = await session.client.request(
        { method: 'tasks/cancel', params: { taskId: created.task.taskId } },
        clientSchemas.CancelTaskResult,
      );
      expect(cancelled).toMatchObject({ status: 'cancelled', taskId: created.task.taskId });
      // The interrupted render settles as the SDK's tool error for the abort,
      // which is exactly what tasks/result then returns.
      const result = await getResult(session.client, created.task.taskId);
      expect(result).toMatchObject({ isError: true });
      expect((await getTask(session.client, created.task.taskId)).status).toBe('cancelled');
      expect((await rpcError(session.client.request(
        { method: 'tasks/cancel', params: { taskId: created.task.taskId } },
        clientSchemas.CancelTaskResult,
      ))).code).toBe(-32_602);
    });

    it('lists the session\'s tasks and refuses a task call to a tool that did not opt in', async () => {
      await using session = await openInMemoryMcpServer();

      expect((await session.client.request({ method: 'tasks/list' }, clientSchemas.ListTasksResult)).tasks).toEqual([]);
      const first = await createTask(session.client, 'wait', { holdMs: 50 });
      const second = await createTask(session.client, 'catalog', {});
      const listed = await session.client.request({ method: 'tasks/list' }, clientSchemas.ListTasksResult);
      expect(listed.tasks.map((task) => task.taskId)).toEqual([first.task.taskId, second.task.taskId]);
      await Promise.all([getResult(session.client, first.task.taskId), getResult(session.client, second.task.taskId)]);

      const refused = await rpcError(createTask(session.client, 'echo', { message: 'not a task' }));
      expect(refused.code).toBe(-32_601);
      expect((await rpcError(getTask(session.client, 'no-such-task'))).code).toBe(-32_602);
    });

    it('leaves a client that never asks for a task on the ordinary contract', async () => {
      await using session = await openInMemoryMcpServer();
      const notifications: unknown[] = [];
      session.client.setNotificationHandler('notifications/progress', (notification) => {
        notifications.push(notification.params);
      });

      const result = await session.client.callTool({ arguments: { holdMs: 50 }, name: 'wait' });
      expect(result).toMatchObject({ content: [{ text: 'waited 50ms', type: 'text' }], structuredContent: { waitedMs: 50 } });
      for (const key of ['task', 'taskId', 'status', 'createdAt', 'ttl', 'pollInterval']) {
        expect(Object.hasOwn(result, key)).toBe(false);
      }
      expect(notifications).toEqual([]);
      expect((await session.client.request({ method: 'tasks/list' }, clientSchemas.ListTasksResult)).tasks).toEqual([]);
    });
  });

  it('emits notifications/resources/updated for the notice inbox only to subscribed matching sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-inbox-updated-'));
    const inboxUri = 'agent-bundle://notices/inbox';
    const sessionIdentity = (sessionId: string) => ({
      source: 'native' as const,
      state: 'available' as const,
      value: { sessionId },
    });
    const durable = (sessionId: string) => openInMemoryMcpServer({
      context: { session: sessionIdentity(sessionId) },
      state: { definition: stateDefinition, driver: createSqliteStateDriver({ root }) },
    });
    const settle = async (): Promise<void> => {
      // The inbox observation is detached from the render that triggered it;
      // a few turns of the event loop let it reserve, send, and record.
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const signalled = async (session: 's1' | 's2', count: number): Promise<void> => {
      for (let i = 0; i < 200 && updates[session].length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The availability receipt commits right after the wire write resolves.
      await settle();
    };
    const readInbox = async (client: (typeof subscribed)['client']) => {
      const read = await client.readResource({ uri: inboxUri });
      const content = read.contents[0];
      if (content === undefined || !('text' in content)) throw new TypeError('Expected text inbox content');
      return (JSON.parse(content.text) as { notices: readonly Readonly<Record<string, unknown>>[] }).notices;
    };
    const subscribed = await durable('s1');
    const bystander = await durable('s2');
    const updates = { s1: [] as string[], s2: [] as string[] };
    subscribed.client.setNotificationHandler('notifications/resources/updated', (notification) => {
      updates.s1.push(notification.params.uri);
    });
    bystander.client.setNotificationHandler('notifications/resources/updated', (notification) => {
      updates.s2.push(notification.params.uri);
    });
    try {
      expect(subscribed.client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
      // Only the inbox is subscribable: static resources never change per session.
      await expect(subscribed.client.subscribeResource({ uri: 'harness://notes' })).rejects.toThrow(/does not support subscriptions/u);
      await subscribed.client.subscribeResource({ uri: inboxUri });

      // s1 publishes to itself: the subscribed session gets exactly one signal.
      await subscribed.client.callTool({ arguments: { message: 'for s1', recipientSession: 's1' }, name: 'publish-notice' });
      await signalled('s1', 1);
      expect(updates).toEqual({ s1: [inboxUri], s2: [] });

      // Availability is a receipt on the pending notice, not a state change;
      // the client's re-read records exposure and triggers no further signal.
      const inbox = await readInbox(subscribed.client);
      expect(inbox).toEqual([expect.objectContaining({
        availability: expect.objectContaining({ channel: 'mcp-resource-updated', count: 1 }),
        exposure: expect.objectContaining({ channel: 'mcp-inbox', count: 1 }),
        state: 'pending',
      })]);
      await subscribed.client.callTool({ arguments: { message: 'unrelated render' }, name: 'echo' });
      await settle();
      expect(updates).toEqual({ s1: [inboxUri], s2: [] });

      // An unsubscribed session is never signalled, even for its own notice;
      // the subscribed session is not signalled for a notice it cannot read.
      await bystander.client.callTool({ arguments: { message: 'for s2', recipientSession: 's2' }, name: 'publish-notice' });
      await subscribed.client.callTool({ arguments: { message: 'observe' }, name: 'echo' });
      await settle();
      expect(updates).toEqual({ s1: [inboxUri], s2: [] });
      const bystanderInbox = await readInbox(bystander.client);
      expect(bystanderInbox).toEqual([expect.objectContaining({ state: 'pending' })]);
      expect(bystanderInbox[0]).not.toHaveProperty('availability');

      // Unsubscribing stops delivery; the notice stays pending for the inbox route.
      await subscribed.client.unsubscribeResource({ uri: inboxUri });
      await subscribed.client.callTool({ arguments: { message: 'for s1 again', recipientSession: 's1' }, name: 'publish-notice' });
      await settle();
      expect(updates).toEqual({ s1: [inboxUri], s2: [] });
      expect(await readInbox(subscribed.client)).toHaveLength(2);
    } finally {
      await subscribed.close();
      await bystander.close();
    }

    // Volatile state lives in the render side's heap, so the server honestly
    // advertises no subscription capability and registers no subscribe handler.
    const volatile = await openInMemoryMcpServer({
      state: {
        definition: defineState({
          events: { changed: z.object({ value: z.string() }).strict() },
          id: 'mcp-in-memory/volatile',
          initial: { value: '' },
          lifetime: 'process',
          reduce: (_state, event) => ({ value: event.payload.value }),
          schema: z.object({ value: z.string() }).strict(),
        }),
        driver: createMemoryStateDriver({ lifetime: 'process' }),
      },
    });
    try {
      expect(volatile.client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
      await expect(volatile.client.subscribeResource({ uri: inboxUri })).rejects.toThrow(/Method not found/u);
    } finally {
      await volatile.close();
      await rm(root, { force: true, recursive: true });
    }
  });

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
