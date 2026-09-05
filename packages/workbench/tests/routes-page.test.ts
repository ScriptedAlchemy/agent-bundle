import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import { routeCatalogFor, unavailableRouteCatalog } from '../src/routes/routes-model.ts';
import { RoutesPage } from '../src/routes/routes-page.tsx';

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
  contracts: [{
    id: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
    input: {
      additionalProperties: false,
      properties: { format: { enum: ['text', 'json'], type: 'string' } },
      required: ['format'],
      type: 'object',
    },
    origin: { binding: 'statusInputSchema', module: 'src/lib/protocol-schemas.ts' },
    routes: ['cli:library/audit', 'tool:library/echo'],
  }],
  diagnostics: [{ code: 'AB4801', message: 'Two MCP tool routes claim the same name.', severity: 'error' }],
  digest: 'd'.repeat(64),
  events: [{
    config: [{ key: 'targets', kind: 'array', value: '2 entries' }],
    event: 'afterTool',
    id: 'event:tool/after',
    kind: 'event-route',
    provenance: { kind: 'conventional' },
    source: 'src/events/tool/after.ts',
  }],
  providers: [{ id: 'provider:library', name: 'library', source: 'src/providers/library.ts' }],
  scripts: [],
  servers: [{
    id: 'mcp:library',
    mode: 'generated',
    name: 'library',
    routes: [{
      config: [{ key: 'title', kind: 'string', value: 'Echo' }],
      contract: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
      description: 'Echo the request back',
      id: 'tool:library/echo',
      inputSchema: {
        additionalProperties: false,
        properties: {
          count: { default: 2, description: 'Repeat count.', type: 'number' },
          enabled: { default: true, type: 'boolean' },
          format: { enum: ['text', 'json'], type: 'string' },
          strict: { type: 'boolean' },
          tags: { items: { type: 'string' }, type: 'array' },
        },
        required: ['format'],
        type: 'object',
      },
      kind: 'tool',
      provenance: { kind: 'conventional' },
      serverId: 'mcp:library',
      source: 'src/mcp/library/tools/echo.ts',
    }],
  }],
  state: {
    budgets: {
      resolved: {
        maxCommitMs: 5_000,
        maxEventBytes: 262_144,
        maxRevisions: 100_000,
        maxStateBytes: 1_048_576,
      },
      source: 'declared',
    },
    driver: 'sqlite',
    durableLocation: '$AGENT_BUNDLE_PLUGIN_ROOT/state',
    id: 'library/catalog',
    lifetime: 'workspace-durable',
    noticeRetention: {
      resolved: { maxJournalBytes: 16_777_216, maxTerminal: 500, terminalTtlMs: 172_800_000 },
      source: 'declared',
    },
    notices: ['The notice ledger is co-mounted at the same lifetime.'],
    source: 'src/state.ts',
  },
  sourceRevision: 'r'.repeat(64),
};

const render = (catalog: Parameters<typeof RoutesPage>[0]['catalog']): string =>
  renderToStaticMarkup(createElement(RoutesPage, { catalog }));

it('renders the compiled catalog grouped by server and project surface', () => {
  const markup = render(routeCatalogFor(manifest, 'r'.repeat(64)));

  expect(markup).toContain('library · Tools');
  expect(markup).toContain('>Event routes<');
  expect(markup).toContain('>CLI commands<');
  expect(markup).toContain('tool:library/echo');
  expect(markup).toContain('src/mcp/library/tools/echo.ts');
  expect(markup).toContain('title: Echo');
  expect(markup).toContain('Echo the request back');
  expect(markup).toContain('>Context providers<');
  expect(markup).toContain('provider:library');
});

it('renders the declared state catalog as read-only facts', () => {
  const markup = render(routeCatalogFor(manifest));
  const statePanel = markup.match(/<section[^>]*aria-label="State"[^>]*>(.*?)<\/section>/u)?.[1] ?? '';

  expect(statePanel).toContain('library/catalog');
  expect(statePanel).toContain('workspace-durable');
  expect(statePanel).toContain('sqlite');
  expect(statePanel).toContain('declared');
  expect(statePanel).toContain('maxCommitMs');
  expect(statePanel).toContain('5000');
  expect(statePanel).toContain('$AGENT_BUNDLE_PLUGIN_ROOT/state');
  expect(statePanel).toContain('notice ledger is co-mounted');
  expect(statePanel).toContain('src/state.ts');
  // The notice retention policy is static configuration, shown in the units
  // the config author used and in the runtime's milliseconds.
  expect(statePanel).toContain('Notice retention');
  expect(statePanel).toContain('terminalTtl');
  expect(statePanel).toContain('2d (172800000ms)');
  expect(statePanel).toContain('maxTerminal');
  expect(statePanel).toContain('16777216');
  expect(statePanel).not.toMatch(/<(?:button|input|select|textarea)\b/u);
});

it('omits the notice retention block for manifests that predate it', () => {
  const { noticeRetention: _retention, ...legacyState } = manifest.state!;
  const markup = render(routeCatalogFor({ ...manifest, state: legacyState }));
  const statePanel = markup.match(/<section[^>]*aria-label="State"[^>]*>(.*?)<\/section>/u)?.[1] ?? '';
  expect(statePanel).toContain('library/catalog');
  expect(statePanel).not.toContain('Notice retention');
});

it('renders honest state absence without an alert', () => {
  const { state: _state, ...statelessManifest } = manifest;
  const markup = render(routeCatalogFor(statelessManifest));

  expect(markup).toContain('This project declares no state module.');
  expect(markup.match(/This project declares no state module\.<\/p>/u)?.[0]).not.toContain('role="alert"');
});

it('shows the argv projection of a compiled CLI command', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('library audit &lt;input&gt; [--verbose]');
  expect(markup).toContain('Schema not statically projectable');
});

it('leads the usage line with positionals in argv order regardless of option order', () => {
  const reordered: RouteManifest = {
    ...manifest,
    cli: {
      ...manifest.cli!,
      commands: [{
        aliases: [],
        exitCode: 'result',
        options: [
          { key: 'concurrency', kind: 'number', option: 'concurrency', repeated: false, required: false },
          { key: 'report', kind: 'string', option: 'report', repeated: false, required: true },
          { key: 'sources', kind: 'string', option: 'sources', positional: 0, repeated: true, required: true },
        ],
        path: ['library', 'audit'],
        routeId: 'cli:library/audit',
      }],
    },
  };

  const markup = render(routeCatalogFor(reordered));

  expect(markup).toContain('library audit &lt;sources...&gt; [--concurrency &lt;number&gt;] --report &lt;string&gt;');
});

it('formats optional positionals and enum flags like generated CLI help', () => {
  const optionalInputs: RouteManifest = {
    ...manifest,
    cli: {
      ...manifest.cli!,
      commands: [{
        aliases: [],
        exitCode: 'zero',
        options: [
          { key: 'format', kind: 'enum', option: 'format', choices: ['mp3', 'opus'], repeated: false, required: false },
          { key: 'destination', kind: 'string', option: 'output-directory', positional: 0, repeated: false, required: false },
          { key: 'sources', kind: 'string', option: 'extra-source', positional: 1, repeated: true, required: false },
        ],
        path: ['publish'],
        routeId: 'cli:library/audit',
      }],
    },
  };

  const markup = render(routeCatalogFor(optionalInputs));

  expect(markup).toContain('publish [output-directory] [extra-source...] [--format &lt;mp3|opus&gt;]');
});

it('renders generated fields, descriptions, defaults, required markers, and a gated MCP handoff', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('Generated input editor');
  expect(markup).toContain('Repeat count.');
  expect(markup).toContain('value="2"');
  expect(markup).toMatch(/Enabled<input[^>]*type="checkbox"[^>]*checked=""/u);
  expect(markup).toContain('Format (required)');
  expect(markup).toContain('<option value="json">json</option>');
  expect(markup).toMatch(/Strict<select[^>]*><option value=""[^>]*>\(omitted\)<\/option><option value="true">true<\/option><option value="false">false<\/option><\/select>/u);
  expect(markup).toContain('Add Tags item');
  expect(markup).toContain('Full schema validation runs during execution.');
  expect(markup).toContain('Open in MCP session');
  expect(markup).toContain('disabled=""');
});

it('renders a compact contract origin and sharing summary beside the input heading', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain(
    'Contract statusInputSchema · src/lib/protocol-schemas.ts · shared with cli:library/audit',
  );
});

it('renders an honest JSON fallback and no invoke control for non-tool routes', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('Schema not statically projectable; enter a JSON object.');
  expect(markup).toContain('Validation only; this route kind is not invokable from Routes.');
  expect(markup.match(/Open in MCP session/gu)).toHaveLength(1);
});

it('shows the canonical event beside an event route', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('>afterTool<');
  expect(markup).toContain('targets: 2 entries');
});

it('surfaces route graph diagnostics alongside the catalog', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('Route diagnostics (1)');
  expect(markup).toContain('AB4801');
  expect(markup).toContain('Two MCP tool routes claim the same name.');
});

it('reports a manifest ahead of the published build without hiding routes', () => {
  const markup = render(routeCatalogFor(manifest, 'e'.repeat(64)));

  expect(markup).toContain('Rebuild to publish these routes.');
  expect(markup).toContain('route-state--stale');
  expect(markup).toContain('tool:library/echo');
});

it('names the empty compiled graph rather than an error', () => {
  const markup = render(routeCatalogFor({
    diagnostics: [],
    digest: 'e'.repeat(64),
    events: [],
    providers: [],
    scripts: [],
    servers: [],
    sourceRevision: 'r'.repeat(64),
  }));

  expect(markup).toContain('This project declares no conventional route modules.');
  expect(markup).not.toContain('role="alert"');
});

it('renders externally packaged empty servers instead of the no-routes state', () => {
  const markup = render(routeCatalogFor({
    diagnostics: [],
    digest: 'e'.repeat(64),
    events: [],
    providers: [],
    scripts: [],
    servers: [
      { id: 'mcp:custom-library', mode: 'custom', name: 'custom-library', routes: [] },
      { id: 'mcp:remote-catalog', mode: 'remote', name: 'remote-catalog', routes: [] },
    ],
    sourceRevision: 'r'.repeat(64),
  }));

  expect(markup).toContain('>custom-library<');
  expect(markup).toContain('>remote-catalog<');
  expect(markup).toContain('custom mode');
  expect(markup).toContain('remote mode');
  expect(markup).toContain('packaged externally');
  expect(markup).not.toContain('This project declares no conventional route modules.');
});

it('reports an unreadable manifest as an alert', () => {
  const markup = render(unavailableRouteCatalog('Route manifest is not available.'));

  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Route manifest is not available.');
  expect(markup).not.toContain('route-table');
});

it('reports no static config export instead of an empty cell', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('No static config export');
});

it('does not repeat the description it already renders as the route label', () => {
  const described: RouteManifest = {
    ...manifest,
    servers: [{
      ...manifest.servers[0]!,
      routes: [{
        config: [
          { key: 'description', kind: 'string', value: 'Echo the request back' },
          { key: 'title', kind: 'string', value: 'Echo' },
        ],
        description: 'Echo the request back',
        id: 'tool:library/echo',
        kind: 'tool',
        provenance: { kind: 'conventional' },
        serverId: 'mcp:library',
        source: 'src/mcp/library/tools/echo.ts',
      }],
    }],
  };

  const markup = render(routeCatalogFor(described));

  expect(markup).toContain('title: Echo');
  expect(markup).not.toContain('description: Echo the request back');
  expect(markup.match(/Echo the request back/gu)).toHaveLength(1);
});

it('names a config carrying only the description rather than claiming there is none', () => {
  const onlyDescription: RouteManifest = {
    ...manifest,
    servers: [{
      ...manifest.servers[0]!,
      routes: [{
        config: [{ key: 'description', kind: 'string', value: 'Curate a library' }],
        description: 'Curate a library',
        id: 'prompt:library/curate',
        kind: 'prompt',
        provenance: { kind: 'conventional' },
        serverId: 'mcp:library',
        source: 'src/mcp/library/prompts/curate.ts',
      }],
    }],
  };

  const markup = render(routeCatalogFor(onlyDescription));

  expect(markup).toContain('No config beyond the description');
  // The CLI route in the same manifest exports no config at all, so the two
  // empty-config summaries must stay distinguishable rather than collapse.
  expect(markup).toContain('No static config export');
});
