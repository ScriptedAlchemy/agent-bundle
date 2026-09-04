import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from '@rstest/core';
import { expectDocument, renderRoute, withTestState } from 'agent-bundle/test';

import * as ReviewCurationShelfRoute from '../../src/mcp/curator/tools/review_curation_shelf.js';

it('persists an Audible selection across tool renders with the same state handle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-route-unit-state-'));
  const candidates = join(directory, 'candidates.json');
  const generatedAt = '2026-09-02T18:00:00.000Z';
  await writeFile(candidates, JSON.stringify({
    candidates: [{
      asin: 'B0CURATOR01',
      authors: [{ name: 'Ada Author' }],
      evidence: {
        authorMatch: true,
        languageMatch: true,
        narratorMatch: true,
        score: 100,
        strictIdentityMatch: true,
        titleMatch: true,
        unabridged: true,
      },
      narrators: [{ name: 'Nora Narrator' }],
      region: 'us',
      title: 'The Persisted Edition',
    }],
    errors: [],
    exitCode: 0,
    generatedAt,
    humanReviewRequired: true,
    mutation: false,
    operation: 'audible-search',
    query: { title: 'The Persisted Edition' },
    reviewNote: 'Choose the matching edition.',
  }));

  try {
    // One mounted shelf state (the project's own `src/state.ts`, in a
    // disposable store) serves both renders, so the review reads the selection.
    await withTestState(async (shelf) => {
      const selected = await renderRoute('tool:curator/select_audible_edition', {
        context: {
          ...shelf.context(),
          invocation: { id: 'state-test:select' },
        },
        input: { candidate: 1, candidates },
      });

      expectDocument(selected)
        .toHaveStatus('success')
        .toContainText('Recorded human-reviewed Audible candidate 1.')
        .toContainMarkdown('The Persisted Edition')
        .toContainMarkdown('B0CURATOR01');
      const receipt = selected.document.value as { readonly generatedAt: string };

      const reviewed = await renderRoute('tool:curator/review_curation_shelf', {
        context: {
          ...shelf.context(),
          invocation: { id: 'state-test:review' },
        },
        input: {},
      });

      expectDocument(reviewed)
        .toHaveStatus('success')
        .toContainMarkdown('The Persisted Edition')
        .toContainMarkdown('B0CURATOR01')
        .toHaveValue({
          mutations: [],
          selections: [{
            asin: 'B0CURATOR01',
            candidateNumber: 1,
            region: 'us',
            selectedAt: receipt.generatedAt,
            title: 'The Persisted Edition',
          }],
        });
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it('renders an honest unavailable shelf without mounted state', async () => {
  const rendered = await renderRoute(ReviewCurationShelfRoute, {
    input: {},
    kind: 'tool',
  });

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('Persisted curation shelf unavailable.')
    .toContainContext('State is not mounted on this invocation surface.')
    .toHaveValue({ mutations: [], selections: [] });
});
