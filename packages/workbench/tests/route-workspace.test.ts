import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from '@rstest/core';

import { appResourceUriFor, catalogToolsFor, orderedToolsForApp } from '../src/application/app-route-workspace.tsx';
import { ExecutableRouteWorkspace, resultTabFor } from '../src/application/executable-route-workspace.tsx';
import { idleInvocationState, reduceInvocationState, selectBackend } from '../src/application/invocation-model.ts';
import { ResultTabs } from '../src/application/result-tabs.tsx';
import { requestContextRows, RouteInspector } from '../src/application/route-inspector.tsx';
import { RouteWorkspace } from '../src/application/route-workspace.tsx';
import type { RouteInvocationController } from '../src/application/workspace-contracts.ts';
import {
  appLeaf,
  clients,
  cliLeaf,
  eventLeaf,
  fakeBackend,
  invocation,
  ruleLeaf,
  skillLeaf,
  status,
  summaryOf,
  toolLeaf,
  tree,
} from './support/workspace-fixtures.ts';

const noop = (): void => undefined;

const controllerWith = (overrides: Partial<RouteInvocationController> = {}): RouteInvocationController => ({
  backendKind: 'dev-server',
  history: [summaryOf(invocation)],
  load: noop,
  run: noop,
  state: idleInvocationState,
  ...overrides,
});

const succeeded = controllerWith({
  request: { correlationId: 'corr-1', input: { title: 'Dune' }, routeId: toolLeaf.routeId! },
  state: { durationMs: 432, invocation, phase: 'succeeded' },
});

describe('invocation state contract', () => {
  it('runs, settles with the envelope, and turns a failed envelope into the failed phase with its diagnostics', () => {
    const running = reduceInvocationState(idleInvocationState, { correlationId: 'c', startedAt: 1_000, type: 'start' });
    expect(running).toEqual({ correlationId: 'c', phase: 'running', startedAt: 1_000 });

    const done = reduceInvocationState(running, { completedAt: 1_432, invocation, type: 'settle' });
    expect(done).toMatchObject({ durationMs: 432, phase: 'succeeded' });

    const failedEnvelope = { ...invocation, diagnostics: [{ code: 'AB7101', message: 'Handler threw.', severity: 'error' as const }], status: 'failed' as const };
    const failed = reduceInvocationState(running, { completedAt: 1_500, invocation: failedEnvelope, type: 'settle' });
    expect(failed).toMatchObject({ diagnostics: [{ code: 'AB7101' }], durationMs: 500, phase: 'failed' });

    const rejected = reduceInvocationState(running, { completedAt: 1_100, failure: { code: 'AB8231', message: 'Unknown route.' }, type: 'fail' });
    expect(rejected).toMatchObject({ diagnostics: [], durationMs: 100, failure: { code: 'AB8231' }, phase: 'failed' });

    const loaded = reduceInvocationState(idleInvocationState, { invocation, type: 'load' });
    expect(loaded).toEqual({ invocation, phase: 'succeeded' });
    expect(reduceInvocationState(loaded, { type: 'reset' })).toBe(idleInvocationState);
  });

  it('selects the first backend that accepts the leaf', () => {
    const runtime = fakeBackend(invocation, 'runtime');
    const devServer = fakeBackend();
    expect(selectBackend([runtime, devServer], toolLeaf)).toBe(runtime);
    expect(selectBackend([devServer], skillLeaf)).toBeUndefined();
  });

  it('falls back to the rendered tab for unknown deep links', () => {
    expect(resultTabFor('mcp')).toBe('mcp');
    expect(resultTabFor('bogus')).toBe('rendered');
    expect(resultTabFor(undefined)).toBe('rendered');
  });
});

describe('RouteWorkspace dispatch', () => {
  it('mounts the executable body for a tool leaf with editor, Run, result tabs, and a closed inspector', async () => {
    const backend = fakeBackend();
    const markup = renderToStaticMarkup(createElement(RouteWorkspace, {
      backends: [backend],
      clients: clients(),
      leaf: toolLeaf,
      onNavigate: noop,
      status,
      tree,
    }));

    expect(markup).toContain('data-testid="route-workspace"');
    expect(markup).toContain('data-testid="route-input-editor"');
    expect(markup).toContain('data-testid="route-run"');
    expect(markup).toContain('data-testid="result-tab-rendered"');
    expect(markup).toContain('data-testid="result-tab-structured"');
    expect(markup).toContain('data-testid="result-tab-raw"');
    expect(markup).toContain('data-testid="result-tab-trace"');
    expect(markup).toContain('data-testid="rendered-document"');
    expect(markup).toContain('data-testid="inspector-toggle"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="tabpanel" aria-label="Source"');
    expect(markup).toContain('search_audible');
    expect(markup).toContain('Search Audible regions and return ranked identity evidence.');
    expect(markup).toContain('Title (required)');
    expect(markup).toContain('via dev-server');
    expect(markup).toContain('Not run yet');
    // The fake backend answers the request shape the workspace sends.
    const answered = await backend.invoke(toolLeaf, { correlationId: 'x', input: { title: 'Dune' }, routeId: toolLeaf.routeId! });
    expect(answered.correlationId).toBe('x');
    expect(backend.requests).toEqual([{ correlationId: 'x', input: { title: 'Dune' }, routeId: 'tool:curator/search_audible' }]);
  });

  it('says when no backend accepts the leaf', () => {
    const markup = renderToStaticMarkup(createElement(RouteWorkspace, {
      backends: [],
      clients: clients(),
      leaf: cliLeaf,
      onNavigate: noop,
      status,
      tree,
    }));

    expect(markup).toContain('No backend can run this route.');
    expect(markup).toContain('Argv the routed CLI receives');
  });

  it('presents an unavailable-build invocation as a diagnostic with a Problems link', () => {
    const markup = renderToStaticMarkup(createElement(ExecutableRouteWorkspace, {
      controller: controllerWith({
        state: {
          diagnostics: [],
          failure: {
            code: 'AB8232',
            message: 'The source is newer than the published build. Rebuild before invoking routes.',
          },
          phase: 'failed',
        },
      }),
      leaf: toolLeaf,
      onNavigate: noop,
    }));

    expect(markup).toContain('<strong>AB8232</strong>');
    expect(markup).toContain('The source is newer than the published build. Rebuild before invoking routes.');
    expect(markup).toContain('Open in Problems');
    expect(markup).not.toContain('Handler threw');
  });

  it('shows the outcome of a completed run beside its execution status, never as plain success', () => {
    const render = (outcome: NonNullable<typeof invocation.outcome>): string => {
      const envelope = { ...invocation, outcome };
      return renderToStaticMarkup(createElement(ExecutableRouteWorkspace, {
        controller: controllerWith({
          history: [summaryOf(envelope)],
          state: { durationMs: 432, invocation: envelope, phase: 'succeeded' },
        }),
        leaf: toolLeaf,
        onNavigate: noop,
        tab: 'trace',
      }));
    };

    const represented = render({ kind: 'represented-error', summary: '[refused] Refused: policy' });
    expect(represented).toContain('Completed in 432 ms');
    expect(represented).toContain('route-outcome--represented-error');
    expect(represented).toContain('Represented error · [refused] Refused: policy');
    // Once on the status line, once on the Trace entry.
    expect(represented.split('route-outcome--represented-error')).toHaveLength(3);
    expect(represented).not.toContain('route-outcome--success');

    const exited = render({ exitCode: 3, kind: 'process-exit' });
    expect(exited).toContain('route-outcome--process-exit');
    expect(exited).toContain('Exit code 3');
    expect(exited).not.toContain('route-outcome--success');

    const success = render({ kind: 'success' });
    expect(success).toContain('route-outcome--success');
    expect(success).toContain('>Success<');
  });

  it('mounts the host selector for an event leaf', () => {
    const markup = renderToStaticMarkup(createElement(RouteWorkspace, {
      backends: [fakeBackend()],
      clients: clients(),
      leaf: eventLeaf,
      onNavigate: noop,
      status,
      tree,
    }));

    expect(markup).toContain('data-testid="event-host-canonical"');
    expect(markup).toContain('data-testid="event-host-claude"');
    expect(markup).toContain('data-testid="event-host-codex"');
    expect(markup).toContain('data-testid="event-host-cursor"');
    expect(markup).toContain('data-testid="result-tab-mapping"');
    expect(markup).toContain('data-testid="result-tab-native"');
    expect(markup).toContain('data-testid="result-tab-canonical"');
    expect(markup).toContain('data-testid="result-tab-replay"');
  });

  it('mounts the App preview workspace for an app leaf', () => {
    const markup = renderToStaticMarkup(createElement(RouteWorkspace, {
      backends: [fakeBackend()],
      clients: clients(),
      leaf: appLeaf,
      onNavigate: noop,
      status,
      tree,
    }));

    expect(markup).toContain('data-testid="app-preview"');
    expect(markup).toContain('ui://curator/library.html');
    expect(markup).toContain('Publish a build to preview this App');
    expect(markup).toContain('Open protocol inspector');
  });

  it('mounts the rendered Skill document for a skill leaf and a read-only view for a rule', () => {
    const skill = renderToStaticMarkup(createElement(RouteWorkspace, {
      backends: [],
      clients: clients(),
      leaf: skillLeaf,
      onNavigate: noop,
      status,
      tree,
    }));
    const rule = renderToStaticMarkup(createElement(RouteWorkspace, {
      backends: [],
      clients: clients(),
      leaf: ruleLeaf,
      onNavigate: noop,
      status,
      tree,
    }));

    expect(skill).toContain('aria-label="Skill document"');
    expect(skill).toContain('Loading the authored Skill…');
    expect(skill).toContain('data-testid="inspector-toggle"');
    expect(rule).toContain('rules/style.md');
    expect(rule).toContain('alwaysApply');
    expect(rule).toContain('nothing to run');
    expect(rule).not.toContain('data-testid="route-run"');
  });
});

describe('ResultTabs', () => {
  it('renders the Agent Document by default and offers the MCP projection only when the envelope has one', () => {
    const markup = renderToStaticMarkup(createElement(ResultTabs, {
      controller: succeeded,
      leaf: toolLeaf,
      onNavigate: noop,
      onTabChange: noop,
      tab: 'rendered',
    }));

    expect(markup).toContain('Found 8 candidates for Dune.');
    expect(markup).toContain('<strong>Dune</strong>');
    expect(markup).toContain('rendered-document-badge--success');
    expect(markup).toContain('data-testid="result-tab-mcp"');
    expect(markup).not.toContain('data-testid="result-tab-cli"');
    expect(markup).toContain('aria-selected="true"');
  });

  it('shows the structured result, the raw stream, the MCP projection, and the trace on their tabs', () => {
    const render = (tab: 'mcp' | 'raw' | 'structured' | 'trace'): string => renderToStaticMarkup(createElement(ResultTabs, {
      controller: succeeded,
      leaf: toolLeaf,
      onNavigate: noop,
      onTabChange: noop,
      tab,
    }));

    expect(render('structured')).toContain('&quot;candidates&quot;: 8');
    const raw = render('raw');
    expect(raw).toContain('Render events (3)');
    expect(raw).toContain('Shell · #0');
    expect(raw).toContain('Progress · #1 · Searching us · 1 / 2');
    expect(raw).toContain('Complete · #2 · success');
    expect(render('mcp')).toContain('structuredContent');
    const trace = render('trace');
    expect(trace).toContain('aria-label="Invocations of this route"');
    expect(trace).toContain('inv-1');
    expect(trace).toContain('result-trace-entry--current');
  });

  it('marks the rendered pane pending while the backend is running', () => {
    const markup = renderToStaticMarkup(createElement(ResultTabs, {
      controller: controllerWith({ state: { correlationId: 'c', phase: 'running', startedAt: 0 } }),
      leaf: toolLeaf,
      onNavigate: noop,
      onTabChange: noop,
      tab: 'rendered',
    }));

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Waiting for the first render event…');
  });
});

describe('RouteInspector', () => {
  it('stays closed by default and opens to the evidence tabs', () => {
    const closed = renderToStaticMarkup(createElement(RouteInspector, {
      backendKind: 'dev-server',
      invocation,
      leaf: toolLeaf,
      onTabChange: noop,
      onToggle: noop,
      open: false,
      tab: 'source',
    }));
    expect(closed).toContain('data-testid="inspector-toggle"');
    expect(closed).not.toContain('role="tablist"');

    const open = (tab: 'context' | 'projection' | 'providers' | 'raw-protocol' | 'schema' | 'source' | 'timings'): string => renderToStaticMarkup(createElement(RouteInspector, {
      backendKind: 'dev-server',
      invocation,
      leaf: toolLeaf,
      onTabChange: noop,
      onToggle: noop,
      open: true,
      request: succeeded.request,
      tab,
    }));

    const source = open('source');
    expect(source).toContain('src/mcp/curator/tools/search_audible.tsx');
    expect(source).toContain('tool:curator/search_audible');
    expect(source).toContain('rev-1');
    for (const id of ['source', 'schema', 'context', 'providers', 'timings', 'projection', 'raw-protocol']) {
      expect(source).toContain(`data-testid="inspector-tab-${id}"`);
    }
    expect(open('schema')).toContain('&quot;required&quot;');
    const context = open('context');
    expect(context).toContain('/home/me/library · derived');
    expect(context).toContain('Unavailable · no-shared-runtime');
    const providers = open('providers');
    expect(providers).toContain('library');
    expect(providers).toContain('inspector-status--mounted');
    expect(providers).toContain('2 ms');
    const timings = open('timings');
    expect(timings).toContain('handler');
    expect(timings).toContain('400 ms');
    expect(open('projection')).toContain('structuredContent');
    const raw = open('raw-protocol');
    expect(raw).toContain('&quot;correlationId&quot;: &quot;corr-1&quot;');
    expect(raw).toContain('&quot;manifestDigest&quot;: &quot;digest-1&quot;');
  });

  it('renders unobserved providers without a fabricated 0 ms duration', () => {
    const markup = renderToStaticMarkup(createElement(RouteInspector, {
      backendKind: 'dev-server',
      invocation: {
        ...invocation,
        providers: [{ id: 'provider:library', name: 'library', status: 'unobserved' }],
        timings: [{ durationMs: 5, phase: 'render', startedAt: invocation.startedAt }],
      },
      leaf: toolLeaf,
      onTabChange: noop,
      onToggle: noop,
      open: true,
      tab: 'providers',
    }));

    expect(markup).toContain('inspector-status--unobserved');
    expect(markup).toContain('unobserved');
    expect(markup).not.toContain('0 ms');
    expect(markup).toContain('—');
  });

  it('derives one row per request-context axis', () => {
    expect(requestContextRows(invocation.context).map((entry) => entry.label)).toEqual([
      'Invocation kind', 'Operation ID', 'Surface', 'Host contract revision', 'Host', 'Session', 'Actor', 'Workspace', 'Lineage',
    ]);
  });
});

describe('App leaf tool binding', () => {
  it('reads the App resource and orders the server tools bound through _meta.ui.resourceUri first', () => {
    expect(appResourceUriFor(appLeaf)).toBe('ui://curator/library.html');
    const tools = catalogToolsFor([
      { description: 'Lists sources', inputSchema: { type: 'object' }, name: 'inventory_sources' },
      { _meta: { ui: { resourceUri: 'ui://curator/library.html' } }, name: 'browse_library' },
      { name: 42 },
      'not a tool',
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['inventory_sources', 'browse_library']);
    expect(orderedToolsForApp(tools, 'ui://curator/library.html').map((tool) => tool.name)).toEqual(['browse_library', 'inventory_sources']);
    expect(orderedToolsForApp(tools, undefined).map((tool) => tool.name)).toEqual(['inventory_sources', 'browse_library']);
  });
});
