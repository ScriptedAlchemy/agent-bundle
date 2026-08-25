import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { BundleWorkflow } from '../src/overview-page.tsx';

it('introduces the bundle dashboard and its author-to-evidence workflow', () => {
  const markup = renderToStaticMarkup(createElement(BundleWorkflow, { onNavigate: () => undefined }));

  expect(markup).toContain('Bundle dashboard');
  expect(markup).toContain('Author once, exercise host-ready behavior, and evaluate durable evidence.');
});

it('groups workflow navigation by the author, build, exercise, and evaluate lifecycle', () => {
  const markup = renderToStaticMarkup(createElement(BundleWorkflow, { onNavigate: () => undefined }));
  const stages = [...markup.matchAll(/<li>(.*?)<\/li>/gu)].map((match) => match[1]!);
  const headings = [...markup.matchAll(/<h2>(.*?)<\/h2>/gu)].map((match) => match[1]!);

  expect(stages).toHaveLength(4);
  expect(headings).toEqual(['Author', 'Build', 'Exercise', 'Evaluate']);
  expect(markup).not.toMatch(/<h2>[1-4]\.\s/gu);
  expect(stages[0]).toContain('>Author<');
  expect(stages[0]).toContain('>Skills<');
  expect(stages[0]).toContain('>Hooks<');
  expect(stages[1]).toContain('>Build<');
  expect(stages[1]).toContain('>Artifacts<');
  expect(stages[2]).toContain('>Exercise<');
  expect(stages[2]).toContain('>Skills<');
  expect(stages[2]).toContain('>Hooks<');
  expect(stages[2]).toContain('>Playground<');
  expect(stages[2]).toContain('>MCP<');
  expect(stages[3]).toContain('>Evaluate<');
  expect(stages[3]).toContain('>Evals<');
  expect(stages[3]).toContain('>Comparisons<');
});
