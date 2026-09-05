import { access, cp, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { expect, it } from '@rstest/core';
import type { Transport } from '@modelcontextprotocol/client';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from './support/build.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { normalizeProject } from '../src/config/normalize.ts';

import { EpochStore } from '../src/dev/epoch-store.ts';
import { McpAppBindingService, type McpAppSessionAuthority } from '../src/dev/mcp-apps/mcp-app-binding-service.ts';
import {
  mcpAppClientCapabilities,
  McpSession,
  McpSessionError,
  McpSessionService,
  type McpSessionTraceSubscription,
} from '../src/dev/mcp-session/mcp-session-service.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import { pathTokens, type NormalizationTargetRegistry } from '../src/core/types.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import { mcpCatalogStub, stdioTransportStub } from './support/mcp-client-stub.ts';
import { loadedProject } from './support/loaded-project.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const runtimeFor = (target: string) => {
  const runtime = createDefaultRegistry().mcpRuntime(target);
  if (runtime === undefined) throw new Error(`Expected MCP runtime for ${JSON.stringify(target)}.`);
  return runtime;
};

const epochFor = (
  root: string,
  id: string,
  createdAt = '2026-08-14T12:00:00.000Z',
  targets: readonly string[] = ['portable'],
): ArtifactEpoch => ({
  configDigest: 'config-digest',
  createdAt,
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: 'model-digest',
  projectRevision: 'project-revision',
  targetDigests: Object.fromEntries(targets.map((target) => [target, `${target}-digest`])),
});

/**
 * Stages one built plugin root as an epoch the way the artifact service does
 * (#555): the epoch is the root itself, so every top-level entry moves over.
 */
const copyArtifactIntoStaging = async (artifact: string, stagingRoot: string): Promise<void> => {
  await Promise.all((await readdir(artifact)).map((entry) =>
    cp(join(artifact, entry), join(stagingRoot, entry), { recursive: true })));
};

const textFrom = (value: { readonly content: readonly { readonly type: string }[] }): string => {
  const content: unknown = value.content[0];
  if (
    typeof content !== 'object' ||
    content === null ||
    !('text' in content) ||
    !('type' in content) ||
    content.type !== 'text' ||
    typeof content.text !== 'string'
  ) {
    throw new Error('Expected the fixture to return a text content block.');
  }
  return content.text;
};

const isToolCallFrame = (message: unknown, name: string): boolean =>
  typeof message === 'object'
  && message !== null
  && (message as { readonly method?: unknown }).method === 'tools/call'
  && (message as { readonly params?: { readonly name?: unknown } }).params?.name === name;

/**
 * Resolves once the session puts the `tools/call` for `name` on the wire. The
 * request slot is admitted before the SDK sends, so from then on `cancel()`
 * finds it — an ordering a fixed sleep can only approximate.
 */
const toolCallSent = (session: McpSession, name: string): Promise<void> => {
  const afterSequence = session.trace().entries.at(-1)?.sequence ?? 0;
  let subscription: McpSessionTraceSubscription | undefined;
  const sent = new Promise<void>((resolvePromise) => {
    subscription = session.subscribeTrace({ afterSequence }, (entry) => {
      if ('kind' in entry && entry.kind === 'frame' && entry.direction === 'client' && isToolCallFrame(entry.message, name)) {
        resolvePromise();
      }
    });
  });
  return sent.finally(() => subscription?.unsubscribe());
};

const publishFixtureEpoch = async (
  root: string,
  id: string,
  targets: readonly ('claude' | 'portable')[] = ['portable'],
): Promise<EpochStore> => {
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(
    join(agentBundleNodeModules, '@modelcontextprotocol'),
    join(root, 'node_modules', '@modelcontextprotocol'),
    'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'src', 'server.ts'), [
    "import { McpServer } from '@modelcontextprotocol/server';",
    "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
    '',
    "const server = new McpServer({ name: 'persistent-fixture', version: '1.0.0' });",
    "server.registerTool('inspect', { description: 'Inspect persistent session state.' }, async () => {",
    "  process.stderr.write('fixture stderr\\n');",
    '  return {',
    "    _meta: { ui: { resourceUri: 'ui://fixture/result.html' }, opaque: { nested: ['exact', 42] } },",
    '    content: [',
    "      { type: 'text', text: JSON.stringify({ cwd: process.cwd(), data: process.env.FIXTURE_DATA, inherited: process.env.AGENT_BUNDLE_PERSISTENT_INHERITED, pid: process.pid, root: process.env.FIXTURE_ROOT, workspace: process.env.FIXTURE_WORKSPACE }) },",
    "      { type: 'resource_link', name: 'fixture', uri: 'ui://fixture/resource.txt' },",
    '    ],',
    "    structuredContent: { answer: 42, opaque: { exact: true } },",
    '  };',
    '});',
    "server.registerTool('hang', { description: 'Wait for cancellation.' }, async () => new Promise(() => {}));",
    "server.registerResource('fixture', 'ui://fixture/resource.txt', { mimeType: 'text/plain' }, async (uri) => ({",
    "  contents: [{ mimeType: 'text/plain', text: 'fixture resource', uri: uri.href }],",
    '}));',
    "server.registerPrompt('fixture', { description: 'Fixture prompt.' }, async () => ({",
    "  messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }],",
    '}));',
    'await server.connect(new StdioServerTransport());',
    '',
  ].join('\n'));

  const model = await normalizeProject(
    loadedProject(root, {
      mcp: {
        servers: {
          fixture: {
            entry: './src/server.ts',
            env: {
              FIXTURE_DATA: targets.includes('claude') ? pathTokens.pluginData : '${PLUGIN_DATA}',
              FIXTURE_ROOT: targets.includes('claude') ? pathTokens.pluginRoot : '${PLUGIN_ROOT}',
              ...(targets.includes('claude') ? { FIXTURE_WORKSPACE: pathTokens.workspaceRoot } : {}),
            },
          },
        },
      },
      plugin: { name: 'persistent-mcp-fixture', version: '1.0.0' },
      targets: [...targets],
    }),
    { skills: [] },
    registry,
  );
  const artifact = join(root, 'compiled');
  await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

  const store = new EpochStore({ projectRoot: root });
  const staging = await store.createStagingEpoch({
    epoch: epochFor(root, id, undefined, targets),
    targets,
  });
  await copyArtifactIntoStaging(artifact, staging.root);
  await staging.publish(async () => undefined);
  const epochRoot = join(root, '.agent-bundle', 'epochs', id);
  await expect(validateArtifact({
    allowEpochStagingMarker: true,
    artifactRoot: epochRoot,
  })).resolves.toEqual([]);
  return store;
};

const publishRemoteEpoch = async (root: string, id: string): Promise<EpochStore> => {
  await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
  const model = await normalizeProject(
    loadedProject(root, {
      mcp: {
        servers: {
          http: {
            // Agent Plugins §7.2.1: clients never expand placeholders in
            // headers, and the build now fails closed on one (AB6036).
            headers: { Authorization: 'Bearer fixture-token' },
            transport: 'streamable-http',
            url: 'https://mcp.example.test/tools',
          },
        },
      },
      plugin: { name: 'persistent-mcp-remote-fixture', version: '1.0.0' },
      targets: ['portable'],
    }),
    { skills: [] },
    registry,
  );
  const artifact = join(root, 'compiled');
  await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

  const store = new EpochStore({ projectRoot: root });
  const staging = await store.createStagingEpoch({ epoch: epochFor(root, id), targets: ['portable'] });
  await copyArtifactIntoStaging(artifact, staging.root);
  await staging.publish(async () => undefined);
  return store;
};

const publishEpochCopy = async (
  root: string,
  store: EpochStore,
  sourceRoot: string,
  epochId: string,
  createdAt: string,
): Promise<void> => {
  const staging = await store.createStagingEpoch({
    epoch: epochFor(root, epochId, createdAt),
    targets: ['portable'],
  });
  await copyArtifactIntoStaging(sourceRoot, staging.root);
  await staging.publish(async () => undefined);
};

it('keeps one generated server and plugin-data directory bound to the selected epoch until restart or close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-'));
  const inheritedKey = 'AGENT_BUNDLE_PERSISTENT_INHERITED';
  const previousInherited = process.env[inheritedKey];
  try {
    process.env[inheritedKey] = 'resolved-on-open';
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const service = new McpSessionService({ epochStore, projectRoot: root });
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });

    expect(session.binding).toEqual({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    expect((await session.listTools()).map((tool) => tool.name)).toEqual(['inspect', 'hang']);
    expect((await session.listResources()).map((resource) => resource.uri)).toEqual(['ui://fixture/resource.txt']);
    expect(await session.listResourceTemplates()).toEqual([]);
    expect((await session.listPrompts()).map((prompt) => prompt.name)).toEqual(['fixture']);
    await expect(session.getPrompt({ name: 'fixture' })).resolves.toMatchObject({
      messages: [{ content: { text: 'fixture prompt', type: 'text' }, role: 'user' }],
    });
    await expect(session.readResource({ uri: 'ui://fixture/resource.txt' })).resolves.toEqual({
      contents: [{ mimeType: 'text/plain', text: 'fixture resource', uri: 'ui://fixture/resource.txt' }],
    });

    const first = await session.callTool({ arguments: {}, name: 'inspect' });
    expect(first).toMatchObject({
      _meta: { opaque: { nested: ['exact', 42] }, ui: { resourceUri: 'ui://fixture/result.html' } },
      content: [{ type: 'text' }, { name: 'fixture', type: 'resource_link', uri: 'ui://fixture/resource.txt' }],
      structuredContent: { answer: 42, opaque: { exact: true } },
    });
    const firstState = JSON.parse(textFrom(first)) as {
      readonly data: string;
      readonly inherited: string;
      readonly pid: number;
      readonly root: string;
    };
    expect(firstState.root).toBe(join(root, '.agent-bundle', 'epochs', 'epoch-1'));
    expect(firstState.inherited).toBe('resolved-on-open');
    await expect(access(firstState.data)).resolves.toBeUndefined();
    expect(session.events().some((event) => event.type === 'stderr' && event.text === 'fixture stderr\n')).toBe(true);
    expect(session.frames().length).toBeGreaterThan(0);

    const second = await session.callTool({ arguments: {}, name: 'inspect' });
    const secondState = JSON.parse(textFrom(second)) as {
      readonly data: string;
      readonly inherited: string;
      readonly pid: number;
    };
    expect(secondState).toEqual(firstState);

    process.env[inheritedKey] = 'changed-after-open';
    await session.restart();
    const restarted = await session.callTool({ arguments: {}, name: 'inspect' });
    const restartedState = JSON.parse(textFrom(restarted)) as {
      readonly data: string;
      readonly inherited: string;
      readonly pid: number;
      readonly root: string;
    };
    expect(restartedState.data).toBe(firstState.data);
    expect(restartedState.inherited).toBe('resolved-on-open');
    expect(restartedState.root).toBe(firstState.root);
    expect(restartedState.pid).not.toBe(firstState.pid);

    const pendingSent = toolCallSent(session, 'hang');
    const pending = session.callTool({ arguments: {}, name: 'hang', requestId: 'pending-hang' });
    await pendingSent;
    expect(session.cancel('pending-hang')).toBe(true);
    await expect(pending).rejects.toBeDefined();

    await session.close();
    await session.close();
    await expect(access(firstState.data)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.close();
  } finally {
    if (previousInherited === undefined) {
      delete process.env[inheritedKey];
    } else {
      process.env[inheritedKey] = previousInherited;
    }
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('uses the admitted session timeout for initialization, catalog, operations, and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-timeout-'));
  const observed: Array<readonly [string, number | undefined]> = [];
  const callToolParams: unknown[] = [];
  const capture = (operation: string, options: { readonly timeout?: number } | undefined): void => {
    observed.push([operation, options?.timeout]);
  };
  let service: McpSessionService | undefined;
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-timeout');
    service = new McpSessionService({
      createClient: () => ({
        callTool: async (params, options) => {
          callToolParams.push(params);
          capture('callTool', options);
          return { content: [] };
        },
        close: async () => undefined,
        connect: async (_transport, options) => {
          capture('connect', options);
        },
        getPrompt: async (_params, options) => {
          capture('getPrompt', options);
          return { messages: [] };
        },
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listPrompts: async (_params, options) => {
          capture('listPrompts', options);
          return { prompts: [] };
        },
        listResources: async (_params, options) => {
          capture('listResources', options);
          return { resources: [] };
        },
        listResourceTemplates: async (_params, options) => {
          capture('listResourceTemplates', options);
          return { resourceTemplates: [] };
        },
        listTools: async (_params, options) => {
          capture('listTools', options);
          return { tools: [] };
        },
        readResource: async (_params, options) => {
          capture('readResource', options);
          return { contents: [] };
        },
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });

    const defaultSession = await service.open({ epochId: 'epoch-timeout', serverName: 'fixture', target: 'portable' });
    expect((defaultSession as unknown as { readonly timeoutMs?: number }).timeoutMs).toBe(30_000);
    await defaultSession.listTools();
    await defaultSession.close();

    const session = await service.open({ epochId: 'epoch-timeout', serverName: 'fixture', target: 'portable', timeoutMs: 12_345 });
    expect((session as unknown as { readonly timeoutMs?: number }).timeoutMs).toBe(12_345);
    await session.listTools();
    await session.listResources();
    await session.listResourceTemplates();
    await session.listPrompts();
    await session.getPrompt({ name: 'fixture' });
    await session.readResource({ uri: 'ui://fixture/resource.txt' });
    await session.callTool({ arguments: {}, name: 'fixture' });
    await session.callTool({ _meta: { progressToken: 'lifecycle:fixture:0' }, arguments: {}, name: 'fixture' });
    await session.listTools({ timeoutMs: 321 });
    await session.restart();
    await expect(session.listTools({ timeoutMs: Number.NaN })).rejects.toThrow(
      'MCP session timeoutMs must be a positive finite number.',
    );

    expect(observed).toEqual([
      ['connect', 30_000],
      ['listTools', 30_000],
      ['connect', 12_345],
      ['listTools', 12_345],
      ['listResources', 12_345],
      ['listResourceTemplates', 12_345],
      ['listPrompts', 12_345],
      ['getPrompt', 12_345],
      ['readResource', 12_345],
      ['callTool', 12_345],
      ['callTool', 12_345],
      ['listTools', 321],
      ['connect', 12_345],
    ]);
    // `_meta` reaches the wire request only when the caller supplies it.
    expect(callToolParams).toEqual([
      { arguments: {}, name: 'fixture' },
      { _meta: { progressToken: 'lifecycle:fixture:0' }, arguments: {}, name: 'fixture' },
    ]);
    await session.close();
  } finally {
    await service?.close();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('uses the configured project root as the default workspace from a decoy cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-workspace-root-'));
  const decoy = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-workspace-decoy-'));
  const originalCwd = process.cwd();
  let service: McpSessionService | undefined;
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-workspace', ['claude']);
    service = new McpSessionService({ epochStore, projectRoot: root });
    process.chdir(decoy);
    const session = await service.open({ epochId: 'epoch-workspace', serverName: 'fixture', target: 'claude' });
    const first = JSON.parse(textFrom(await session.callTool({ arguments: {}, name: 'inspect' }))) as {
      readonly cwd: string;
      readonly workspace: string;
    };
    const targetRoot = join(root, '.agent-bundle', 'epochs', 'epoch-workspace');
    expect(first).toMatchObject({ cwd: targetRoot, workspace: root });

    await session.restart();
    const restarted = JSON.parse(textFrom(await session.callTool({ arguments: {}, name: 'inspect' }))) as {
      readonly cwd: string;
      readonly workspace: string;
    };
    expect(restarted).toMatchObject({ cwd: targetRoot, workspace: root });
  } finally {
    process.chdir(originalCwd);
    await service?.close();
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(decoy, { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('pins the selected epoch until the persistent session closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-reference-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const service = new McpSessionService({ epochStore, projectRoot: root });
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });

    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpochCopy(
        root,
        epochStore,
        join(root, '.agent-bundle', 'epochs', 'epoch-1'),
        `epoch-${sequence}`,
        `2026-08-14T12:00:0${sequence}.000Z`,
      );
    }
    await epochStore.cleanup();
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'mcp.json'))).resolves.toBeUndefined();

    await session.close();
    await epochStore.cleanup();
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('fails tool calls closed with a typed stale-epoch error when the pinned epoch is removed underneath the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-stale-epoch-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const service = new McpSessionService({ epochStore, projectRoot: root });
    // A session timeout beyond this test's own timeout proves the stale-epoch
    // failure below is fail-fast rather than the SDK request timeout.
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable', timeoutMs: 120_000 });

    // The serving project moves on; the pinned session must keep working.
    await publishEpochCopy(
      root,
      epochStore,
      join(root, '.agent-bundle', 'epochs', 'epoch-1'),
      'epoch-2',
      '2026-08-14T12:00:02.000Z',
    );
    await session.callTool({ arguments: {}, name: 'inspect' });

    const inFlight = session.callTool({ arguments: {}, name: 'hang', requestId: 'stale-epoch-in-flight' });
    const inFlightFailure = inFlight.then(
      () => { throw new Error('Expected the in-flight tool call to fail.'); },
      (error: unknown) => error,
    );

    // Another process's build retention cannot observe this process's epoch
    // leases: it removes the pinned epoch directory and metadata underneath
    // the live session while `active-epoch.json` already names epoch-2.
    await rm(join(root, '.agent-bundle', 'epochs', 'epoch-1'), { force: true, recursive: true });
    await rm(join(root, '.agent-bundle', 'epochs', '.metadata', 'epoch-1.json'), { force: true });

    await expect(session.callTool({ arguments: {}, name: 'inspect' })).rejects.toMatchObject({
      epochId: 'epoch-1',
      message: 'MCP session epoch "epoch-1" is no longer available; the project changed underneath the session.',
      name: 'McpSessionStaleEpochError',
    });
    await expect(inFlightFailure).resolves.toMatchObject({
      epochId: 'epoch-1',
      name: 'McpSessionStaleEpochError',
    });
    expect(service.get(session.id)).toBeUndefined();
    await session.close();
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('executes only the acquired epoch reference root when service and store roots differ', async () => {
  const serviceRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-service-root-'));
  const storeRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-store-root-'));
  try {
    await publishFixtureEpoch(serviceRoot, 'epoch-1');
    const epochStore = await publishFixtureEpoch(storeRoot, 'epoch-1');
    const service = new McpSessionService({ epochStore, projectRoot: serviceRoot });

    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    const result = await session.callTool({ arguments: {}, name: 'inspect' });
    const state = JSON.parse(textFrom(result)) as { readonly root: string };

    expect(state.root).toBe(join(storeRoot, '.agent-bundle', 'epochs', 'epoch-1'));
    await session.close();
    await expect(access(join(serviceRoot, '.agent-bundle', 'epochs', 'epoch-1', 'mcp.json'))).resolves.toBeUndefined();
    await service.close();
  } finally {
    await Promise.all([
      rm(serviceRoot, { force: true, recursive: true }),
      rm(storeRoot, { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('closes an in-flight open instead of returning an untracked epoch-pinning session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-open-close-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    let allowConnection: (() => void) | undefined;
    const connectionBlocked = new Promise<void>((resolvePromise) => {
      allowConnection = resolvePromise;
    });
    let connectionStarted: (() => void) | undefined;
    const connectionStartedPromise = new Promise<void>((resolvePromise) => {
      connectionStarted = resolvePromise;
    });
    let clientCloses = 0;
    const client = {
      callTool: async () => ({ content: [] }),
      close: async () => {
        clientCloses += 1;
      },
      connect: async () => {
        connectionStarted?.();
        await connectionBlocked;
      },
      ...mcpCatalogStub(),
    };
    const service = new McpSessionService({
      createClient: () => client,
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });

    const opening = service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    const openingFailure = opening.then(
      () => { throw new Error('Expected the aborted opening to fail.'); },
      (error: unknown) => error,
    );
    await connectionStartedPromise;
    let closeCompleted = false;
    const closing = service.close().then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);
    allowConnection?.();
    await closing;
    const openFailure = await openingFailure;
    expect(openFailure).toEqual(expect.objectContaining({ message: 'MCP session service is closed.' }));
    expect(clientCloses).toBe(1);

    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpochCopy(
        root,
        epochStore,
        join(root, 'compiled'),
        `epoch-${sequence}`,
        `2026-08-14T12:01:0${sequence}.000Z`,
      );
    }
    await epochStore.cleanup();
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('retains a rejected cleanup from an opening drained during service close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-opening-close-failure-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const cleanupFailure = new Error('opening cleanup failed');
    let allowConnection: (() => void) | undefined;
    const connectionBlocked = new Promise<void>((resolvePromise) => {
      allowConnection = resolvePromise;
    });
    let connectionStarted: (() => void) | undefined;
    const connectionStartedPromise = new Promise<void>((resolvePromise) => {
      connectionStarted = resolvePromise;
    });
    let clientCloses = 0;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => {
          clientCloses += 1;
          throw cleanupFailure;
        },
        connect: async () => {
          connectionStarted?.();
          await connectionBlocked;
        },
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });

    const opening = service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    await connectionStartedPromise;
    const closing = service.close();
    allowConnection?.();
    await expect(opening).rejects.toBe(cleanupFailure);
    const failure = await closing.then(
      () => { throw new Error('Expected service close to retain the opening cleanup failure.'); },
      (error: unknown) => error,
    );
    expect(failure).toEqual(expect.objectContaining({
      failures: [{ error: cleanupFailure, resource: 'opening' }],
      message: 'MCP session service could not close every lifecycle resource.',
      name: 'McpSessionServiceCloseError',
    }));
    expect(clientCloses).toBe(1);
    await expect(service.close()).rejects.toBe(failure);
    await expect(service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' })).rejects.toThrow(
      'MCP session service is closed.',
    );

    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpochCopy(
        root,
        epochStore,
        join(root, 'compiled'),
        `epoch-${sequence}`,
        `2026-08-14T12:01:0${sequence}.000Z`,
      );
    }
    await epochStore.cleanup();
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('orders opening cleanup failures before active session cleanup failures during service close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-opening-and-session-close-failure-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const openingFailure = new Error('opening cleanup failed');
    const sessionFailure = new Error('session cleanup failed');
    let allowOpeningConnection: (() => void) | undefined;
    const openingConnectionBlocked = new Promise<void>((resolvePromise) => {
      allowOpeningConnection = resolvePromise;
    });
    let openingConnectionStarted: (() => void) | undefined;
    const openingConnectionStartedPromise = new Promise<void>((resolvePromise) => {
      openingConnectionStarted = resolvePromise;
    });
    let clientIndex = 0;
    const service = new McpSessionService({
      createClient: () => {
        const index = clientIndex;
        clientIndex += 1;
        return {
          callTool: async () => ({ content: [] }),
          close: async () => {
            throw index === 0 ? sessionFailure : openingFailure;
          },
          connect: async () => {
            if (index === 1) {
              openingConnectionStarted?.();
              await openingConnectionBlocked;
            }
          },
          ...mcpCatalogStub(),
        };
      },
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const first = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    const opening = service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    await openingConnectionStartedPromise;

    const closing = service.close();
    allowOpeningConnection?.();
    await expect(opening).rejects.toBe(openingFailure);
    const failure = await closing.then(
      () => { throw new Error('Expected service close to retain opening and session cleanup failures.'); },
      (error: unknown) => error,
    );
    expect(failure).toEqual(expect.objectContaining({
      failures: [
        { error: openingFailure, resource: 'opening' },
        { error: sessionFailure, resource: 'session', sessionId: first.id },
      ],
      message: 'MCP session service could not close every lifecycle resource.',
      name: 'McpSessionServiceCloseError',
    }));
    await expect(service.close()).rejects.toBe(failure);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('waits for every session cleanup and retains every close failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-close-all-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const fastFailure = new Error('fast session cleanup failed');
    const delayedFailure = new Error('delayed session cleanup failed');
    let releaseDelayedClose: (() => void) | undefined;
    const delayedClose = new Promise<void>((resolvePromise) => {
      releaseDelayedClose = resolvePromise;
    });
    let delayedCloseStarted: (() => void) | undefined;
    const delayedCloseStartedPromise = new Promise<void>((resolvePromise) => {
      delayedCloseStarted = resolvePromise;
    });
    let clientIndex = 0;
    const service = new McpSessionService({
      createClient: () => {
        const index = clientIndex;
        clientIndex += 1;
        return {
          callTool: async () => ({ content: [] }),
          close: async () => {
            if (index === 0) throw fastFailure;
            delayedCloseStarted?.();
            await delayedClose;
            throw delayedFailure;
          },
          connect: async () => undefined,
          ...mcpCatalogStub(),
        };
      },
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const first = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    const second = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });

    let closeSettled = false;
    const closing = service.close();
    void closing.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await delayedCloseStartedPromise;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(closeSettled).toBe(false);
    releaseDelayedClose?.();

    const failure = await closing.then(
      () => { throw new Error('Expected service close to retain cleanup failures.'); },
      (error: unknown) => error,
    );
    expect(failure).toEqual(expect.objectContaining({
      failures: [
        { error: fastFailure, resource: 'session', sessionId: first.id },
        { error: delayedFailure, resource: 'session', sessionId: second.id },
      ],
      message: 'MCP session service could not close every lifecycle resource.',
      name: 'McpSessionServiceCloseError',
    }));
    expect(service.get(first.id)).toBeUndefined();
    expect(service.get(second.id)).toBeUndefined();
    await expect(service.close()).rejects.toBe(failure);
    await expect(service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' })).rejects.toThrow(
      'MCP session service is closed.',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('closes a replacement client when restart races with session shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-restart-close-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    let allowReplacement: (() => void) | undefined;
    const replacementBlocked = new Promise<void>((resolvePromise) => {
      allowReplacement = resolvePromise;
    });
    let replacementStarted: (() => void) | undefined;
    const replacementStartedPromise = new Promise<void>((resolvePromise) => {
      replacementStarted = resolvePromise;
    });
    const clients: Array<{ readonly close: () => Promise<void>; readonly closes: () => number }> = [];
    const service = new McpSessionService({
      createClient: () => {
        const index = clients.length;
        let closes = 0;
        const client = {
          callTool: async () => ({ content: [] }),
          close: async () => {
            closes += 1;
          },
          connect: async () => {
            if (index === 1) {
              replacementStarted?.();
              await replacementBlocked;
            }
          },
          ...mcpCatalogStub(),
        };
        clients.push({ close: client.close, closes: () => closes });
        return client;
      },
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });

    const restarting = session.restart();
    const restartRejected = expect(restarting).rejects.toThrow('MCP session is closed.');
    await replacementStartedPromise;
    const closing = session.close();
    allowReplacement?.();
    await closing;
    await restartRejected;
    expect(clients).toHaveLength(2);
    expect(clients[1]!.closes()).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('rejects an already-aborted tool call without invoking the MCP SDK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-pre-abort-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    let calls = 0;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => {
          calls += 1;
          return { content: [] };
        },
        close: async () => undefined,
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    const aborted = new AbortController();
    const reason = new Error('already cancelled');
    aborted.abort(reason);

    await expect(session.callTool({ arguments: {}, name: 'fixture', signal: aborted.signal })).rejects.toBe(reason);
    expect(calls).toBe(0);

    await session.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('rejects a tool call aborted while its epoch availability probe is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-probe-abort-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-probe-abort-data-'));
  try {
    let allowProbe: (() => void) | undefined;
    const probeBlocked = new Promise<void>((resolvePromise) => {
      allowProbe = resolvePromise;
    });
    let probeStarted: (() => void) | undefined;
    const probeStartedPromise = new Promise<void>((resolvePromise) => {
      probeStarted = resolvePromise;
    });
    let calls = 0;
    const session = new McpSession({
      assertEpochAvailable: async () => {
        probeStarted?.();
        await probeBlocked;
      },
      binding: { epochId: 'epoch-probe-abort', serverName: 'fixture', target: 'portable' },
      createClient: () => ({
        callTool: async () => {
          calls += 1;
          return { content: [] };
        },
        close: async () => undefined,
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      createStreamableHttpTransport: () => ({}) as never,
      epochReference: { close: async () => undefined, root } as never,
      id: 'session-probe-abort',
      onClose: () => undefined,
      pluginData,
      resolved: {
        runtime: runtimeFor('portable'),
        server: { args: [], command: 'node', kind: 'stdio' },
        target: 'portable',
        targetRoot: root,
      },
      workspaceRoot: root,
    });
    await session.initialize();
    const aborted = new AbortController();
    const reason = new Error('cancelled during epoch probe');

    const pending = session.callTool({ arguments: {}, name: 'fixture', signal: aborted.signal });
    await probeStartedPromise;
    aborted.abort(reason);
    allowProbe?.();

    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(0);
    await session.close();
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(pluginData, { force: true, recursive: true });
  }
}, 30_000);

it('bounds frame and event retention with an explicit replay overflow cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-retention-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    let spawned: Transport | undefined;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
        connect: async () => {
          for (let index = 0; index < 513; index += 1) {
            spawned?.onmessage?.({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progress: index, progressToken: 'retention-fixture' },
            });
          }
        },
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => {
        const transport = { close: async () => undefined, send: async () => undefined, start: async () => undefined, stderr: null };
        spawned = transport as Transport;
        return transport as never;
      },
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });

    expect(session.frames()).toHaveLength(512);
    expect(session.events()).toHaveLength(512);
    expect(session.replay(0)).toMatchObject({
      overflow: { afterSequence: 0, droppedThroughSequence: 2 },
    });
    expect(session.replay(2).overflow).toBeUndefined();

    const trace = session.trace(0);
    const earliestRetainedSequence = trace.entries[0]?.sequence;
    if (earliestRetainedSequence === undefined) throw new Error('Expected the trace to retain entries.');
    expect(trace.entries).toHaveLength(512);
    expect(trace.overflow).toEqual({ afterSequence: 0, droppedThroughSequence: earliestRetainedSequence - 1 });
    expect(session.trace(earliestRetainedSequence - 1).overflow).toBeUndefined();
    expect(Object.isFrozen(trace.entries)).toBe(true);
    expect(Object.isFrozen(trace.entries[0]!)).toBe(true);
    expect(Reflect.set(trace.entries[0]!, 'sequence', 0)).toBe(false);

    const replayed: Array<{ readonly sequence?: number; readonly type?: string }> = [];
    session.subscribeTrace({ afterSequence: 0 }, (entry) => {
      replayed.push('sequence' in entry
        ? { sequence: entry.sequence, type: entry.kind }
        : { type: entry.type });
    });
    expect(replayed[0]).toEqual({ type: 'replay.gap' });
    expect(replayed.slice(1).map((entry) => entry.sequence)).toEqual(trace.entries.map((entry) => entry.sequence));
    const latestSequence = trace.entries.at(-1)?.sequence;
    if (latestSequence === undefined) throw new Error('Expected a trace cursor.');
    expect(() => session.subscribeTrace({ afterSequence: latestSequence + 1 }, () => undefined)).toThrow(
      'cannot be ahead',
    );

    await session.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('delivers replay and reentrant live trace entries in one monotonic order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-trace-order-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-trace-order');
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-trace-order', serverName: 'fixture', target: 'portable' });
    const first: number[] = [];
    const second: number[] = [];
    let nested = false;

    session.subscribeTrace({ afterSequence: 0 }, (entry) => {
      if (!('sequence' in entry)) return;
      first.push(entry.sequence);
      if (!nested) {
        nested = true;
        for (let index = 0; index < 300; index += 1) {
          expect(session.cancel(`not-running-${index}`)).toBe(false);
        }
        session.subscribeTrace({ afterSequence: 0 }, (later) => {
          if ('sequence' in later) second.push(later.sequence);
        });
      }
    });

    expect(first).toEqual(Array.from({ length: 602 }, (_, index) => index + 1));
    expect(second).toEqual(Array.from({ length: 512 }, (_, index) => index + 91));
    await session.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('fails and closes the session as soon as stderr exceeds its output bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-stderr-limit-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const stderr = new PassThrough();
    let clientCloses = 0;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => {
          stderr.write('a'.repeat(1_000_000));
          stderr.write('!');
          return { content: [] };
        },
        close: async () => {
          clientCloses += 1;
        },
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => ({ close: async () => undefined, send: async () => undefined, start: async () => undefined, stderr }) as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });

    await expect(session.callTool({ arguments: {}, name: 'fixture' })).rejects.toThrow('stderr exceeds the 1 MB limit');
    await session.close();
    expect(clientCloses).toBe(1);
    expect(Buffer.byteLength(session.stderr())).toBeLessThanOrEqual(1_000_000);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('fails admission, lifecycle, and service misuse closed with coded McpSessionError values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-typed-errors-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-1');
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    // Each call the stub receives resolves the oldest admission waiter: by
    // then the session has admitted the request and registered its signal.
    const admissions: Array<() => void> = [];
    const nextAdmission = (): Promise<void> => new Promise<void>((resolvePromise) => {
      admissions.push(resolvePromise);
    });
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async (_params: unknown, options?: { readonly signal?: AbortSignal }) => {
          if (options?.signal !== undefined) signals.push(options.signal);
          const released = new Promise<void>((resolvePromise) => {
            releases.push(resolvePromise);
          });
          admissions.shift()?.();
          await released;
          return { content: [] };
        },
        close: async () => undefined,
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });

    const expectSessionError = async (
      rejection: Promise<unknown>,
      code: string,
      message: string,
    ): Promise<void> => {
      const error = await rejection.then(
        () => { throw new Error(`Expected ${code} to reject.`); },
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(McpSessionError);
      expect(error).toEqual(expect.objectContaining({ code, message, name: 'McpSessionError' }));
    };

    await expectSessionError(
      service.open({ epochId: 'epoch-1', serverName: '  ', target: 'portable' }),
      'invalid-server-name',
      'MCP server name must be nonempty.',
    );

    const session = await service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    await expectSessionError(
      session.callTool({ arguments: {}, name: 'fixture', requestId: ' ' }),
      'invalid-request-id',
      'MCP session requestId must be nonempty.',
    );

    const firstAdmitted = nextAdmission();
    const first = session.callTool({ arguments: {}, name: 'fixture', requestId: 'shared' });
    await firstAdmitted;
    expect(signals).toHaveLength(1);
    await expectSessionError(
      session.callTool({ arguments: {}, name: 'fixture', requestId: 'shared' }),
      'duplicate-request-id',
      'MCP session request "shared" is already active.',
    );
    expect(signals[0]?.aborted).toBe(false);
    releases.shift()?.();
    await expect(first).resolves.toEqual({ content: [] });
    // Releasing the request slot aborts its controller and frees the id.
    expect(signals[0]?.aborted).toBe(true);
    const reusedAdmitted = nextAdmission();
    const reused = session.callTool({ arguments: {}, name: 'fixture', requestId: 'shared' });
    await reusedAdmitted;
    expect(signals).toHaveLength(2);
    releases.shift()?.();
    await expect(reused).resolves.toEqual({ content: [] });

    await session.close();
    await expectSessionError(session.restart(), 'session-closed', 'MCP session is closed.');
    await expectSessionError(session.listTools(), 'session-closed', 'MCP session is closed.');

    await service.close();
    await expectSessionError(
      service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' }),
      'service-closed',
      'MCP session service is closed.',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('opens a generated streamable HTTP server through its modern transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-remote-'));
  try {
    const epochStore = await publishRemoteEpoch(root, 'epoch-remote');
    const http: Array<{ readonly headers?: Readonly<Record<string, string>>; readonly url: string }> = [];
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStreamableHttpTransport: (url, options) => {
        http.push({ ...options, url: url.href });
        return { close: async () => undefined, send: async () => undefined, start: async () => undefined } as never;
      },
      epochStore,
      projectRoot: root,
    });

    const httpSession = await service.open({ epochId: 'epoch-remote', serverName: 'http', target: 'portable' });

    expect(http[0]?.url).toBe('https://mcp.example.test/tools');
    expect(http[0]?.headers).toEqual({ Authorization: 'Bearer fixture-token' });

    await Promise.all([httpSession.close(), service.close()]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('retains frozen transport snapshots without caller or subscriber mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-raw-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-raw');
    const shared = { value: 'shared-before-mutation' };
    const outbound = {
      id: 1,
      jsonrpc: '2.0' as const,
      method: 'initialize',
      params: { a: shared, b: shared, nested: { value: 'outbound-before-mutation' } },
    };
    const progress = {
      jsonrpc: '2.0' as const,
      method: 'notifications/progress',
      params: { nested: { value: 'progress-before-mutation' }, progress: 1, progressToken: 'fixture-progress', total: 2 },
    };
    const logging = {
      jsonrpc: '2.0' as const,
      method: 'notifications/message',
      params: { data: { nested: ['logging-before-mutation'] }, level: 'info', logger: 'fixture' },
    };
    const result = {
      _meta: { opaque: { nested: ['exact', 42] } },
      content: [{ text: 'fixture result', type: 'text' as const }],
      structuredContent: { value: 42 },
    };
    let closed = false;
    let connected: Transport | undefined;
    let spawned: Transport | undefined;
    const inner: Transport = {
      close: async () => {
        closed = true;
      },
      send: async () => undefined,
      start: async () => undefined,
    };
    const client = {
      callTool: async () => result,
      close: async () => {
        await connected?.close();
      },
      connect: async (transport: Transport) => {
        connected = transport;
        await transport.start();
        await transport.send(outbound);
        spawned?.onmessage?.(progress);
        spawned?.onmessage?.(logging);
      },
      getPrompt: async () => ({ messages: [] }),
      getServerCapabilities: () => ({ logging: {} }),
      getServerVersion: () => ({ name: 'raw-fixture', version: '1.0.0' }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      listTools: async () => ({ tools: [] }),
      readResource: async () => ({ contents: [] }),
    };
    const service = new McpSessionService({
      createClient: () => client,
      createStdioTransport: () => {
        const stdioTransport = { ...inner, stderr: null };
        spawned = stdioTransport;
        return stdioTransport as never;
      },
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-raw', serverName: 'fixture', target: 'portable' });

    expect(session.frames().map((frame) => frame.message)).toEqual([outbound, progress, logging]);
    expect(session.frames()[0]!.message).not.toBe(outbound);
    expect(session.frames()[1]!.message).not.toBe(progress);
    expect(session.frames()[2]!.message).not.toBe(logging);
    outbound.params.nested.value = 'mutated-by-caller';
    shared.value = 'mutated-by-caller';
    progress.params.nested.value = 'mutated-by-caller';
    logging.params.data.nested[0] = 'mutated-by-caller';
    expect(session.frames().map((frame) => frame.message)).toEqual([
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          a: { value: 'shared-before-mutation' },
          b: { value: 'shared-before-mutation' },
          nested: { value: 'outbound-before-mutation' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { nested: { value: 'progress-before-mutation' }, progress: 1, progressToken: 'fixture-progress', total: 2 },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { data: { nested: ['logging-before-mutation'] }, level: 'info', logger: 'fixture' },
      },
    ]);
    expect(session.events()).toEqual([
      {
        payload: { nested: { value: 'progress-before-mutation' }, progress: 1, progressToken: 'fixture-progress', total: 2 },
        sequence: 3,
        type: 'progress',
      },
      { payload: { data: { nested: ['logging-before-mutation'] }, level: 'info', logger: 'fixture' }, sequence: 5, type: 'logging' },
    ]);
    const traceFrame = session.trace().entries.find((entry) => entry.kind === 'frame');
    if (traceFrame?.kind !== 'frame') throw new Error('Expected the raw outbound frame in the wire trace.');
    expect(traceFrame.message).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        a: { value: 'shared-before-mutation' },
        b: { value: 'shared-before-mutation' },
        nested: { value: 'outbound-before-mutation' },
      },
    });
    if (typeof traceFrame.message !== 'object' || traceFrame.message === null) {
      throw new Error('Expected the raw frame snapshot to be an object.');
    }
    expect(Reflect.set(traceFrame.message, 'mutated', true)).toBe(false);
    if (
      !('params' in traceFrame.message) ||
      typeof traceFrame.message.params !== 'object' ||
      traceFrame.message.params === null ||
      !('a' in traceFrame.message.params) ||
      !('b' in traceFrame.message.params)
    ) throw new Error('Expected detached repeated JSON values.');
    expect(traceFrame.message.params.a).toEqual({ value: 'shared-before-mutation' });
    expect(traceFrame.message.params.b).toEqual({ value: 'shared-before-mutation' });
    expect(traceFrame.message.params.a).not.toBe(traceFrame.message.params.b);

    const afterSequence = session.trace().entries.at(-1)?.sequence;
    if (afterSequence === undefined) throw new Error('Expected a trace cursor.');
    const subscriberSnapshots: unknown[] = [];
    const subscription = session.subscribeTrace({ afterSequence }, (entry) => subscriberSnapshots.push(entry));
    const liveFrame = {
      jsonrpc: '2.0' as const,
      method: 'notifications/progress',
      params: { nested: { value: 'live-before-mutation' }, progress: 2, progressToken: 'fixture-progress' },
    };
    spawned?.onmessage?.(liveFrame);
    subscription.unsubscribe();
    const received = subscriberSnapshots[0];
    if (
      typeof received !== 'object' ||
      received === null ||
      !('kind' in received) ||
      received.kind !== 'frame' ||
      !('message' in received) ||
      typeof received.message !== 'object' ||
      received.message === null
    ) throw new Error('Expected a live frame snapshot.');
    expect(received.message).not.toBe(liveFrame);
    expect(Reflect.set(received.message, 'mutated', true)).toBe(false);
    if (
      !('params' in received.message) ||
      typeof received.message.params !== 'object' ||
      received.message.params === null
    ) throw new Error('Expected a deeply frozen live frame snapshot.');
    expect(Reflect.set(received.message.params, 'mutated', true)).toBe(false);
    liveFrame.params.nested.value = 'mutated-by-caller';
    const replayedFrame = session.trace(afterSequence).entries.find((entry) => entry.kind === 'frame');
    if (replayedFrame?.kind !== 'frame') throw new Error('Expected a replayed frame snapshot.');
    expect(replayedFrame.message).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { nested: { value: 'live-before-mutation' }, progress: 2, progressToken: 'fixture-progress' },
    });
    const cyclic: { readonly jsonrpc: '2.0'; readonly method: string; self?: unknown } = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
    };
    cyclic.self = cyclic;
    expect(() => spawned?.onmessage?.(cyclic)).toThrow('cyclic');
    await expect(session.listTools()).resolves.toEqual([]);
    await expect(session.callTool({ arguments: {}, name: 'fixture' })).resolves.toBe(result);

    await session.close();
    expect(closed).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('fails closed when projecting adversarial generated launch configuration for the Inspector', () => {
  const shared = {
    binding: { epochId: 'epoch-inspector', serverName: 'fixture', target: 'portable' },
    createClient: () => ({}) as never,
    createStdioTransport: () => ({}) as never,
    createStreamableHttpTransport: () => ({}) as never,
    epochReference: { close: async () => undefined, root: '/tmp/agent-bundle-inspector' } as never,
    id: 'session-inspector',
    onClose: () => undefined,
    pluginData: '/tmp/agent-bundle-inspector-data',
    workspaceRoot: '/tmp/agent-bundle-inspector-workspace',
  };
  const stdio = new McpSession({
    ...shared,
    resolved: {
      runtime: runtimeFor('portable'),
      server: {
        args: [
          '--header',
          'Authorization: Bearer header-secret',
          '--header=Cookie: session=cookie-secret',
          '--token',
          '-token-secret',
          '--api-key=api-key-secret',
          '--enable-source-maps',
          '/tmp/agent-bundle-inspector/portable/server.mjs',
          '/tmp/agent-bundle-inspector/portable/token-secret/entry.mjs',
        ],
        command: 'node',
        env: {
          FORCE_COLOR: '2',
          LANG: 'en_US.UTF-8-token-secret',
          LC_ALL: 'BearerLocaleSecret',
          NO_COLOR: '1',
          TZ: 'token-timezone-secret',
        },
        kind: 'stdio',
      },
      target: 'portable',
      targetRoot: '/tmp/agent-bundle-inspector/portable',
    },
  });
  const stdioProjection = stdio.inspectorConfig();
  const stdioJson = JSON.stringify(stdioProjection);

  expect(stdioJson).not.toContain('header-secret');
  expect(stdioJson).not.toContain('cookie-secret');
  expect(stdioJson).not.toContain('token-secret');
  expect(stdioJson).not.toContain('api-key-secret');
  expect(stdioJson).not.toContain('environment-secret');
  expect(stdioJson).not.toContain('BearerLocaleSecret');
  expect(stdioJson).not.toContain('token-timezone-secret');
  if (stdioProjection.launch.kind !== 'stdio') throw new Error('Expected a stdio Inspector projection.');
  expect(stdioProjection.launch.env).toEqual({ FORCE_COLOR: '2', NO_COLOR: '1' });
  expect(stdioProjection.launch.args).toContain('--enable-source-maps');

  const remote = new McpSession({
    ...shared,
    id: 'session-inspector-remote',
    resolved: {
      runtime: runtimeFor('portable'),
      server: {
        headers: { Authorization: 'Bearer header-secret', Cookie: 'session=cookie-secret' },
        kind: 'streamable-http',
        url: 'https://user:password@mcp.example.test/token-secret/tools?token=query-secret#fragment-secret',
      },
      target: 'portable',
      targetRoot: '/tmp/agent-bundle-inspector/portable',
    },
  });
  const remoteProjection = remote.inspectorConfig();
  const remoteJson = JSON.stringify(remoteProjection);
  expect(remoteJson).not.toContain('password');
  expect(remoteJson).not.toContain('query-secret');
  expect(remoteJson).not.toContain('fragment-secret');
  expect(remoteJson).not.toContain('header-secret');
  expect(remoteJson).not.toContain('cookie-secret');
  expect(remoteJson).not.toContain('token-secret');
  expect(remoteProjection).toEqual({
    launch: { kind: 'streamable-http', url: 'https://mcp.example.test/' },
    origin: 'artifact',
  });
});

it('exposes one opaque, epoch-bound session handle with a bounded ordered wire trace and a secret-free Inspector projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-wire-'));
  const secretKey = 'AGENT_BUNDLE_MCP_SESSION_WIRE_SECRET';
  const previousSecret = process.env[secretKey];
  try {
    process.env[secretKey] = 'must-not-reach-the-browser';
    const epochStore = await publishFixtureEpoch(root, 'epoch-wire');
    const clientFrame = { id: 1, jsonrpc: '2.0' as const, method: 'initialize', params: {} };
    const progressFrame = {
      jsonrpc: '2.0' as const,
      method: 'notifications/progress',
      params: { progress: 1, progressToken: 'wire-fixture' },
    };
    let transport: Transport | undefined;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
        connect: async (nextTransport: Transport) => {
          transport = nextTransport;
          await nextTransport.start();
          await nextTransport.send(clientFrame);
          transport.onmessage?.(progressFrame);
        },
        getNegotiatedProtocolVersion: () => '2026-07-28',
        getProtocolEra: () => 'modern' as const,
        getPrompt: async () => ({ messages: [] }),
        getServerCapabilities: () => ({ logging: {} }),
        getServerVersion: () => ({ name: 'wire-fixture', version: '1.0.0' }),
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listTools: async () => ({ tools: [] }),
        readResource: async () => ({ contents: [] }),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-wire', serverName: 'fixture', target: 'portable' });

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/u);
    const id = session.id;
    expect(service.get(session.id)).toBe(session);
    expect(session.binding).toEqual({ epochId: 'epoch-wire', serverName: 'fixture', target: 'portable' });
    expect(Object.isFrozen(session.binding)).toBe(true);
    expect(session.connection).toMatchObject({
      protocolEra: 'modern',
      protocolVersion: '2026-07-28',
      server: { name: 'wire-fixture', version: '1.0.0' },
    });

    const received: unknown[] = [];
    const subscription = session.subscribeTrace({}, (entry) => received.push(entry));
    await session.callTool({ arguments: {}, name: 'fixture' });
    subscription.unsubscribe();
    const replay = session.trace(0);
    expect(replay.entries.map((entry) => entry.sequence)).toEqual([...replay.entries]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.sequence));
    expect(replay.entries.every((entry) => Number.isSafeInteger(entry.sequence) && entry.occurredAt > 0)).toBe(true);
    expect(replay.entries.some((entry) => entry.kind === 'operation')).toBe(true);
    const frame = replay.entries.find((entry) => entry.kind === 'frame');
    if (frame?.kind !== 'frame') throw new Error('Expected the raw client frame in the wire trace.');
    expect(frame.message).toEqual(clientFrame);
    expect(frame.message).not.toBe(clientFrame);
    expect(received.length).toBeGreaterThan(0);

    const inspector = session.inspectorConfig();
    expect(inspector.origin).toBe('artifact');
    expect(JSON.stringify(inspector)).not.toContain('must-not-reach-the-browser');
    expect(JSON.stringify(inspector)).not.toContain(secretKey);
    expect('headers' in inspector).toBe(false);

    const bindingBeforeRestart = session.binding;
    await session.restart();
    expect(session.id).toBe(id);
    expect(session.binding).toBe(bindingBeforeRestart);
    expect(session.binding).toEqual({ epochId: 'epoch-wire', serverName: 'fixture', target: 'portable' });
    expect(await service.closeSession(id)).toBe(true);
    expect(await service.closeSession(id)).toBe(false);
    expect(service.get(id)).toBeUndefined();
  } finally {
    if (previousSecret === undefined) {
      delete process.env[secretKey];
    } else {
      process.env[secretKey] = previousSecret;
    }
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('leases immutable canonical MCP App data without closing the control-owned session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-lease-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-app');
    const visibleTool = {
      _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['app'] } },
      inputSchema: { type: 'object' as const },
      name: 'show-weather',
    };
    const hiddenTool = {
      _meta: { ui: { resourceUri: 'ui://weather/private.html', visibility: ['model'] } },
      inputSchema: { type: 'object' as const },
      name: 'delete-weather',
    };
    const defaultTool = {
      _meta: { ui: { resourceUri: 'ui://weather/default.html' } },
      inputSchema: { type: 'object' as const },
      name: 'default-weather',
    };
    const visibleResource = {
      _meta: { ui: { visibility: ['app'] } },
      mimeType: 'text/html',
      name: 'weather-app',
      uri: 'ui://weather/forecast.html',
    };
    const hiddenResource = {
      _meta: { ui: { visibility: ['model'] } },
      mimeType: 'text/html',
      name: 'private-app',
      uri: 'ui://weather/private.html',
    };
    const defaultResource = {
      mimeType: 'text/html',
      name: 'default-app',
      uri: 'ui://weather/default.html',
    };
    const calls: Array<{ readonly arguments: Record<string, unknown>; readonly name: string }> = [];
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async ({ arguments: toolArguments, name }) => {
          calls.push({ arguments: toolArguments, name });
          return { content: [{ text: 'forecast', type: 'text' }], structuredContent: { name } };
        },
        close: async () => undefined,
        connect: async () => undefined,
        getPrompt: async () => ({ messages: [] }),
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [visibleResource, hiddenResource, defaultResource] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listTools: async () => ({ tools: [visibleTool, hiddenTool, defaultTool] }),
        readResource: async ({ uri }) => ({ contents: [{ text: uri, type: 'text' }] }),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const authority: McpAppSessionAuthority = service;
    const session = await service.open({ epochId: 'epoch-app', serverName: 'fixture', target: 'portable' });
    const lease = await authority.acquireAppLease(session.id);

    const identity = lease.session.identity as typeof lease.session.identity & { readonly binding: typeof session.binding };
    expect(identity).toEqual({ binding: session.binding, sessionId: session.id });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.binding)).toBe(true);
    expect(await lease.session.listBridgeTools()).toEqual([
      { appVisible: true, definition: visibleTool, name: 'show-weather' },
      { appVisible: false, definition: hiddenTool, name: 'delete-weather' },
      { appVisible: true, definition: defaultTool, name: 'default-weather' },
    ]);
    expect(await lease.session.listBridgeResources()).toEqual([
      { appVisible: true, uri: 'ui://weather/forecast.html' },
      { appVisible: false, uri: 'ui://weather/private.html' },
      { appVisible: true, uri: 'ui://weather/default.html' },
    ]);
    visibleTool._meta.ui.resourceUri = 'ui://attacker/replaced.html';
    visibleResource._meta.ui.visibility = ['model'];
    expect(await lease.session.listBridgeTools()).toEqual([
      {
        appVisible: true,
        definition: {
          _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['app'] } },
          inputSchema: { type: 'object' },
          name: 'show-weather',
        },
        name: 'show-weather',
      },
      { appVisible: false, definition: hiddenTool, name: 'delete-weather' },
      { appVisible: true, definition: defaultTool, name: 'default-weather' },
    ]);
    expect(await lease.session.listBridgeResources()).toEqual([
      { appVisible: true, uri: 'ui://weather/forecast.html' },
      { appVisible: false, uri: 'ui://weather/private.html' },
      { appVisible: true, uri: 'ui://weather/default.html' },
    ]);
    await expect(lease.session.callTool({ arguments: { city: 'Paris' }, name: 'show-weather' })).resolves.toEqual({
      content: [{ text: 'forecast', type: 'text' }],
      structuredContent: { name: 'show-weather' },
    });
    await expect(lease.session.readResource({ uri: 'ui://weather/forecast.html' })).resolves.toEqual({
      contents: [{ text: 'ui://weather/forecast.html', type: 'text' }],
    });
    expect(calls).toEqual([{ arguments: { city: 'Paris' }, name: 'show-weather' }]);

    await lease.release();
    await lease.release();
    await expect(session.listTools()).resolves.toEqual([visibleTool, hiddenTool, defaultTool]);
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('synchronously invalidates App leases when the control session closes during binding creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-close-race-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-app-close');
    const appTool = {
      _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['app'] } },
      inputSchema: { type: 'object' as const },
      name: 'show-weather',
    };
    let allowListing: (() => void) | undefined;
    const listing = new Promise<void>((resolvePromise) => {
      allowListing = resolvePromise;
    });
    let listingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => {
      listingStarted = resolvePromise;
    });
    let clientCloses = 0;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => {
          clientCloses += 1;
        },
        connect: async () => undefined,
        getPrompt: async () => ({ messages: [] }),
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listTools: async () => {
          listingStarted?.();
          await listing;
          return { tools: [appTool] };
        },
        readResource: async () => ({ contents: [] }),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-app-close', serverName: 'fixture', target: 'portable' });
    const bindings = new McpAppBindingService({ sessionAuthority: service });
    const creating = bindings.createBinding({
      input: {},
      previewProfile: 'portable',
      result: {},
      sessionId: session.id,
      tool: appTool,
    });
    await started;

    const closing = service.closeSession(session.id);
    expect(service.get(session.id)).toBeUndefined();
    await expect(service.acquireAppLease(session.id)).rejects.toThrow('Unknown MCP App session');
    allowListing?.();
    await expect(creating).rejects.toThrow('MCP App session is closed.');
    await closing;
    expect(clientCloses).toBe(1);

    const serviceSession = await service.open({ epochId: 'epoch-app-close', serverName: 'fixture', target: 'portable' });
    const serviceLease = await service.acquireAppLease(serviceSession.id);
    const closeReasons: unknown[] = [];
    serviceLease.watchSessionClosed((reason) => {
      closeReasons.push(reason);
    });
    const serviceClosing = service.close();
    expect(service.get(serviceSession.id)).toBeUndefined();
    expect(closeReasons).toHaveLength(1);
    await serviceClosing;
    await serviceLease.release();
    expect(clientCloses).toBe(2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('revokes App authority before a direct session close drains its client and in-flight lists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-direct-close-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-app-direct-close');
    const appTool = {
      _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['app'] } },
      inputSchema: { type: 'object' as const },
      name: 'show-weather',
    };
    let allowClientClose: (() => void) | undefined;
    const clientCloseBlocked = new Promise<void>((resolvePromise) => {
      allowClientClose = resolvePromise;
    });
    let clientCloseStarted: (() => void) | undefined;
    const clientClosing = new Promise<void>((resolvePromise) => {
      clientCloseStarted = resolvePromise;
    });
    let allowListing: (() => void) | undefined;
    const listingBlocked = new Promise<void>((resolvePromise) => {
      allowListing = resolvePromise;
    });
    let listCalls = 0;
    let bothListsStarted: (() => void) | undefined;
    const listsStarted = new Promise<void>((resolvePromise) => {
      bothListsStarted = resolvePromise;
    });
    let clientCloses = 0;
    const service = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => {
          clientCloses += 1;
          clientCloseStarted?.();
          await clientCloseBlocked;
        },
        connect: async () => undefined,
        getPrompt: async () => ({ messages: [] }),
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listTools: async () => {
          listCalls += 1;
          if (listCalls === 2) bothListsStarted?.();
          await listingBlocked;
          return { tools: [appTool] };
        },
        readResource: async () => ({ contents: [] }),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      epochStore,
      projectRoot: root,
    });
    const session = await service.open({ epochId: 'epoch-app-direct-close', serverName: 'fixture', target: 'portable' });
    const lease = await service.acquireAppLease(session.id);
    const bindings = new McpAppBindingService({ sessionAuthority: service });
    const listed = lease.session.listBridgeTools();
    const creating = bindings.createBinding({
      input: {},
      previewProfile: 'portable',
      result: {},
      sessionId: session.id,
      tool: appTool,
    });
    await listsStarted;

    const closeReasons: unknown[] = [];
    lease.watchSessionClosed((reason) => {
      closeReasons.push(reason);
    });
    const closing = session.close();
    await clientClosing;
    expect(service.get(session.id)).toBeUndefined();
    await expect(service.acquireAppLease(session.id)).rejects.toThrow('Unknown MCP App session');
    expect(closeReasons).toHaveLength(1);

    allowListing?.();
    await expect(listed).rejects.toThrow('MCP App session is closed.');
    await expect(creating).rejects.toThrow('MCP App session is closed.');
    allowClientClose?.();
    await closing;
    await session.close();
    expect(clientCloses).toBe(1);
    expect(closeReasons).toHaveLength(1);
    await lease.release();
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('shares one close promise when a synchronous close observer re-enters shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-reentrant-close-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-reentrant-data-'));
  try {
    let clientCloses = 0;
    let epochCloses = 0;
    let onCloseCalls = 0;
    let onClosingCalls = 0;
    let reentered = false;
    let reentrantClose: Promise<void> | undefined;
    const session = new McpSession({
      binding: { epochId: 'epoch-reentrant', serverName: 'fixture', target: 'portable' },
      createClient: () => ({
        callTool: async () => ({ content: [] }),
        close: async () => {
          clientCloses += 1;
        },
        connect: async () => undefined,
        ...mcpCatalogStub(),
      }),
      createStdioTransport: () => stdioTransportStub() as never,
      createStreamableHttpTransport: () => ({}) as never,
      epochReference: {
        close: async () => {
          epochCloses += 1;
        },
        root,
      } as never,
      id: 'session-reentrant',
      onClose: () => {
        onCloseCalls += 1;
      },
      onClosing: () => {
        onClosingCalls += 1;
        if (!reentered) {
          reentered = true;
          reentrantClose = session.close();
        }
      },
      pluginData,
      resolved: {
        runtime: runtimeFor('portable'),
        server: { args: [], command: 'node', kind: 'stdio' },
        target: 'portable',
        targetRoot: root,
      },
      workspaceRoot: root,
    });
    await session.initialize();

    const initialClose = session.close();
    expect(reentrantClose).toBe(initialClose);
    await expect(Promise.all([initialClose, reentrantClose!])).resolves.toEqual([undefined, undefined]);
    expect(onClosingCalls).toBe(1);
    expect(onCloseCalls).toBe(1);
    expect(clientCloses).toBe(1);
    expect(epochCloses).toBe(1);
    await expect(access(pluginData)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(pluginData, { force: true, recursive: true });
  }
}, 30_000);

it('advertises the pinned MCP Apps UI extension and MIME type on session initialize', () => {
  expect(mcpAppClientCapabilities).toEqual({
    extensions: {
      'io.modelcontextprotocol/ui': {
        mimeTypes: ['text/html;profile=mcp-app'],
      },
    },
  });
});
