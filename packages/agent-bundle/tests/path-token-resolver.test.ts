import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { pathTokens, type AgentBundleConfig } from '../src/core/types.ts';
import { resolveMcpPathTokens } from '../src/services/mcp-path-tokens.ts';
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

for (const testCase of fixture.cases) {
  it(`resolves ${testCase.target} capabilities outside command`, () => {
    expect(resolveMcpPathTokens({
      adapter: createDefaultRegistry().get(testCase.target),
      roots: fixture.roots,
      server: { args: [], ...testCase.server },
    })).toEqual(testCase.expected);
  });
}

it('reports the selected adapter capability diagnostic for an unsupported path token', () => {
  try {
    resolveMcpPathTokens({
      adapter: createDefaultRegistry().get(fixture.unsupported.target),
      roots: fixture.roots,
      server: { args: [], ...fixture.unsupported.server },
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

it('resolves Claude path tokens outside command when launching a generated artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-path-tokens-'));
  try {
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
