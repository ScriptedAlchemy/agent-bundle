import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';

import { createRsbuild, type RsbuildConfig } from '@rsbuild/core';
import { chromium } from 'playwright';
import { describe, expect, it } from '@rstest/core';

import { createWorkbenchConfig } from '../rsbuild.config.ts';

const contentType = (path: string): string => path.endsWith('.css')
  ? 'text/css'
  : path.endsWith('.js')
    ? 'text/javascript'
    : 'text/html';

const startStaticServer = async (root: string) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = pathname === '/' ? 'runtime-inspector-fixture.html' : pathname.slice(1);
    const path = normalize(join(root, file));
    if (relative(root, path).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then((body) => response.writeHead(200, { 'content-type': contentType(path) }).end(body), () => response.writeHead(404).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Runtime Inspector fixture did not expose a TCP address.');
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const fixtureSource = (root: string): string => `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { RuntimeInspector } from ${JSON.stringify(join(root, 'packages/workbench/src/runtime-inspector.tsx'))};

  const surface = { fixtures: [], id: 'tool/customer', kind: 'mcp-tool', label: 'Get customer', readOnly: false, targets: ['portable'] } as const;
  const run = {
    completedAt: '2026-08-15T12:00:01.000Z', id: 'run-customer', input: { customer_id: 'cust_12345' },
    result: {
      flight: { bytes: 24, preview: 'Flight payload', truncated: false },
      protocol: { jsonrpc: '2.0', method: 'tools/call' },
      state: { identity: { stateStoreId: 'state-customer', stateVersion: 2 }, snapshot: { customer_id: 'cust_12345' } },
      trace: [
        { id: 'render', phase: 'rsc-render', startedAt: '2026-08-15T12:00:00.000Z', status: 'succeeded' },
        { id: 'decode', parentId: 'render', phase: 'flight-decode', startedAt: '2026-08-15T12:00:01.000Z', status: 'succeeded' },
      ],
      tree: [{ children: [{ children: [], id: 'heading', kind: 'text', label: 'Customer Lookup' }], id: 'root', kind: 'component', label: 'CustomerLookupApp', props: { id: 'cust_12345' } }],
    },
    startedAt: '2026-08-15T12:00:00.000Z', status: 'succeeded', surfaceId: 'tool/customer', target: 'portable',
    vector: { providerSessionId: 'provider', runtimeGenerationId: 'generation', sourceRevision: 'source', stateStoreId: 'state-customer', stateVersion: 2 },
  } as const;
  const agentDocument = {
    root: { children: [{ kind: 'markdown', text: '# Customer document' }], kind: 'result' },
    status: 'success', version: 1,
  } as const;
  createRoot(document.getElementById('root')!).render(<RuntimeInspector
    loadDocumentEvents={async () => [
      { document: agentDocument, sequence: 0, type: 'shell' },
      { completed: 1, message: 'Loaded', sequence: 1, total: 1, type: 'progress' },
      { document: agentDocument, sequence: 2, type: 'complete' },
    ]}
    run={run}
    surface={surface}
  />);
`;

describe('Runtime inspector', () => {
  it('renders the six accessible panels, decoded tree, shared protocol, and provider-only render trace in the production bundle', async () => {
    const root = process.cwd();
    const temp = await mkdtemp(join(root, 'packages/workbench/.runtime-inspector-'));
    const entry = join(temp, 'runtime-inspector-fixture.tsx');
    const output = join(temp, 'dist');
    await writeFile(entry, fixtureSource(root));
    const config: RsbuildConfig = createWorkbenchConfig();
    config.source = {
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      entry: { 'runtime-inspector-fixture': entry },
    };
    config.output = { ...config.output, distPath: { root: output } };
    const rsbuild = await createRsbuild({ config });
    const buildResult = await rsbuild.build();
    await buildResult.close();
    const { server, url } = await startStaticServer(output);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await page.getByText('Decoded React tree', { exact: true }).waitFor({ timeout: 5_000 });
      expect(await page.getByRole('tab').allTextContents()).toEqual(['Tree', 'Result', 'Document', 'Flight', 'Protocol', 'State', 'Diagnostics']);
      expect(await page.locator('[role="tree"]').count()).toBe(1);
      expect(await page.locator('[role="treeitem"]').count()).toBe(2);
      expect(await page.locator('[role="treeitem"]').first().getAttribute('aria-level')).toBe('1');
      expect(await page.locator('[role="treeitem"]').first().getAttribute('aria-expanded')).toBe('true');
      expect(await page.getByText('MCP App preview', { exact: true }).count()).toBe(0);

      await page.getByRole('button', { name: 'Show component props' }).click();
      expect(await page.locator('[role="treeitem"] pre code').textContent()).toContain('cust_12345');
      await page.getByRole('button', { name: 'Collapse all' }).click();
      expect(await page.locator('[role="treeitem"]').count()).toBe(1);
      expect(await page.locator('[role="treeitem"]').first().getAttribute('aria-expanded')).toBe('false');
      await page.getByRole('button', { name: 'Expand all' }).click();
      expect(await page.locator('[role="treeitem"]').count()).toBe(2);

      await page.getByRole('tab', { name: 'Document' }).click();
      await page.getByRole('heading', { name: 'Customer document' }).waitFor({ timeout: 5_000 });
      expect(await page.getByLabel('Agent Document', { exact: true }).textContent()).toContain('Version 1 · success');
      expect(await page.getByLabel('Agent Document', { exact: true }).textContent()).toContain('Loaded · 1 / 1');

      await page.getByRole('tab', { name: 'Protocol' }).click();
      await page.getByText('Provider MCP protocol', { exact: true }).waitFor({ timeout: 5_000 });
      expect(await page.getByText('tools/call', { exact: false }).count()).toBeGreaterThan(0);

      await page.getByRole('tab', { name: 'Diagnostics' }).click();
      await page.getByText('Render trace', { exact: true }).waitFor({ timeout: 5_000 });
      const trace = await page.locator('[aria-label="Runtime render trace"]').textContent();
      expect(trace!.indexOf('rsc-render')).toBeLessThan(trace!.indexOf('flight-decode'));
      expect(trace).not.toContain('W17');
      expect(await page.getByText('Replay', { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(temp, { force: true, recursive: true });
    }
  }, 30_000);
});
