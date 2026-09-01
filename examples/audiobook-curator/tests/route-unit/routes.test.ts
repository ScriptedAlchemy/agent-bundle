import { expect, it } from '@rstest/core';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

/**
 * The route-unit proof level for this example: it proves the curator's route
 * modules render to the Agent Documents they claim. The manifest below is the
 * framework compiler's own route compilation — the same one the build uses —
 * delivered without building an artifact. It is not transport, packed-artifact,
 * or host proof.
 */
const manifest = testManifest();

it('compiles the curator routes through the framework test manifest, with no build', () => {
  expect(manifest.proofLevel).toBe('route-unit');
  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(Object.keys(manifest.routes)).toContain('prompt:curator/curate');
});

it('renders the curation prompt route into a final Agent Document', async () => {
  const rendered = await renderRoute('prompt:curator/curate', { input: { root: '/library' } });

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('Evidence-first curation prompt ready.')
    .toHaveValue({
      messages: [{
        content: {
          text: 'Inspect /library, retain evidence, and require review before mutation.',
          type: 'text',
        },
        role: 'user',
      }],
    });
  expect(rendered.provenance).toMatchObject({ proofLevel: 'route-unit', routeId: 'prompt:curator/curate' });
});
