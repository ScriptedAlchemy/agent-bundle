import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { Navigation, pageForHash, type WorkbenchPage } from '../src/workbench-screen.tsx';

const pages = (...values: WorkbenchPage[]): ReadonlySet<WorkbenchPage> => new Set(values);

it('renders only available routes in grouped navigation', () => {
  const markup = renderToStaticMarkup(createElement(Navigation, {
    onNavigate: () => undefined,
    page: 'skills',
    pages: pages('overview', 'routes', 'skills', 'artifacts', 'logs', 'evals', 'comparisons'),
  }));

  expect(markup).toContain('>Routes<');
  expect(markup).toContain('>Build<');
  expect(markup).toContain('>Capabilities<');
  expect(markup).toContain('>Quality<');
  expect(markup).toContain('>Inspect<');
  expect(markup).toContain('>Skills<');
  expect(markup).toContain('>Evals<');
  expect(markup).not.toContain('>Hooks<');
  expect(markup).not.toContain('MCP playground');
  expect(markup).not.toContain('>Playground<');
});

it('resolves unsupported and unknown hashes to Overview', () => {
  const available = pages('overview', 'routes', 'skills', 'artifacts', 'logs');

  expect(pageForHash('#skills', available)).toBe('skills');
  expect(pageForHash('#routes', available)).toBe('routes');
  expect(pageForHash('#routes', pages('overview', 'skills'))).toBe('overview');
  expect(pageForHash('#hooks', available)).toBe('overview');
  expect(pageForHash('#unknown', available)).toBe('overview');
  expect(pageForHash('', available)).toBe('overview');
});
