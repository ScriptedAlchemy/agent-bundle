import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

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
import { expectDocument } from '../src/test/matchers.ts';
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
