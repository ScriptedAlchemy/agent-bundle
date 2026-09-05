import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import { ProblemsPage } from '../src/problems/problems-page.tsx';
import { problemsFor, staleCatalogMessage } from '../src/shell/build-status-model.ts';

const staleStatus: ProjectStatus = {
  artifact: {
    activeEpoch: {
      configDigest: 'config',
      createdAt: '2026-08-14T12:00:00.000Z',
      diagnostics: { errors: 0, infos: 0, warnings: 0 },
      id: 'epoch-1',
      manifestPath: 'agent-bundle.manifest.json',
      modelDigest: 'model',
      projectRevision: 'revision-1',
      targetDigests: { portable: 'digest' },
    },
    currentSourceRevision: 'revision-2',
    state: 'stale',
  },
  build: {
    lastAttempt: {
      completedAt: '2026-08-14T12:01:00.000Z',
      diagnostics: [{ code: 'AB5200', message: 'Tool schema invalid.', recovery: 'Fix the schema.', severity: 'error', target: 'tool:curator/search_audible' }],
      id: 'attempt-1',
      outcome: 'failed',
      sourceRevision: 'revision-2',
      startedAt: '2026-08-14T12:00:01.000Z',
    },
    state: 'failed',
  },
  source: { diagnostics: [], revision: 'revision-2', state: 'ready' },
};

const render = (status: ProjectStatus, problems = problemsFor({ catalog: { diagnostics: [], state: status.artifact.state === 'stale' ? 'stale' : 'current' }, status })) =>
  renderToStaticMarkup(createElement(ProblemsPage, { onNavigate: () => undefined, onRepair: async () => undefined, problems, status }));

it('lists build and stale-catalog problems with code, severity, message, source, and route deep link, and offers Repair', () => {
  const markup = render(staleStatus);
  expect(markup).toContain('Problems (2)');
  expect(markup).toContain('data-testid="problems-summary">Resolve 1 error, then rebuild<');
  expect(markup).toMatch(/<button data-testid="problems-repair"[^>]*>Repair<\/button>/u);
  expect(markup).toContain('<span class="severity severity--error">error</span>');
  expect(markup).toContain('>AB5200<');
  expect(markup).toContain('Tool schema invalid.');
  expect(markup).toContain('<span class="problem-recovery">Fix the schema.</span>');
  expect(markup).toContain('<span class="problem-source">Build</span>');
  expect(markup).toContain('href="/routes/mcp/curator/tool/search_audible"');
  expect(markup).toContain(staleCatalogMessage);
  expect(markup).toContain('<span class="problem-source">Route catalog</span>');
  expect(markup).toContain('data-problem-source="route-catalog"');
  expect(markup.indexOf('AB5200')).toBeLessThan(markup.indexOf(staleCatalogMessage));
});

it('shows the empty state and a Rebuild action when nothing needs repair', () => {
  const healthy: ProjectStatus = {
    ...staleStatus,
    artifact: { activeEpoch: staleStatus.artifact.activeEpoch!, currentSourceRevision: 'revision-1', state: 'active' },
    build: { state: 'idle' },
  };
  const markup = render(healthy, []);
  expect(markup).toContain('Problems (0)');
  expect(markup).toContain('data-testid="problems-empty"');
  expect(markup).toMatch(/<button data-testid="problems-repair"[^>]*>Rebuild<\/button>/u);
  expect(markup).toContain('The current build matches your source');
});

it('renders a problem without a route as a dash rather than a link', () => {
  const markup = render(staleStatus, [{ message: 'Contract matrix failed', repairable: true, severity: 'error', source: 'host-attach' }]);
  expect(markup).toContain('<td class="identifier">—</td>');
  expect(markup).toContain('<span class="problem-source">Host attach</span>');
  expect(markup).not.toContain('problem-link');
});
