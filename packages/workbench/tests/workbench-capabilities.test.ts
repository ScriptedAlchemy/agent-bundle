import { expect, it } from '@rstest/core';

import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import { loadWorkbenchCapabilities } from '../src/workbench-capabilities.ts';

const digest = '0'.repeat(64);
const file = (path: string) => ({
  bytes: 1,
  kind: 'generated' as const,
  path,
  sha256: digest,
  sourceInputs: [],
});

const inspection = ({ hooks = 0, mcpServers = 0, scripts = 0, targets = 1 } = {}): ArtifactInspection => ({
  epochId: 'build-a',
  files: [],
  project: {
    configDigest: digest,
    configPath: 'agent-bundle.config.ts',
    modelDigest: digest,
    revision: digest,
    sourceInputs: [],
  },
  provenance: [],
  runtime: {
    executables: [],
    hooks: Array.from({ length: hooks }, (_, index) => ({
      event: 'sessionStart',
      file: file(`claude/hooks/hook-${String(index)}.mjs`),
      id: `hook:${String(index)}`,
      name: `hook-${String(index)}`,
      path: `hooks/hook-${String(index)}.mjs`,
      target: 'claude',
    })),
    mcpServers: Array.from({ length: mcpServers }, (_, index) => ({
      entryPaths: [`portable/mcp/server-${String(index)}.mjs`],
      kind: 'stdio' as const,
      manifestPath: `portable/mcp/server-${String(index)}.json`,
      name: `server-${String(index)}`,
      target: 'portable',
    })),
    scripts: Array.from({ length: scripts }, (_, index) => ({
      file: file(`portable/scripts/script-${String(index)}.mjs`),
      id: `script:${String(index)}`,
      name: `script-${String(index)}`,
      target: 'portable',
    })),
  },
  targets: Array.from({ length: targets }, (_, index) => ({
    name: `target-${String(index)}`,
    tree: { children: [], kind: 'directory' as const, name: `target-${String(index)}`, path: `target-${String(index)}` },
  })),
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

it('derives the Skills Starter routes from its validated catalogs', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, skills: 1, targets: 3 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'routes', 'skills', 'artifacts', 'logs', 'evals', 'comparisons',
  ]);
  expect(capabilities.counts).toEqual({ evalSuites: 1, hooks: 0, mcpServers: 0, scripts: 0, skills: 1, targets: 3 });
  expect(capabilities.routes.state).toBe('current');
  expect(capabilities.routes.routeCount).toBe(0);
  expect(Object.isFrozen(capabilities)).toBe(true);
  expect(Object.isFrozen(capabilities.counts)).toBe(true);
});

it('derives Hooks and Playground without advertising unrelated capabilities', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ hooks: 1, scripts: 2, targets: 3 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'routes', 'hooks', 'artifacts', 'playground', 'logs',
  ]);
});

it('derives the complete route set for a full bundle', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, hooks: 1, mcpServers: 1, scripts: 1, skills: 1, targets: 3 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'routes', 'skills', 'hooks', 'mcp', 'artifacts', 'playground', 'logs', 'evals', 'comparisons',
  ]);
  expect(capabilities.inspection.epochId).toBe('build-a');
});

it('rejects an inspection from a different build', async () => {
  await expect(loadWorkbenchCapabilities({
    buildId: 'build-b',
    ...clientsFor({ skills: 1 }),
  })).rejects.toThrow('Capability catalog did not match the current build.');
});

it('opens Hooks, MCP, and Playground from the compiled route graph alone', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ cliRoutes: 1, events: 1, routeScripts: 2, routeServers: 2 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'routes', 'hooks', 'lifecycles', 'mcp', 'artifacts', 'playground', 'logs',
  ]);
  expect(capabilities.counts.hooks).toBe(0);
  expect(capabilities.counts.mcpServers).toBe(0);
  expect(capabilities.routes.routeCount).toBe(6);
  expect(capabilities.routes.groups.map((group) => group.label)).toEqual([
    'server-0 · Tools',
    'server-1 · Tools',
    'Event routes',
    'CLI commands',
    'Scripts',
  ]);
});

it('reports a manifest compiled from newer source than the published build as stale', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    epochSourceRevision: '1'.repeat(64),
    ...clientsFor({ events: 1 }),
  });

  expect(capabilities.routes.state).toBe('stale');
  expect(capabilities.pages.has('hooks')).toBe(true);
  expect(capabilities.pages.has('lifecycles')).toBe(true);
});

it('keeps every artifact-derived page when the manifest route is unavailable', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, hooks: 1, mcpServers: 1, scripts: 1, skills: 1, targets: 3 }),
    routeManifestClient: { manifest: async () => { throw new Error('Route manifest is not available.'); } },
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'routes', 'skills', 'hooks', 'mcp', 'artifacts', 'playground', 'logs', 'evals', 'comparisons',
  ]);
  expect(capabilities.routes.state).toBe('unavailable');
  expect(capabilities.routes.message).toBe('Route manifest is not available.');
});
