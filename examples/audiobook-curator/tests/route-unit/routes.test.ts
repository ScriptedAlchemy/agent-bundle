import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { expectDocument, invokeMcpTool, renderRoute, testManifest } from 'agent-bundle/test';

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
  // The one shared document shell every rendered curator route composes through.
  expect(manifest.layouts.map((layout) => layout.id)).toEqual(['layout:root']);
});

it('renders the curation prompt route into a final Agent Document', async () => {
  const rendered = await renderRoute('prompt:curator/curate', { input: { root: '/library' } });

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('Curation review prepared.')
    .toHaveValue({
      messages: [{
        content: {
          text: 'Inspect /library through discover, identify, curate, and verify. Retain evidence and require review before any mutation.',
          type: 'text',
        },
        role: 'user',
      }],
    });
  expect(rendered.provenance).toMatchObject({ proofLevel: 'route-unit', routeId: 'prompt:curator/curate' });
  // The layout's shell merged with the route's valued result: one root, the
  // route's value, plus the shell's provenance metadata.
  expect(rendered.document.root.kind === 'result' ? rendered.document.root.metadata : undefined).toEqual({
    curator: { route: 'prompt:curator/curate', server: 'mcp:curator', surface: 'prompt' },
  });
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

    // Over the real protocol the layout leaves `structuredContent` as the
    // route's receipt and hands hosts the shell's provenance as `_meta`.
    const invocation = await invokeMcpTool('audit_library', { input: { concurrency: 1, sources: [sources] } });
    expect(invocation.isError).toBe(false);
    const { generatedAt: _rendered, ...stableReceipt } = receipt as typeof receipt & { readonly generatedAt: string };
    const { generatedAt: _projected, ...stableProjected } = invocation.structuredContent as typeof receipt & { readonly generatedAt: string };
    expect(stableProjected).toEqual(stableReceipt);
    expect(invocation._meta).toEqual({
      curator: { route: 'tool:curator/audit_library', server: 'mcp:curator', surface: 'tool' },
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

it('caps rendered inventory probe errors while retaining the complete receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-route-unit-inventory-errors-'));
  const previousPath = process.env['PATH'];
  try {
    const source = join(directory, 'library');
    await mkdir(source);
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      writeFile(join(source, `broken-${String(index)}.mp3`), 'not audio')));
    process.env['PATH'] = directory;

    const rendered = await renderRoute('tool:curator/inventory_sources', {
      input: { source, strict: true },
    });
    const receipt = rendered.document.value as {
      readonly errors: readonly unknown[];
    };
    if (rendered.document.root.kind !== 'result') throw new Error('expected inventory result document');
    const errorCallouts = rendered.document.root.children.filter((node) => node.kind === 'error');

    expect(receipt.errors).toHaveLength(25);
    expect(errorCallouts).toHaveLength(20);
    expectDocument(rendered)
      .toContainMarkdown('_+5 more probe errors retained in the structured receipt._')
      .toHaveValue(receipt);
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
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
    // The same shell wraps rendered CLI commands; a CLI route has no owning server.
    expect(rendered.document.root.kind === 'result' ? rendered.document.root.metadata : undefined).toEqual({
      curator: { route: 'cli:library-audit', server: null, surface: 'cli' },
    });
    // The component reported request-scoped progress around the audit.
    expect(rendered.progress.map((update) => update.completed)).toEqual([0, 1]);
    // The receipt landed in the requested report file, exactly like the
    // pre-migration plain command.
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({ operation: 'library-audit' });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
