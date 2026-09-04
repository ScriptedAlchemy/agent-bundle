import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import { overviewFor } from '../src/overview-model.ts';
import { BundleWorkflow, HostAdoptionSection } from '../src/overview-page.tsx';
import type { WorkbenchCapabilities } from '../src/workbench-capabilities.ts';

const capabilities: Pick<WorkbenchCapabilities, 'counts' | 'pages'> = {
  counts: { evalSuites: 1, hooks: 0, mcpServers: 0, scripts: 0, skills: 1, targets: 3 },
  pages: new Set(['overview', 'skills', 'artifacts', 'logs', 'evals', 'comparisons']),
};

it('introduces the bundle dashboard as a plain-language capability summary', () => {
  const markup = renderToStaticMarkup(createElement(BundleWorkflow, { capabilities, onNavigate: () => undefined }));

  expect(markup).toContain('Bundle dashboard');
  expect(markup).toContain('See what this bundle publishes, try supported workflows, and rebuild after source changes.');
  expect(markup).toContain('1 Skill');
  expect(markup).toContain('1 Eval suite');
  expect(markup).toContain('3 generated targets');
});

it('offers only unique actions supported by the current bundle', () => {
  const markup = renderToStaticMarkup(createElement(BundleWorkflow, { capabilities, onNavigate: () => undefined }));

  expect(markup.match(/>Review authored Skills</gu)).toHaveLength(1);
  expect(markup.match(/>Run evaluations</gu)).toHaveLength(1);
  expect(markup.match(/>Inspect generated output</gu)).toHaveLength(1);
  expect(markup).not.toContain('Hooks');
  expect(markup).not.toContain('MCP');
  expect(markup).not.toContain('<ol');
  expect(markup).not.toContain('<button');
});

const activeStatus: ProjectStatus = {
  artifact: {
    activeEpoch: {
      configDigest: 'config',
      createdAt: '2026-08-14T12:00:00.000Z',
      diagnostics: { errors: 0, infos: 0, warnings: 0 },
      id: 'epoch-2',
      manifestPath: 'agent-bundle.manifest.json',
      modelDigest: 'model',
      projectRevision: 'revision-2',
      targetDigests: { portable: 'portable-digest' },
    },
    currentSourceRevision: 'revision-2',
    state: 'active',
  },
  build: { state: 'idle' },
  source: { diagnostics: [], revision: 'revision-2', state: 'ready' },
};

/**
 * The Overview in main.tsx feeds `overviewFor(status)` into the shared
 * HostAdoptionSection; this renders that section the same way.
 */
const renderHostAdoption = (status: ProjectStatus): string => {
  const overview = overviewFor(status);
  return renderToStaticMarkup(createElement(HostAdoptionSection, {
    hostAdoption: overview.hostAdoption,
    publishedEpochId: overview.epoch.id,
  }));
};

it('renders a failed host-adoption gate with its violations instead of silently applying the build', () => {
  const status: ProjectStatus = {
    ...activeStatus,
    hostAdoption: {
      adoptedEpochId: 'epoch-1',
      contracts: {
        diagnostics: [{ code: 'AB7211', message: 'Contract matrix reported 1 violation(s).', severity: 'error', target: 'epoch-2' }],
        epochId: 'epoch-2',
        failures: [{ checks: ['coverage'], routeId: 'tool:fixture/unknown' }],
        state: 'failed',
        summary: 'Development contract matrix reported 1 violation(s).',
      },
      mode: 'gated',
    },
  };
  const markup = renderHostAdoption(status);

  expect(markup).toContain('Host adoption');
  expect(markup).toContain('data-state="failed"');
  expect(markup).toContain('Contract matrix failed for build epoch-2 with 1 violation; hosts keep build epoch-1');
  expect(markup).toContain('tool:fixture/unknown');
  expect(markup).toContain('coverage');
  expect(markup).toContain('epoch-2');
  // The gate diagnostic reaches the Overview diagnostics table through the same model.
  expect(overviewFor(status).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['AB7211']);
});

it('omits the host-adoption section when the foreground reports no host-facing surfaces', () => {
  expect(renderHostAdoption(activeStatus)).toBe('');
});
