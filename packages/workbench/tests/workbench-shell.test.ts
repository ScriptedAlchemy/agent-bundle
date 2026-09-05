import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import type { ApplicationTree } from '../src/application/application-tree-model.ts';
import type { Problem } from '../src/shell/build-status-model.ts';
import { buildStatusTextFor, ConnectionGate, projectNameFor } from '../src/shell/shell-status.tsx';
import { ApplicationArea, SelectRouteState, UnknownRouteState, WorkbenchShell, workbenchNavItems } from '../src/shell/workbench-shell.tsx';

const status = (overrides: Partial<ProjectStatus> = {}): ProjectStatus => ({
  artifact: {
    activeEpoch: {
      configDigest: 'config',
      createdAt: '2026-08-14T12:00:00.000Z',
      diagnostics: { errors: 0, infos: 0, warnings: 0 },
      id: 'epoch-abcdef123456789',
      manifestPath: 'agent-bundle.manifest.json',
      modelDigest: 'model',
      packageName: 'audiobook-curator',
      projectRevision: 'revision-1',
      targetDigests: { portable: 'digest' },
    },
    currentSourceRevision: 'revision-1',
    state: 'active',
  },
  build: { state: 'idle' },
  source: { diagnostics: [], packageName: 'audiobook-curator', revision: 'revision-1', state: 'ready' },
  ...overrides,
});

const tree: ApplicationTree = { diagnostics: [], groups: [], leafCount: 7, state: 'current' };

const error: Problem = { code: 'AB4000', message: 'Plugin name is required.', repairable: true, severity: 'error', source: 'build' };
const warning: Problem = { message: 'stale', repairable: true, severity: 'warning', source: 'route-catalog' };

type ShellProps = ComponentProps<typeof WorkbenchShell>;

const shell = (location: ShellProps['location'], problems: readonly Problem[] = [], extra: Partial<ShellProps> = {}) =>
  renderToStaticMarkup(createElement(WorkbenchShell, {
    children: createElement('p', undefined, 'area content'),
    connection: { generation: 1, state: 'connected' },
    location,
    onNavigate: () => undefined,
    problems,
    status: status(),
    tree,
    ...extra,
  }));

it('renders the four PR 1 destinations in order, without Sessions, and marks the active one', () => {
  expect(workbenchNavItems.map((item) => item.label)).toEqual(['Application', 'Trace', 'Problems', 'Advanced']);
  const markup = shell({ area: 'trace' });
  expect(markup).toContain('data-testid="workbench-nav"');
  expect(markup).not.toContain('Sessions');
  expect(markup).toMatch(/<a[^>]*aria-current="page"[^>]*data-area="trace"/u);
  expect(markup).not.toMatch(/aria-current="page"[^>]*data-area="application"/u);
  expect(markup).toContain('href="/"');
  expect(markup).toContain('href="/trace"');
  expect(markup).toContain('href="/problems"');
  expect(markup).toContain('href="/advanced/evals"');
  expect(markup).toContain('data-testid="workbench-area-trace"');
  expect(markup).toContain('area content');
});

it('treats a selected route as the Application area and shows the leaf count', () => {
  const markup = shell({ area: 'application', node: { kind: 'tool', name: 'search_audible', server: 'curator' } });
  expect(markup).toMatch(/aria-current="page"[^>]*data-area="application"/u);
  expect(markup).toContain('<span class="nav-count">7</span>');
});

it('shows project name, build state with epoch, a failure badge linking to Problems, and the connection', () => {
  const markup = shell({ area: 'application' }, [error, warning, error]);
  expect(markup).toContain('data-testid="shell-project-name">audiobook-curator<');
  expect(markup).toMatch(/data-testid="shell-build-status"[^>]*>.*Current build.*epoch epoch-abcdef/u);
  expect(markup).toMatch(/<a[^>]*aria-label="2 problems"[^>]*class="shell-problems shell-problems--failing"[^>]*data-testid="problems-badge"[^>]*href="\/problems"/u);
  expect(markup).toContain('<span class="shell-problems-count">2</span>failures');
  expect(markup).toContain('<span class="nav-count nav-count--failing">2</span>');
  expect(markup).toContain('data-testid="shell-connection"');
  expect(markup).toContain('Foreground server connected');
});

it('reads zero failures as "No problems" and omits the Problems nav count', () => {
  const markup = shell({ area: 'problems' }, [warning]);
  expect(markup).toContain('aria-label="No problems"');
  expect(markup).toContain('<span class="shell-problems-count">0</span>failures');
  expect(markup).not.toContain('nav-count--failing');
});

it('renders connection loss and the runtime notice in the header', () => {
  const markup = shell({ area: 'application' }, [], {
    connection: { generation: 1, state: 'unavailable' },
    connectionError: 'AB8003 — Request origin is not this foreground server. (HTTP 403)',
    header: createElement('p', { role: 'status' }, 'Runtime capability issue: provider offline'),
  });
  expect(markup).toContain('shell-connection--unavailable');
  expect(markup).toContain('Foreground server unavailable: AB8003 — Request origin is not this foreground server. (HTTP 403)');
  expect(markup).toContain('Runtime capability issue: provider offline');
});

it('describes every build state for the header', () => {
  expect(buildStatusTextFor(status())).toEqual({ detail: 'epoch epoch-abcdef', label: 'Current build', tone: 'ready' });
  expect(buildStatusTextFor(status({ build: { activeAttempt: { diagnostics: [], id: 'a', outcome: 'running', sourceRevision: 'r', startedAt: 't' }, state: 'building' } })))
    .toEqual({ detail: 'epoch epoch-abcdef', label: 'Building…', tone: 'building' });
  expect(buildStatusTextFor(status({
    build: { lastAttempt: { completedAt: 't', diagnostics: [{ code: 'AB1', message: 'm', severity: 'error' }], id: 'a', outcome: 'failed', sourceRevision: 'r', startedAt: 't' }, state: 'failed' },
  }))).toEqual({ detail: 'current build · epoch epoch-abcdef', label: 'Build failed', tone: 'failed' });
  expect(buildStatusTextFor(status({ artifact: { state: 'missing' } }))).toEqual({ label: 'No build yet', tone: 'missing' });
  const stale = status();
  expect(buildStatusTextFor({ ...stale, artifact: { ...stale.artifact, state: 'stale' } as ProjectStatus['artifact'] }))
    .toEqual({ detail: 'epoch epoch-abcdef', label: 'Last good build', tone: 'stale' });
  expect(projectNameFor(undefined)).toBe('Agent Bundle project');
  expect(projectNameFor(status({ source: { diagnostics: [], state: 'unknown' } }))).toBe('audiobook-curator');
});

it('lays out the tree column beside the workspace and renders the empty and unknown-route states', () => {
  const layout = renderToStaticMarkup(createElement(ApplicationArea, { children: createElement('p', undefined, 'workspace'), tree: createElement('p', undefined, 'tree') }));
  expect(layout).toContain('<aside aria-label="Application tree" class="application-tree-column"><p>tree</p></aside>');
  expect(layout).toContain('<section aria-label="Route workspace" class="application-workspace"><p>workspace</p></section>');

  const select = renderToStaticMarkup(createElement(SelectRouteState, { tree }));
  expect(select).toContain('Select a route');
  expect(select).toContain('7 application routes');
  expect(renderToStaticMarkup(createElement(SelectRouteState, {}))).toContain('declares no routes yet');

  const unknown = renderToStaticMarkup(createElement(UnknownRouteState, { onNavigate: () => undefined, path: '/routes/scripts/gone' }));
  expect(unknown).toContain('This route is not in the compiled catalog');
  expect(unknown).toContain('/routes/scripts/gone');
  expect(unknown).toContain('href="/"');
});

it('overlays the connection gate with the failure line', () => {
  const markup = renderToStaticMarkup(createElement(ConnectionGate, { error: 'AB8003 — refused', state: 'unavailable' }));
  expect(markup).toContain('Foreground connection unavailable');
  expect(markup).toContain('<p role="alert">AB8003 — refused</p>');
  expect(renderToStaticMarkup(createElement(ConnectionGate, { state: 'connecting' }))).toContain('Foreground connection reconnecting');
});
