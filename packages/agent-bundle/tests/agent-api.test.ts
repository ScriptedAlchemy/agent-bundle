import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from '@rstest/core';

import { stableJson } from '../src/core/digest.ts';
import { AgentApi, agentApiToolNames, type AgentApiOptions } from '../src/dev/agent-api.ts';
import { ForegroundServerCloseError, ProjectEventHub, startForegroundServer } from '../src/dev/index.ts';
import type { ProjectStatus } from '../src/dev/types.ts';

const projectStatus = (): ProjectStatus => ({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
});

const createApi = (overrides: Partial<AgentApiOptions> = {}): AgentApi => new AgentApi({
    artifacts: { inspect: async (epochId) => ({ epochId }) },
    coordinator: {
      status: () => projectStatus(),
    },
    diagnostics: { list: async () => ({ diagnostics: [] }) },
    epochs: {
      acquireActiveEpochReference: async () => ({
        close: async () => undefined,
        epoch: { id: 'epoch-a' },
        root: '/test/epoch-a',
      }),
      acquireEpochReference: async (epochId) => ({
        close: async () => undefined,
        epoch: { id: epochId },
        root: `/test/${epochId}`,
      }),
      listEpochs: async () => [{ id: 'epoch-a' }],
    },
    evals: {
      list: async () => [],
      read: async (runId) => ({ run: { id: runId } }),
      run: async () => ({ run: { id: 'run-a' } }),
      suites: async () => ({ diagnostics: [], suites: [] }),
    },
    hooks: {
      list: async () => [],
      simulate: async () => ({ diagnostics: [] }),
    },
    mcpSessions: {
      open: async () => ({
        callTool: async () => ({ content: [{ text: 'ok', type: 'text' }] }),
        close: async () => undefined,
        initialize: async () => ({ capabilities: {}, server: { name: 'fixture', version: '1.0.0' } }),
      }),
    },
    skills: {
      generated: async (epochId, target, skillId) => ({ epochId, id: skillId, target }),
      generatedTree: async (epochId, target) => ({ epochId, skills: [], target }),
    },
  ...overrides,
  token: overrides.token ?? 'test-agent-api-token',
});

const startApi = async (options: Readonly<{ readonly api?: AgentApi; readonly port?: number }> = {}): Promise<Readonly<{
  api: AgentApi;
  close: () => Promise<void>;
  url: string;
}>> => {
  const api = options.api ?? createApi();
  const server = createServer((request, response) => {
    void api.handle(request, response);
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: options.port ?? 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    api,
    close: async () => {
      await api.close();
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    url: `http://127.0.0.1:${address.port}`,
  });
};

const deferred = <Value>(): Readonly<{
  promise: Promise<Value>;
  reject: (error: unknown) => void;
  resolve: (value: Value) => void;
}> => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

it('uses the official stateless MCP handler to expose the fixed ordered tool set', async () => {
  const started = await startApi();
  const client = new Client({ name: 'agent-api-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const status = await client.callTool({ name: 'project_status' });
    const invoked = await client.callTool({
      arguments: { server: 'fixture', target: 'portable', tool: 'inspect' },
      name: 'mcp_invoke',
    });

    expect(listed.tools.map((tool) => tool.name)).toEqual(agentApiToolNames);
    expect(listed.tools.map((tool) => tool.inputSchema.additionalProperties)).toEqual(
      agentApiToolNames.map(() => false),
    );
    expect(status.structuredContent).toEqual({ status: projectStatus() });
    expect(status.content).toEqual([{
      text: '{"status":{"artifact":{"state":"missing"},"build":{"state":"idle"},"source":{"diagnostics":[],"state":"unknown"}}}',
      type: 'text',
    }]);
    expect(invoked.structuredContent).toEqual({ result: { content: [{ text: 'ok', type: 'text' }] } });
  } finally {
    await client.close();
    await started.close();
  }
});

it('delegates every fixed tool through the official MCP transport with stable structured and text results', async () => {
  const calls: unknown[] = [];
  const api = createApi({
    artifacts: {
      inspect: async (epochId) => {
        calls.push(['artifacts.inspect', epochId]);
        return {
          epochId,
          runtime: {
            mcpServers: [
              { name: 'portable-server', target: 'portable' },
              { name: 'other-server', target: 'other' },
            ],
          },
        };
      },
    },
    diagnostics: {
      list: async () => {
        calls.push(['diagnostics.list']);
        return { diagnostics: [{ code: 'AB1000', message: 'Known diagnostic', severity: 'warning' }] };
      },
    },
    evals: {
      list: async () => { calls.push(['evals.list']); return [{ id: 'run-a' }]; },
      read: async (runId) => { calls.push(['evals.read', runId]); return { id: runId }; },
      run: async (request) => { calls.push(['evals.run', request]); return { id: 'run-b' }; },
      suites: async () => { calls.push(['evals.suites']); return { diagnostics: [], suites: [{ name: 'suite-a' }] }; },
    },
    hooks: {
      list: async (options) => { calls.push(['hooks.list', options]); return [{ id: 'hook-a' }]; },
      simulate: async (options) => { calls.push(['hooks.simulate', options]); return { id: 'simulation-a' }; },
    },
    mcpSessions: {
      open: async (options) => {
        calls.push(['mcp.open', options]);
        return {
          callTool: async (request) => { calls.push(['mcp.callTool', request]); return { value: 'mcp-result' }; },
          close: async () => { calls.push(['mcp.close']); },
          initialize: async () => { calls.push(['mcp.initialize']); return { server: { name: 'fixture', version: '1.0.0' } }; },
        };
      },
    },
    skills: {
      generated: async (epochId, target, skillId) => {
        calls.push(['skills.generated', epochId, target, skillId]);
        return { epochId, id: skillId, target };
      },
      generatedTree: async (epochId, target) => {
        calls.push(['skills.generatedTree', epochId, target]);
        return { epochId, skills: [], target };
      },
    },
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-delegation-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const results = await Promise.all([
      client.callTool({ name: 'project_status' }),
      client.callTool({ arguments: { target: 'portable' }, name: 'skills_list' }),
      client.callTool({ arguments: { skill_id: 'skill-a', target: 'portable' }, name: 'skill_inspect' }),
      client.callTool({ name: 'artifacts_list' }),
      client.callTool({ name: 'artifact_inspect' }),
      client.callTool({ arguments: { target: 'portable' }, name: 'mcp_servers_list' }),
      client.callTool({
        arguments: { arguments: { input: 'value' }, server: 'server-a', target: 'portable', tool: 'tool-a' },
        name: 'mcp_invoke',
      }),
      client.callTool({ arguments: { target: 'portable' }, name: 'hooks_list' }),
      client.callTool({
        arguments: { hook: 'hook-a', input: { fixture: 'value' }, target: 'portable' },
        name: 'hook_simulate',
      }),
      client.callTool({ name: 'evals_list' }),
      client.callTool({
        arguments: { case_ids: ['case-a'], suites: ['suite-a'], trials: 2 },
        name: 'eval_run',
      }),
      client.callTool({ arguments: { run_id: 'run-a' }, name: 'eval_get' }),
      client.callTool({ name: 'diagnostics_list' }),
    ]);

    expect(results).toHaveLength(agentApiToolNames.length);
    for (const result of results) {
      expect(result.content).toEqual([{
        text: stableJson(result.structuredContent as never),
        type: 'text',
      }]);
    }
    expect(results.map((result) => result.structuredContent)).toEqual([
      { status: projectStatus() },
      { skills: { epochId: 'epoch-a', skills: [], target: 'portable' } },
      { skill: { epochId: 'epoch-a', id: 'skill-a', target: 'portable' } },
      { epochs: [{ id: 'epoch-a' }] },
      { artifact: { epochId: 'epoch-a', runtime: { mcpServers: [{ name: 'portable-server', target: 'portable' }, { name: 'other-server', target: 'other' }] } } },
      { servers: [{ name: 'portable-server', target: 'portable' }] },
      { result: { value: 'mcp-result' } },
      { hooks: [{ id: 'hook-a' }] },
      { simulation: { id: 'simulation-a' } },
      { runs: [{ id: 'run-a' }], suites: { diagnostics: [], suites: [{ name: 'suite-a' }] } },
      { run: { id: 'run-b' } },
      { run: { id: 'run-a' } },
      { diagnostics: { diagnostics: [{ code: 'AB1000', message: 'Known diagnostic', severity: 'warning' }] } },
    ]);
    expect(calls).toEqual(expect.arrayContaining([
      ['skills.generatedTree', 'epoch-a', 'portable'],
      ['skills.generated', 'epoch-a', 'portable', 'skill-a'],
      ['artifacts.inspect', 'epoch-a'],
      ['mcp.open', { epochId: 'epoch-a', serverName: 'server-a', target: 'portable' }],
      ['mcp.initialize'],
      ['mcp.callTool', expect.objectContaining({ arguments: { input: 'value' }, name: 'tool-a' })],
      ['mcp.close'],
      ['hooks.list', { epochId: 'epoch-a', target: 'portable' }],
      ['hooks.simulate', expect.objectContaining({
        epochId: 'epoch-a',
        hook: 'hook-a',
        input: { inline: { fixture: 'value' } },
        target: 'portable',
      })],
      ['evals.list'],
      ['evals.suites'],
      ['evals.run', expect.objectContaining({
        artifact: '/test/epoch-a',
        caseIds: ['case-a'],
        suites: ['suite-a'],
        trials: 2,
      })],
      ['evals.read', 'run-a'],
      ['diagnostics.list'],
    ]));
  } finally {
    await client.close();
    await started.close();
  }
});

it('rejects unknown and forbidden tool fields with the SDK-owned strict schemas', async () => {
  const started = await startApi();
  const client = new Client({ name: 'agent-api-schema-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    await expect(client.callTool({ arguments: { root: '/forbidden' }, name: 'artifact_inspect' })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ arguments: { harness: 'browser', trials: 1 }, name: 'eval_run' })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({
      arguments: { cwd: '/forbidden', server: 'server-a', target: 'portable', tool: 'tool-a' },
      name: 'mcp_invoke',
    })).resolves.toMatchObject({ isError: true });
  } finally {
    await client.close();
    await started.close();
  }
});

it('pins in-flight artifact calls to their acquired epoch while later omitted calls use the new epoch', async () => {
  let active = 'epoch-a';
  let firstEpochA = true;
  const inspectionStarted = deferred<void>();
  const inspection = deferred<unknown>();
  const leases = new Map<string, number>();
  const acquire = async (epochId: string) => {
    leases.set(epochId, (leases.get(epochId) ?? 0) + 1);
    return {
      close: async () => { leases.set(epochId, (leases.get(epochId) ?? 1) - 1); },
      epoch: { id: epochId },
      root: `/fixture/${epochId}`,
    };
  };
  const started = await startApi({
    api: createApi({
      artifacts: {
        inspect: async (epochId) => {
          if (epochId === 'epoch-a' && firstEpochA) {
            firstEpochA = false;
            inspectionStarted.resolve();
            return inspection.promise;
          }
          return { epochId };
        },
      },
      epochs: {
        acquireActiveEpochReference: async () => acquire(active),
        acquireEpochReference: acquire,
        listEpochs: async () => [{ id: active }],
      },
    }),
  });
  const client = new Client({ name: 'agent-api-epoch-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const inFlight = client.callTool({ name: 'artifact_inspect' });
    await inspectionStarted.promise;
    expect(leases.get('epoch-a')).toBe(1);

    active = 'epoch-b';
    const omittedB = await client.callTool({ name: 'artifact_inspect' });
    const explicitA = await client.callTool({ arguments: { epoch: 'epoch-a' }, name: 'artifact_inspect' });
    expect(omittedB.structuredContent).toEqual({ artifact: { epochId: 'epoch-b' } });
    expect(explicitA.structuredContent).toEqual({ artifact: { epochId: 'epoch-a' } });
    expect(leases.get('epoch-a')).toBe(1);

    inspection.resolve({ epochId: 'epoch-a' });
    await expect(inFlight).resolves.toMatchObject({ structuredContent: { artifact: { epochId: 'epoch-a' } } });
    expect(leases.get('epoch-a')).toBe(0);
    expect(leases.get('epoch-b')).toBe(0);
  } finally {
    await client.close();
    await started.close();
  }
});

it('closes admissions and drains active Agent API operations before shared shutdown can continue', async () => {
  const inspectionStarted = deferred<void>();
  const inspection = deferred<unknown>();
  const api = createApi({
    artifacts: {
      inspect: async () => {
        inspectionStarted.resolve();
        return inspection.promise;
      },
    },
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-close-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const inFlight = client.callTool({ name: 'artifact_inspect' });
    await inspectionStarted.promise;
    let closed = false;
    const closing = api.close().then(() => { closed = true; });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(closed).toBe(false);
    inspection.resolve({ epochId: 'epoch-a' });
    await closing;
    await expect(inFlight).resolves.toMatchObject({ structuredContent: { artifact: { epochId: 'epoch-a' } } });
    expect((await fetch(`${started.url}/mcp`, { method: 'POST' })).status).toBe(503);
  } finally {
    await client.close();
    await started.close();
  }
});

it('keeps an initialized official stateless transport usable after the fixed URL restarts', async () => {
  const initial = await startApi();
  const port = Number(new URL(initial.url).port);
  const client = new Client({ name: 'agent-api-restart-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${initial.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  let restarted: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools[0]).toMatchObject({ name: 'project_status' });
    await initial.close();
    restarted = await startApi({ port });
    expect((await client.listTools()).tools[0]).toMatchObject({ name: 'project_status' });
  } finally {
    await client.close();
    await restarted?.close();
  }
});

it('rejects a missing or changed bearer token without disclosing it', async () => {
  const started = await startApi();
  try {
    const missing = await fetch(`${started.url}/mcp`, { method: 'POST' });
    const changed = await fetch(`${started.url}/mcp`, {
      headers: { authorization: 'Bearer changed-token' },
      method: 'POST',
    });

    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect(changed.status).toBe(401);
    await expect(changed.text()).resolves.not.toContain('changed-token');
  } finally {
    await started.close();
  }
});

it('mounts the optional API only at /mcp and applies the foreground origin guard before bearer auth', async () => {
  const coordinator = {
    close: async () => undefined,
    rebuild: async () => ({ outcome: 'failed' as const }),
    start: async () => undefined,
    status: () => projectStatus(),
  };
  const disabled = await startForegroundServer({ coordinator, eventHub: new ProjectEventHub(), port: 0 });
  const enabled = await startForegroundServer({
    agentApi: createApi(),
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
  });
  const client = new Client({ name: 'agent-api-foreground-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${enabled.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    expect((await fetch(`${disabled.url}/mcp`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${enabled.url}/mcp`, {
      headers: { origin: 'http://127.0.0.1:1' },
      method: 'POST',
    })).status).toBe(403);

    await client.connect(transport);
    expect((await client.listTools()).tools[0]).toMatchObject({ name: 'project_status' });
  } finally {
    await client.close();
    await Promise.all([disabled.close(), enabled.close()]);
  }
});

it('aggregates an Agent API shutdown failure after closing its admissions before the coordinator', async () => {
  const agentApiFailure = new Error('Agent API cleanup failed.');
  const closeOrder: string[] = [];
  const coordinator = {
    close: async () => { closeOrder.push('coordinator'); },
    rebuild: async () => ({ outcome: 'failed' as const }),
    start: async () => undefined,
    status: () => projectStatus(),
  };
  const agentApi = {
    close: async () => { closeOrder.push('agent-api'); throw agentApiFailure; },
    handle: async () => undefined,
  } as unknown as AgentApi;
  const foreground = await startForegroundServer({ agentApi, coordinator, eventHub: new ProjectEventHub(), port: 0 });
  await expect(foreground.close()).rejects.toEqual(expect.objectContaining({
    failures: [{ error: agentApiFailure, resource: 'agent-api' }],
    name: ForegroundServerCloseError.name,
  }));
  expect(closeOrder).toEqual(['agent-api', 'coordinator']);
});
