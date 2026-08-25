import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { BundleWorkflow } from '../src/overview-page.tsx';

it('introduces the bundle dashboard and its author-to-evidence workflow', () => {
  const markup = renderToStaticMarkup(createElement(BundleWorkflow, { onNavigate: () => undefined }));

  expect(markup).toContain('Bundle dashboard');
  expect(markup).toContain('Author once, exercise host-ready behavior, and evaluate durable evidence.');
});

it('offers workflow navigation without receiving a second project-state model', () => {
  const markup = renderToStaticMarkup(createElement(BundleWorkflow, { onNavigate: () => undefined }));

  expect(markup).toContain('>Skills<');
  expect(markup).toContain('>Hooks<');
  expect(markup).toContain('>Playground<');
  expect(markup).toContain('>MCP<');
  expect(markup).toContain('>Evals<');
  expect(markup).toContain('>Artifacts<');
});
