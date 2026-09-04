import { Client, InMemoryTransport, specTypeSchemas as clientSchemas } from '@modelcontextprotocol/client';
import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import {
  DEFAULT_MCP_TASK_POLL_INTERVAL_MS,
  DEFAULT_MCP_TASK_TTL_MS,
  MAX_MCP_TASK_TTL_MS,
  MCP_TASK_PROGRESS_META_KEY,
  MODEL_IMMEDIATE_RESPONSE_META_KEY,
  createTaskAugmentedMcpServer,
} from '../src/mcp-tasks.ts';

/**
 * The task lifecycle over the SDK's own `Server`, exercised by a real client
 * through the in-memory transport pair and hand-registered tools, so every
 * protocol rule is pinned without a compiled route graph. The generated
 * server's integration of the same lifecycle is proven by the `mcp-in-memory`
 * level (projection/mcp-in-memory.test.ts).
 */

const RELATED_TASK = 'io.modelcontextprotocol/related-task';

interface Hold {
  readonly release: (text: string) => void;
  readonly fail: (message: string) => void;
  readonly waited: Promise<string>;
}

const hold = (): Hold => {
  let release: (text: string) => void = () => undefined;
  let fail: (message: string) => void = () => undefined;
  const waited = new Promise<string>((resolve, reject) => {
    release = resolve;
    fail = (message) => reject(new Error(message));
  });
  return { fail, release, waited };
};

interface Harness {
  readonly client: Client;
  readonly holds: Hold[];
  readonly aborted: string[];
  readonly close: () => Promise<void>;
  readonly errors: Error[];
}

const open = async (options: { readonly clientCapabilities?: Record<string, unknown>; readonly declareTasks?: boolean } = {}): Promise<Harness> => {
  const { declareTool, install, server, tasks } = createTaskAugmentedMcpServer({ name: 'tasks-unit', version: '0.0.0' });
  const errors: Error[] = [];
  tasks.onerror = (error) => errors.push(error);
  const holds: Hold[] = [];
  const aborted: string[] = [];
  const optional = server.registerTool('slow', {
    description: 'Blocks until the test releases it.',
    inputSchema: z.object({ label: z.string() }),
    outputSchema: z.object({ label: z.string() }),
  }, async ({ label }, ctx) => {
    const step = hold();
    holds.push(step);
    ctx.mcpReq.signal.addEventListener('abort', () => {
      aborted.push(label);
      step.fail(`aborted ${label}`);
    }, { once: true });
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) {
      await ctx.mcpReq.notify({ method: 'notifications/progress', params: { message: 'half way', progress: 1, progressToken, total: 2 } });
    }
    const text = await step.waited;
    return { content: [{ text, type: 'text' }], structuredContent: { label } };
  });
  const required = server.registerTool('background-only', {
    description: 'Must be called as a task.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ text: 'ran', type: 'text' }] }));
  const plain = server.registerTool('plain', {
    description: 'Never a task.',
    inputSchema: z.object({ fail: z.boolean().optional() }),
  }, async ({ fail }) => (fail === true
    ? { content: [{ text: 'plain failed', type: 'text' }], isError: true }
    : { content: [{ text: 'plain', type: 'text' }] }));
  const failing = server.registerTool('failing', {
    description: 'Reports a tool error.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ text: 'quota exceeded', type: 'text' }], isError: true }));
  if (options.declareTasks !== false) {
    declareTool(optional, 'slow', 'optional');
    declareTool(required, 'background-only', 'required');
    declareTool(failing, 'failing', 'optional');
  }
  declareTool(plain, 'plain', 'forbidden');
  install();
  const client = new Client(
    { name: 'tasks-unit-client', version: '0.0.0' },
    options.clientCapabilities === undefined ? undefined : { capabilities: options.clientCapabilities as never },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    aborted,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
    errors,
    holds,
  };
};

const callAsTask = (client: Client, name: string, args: Record<string, unknown>, task: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
  client.request({
    method: 'tools/call',
    params: { ...(meta === undefined ? {} : { _meta: meta }), arguments: args, name, task },
  }, clientSchemas.CreateTaskResult);

const getTask = (client: Client, taskId: string) =>
  client.request({ method: 'tasks/get', params: { taskId } }, clientSchemas.GetTaskResult);

const getResult = (client: Client, taskId: string) =>
  client.request({ method: 'tasks/result', params: { taskId } }, clientSchemas.CallToolResult);

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const rpcError = async (promise: Promise<unknown>): Promise<{ readonly code: number; readonly message: string }> => {
  try {
    await promise;
  } catch (error) {
    const { code, message } = error as { code: number; message: string };
    return { code, message };
  }
  throw new Error('Expected the request to fail');
};

describe('task-augmented tools/call (#369)', () => {
  it('advertises the tasks capability and each tool\'s execution.taskSupport only when a tool opted in', async () => {
    const harness = await open();
    try {
      expect(harness.client.getServerCapabilities()?.tasks).toEqual({ cancel: {}, list: {}, requests: { tools: { call: {} } } });
      const listed = await harness.client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      expect(byName.get('slow')?.execution).toEqual({ taskSupport: 'optional' });
      expect(byName.get('background-only')?.execution).toEqual({ taskSupport: 'required' });
      expect(byName.get('plain')?.execution).toBeUndefined();
    } finally {
      await harness.close();
    }

    const plainOnly = await open({ declareTasks: false });
    try {
      expect(Object.hasOwn(plainOnly.client.getServerCapabilities() ?? {}, 'tasks')).toBe(false);
      // A receiver that declared no task capability processes the request
      // normally and ignores the task metadata (2025-11-25 Tasks).
      const result = await plainOnly.client.request({
        method: 'tools/call',
        params: { arguments: {}, name: 'plain', task: { ttl: 1000 } },
      }, clientSchemas.CallToolResult);
      expect(result).toEqual({ content: [{ text: 'plain', type: 'text' }] });
      const missing = await rpcError(getTask(plainOnly.client, 'nope'));
      expect(missing.code).toBe(-32_601);
    } finally {
      await plainOnly.close();
    }
  });

  it('returns a CreateTaskResult at once, reports progress through tasks/get, and hands the final CallToolResult to tasks/result', async () => {
    const harness = await open();
    try {
      const created = await callAsTask(harness.client, 'slow', { label: 'one' }, { pollInterval: 250, ttl: 90_000 });
      expect(created.task).toMatchObject({ pollInterval: 250, status: 'working', ttl: 90_000 });
      expect(created.task.taskId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(created.task.createdAt).toBe(created.task.lastUpdatedAt);
      expect(created._meta?.[MODEL_IMMEDIATE_RESPONSE_META_KEY]).toContain(created.task.taskId);
      // The tool is still running: the response did not wait for it.
      await waitFor(() => harness.holds.length === 1, 'the tool to start');

      const working = await getTask(harness.client, created.task.taskId);
      expect(working).toMatchObject({ status: 'working', statusMessage: 'half way', taskId: created.task.taskId });
      expect(working._meta?.[MCP_TASK_PROGRESS_META_KEY]).toEqual({ message: 'half way', progress: 1, total: 2 });

      // tasks/result blocks until the task settles.
      let settled = false;
      const pending = getResult(harness.client, created.task.taskId).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      harness.holds[0]!.release('done one');
      const result = await pending;
      expect(result).toMatchObject({
        content: [{ text: 'done one', type: 'text' }],
        structuredContent: { label: 'one' },
      });
      // The result carries the related-task key the spec requires of tasks/result.
      expect((result._meta as Record<string, unknown> | undefined)?.[RELATED_TASK]).toEqual({ taskId: created.task.taskId });

      const completed = await getTask(harness.client, created.task.taskId);
      expect(completed.status).toBe('completed');
      expect(completed).not.toHaveProperty('statusMessage');
      // The last progress the render reported stays readable on the settled task.
      expect(completed._meta?.[MCP_TASK_PROGRESS_META_KEY]).toEqual({ message: 'half way', progress: 1, total: 2 });
      // A settled task's result can be fetched again while it is retained.
      expect(await getResult(harness.client, created.task.taskId)).toMatchObject({ structuredContent: { label: 'one' } });
    } finally {
      await harness.close();
    }
  });

  it('forwards progress under the client\'s own token with the related-task key, and never invents a token', async () => {
    const harness = await open();
    try {
      const notifications: unknown[] = [];
      harness.client.setNotificationHandler('notifications/progress', (notification) => {
        notifications.push(notification.params);
      });
      const silent = await callAsTask(harness.client, 'slow', { label: 'silent' });
      const loud = await callAsTask(harness.client, 'slow', { label: 'loud' }, {}, { progressToken: 'tok-369' });
      await waitFor(() => harness.holds.length === 2, 'both tools to start');
      await waitFor(() => notifications.length === 1, 'the tokened progress notification');
      expect(notifications).toEqual([{
        _meta: { [RELATED_TASK]: { taskId: loud.task.taskId } },
        message: 'half way',
        progress: 1,
        progressToken: 'tok-369',
        total: 2,
      }]);
      // Both tasks observed their progress regardless of the token.
      expect((await getTask(harness.client, silent.task.taskId)).statusMessage).toBe('half way');
      expect((await getTask(harness.client, loud.task.taskId)).statusMessage).toBe('half way');
      for (const step of harness.holds) step.release('ok');
    } finally {
      await harness.close();
    }
  });

  it('cancels a working task: status flips before the response and the tool\'s signal aborts', async () => {
    const harness = await open();
    try {
      const statuses: string[] = [];
      harness.client.setNotificationHandler('notifications/tasks/status', { params: clientSchemas.Task }, (params) => {
        statuses.push(`${params.taskId}:${params.status}`);
      });
      const created = await callAsTask(harness.client, 'slow', { label: 'cancel-me' });
      await waitFor(() => harness.holds.length === 1, 'the tool to start');
      const cancelled = await harness.client.request(
        { method: 'tasks/cancel', params: { taskId: created.task.taskId } },
        clientSchemas.CancelTaskResult,
      );
      expect(cancelled).toMatchObject({ status: 'cancelled', statusMessage: 'The task was cancelled by request.', taskId: created.task.taskId });
      await waitFor(() => harness.aborted.includes('cancel-me'), 'the render signal to abort');
      // Terminal for good, even once the underlying call settles.
      expect((await getTask(harness.client, created.task.taskId)).status).toBe('cancelled');
      // tasks/result returns exactly what the interrupted call produced: the
      // SDK's tool error for the abort.
      const result = await getResult(harness.client, created.task.taskId);
      expect(result).toMatchObject({ content: [{ text: 'aborted cancel-me', type: 'text' }], isError: true });
      expect(statuses).toEqual([`${created.task.taskId}:cancelled`]);
      // A second cancel is rejected: the task is terminal.
      const again = await rpcError(harness.client.request(
        { method: 'tasks/cancel', params: { taskId: created.task.taskId } },
        clientSchemas.CancelTaskResult,
      ));
      expect(again.code).toBe(-32_602);
      expect(again.message).toContain('terminal');
    } finally {
      await harness.close();
    }
  });

  it('marks a tool error result failed with its diagnostic and still returns it from tasks/result', async () => {
    const harness = await open();
    try {
      const created = await callAsTask(harness.client, 'failing', {});
      await waitFor(() => false, 'nothing').catch(() => undefined);
      const failed = await getTask(harness.client, created.task.taskId);
      expect(failed).toMatchObject({ status: 'failed', statusMessage: 'quota exceeded' });
      expect(await getResult(harness.client, created.task.taskId)).toEqual({
        _meta: { [RELATED_TASK]: { taskId: created.task.taskId } },
        content: [{ text: 'quota exceeded', type: 'text' }],
        isError: true,
      });
    } finally {
      await harness.close();
    }
  }, 10_000);

  it('lists the session\'s tasks oldest first and pages by cursor', async () => {
    const harness = await open();
    try {
      const created = [];
      for (const label of ['a', 'b', 'c']) created.push(await callAsTask(harness.client, 'slow', { label }));
      await waitFor(() => harness.holds.length === 3, 'the tools to start');
      const listed = await harness.client.request({ method: 'tasks/list' }, clientSchemas.ListTasksResult);
      expect(listed.tasks.map((task) => task.taskId)).toEqual(created.map((entry) => entry.task.taskId));
      expect(listed).not.toHaveProperty('nextCursor');
      const bad = await rpcError(harness.client.request({ method: 'tasks/list', params: { cursor: 'not-a-cursor' } }, clientSchemas.ListTasksResult));
      expect(bad.code).toBe(-32_602);
      for (const step of harness.holds) step.release('ok');
    } finally {
      await harness.close();
    }
  });

  it('refuses an ordinary call to a required tool and a task call to a forbidden tool with -32601', async () => {
    const harness = await open();
    try {
      const ordinary = await rpcError(harness.client.callTool({ arguments: {}, name: 'background-only' }));
      expect(ordinary).toMatchObject({ code: -32_601 });
      expect(ordinary.message).toContain('requires task-augmented execution');
      const forbidden = await rpcError(callAsTask(harness.client, 'plain', {}));
      expect(forbidden).toMatchObject({ code: -32_601 });
      expect(forbidden.message).toContain('does not support task-augmented execution');
      // The required tool runs as a task.
      const created = await callAsTask(harness.client, 'background-only', {});
      expect(await getResult(harness.client, created.task.taskId)).toMatchObject({ content: [{ text: 'ran', type: 'text' }] });
    } finally {
      await harness.close();
    }
  });

  it('keeps ordinary calls untouched: no task shape, no progress without a token, tool errors as before', async () => {
    const harness = await open();
    try {
      const notifications: unknown[] = [];
      harness.client.setNotificationHandler('notifications/progress', (notification) => {
        notifications.push(notification.params);
      });
      const pending = harness.client.callTool({ arguments: { label: 'ordinary' }, name: 'slow' });
      await waitFor(() => harness.holds.length === 1, 'the tool to start');
      harness.holds[0]!.release('sync');
      const result = await pending;
      expect(result).toEqual({ content: [{ text: 'sync', type: 'text' }], structuredContent: { label: 'ordinary' } });
      expect(notifications).toEqual([]);
      expect(await harness.client.callTool({ arguments: { fail: true }, name: 'plain' })).toEqual({
        content: [{ text: 'plain failed', type: 'text' }],
        isError: true,
      });
      const listed = await harness.client.request({ method: 'tasks/list' }, clientSchemas.ListTasksResult);
      expect(listed.tasks).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('answers an unknown task with -32602 and clamps the requested ttl and poll interval', async () => {
    const harness = await open();
    try {
      const missing = await rpcError(getTask(harness.client, 'no-such-task'));
      expect(missing).toEqual({ code: -32_602, message: expect.stringContaining('Task not found') });
      expect((await rpcError(getResult(harness.client, 'no-such-task'))).code).toBe(-32_602);
      const defaults = await callAsTask(harness.client, 'slow', { label: 'defaults' });
      expect(defaults.task).toMatchObject({ pollInterval: DEFAULT_MCP_TASK_POLL_INTERVAL_MS, ttl: DEFAULT_MCP_TASK_TTL_MS });
      const clamped = await callAsTask(harness.client, 'slow', { label: 'clamped' }, { pollInterval: 1, ttl: Number.MAX_SAFE_INTEGER });
      expect(clamped.task).toMatchObject({ pollInterval: 100, ttl: MAX_MCP_TASK_TTL_MS });
      await waitFor(() => harness.holds.length === 2, 'the tools to start');
      for (const step of harness.holds) step.release('ok');
    } finally {
      await harness.close();
    }
  });

  it('cancels every working task when the session closes', async () => {
    const harness = await open();
    const created = await callAsTask(harness.client, 'slow', { label: 'orphan' });
    await waitFor(() => harness.holds.length === 1, 'the tool to start');
    await harness.close();
    await waitFor(() => harness.aborted.includes('orphan'), 'the orphaned render to abort');
    expect(created.task.status).toBe('working');
    expect(harness.errors).toEqual([]);
  });
});
