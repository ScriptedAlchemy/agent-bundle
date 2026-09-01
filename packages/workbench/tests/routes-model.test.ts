import { expect, it } from '@rstest/core';

import type { RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import {
  routeCatalogFor,
  routeCatalogHasKind,
  routeCatalogServerCount,
  routeKindLabel,
  unavailableRouteCatalog,
} from '../src/routes/routes-model.ts';

const manifest: RouteManifest = {
  cli: {
    commands: [{
      aliases: [],
      exitCode: 'zero',
      options: [
        { key: 'input', kind: 'string', option: 'input', positional: 0, repeated: false, required: true },
        { key: 'verbose', kind: 'boolean', option: 'verbose', repeated: false, required: false },
      ],
      path: ['library', 'audit'],
      routeId: 'cli:library/audit',
    }],
    mode: 'generated',
    routes: [{
      config: [],
      id: 'cli:library/audit',
      kind: 'cli',
      provenance: { kind: 'conventional' },
      source: 'src/cli/library/audit.ts',
    }],
  },
  diagnostics: [],
  digest: 'd'.repeat(64),
  events: [{
    config: [{ key: 'targets', kind: 'array', value: '2 entries' }],
    event: 'afterTool',
    id: 'event:tool/after',
    kind: 'event-route',
    provenance: { kind: 'conventional' },
    source: 'src/events/tool/after.ts',
  }],
  providers: [
    { id: 'provider:library', name: 'library', source: 'src/providers/library.ts' },
    { id: 'provider:audio', name: 'audio', source: 'src/providers/audio.ts' },
  ],
  scripts: [{
    config: [],
    id: 'script:convert',
    kind: 'script',
    provenance: { kind: 'conventional' },
    source: 'src/scripts/convert.ts',
  }],
  servers: [
    {
      id: 'mcp:zeta',
      mode: 'custom',
      name: 'zeta',
      routes: [{
        config: [],
        id: 'prompt:zeta/summarize',
        kind: 'prompt',
        provenance: { kind: 'conventional' },
        serverId: 'mcp:zeta',
        source: 'src/mcp/zeta/prompts/summarize.ts',
      }],
    },
    {
      id: 'mcp:alpha',
      mode: 'generated',
      name: 'alpha',
      routes: [
        {
          config: [{ key: 'title', kind: 'string', value: 'Echo' }],
          id: 'tool:alpha/echo',
          kind: 'tool',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:alpha',
          source: 'src/mcp/alpha/tools/echo.ts',
        },
        {
          config: [],
          id: 'tool:alpha/build',
          kind: 'tool',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:alpha',
          source: 'src/mcp/alpha/tools/build.ts',
        },
        {
          config: [],
          id: 'resource:alpha/notes',
          kind: 'resource',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:alpha',
          source: 'src/mcp/alpha/resources/notes.ts',
        },
      ],
    },
  ],
  sourceRevision: 'r'.repeat(64),
};

it('groups the compiled graph by server then by project surface', () => {
  const catalog = routeCatalogFor(manifest, 'r'.repeat(64));

  expect(catalog.groups.map((group) => group.label)).toEqual([
    'alpha · Tools',
    'alpha · Resources',
    'zeta · Prompts',
    'Event routes',
    'CLI commands',
    'Scripts',
  ]);
  expect(catalog.state).toBe('current');
  expect(catalog.routeCount).toBe(7);
  expect(routeCatalogServerCount(catalog)).toBe(2);
});

it('orders routes within a group by compiled id', () => {
  const catalog = routeCatalogFor(manifest);

  expect(catalog.groups[0]?.entries.map((entry) => entry.id)).toEqual(['tool:alpha/build', 'tool:alpha/echo']);
});

it('carries the server packaging mode and the CLI surface mode as group metadata', () => {
  const catalog = routeCatalogFor(manifest);

  expect(catalog.groups.find((group) => group.label === 'zeta · Prompts')?.mode).toBe('custom');
  expect(catalog.groups.find((group) => group.kind === 'cli')?.mode).toBe('generated');
  expect(catalog.groups.find((group) => group.kind === 'cli')?.server).toBeUndefined();
});

it('retains empty externally packaged servers as catalog surfaces', () => {
  const catalog = routeCatalogFor({
    diagnostics: [],
    digest: 'e'.repeat(64),
    events: [],
    providers: [],
    scripts: [],
    servers: [
      { id: 'mcp:custom-library', mode: 'custom', name: 'custom-library', routes: [] },
      { id: 'mcp:command-catalog', mode: 'command', name: 'command-catalog', routes: [] },
    ],
    sourceRevision: 'r'.repeat(64),
  });

  expect(routeCatalogServerCount(catalog)).toBe(2);
  expect(catalog.servers).toEqual([
    { id: 'mcp:command-catalog', mode: 'command', name: 'command-catalog', routeCount: 0 },
    { id: 'mcp:custom-library', mode: 'custom', name: 'custom-library', routeCount: 0 },
  ]);
  expect(catalog.groups).toEqual([]);
  expect(catalog.routeCount).toBe(0);
});

it('attaches the compiled command to its CLI route entry', () => {
  const catalog = routeCatalogFor(manifest);
  const entry = catalog.groups.find((group) => group.kind === 'cli')?.entries[0];

  expect(entry?.command?.path).toEqual(['library', 'audit']);
  expect(entry?.command?.options.map((option) => option.key)).toEqual(['input', 'verbose']);
});

it('sorts providers by name and keeps route provenance on every entry', () => {
  const catalog = routeCatalogFor(manifest);

  expect(catalog.providers.map((provider) => provider.name)).toEqual(['audio', 'library']);
  expect(catalog.groups.flatMap((group) => group.entries).every((entry) => entry.provenance === 'conventional')).toBe(true);
});

it('reports a manifest revision ahead of the published build as stale', () => {
  expect(routeCatalogFor(manifest, 'e'.repeat(64)).state).toBe('stale');
  expect(routeCatalogFor(manifest).state).toBe('current');
});

it('answers kind availability from the compiled graph', () => {
  const catalog = routeCatalogFor(manifest);

  expect(routeCatalogHasKind(catalog, 'event-route')).toBe(true);
  expect(routeCatalogHasKind(catalog, 'script')).toBe(true);
  expect(routeCatalogHasKind(catalog, 'app')).toBe(false);
});

it('renders an empty compiled graph without groups', () => {
  const catalog = routeCatalogFor({
    diagnostics: [],
    digest: 'e'.repeat(64),
    events: [],
    providers: [],
    scripts: [],
    servers: [],
    sourceRevision: 'r'.repeat(64),
  });

  expect(catalog.groups).toEqual([]);
  expect(catalog.servers).toEqual([]);
  expect(catalog.routeCount).toBe(0);
  expect(catalog.state).toBe('current');
});

it('describes an unreadable manifest without inventing routes', () => {
  const catalog = unavailableRouteCatalog('Route manifest is not available.');

  expect(catalog.state).toBe('unavailable');
  expect(catalog.groups).toEqual([]);
  expect(catalog.servers).toEqual([]);
  expect(catalog.sourceRevision).toBeUndefined();
  expect(routeCatalogHasKind(catalog, 'tool')).toBe(false);
});

it('labels every compiled route kind', () => {
  expect(routeKindLabel('tool')).toBe('Tools');
  expect(routeKindLabel('event-route')).toBe('Event routes');
  expect(routeKindLabel('app')).toBe('MCP Apps');
});
