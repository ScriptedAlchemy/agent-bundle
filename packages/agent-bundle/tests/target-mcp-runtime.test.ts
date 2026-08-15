import { access, cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { McpSessionService } from '../src/dev/mcp-session-service.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import type { TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';
import {
  createTargetMcpRuntime,
  readTargetMcpServer,
  resolveTargetRelativeStdioArgument,
} from '../src/services/mcp-runtime.ts';
import { createMcpPathTokenResolver } from '../src/services/mcp-path-tokens.ts';
import { McpService } from '../src/services/mcp-service.ts';
import { build } from './support/build.ts';

const metadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
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
  readModernServer: (document, name) => {
    const servers = document !== null && typeof document === 'object'
      ? (document as { readonly nativeServers?: Record<string, unknown> }).nativeServers
      : undefined;
    const server = servers?.[name];
    if (server === undefined || server === null || typeof server !== 'object') return { status: 'missing' };
    const native = server as Record<string, unknown>;
    if (native.kind === 'native-stdio' && typeof native.exec === 'string') {
      return {
        server: {
          args: Array.isArray(native.argv) && native.argv.every((value) => typeof value === 'string')
            ? native.argv
            : [],
          command: native.exec,
          cwd: typeof native.directory === 'string' ? native.directory : undefined,
          env: native.environment !== null && typeof native.environment === 'object'
            ? native.environment as Record<string, string>
            : undefined,
          kind: 'stdio',
        },
        status: 'found',
      };
    }
    if (native.kind === 'native-http' && typeof native.endpoint === 'string') {
      return {
        server: {
          headers: native.requestHeaders !== null && typeof native.requestHeaders === 'object'
            ? native.requestHeaders as Record<string, string>
            : undefined,
          kind: 'streamable-http',
          url: native.endpoint,
        },
        status: 'found',
      };
    }
    return { status: 'missing' };
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
  const malformed = { ...runtime, readModernServer: () => null as never };
  const throwing = { ...runtime, readModernServer: () => { throw new Error('reader failure'); } };

  expect(readTargetMcpServer(malformed, { nativeServers: {} }, 'fixture')).toEqual({ status: 'invalid' });
  expect(readTargetMcpServer(throwing, { nativeServers: {} }, 'fixture')).toEqual({ status: 'invalid' });
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
    validateModel: () => [],
  });
  const adapter = (name: string): TargetAdapter => ({
    capabilities: { mcp: true },
    metadata,
    name,
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
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
    capabilities: { mcp: true },
    mcpRuntime: runtime,
    metadata,
    name: 'synthetic-mcp',
    plan: () => ({
      diagnostics: [],
      entries: [{
        content: `${JSON.stringify({
          nativeServers: {
            http: {
              endpoint: 'https://mcp.example.test/$SYNTHETIC_ROOT',
              kind: 'native-http',
              requestHeaders: { Authorization: 'Bearer $SYNTHETIC_DATA' },
            },
            stdio: {
              argv: ['./runtime/server.mjs', '$SYNTHETIC_ROOT/bin'],
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
      }],
    }),
    validateModel: () => [],
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
      args: [join(artifact, 'synthetic-mcp', 'runtime', 'server.mjs'), join(artifact, 'synthetic-mcp', 'bin')],
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
        join(root, '.agent-bundle', 'epochs', 'synthetic-epoch', 'synthetic-mcp', 'runtime', 'server.mjs'),
        join(root, '.agent-bundle', 'epochs', 'synthetic-epoch', 'synthetic-mcp', 'bin'),
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
