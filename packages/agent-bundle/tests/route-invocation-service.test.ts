import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { RouteInvocation } from '../src/dev/routes/route-invocation-result.ts';
import {
  InvocationRingBuffer,
  ROUTE_INVOCATION_STALE_REVISION_CODE,
  RouteInvocationService,
  RouteInvocationRequestError,
  invocationSummary,
  parseRouteInvocationRequest,
  routeInvocationStateRoot,
  type RouteInvocationChildRequest,
  type RouteInvocationChildResult,
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
  projection: {},
  providers: [],
  routeId: 'tool:fixture/echo',
  source: 'src/mcp/fixture/tools/echo.tsx',
  sourceRevision: 'revision',
  startedAt: completedAt,
  status: 'succeeded',
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
    event: { fixtureId: 'starter', host: 'claude' },
    mode: 'unit-render',
    routeId: 'event:tool/after',
  })).toEqual({
    event: { fixtureId: 'starter', host: 'claude' },
    mode: 'unit-render',
    routeId: 'event:tool/after',
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
    { event: { host: 'other' }, routeId: 'event:tool/after' },
    { event: { fixtureId: '' }, routeId: 'event:tool/after' },
    { mode: 'preview', routeId: 'tool:x/y' },
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

const childResult = (request: RouteInvocationChildRequest): RouteInvocationChildResult => ({
  document: {
    root: { kind: 'text', text: 'ok' },
    status: 'success',
    version: 1,
  },
  events: [],
  input: request.input,
  mcp: {},
  renderDurationMs: 1,
});

it('aborts and drains a running render when the service closes', async () => {
  let releases = 0;
  const started = deferred();
  const service = new RouteInvocationService({
    manifest: {
      manifest: () => catalog('digest', 'revision'),
    },
    prepared: () => ({
      project: {
        manifest: { projectRoot: '/project' } as never,
        stateRoot: routeInvocationStateRoot('/project'),
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

  const pending = service.invoke({ input: {}, mode: 'unit-render', routeId: echoRoute.id });
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
  const service = new RouteInvocationService({
    concurrency: 1,
    manifest: {
      manifest: () => catalog(digest, sourceRevision),
    },
    prepared: () => ({
      project: {
        manifest: { projectRoot } as never,
        stateRoot: routeInvocationStateRoot(projectRoot),
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
      return childResult(request);
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
    manifestDigest: 'digest-1',
    sourceRevision: 'rev-1',
    status: 'succeeded',
  });
  expect(executed).toHaveLength(1);
  expect(executed[0]?.stateRoot).toBe(routeInvocationStateRoot(projectRoot));
  expect(executed[0]?.stateRoot).not.toBe(projectRoot);
  await expect(second).rejects.toMatchObject({
    code: ROUTE_INVOCATION_STALE_REVISION_CODE,
    status: 409,
  });
  expect(executed).toHaveLength(1);
  expect(releases).toBe(2);
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
    stateRoot: routeInvocationStateRoot(root),
    targets: ['claude' as const],
  });
  return {
    root,
    service: (options = {}) => new RouteInvocationService({
      manifest: { manifest: () => manifest },
      prepared: () => prepared,
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

/**
 * `report.tsx` imports `panel.tsx` by its emitted name and also renders the
 * string `'./panel.js'`: the child must resolve the component and print the
 * text exactly as the compiled program does (#600).
 */
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
    const invocation = await project.service().invoke({ input: {}, routeId: 'tool:fixture/report' });

    expect(invocation.status, JSON.stringify(invocation.diagnostics)).toBe('succeeded');
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
    const invocation = await project.service().invoke({ input: {}, mode: 'unit-render', routeId: 'tool:fixture/leak' });
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
    const pending = service.invoke({ input: {}, mode: 'unit-render', routeId: 'tool:fixture/leak' });
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
    const pending = service.invoke({ input: {}, mode: 'unit-render', routeId: 'tool:fixture/leak' });
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
  prepared: () => ({
    manifest: { projectRoot: '/project' } as never,
    stateRoot: routeInvocationStateRoot('/project'),
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
  expect(result.providers).toEqual([{ id: 'provider:clock', name: 'clock', status: 'unobserved' }]);
  expect(result.providers[0]).not.toHaveProperty('durationMs');
  expect(result.timings.map((entry) => entry.phase)).toEqual(['render', 'projection']);
  expect(result.timings[0]).toMatchObject({ durationMs: 12, phase: 'render' });
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
