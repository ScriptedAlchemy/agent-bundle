import { expect, it } from '@rstest/core';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

/**
 * The route-unit proof level: the route module rendered through the real Agent
 * renderer, against the manifest this project's own compiler pass produced —
 * no artifact is built, no MCP transport is opened, and no host runs. The
 * protocol projection of the same route is proven one level up, in
 * `tests/projection/mcp-in-memory.test.ts`.
 */
const manifest = testManifest();

it('compiles the status server routes without a build', () => {
  expect(manifest.proofLevel).toBe('route-unit');
  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(Object.keys(manifest.routes)).toContain('tool:status/report-status');
});

it('renders a known service into a final Agent Document', async () => {
  const rendered = await renderRoute('tool:status/report-status', { input: { service: 'docs' } });

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('docs is ready.')
    .toHaveValue({ service: 'docs', status: 'healthy', summary: 'docs is ready.' });
  expect(rendered.provenance).toMatchObject({
    proofLevel: 'route-unit',
    routeId: 'tool:status/report-status',
  });
});

it('renders an unknown service without inventing readiness', async () => {
  const rendered = await renderRoute('tool:status/report-status', { input: { service: 'billing' } });

  // `result` is the document value the route's own resultSchema accepted, so a
  // document that renders but whose value the schema rejects is a failure here.
  expect(rendered.result).toEqual({
    service: 'billing',
    status: 'unknown',
    summary: 'billing is not a known service.',
  });
});
