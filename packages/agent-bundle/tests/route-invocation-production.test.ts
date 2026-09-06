import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import type { RequestContextProvenance } from '../src/contracts/request-provenance.ts';
import {
  artifactCompilerRecordVersion,
  artifactManifestName,
  artifactManifestVersion,
  serializeArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestFile,
} from '../src/build/manifest.ts';
import { digest } from '../src/core/digest.ts';
import { resolveRouteExecutable } from '../src/dev/routes/route-invocation-executable.ts';
import { renderProductionRoute } from '../src/dev/routes/route-invocation-production.ts';
import type { RouteInvocationChildRequest } from '../src/dev/routes/route-invocation-service.ts';
import type { RouteInvocationSurface } from '../src/dev/routes/route-invocation.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';
import { testManifestFromRouteGraph } from '../src/test/manifest.ts';

const hash = (character: string): string => character.repeat(64);

const sourceInputs = Object.freeze([Object.freeze({ path: 'agent-bundle.config.ts', sha256: hash('a') })]);

const bundle = (path: string): ArtifactManifestFile => ({ bytes: 1, kind: 'bundle', path, sha256: hash('f') });

interface FixtureOptions {
  /** Event route execution record; defaults to a standalone runtime. */
  readonly execution?: Readonly<{ readonly fallback: 'none' | 'standalone'; readonly preflight?: string; readonly runtime: 'shared' | 'standalone' }>;
  /** Whether the hooks surface emitted `hooks/hooks-flight.mjs`. */
  readonly hooksWorker?: boolean;
  /** The wrapper rows of the event route, one per host. */
  readonly wrappers?: readonly string[];
  /** Compiled MCP servers with a Flight worker, by name, and the hosts each reaches. */
  readonly servers?: readonly Readonly<{ readonly hosts: readonly string[]; readonly name: string }>[];
}

/**
 * A canonical manifest of a two-host root with one tool route on server
 * `alpha`, a rendered script, a routed CLI, and one event route. `beta` is a
 * second compiled server whose worker exists on disk but owns no route the
 * tests invoke.
 */
const manifestFixture = (options: FixtureOptions = {}): ArtifactManifest => {
  const servers = options.servers ?? [{ hosts: ['claude', 'cursor'], name: 'alpha' }, { hosts: ['claude', 'cursor'], name: 'beta' }];
  const wrappers = options.wrappers ?? ['claude', 'cursor'];
  const hooksWorker = options.hooksWorker ?? true;
  const execution = options.execution ?? { fallback: 'none', runtime: 'standalone' };
  const files: ArtifactManifestFile[] = [
    bundle('bin/fixture.mjs'),
    bundle('bin/fixture-flight.mjs'),
    bundle('scripts/report.mjs'),
    bundle('scripts/report-flight.mjs'),
    ...servers.flatMap((server) => [bundle(`mcp/mcp-${server.name}.mjs`), bundle(`mcp/mcp-${server.name}-flight.mjs`)]),
    ...wrappers.map((host) => bundle(`hooks/event-route-tool-before.${host}.mjs`)),
    ...(hooksWorker ? [bundle('hooks/hooks-flight.mjs')] : []),
  ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    application: { id: 'plugin:fixture', name: 'fixture', version: '1.0.0' },
    compiler: {
      adapters: ['claude', 'cursor'].map((host) => ({ adapterRevision: `${host}-adapter-v1`, host, observedVersion: '1.0.0', schemas: [] })),
      agentSkills: {
        schemaSha256: hash('b'),
        sourceRevision: hash('c'),
        specification: 'https://example.invalid/specification.mdx',
      },
      producer: { name: 'agent-bundle', version: '0.1.0' },
      project: {
        configDigest: hash('a'),
        configPath: 'agent-bundle.config.ts',
        modelDigest: hash('e'),
        revision: digest({ inputs: sourceInputs }),
        sourceInputs,
      },
      provenance: files.map((file) => ({ path: file.path, sourceInputs: ['agent-bundle.config.ts'] })),
      recordVersion: artifactCompilerRecordVersion,
      validation: {
        artifact: { status: 'passed' },
        projections: [{ host: 'claude', status: 'passed' }, { host: 'cursor', status: 'passed' }],
        source: { status: 'passed' },
      },
    },
    distribution: { channels: ['local'], payloads: [] },
    executables: {
      bins: [{ hosts: ['claude', 'cursor'], name: 'fixture', path: 'bin/fixture.mjs', worker: 'bin/fixture-flight.mjs' }],
      hooks: wrappers.map((host) => ({
        event: 'tool/before',
        host,
        id: 'hook:event-route-tool-before',
        kind: 'event-route' as const,
        name: 'event-route-tool-before',
        path: `hooks/event-route-tool-before.${host}.mjs`,
        routeId: 'event:tool/before',
      })).sort((left, right) => left.host.localeCompare(right.host)),
      mcpServers: servers.map((server) => ({
        apps: [],
        hosts: [...server.hosts].sort(),
        id: `mcp:${server.name}`,
        kind: 'compiled' as const,
        launch: { args: [], entry: `mcp/mcp-${server.name}.mjs`, env: {}, worker: `mcp/mcp-${server.name}-flight.mjs` },
        name: server.name,
        transport: 'stdio',
      })).sort((left, right) => left.id.localeCompare(right.id)),
      scripts: [{
        hosts: ['claude', 'cursor'],
        id: 'script:report',
        mode: 'bundle',
        name: 'report',
        path: 'scripts/report.mjs',
        rendered: { routeId: 'script:report' },
        worker: 'scripts/report-flight.mjs',
      }],
    },
    files,
    manifestVersion: artifactManifestVersion,
    projections: [{ documents: {}, host: 'claude' }, { documents: {}, host: 'cursor' }],
    routes: {
      cli: {
        commands: [{
          aliases: [],
          exitCode: 'zero',
          options: [],
          path: ['greet'],
          routeId: 'cli:greet',
        }],
        mode: 'generated',
        routes: [{
          id: 'cli:greet',
          kind: 'cli',
          provenance: { kind: 'conventional' },
          source: 'src/cli/greet.tsx',
        }],
      },
      digest: hash('d'),
      events: [{
        event: 'tool/before',
        execution,
        id: 'event:tool/before',
        kind: 'event-route',
        provenance: { kind: 'conventional' },
        source: 'src/events/tool/before.tsx',
      }],
      layouts: [],
      providers: [],
      scripts: [{
        id: 'script:report',
        kind: 'script',
        provenance: { kind: 'conventional' },
        source: 'src/scripts/report.tsx',
      }],
      servers: [{
        id: 'mcp:alpha',
        mode: 'generated',
        name: 'alpha',
        routes: [{
          id: 'tool:alpha/echo',
          kind: 'tool',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:alpha',
          source: 'src/mcp/alpha/tools/echo.tsx',
        }],
      }],
    },
    runtime: { node: '22.12.0' },
  };
};

const bind = (
  routeId: string,
  surface: RouteInvocationSurface,
  manifest: ArtifactManifest = manifestFixture(),
) => resolveRouteExecutable({ artifactRoot: '/artifact', manifest, routeId, surface });

describe('resolveRouteExecutable', () => {
  it('binds MCP, script, and CLI routes to the executables the manifest rows name', () => {
    expect(bind('tool:alpha/echo', { kind: 'mcp' })).toEqual({ worker: '/artifact/mcp/mcp-alpha-flight.mjs' });
    expect(bind('script:report', { kind: 'script' })).toEqual({ worker: '/artifact/scripts/report-flight.mjs' });
    expect(bind('cli:greet', { args: ['Ada'], command: 'greet', kind: 'cli' })).toEqual({
      bin: '/artifact/bin/fixture.mjs',
      worker: '/artifact/bin/fixture-flight.mjs',
    });
  });

  it('binds a hosted standalone event to its host wrapper row and the hooks Flight worker', () => {
    expect(bind('event:tool/before', { host: 'cursor', kind: 'event' })).toEqual({
      worker: '/artifact/hooks/hooks-flight.mjs',
      wrapper: '/artifact/hooks/event-route-tool-before.cursor.mjs',
    });
    expect(bind('event:tool/before', { kind: 'event' })).toEqual({ worker: '/artifact/hooks/hooks-flight.mjs' });
  });

  it('binds a shared-runtime event to the first compiled server reaching the host, as eventRuntimeHosting does', () => {
    // `alpha` reaches claude only; cursor's runtime owner is the next server by
    // name (`beta`), not the first server overall and not the last one.
    const shared = manifestFixture({
      execution: { fallback: 'none', runtime: 'shared' },
      hooksWorker: false,
      servers: [{ hosts: ['claude'], name: 'alpha' }, { hosts: ['cursor'], name: 'beta' }, { hosts: ['cursor'], name: 'gamma' }],
    });

    expect(bind('event:tool/before', { host: 'claude', kind: 'event' }, shared)).toEqual({
      worker: '/artifact/mcp/mcp-alpha-flight.mjs',
      wrapper: '/artifact/hooks/event-route-tool-before.claude.mjs',
    });
    expect(bind('event:tool/before', { host: 'cursor', kind: 'event' }, shared)).toEqual({
      worker: '/artifact/mcp/mcp-beta-flight.mjs',
      wrapper: '/artifact/hooks/event-route-tool-before.cursor.mjs',
    });
    expect(bind('event:tool/before', { kind: 'event' }, shared)).toEqual({ worker: '/artifact/mcp/mcp-alpha-flight.mjs' });
  });

  it('binds a shared-runtime event to the one compiled server reaching the host, else to the declared standalone fallback', () => {
    const shared = manifestFixture({
      execution: { fallback: 'standalone', runtime: 'shared' },
      servers: [{ hosts: ['claude'], name: 'alpha' }],
    });

    expect(bind('event:tool/before', { host: 'claude', kind: 'event' }, shared).worker).toBe('/artifact/mcp/mcp-alpha-flight.mjs');
    expect(bind('event:tool/before', { host: 'cursor', kind: 'event' }, shared).worker).toBe('/artifact/hooks/hooks-flight.mjs');
    const noFallback = manifestFixture({
      execution: { fallback: 'none', runtime: 'shared' },
      hooksWorker: false,
      servers: [{ hosts: ['claude'], name: 'alpha' }],
    });
    expect(() => bind('event:tool/before', { host: 'cursor', kind: 'event' }, noFallback)).toThrow(
      expect.objectContaining({ code: 'AB8251', message: expect.stringContaining('for cursor') }),
    );
  });

  it('fails closed instead of guessing', () => {
    expect(() => bind('tool:alpha/missing', { kind: 'mcp' })).toThrow(expect.objectContaining({ code: 'AB8251' }));
    expect(() => bind('event:tool/before', { host: 'codex', kind: 'event' })).toThrow(expect.objectContaining({
      code: 'AB8251',
      message: expect.stringContaining('no codex wrapper'),
    }));
    expect(() => bind('event:tool/before', { host: 'claude', kind: 'event' }, manifestFixture({ hooksWorker: false }))).toThrow(
      expect.objectContaining({ code: 'AB8251' }),
    );
    const preflight = manifestFixture({
      execution: { fallback: 'none', preflight: 'src/events/tool/before.preflight.ts', runtime: 'standalone' },
    });
    expect(() => bind('event:tool/before', { kind: 'event' }, preflight)).toThrow(expect.objectContaining({
      code: 'AB8252',
      message: expect.stringContaining('handler is not reached'),
    }));
    expect(bind('event:tool/before', { host: 'claude', kind: 'event' }, preflight).wrapper).toBe('/artifact/hooks/event-route-tool-before.claude.mjs');
    expect(() => bind('tool:alpha/echo', { args: [], command: 'echo', kind: 'cli' })).toThrow(expect.objectContaining({
      code: 'AB8251',
      message: expect.stringContaining('routed CLI'),
    }));
  });
});

const context: RequestContextProvenance = {
  actor: { reason: 'not-provided', state: 'unavailable' },
  host: { reason: 'host-omitted', state: 'unavailable' },
  invocation: { kind: 'workbench', operationId: 'tool:alpha/echo', surface: 'mcp' },
  lineage: { reason: 'no-shared-runtime', state: 'unavailable' },
  session: { reason: 'not-provided', state: 'unavailable' },
  workspace: { source: 'derived', state: 'available', value: { root: '/project' } },
};

/** A Flight worker stand-in: records that it started, then answers every render with `message`. */
const workerSource = (name: string, message: string): string => [
  "import { writeFileSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "import { parentPort } from 'node:worker_threads';",
  '',
  `writeFileSync(fileURLToPath(new URL(${JSON.stringify(`../started-${name}`)}, import.meta.url)), 'started');`,
  "parentPort.on('message', (message) => {",
  "  if (message.type !== 'render') return;",
  `  parentPort.postMessage({ id: message.id, message: ${JSON.stringify(message)}, type: 'error' });`,
  '});',
  '',
].join('\n');

const missingRouteMessage = 'Generated route must default-export a route module.';

interface ArtifactFixture {
  readonly request: (routeId: string, surface: RouteInvocationSurface, input?: RouteInvocationChildRequest['input']) => RouteInvocationChildRequest;
  readonly root: string;
  readonly started: (name: string) => boolean;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const artifactFixture = async (
  manifest: ArtifactManifest | undefined,
  files: Readonly<Record<string, string>>,
): Promise<ArtifactFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-production-'));
  roots.push(root);
  const artifactRoot = join(root, 'artifact');
  await Promise.all(Object.entries({
    ...(manifest === undefined ? {} : { [artifactManifestName]: serializeArtifactManifest(manifest) }),
    ...files,
  }).map(async ([path, text]) => {
    await mkdir(dirname(join(artifactRoot, path)), { recursive: true });
    await writeFile(join(artifactRoot, path), text);
  }));
  const eventSource = join(root, 'src/events/tool/before.tsx');
  const toolSource = join(root, 'src/mcp/alpha/tools/echo.tsx');
  const graph = {
    diagnostics: [],
    digest: 'digest',
    events: [{
      config: {},
      event: 'tool/before',
      id: 'event:tool/before',
      kind: 'event-route',
      provenance: { kind: 'conventional', relativePath: 'src/events/tool/before.tsx' },
      source: eventSource,
    }],
    providers: [],
    scripts: [],
    servers: [{
      id: 'mcp:alpha',
      mode: 'generated',
      name: 'alpha',
      routes: [{
        config: {},
        id: 'tool:alpha/echo',
        kind: 'tool',
        provenance: { kind: 'conventional', relativePath: 'src/mcp/alpha/tools/echo.tsx' },
        serverId: 'mcp:alpha',
        source: toolSource,
      }],
    }],
  } satisfies CompiledRouteGraph;
  const harness = testManifestFromRouteGraph({ graph, projectRoot: root });
  return {
    request: (routeId, surface, input = {}) => ({
      artifactEpoch: 'fixture@1.0.0',
      artifactRoot,
      context,
      input,
      manifest: harness,
      routeId,
      stateRoot: join(root, 'state'),
      surface,
    }),
    root: artifactRoot,
    started: (name) => existsSync(join(artifactRoot, `started-${name}`)),
  };
};

describe('renderProductionRoute', () => {
  it('runs only the worker the manifest bound: a missing-route error there is the failure, not a cue to try a sibling', async () => {
    const fixture = await artifactFixture(manifestFixture(), {
      'mcp/mcp-alpha-flight.mjs': workerSource('alpha', missingRouteMessage),
      'mcp/mcp-beta-flight.mjs': workerSource('beta', 'beta must never run'),
      'hooks/hooks-flight.mjs': workerSource('hooks', 'hooks must never run'),
    });

    await expect(renderProductionRoute(fixture.request('tool:alpha/echo', { kind: 'mcp' }))).rejects.toThrow(missingRouteMessage);
    expect(fixture.started('alpha')).toBe(true);
    expect(fixture.started('beta')).toBe(false);
    expect(fixture.started('hooks')).toBe(false);
  });

  it('propagates a handler failure without running another executable', async () => {
    const fixture = await artifactFixture(manifestFixture(), {
      'hooks/hooks-flight.mjs': workerSource('hooks', 'handler exploded'),
      'mcp/mcp-alpha-flight.mjs': workerSource('alpha', 'alpha must never run'),
      'mcp/mcp-beta-flight.mjs': workerSource('beta', 'beta must never run'),
    });

    await expect(renderProductionRoute(fixture.request('event:tool/before', { kind: 'event' }, { canonical: {}, native: {} })))
      .rejects.toThrow('handler exploded');
    expect(fixture.started('hooks')).toBe(true);
    expect(fixture.started('alpha')).toBe(false);
    expect(fixture.started('beta')).toBe(false);
  });

  it('fails closed before any executable runs when the manifest cannot bind the route', async () => {
    const preflight = manifestFixture({
      execution: { fallback: 'none', preflight: 'src/events/tool/before.preflight.ts', runtime: 'standalone' },
      wrappers: ['claude'],
    });
    const workers = {
      'hooks/hooks-flight.mjs': workerSource('hooks', 'must never run'),
      'mcp/mcp-alpha-flight.mjs': workerSource('alpha', 'must never run'),
      'mcp/mcp-beta-flight.mjs': workerSource('beta', 'must never run'),
    };
    const fixture = await artifactFixture(preflight, workers);

    await expect(renderProductionRoute(fixture.request('event:tool/before', { kind: 'event' }, { canonical: {}, native: {} })))
      .rejects.toMatchObject({ code: 'AB8252' });
    await expect(renderProductionRoute(fixture.request('event:tool/before', { host: 'cursor', kind: 'event' }, { canonical: {}, native: {} })))
      .rejects.toMatchObject({ code: 'AB8251' });
    await expect(renderProductionRoute(fixture.request('tool:alpha/missing', { kind: 'mcp' }))).rejects.toMatchObject({ code: 'AB8251' });
    expect(fixture.started('hooks')).toBe(false);
    expect(fixture.started('alpha')).toBe(false);
    expect(fixture.started('beta')).toBe(false);

    const unpublished = await artifactFixture(undefined, workers);
    await expect(renderProductionRoute(unpublished.request('tool:alpha/echo', { kind: 'mcp' }))).rejects.toMatchObject({ code: 'AB8250' });
    expect(unpublished.started('alpha')).toBe(false);
  });

  it('runs the bound wrapper preparation and never reaches the handler when preflight does not execute', async () => {
    const fixture = await artifactFixture(manifestFixture(), {
      'hooks/event-route-tool-before.claude.mjs': [
        'export const prepareRouteInvocation = async (native) => Object.freeze({',
        "  gate: { outcome: 'deny', reason: 'blocked by fixture preflight' },",
        '  native,',
        "  props: { canonical: { decoded: true } },",
        "  runtime: 'standalone',",
        '});',
        '',
      ].join('\n'),
      'hooks/event-route-tool-before.cursor.mjs': 'export const unrelated = true;\n',
      'hooks/hooks-flight.mjs': workerSource('hooks', 'must never run'),
    });

    const denied = await renderProductionRoute(fixture.request('event:tool/before', { host: 'claude', kind: 'event' }, { native: { hook_event_name: 'PreToolUse' } }));
    expect(denied.result).toEqual({ outcome: 'deny', reason: 'blocked by fixture preflight' });
    expect(denied.input).toEqual({ canonical: { decoded: true }, native: { hook_event_name: 'PreToolUse' } });
    await expect(renderProductionRoute(fixture.request('event:tool/before', { host: 'cursor', kind: 'event' }, { native: {} })))
      .rejects.toMatchObject({ code: 'AB8252', message: expect.stringContaining('preparation contract') });
    expect(fixture.started('hooks')).toBe(false);
  });
});
