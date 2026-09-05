import { expect, it } from '@rstest/core';

import { artifactCompilerRecordVersion, type ArtifactManifest } from '../src/build/manifest.ts';
import { applicationExplorerFor } from '../src/dev/artifacts/application-explorer.ts';

const hash = 'a'.repeat(64);

const manifest = (): ArtifactManifest => ({
  application: {
    description: 'Reviews changes.',
    id: 'application:review',
    name: 'Review',
    version: '1.2.3',
  },
  distribution: {
    channels: ['local', 'npm'],
    install: { instructions: 'INSTALL.md', script: 'install.mjs' },
  },
  executables: {
    bins: [{
      hosts: ['claude', 'codex'],
      name: 'review',
      path: 'bin/review.mjs',
    }],
    hooks: [
      {
        event: 'sessionStart',
        host: 'codex',
        id: 'config:zeta',
        kind: 'config',
        name: 'Zeta setup',
        path: 'hooks/zeta.mjs',
      },
      {
        event: 'tool/after',
        host: 'claude',
        id: 'event:after',
        kind: 'event-route',
        name: 'After tool',
        path: 'hooks/after-claude.mjs',
        routeId: 'event:tool/after',
        timeout: 30,
      },
      {
        event: 'sessionStart',
        host: 'claude',
        id: 'config:alpha',
        kind: 'config',
        name: 'Alpha setup',
        path: 'hooks/alpha.mjs',
        timeout: 10,
      },
      {
        event: 'tool/after',
        host: 'codex',
        id: 'event:after',
        kind: 'event-route',
        name: 'After tool',
        path: 'hooks/after-codex.mjs',
        routeId: 'event:tool/after',
      },
    ],
    mcpServers: [{
      apps: [
        {
          id: 'app:review/dashboard',
          name: 'Dashboard',
          path: 'apps/dashboard.html',
          resourceUri: 'ui://review/dashboard',
        },
      ],
      entry: { path: 'mcp/review.mjs' },
      hosts: ['claude', 'codex'],
      id: 'mcp:review',
      kind: 'compiled',
      name: 'Review',
      transport: 'stdio',
    }],
    scripts: [{
      hosts: ['codex', 'claude'],
      id: 'script:lint',
      mode: 'bundle',
      name: 'Lint',
      path: 'scripts/lint.mjs',
    }],
  },
  compiler: {
    adapters: [
      { adapterRevision: 'claude-v1', host: 'claude', observedVersion: '1.0.0', schemas: [] },
      { adapterRevision: 'codex-v1', host: 'codex', observedVersion: '1.0.0', schemas: [] },
    ],
    agentSkills: {
      schemaSha256: hash,
      sourceRevision: hash,
      specification: 'https://example.com/agent-skills',
    },
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: hash,
      configPath: 'agent-bundle.config.ts',
      modelDigest: hash,
      revision: hash,
      sourceInputs: [{ path: 'agent-bundle.config.ts', sha256: hash }],
    },
    provenance: [],
    recordVersion: artifactCompilerRecordVersion,
    validation: {
      artifact: { status: 'passed' },
      projections: [{ host: 'claude', status: 'passed' }, { host: 'codex', status: 'passed' }],
      source: { status: 'passed' },
    },
  },
  files: [],
  manifestVersion: 2,
  projections: [
    {
      documents: { mcp: 'codex/mcp.json', plugin: 'codex/plugin.json' },
      host: 'codex',
    },
    {
      builtInHost: 'claude',
      documents: {
        hooks: 'claude/hooks.json',
        marketplace: 'claude/marketplace.json',
        plugin: 'claude/plugin.json',
      },
      host: 'claude',
      marketplace: { name: 'review-marketplace' },
    },
  ],
  routes: {
    cli: {
      commands: [
        { aliases: [], exitCode: 'result', options: [], path: ['zeta'], routeId: 'cli:zeta' },
        { aliases: [], exitCode: 'result', options: [], path: ['alpha'], routeId: 'cli:alpha' },
      ],
      mode: 'generated',
      routes: [],
    },
    digest: hash,
    events: [{
      event: 'tool/after',
      id: 'event:tool/after',
      kind: 'event-route',
      provenance: { kind: 'conventional' },
      source: 'src/events/tool/after.ts',
    }],
    layouts: [],
    providers: [],
    scripts: [],
    servers: [{
      id: 'mcp:review',
      mode: 'generated',
      name: 'Review',
      routes: [
        {
          description: 'Review a file.',
          id: 'tool:review/run',
          kind: 'tool',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:review',
          source: 'src/mcp/review/tools/run.ts',
        },
        {
          id: 'resource:review/summary',
          kind: 'resource',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:review',
          source: 'src/mcp/review/resources/summary.ts',
        },
        {
          id: 'prompt:review/check',
          kind: 'prompt',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:review',
          source: 'src/mcp/review/prompts/check.ts',
        },
        {
          id: 'app:review/dashboard',
          kind: 'app',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:review',
          source: 'src/mcp/review/apps/dashboard.tsx',
        },
      ],
    }],
  },
  runtime: { node: '22.12.0' },
});

it('projects one stable application tree by joining routes and executable rows', () => {
  const explorer = applicationExplorerFor(manifest());

  expect(explorer.identity).toEqual({
    description: 'Reviews changes.',
    id: 'application:review',
    name: 'Review',
    version: '1.2.3',
  });
  expect(explorer.hosts).toEqual([
    {
      builtIn: true,
      documents: [
        { kind: 'hooks', path: 'claude/hooks.json' },
        { kind: 'marketplace', path: 'claude/marketplace.json' },
        { kind: 'plugin', path: 'claude/plugin.json' },
      ],
      host: 'claude',
      marketplace: 'review-marketplace',
    },
    {
      builtIn: false,
      documents: [
        { kind: 'mcp', path: 'codex/mcp.json' },
        { kind: 'plugin', path: 'codex/plugin.json' },
      ],
      host: 'codex',
    },
  ]);
  expect(explorer.servers).toEqual([{
    apps: [{
      id: 'app:review/dashboard',
      name: 'Dashboard',
      path: 'apps/dashboard.html',
      resourceUri: 'ui://review/dashboard',
    }],
    entry: 'mcp/review.mjs',
    hosts: ['claude', 'codex'],
    id: 'mcp:review',
    kind: 'compiled',
    name: 'Review',
    prompts: [{ id: 'prompt:review/check', name: 'prompt:review/check' }],
    resources: [{ id: 'resource:review/summary', name: 'resource:review/summary' }],
    tools: [{ description: 'Review a file.', id: 'tool:review/run', name: 'tool:review/run' }],
    transport: 'stdio',
  }]);
  expect(explorer.events).toEqual([{
    event: 'tool/after',
    hooks: [
      { host: 'claude', kind: 'event-route', path: 'hooks/after-claude.mjs', timeout: 30 },
      { host: 'codex', kind: 'event-route', path: 'hooks/after-codex.mjs' },
    ],
    id: 'event:tool/after',
  }]);
  expect(explorer.hooks).toEqual([
    {
      hooks: [{
        event: 'sessionStart',
        id: 'config:alpha',
        kind: 'config',
        name: 'Alpha setup',
        path: 'hooks/alpha.mjs',
        timeout: 10,
      }],
      host: 'claude',
    },
    {
      hooks: [{
        event: 'sessionStart',
        id: 'config:zeta',
        kind: 'config',
        name: 'Zeta setup',
        path: 'hooks/zeta.mjs',
      }],
      host: 'codex',
    },
  ]);
  expect(explorer.cli).toEqual({
    bins: [{ hosts: ['claude', 'codex'], name: 'review', path: 'bin/review.mjs' }],
    commands: [
      { path: ['alpha'], routeId: 'cli:alpha' },
      { path: ['zeta'], routeId: 'cli:zeta' },
    ],
    mode: 'generated',
  });
  expect(explorer.scripts).toEqual([{
    hosts: ['claude', 'codex'],
    id: 'script:lint',
    mode: 'bundle',
    name: 'Lint',
    path: 'scripts/lint.mjs',
  }]);
  expect(explorer.distribution).toEqual({
    channels: ['local', 'npm'],
    install: { instructions: 'INSTALL.md', script: 'install.mjs' },
  });
});

it('deep-freezes the complete browser projection', () => {
  const explorer = applicationExplorerFor(manifest());

  expect(Object.isFrozen(explorer)).toBe(true);
  expect(Object.isFrozen(explorer.hosts)).toBe(true);
  expect(Object.isFrozen(explorer.hosts[0]!.documents[0]!)).toBe(true);
  expect(Object.isFrozen(explorer.servers[0]!.tools[0]!)).toBe(true);
  expect(Object.isFrozen(explorer.events[0]!.hooks)).toBe(true);
  expect(Object.isFrozen(explorer.hooks[0]!.hooks[0]!)).toBe(true);
  expect(Object.isFrozen(explorer.cli!.commands[0]!.path)).toBe(true);
  expect(Object.isFrozen(explorer.distribution.install!)).toBe(true);
});
