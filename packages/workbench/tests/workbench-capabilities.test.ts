import { expect, it } from '@rstest/core';

import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import { applicationTreeSourcesFor, loadWorkbenchCapabilities } from '../src/workbench-capabilities.ts';

const digest = '0'.repeat(64);
const file = (path: string) => ({
  bytes: 1,
  kind: 'generated' as const,
  path,
  sha256: digest,
  sourceInputs: [],
});

const inspection = ({ hooks = 0, mcpServers = 0, scripts = 0, targets = 1 } = {}): ArtifactInspection => ({
  application: {
    distribution: { channels: ['local'] },
    events: Array.from({ length: hooks }, (_, index) => ({
      event: 'sessionStart',
      hooks: [{ host: 'claude', kind: 'event-route' as const, path: `hooks/hook-${String(index)}.mjs` }],
      id: `event:${String(index)}`,
    })),
    hooks: [],
    hosts: Array.from({ length: targets }, (_, index) => ({
      builtIn: true,
      documents: [],
      host: `target-${String(index)}`,
    })),
    identity: { id: 'application:fixture', name: 'fixture', version: '1.2.3' },
    scripts: Array.from({ length: scripts }, (_, index) => ({
      hosts: ['portable'],
      id: `script:${String(index)}`,
      mode: 'bundle' as const,
      name: `script-${String(index)}`,
      path: `scripts/script-${String(index)}.mjs`,
    })),
    servers: Array.from({ length: mcpServers }, (_, index) => ({
      apps: [],
      entry: `mcp/server-${String(index)}.mjs`,
      hosts: ['portable'],
      id: `mcp:server-${String(index)}`,
      kind: 'compiled' as const,
      name: `server-${String(index)}`,
      prompts: [],
      resources: [],
      tools: [],
      transport: 'stdio',
    })),
  },
  epochId: 'build-a',
  files: [],
  project: {
    configDigest: digest,
    configPath: 'agent-bundle.config.ts',
    modelDigest: digest,
    revision: digest,
    sourceInputs: [],
  },
  projections: Array.from({ length: targets }, (_, index) => ({
    documents: {},
    host: `target-${String(index)}`,
    tree: { children: [], kind: 'directory' as const, name: `target-${String(index)}`, path: `target-${String(index)}` },
  })),
  provenance: [],
  runtime: {
    bins: [],
    executables: [],
    hooks: Array.from({ length: hooks }, (_, index) => ({
      event: 'sessionStart',
      file: file(`hooks/hook-${String(index)}.mjs`),
      id: `hook:${String(index)}`,
      kind: 'event-route',
      name: `hook-${String(index)}`,
      path: `hooks/hook-${String(index)}.mjs`,
      target: 'claude',
    })),
    mcpServers: Array.from({ length: mcpServers }, (_, index) => ({
      apps: [],
      entryPaths: [`mcp/server-${String(index)}.mjs`],
      kind: 'compiled' as const,
      manifestPath: `mcp/server-${String(index)}.json`,
      name: `server-${String(index)}`,
      target: 'portable',
    })),
    scripts: Array.from({ length: scripts }, (_, index) => ({
      file: file(`scripts/script-${String(index)}.mjs`),
      id: `script:${String(index)}`,
      mode: 'bundle' as const,
      name: `script-${String(index)}`,
      target: 'portable',
    })),
  },
});

const skill = {
  base: { kind: 'source' as const, skillId: 'skill:review' },
  body: '# Review',
  diagnostics: [],
  frontmatter: { description: 'Review changes', name: 'review' },
  id: 'skill:review',
  markdown: '---\nname: review\ndescription: Review changes\n---\n# Review',
  name: 'review',
  resources: [],
  targets: ['portable'],
};

const route = (id: string, kind: RouteManifest['events'][number]['kind'], relativePath: string) => ({
  config: [],
  id,
  kind,
  provenance: { kind: 'conventional' as const },
  source: relativePath,
});

const manifest = ({
  cliRoutes = 0,
  events = 0,
  routeScripts = 0,
  servers = 0,
  sourceRevision = digest,
} = {}): RouteManifest => ({
  ...(cliRoutes === 0 ? {} : {
    cli: {
      mode: 'generated' as const,
      routes: Array.from({ length: cliRoutes }, (_, index) =>
        route(`cli:command-${String(index)}`, 'cli', `src/cli/command-${String(index)}.ts`)),
    },
  }),
  diagnostics: [],
  digest,
  events: Array.from({ length: events }, (_, index) => ({
    ...route(`event:after-tool-${String(index)}`, 'event-route', `src/events/tool/after-${String(index)}.ts`),
    event: 'afterTool',
  })),
  providers: [],
  scripts: Array.from({ length: routeScripts }, (_, index) =>
    route(`script:task-${String(index)}`, 'script', `src/scripts/task-${String(index)}.ts`)),
  servers: Array.from({ length: servers }, (_, index) => ({
    id: `mcp:server-${String(index)}`,
    mode: 'generated' as const,
    name: `server-${String(index)}`,
    routes: [route(`tool:server-${String(index)}/echo`, 'tool', `src/mcp/server-${String(index)}/tools/echo.ts`)],
  })),
  sourceRevision,
});

const clientsFor = ({
  cliRoutes = 0,
  evalSuites = 0,
  events = 0,
  hooks = 0,
  mcpServers = 0,
  routeManifest = undefined as RouteManifest | undefined,
  routeScripts = 0,
  routeServers = 0,
  scripts = 0,
  skills = 0,
  targets = 1,
} = {}) => ({
  artifactClient: { inspect: async () => inspection({ hooks, mcpServers, scripts, targets }) },
  routeManifestClient: {
    manifest: async () => routeManifest ?? manifest({ cliRoutes, events, routeScripts, servers: routeServers }),
  },
  evalClient: {
    suites: async () => ({
      diagnostics: [],
      suites: Array.from({ length: evalSuites }, (_, index) => ({
        cases: [],
        digest,
        name: `suite-${String(index)}`,
        sourcePath: `evals/suite-${String(index)}.eval.ts`,
      })),
    }),
  },
  skillClient: {
    sourceTree: async () => ({ diagnostics: [], skills: Array.from({ length: skills }, () => skill) }),
  },
});

it('derives the Skills Starter features from its validated catalogs', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, skills: 1, targets: 3 }),
  });

  expect(capabilities.features).toEqual({ evals: true, hooks: false, mcp: false, runtime: false, scripts: false, skills: true });
  expect(capabilities.counts).toEqual({ evalSuites: 1, hooks: 0, mcpServers: 0, scripts: 0, skills: 1, targets: 3 });
  expect(capabilities.routes.state).toBe('current');
  expect(capabilities.routes.manifest?.servers).toEqual([]);
  expect(Object.isFrozen(capabilities)).toBe(true);
  expect(Object.isFrozen(capabilities.counts)).toBe(true);
  expect(Object.isFrozen(capabilities.features)).toBe(true);
});

it('detects hooks and scripts from the artifact catalog without advertising unrelated features', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ hooks: 1, scripts: 2, targets: 3 }),
  });

  expect(capabilities.features).toEqual({ evals: false, hooks: true, mcp: false, runtime: false, scripts: true, skills: false });
});

it('detects the complete feature set for a full bundle and carries the runtime topology flag', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    runtime: true,
    ...clientsFor({ evalSuites: 1, hooks: 1, mcpServers: 1, scripts: 1, skills: 1, targets: 3 }),
  });

  expect(capabilities.features).toEqual({ evals: true, hooks: true, mcp: true, runtime: true, scripts: true, skills: true });
  expect(capabilities.inspection.epochId).toBe('build-a');
});

it('rejects an inspection from a different build', async () => {
  await expect(loadWorkbenchCapabilities({
    buildId: 'build-b',
    ...clientsFor({ skills: 1 }),
  })).rejects.toThrow('Capability catalog did not match the current build.');
});

it('detects hooks, MCP, and scripts from the compiled route graph alone', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ cliRoutes: 1, events: 1, routeScripts: 2, routeServers: 2 }),
  });

  expect(capabilities.features).toEqual({ evals: false, hooks: true, mcp: true, runtime: false, scripts: true, skills: false });
  expect(capabilities.counts.hooks).toBe(0);
  expect(capabilities.counts.mcpServers).toBe(0);
  expect(capabilities.routes.manifest?.servers.map((server) => server.name)).toEqual(['server-0', 'server-1']);
  expect(capabilities.routes.manifest?.events).toHaveLength(1);
  expect(capabilities.routes.manifest?.cli?.routes).toHaveLength(1);
});

it('reports a manifest compiled from newer source than the published build as stale', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    epochSourceRevision: '1'.repeat(64),
    ...clientsFor({ events: 1 }),
  });

  expect(capabilities.routes.state).toBe('stale');
  expect(capabilities.routes.manifest).toBeDefined();
  expect(capabilities.features.hooks).toBe(true);
});

it('keeps every artifact-derived feature when the manifest route is unavailable', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, hooks: 1, mcpServers: 1, scripts: 1, skills: 1, targets: 3 }),
    routeManifestClient: { manifest: async () => { throw new Error('Route manifest is not available.'); } },
  });

  expect(capabilities.features).toEqual({ evals: true, hooks: true, mcp: true, runtime: false, scripts: true, skills: true });
  expect(capabilities.routes).toEqual({ message: 'Route manifest is not available.', state: 'unavailable' });
  expect(applicationTreeSourcesFor(capabilities)).toEqual({
    inspection: capabilities.inspection,
    message: 'Route manifest is not available.',
    skillTree: capabilities.skillTree,
    state: 'unavailable',
  });
});

it('projects the manifest, catalog state, Skill tree, and inspection into the tree sources', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ routeServers: 1, skills: 1 }),
  });

  const sources = applicationTreeSourcesFor(capabilities);
  expect(sources.manifest).toBe(capabilities.routes.manifest);
  expect(sources.skillTree).toBe(capabilities.skillTree);
  expect(sources.inspection).toBe(capabilities.inspection);
  expect(sources.state).toBe('current');
  expect(sources.message).toBeUndefined();
});
