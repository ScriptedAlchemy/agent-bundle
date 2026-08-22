import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpHttpHandler, McpServerFactory } from '@modelcontextprotocol/server';
import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { stableJson } from '../src/core/digest.ts';
import {
  AgentApi,
  AgentApiCloseError,
  agentApiTokenEquals,
  agentApiToolNames,
  type AgentApiEpochReference,
  type AgentApiOptions,
} from '../src/dev/agent-api.ts';
import { EvalService } from '../src/dev/eval/eval-service.ts';
import { ForegroundServerCloseError, ProjectEventHub, startForegroundServer } from '../src/dev/index.ts';
import type { ProjectStatus } from '../src/dev/types.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { seedEvalProject } from './support/eval-project.ts';

const projectStatus = (): ProjectStatus => ({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
});

type TestAgentApiOptions = Partial<AgentApiOptions> & Readonly<{
  readonly handlerFactory?: (factory: McpServerFactory) => McpHttpHandler;
}>;

const createApi = (overrides: TestAgentApiOptions = {}): AgentApi => new AgentApi({
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
      start: async () => ({ run: { id: 'run-a' } }),
      subscribeEvents: async () => ({
        activate: () => undefined,
        close: () => undefined,
        replay: { cursor: { afterSequence: 0 }, events: [] },
      }),
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
} as AgentApiOptions);

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
      const apiClose = await Promise.allSettled([api.close()]);
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
      const failure = apiClose[0];
      if (failure?.status === 'rejected') throw failure.reason;
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

const within = async <Value>(promise: Promise<Value>, timeoutMs = 1_000): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectPromise) => {
        timeout = setTimeout(() => rejectPromise(new Error('Timed out waiting for the requested operation.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
      read: async (runId: string) => { calls.push(['evals.read', runId]); return { id: runId }; },
      start: async (request: Parameters<AgentApiOptions['evals']['start']>[0]) => { calls.push(['evals.start', request]); return { run: { id: 'run-b' } }; },
      subscribeEvents: async (runId: string, afterSequence: number) => {
        calls.push(['evals.subscribeEvents', runId, afterSequence]);
        return {
          activate: () => undefined,
          close: () => undefined,
          replay: {
            cursor: { afterSequence: 1 },
            events: [{ kind: 'run.completed', payload: {}, sequence: 1, timestamp: '2026-08-18T00:00:00.000Z' }],
          },
        };
      },
      suites: async () => { calls.push(['evals.suites']); return { diagnostics: [], suites: [{ name: 'suite-a' }] }; },
    } as unknown as AgentApiOptions['evals'],
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
      { run: { id: 'run-b', status: 'admitted' } },
      { run: { id: 'run-a' } },
      { diagnostics: [{ code: 'AB1000', message: 'Known diagnostic', severity: 'warning' }] },
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
      ['evals.start', expect.objectContaining({
        artifact: '/test/epoch-a',
        caseIds: ['case-a'],
        harness: 'deterministic',
        suites: ['suite-a'],
        trials: 2,
      })],
      ['evals.subscribeEvents', 'run-b', 0],
      ['evals.read', 'run-a'],
      ['diagnostics.list'],
    ]));
  } finally {
    await client.close();
    await started.close();
  }
});

it('admits deterministic evals against an atomically leased epoch until their terminal event', async () => {
  const released = deferred<void>();
  const requests: unknown[] = [];
  let closeCalls = 0;
  let notify!: (event: Readonly<{ readonly kind: string }>) => void;
  const api = createApi({
    epochs: {
      acquireActiveEpochReference: async () => ({
        close: async () => {
          closeCalls += 1;
          released.resolve();
        },
        epoch: { id: 'epoch-pinned' },
        root: '/test/epoch-pinned',
      }),
      acquireEpochReference: async () => { throw new Error('The active epoch should be used when epoch is omitted.'); },
      listEpochs: async () => [{ id: 'epoch-pinned' }],
    },
    evals: {
      list: async () => [],
      read: async (runId: string) => ({ run: { id: runId } }),
      // The former synchronous path must not execute for an admitted Agent API run.
      run: async () => { throw new Error('eval_run must use asynchronous admission.'); },
      start: async (request: unknown) => {
        requests.push(request);
        return { run: { id: 'run-admitted' } };
      },
      subscribeEvents: async () => ({
        activate: (listener: (event: Readonly<{ readonly kind: string }>) => void) => { notify = listener; },
        close: () => undefined,
        replay: { events: [] },
      }),
      suites: async () => ({ diagnostics: [], suites: [] }),
    } as unknown as AgentApiOptions['evals'],
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-eval-admission-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      arguments: { case_ids: ['case-a'], suites: ['suite-a'], trials: 2 },
      name: 'eval_run',
    });

    expect(result.structuredContent).toEqual({ run: { id: 'run-admitted', status: 'admitted' } });
    expect(requests).toEqual([expect.objectContaining({
      artifact: '/test/epoch-pinned',
      caseIds: ['case-a'],
      harness: 'deterministic',
      signal: expect.any(AbortSignal),
      suites: ['suite-a'],
      trials: 2,
    })]);
    expect(closeCalls).toBe(0);

    notify({ kind: 'run.completed' });
    await within(released.promise);
    expect(closeCalls).toBe(1);
  } finally {
    await client.close();
    await started.close();
  }
});

it('retains an eval admission refusal when the leased epoch also fails to release', async () => {
  const admissionFailure = Object.assign(new Error('No selected eval case matched.'), { code: 'EVAL_SELECTION_EMPTY' });
  const releaseFailure = new Error('Epoch release failed.');
  let referenceCloses = 0;
  const api = createApi({
    epochs: {
      acquireActiveEpochReference: async () => ({
        close: async () => {
          referenceCloses += 1;
          throw releaseFailure;
        },
        epoch: { id: 'epoch-release-failure' },
        root: '/test/epoch-release-failure',
      }),
      acquireEpochReference: async () => { throw new Error('Only the active epoch should be acquired.'); },
      listEpochs: async () => [{ id: 'epoch-release-failure' }],
    },
    evals: {
      list: async () => [],
      read: async (runId: string) => ({ run: { id: runId } }),
      start: async () => { throw admissionFailure; },
      subscribeEvents: async () => { throw new Error('Subscription must not open after a refused admission.'); },
      suites: async () => ({ diagnostics: [], suites: [] }),
    } as unknown as AgentApiOptions['evals'],
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-eval-release-failure-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    await expect(client.callTool({ name: 'eval_run' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'EVAL_SELECTION_EMPTY' } },
    });
    expect(referenceCloses).toBe(1);
  } finally {
    await client.close();
    await started.close();
  }
});

it('releases both terminal eval resources before preserving a cleanup failure for shutdown', async () => {
  const cleanupFailure = new Error('Subscription release failed.');
  const released = deferred<void>();
  let epochCloses = 0;
  let subscriptionCloses = 0;
  let notify!: (event: Readonly<{ readonly kind: string }>) => void;
  const api = createApi({
    epochs: {
      acquireActiveEpochReference: async () => ({
        close: async () => {
          epochCloses += 1;
          released.resolve();
        },
        epoch: { id: 'epoch-terminal-cleanup' },
        root: '/test/epoch-terminal-cleanup',
      }),
      acquireEpochReference: async () => { throw new Error('Only the active epoch should be acquired.'); },
      listEpochs: async () => [{ id: 'epoch-terminal-cleanup' }],
    },
    evals: {
      list: async () => [],
      read: async (runId: string) => ({ run: { id: runId } }),
      start: async () => ({ run: { id: 'run-terminal-cleanup' } }),
      subscribeEvents: async () => ({
        activate: (listener: (event: Readonly<{ readonly kind: string }>) => void) => { notify = listener; },
        close: () => {
          subscriptionCloses += 1;
          throw cleanupFailure;
        },
        replay: { events: [] },
      }),
      suites: async () => ({ diagnostics: [], suites: [] }),
    } as unknown as AgentApiOptions['evals'],
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-eval-terminal-cleanup-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: 'eval_run' });
    notify({ kind: 'run.completed' });
    await within(released.promise);
    expect(subscriptionCloses).toBe(1);
    expect(epochCloses).toBe(1);
    await expect(api.close()).rejects.toEqual(expect.objectContaining({
      failures: [{ error: expect.objectContaining({ errors: [cleanupFailure] }), resource: 'eval' }],
      name: AgentApiCloseError.name,
    }));
  } finally {
    await client.close().catch(() => undefined);
    await started.close().catch(() => undefined);
  }
});

it('admits a deterministic eval against a real leased artifact epoch', async () => {
  const project = await createProjectFixture();
  const artifact = join(project.root, '.agent-bundle', 'epochs', 'epoch-real');
  const evals = new EvalService({ projectRoot: project.root, targets: ['portable'] });
  let referenceCloses = 0;
  let serviceFailure: unknown;
  let started: Awaited<ReturnType<typeof startApi>> | undefined;
  const client = new Client({ name: 'agent-api-real-eval-client', version: '1.0.0' });
  try {
    await seedEvalProject(project.root);
    await build({ output: artifact, root: project.root });
    const api = createApi({
      epochs: {
        acquireActiveEpochReference: async () => ({
          close: async () => { referenceCloses += 1; },
          epoch: { id: 'epoch-real' },
          root: artifact,
        }),
        acquireEpochReference: async () => { throw new Error('Only the active epoch should be acquired.'); },
        listEpochs: async () => [{ id: 'epoch-real' }],
      },
      evals: {
        list: () => evals.list(),
        read: (runId) => evals.read(runId),
        start: async (request) => {
          try {
            return await evals.start(request);
          } catch (error) {
            serviceFailure = error;
            throw error;
          }
        },
        subscribeEvents: (runId, afterSequence) => evals.subscribeEvents(runId, afterSequence),
        suites: () => evals.suites(),
      },
    });
    started = await startApi({ api });
    const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
      authProvider: { token: async () => 'test-agent-api-token' },
    });

    await client.connect(transport);
    const admitted = await client.callTool({
      arguments: { case_ids: ['reads-result'], suites: ['review-change'], trials: 1 },
      name: 'eval_run',
    });

    expect(serviceFailure).toBeUndefined();
    expect(admitted.isError).not.toBe(true);
    expect(admitted).toMatchObject({
      structuredContent: { run: { id: expect.any(String), status: 'admitted' } },
    });
    expect(admitted.structuredContent).toEqual({
      run: { id: expect.any(String), status: 'admitted' },
    });
    expect(stableJson(admitted.structuredContent as never)).not.toContain('.agent-bundle/epochs');
    await evals.close();
    await within(new Promise<void>((resolvePromise) => {
      const interval = setInterval(() => {
        if (referenceCloses !== 1) return;
        clearInterval(interval);
        resolvePromise();
      }, 10);
    }));
  } finally {
    await client.close().catch(() => undefined);
    await started?.close().catch(() => undefined);
    await evals.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 30_000);

it('does not cancel an admitted real eval when its MCP request aborts', async () => {
  const project = await createProjectFixture();
  const artifact = join(project.root, '.agent-bundle', 'epochs', 'epoch-request-abort');
  const evals = new EvalService({ projectRoot: project.root, targets: ['portable'] });
  const admitted = deferred<string>();
  const allowSubscription = deferred<void>();
  let referenceCloses = 0;
  let started: Awaited<ReturnType<typeof startApi>> | undefined;
  const client = new Client({ name: 'agent-api-real-eval-request-abort-client', version: '1.0.0' });
  try {
    await seedEvalProject(project.root);
    await build({ output: artifact, root: project.root });
    const api = createApi({
      epochs: {
        acquireActiveEpochReference: async () => ({
          close: async () => { referenceCloses += 1; },
          epoch: { id: 'epoch-request-abort' },
          root: artifact,
        }),
        acquireEpochReference: async () => { throw new Error('Only the active epoch should be acquired.'); },
        listEpochs: async () => [{ id: 'epoch-request-abort' }],
      },
      evals: {
        list: () => evals.list(),
        read: (runId) => evals.read(runId),
        start: async (request) => {
          const admission = await evals.start(request);
          admitted.resolve(admission.run.id);
          return admission;
        },
        subscribeEvents: async (runId, afterSequence) => {
          await allowSubscription.promise;
          return evals.subscribeEvents(runId, afterSequence);
        },
        suites: () => evals.suites(),
      },
    });
    started = await startApi({ api });
    const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
      authProvider: { token: async () => 'test-agent-api-token' },
    });
    const request = new AbortController();

    await client.connect(transport);
    const pending = client.callTool({
      arguments: { case_ids: ['reads-result'], suites: ['review-change'], trials: 1 },
      name: 'eval_run',
    }, { signal: request.signal });
    void pending.catch(() => undefined);
    const runId = await within(admitted.promise);
    request.abort();
    allowSubscription.resolve();
    await within(pending.catch(() => undefined));

    let completed = await evals.read(runId);
    for (let attempt = 0; completed.run.completedAt === undefined && attempt < 100; attempt += 1) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      completed = await evals.read(runId);
    }
    expect(completed.run.completedAt).toEqual(expect.any(String));
    expect(completed.run.summary).toMatchObject({ cases: 1, pass: 1, trials: 1 });
    expect(completed.trials).toEqual([expect.objectContaining({ caseId: 'reads-result', outcome: 'pass' })]);
    await within(new Promise<void>((resolvePromise) => {
      const interval = setInterval(() => {
        if (referenceCloses !== 1) return;
        clearInterval(interval);
        resolvePromise();
      }, 10);
    }));
  } finally {
    allowSubscription.resolve();
    await client.close().catch(() => undefined);
    await started?.close().catch(() => undefined);
    await evals.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 30_000);

it('releases a late-acquired epoch without admitting an eval after Agent API shutdown', async () => {
  const acquisitionStarted = deferred<void>();
  const acquired = deferred<AgentApiEpochReference>();
  let closeCalls = 0;
  let starts = 0;
  const api = createApi({
    epochs: {
      acquireActiveEpochReference: async () => {
        acquisitionStarted.resolve();
        return acquired.promise;
      },
      acquireEpochReference: async () => { throw new Error('Only the active epoch should be acquired.'); },
      listEpochs: async () => [{ id: 'epoch-racing-close' }],
    },
    evals: {
      list: async () => [],
      read: async (runId: string) => ({ run: { id: runId } }),
      start: async (request: Parameters<AgentApiOptions['evals']['start']>[0]) => {
        starts += 1;
        request.signal?.throwIfAborted();
        return { run: { id: 'run-racing-close' } };
      },
      subscribeEvents: async () => { throw new Error('An aborted admission must not subscribe.'); },
      suites: async () => ({ diagnostics: [], suites: [] }),
    } as unknown as AgentApiOptions['evals'],
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-close-race-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const pending = client.callTool({ name: 'eval_run' });
    void pending.catch(() => undefined);
    await acquisitionStarted.promise;
    const closing = api.close();
    acquired.resolve({
      close: async () => { closeCalls += 1; },
      epoch: { id: 'epoch-racing-close' },
      root: '/test/epoch-racing-close',
    });
    await closing;
    expect(starts).toBe(0);
    expect(closeCalls).toBe(1);
    await within(pending.catch(() => undefined));
  } finally {
    await client.close().catch(() => undefined);
    await started.close().catch(() => undefined);
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
    // The client may first dispatch onto the pooled keep-alive socket the closed server
    // already finished; one retry gets a fresh connection and proves the initialized
    // client keeps working without reconnecting or re-initializing the transport.
    const tools = await client.listTools().catch(() => client.listTools());
    expect(tools.tools[0]).toMatchObject({ name: 'project_status' });
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

it('compares every bearer token shape through a fixed-width verification path', () => {
  const expected = 'test-agent-api-token';
  const cases = [
    ['', false],
    ['short', false],
    ['test-agent-api-wrong', false],
    ['a token that is much longer than the configured token', false],
    [expected, true],
  ] as const;

  for (const [candidate, accepted] of cases) {
    expect(agentApiTokenEquals(expected, candidate)).toBe(accepted);
  }
});

it('redacts hostile thrown values without reading arbitrary error fields', async () => {
  const secretPath = '/private/agent-api-secret/manifest.json';
  const hostile = new Proxy({}, {
    get: () => { throw new Error(secretPath); },
    getOwnPropertyDescriptor: () => { throw new Error(secretPath); },
  });
  const started = await startApi({
    api: createApi({ artifacts: { inspect: async () => { throw hostile; } } }),
  });
  const client = new Client({ name: 'agent-api-hostile-error-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'artifact_inspect' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'AGENT_API_OPERATION_FAILED', message: 'The requested operation could not be completed.' } },
    });
    expect(stableJson(result.structuredContent as never)).not.toContain(secretPath);
  } finally {
    await client.close();
    await started.close();
  }
});

it('projects project and epoch summaries without recursively exposing filesystem paths', async () => {
  const secretPath = '/private/agent-api-secret/manifest.json';
  const unsafeStatus = {
    artifact: {
      activeEpoch: { id: 'epoch-a', manifestPath: secretPath, root: '/private/agent-api-secret', sourcePath: secretPath },
      state: 'active',
    },
    build: { details: { nested: { manifestPath: secretPath, sourcePath: secretPath } }, state: 'idle' },
    source: { diagnostics: [], root: '/private/agent-api-secret', state: 'unknown' },
  } as unknown as ProjectStatus;
  const started = await startApi({
    api: createApi({
      coordinator: { status: () => unsafeStatus },
      epochs: {
        acquireActiveEpochReference: async () => ({ close: async () => undefined, epoch: { id: 'epoch-a' }, root: '/private/agent-api-secret' }),
        acquireEpochReference: async (epochId) => ({ close: async () => undefined, epoch: { id: epochId }, root: '/private/agent-api-secret' }),
        listEpochs: async () => [{ id: 'epoch-a', manifestPath: secretPath, nested: { root: '/private/agent-api-secret', sourcePath: secretPath } }],
      },
    }),
  });
  const client = new Client({ name: 'agent-api-safe-projection-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const [status, artifacts] = await Promise.all([
      client.callTool({ name: 'project_status' }),
      client.callTool({ name: 'artifacts_list' }),
    ]);
    for (const result of [status, artifacts]) {
      const wire = stableJson(result.structuredContent as never);
      expect(wire).not.toContain(secretPath);
      expect(wire).not.toContain('/private/agent-api-secret');
      expect(wire).not.toContain('manifestPath');
      expect(wire).not.toContain('sourcePath');
    }
  } finally {
    await client.close();
    await started.close();
  }
});

it('projects status, epoch, and diagnostic DTOs without leaking embedded paths or secret fields', async () => {
  const sensitive = [
    '/private/agent-api-secret/manifest.json',
    'C:\\private\\agent-api-secret\\manifest.json',
    '\\\\server\\share\\agent-api-secret\\manifest.json',
    'file:///private/agent-api-secret/manifest.json',
    'diagnostic-secret',
    'epoch-secret',
  ];
  const unsafeDiagnostic = (message: string) => ({
    code: 'AB9000',
    generatedPath: '/private/agent-api-secret/generated.ts',
    message,
    recovery: 'Repair file:///private/agent-api-secret/config.ts; secret: diagnostic-secret',
    secret: 'diagnostic-secret',
    severity: 'error',
    sourcePath: '/private/agent-api-secret/source.ts',
    target: 'portable',
  });
  const unsafeStatus = {
    artifact: {
      activeEpoch: {
        configDigest: '/private/agent-api-secret/config-digest',
        createdAt: '2026-08-18T00:00:00.000Z',
        diagnostics: { errors: 0, infos: 0, warnings: 0 },
        id: 'epoch-a',
        manifestPath: '/private/agent-api-secret/manifest.json',
        modelDigest: 'C:\\private\\agent-api-secret\\model-digest',
        projectRevision: 'file:///private/agent-api-secret/revision',
        secret: 'epoch-secret',
        targetDigests: { portable: '\\\\server\\share\\agent-api-secret\\target-digest' },
      },
      currentSourceRevision: 'file:///private/agent-api-secret/current-revision',
      state: 'active',
    },
    build: {
      lastAttempt: {
        completedAt: '2026-08-18T00:01:00.000Z',
        diagnostics: [unsafeDiagnostic('Could not read /private/agent-api-secret/build.ts; secret: diagnostic-secret')],
        id: 'attempt-a',
        outcome: 'failed',
        sourceRevision: 'C:\\private\\agent-api-secret\\source-revision',
        startedAt: '2026-08-18T00:00:00.000Z',
      },
      state: 'failed',
    },
    source: {
      diagnostics: [unsafeDiagnostic('Could not read \\\\server\\share\\agent-api-secret\\source.ts or file:///private/agent-api-secret/source.ts; secret: diagnostic-secret')],
      revision: 'file:///private/agent-api-secret/source-revision',
      state: 'invalid',
    },
  } as unknown as ProjectStatus;
  const started = await startApi({
    api: createApi({
      coordinator: { status: () => unsafeStatus },
      diagnostics: {
        list: async () => ({
          diagnostics: [unsafeDiagnostic('Could not read C:\\private\\agent-api-secret\\diagnostic.ts; secret: diagnostic-secret')],
          secret: 'diagnostic-secret',
        }),
      },
      epochs: {
        acquireActiveEpochReference: async () => ({ close: async () => undefined, epoch: { id: 'epoch-a' }, root: '/private/agent-api-secret' }),
        acquireEpochReference: async (epochId) => ({ close: async () => undefined, epoch: { id: epochId }, root: '/private/agent-api-secret' }),
        listEpochs: async () => [{
          configDigest: '/private/agent-api-secret/config-digest',
          createdAt: '2026-08-18T00:00:00.000Z',
          diagnostics: { errors: 0, infos: 0, warnings: 0 },
          id: 'epoch-a',
          modelDigest: 'C:\\private\\agent-api-secret\\model-digest',
          projectRevision: 'file:///private/agent-api-secret/revision',
          secret: 'epoch-secret',
          targetDigests: { portable: '\\\\server\\share\\agent-api-secret\\target-digest' },
        }],
      },
    }),
  });
  const client = new Client({ name: 'agent-api-wire-dto-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const results = await Promise.all([
      client.callTool({ name: 'project_status' }),
      client.callTool({ name: 'artifacts_list' }),
      client.callTool({ name: 'diagnostics_list' }),
    ]);
    expect(results[0].structuredContent).toMatchObject({ status: { artifact: { activeEpoch: { id: 'epoch-a' }, state: 'active' } } });
    expect(results[1].structuredContent).toEqual({ epochs: [{ createdAt: '2026-08-18T00:00:00.000Z', diagnostics: { errors: 0, infos: 0, warnings: 0 }, id: 'epoch-a' }] });
    expect(results[2].structuredContent).toMatchObject({
      diagnostics: [{ code: 'AB9000', recovery: expect.any(String), severity: 'error', target: 'portable' }],
    });
    for (const result of results) {
      const wire = stableJson(result.structuredContent as never);
      for (const value of sensitive) expect(wire).not.toContain(value);
      expect(wire).not.toContain('manifestPath');
      expect(wire).not.toContain('generatedPath');
      expect(wire).not.toContain('sourcePath');
      expect(wire).not.toContain('"secret"');
    }
  } finally {
    await client.close();
    await started.close();
  }
});

it('falls back to path-free DTOs when projection receives a hostile proxy', async () => {
  const secret = '/private/agent-api-secret/proxy.txt';
  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor: () => { throw new Error(secret); },
    ownKeys: () => { throw new Error(secret); },
  });
  const started = await startApi({
    api: createApi({
      coordinator: { status: () => hostile as ProjectStatus },
      diagnostics: { list: async () => hostile },
      epochs: {
        acquireActiveEpochReference: async () => ({ close: async () => undefined, epoch: { id: 'epoch-a' }, root: '/private/agent-api-secret' }),
        acquireEpochReference: async (epochId) => ({ close: async () => undefined, epoch: { id: epochId }, root: '/private/agent-api-secret' }),
        listEpochs: async () => hostile as unknown as readonly { readonly id: string }[],
      },
    }),
  });
  const client = new Client({ name: 'agent-api-hostile-wire-dto-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const results = await Promise.all([
      client.callTool({ name: 'project_status' }),
      client.callTool({ name: 'artifacts_list' }),
      client.callTool({ name: 'diagnostics_list' }),
    ]);
    for (const result of results) {
      expect(result.isError).not.toBe(true);
      expect(stableJson(result.structuredContent as never)).not.toContain(secret);
    }
  } finally {
    await client.close();
    await started.close();
  }
});

it('fails closed for diagnostic messages with paths, control characters, or secret assignments', async () => {
  const generic = 'Diagnostic details are available in the local workbench.';
  const cases = [
    ['quoted-posix', 'Failed at "/private folder/posix tail.txt"; POSIX_TAIL', generic],
    ['quoted-drive', 'Failed at "C:\\private folder\\drive tail.txt"; DRIVE_TAIL', generic],
    ['quoted-unc', 'Failed at "\\\\server\\share name\\unc tail.txt"; UNC_TAIL', generic],
    ['quoted-file-url', 'Failed at "file:///private folder/file tail.txt"; FILE_TAIL', generic],
    ['bare-slashes', 'Failed at //private host/path with spaces; BARE_TAIL', generic],
    ['control', 'Failed at invalid\u0000control text; CONTROL_TAIL', generic],
    ['secret-assignment', 'Failed with secret = diagnostic-secret; SECRET_TAIL', generic],
    ['normal', 'The target configuration is not valid.', 'The target configuration is not valid.'],
  ] as const;
  const diagnostics = cases.map(([, message]) => ({ code: 'AB9000', message, severity: 'error' as const, target: 'portable' }));
  const expectedMessages = cases.map(([, , message]) => message);
  const tails = ['POSIX_TAIL', 'DRIVE_TAIL', 'UNC_TAIL', 'FILE_TAIL', 'BARE_TAIL', 'CONTROL_TAIL', 'SECRET_TAIL', 'diagnostic-secret'];
  const started = await startApi({
    api: createApi({
      coordinator: {
        status: () => ({
          artifact: { state: 'missing' },
          build: { state: 'idle' },
          source: { diagnostics, state: 'invalid' },
        }),
      },
      diagnostics: { list: async () => ({ diagnostics }) },
    }),
  });
  const client = new Client({ name: 'agent-api-diagnostic-message-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    const [status, listed] = await Promise.all([
      client.callTool({ name: 'project_status' }),
      client.callTool({ name: 'diagnostics_list' }),
    ]);
    expect((status.structuredContent as { status: { source: { diagnostics: readonly { message: string }[] } } }).status.source.diagnostics.map(({ message }) => message)).toEqual(expectedMessages);
    expect((listed.structuredContent as { diagnostics: readonly { message: string }[] }).diagnostics.map(({ message }) => message)).toEqual(expectedMessages);
    for (const result of [status, listed]) {
      const wire = stableJson(result.structuredContent as never);
      for (const tail of tails) expect(wire).not.toContain(tail);
    }
  } finally {
    await client.close();
    await started.close();
  }
});

it('propagates API shutdown to an admitted eval lifecycle', async () => {
  const startedRun = deferred<void>();
  const aborted = deferred<void>();
  let notify!: (event: Readonly<{ readonly kind: string }>) => void;
  const api = createApi({
    evals: {
      list: async () => [],
      read: async (runId: string) => ({ id: runId }),
      start: async (request: Parameters<AgentApiOptions['evals']['start']>[0]) => {
        startedRun.resolve();
        request.signal?.addEventListener('abort', () => {
          aborted.resolve();
          notify({ kind: 'run.cancelled' });
        }, { once: true });
        return { run: { id: 'run-aborted' } };
      },
      subscribeEvents: async () => ({
        activate: (listener: (event: Readonly<{ readonly kind: string }>) => void) => { notify = listener; },
        close: () => undefined,
        replay: { events: [] },
      }),
      suites: async () => ({ diagnostics: [], suites: [] }),
    } as unknown as AgentApiOptions['evals'],
  });
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-disconnect-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: 'eval_run' });
    await startedRun.promise;
    const closing = api.close();
    await within(aborted.promise);
    await closing;
  } finally {
    await client.close().catch(() => undefined);
    await started.close();
  }
});

it('publishes one reentrant close promise before aborted operations observe shutdown', async () => {
  const startedRun = deferred<void>();
  const holder: { api?: AgentApi } = {};
  let nestedClose: Promise<void> | undefined;
  let notify!: (event: Readonly<{ readonly kind: string }>) => void;
  const api = createApi({
    evals: {
      list: async () => [],
      read: async (runId: string) => ({ id: runId }),
      start: async (request: Parameters<AgentApiOptions['evals']['start']>[0]) => {
        startedRun.resolve();
        request.signal?.addEventListener('abort', () => {
          if (holder.api === undefined) throw new Error('Agent API is not ready.');
          nestedClose = holder.api.close();
          notify({ kind: 'run.cancelled' });
        }, { once: true });
        return { run: { id: 'run-closed' } };
      },
      subscribeEvents: async () => ({
        activate: (listener: (event: Readonly<{ readonly kind: string }>) => void) => { notify = listener; },
        close: () => undefined,
        replay: { events: [] },
      }),
      suites: async () => ({ diagnostics: [], suites: [] }),
    } as unknown as AgentApiOptions['evals'],
  });
  holder.api = api;
  const started = await startApi({ api });
  const client = new Client({ name: 'agent-api-reentrant-close-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    authProvider: { token: async () => 'test-agent-api-token' },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: 'eval_run' });
    await startedRun.promise;
    const closing = api.close();
    await closing;
    expect(nestedClose).toBe(closing);
  } finally {
    await client.close();
    await started.close();
  }
});

it('closes its official handler once and preserves the handler cleanup failure', async () => {
  const failure = new Error('Handler cleanup failed.');
  let closeCalls = 0;
  const api = createApi({
    handlerFactory: () => ({
      close: async () => { closeCalls += 1; throw failure; },
      fetch: async () => new Response(null, { status: 503 }),
    } as unknown as McpHttpHandler),
  });

  const first = api.close();
  const second = api.close();
  expect(second).toBe(first);
  await expect(first).rejects.toEqual(expect.objectContaining({
    failures: [{ error: failure, resource: 'handler' }],
    name: AgentApiCloseError.name,
  }));
  expect(closeCalls).toBe(1);
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
  let agentApiCloseCalls = 0;
  const coordinator = {
    close: async () => { closeOrder.push('coordinator'); },
    rebuild: async () => ({ outcome: 'failed' as const }),
    start: async () => undefined,
    status: () => projectStatus(),
  };
  const agentApi = {
    close: async () => { agentApiCloseCalls += 1; closeOrder.push('agent-api'); throw agentApiFailure; },
    handle: async () => undefined,
  } as unknown as AgentApi;
  const foreground = await startForegroundServer({ agentApi, coordinator, eventHub: new ProjectEventHub(), port: 0 });
  await expect(foreground.close()).rejects.toEqual(expect.objectContaining({
    failures: [{ error: agentApiFailure, resource: 'agent-api' }],
    name: ForegroundServerCloseError.name,
  }));
  expect(agentApiCloseCalls).toBe(1);
  expect(closeOrder).toEqual(['agent-api', 'coordinator']);
});
