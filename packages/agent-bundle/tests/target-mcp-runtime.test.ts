import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import type { TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';
import { resolveTargetRelativeStdioArgument } from '../src/services/mcp-runtime.ts';
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

const runtime: TargetMcpRuntimeContract = {
  manifestPath: 'native/registry.json',
  readModernServer: (document, name) => {
    const servers = document !== null && typeof document === 'object'
      ? (document as { readonly nativeServers?: Record<string, unknown> }).nativeServers
      : undefined;
    const server = servers?.[name];
    if (server === undefined || server === null || typeof server !== 'object') return undefined;
    const native = server as Record<string, unknown>;
    if (native.kind === 'native-stdio' && typeof native.exec === 'string') {
      return {
        args: Array.isArray(native.argv) && native.argv.every((value) => typeof value === 'string')
          ? native.argv
          : [],
        command: native.exec,
        cwd: typeof native.directory === 'string' ? native.directory : undefined,
        env: native.environment !== null && typeof native.environment === 'object'
          ? native.environment as Record<string, string>
          : undefined,
        kind: 'stdio',
      };
    }
    if (native.kind === 'native-http' && typeof native.endpoint === 'string') {
      return {
        headers: native.requestHeaders !== null && typeof native.requestHeaders === 'object'
          ? native.requestHeaders as Record<string, string>
          : undefined,
        kind: 'streamable-http',
        url: native.endpoint,
      };
    }
    return undefined;
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

it('delegates one-shot stdio and HTTP MCP operations to an injected target runtime', async () => {
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
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
