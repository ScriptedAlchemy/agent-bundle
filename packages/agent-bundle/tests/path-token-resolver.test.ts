import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from './support/build.ts';
import { loadedProject } from './support/loaded-project.ts';

import { normalizeProject } from '../src/config/normalize.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { pathTokens } from '../src/core/types.ts';
import { createMcpPathTokenResolver, resolveMcpPathTokens } from '../src/services/mcp-path-tokens.ts';
import type { TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';
import { McpService } from '../src/services/mcp-service.ts';

interface ResolutionFixture {
  readonly cases: readonly {
    readonly expected: {
      readonly args?: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    };
    readonly server: {
      readonly args?: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    };
    readonly target: string;
  }[];
  readonly roots: {
    readonly pluginData: string;
    readonly pluginRoot: string;
    readonly workspaceRoot: string;
  };
  readonly unsupported: {
    readonly diagnostic: { readonly code: string; readonly message: string };
    readonly server: {
      readonly args?: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    };
    readonly target: string;
  };
}

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/contracts/path-tokens/resolution.json', import.meta.url), 'utf8'),
) as ResolutionFixture;

const runtimeFor = (target: string): TargetMcpRuntimeContract => {
  const runtime = createDefaultRegistry().mcpRuntime(target);
  if (runtime === undefined) throw new Error(`Expected ${target} MCP runtime contract.`);
  return runtime;
};

for (const testCase of fixture.cases) {
  it(`resolves ${testCase.target} capabilities outside command`, () => {
    expect(resolveMcpPathTokens({
      roots: fixture.roots,
      runtime: runtimeFor(testCase.target),
      server: { args: [], ...testCase.server, kind: 'stdio' },
      target: testCase.target,
    })).toEqual({ ...testCase.expected, kind: 'stdio' });
  });
}

it('reports the selected adapter capability diagnostic for an unsupported path token', () => {
  try {
    resolveMcpPathTokens({
      roots: fixture.roots,
      runtime: runtimeFor(fixture.unsupported.target),
      server: { args: [], ...fixture.unsupported.server, kind: 'stdio' },
      target: fixture.unsupported.target,
    });
    throw new Error('expected unsupported path token to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toEqual([
      {
        ...fixture.unsupported.diagnostic,
        severity: 'error',
        target: fixture.unsupported.target,
      },
    ]);
  }
});

it('resolves URL and headers through the same target runtime contract', () => {
  const roots = {
    pluginData: '/session/data',
    pluginRoot: '/artifact/synthetic',
    workspaceRoot: '/workspace',
  };
  const runtime: TargetMcpRuntimeContract = {
    manifestPath: 'native/servers.json',
    readModernServers: () => ({ servers: [], status: 'found' }),
    resolveStdioArgument: (value) => value,
    resolveValue: (field, valueRoots, value) => ({
      diagnostics: [],
      value: value
        .replaceAll('$ROOT', valueRoots.pluginRoot)
        .replaceAll('$DATA', valueRoots.pluginData)
        .replaceAll('$WORKSPACE', valueRoots.workspaceRoot)
        .replaceAll('$FIELD', field),
    }),
  };

  expect(resolveMcpPathTokens({
    roots,
    runtime,
    server: {
      headers: { Authorization: 'Bearer $DATA', 'X-Root': '$ROOT' },
      kind: 'streamable-http',
      url: 'https://mcp.example.test/$FIELD/$WORKSPACE',
    },
    target: 'synthetic',
  })).toEqual({
    headers: {
      Authorization: 'Bearer /session/data',
      'X-Root': '/artifact/synthetic',
    },
    kind: 'streamable-http',
    url: 'https://mcp.example.test/url//workspace',
  });
});

it('rejects unsupported URL tokens after resolving every remote value', () => {
  const roots = {
    pluginData: '/session/data',
    pluginRoot: '/artifact/synthetic',
    workspaceRoot: '/workspace',
  };
  const runtime: TargetMcpRuntimeContract = {
    manifestPath: 'native/servers.json',
    readModernServers: () => ({ servers: [], status: 'found' }),
    resolveStdioArgument: (value) => value,
    resolveValue: createMcpPathTokenResolver({
      target: 'synthetic',
      tokens: { headers: { '$DATA': 'pluginData' } },
    }),
  };

  expect(() => resolveMcpPathTokens({
    roots,
    runtime,
    server: {
      kind: 'streamable-http',
      url: 'https://mcp.example.test/$DATA',
    },
    target: 'synthetic',
  })).toThrow('MCP url cannot resolve "$DATA" for selected synthetic adapter.');
});

it('returns a stable target and field diagnostic when a target value resolver is invalid', () => {
  const runtime: TargetMcpRuntimeContract = {
    manifestPath: 'native/servers.json',
    readModernServers: () => ({ servers: [], status: 'found' }),
    resolveStdioArgument: (value) => value,
    resolveValue: () => null as never,
  };

  try {
    resolveMcpPathTokens({
      roots: { pluginData: '/data', pluginRoot: '/plugin', workspaceRoot: '/workspace' },
      runtime,
      server: { args: ['--fixture'], command: 'runner', kind: 'stdio' },
      target: 'synthetic',
    });
    throw new Error('expected invalid resolver result to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toEqual([{
      code: 'mcp.runtime.resolve-value.args',
      message: 'MCP target "synthetic" returned an invalid args value resolver result.',
      severity: 'error',
      target: 'synthetic',
    }]);
  }
});

it('does not run stdio argument policy when token diagnostics already exist', () => {
  let stdioArgumentCalls = 0;
  const runtime: TargetMcpRuntimeContract = {
    manifestPath: 'native/servers.json',
    readModernServers: () => ({ servers: [], status: 'found' }),
    resolveStdioArgument: (value) => {
      stdioArgumentCalls += 1;
      return value;
    },
    resolveValue: createMcpPathTokenResolver({
      knownTokens: ['$UNSUPPORTED'],
      target: 'synthetic',
      tokens: {},
    }),
  };

  expect(() => resolveMcpPathTokens({
    roots: { pluginData: '/data', pluginRoot: '/plugin', workspaceRoot: '/workspace' },
    runtime,
    server: { args: ['$UNSUPPORTED'], command: 'runner', kind: 'stdio' },
    target: 'synthetic',
  })).toThrow('MCP args cannot resolve "$UNSUPPORTED" for selected synthetic adapter.');
  expect(stdioArgumentCalls).toBe(0);
});

it('returns a stable target and field diagnostic when a stdio argument policy is invalid', () => {
  const runtime: TargetMcpRuntimeContract = {
    manifestPath: 'native/servers.json',
    readModernServers: () => ({ servers: [], status: 'found' }),
    resolveStdioArgument: () => undefined as never,
    resolveValue: (_field, _roots, value) => ({ diagnostics: [], value }),
  };

  try {
    resolveMcpPathTokens({
      roots: { pluginData: '/data', pluginRoot: '/plugin', workspaceRoot: '/workspace' },
      runtime,
      server: { args: ['--fixture'], command: 'runner', kind: 'stdio' },
      target: 'synthetic',
    });
    throw new Error('expected invalid stdio policy result to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toEqual([{
      code: 'mcp.runtime.resolve-stdio-argument.args',
      message: 'MCP target "synthetic" returned an invalid stdio argument resolver result for args.',
      severity: 'error',
      target: 'synthetic',
    }]);
  }
});

it('resolves Claude path tokens outside command when launching a generated artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-path-tokens-'));
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            fixture: {
              args: [`${pathTokens.workspaceRoot}/tool`],
              command: `${pathTokens.pluginRoot}/bin/unchanged`,
              cwd: pathTokens.pluginData,
              env: {
                ROOT: pathTokens.pluginRoot,
                WORKSPACE: pathTokens.workspaceRoot,
              },
            },
          },
        },
        plugin: { name: 'path-token-fixture', version: '1.0.0' },
        targets: ['claude'],
      }),
      { skills: [] },
      createDefaultRegistry(),
    );
    const artifact = join(root, 'dist');
    await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

    const stdio: Array<{
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }> = [];
    const service = new McpService({
      createClient: () => ({
        callTool: async () => ({ content: [] }) as never,
        close: async () => undefined,
        connect: async () => undefined,
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listTools: async () => ({ tools: [] }),
      }),
      createStdioTransport: (options) => {
        stdio.push(options);
        return { close: async () => undefined, stderr: null } as never;
      },
    });

    await service.list({
      artifact,
      server: 'fixture',
      target: 'claude',
      workspaceRoot: fixture.roots.workspaceRoot,
    });

    expect(stdio).toHaveLength(1);
    expect(stdio[0]).toMatchObject({
      args: [`${fixture.roots.workspaceRoot}/tool`],
      command: '${CLAUDE_PLUGIN_ROOT}/bin/unchanged',
      cwd: expect.any(String),
      env: {
        ROOT: expect.any(String),
        WORKSPACE: fixture.roots.workspaceRoot,
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
