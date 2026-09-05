import { expect, it } from '@rstest/core';

import { normalizeProject } from '../src/config/normalize.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';
import type { AgentBundleConfig, NormalizationTargetRegistry } from '../src/core/types.ts';
import type { DiscoveredProject } from '../src/config/discover.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { CompiledAgentRoute, CompiledRouteGraph } from '../src/routes/types.ts';

const root = '/workspace/web-config';
const configPath = `${root}/agent-bundle.config.ts`;
const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => name === 'portable',
  supports: () => true,
};

const loaded = (config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath,
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

const route = (
  kind: CompiledAgentRoute['kind'],
  name: string,
  config: Readonly<Record<string, unknown>> = {},
): CompiledAgentRoute => ({
  config,
  id: `mcp:catalog/${kind}s/${name}`,
  kind,
  provenance: { kind: 'conventional', relativePath: `src/mcp/catalog/${kind}s/${name}.ts` },
  serverId: 'mcp:catalog',
  source: `${root}/src/mcp/catalog/${kind}s/${name}.ts`,
});

const appRoute = route('app', 'details', { resourceUri: 'ui://catalog/details' });
const toolRoute = route('tool', 'open-details', {
  _meta: { ui: { resourceUri: 'ui://catalog/details' } },
});

const discovered = (options: {
  cliWeb?: boolean;
  generated?: boolean;
} = {}): DiscoveredProject => {
  const graph: CompiledRouteGraph = {
    ...(options.cliWeb === true
      ? {
          cli: {
            commands: [{
              aliases: [],
              exitCode: 'zero',
              options: [],
              path: ['web'],
              rendered: false,
              routeId: 'cli:web',
            }],
            mode: 'generated',
            routes: [{
              config: {},
              id: 'cli:web',
              kind: 'cli',
              provenance: { kind: 'conventional', relativePath: 'src/cli/web.ts' },
              source: `${root}/src/cli/web.ts`,
            }],
          } as const,
        }
      : {}),
    diagnostics: [],
    digest: 'graph',
    events: [],
    providers: [],
    scripts: [],
    servers: options.generated === false
      ? []
      : [{ id: 'mcp:catalog', mode: 'generated', name: 'catalog', routes: [appRoute, toolRoute] }],
  };
  return { routeGraph: graph, skills: [] };
};

const baseConfig = (web: AgentBundleConfig['web']): AgentBundleConfig => ({
  mcp: {
    servers: {
      catalog: {
        apps: {
          details: {
            entry: './src/mcp/catalog/apps/details.ts',
            resourceUri: 'ui://catalog/details',
          },
        },
      },
    },
  },
  plugin: { name: 'catalog-tools', version: '1.0.0' },
  web,
});

const webDiagnostics = async (
  config: AgentBundleConfig,
  project: DiscoveredProject = discovered(),
) => {
  const source = validateSource(loaded(config), project, registry).filter(({ code }) => code === 'AB4341');
  const model = await normalizeProject(loaded(config), project, registry);
  return { model, diagnostics: [...source, ...validateModel(model, registry).filter(({ code }) => code === 'AB4341')] };
};

it('normalizes shorthand and object Apps, defaults open, and creates the web bin', async () => {
  const { model, diagnostics } = await webDiagnostics(baseConfig({
    apps: [
      'catalog/details',
      {
        allow: ['call-tool'],
        app: 'catalog/details',
        input: { sku: '42' },
        tool: 'open-details',
      },
    ],
  }));

  expect(model.web).toEqual({
    apps: [
      {
        allow: [],
        app: 'catalog/details',
        appName: 'details',
        resourceUri: 'ui://catalog/details',
        serverId: 'mcp:catalog',
        serverName: 'catalog',
      },
      {
        allow: ['call-tool'],
        app: 'catalog/details',
        appName: 'details',
        input: { sku: '42' },
        resourceUri: 'ui://catalog/details',
        serverId: 'mcp:catalog',
        serverName: 'catalog',
        tool: 'open-details',
      },
    ],
    open: 'never',
    provenance: { sourcePath: configPath },
  });
  expect(model.packageBuild?.bins).toEqual([
    expect.objectContaining({
      generatedCli: { commands: [], routes: [] },
      name: 'catalog-tools',
      source: configPath,
      web: true,
    }),
  ]);
  expect(diagnostics.map(({ message }) => message)).toEqual([
    'web.apps[1] names catalog/details twice.',
  ]);
});

it('reports malformed open and allow values with AB4341', async () => {
  const config = baseConfig({
    apps: [{ allow: ['camera'], app: 'catalog/details' }],
    open: 'window',
  } as unknown as NonNullable<AgentBundleConfig['web']>);
  const { diagnostics } = await webDiagnostics(config);
  expect(diagnostics.map(({ message }) => message)).toEqual([
    'web.open must be "browser" or "never".',
    'web.apps[0] allows camera, which is not an App-initiated consent capability.',
  ]);
});

it('reports unknown Apps, duplicate Apps, invalid generated tools, and reserved web commands', async () => {
  const config = baseConfig({
    apps: [
      'catalog/missing',
      'catalog/details',
      { app: 'catalog/details', tool: 'missing-tool' },
    ],
    open: 'browser',
  });
  const { diagnostics } = await webDiagnostics(config, discovered({ cliWeb: true }));
  expect(diagnostics.map(({ message }) => message)).toEqual([
    'web.apps[0] names catalog/missing, which no mcp.servers.<id>.apps entry declares.',
    'web.apps[2] names catalog/details twice.',
    "web.apps[2].tool missing-tool is not a tool this project's route graph declares for catalog.",
    'CLI command "web" is reserved by the web surface (web.apps is configured).',
  ]);
});

it('skips static tool validation for hand-written MCP server factories', async () => {
  const config: AgentBundleConfig = {
    mcp: {
      servers: {
        catalog: {
          apps: {
            details: {
              entry: './src/apps/details.ts',
              resourceUri: 'ui://catalog/details',
            },
          },
          entry: './src/server.ts',
        },
      },
    },
    plugin: { name: 'catalog-tools', version: '1.0.0' },
    web: { apps: [{ app: 'catalog/details', tool: 'runtime-tool' }] },
  };
  const { diagnostics } = await webDiagnostics(config, discovered({ generated: false }));
  expect(diagnostics).toEqual([]);
});
