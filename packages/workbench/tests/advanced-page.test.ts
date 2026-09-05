import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import { AdvancedPage, advancedSectionLabels, type AdvancedClients, type AdvancedProtocolSession } from '../src/advanced/advanced-page.tsx';
import { ArtifactClient } from '../src/artifacts/artifact-client.ts';
import { ComparisonClient } from '../src/comparisons/comparison-client.ts';
import { DiscoveryClient } from '../src/discovery/discovery-client.ts';
import { EvalClient } from '../src/evals/eval-client.ts';
import { LogClient } from '../src/logs/log-client.ts';
import { McpAppClient } from '../src/mcp/mcp-app-client.ts';
import { ForegroundRouteClient, McpRouteClient } from '../src/mcp/mcp-route-client.ts';
import { createMcpSessionController } from '../src/mcp/mcp-session-controller.ts';
import type { AdvancedSection, WorkbenchLocation } from '../src/shell/workbench-location.ts';
import { advancedSections } from '../src/shell/workbench-location.ts';

const foreground = new ForegroundRouteClient({ fetch: () => Promise.reject(new Error('no network under test')) });

const clients: AdvancedClients = {
  appClient: new McpAppClient({ foreground }),
  artifactClient: new ArtifactClient({ foreground }),
  comparisonClient: new ComparisonClient({ foreground }),
  discoveryClient: new DiscoveryClient({ foreground }),
  evalClient: new EvalClient({ foreground }),
  logClient: new LogClient({ foreground }),
};

const protocol: AdvancedProtocolSession = {
  controller: createMcpSessionController({ routes: new McpRouteClient({ foreground }) }),
  inspectorLaunch: {
    launch: async () => undefined,
    model: { phase: 'idle' },
    refresh: async () => undefined,
    subscribe: (listener) => { listener({ phase: 'idle' }); return () => undefined; },
  },
  onResetSession: () => undefined,
};

const status: ProjectStatus = {
  artifact: {
    activeEpoch: {
      configDigest: 'config',
      createdAt: '2026-08-14T12:00:00.000Z',
      diagnostics: { errors: 0, infos: 0, warnings: 0 },
      id: 'epoch-1',
      manifestPath: 'agent-bundle.manifest.json',
      modelDigest: 'model',
      projectRevision: 'revision-1',
      targetDigests: { claude: 'digest', portable: 'digest' },
    },
    currentSourceRevision: 'revision-1',
    state: 'active',
  },
  build: { state: 'idle' },
  source: { diagnostics: [], revision: 'revision-1', state: 'ready' },
};

const render = (section: AdvancedSection, onNavigate: (location: WorkbenchLocation) => void = () => undefined) =>
  renderToStaticMarkup(createElement(AdvancedPage, { clients, manifestSourceRevision: 'revision-1', onNavigate, protocol, section, status }));

it('renders the sub-nav in section order with URL hrefs and the active section marked', () => {
  const markup = render('protocol');
  expect(advancedSections.map((section) => advancedSectionLabels[section])).toEqual(['Evals', 'Artifact', 'Protocol', 'Host diagnostics', 'Raw logs']);
  expect(markup).toContain('data-testid="advanced-nav"');
  for (const section of advancedSections) expect(markup).toContain(`href="/advanced/${section}"`);
  expect(markup).toMatch(/<a aria-current="page" href="\/advanced\/protocol">Protocol<\/a>/u);
  expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
});

it('mounts each existing page component under its section', () => {
  const evals = render('evals');
  expect(evals).toContain('advanced-section--evals');
  expect(evals).toMatch(/<button aria-selected="true"[^>]*role="tab"[^>]*>Runs<\/button>/u);
  expect(evals).toMatch(/<button aria-selected="false"[^>]*role="tab"[^>]*>Compare<\/button>/u);

  const artifact = render('artifact');
  expect(artifact).toContain('advanced-section--artifact');
  expect(artifact).toContain('id="artifact-target"');

  const protocolMarkup = render('protocol');
  expect(protocolMarkup).toContain('class="mcp-content"');
  expect(protocolMarkup).toContain('epoch-1');

  const hosts = render('hosts');
  expect(hosts).toContain('advanced-section--hosts');

  const logs = render('logs');
  expect(logs).toContain('advanced-section--logs');
  expect(logs).toContain('logs-');
});
