import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

it('renders the composed library-audit tool document with its canonical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-route-unit-tool-audit-'));
  try {
    const sources = join(directory, 'library');
    await mkdir(sources, { recursive: true });
    const rendered = await renderRoute('tool:curator/audit_library', {
      input: { concurrency: 1, sources: [sources] },
    });
    const receipt = rendered.document.value as {
      readonly duplicateCandidates: readonly unknown[];
      readonly operation: string;
      readonly summary: { readonly files: number };
    };

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainText('Audited 0 library media files')
      .toContainMarkdown('**Files:** 0')
      .toContainContext('review candidates')
      .toHaveValue(receipt);
    expect(receipt).toMatchObject({
      duplicateCandidates: [],
      operation: 'library-audit',
      summary: { files: 0 },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it('renders composed inspection and inventory tool documents with unchanged values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-route-unit-discovery-'));
  try {
    const sources = join(directory, 'library');
    await mkdir(sources, { recursive: true });
    const inspected = await renderRoute('tool:curator/inspect_sources', {
      input: { root: sources },
    });
    const inventoried = await renderRoute('tool:curator/inventory_sources', {
      input: { source: sources },
    });
    const inventoryReceipt = inventoried.document.value as {
      readonly files: readonly unknown[];
      readonly operation: string;
      readonly summary: { readonly files: number };
    };

    expectDocument(inspected)
      .toHaveStatus('success')
      .toContainText('Inspected 0 audio files')
      .toContainMarkdown('**Files:** 0')
      .toHaveValue({
        files: [],
        operation: 'inspect',
        root: sources,
        totalBytes: 0,
      });
    expectDocument(inventoried)
      .toHaveStatus('success')
      .toContainText('Inventoried 0 media files')
      .toContainMarkdown('**Files:** 0')
      .toHaveValue(inventoryReceipt);
    expect(inventoryReceipt).toMatchObject({
      files: [],
      operation: 'inventory',
      summary: { files: 0 },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it('renders the library-audit CLI route with in-flight progress and the canonical receipt (#102 stage 3)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-route-unit-audit-'));
  try {
    const sources = join(directory, 'library');
    const report = join(directory, 'report.json');
    await mkdir(sources, { recursive: true });
    const rendered = await renderRoute('cli:library-audit', {
      input: { concurrency: 1, report, sources: [sources] },
    });

    expectDocument(rendered).toHaveStatus('success').toContainMarkdown('Library audit');
    const receipt = rendered.document.value as {
      readonly exitCode: number;
      readonly operation: string;
      readonly summary: { readonly files: number };
    };
    expect(receipt.operation).toBe('library-audit');
    expect(receipt.exitCode).toBe(0);
    expect(receipt.summary.files).toBe(0);
    // The component reported request-scoped progress around the audit.
    expect(rendered.progress.map((update) => update.completed)).toEqual([0, 1]);
    // The receipt landed in the requested report file, exactly like the
    // pre-migration plain command.
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({ operation: 'library-audit' });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
