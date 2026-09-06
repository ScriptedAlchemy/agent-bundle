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
  ROUTE_INVOCATION_STALE_REVISION_CODE,
  RouteInvocationService,
  RouteInvocationRequestError,
  invocationSummary,
  parseRouteInvocationRequest,
  type RouteInvocationChildRequest,
  type RouteInvocationChildResult,
  type RouteInvocationPreparedProject,
  type RouteInvocationServiceOptions,
} from '../src/dev/routes/route-invocation-service.ts';
import type { RouteManifest } from '../src/dev/routes/route-manifest.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';
import { testManifestFromRouteGraph } from '../src/test/manifest.ts';
import { expectDocument } from '../src/test/matchers.ts';
import { isProcessGone } from './support/bin-process.ts';
import { deferred } from './support/eventually.ts';

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
  outcome: { kind: 'success' },
  projection: {},
  providers: [],
  routeId: 'tool:fixture/echo',
  source: 'src/mcp/fixture/tools/echo.tsx',
  sourceRevision: 'revision',
  startedAt: completedAt,
  status: 'succeeded',
  surface: { kind: 'mcp' },
  timings: [],
  trace: [{
    at: 0,
    execution: {
      event: 'tool/after',
      executionId: id,
      host: 'claude',
      nativeEvent: 'PostToolUse',
    },
    kind: 'preflight.start',
    phase: 'preflight',
    sequence: 0,
  }],
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
    routeId: 'tool:curator/search_audible',
  })).toEqual({
    correlationId: 'browser-1',
    input: { query: 'Dune' },
    routeId: 'tool:curator/search_audible',
  });
  expect(parseRouteInvocationRequest({
    surface: { fixtureId: 'starter', host: 'claude', kind: 'event' },
    routeId: 'event:tool/after',
  })).toEqual({
    surface: { fixtureId: 'starter', host: 'claude', kind: 'event' },
    routeId: 'event:tool/after',
  });
  expect(parseRouteInvocationRequest({
    surface: { args: ['--name', 'Ada'], command: 'report', kind: 'cli' },
    routeId: 'tool:status/report',
  })).toEqual({
    surface: { args: ['--name', 'Ada'], command: 'report', kind: 'cli' },
    routeId: 'tool:status/report',
  });
  expect(parseRouteInvocationRequest({
    routeId: 'tool:curator/search_audible',
  })).toEqual({
    routeId: 'tool:curator/search_audible',
  });

  for (const value of [
    {},
    { routeId: '' },
    { routeId: 'tool:x/y', unknown: true },
    { args: ['ok', 1], routeId: 'cli:x' },
    { requestId: '', routeId: 'tool:x/y' },
    { event: { host: 'claude' }, routeId: 'event:tool/after' },
    { mode: 'preview', routeId: 'tool:x/y' },
    { routeId: 'event:tool/after', surface: { host: 'other', kind: 'event' } },
    { routeId: 'event:tool/after', surface: { fixtureId: '', kind: 'event' } },
    { routeId: 'tool:x/y', surface: { command: 'x', kind: 'cli' } },
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
  expect(summary).not.toHaveProperty('trace');
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
    prepared: async () => ({
      project: {
        artifact: { epochId: 'epoch-1', target: 'claude' },
        manifest: { plugin: { name: 'fixture', version: '1.0.0' }, projectRoot: '/project' } as never,
        stateRoot: '/project/.agent-bundle/state',
        targets: ['claude'],
      },
      release: () => undefined,
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
    routeId: route.id,
  });

  expect(result.timings.map((entry) => entry.phase)).toEqual(['render', 'projection']);
  expect(trace.entries).toEqual([
    expect.objectContaining({
      correlation: {
        correlationId: 'correlation-1',
        epochId: 'epoch-1',
        invocationId: result.id,
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
        routeId: route.id,
      },
      details: {
        diagnosticCodes: [],
        projectionKind: 'mcp',
        providers: [{ name: 'clock' }],
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
    prepared: async () => ({
      project: {
        artifact: { epochId: 'epoch-1', target: 'claude' },
        manifest: { projectRoot: '/project' } as never,
        stateRoot: '/project/.agent-bundle/state',
        targets: ['claude'],
      },
      release: () => undefined,
    }),
    renderChild: async () => {
      throw new Error('render exploded');
    },
    trace: trace.publisher,
  });

  const result = await service.invoke({
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
    routeId: route.id,
    surface: { host: 'claude', kind: 'event' },
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

const echoRoute = {
  config: [],
  id: 'tool:fixture/echo',
  kind: 'tool',
  provenance: { kind: 'conventional' },
  serverId: 'mcp:fixture',
  source: 'src/mcp/fixture/tools/echo.tsx',
} as const;

const catalog = (digest: string, sourceRevision: string): RouteManifest => ({
  diagnostics: [],
  digest,
  events: [],
  providers: [],
  scripts: [],
  servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [echoRoute] }],
  sourceRevision,
});

const childResult = (request: RouteInvocationChildRequest, text = 'ok'): RouteInvocationChildResult => ({
  document: {
    root: { kind: 'text', text },
    status: 'success',
    version: 1,
  },
  events: [],
  input: request.input,
  mcp: {},
  renderDurationMs: 1,
});

const preparedLease = async (project: RouteInvocationPreparedProject) => ({
  project,
  release: () => undefined,
});

it('aborts and drains a running render when the service closes', async () => {
  let releases = 0;
  const started = deferred();
  const service = new RouteInvocationService({
    manifest: {
      manifest: () => catalog('digest', 'revision'),
    },
    prepared: async () => ({
      project: {
        manifest: { projectRoot: '/project' } as never,
        stateRoot: '/project/.agent-bundle/state',
        targets: ['claude'],
      },
      release: () => {
        releases += 1;
      },
    }),
    renderChild: (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started.resolve();
    }),
  });

  const pending = service.invoke({ input: {}, routeId: echoRoute.id, surface: { kind: 'unit-render' } });
  await started.promise;
  await service.close();

  await expect(pending).resolves.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB8236' })],
    status: 'failed',
  });
  expect(releases).toBe(1);
});

it('rejects a queued invocation when the published revision moves before the slot is acquired', async () => {
  const hold = deferred();
  const firstStarted = deferred();
  let digest = 'digest-1';
  let sourceRevision = 'rev-1';
  const executed: RouteInvocationChildRequest[] = [];
  let releases = 0;
  const projectRoot = '/project';
  const stateRoot = join(projectRoot, '.agent-bundle', 'state');
  const service = new RouteInvocationService({
    concurrency: 1,
    manifest: {
      manifest: () => catalog(digest, sourceRevision),
    },
    prepared: async () => ({
      project: {
        manifest: { projectRoot } as never,
        stateRoot,
        targets: ['claude'],
      },
      release: () => {
        releases += 1;
      },
    }),
    renderChild: async (request) => {
      executed.push(request);
      firstStarted.resolve();
      await hold.promise;
      return childResult(request, 'old output');
    },
  });

  const first = service.invoke({ input: { n: 1 }, routeId: echoRoute.id });
  await firstStarted.promise;
  const second = service.invoke({ input: { n: 2 }, routeId: echoRoute.id });
  await Promise.resolve();
  digest = 'digest-2';
  sourceRevision = 'rev-2';
  hold.resolve();

  const firstResult = await first;
  expect(firstResult).toMatchObject({
    document: { root: { kind: 'text', text: 'old output' } },
    manifestDigest: 'digest-1',
    sourceRevision: 'rev-1',
    status: 'succeeded',
  });
  expect(executed).toHaveLength(1);
  expect(executed[0]?.stateRoot).toBe(stateRoot);
  expect(executed[0]?.stateRoot).not.toBe(projectRoot);
  await expect(second).rejects.toMatchObject({
    code: ROUTE_INVOCATION_STALE_REVISION_CODE,
    status: 409,
  });
  expect(executed).toHaveLength(1);
  expect(releases).toBe(2);
});

it('does not spawn a child for an invocation aborted while queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-queued-abort-'));
  const marker = join(root, 'queued-child-started');
  const hold = deferred();
  const firstStarted = deferred();
  let childStarts = 0;
  const service = new RouteInvocationService({
    concurrency: 1,
    manifest: {
      manifest: () => catalog('digest', 'revision'),
    },
    prepared: async () => ({
      project: {
        manifest: { projectRoot: root } as never,
        stateRoot: join(root, '.agent-bundle', 'state'),
        targets: ['claude'],
      },
      release: () => undefined,
    }),
    renderChild: async (request) => {
      childStarts += 1;
      if ((request.input as { readonly n?: number }).n === 2) await writeFile(marker, 'spawned');
      firstStarted.resolve();
      await hold.promise;
      return childResult(request);
    },
  });

  try {
    const first = service.invoke({ input: { n: 1 }, routeId: echoRoute.id });
    await firstStarted.promise;
    const controller = new AbortController();
    const second = service.invoke(
      { input: { n: 2 }, routeId: echoRoute.id },
      { signal: controller.signal },
    );
    const cancelled = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(new DOMException('Queued invocation cancelled.', 'AbortError'));
    await cancelled;

    expect(childStarts).toBe(1);
    expect(existsSync(marker)).toBe(false);
    hold.resolve();
    await first;
    expect(childStarts).toBe(1);
    expect(existsSync(marker)).toBe(false);
  } finally {
    hold.resolve();
    await service.close();
    await rm(root, { force: true, recursive: true });
  }
});

it('does not lease or execute an invocation aborted while queued', async () => {
  const hold = deferred();
  const firstStarted = deferred();
  const executed: RouteInvocationChildRequest[] = [];
  let leases = 0;
  const service = new RouteInvocationService({
    concurrency: 1,
    manifest: { manifest: () => catalog('digest', 'revision') },
    prepared: async () => {
      leases += 1;
      return {
        project: {
          manifest: { plugin: { name: 'fixture', version: '1.0.0' }, projectRoot: '/project' } as never,
          stateRoot: '/project/.agent-bundle/state',
          targets: ['claude'],
        },
        release: () => undefined,
      };
    },
    renderChild: async (request) => {
      executed.push(request);
      firstStarted.resolve();
      await hold.promise;
      return childResult(request);
    },
  });

  const first = service.invoke({ input: { n: 1 }, routeId: echoRoute.id });
  await firstStarted.promise;
  const controller = new AbortController();
  const queued = service.invoke({ input: { n: 2 }, routeId: echoRoute.id }, { signal: controller.signal });
  controller.abort(new DOMException('Request closed.', 'AbortError'));
  hold.resolve();

  await expect(first).resolves.toMatchObject({ status: 'succeeded' });
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  expect(executed).toHaveLength(1);
  expect(leases).toBe(1);
});

it('rejects a canonical event surface when the compiled route has preflight', async () => {
  const route = {
    config: [],
    event: 'tool/before',
    id: 'event:tool/before',
    execution: { fallback: 'standalone', preflight: 'src/events/tool/before.preflight.ts', runtime: 'standalone' },
    kind: 'event-route',
    provenance: { kind: 'conventional' },
    source: 'src/events/tool/before.tsx',
  } as const;
  let leases = 0;
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
    prepared: async () => {
      leases += 1;
      throw new Error('canonical preflight submission must fail before leasing');
    },
  });

  await expect(service.invoke({
    input: {},
    routeId: route.id,
    surface: { kind: 'event' },
  })).rejects.toMatchObject({
    code: 'AB8255',
    status: 400,
  });
  expect(leases).toBe(0);
});

interface RouteProject {
  readonly root: string;
  readonly service: (options?: Readonly<{ timeoutMs?: number }>) => RouteInvocationService;
}

/** One conventional tool route at `src/mcp/fixture/tools/<name>.tsx`, with the sibling files it imports. */
const routeProject = async (
  root: string,
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<RouteProject> => {
  const relativePath = `src/mcp/fixture/tools/${name}.tsx`;
  const source = join(root, relativePath);
  await mkdir(dirname(source), { recursive: true });
  await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(root, path), text)));
  const compiled = {
    config: {},
    id: `tool:fixture/${name}`,
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
    stateRoot: join(root, 'state'),
    targets: ['claude' as const],
  });
  return {
    root,
    service: (options = {}) => new RouteInvocationService({
      manifest: { manifest: () => manifest },
      prepared: () => preparedLease(prepared),
      timeoutMs: options.timeoutMs,
    }),
  };
};

interface LeakingRouteProject extends RouteProject {
  readonly pids: () => Promise<Readonly<{ child: number; descendant: number }> | undefined>;
}

/** A tool route that holds an interval and a forked descendant, and writes both pids. */
const leakingRouteProject = async (behaviour: 'hang' | 'reply'): Promise<LeakingRouteProject> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-child-'));
  const pidsPath = join(root, 'pids.json');
  const project = await routeProject(root, 'leak', {
    'src/mcp/fixture/tools/leak.tsx': [
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
    ].join('\n'),
  });
  return {
    ...project,
    pids: async () => {
      if (!existsSync(pidsPath)) return undefined;
      return JSON.parse(await readFile(pidsPath, 'utf8')) as Readonly<{ child: number; descendant: number }>;
    },
  };
};

const tsxSiblingProject = async (): Promise<RouteProject> => routeProject(
  await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-tsx-sibling-')),
  'report',
  {
    'src/mcp/fixture/tools/panel.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      '',
      "export const Panel = () => createElement(Agent.Text, null, 'panel rendered');",
      '',
    ].join('\n'),
    'src/mcp/fixture/tools/report.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      '',
      "import { Panel } from './panel.js';",
      '',
      'export default async function Report() {',
      "  return createElement(Agent.Result, null, createElement(Panel), createElement(Agent.Text, null, './panel.js'));",
      '}',
      '',
    ].join('\n'),
  },
);

it('resolves a `.js` import of a `.tsx` sibling without rewriting the same string rendered as text', { timeout: 30_000 }, async () => {
  const project = await tsxSiblingProject();
  try {
    const invocation = await project.service().invoke({ input: {}, routeId: 'tool:fixture/report', surface: { kind: 'unit-render' } });

    expect(invocation.status, JSON.stringify(invocation.diagnostics)).toBe('succeeded');
    expect(invocation.surface).toEqual({ kind: 'unit-render' });
    expect(invocation.document).toBeDefined();
    expectDocument(invocation.document!)
      .toContainText('panel rendered')
      .toContainText('./panel.js');
  } finally {
    await rm(project.root, { force: true, recursive: true });
  }
});

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
    const invocation = await project.service().invoke({ input: {}, routeId: 'tool:fixture/leak', surface: { kind: 'unit-render' } });
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
    const pending = service.invoke({ input: {}, routeId: 'tool:fixture/leak', surface: { kind: 'unit-render' } });
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
    const pending = service.invoke({ input: {}, routeId: 'tool:fixture/leak', surface: { kind: 'unit-render' } });
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
    prepared: () => preparedLease({
      manifest: testManifestFromRouteGraph({ graph, projectRoot: root }),
      stateRoot: join(root, '.agent-bundle', 'state'),
      targets: ['claude'],
    }),
    trace: trace.publisher,
  });
  try {
    const tool = await service.invoke({ routeId: toolRoute.id, surface: { kind: 'unit-render' } });
    const event = await service.invoke({ input: {}, routeId: eventRoute.id, surface: { kind: 'unit-render' } });
    const kernel = trace.entries.filter((entry) => entry.source === 'kernel');
    const manualKernel = kernel.filter((entry) =>
      entry.correlation.executionId === 'execution-tool'
      || entry.correlation.executionId === 'execution-event');

    expect(manualKernel.map((entry) => entry.correlation)).toEqual([
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
    expect(manualKernel.map((entry) => entry.kind)).toEqual([
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

const clockProvider = {
  id: 'provider:clock',
  name: 'clock',
  source: 'src/providers/clock.ts',
} as const;

const telemetryManifest = (): RouteManifest => ({
  diagnostics: [],
  digest: 'digest',
  events: [],
  providers: [clockProvider],
  scripts: [],
  servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [echoRoute] }],
  sourceRevision: 'revision',
});

const succeededChild = (observed?: RouteInvocationChildResult['observed']): RouteInvocationChildResult => ({
  document: {
    root: { children: [{ kind: 'text', text: 'ok' }], kind: 'result' },
    status: 'success',
    version: 1,
  },
  events: [{
    document: {
      root: { children: [{ kind: 'text', text: 'ok' }], kind: 'result' },
      status: 'success',
      version: 1,
    },
    sequence: 1,
    type: 'complete',
  }],
  input: {},
  mcp: { content: [] },
  ...(observed === undefined ? {} : { observed }),
  renderDurationMs: 12,
});

const telemetryService = (
  renderChild: NonNullable<RouteInvocationServiceOptions['renderChild']>,
): RouteInvocationService => new RouteInvocationService({
  manifest: { manifest: telemetryManifest },
  prepared: () => preparedLease({
    manifest: { projectRoot: '/project' } as never,
    stateRoot: '/project/state',
    targets: ['claude'],
  }),
  renderChild,
});

it('marks catalog providers unobserved when the child reports no observations', async () => {
  const result = await telemetryService(async () => succeededChild()).invoke({
    input: {},
    routeId: echoRoute.id,
  });

  expect(result.status).toBe('succeeded');
  expect(result.surface).toEqual({ kind: 'mcp' });
  expect(result.providers).toEqual([{ id: 'provider:clock', name: 'clock', status: 'unobserved' }]);
  expect(result.providers[0]).not.toHaveProperty('durationMs');
  expect(result.timings.map((entry) => entry.phase)).toEqual(['render', 'projection']);
  expect(result.timings[0]).toMatchObject({ durationMs: 12, phase: 'render' });
});

it('omits render timing when the child did not render', async () => {
  const result = await telemetryService(async () => {
    const { renderDurationMs: _renderDurationMs, ...withoutRender } = succeededChild();
    return withoutRender;
  }).invoke({
    input: {},
    routeId: echoRoute.id,
  });

  expect(result.providers).toEqual([{ id: 'provider:clock', name: 'clock', status: 'unobserved' }]);
  expect(result.timings.map((entry) => entry.phase)).toEqual(['projection']);
});

it('reports an event route kind for unit-render provenance', async () => {
  const route = {
    config: [],
    event: 'tool/after',
    id: 'event:tool/after',
    kind: 'event-route',
    provenance: { kind: 'conventional' },
    source: 'src/events/tool/after.tsx',
  } as const;
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
    prepared: () => preparedLease({
      manifest: { plugin: { name: 'fixture', version: '1.0.0' }, projectRoot: '/project' } as never,
      stateRoot: '/project/.agent-bundle/state',
      targets: ['claude'],
    }),
    renderChild: async (request) => childResult(request),
  });

  const result = await service.invoke({
    input: {},
    routeId: route.id,
    surface: { kind: 'unit-render' },
  });

  expect(result.context.invocation).toMatchObject({
    kind: 'event',
    operationId: route.id,
    surface: 'unit-render',
  });
});

it('forwards observed providers and timings without fabricating the rest', async () => {
  const observed = {
    providers: [{ durationMs: 7, id: 'provider:clock', name: 'clock', status: 'mounted' as const }],
    timings: [
      { durationMs: 3, phase: 'providers', startedAt: '2026-09-05T00:00:00.000Z' },
      { durationMs: 3, phase: 'provider:clock', startedAt: '2026-09-05T00:00:00.000Z' },
      { durationMs: 9, phase: 'handler', startedAt: '2026-09-05T00:00:00.003Z' },
      { durationMs: 99, phase: 'render', startedAt: '2026-09-05T00:00:00.012Z' },
    ],
  } as const;
  const result = await telemetryService(async () => succeededChild(observed)).invoke({
    input: {},
    routeId: echoRoute.id,
  });

  expect(result.providers).toEqual(observed.providers);
  expect(result.timings.map((entry) => entry.phase)).toEqual([
    'providers',
    'provider:clock',
    'handler',
    'render',
    'projection',
  ]);
  expect(result.timings.find((entry) => entry.phase === 'handler')).toMatchObject({ durationMs: 9 });
  expect(result.timings.find((entry) => entry.phase === 'render')).toMatchObject({ durationMs: 12 });
});

it('does not fabricate failed providers when the child throws', async () => {
  const result = await telemetryService(async () => {
    throw new Error('provider boom');
  }).invoke({ input: {}, routeId: echoRoute.id });

  expect(result.status).toBe('failed');
  expect(result.providers).toEqual([{ id: 'provider:clock', name: 'clock', status: 'unobserved' }]);
  expect(result.providers[0]).not.toHaveProperty('durationMs');
  expect(result.providers.some((provider) => provider.status === 'failed')).toBe(false);
  expect(result.timings.map((entry) => entry.phase)).toEqual(['elapsed']);
  expect(result.timings.some((entry) => entry.phase === 'render' || entry.phase === 'handler')).toBe(false);
});
