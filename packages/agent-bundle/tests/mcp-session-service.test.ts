import { access, cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import type { Transport } from '@modelcontextprotocol/client';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { McpSessionService } from '../src/dev/mcp-session-service.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import type { AgentBundleConfig, NormalizationTargetRegistry } from '../src/core/types.ts';

const registry: NormalizationTargetRegistry = {
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const loadedProject = (root: string, config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

const epochFor = (root: string, id: string, createdAt = '2026-08-14T12:00:00.000Z'): ArtifactEpoch => ({
  configDigest: 'config-digest',
  createdAt,
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: 'model-digest',
  projectRevision: 'project-revision',
  targetDigests: { portable: 'portable-digest' },
});

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

const publishFixtureEpoch = async (root: string, id: string): Promise<EpochStore> => {
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(
    join(process.cwd(), 'node_modules', '@modelcontextprotocol'),
    join(root, 'node_modules', '@modelcontextprotocol'),
    'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
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
    "      { type: 'text', text: JSON.stringify({ data: process.env.FIXTURE_DATA, inherited: process.env.AGENT_BUNDLE_PERSISTENT_INHERITED, pid: process.pid, root: process.env.FIXTURE_ROOT }) },",
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
              FIXTURE_DATA: '${PLUGIN_DATA}',
              FIXTURE_ROOT: '${PLUGIN_ROOT}',
            },
          },
        },
      },
      plugin: { name: 'persistent-mcp-fixture', version: '1.0.0' },
      targets: ['portable'],
    }),
    { skills: [] },
    registry,
  );
  const artifact = join(root, 'compiled');
  await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

  const store = new EpochStore({ projectRoot: root });
  const staging = await store.createStagingEpoch({ epoch: epochFor(root, id), targets: ['portable'] });
  await Promise.all([
    cp(join(artifact, 'agent-bundle.hooks.json'), join(staging.root, 'agent-bundle.hooks.json')),
    cp(join(artifact, 'agent-bundle.manifest.json'), join(staging.root, 'agent-bundle.manifest.json')),
    cp(join(artifact, 'portable'), join(staging.root, 'portable'), { recursive: true }),
  ]);
  await staging.publish(async () => undefined);
  const epochRoot = join(root, '.agent-bundle', 'epochs', id);
  await expect(validateArtifact({
    allowEpochStagingMarker: true,
    artifactRoot: epochRoot,
  })).resolves.toEqual([]);
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
  await Promise.all([
    cp(join(sourceRoot, 'agent-bundle.hooks.json'), join(staging.root, 'agent-bundle.hooks.json')),
    cp(join(sourceRoot, 'agent-bundle.manifest.json'), join(staging.root, 'agent-bundle.manifest.json')),
    cp(join(sourceRoot, 'portable'), join(staging.root, 'portable'), { recursive: true }),
  ]);
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
    expect(firstState.root).toBe(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'portable'));
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

    const pending = session.callTool({ arguments: {}, name: 'hang', requestId: 'pending-hang' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
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
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'portable', 'mcp.json'))).resolves.toBeUndefined();

    await session.close();
    await epochStore.cleanup();
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'portable', 'mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
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
      getPrompt: async () => ({ messages: [] }),
      getServerCapabilities: () => undefined,
      getServerVersion: () => undefined,
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      listTools: async () => ({ tools: [] }),
      readResource: async () => ({ contents: [] }),
    };
    const service = new McpSessionService({
      createClient: () => client,
      createStdioTransport: () => ({ close: async () => undefined, send: async () => undefined, start: async () => undefined, stderr: null }) as never,
      epochStore,
      projectRoot: root,
    });

    const opening = service.open({ epochId: 'epoch-1', serverName: 'fixture', target: 'portable' });
    await connectionStartedPromise;
    let closeCompleted = false;
    const closing = service.close().then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);
    allowConnection?.();
    await closing;
    await expect(opening).rejects.toThrow('MCP session service is closed.');
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
    await expect(access(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'portable', 'mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('retains raw protocol frame identities and exposes progress and logging without translating SDK results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-persistent-mcp-raw-'));
  try {
    const epochStore = await publishFixtureEpoch(root, 'epoch-raw');
    const outbound = { id: 1, jsonrpc: '2.0' as const, method: 'initialize', params: {} };
    const progress = {
      jsonrpc: '2.0' as const,
      method: 'notifications/progress',
      params: { progress: 1, progressToken: 'fixture-progress', total: 2 },
    };
    const logging = {
      jsonrpc: '2.0' as const,
      method: 'notifications/message',
      params: { data: { nested: ['exact'] }, level: 'info', logger: 'fixture' },
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
    expect(session.frames()[0]!.message).toBe(outbound);
    expect(session.frames()[1]!.message).toBe(progress);
    expect(session.frames()[2]!.message).toBe(logging);
    expect(session.events()).toEqual([
      { payload: progress.params, sequence: 3, type: 'progress' },
      { payload: logging.params, sequence: 5, type: 'logging' },
    ]);
    await expect(session.callTool({ arguments: {}, name: 'fixture' })).resolves.toBe(result);

    await session.close();
    expect(closed).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
