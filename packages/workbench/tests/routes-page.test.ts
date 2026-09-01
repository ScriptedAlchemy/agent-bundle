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
      description: 'Echo the request back',
      id: 'tool:library/echo',
      kind: 'tool',
      provenance: { kind: 'conventional' },
      serverId: 'mcp:library',
      source: 'src/mcp/library/tools/echo.ts',
    }],
  }],
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

it('shows the argv projection of a compiled CLI command', () => {
  const markup = render(routeCatalogFor(manifest));

  expect(markup).toContain('library audit &lt;input&gt; [--verbose]');
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
