import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import { expect, it } from '@rstest/core';

import { BundleWorkflow } from '../src/overview-page.tsx';
import type { WorkbenchCapabilities } from '../src/workbench-capabilities.ts';

const capabilities: Pick<WorkbenchCapabilities, 'counts' | 'pages'> = {
  counts: { evalSuites: 1, hooks: 0, mcpServers: 0, scripts: 0, skills: 1, targets: 3 },
  pages: new Set(['overview', 'skills', 'artifacts', 'logs', 'evals', 'comparisons']),
};

it('introduces the bundle dashboard as a plain-language capability summary', () => {
  const markup = renderToStaticMarkup(createElement(MemoryRouter, undefined, createElement(BundleWorkflow, { capabilities })));

  expect(markup).toContain('Bundle dashboard');
  expect(markup).toContain('See what this bundle publishes, try supported workflows, and rebuild after source changes.');
  expect(markup).toContain('1 Skill');
  expect(markup).toContain('1 Eval suite');
  expect(markup).toContain('3 generated targets');
});

it('offers only unique actions supported by the current bundle', () => {
  const markup = renderToStaticMarkup(createElement(MemoryRouter, undefined, createElement(BundleWorkflow, { capabilities })));

  expect(markup.match(/>Review authored Skills</gu)).toHaveLength(1);
  expect(markup.match(/>Run evaluations</gu)).toHaveLength(1);
  expect(markup.match(/>Inspect generated output</gu)).toHaveLength(1);
  expect(markup).not.toContain('Hooks');
  expect(markup).not.toContain('MCP');
  expect(markup).not.toContain('<ol');
  expect(markup).not.toContain('<button');
});
