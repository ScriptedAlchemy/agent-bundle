import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from './support/build.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { pathTokens, type AgentBundleConfig } from '../src/core/types.ts';
import { createMcpPathTokenResolver, resolveMcpPathTokens } from '../src/services/mcp-path-tokens.ts';
import type { TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';
import { McpService } from '../src/services/mcp-service.ts';

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
    })).toEqual({ ...testCase.expected, kind: 'stdio' });
  });
}

it('reports the selected adapter capability diagnostic for an unsupported path token', () => {
  try {
    resolveMcpPathTokens({
      roots: fixture.roots,
      runtime: runtimeFor(fixture.unsupported.target),
      server: { args: [], ...fixture.unsupported.server, kind: 'stdio' },
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
    readModernServer: () => undefined,
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
    readModernServer: () => undefined,
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
  })).toThrow('MCP url cannot resolve "$DATA" for selected synthetic adapter.');
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
