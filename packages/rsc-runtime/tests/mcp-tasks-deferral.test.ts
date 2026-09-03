// Deferral sentinel for issue #369 (task-augmented MCP tool calls, the #96
// acceptance remainder). The installed MCP SDK carries the 2025-11-25 Tasks
// wire vocabulary but no task runtime, and the 2026-07-28 revision moved
// tasks into the `io.modelcontextprotocol/tasks` extension (SEP-2663) with a
// redesigned lifecycle. Rather than hand-roll a protocol fork on a surface the
// SDK labels "interoperability only", the repository defers and pins the exact
// conditions of that deferral here. Every assertion below is a fact about the
// SDK as installed; the day one of them stops holding, this file fails and the
// deferral recorded in docs/mcp-conformance.md must be re-audited.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as clientModule from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import * as serverModule from '@modelcontextprotocol/server';
import { McpServer as ProtocolMcpServer } from '@modelcontextprotocol/server';
import { afterAll, describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import { Mcp, createRscMcpServer, defineOperation, defineRscApplication } from '../src/index.js';

/** The SDK revision this deferral was audited against (2026-09-02). */
const AUDITED_SDK_VERSION = '2.0.0';

/** The task vocabulary the 2025-11-25 revision defines and the SDK leaves unrouted. */
const TASK_METHODS = ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'] as const;

/**
 * The only task-named exports the audited SDK exposes: a `_meta` key and a
 * deprecated wire-shape guard. A `TaskStore`, `registerToolTask`, an
 * `experimental.tasks` namespace, or exported task result schemas would mean
 * the SDK grew a runtime and the deferral is stale.
 */
const AUDITED_TASK_EXPORTS = ['RELATED_TASK_META_KEY', 'isTaskAugmentedRequestParams'];

const installedVersion = async (packageName: string): Promise<string> => {
  const manifestPath = fileURLToPath(new URL(`../node_modules/${packageName}/package.json`, import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { readonly version: string };
  return manifest.version;
};

const taskNamedExports = (module: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(module).filter((name) => /task/iu.test(name)).sort();

const slowOperation = defineOperation({
  execute: async () => ({ ok: true }),
  id: 'slow',
  inputSchema: z.object({}).strict(),
  mcp: {
    description: 'A render the Tasks utility would let a client defer.',
    name: 'slow',
    readOnly: true,
    server: 'demo',
  },
  render: (result) => createElement(
    Mcp.Result,
    { structuredContent: result },
    createElement(Mcp.Text, null, 'done'),
  ),
  resultSchema: z.object({ ok: z.boolean() }).strict(),
});

const application = defineRscApplication({
  name: 'tasks-deferral-demo',
  operations: [slowOperation],
  version: '1.0.0',
});

interface WireMessage {
  readonly error?: { readonly code: number; readonly message: string };
  readonly id?: number | string;
  readonly result?: Record<string, unknown>;
}

const openClients: Client[] = [];

/**
 * Connects a real client that negotiates the 2025-11-25 `tasks` capability
 * and returns a raw-frame injector: the typed client refuses task methods, so
 * the wire shape a task-aware peer would send is delivered straight to the
 * server transport and the serialized response captured.
 */
const connectTaskNegotiatingClient = async (): Promise<{
  readonly client: Client;
  readonly inject: (id: number, method: string, params: Record<string, unknown>) => Promise<WireMessage>;
  readonly server: ProtocolMcpServer;
}> => {
  const server = createRscMcpServer(application, 'demo');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: WireMessage[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    sent.push(JSON.parse(JSON.stringify(message)) as WireMessage);
    return originalSend(message, options);
  };
  const client = new Client(
    { name: 'tasks-deferral-test', version: '0.0.0' },
    { capabilities: { tasks: { requests: { tools: { call: {} } } } } as never },
  );
  openClients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const inject = async (id: number, method: string, params: Record<string, unknown>): Promise<WireMessage> => {
    serverTransport.onmessage?.({ id, jsonrpc: '2.0', method, params });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = sent.find((message) => message.id === id);
      if (response !== undefined) return response;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No response for ${method} (id ${String(id)})`);
  };
  return { client, inject, server };
};

afterAll(async () => {
  await Promise.allSettled(openClients.map((client) => client.close()));
});

describe('MCP Tasks deferral sentinel (#369)', () => {
  it('pins the SDK revision the deferral was audited against', async () => {
    await expect(installedVersion('@modelcontextprotocol/server')).resolves.toBe(AUDITED_SDK_VERSION);
    await expect(installedVersion('@modelcontextprotocol/client')).resolves.toBe(AUDITED_SDK_VERSION);
  });

  it('exposes only task wire vocabulary, not a task runtime', () => {
    expect(taskNamedExports(serverModule)).toEqual(AUDITED_TASK_EXPORTS);
    expect(taskNamedExports(clientModule)).toEqual(AUDITED_TASK_EXPORTS);
    const server = new ProtocolMcpServer({ name: 'probe', version: '0.0.0' });
    expect('experimental' in server).toBe(false);
    expect('experimental' in server.server).toBe(false);
  });

  it('keeps task methods off the typed request surface', async () => {
    const { client } = await connectTaskNegotiatingClient();
    for (const method of TASK_METHODS) {
      // The audited client rejects synchronously; a later SDK might reject the
      // returned promise instead, so both shapes are funnelled through one promise.
      await expect(Promise.resolve().then(() => client.request({ method, params: { taskId: 'never-created' } } as never)))
        .rejects.toThrow(/not a spec method/u);
    }
    // The compile-time half of this sentinel (a `@ts-expect-error` on the
    // typed `setRequestHandler('tasks/get', …)` overload) lives in
    // packages/agent-bundle/tests/projection/mcp-in-memory.test.ts, which
    // `pnpm typecheck` covers; this package's tests are not type-checked.
  });

  it('never advertises tasks, even to a client that negotiated them', async () => {
    const { client, server } = await connectTaskNegotiatingClient();
    expect(server.server.getClientCapabilities()).toMatchObject({ tasks: { requests: { tools: { call: {} } } } });
    expect(client.getServerCapabilities()).toBeDefined();
    expect(Object.hasOwn(client.getServerCapabilities() ?? {}, 'tasks')).toBe(false);
  });

  it('processes a task-augmented tools/call as an ordinary request', async () => {
    // 2025-11-25 Tasks: a receiver that does not declare the capability MUST
    // process the request normally, ignoring task-augmentation metadata.
    const { inject } = await connectTaskNegotiatingClient();
    const response = await inject(101, 'tools/call', { arguments: {}, name: 'slow', task: { ttl: 60_000 } });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      content: [{ text: 'done', type: 'text' }],
      structuredContent: { ok: true },
    });
    for (const key of ['task', 'taskId', 'status', 'createdAt', 'ttl', 'pollInterval']) {
      expect(Object.hasOwn(response.result ?? {}, key)).toBe(false);
    }
  });

  it('answers every task operation with JSON-RPC method-not-found', async () => {
    const { inject } = await connectTaskNegotiatingClient();
    for (const [index, method] of TASK_METHODS.entries()) {
      const response = await inject(200 + index, method, { taskId: 'never-created' });
      expect(response.result).toBeUndefined();
      expect(response.error?.code).toBe(-32_601);
    }
  });
});
