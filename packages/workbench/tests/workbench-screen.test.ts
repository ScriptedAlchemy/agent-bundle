import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import { expect, it } from '@rstest/core';

import { legacyPathForHash, Navigation, workbenchPathFor, workbenchRoutes, type WorkbenchPage } from '../src/workbench-screen.tsx';

const pages = (...values: WorkbenchPage[]): ReadonlySet<WorkbenchPage> => new Set(values);

it('renders only available routes in grouped navigation', () => {
  const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/skills'] },
    createElement(Navigation, {
      pages: pages('overview', 'skills', 'artifacts', 'logs', 'evals', 'comparisons'),
    }),
  ));

  expect(markup).toContain('>Build<');
  expect(markup).toContain('>Capabilities<');
  expect(markup).toContain('>Quality<');
  expect(markup).toContain('>Inspect<');
  expect(markup).toContain('>Skills<');
  expect(markup).toContain('href="/skills"');
  expect(markup).toContain('>Evals<');
  expect(markup).not.toContain('>Hooks<');
  expect(markup).not.toContain('MCP playground');
  expect(markup).not.toContain('>Playground<');
});

it('owns each canonical route in one typed catalog', () => {
  expect(workbenchPathFor('skills')).toBe('/skills');
  expect(workbenchRoutes.skills).toEqual({ glyph: '⌘', label: 'Skills', page: 'skills', path: '/skills' });
  expect(workbenchRoutes.overview.path).toBe('/overview');
});

it('rewrites slash-less hashes to React Router paths', () => {
  expect(legacyPathForHash('#skills')).toBe('/skills');
  expect(legacyPathForHash('#/skills')).toBeUndefined();
  expect(legacyPathForHash('#inspector')).toBe('/overview');
  expect(legacyPathForHash('')).toBeUndefined();
});
