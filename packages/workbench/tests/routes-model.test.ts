import { expect, it } from '@rstest/core';

import type { RouteInputSchema, RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import {
  cliCommandInvocation,
  cliCommandUsage,
  createRouteInputDraft,
  routeCatalogFor,
  routeCatalogHasKind,
  routeCatalogServerCount,
  routeKindLabel,
  unavailableRouteCatalog,
  validateRawRouteInput,
  validateRouteInput,
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
      contract: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
      id: 'cli:library/audit',
      kind: 'cli',
      provenance: { kind: 'conventional' },
      source: 'src/cli/library/audit.ts',
    }],
  },
  contracts: [{
    id: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
    input: {
      additionalProperties: false,
      properties: { format: { enum: ['text', 'json'], type: 'string' } },
      required: ['format'],
      type: 'object',
    },
    origin: { binding: 'statusInputSchema', module: 'src/lib/protocol-schemas.ts' },
    routes: ['cli:library/audit', 'tool:alpha/echo'],
  }],
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
          contract: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
          id: 'tool:alpha/echo',
          inputSchema: {
            additionalProperties: false,
            properties: {
              count: { default: 2, description: 'Repeat count.', type: 'number' },
              enabled: { default: true, type: 'boolean' },
              format: { enum: ['text', 'json'], type: 'string' },
              tags: { items: { type: 'string' }, type: 'array' },
            },
            required: ['format'],
            type: 'object',
          },
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
  state: {
    budgets: {
      resolved: {
        maxCommitMs: 5_000,
        maxEventBytes: 262_144,
        maxRevisions: 100_000,
        maxStateBytes: 1_048_576,
      },
      source: 'defaults',
    },
    driver: 'sqlite',
    durableLocation: '$AGENT_BUNDLE_PLUGIN_ROOT/state',
    id: 'library/catalog',
    lifetime: 'workspace-durable',
    notices: ['The notice ledger is co-mounted at the same lifetime.'],
    source: 'src/state.ts',
  },
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

it('carries the declared state catalog without deriving durability from MCP servers', () => {
  const catalog = routeCatalogFor(manifest);

  expect(catalog.stateDefinition).toEqual(manifest.state);
});

it('keeps state honestly absent when the project declares no state module', () => {
  const { state: _state, ...statelessManifest } = manifest;
  const catalog = routeCatalogFor(statelessManifest);

  expect(catalog.stateDefinition).toBeUndefined();
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

it('derives contract origin and other sharing routes for each catalog entry', () => {
  const catalog = routeCatalogFor(manifest);
  const tool = catalog.groups.flatMap((group) => group.entries)
    .find((entry) => entry.id === 'tool:alpha/echo');
  const cli = catalog.groups.flatMap((group) => group.entries)
    .find((entry) => entry.id === 'cli:library/audit');

  expect(tool?.contract).toEqual({
    id: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
    origin: { binding: 'statusInputSchema', module: 'src/lib/protocol-schemas.ts' },
    sharedWith: ['cli:library/audit'],
  });
  expect(cli?.contract?.sharedWith).toEqual(['tool:alpha/echo']);
  expect(Object.isFrozen(tool?.contract?.sharedWith)).toBe(true);
});

it('prefills projected defaults and validates typed route input before invoke', () => {
  const catalog = routeCatalogFor(manifest);
  const entry = catalog.groups[0]!.entries.find((candidate) => candidate.id === 'tool:alpha/echo')!;
  const draft = createRouteInputDraft(entry.inputSchema!);

  expect(draft).toEqual({ count: '2', enabled: true, format: '', tags: [] });
  expect(validateRouteInput(entry.inputSchema!, draft)).toEqual({
    errors: { format: 'Format is required.' },
  });

  const invalid = validateRouteInput(entry.inputSchema!, {
    ...draft,
    count: 'many',
    format: 'yaml',
    tags: ['one', ''],
  });
  expect(invalid.errors).toEqual({
    count: 'Count must be a number.',
    format: 'Format must be one of: text, json.',
    tags: 'Tags item 2 is required.',
  });

  const valid = validateRouteInput(entry.inputSchema!, {
    ...draft,
    count: '4',
    format: 'json',
    tags: ['fiction', 'history'],
  });
  expect(valid).toEqual({
    arguments: {
      count: 4,
      enabled: true,
      format: 'json',
      tags: ['fiction', 'history'],
    },
    errors: {},
  });
});

it('preserves optional boolean omission while validating explicit and required values', () => {
  const schema: RouteInputSchema = {
    additionalProperties: false,
    properties: {
      defaulted: { default: true, type: 'boolean' },
      enabled: { type: 'boolean' },
      strict: { type: 'boolean' },
    },
    required: ['enabled'],
    type: 'object',
  };
  const draft = createRouteInputDraft(schema);

  expect(draft).toEqual({ defaulted: true, enabled: false });
  expect(validateRouteInput(schema, draft)).toEqual({
    arguments: { defaulted: true, enabled: false },
    errors: {},
  });
  expect(validateRouteInput(schema, { ...draft, strict: true })).toEqual({
    arguments: { defaulted: true, enabled: false, strict: true },
    errors: {},
  });
  expect(validateRouteInput(schema, { ...draft, strict: false })).toEqual({
    arguments: { defaulted: true, enabled: false, strict: false },
    errors: {},
  });
  expect(validateRouteInput(schema, { defaulted: true })).toEqual({
    errors: { enabled: 'Enabled must be true or false.' },
  });
});

it('validates the raw JSON fallback without inventing a schema', () => {
  expect(validateRawRouteInput('{')).toEqual({ error: 'Enter a valid JSON object.' });
  expect(validateRawRouteInput('[]')).toEqual({ error: 'Arguments must be a JSON object.' });
  expect(validateRawRouteInput('{"root":"/library"}')).toEqual({
    arguments: { root: '/library' },
  });
});

it('formats CLI usage and a shell-copyable invocation from validated input', () => {
  const command = {
    aliases: [],
    exitCode: 'zero' as const,
    options: [
      { key: 'input', kind: 'string' as const, option: 'input-file', positional: 0, repeated: false, required: true },
      { choices: ['text', 'json'], key: 'format', kind: 'enum' as const, option: 'format', repeated: false, required: false },
      { key: 'tag', kind: 'string' as const, option: 'tag', repeated: true, required: false },
      { key: 'verbose', kind: 'boolean' as const, option: 'verbose', repeated: false, required: false },
    ],
    path: ['library', 'audit'],
    routeId: 'cli:library/audit',
  };

  expect(cliCommandUsage(command)).toBe(
    'library audit <input-file> [--format <text|json>] [--tag <string> ...] [--verbose]',
  );
  expect(cliCommandInvocation(command, {
    format: 'json',
    input: '/Audio Books',
    tag: ['fiction', 'history'],
    verbose: true,
  })).toBe("library audit '/Audio Books' --format json --tag fiction --tag history --verbose");
});

it('marks required and optional repeated named flags in CLI usage', () => {
  expect(cliCommandUsage({
    aliases: [],
    exitCode: 'zero',
    options: [
      { key: 'source', kind: 'string', option: 'source', repeated: true, required: true },
      { key: 'tag', kind: 'string', option: 'tag', repeated: true, required: false },
    ],
    path: ['library', 'import'],
    routeId: 'cli:library/import',
  })).toBe('library import --source <string> ... [--tag <string> ...]');
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
