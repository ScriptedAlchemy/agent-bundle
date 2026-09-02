import { supportedCapabilities } from './support/adapter-capabilities.ts';
import { access, cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { McpSessionService } from '../src/dev/mcp-session/mcp-session-service.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import type { TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';
import {
  createTargetMcpRuntime,
  readTargetMcpServers,
  readTargetMcpServer,
  resolveTargetRelativeStdioArgument,
} from '../src/services/mcp-runtime.ts';
import { createMcpPathTokenResolver, resolveMcpPathTokens } from '../src/services/mcp-path-tokens.ts';
import { McpService } from '../src/services/mcp-service.ts';
import { build } from './support/build.ts';

const metadata = Object.freeze({
  adapterRevision: 'test',
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

const model = (source: string): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    id: 'plugin:synthetic-mcp',
    name: 'synthetic-mcp',
    provenance: { kind: 'config', sourcePath: source },
    version: '1.0.0',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: 'target:synthetic-mcp',
    name: 'synthetic-mcp',
    provenance: { kind: 'config', sourcePath: source },
  }],
});

const epoch = (root: string): ArtifactEpoch => ({
  configDigest: 'synthetic-config',
  createdAt: '2026-08-15T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id: 'synthetic-epoch',
  manifestPath: join(root, '.agent-bundle', 'epochs', 'synthetic-epoch', 'agent-bundle.manifest.json'),
  modelDigest: 'synthetic-model',
  projectRevision: 'synthetic-revision',
  targetDigests: { 'synthetic-mcp': 'synthetic-target' },
});

const runtime: TargetMcpRuntimeContract = {
  manifestPath: 'native/registry.json',
  readModernServers: (document) => {
    const servers = document !== null && typeof document === 'object'
      ? (document as { readonly nativeServers?: Record<string, unknown> }).nativeServers
      : undefined;
    if (servers === undefined) return { status: 'invalid' };
    const entries = Object.entries(servers).map(([name, server]) => {
      if (server === null || typeof server !== 'object') return undefined;
      const native = server as Record<string, unknown>;
      if (native.kind === 'native-stdio' && typeof native.exec === 'string') {
        return {
          name,
          server: {
            args: Array.isArray(native.argv) && native.argv.every((value) => typeof value === 'string')
              ? native.argv
              : [],
            command: native.exec,
            cwd: typeof native.directory === 'string' ? native.directory : undefined,
            env: native.environment !== null && typeof native.environment === 'object'
              ? native.environment as Record<string, string>
              : undefined,
            kind: 'stdio' as const,
          },
        };
      }
      if (native.kind === 'native-http' && typeof native.endpoint === 'string') {
        return {
          name,
          server: {
            headers: native.requestHeaders !== null && typeof native.requestHeaders === 'object'
              ? native.requestHeaders as Record<string, string>
              : undefined,
            kind: 'streamable-http' as const,
            url: native.endpoint,
          },
        };
      }
      return undefined;
    });
    return entries.some((entry) => entry === undefined)
      ? { status: 'invalid' as const }
      : { servers: entries as Exclude<typeof entries[number], undefined>[], status: 'found' as const };
  },
  resolveStdioArgument: resolveTargetRelativeStdioArgument,
  resolveValue: createMcpPathTokenResolver({
    target: 'synthetic-mcp',
    tokens: {
      args: { '$SYNTHETIC_ROOT': 'pluginRoot' },
      cwd: { '$SYNTHETIC_ROOT': 'pluginRoot' },
      env: { '$SYNTHETIC_DATA': 'pluginData' },
      headers: { '$SYNTHETIC_DATA': 'pluginData' },
      url: { '$SYNTHETIC_ROOT': 'pluginRoot' },
    },
  }),
};

it('converts malformed or throwing target reader callbacks into invalid results', () => {
  const malformed = { ...runtime, readModernServers: () => null as never };
  const throwing = { ...runtime, readModernServers: () => { throw new Error('reader failure'); } };

  expect(readTargetMcpServer(malformed, { nativeServers: {} }, 'fixture')).toEqual({ status: 'invalid' });
  expect(readTargetMcpServer(throwing, { nativeServers: {} }, 'fixture')).toEqual({ status: 'invalid' });
});

it.each([
  ['an argument array with a symbol property', () => {
    const args = ['--config'];
    Object.defineProperty(args, Symbol('extra'), { value: true });
    return { servers: [{ name: 'fixture', server: { args, command: 'node', kind: 'stdio' } }], status: 'found' };
  }],
  ['a server array with an extra property', () => {
    const servers = [{ name: 'fixture', server: { args: [], command: 'node', kind: 'stdio' } }];
    Object.defineProperty(servers, 'extra', { value: true });
    return { servers, status: 'found' };
  }],
  ['a named server record with an extra property', () => ({
    servers: [{ extra: true, name: 'fixture', server: { args: [], command: 'node', kind: 'stdio' } }],
    status: 'found',
  })],
  ['an Array subclass', () => {
    class ServerEntries extends Array<unknown> {}
    return {
      servers: new ServerEntries({ name: 'fixture', server: { args: [], command: 'node', kind: 'stdio' } }),
      status: 'found',
    };
  }],
])('rejects %s from custom MCP readers', (_name, result) => {
  const custom = { ...runtime, readModernServers: () => result() as never };
  expect(readTargetMcpServers(custom, {})).toEqual({ status: 'invalid' });
});

it('reads and freezes every modern server before delegating per-name lookups', () => {
  const parser = createTargetMcpRuntime({
    manifestPath: 'native/registry.json',
    remoteTypes: ['native-http'],
    resolveValue: (_field, _roots, value) => ({ diagnostics: [], value }),
  });
  const document = {
    mcpServers: {
      http: { headers: { Authorization: 'Bearer token' }, type: 'native-http', url: 'https://mcp.example.test' },
      stdio: { args: ['mcp/server.mjs'], command: 'node', type: 'stdio' },
    },
  };

  const all = readTargetMcpServers(parser, document);
  expect(all.status).toBe('found');
  if (all.status !== 'found') throw new Error('Expected modern servers.');
  expect(Object.isFrozen(all)).toBe(true);
  expect(Object.isFrozen(all.servers)).toBe(true);
  expect(all.servers).toEqual([
    { name: 'http', server: { headers: { Authorization: 'Bearer token' }, kind: 'streamable-http', url: 'https://mcp.example.test' } },
    { name: 'stdio', server: { args: ['mcp/server.mjs'], command: 'node', kind: 'stdio' } },
  ]);
  expect(readTargetMcpServer(parser, document, 'stdio')).toEqual({
    server: { args: ['mcp/server.mjs'], command: 'node', kind: 'stdio' },
    status: 'found',
  });
});

it('omits validated legacy remote servers while retaining modern MCP servers', () => {
  const parser = createTargetMcpRuntime({
    manifestPath: 'native/registry.json',
    remoteTypes: ['native-http'],
    validatedButNonModernRemoteTypes: ['sse'],
    resolveValue: (_field, _roots, value) => ({ diagnostics: [], value }),
  });
  const document = {
    mcpServers: {
      legacy: { headers: { Authorization: 'Bearer token' }, type: 'sse', url: 'https://mcp.example.test/events' },
      modern: { type: 'native-http', url: 'https://mcp.example.test' },
      stdio: { args: ['mcp/server.mjs'], command: 'node', type: 'stdio' },
    },
  };

  expect(readTargetMcpServers(parser, document)).toEqual({
    servers: [
      { name: 'modern', server: { kind: 'streamable-http', url: 'https://mcp.example.test' } },
      { name: 'stdio', server: { args: ['mcp/server.mjs'], command: 'node', kind: 'stdio' } },
    ],
    status: 'found',
  });
  expect(readTargetMcpServer(parser, document, 'legacy')).toEqual({ status: 'missing' });
  expect(readTargetMcpServers(parser, {
    mcpServers: { legacy: { type: 'sse', url: 42 } },
  })).toEqual({ status: 'invalid' });
});

it('detaches and freezes reader servers before delayed mutation can change a launch', async () => {
  const args = ['--original'];
  const sharedFields = Object.create(null) as Record<string, string>;
  Object.defineProperty(sharedFields, '__proto__', { enumerable: true, value: 'safe-field' });
  sharedFields.Authorization = 'Bearer original';
  sharedFields.SESSION = 'original-session';
  const stdioServer = { args, command: 'runner', env: sharedFields, kind: 'stdio' as const };
  const httpServer = { headers: sharedFields, kind: 'streamable-http' as const, url: 'https://mcp.example.test/original' };
  const mutatingRuntime: TargetMcpRuntimeContract = {
    manifestPath: 'native/registry.json',
    readModernServers: () => ({
      servers: [
        { name: 'http', server: httpServer },
        { name: 'stdio', server: stdioServer },
      ],
      status: 'found',
    }),
    resolveStdioArgument: (value) => value,
    resolveValue: (_field, _roots, value) => ({ diagnostics: [], value }),
  };

  const stdio = readTargetMcpServer(mutatingRuntime, {}, 'stdio');
  const http = readTargetMcpServer(mutatingRuntime, {}, 'http');
  if (stdio.status !== 'found' || http.status !== 'found') throw new Error('Expected valid reader servers.');
  if (stdio.server.kind !== 'stdio' || http.server.kind !== 'streamable-http') {
    throw new Error('Expected matching stdio and streamable HTTP servers.');
  }
  if (stdio.server.env === undefined || http.server.headers === undefined) {
    throw new Error('Expected stdio environment and remote headers.');
  }
  queueMicrotask(() => {
    args[0] = '--mutated';
    sharedFields.Authorization = 'Bearer mutated';
    sharedFields.SESSION = 'mutated-session';
    httpServer.url = 'https://mcp.example.test/mutated';
  });
  await Promise.resolve();

  expect(Object.isFrozen(stdio)).toBe(true);
  expect(Object.isFrozen(stdio.server)).toBe(true);
  expect(Object.isFrozen(stdio.server.args)).toBe(true);
  expect(Object.isFrozen(stdio.server.env)).toBe(true);
  expect(Object.isFrozen(http)).toBe(true);
  expect(Object.isFrozen(http.server)).toBe(true);
  expect(Object.isFrozen(http.server.headers)).toBe(true);
  expect(Object.getPrototypeOf(stdio.server.env)).toBeNull();
  expect(Object.getPrototypeOf(http.server.headers)).toBeNull();
  expect(Object.hasOwn(stdio.server.env, '__proto__')).toBe(true);
  expect(Object.hasOwn(http.server.headers, '__proto__')).toBe(true);
  expect(stdio.server).toMatchObject({ args: ['--original'], env: { SESSION: 'original-session' } });
  expect(http.server).toMatchObject({
    headers: { Authorization: 'Bearer original' },
    url: 'https://mcp.example.test/original',
  });

  const roots = { pluginData: '/data', pluginRoot: '/plugin', workspaceRoot: '/workspace' };
  expect(resolveMcpPathTokens({ roots, runtime: mutatingRuntime, server: stdio.server, target: 'synthetic' })).toMatchObject({
    args: ['--original'],
    env: { SESSION: 'original-session' },
  });
  expect(resolveMcpPathTokens({ roots, runtime: mutatingRuntime, server: http.server, target: 'synthetic' })).toMatchObject({
    headers: { Authorization: 'Bearer original' },
    url: 'https://mcp.example.test/original',
  });
});

it('distinguishes a missing server from an invalid modern manifest server', () => {
  const parser = createTargetMcpRuntime({
    manifestPath: 'native/registry.json',
    remoteTypes: ['native-http'],
    resolveValue: (field, roots, value) => ({ diagnostics: [], value }),
  });

  expect(readTargetMcpServer(parser, { mcpServers: {} }, 'fixture')).toEqual({ status: 'missing' });
  expect(readTargetMcpServer(parser, { mcpServers: { fixture: { type: 'stdio' } } }, 'fixture')).toEqual({ status: 'invalid' });
  expect(readTargetMcpServer(parser, { nativeServers: {} }, 'fixture')).toEqual({ status: 'invalid' });
});

it('rejects contradictory MCP capability and runtime registrations atomically', () => {
  const registry = new TargetRegistry().register({
    capabilities: {},
    metadata,
    name: 'existing',
    plan: () => ({ diagnostics: [], entries: [] }),
  });
  const adapter = (name: string): TargetAdapter => ({
    capabilities: supportedCapabilities('mcp'),
    metadata,
    name,
    plan: () => ({ diagnostics: [], entries: [] }),
  });

  expect(() => registry.register(adapter('missing-runtime'))).toThrow('mcp capability without an MCP runtime contract');
  expect(registry.names()).toEqual(['existing']);
  expect(() => registry.register({
    ...adapter('unsupported-runtime'),
    capabilities: {},
    mcpRuntime: runtime,
  })).toThrow('MCP runtime contract without mcp capability');
  expect(registry.names()).toEqual(['existing']);
});

it('delegates one-shot and persistent MCP operations to an injected target runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-target-mcp-runtime-'));
  const artifact = join(root, 'dist');
  const configPath = join(root, 'agent-bundle.config.ts');
  const stdio: Array<{ readonly args: readonly string[]; readonly command: string; readonly cwd?: string; readonly env: Record<string, string> }> = [];
  const http: Array<{ readonly headers?: Record<string, string>; readonly url: string }> = [];
  const calls: string[] = [];
  const adapter: TargetAdapter = {
    artifactLayout: { scripts: { allowedSuffixes: ['.mjs'], directory: 'scripts' } },
    capabilities: supportedCapabilities('mcp'),
    mcpRuntime: runtime,
    metadata,
    name: 'synthetic-mcp',
    plan: () => ({
      diagnostics: [],
      entries: [
        {
          content: `${JSON.stringify({
            nativeServers: {
              http: {
                endpoint: 'https://mcp.example.test/$SYNTHETIC_ROOT',
                kind: 'native-http',
                requestHeaders: { Authorization: 'Bearer $SYNTHETIC_DATA' },
              },
              stdio: {
                argv: ['./scripts/server.mjs', '$SYNTHETIC_ROOT/scripts/resource.mjs'],
                directory: '$SYNTHETIC_ROOT',
                environment: { SESSION: '$SYNTHETIC_DATA' },
                exec: 'runner-$SYNTHETIC_ROOT',
                kind: 'native-stdio',
              },
            },
          })}\n`,
          kind: 'write',
          relativePath: runtime.manifestPath,
          sourceInputs: [configPath],
        },
        { content: 'export {};\n', kind: 'write', relativePath: 'scripts/server.mjs', sourceInputs: [configPath] },
        { content: 'export {};\n', kind: 'write', relativePath: 'scripts/resource.mjs', sourceInputs: [configPath] },
      ],
    }),
  };
  const registry = new TargetRegistry().register(adapter, { default: true });

  try {
    await mkdir(root, { recursive: true });
    await writeFile(configPath, 'export default {};\n');
    await build({ model: model(configPath), outputRoot: artifact, projectRoot: root, registry });

    const service = new McpService({
      createClient: () => ({
        callTool: async ({ name }) => {
          calls.push(name);
          return { content: [] } as never;
        },
        close: async () => undefined,
        connect: async () => undefined,
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listTools: async () => {
          calls.push('list');
          return { tools: [] };
        },
      }),
      createStdioTransport: (options) => {
        stdio.push(options);
        return { close: async () => undefined, stderr: null } as never;
      },
      createStreamableHttpTransport: (url, options) => {
        http.push({ ...options, url: url.href });
        return {} as never;
      },
      registry,
    });

    await service.list({ artifact, server: 'stdio', target: 'synthetic-mcp' });
    await service.invoke({ artifact, input: {}, server: 'http', target: 'synthetic-mcp', tool: 'native-tool' });

    expect(calls).toEqual(['list', 'native-tool']);
    expect(stdio).toHaveLength(1);
    expect(stdio[0]).toMatchObject({
      args: [
        join(artifact, 'synthetic-mcp', 'scripts', 'server.mjs'),
        join(artifact, 'synthetic-mcp', 'scripts', 'resource.mjs'),
      ],
      command: 'runner-$SYNTHETIC_ROOT',
      cwd: join(artifact, 'synthetic-mcp'),
      env: { SESSION: expect.any(String) },
    });
    expect(http).toEqual([{
      headers: { Authorization: expect.stringMatching(/^Bearer \/.+/) },
      url: `https://mcp.example.test/${artifact}/synthetic-mcp`,
    }]);
    await expect(access(stdio[0]!.env.SESSION!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(http[0]!.headers!.Authorization.slice('Bearer '.length))).rejects.toMatchObject({ code: 'ENOENT' });

    const epochStore = new EpochStore({ projectRoot: root });
    const staging = await epochStore.createStagingEpoch({ epoch: epoch(root), targets: ['synthetic-mcp'] });
    await Promise.all([
      cp(join(artifact, 'agent-bundle.hooks.json'), join(staging.root, 'agent-bundle.hooks.json')),
      cp(join(artifact, 'agent-bundle.manifest.json'), join(staging.root, 'agent-bundle.manifest.json')),
      cp(join(artifact, 'synthetic-mcp'), join(staging.root, 'synthetic-mcp'), { recursive: true }),
    ]);
    await staging.publish(async () => undefined);

    const persistentStdio: Array<{
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly env: Readonly<Record<string, string>>;
    }> = [];
    const persistent = new McpSessionService({
      createClient: () => ({
        callTool: async () => ({ content: [] }) as never,
        close: async () => undefined,
        connect: async () => undefined,
        getPrompt: async () => ({ messages: [] }),
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listTools: async () => ({ tools: [] }),
        readResource: async () => ({ contents: [] }),
      }),
      createStdioTransport: (options) => {
        persistentStdio.push(options);
        return { close: async () => undefined, send: async () => undefined, start: async () => undefined, stderr: null } as never;
      },
      epochStore,
      projectRoot: root,
      registry,
    });
    const session = await persistent.open({
      epochId: 'synthetic-epoch',
      serverName: 'stdio',
      target: 'synthetic-mcp',
    });
    expect(persistentStdio).toHaveLength(1);
    expect(persistentStdio[0]).toMatchObject({
      args: [
        join(root, '.agent-bundle', 'epochs', 'synthetic-epoch', 'synthetic-mcp', 'scripts', 'server.mjs'),
        join(root, '.agent-bundle', 'epochs', 'synthetic-epoch', 'synthetic-mcp', 'scripts', 'resource.mjs'),
      ],
      command: stdio[0]!.command,
      cwd: join(root, '.agent-bundle', 'epochs', 'synthetic-epoch', 'synthetic-mcp'),
      env: { SESSION: expect.any(String) },
    });
    await Promise.all([session.close(), persistent.close()]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
