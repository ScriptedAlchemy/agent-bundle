import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

import type { TraceEntry, TraceEntryInput } from '../src/dev/trace/trace-entry.ts';
import type { TracePublisher } from '../src/dev/trace/trace-hub.ts';
import type { RouteInvocation } from '../src/dev/routes/route-invocation-result.ts';
import {
  InvocationRingBuffer,
  RouteInvocationService,
  RouteInvocationRequestError,
  invocationSummary,
  parseRouteInvocationRequest,
} from '../src/dev/routes/route-invocation-service.ts';
import type { RouteManifest } from '../src/dev/routes/route-manifest.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';
import { testManifestFromRouteGraph } from '../src/test/manifest.ts';
import { isProcessGone } from './support/bin-process.ts';

const invocation = (id: string, completedAt: string): RouteInvocation => ({
  completedAt,
  context: {
    actor: { reason: 'not-provided', state: 'unavailable' },
    host: { reason: 'host-omitted', state: 'unavailable' },
    invocation: { kind: 'workbench', operationId: 'tool:fixture/echo', surface: 'echo' },
    lineage: { reason: 'no-shared-runtime', state: 'unavailable' },
    session: { reason: 'not-provided', state: 'unavailable' },
    workspace: { source: 'derived', state: 'available', value: { root: '/project' } },
  },
  diagnostics: [],
  document: {
    root: { children: [{ kind: 'text', text: id }], kind: 'result' },
    status: 'success',
    version: 1,
  },
  events: [],
  id,
  input: {},
  kind: 'tool',
  manifestDigest: 'digest',
  projection: {},
  providers: [],
  routeId: 'tool:fixture/echo',
  source: 'src/mcp/fixture/tools/echo.tsx',
  sourceRevision: 'revision',
  startedAt: completedAt,
  status: 'succeeded',
  timings: [],
});

const collectingTrace = (): Readonly<{
  readonly entries: TraceEntryInput[];
  readonly publisher: TracePublisher;
}> => {
  const entries: TraceEntryInput[] = [];
  return {
    entries,
    publisher: {
      publish: (input): TraceEntry => {
        entries.push(input);
        return {
          ...input,
          id: `trace-${String(entries.length)}`,
          occurredAt: input.occurredAt ?? '2026-09-05T00:00:00.000Z',
          sequence: entries.length,
        };
      },
    },
  };
};

it('strictly validates invocation request fields and event options', () => {
  expect(parseRouteInvocationRequest({
    correlationId: 'browser-1',
    input: { query: 'Dune' },
    requestId: 'request-1',
    routeId: 'tool:curator/search_audible',
  })).toEqual({
    correlationId: 'browser-1',
    input: { query: 'Dune' },
    requestId: 'request-1',
    routeId: 'tool:curator/search_audible',
  });
  expect(parseRouteInvocationRequest({
    event: { fixtureId: 'starter', host: 'claude' },
    routeId: 'event:tool/after',
  })).toEqual({
    event: { fixtureId: 'starter', host: 'claude' },
    routeId: 'event:tool/after',
  });

  for (const value of [
    {},
    { routeId: '' },
    { routeId: 'tool:x/y', unknown: true },
    { args: ['ok', 1], routeId: 'cli:x' },
    { requestId: '', routeId: 'tool:x/y' },
    { event: { host: 'other' }, routeId: 'event:tool/after' },
    { event: { fixtureId: '' }, routeId: 'event:tool/after' },
  ]) {
    expect(() => parseRouteInvocationRequest(value)).toThrow(RouteInvocationRequestError);
  }
});

it('projects summaries without retaining heavy invocation payloads', () => {
  const summary = invocationSummary(invocation('inv_one', '2026-09-05T00:00:00.000Z'));

  expect(summary).toMatchObject({
    id: 'inv_one',
    routeId: 'tool:fixture/echo',
    status: 'succeeded',
  });
  expect(summary).not.toHaveProperty('context');
  expect(summary).not.toHaveProperty('document');
  expect(summary).not.toHaveProperty('events');
  expect(summary).not.toHaveProperty('projection');
  expect(summary).not.toHaveProperty('providers');
  expect(summary).not.toHaveProperty('result');
});

it('retains a bounded newest-first invocation history', () => {
  const history = new InvocationRingBuffer(2);
  history.push(invocation('inv_one', '2026-09-05T00:00:01.000Z'));
  history.push(invocation('inv_two', '2026-09-05T00:00:02.000Z'));
  history.push(invocation('inv_three', '2026-09-05T00:00:03.000Z'));

  expect(history.list()).toEqual([
    expect.objectContaining({ id: 'inv_three' }),
    expect.objectContaining({ id: 'inv_two' }),
  ]);
  expect(history.list(1)).toEqual([expect.objectContaining({ id: 'inv_three' })]);
  expect(history.read('inv_one')).toBeUndefined();
  expect(history.read('inv_two')?.id).toBe('inv_two');
});

it('publishes correlated invocation and kernel entries with slim details', async () => {
  const route = {
    config: [],
    id: 'tool:fixture/echo',
    kind: 'tool',
    provenance: { kind: 'conventional' },
    serverId: 'mcp:fixture',
    source: 'src/mcp/fixture/tools/echo.tsx',
  } as const;
  const trace = collectingTrace();
  let currentTime = Date.parse('2026-09-05T00:00:00.000Z');
  const service = new RouteInvocationService({
    manifest: {
      manifest: () => ({
        diagnostics: [],
        digest: 'digest',
        events: [],
        providers: [{ id: 'provider:clock', name: 'clock', source: 'src/providers/clock.ts' }],
        scripts: [],
        servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [route] }],
        sourceRevision: 'revision',
      }),
    },
    now: () => new Date(currentTime += 5),
    prepared: () => ({
      artifact: { epochId: 'epoch-1', target: 'claude' },
      manifest: { projectRoot: '/project' } as never,
      targets: ['claude'],
    }),
    renderChild: async (_request, _signal, publishKernelEvent) => {
      publishKernelEvent({
        at: 8,
        count: 1,
        durationMs: 3,
        execution: {
          event: 'tool/before',
          executionId: 'execution-1',
          host: 'claude',
          nativeEvent: 'PreToolUse',
        },
        kind: 'providers.finish',
        phase: 'providers',
        sequence: 0,
      });
      const document = {
        root: { kind: 'text' as const, text: 'Echo' },
        status: 'success' as const,
        version: 1 as const,
      };
      return {
        document,
        events: [{ document, sequence: 1, type: 'complete' }],
        input: { value: 'echo' },
        mcp: { content: [] },
        renderDurationMs: 4,
      };
    },
    trace: trace.publisher,
  });

  const result = await service.invoke({
    correlationId: 'correlation-1',
    input: { value: 'echo' },
    requestId: 'request-1',
    routeId: route.id,
  });

  expect(result.requestId).toBe('request-1');
  expect(result.timings.find((entry) => entry.phase === 'providers')?.durationMs).toBe(3);
  expect(trace.entries).toEqual([
    expect.objectContaining({
      correlation: {
        correlationId: 'correlation-1',
        epochId: 'epoch-1',
        invocationId: result.id,
        requestId: 'request-1',
        routeId: route.id,
      },
      details: { status: 'running' },
      href: `/routes/mcp/fixture/tool/echo?invocation=${result.id}`,
      kind: 'invocation.started',
      source: 'invocation',
      status: 'running',
      summary: 'MCP tool fixture/echo · running',
    }),
    expect.objectContaining({
      correlation: {
        correlationId: 'correlation-1',
        epochId: 'epoch-1',
        executionId: 'execution-1',
        host: 'claude',
        invocationId: result.id,
        requestId: 'request-1',
        routeId: route.id,
      },
      details: {
        count: 1,
        event: 'tool/before',
        nativeEvent: 'PreToolUse',
        phase: 'providers',
        sequence: 0,
      },
      durationMs: 3,
      kind: 'kernel.providers.finish',
      source: 'kernel',
      status: 'ok',
      summary: 'event tool/before (claude) · providers finished',
    }),
    expect.objectContaining({
      correlation: {
        correlationId: 'correlation-1',
        epochId: 'epoch-1',
        invocationId: result.id,
        requestId: 'request-1',
        routeId: route.id,
      },
      details: {
        diagnosticCodes: [],
        projectionKind: 'mcp',
        providers: [{ durationMs: 0, name: 'clock' }],
        status: 'succeeded',
      },
      durationMs: 10,
      href: `/routes/mcp/fixture/tool/echo?invocation=${result.id}`,
      kind: 'invocation.completed',
      source: 'invocation',
      status: 'ok',
      summary: 'MCP tool fixture/echo · 10.0 ms',
    }),
  ]);
});

it('publishes failed event invocations with native provenance', async () => {
  const route = {
    config: [],
    event: 'tool/after',
    id: 'event:tool/after',
    kind: 'event-route',
    provenance: { kind: 'conventional' },
    source: 'src/events/tool/after.tsx',
  } as const;
  const trace = collectingTrace();
  let currentTime = Date.parse('2026-09-05T00:00:00.000Z');
  const service = new RouteInvocationService({
    manifest: {
      manifest: () => ({
        diagnostics: [],
        digest: 'digest',
        events: [route],
        providers: [],
        scripts: [],
        servers: [],
        sourceRevision: 'revision',
      }),
    },
    now: () => new Date(currentTime += 5),
    prepared: () => ({
      artifact: { epochId: 'epoch-1', target: 'claude' },
      manifest: { projectRoot: '/project' } as never,
      targets: ['claude'],
    }),
    renderChild: async () => {
      throw new Error('render exploded');
    },
    trace: trace.publisher,
  });

  const result = await service.invoke({
    event: { host: 'claude' },
    input: {
      cwd: '/workspace',
      hook_event_name: 'PostToolUse',
      session_id: 'session-1',
      tool_input: {},
      tool_name: 'Write',
      tool_response: { ok: true },
      tool_use_id: 'use-1',
      transcript_path: '/workspace/transcript.json',
    },
    requestId: 'request-2',
    routeId: route.id,
  });

  expect(result.context.session).toEqual({
    source: 'receipt',
    state: 'available',
    value: { sessionId: 'session-1' },
  });
  expect(result.context.lineage).toMatchObject({
    source: 'receipt',
    state: 'available',
    value: { conversation: 'session-1', root: 'session-1' },
  });
  expect(trace.entries).toHaveLength(2);
  expect(trace.entries[1]).toMatchObject({
    correlation: {
      conversationId: 'session-1',
      epochId: 'epoch-1',
      host: 'claude',
      invocationId: result.id,
      requestId: 'request-2',
      routeId: route.id,
      sessionId: 'session-1',
    },
    details: {
      diagnosticCodes: ['AB8236'],
      projectionKind: 'none',
      providers: [],
      status: 'failed',
    },
    durationMs: 5,
    href: `/routes/events/tool/after?invocation=${result.id}`,
    kind: 'invocation.failed',
    source: 'invocation',
    status: 'error',
    summary: 'event tool/after (claude) · failed',
  });
});

it('aborts and drains a running render when the service closes', async () => {
  const route = {
    config: [],
    id: 'tool:fixture/echo',
    kind: 'tool',
    provenance: { kind: 'conventional' },
    serverId: 'mcp:fixture',
    source: 'src/mcp/fixture/tools/echo.tsx',
  } as const;
  const service = new RouteInvocationService({
    manifest: {
      manifest: () => ({
        diagnostics: [],
        digest: 'digest',
        events: [],
        providers: [],
        scripts: [],
        servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [route] }],
        sourceRevision: 'revision',
      }),
    },
    prepared: () => ({
      manifest: { projectRoot: '/project' } as never,
      targets: ['claude'],
    }),
    renderChild: (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  const pending = service.invoke({ input: {}, routeId: route.id });
  await Promise.resolve();
  await service.close();

  await expect(pending).resolves.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB8236' })],
    status: 'failed',
  });
});

interface LeakingRouteProject {
  readonly pids: () => Promise<Readonly<{ child: number; descendant: number }> | undefined>;
  readonly root: string;
  readonly service: (options?: Readonly<{ timeoutMs?: number }>) => RouteInvocationService;
}

/** A tool route that holds an interval and a forked descendant, and writes both pids. */
const leakingRouteProject = async (behaviour: 'hang' | 'reply'): Promise<LeakingRouteProject> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-child-'));
  const relativePath = 'src/mcp/fixture/tools/leak.tsx';
  const source = join(root, relativePath);
  const pidsPath = join(root, 'pids.json');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "import { Agent } from '@agent-bundle/runtime';",
    "import { createElement } from 'react';",
    '',
    'export default async function Leak() {',
    '  setInterval(() => {}, 60_000);',
    "  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
    `  writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ child: process.pid, descendant: descendant.pid }));`,
    ...(behaviour === 'hang' ? ['  await new Promise(() => {});'] : []),
    "  return createElement(Agent.Result, null, createElement(Agent.Text, null, 'leaked'));",
    '}',
    '',
  ].join('\n'));
  const compiled = {
    config: {},
    id: 'tool:fixture/leak',
    kind: 'tool',
    provenance: { kind: 'conventional', relativePath },
    serverId: 'mcp:fixture',
    source,
  } as const;
  const graph = {
    diagnostics: [],
    digest: 'digest',
    events: [],
    providers: [],
    scripts: [],
    servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [compiled] }],
  } satisfies CompiledRouteGraph;
  const manifest: RouteManifest = {
    diagnostics: [],
    digest: 'digest',
    events: [],
    providers: [],
    scripts: [],
    servers: [{
      id: 'mcp:fixture',
      mode: 'generated',
      name: 'fixture',
      routes: [{
        config: [],
        id: compiled.id,
        kind: compiled.kind,
        provenance: { kind: 'conventional' },
        serverId: compiled.serverId,
        source: relativePath,
      }],
    }],
    sourceRevision: 'revision',
  };
  const prepared = Object.freeze({
    manifest: testManifestFromRouteGraph({ graph, projectRoot: root }),
    targets: ['claude' as const],
  });
  return {
    pids: async () => {
      if (!existsSync(pidsPath)) return undefined;
      return JSON.parse(await readFile(pidsPath, 'utf8')) as Readonly<{ child: number; descendant: number }>;
    },
    root,
    service: (options = {}) => new RouteInvocationService({
      manifest: { manifest: () => manifest },
      prepared: () => prepared,
      timeoutMs: options.timeoutMs,
    }),
  };
};

/** A zombie has exited; only a process still scheduled counts as alive. */
const alive = (pid: number): boolean => {
  if (isProcessGone(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    return !/\) Z /u.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
};

const recordedPids = async (project: LeakingRouteProject): Promise<Readonly<{ child: number; descendant: number }>> => {
  await expect.poll(() => project.pids(), { interval: 50, timeout: 20_000 }).toBeDefined();
  const pids = await project.pids();
  if (pids === undefined) throw new Error('The leaking route did not record process ids.');
  return pids;
};

it('reaps the render child and its descendants after a successful reply', { timeout: 30_000 }, async () => {
  const project = await leakingRouteProject('reply');
  try {
    const invocation = await project.service().invoke({ input: {}, routeId: 'tool:fixture/leak' });
    const pids = await project.pids();

    expect(invocation.status).toBe('succeeded');
    if (pids === undefined) throw new Error('The leaking route did not record process ids.');
    expect(alive(pids.child)).toBe(false);
    expect(alive(pids.descendant)).toBe(false);
  } finally {
    await rm(project.root, { force: true, recursive: true });
  }
});

it('reaps the render child and its descendants when the invocation times out', { timeout: 30_000 }, async () => {
  const project = await leakingRouteProject('hang');
  try {
    const service = project.service({ timeoutMs: 8_000 });
    const pending = service.invoke({ input: {}, routeId: 'tool:fixture/leak' });
    const pids = await recordedPids(project);
    expect(alive(pids.child)).toBe(true);
    expect(alive(pids.descendant)).toBe(true);

    await expect(pending).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB8236', message: 'Route invocation child timed out.' })],
      status: 'failed',
    });
    expect(alive(pids.child)).toBe(false);
    expect(alive(pids.descendant)).toBe(false);
  } finally {
    await rm(project.root, { force: true, recursive: true });
  }
});

it('reaps the render child and its descendants when the service closes mid-render', { timeout: 30_000 }, async () => {
  const project = await leakingRouteProject('hang');
  try {
    const service = project.service();
    const pending = service.invoke({ input: {}, routeId: 'tool:fixture/leak' });
    const pids = await recordedPids(project);
    expect(alive(pids.child)).toBe(true);
    expect(alive(pids.descendant)).toBe(true);

    await service.close();
    expect(alive(pids.child)).toBe(false);
    expect(alive(pids.descendant)).toBe(false);
    await expect(pending).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ message: 'Route invocation child stopped because the service closed.' })],
      status: 'failed',
    });
  } finally {
    await rm(project.root, { force: true, recursive: true });
  }
});

it('forwards kernel events from tool and event routes rendered in the real child', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-trace-'));
  const toolSource = join(root, 'src/mcp/fixture/tools/traced.tsx');
  const eventSource = join(root, 'src/events/tool/before.tsx');
  const traceModule = fileURLToPath(new URL('../src/events/trace.ts', import.meta.url));
  await Promise.all([
    mkdir(dirname(toolSource), { recursive: true }),
    mkdir(dirname(eventSource), { recursive: true }),
  ]);
  const routeSource = (executionId: string, event: string, nativeEvent: string): string => [
    "import { Agent } from '@agent-bundle/runtime';",
    "import { createElement } from 'react';",
    `import { createEventTracer, eventTraceExecution } from ${JSON.stringify(traceModule)};`,
    '',
    'export default async function Traced() {',
    `  const trace = createEventTracer({ execution: eventTraceExecution({ event: ${JSON.stringify(event)}, executionId: ${JSON.stringify(executionId)}, host: 'claude', nativeEvent: ${JSON.stringify(nativeEvent)} }) });`,
    '  trace.renderStart();',
    '  trace.renderFinish();',
    "  return createElement(Agent.Result, null, createElement(Agent.Text, null, 'traced'));",
    '}',
    '',
  ].join('\n');
  await Promise.all([
    writeFile(toolSource, routeSource('execution-tool', 'tool/before', 'PreToolUse')),
    writeFile(eventSource, routeSource('execution-event', 'tool/before', 'PreToolUse')),
  ]);
  const toolRoute = {
    config: {},
    id: 'tool:fixture/traced',
    kind: 'tool',
    provenance: { kind: 'conventional', relativePath: 'src/mcp/fixture/tools/traced.tsx' },
    serverId: 'mcp:fixture',
    source: toolSource,
  } as const;
  const eventRoute = {
    config: { runtime: 'standalone' },
    event: 'tool/before',
    id: 'event:tool/before',
    kind: 'event-route',
    provenance: { kind: 'conventional', relativePath: 'src/events/tool/before.tsx' },
    source: eventSource,
  } as const;
  const graph = {
    diagnostics: [],
    digest: 'digest',
    events: [eventRoute],
    providers: [],
    scripts: [],
    servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [toolRoute] }],
  } satisfies CompiledRouteGraph;
  const manifest: RouteManifest = {
    diagnostics: [],
    digest: 'digest',
    events: [{
      config: [],
      event: eventRoute.event,
      id: eventRoute.id,
      kind: eventRoute.kind,
      provenance: { kind: 'conventional' },
      source: eventRoute.provenance.relativePath,
    }],
    providers: [],
    scripts: [],
    servers: [{
      id: 'mcp:fixture',
      mode: 'generated',
      name: 'fixture',
      routes: [{
        config: [],
        id: toolRoute.id,
        kind: toolRoute.kind,
        provenance: { kind: 'conventional' },
        serverId: toolRoute.serverId,
        source: toolRoute.provenance.relativePath,
      }],
    }],
    sourceRevision: 'revision',
  };
  const trace = collectingTrace();
  const service = new RouteInvocationService({
    manifest: { manifest: () => manifest },
    prepared: () => ({
      manifest: testManifestFromRouteGraph({ graph, projectRoot: root }),
      targets: ['claude'],
    }),
    trace: trace.publisher,
  });
  try {
    const tool = await service.invoke({ routeId: toolRoute.id });
    const event = await service.invoke({ input: {}, routeId: eventRoute.id });
    const kernel = trace.entries.filter((entry) => entry.source === 'kernel');

    expect(kernel.map((entry) => entry.correlation)).toEqual([
      expect.objectContaining({
        executionId: 'execution-tool',
        invocationId: tool.id,
        routeId: toolRoute.id,
      }),
      expect.objectContaining({
        executionId: 'execution-tool',
        invocationId: tool.id,
        routeId: toolRoute.id,
      }),
      expect.objectContaining({
        executionId: 'execution-event',
        invocationId: event.id,
        routeId: eventRoute.id,
      }),
      expect.objectContaining({
        executionId: 'execution-event',
        invocationId: event.id,
        routeId: eventRoute.id,
      }),
    ]);
    expect(kernel.map((entry) => entry.kind)).toEqual([
      'kernel.render.start',
      'kernel.render.finish',
      'kernel.render.start',
      'kernel.render.finish',
    ]);
  } finally {
    await service.close();
    await rm(root, { force: true, recursive: true });
  }
});
