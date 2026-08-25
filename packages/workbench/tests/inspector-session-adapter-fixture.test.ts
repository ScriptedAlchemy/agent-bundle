import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { createRsbuild, type RsbuildConfig } from '@rsbuild/core';
import { chromium } from 'playwright';
import { describe, expect, it } from '@rstest/core';

import { createWorkbenchConfig } from '../rsbuild.config.ts';

interface InspectorSessionAdapterFixtureHarness {
  readonly resolveNextTool: (text: string) => void;
  readonly setRuntimeBinding: (revision: number, definitionDigest: string) => void;
}

const contentType = (path: string): string => path.endsWith('.css')
  ? 'text/css'
  : path.endsWith('.js')
    ? 'text/javascript'
    : 'text/html';

const startStaticServer = async (root: string) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = pathname === '/' ? 'inspector-session-adapter-fixture.html' : pathname.slice(1);
    const path = normalize(join(root, file));
    if (relative(root, path).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then((body) => {
      response.writeHead(200, { 'content-type': contentType(path) }).end(body);
    }, () => response.writeHead(404).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not expose a TCP address.');
  return { server, url: `http://127.0.0.1:${address.port}` };
};

describe('Inspector session adapter production fixture', () => {
  it('builds the styled entry and mounts all five Inspector presentations in Chrome', async () => {
    const output = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-fixture-'));
    const config: RsbuildConfig = createWorkbenchConfig();
    config.source = {
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      entry: { 'inspector-session-adapter-fixture': join(process.cwd(), 'packages/workbench/src/inspector/adapter/inspector-session-adapter-fixture.tsx') },
    };
    config.output = { ...config.output, distPath: { root: output } };
    const rsbuild = await createRsbuild({ config });
    await rsbuild.build();
    const { server, url } = await startStaticServer(output);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(100);
      expect(errors).toEqual([]);

      await page.getByText('fixture-tool', { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByText('Render trace', { exact: true }).waitFor({ timeout: 5_000 });
      for (const [label, expected] of [
        ['Resources', 'fixture-resource'],
        ['Prompts', 'fixture-prompt'],
        ['Protocol', 'Messages'],
        ['Logging', 'Log-level changes are unavailable because this W13 session does not expose logging/setLevel.'],
      ] as const) {
        await page.getByRole('button', { name: label }).click();
        await page.getByText(expected, { exact: true }).waitFor({ timeout: 5_000 });
      }

      await page.getByRole('button', { name: 'Protocol' }).click();
      await page.locator('[data-protocol-frame="request:tools/call"]').waitFor({ timeout: 5_000 });
      expect(await page.locator('[data-protocol-sequence]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-protocol-sequence')))).toEqual(['1', '2', '3', '4']);
      expect(await page.locator('[data-protocol-frame="response:2"]').count()).toBe(1);
      expect(await page.locator('link[rel="stylesheet"]').count()).toBeGreaterThan(0);
      expect(await page.locator('[aria-label="Replay"]').count()).toBe(0);
      expect(await page.getByText('Set Active Level', { exact: true }).count()).toBe(0);
      const runtimeTrace = await page.locator('[aria-label="Runtime render trace"]').textContent();
      expect(runtimeTrace!.indexOf('rsc-render')).toBeLessThan(runtimeTrace!.indexOf('flight-decode'));
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(output, { force: true, recursive: true });
    }
  }, 30_000);

  it('resets the committed runtime revision under StrictMode without admitting stale screen completions', async () => {
    const output = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-fixture-'));
    const config: RsbuildConfig = createWorkbenchConfig();
    config.source = {
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      entry: { 'inspector-session-adapter-fixture': join(process.cwd(), 'packages/workbench/src/inspector/adapter/inspector-session-adapter-fixture.tsx') },
    };
    config.output = { ...config.output, distPath: { root: output } };
    const rsbuild = await createRsbuild({ rsbuildConfig: config });
    await rsbuild.build();
    const { server, url } = await startStaticServer(output);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(100);

      const harnessAvailable = await page.evaluate(() => typeof (window as Window & {
        __inspectorSessionAdapterFixture?: unknown;
      }).__inspectorSessionAdapterFixture === 'object');
      expect(harnessAvailable).toBe(true);

      await page.evaluate(() => {
        const harness = (window as Window & { __inspectorSessionAdapterFixture?: InspectorSessionAdapterFixtureHarness }).__inspectorSessionAdapterFixture;
        if (harness === undefined) throw new Error('Inspector fixture harness was not installed.');
        harness.setRuntimeBinding(3, 'definition-revision-3');
      });
      await page.getByText('fixture-tool', { exact: true }).click();
      await page.getByRole('button', { name: 'Execute Tool' }).click();
      await page.evaluate(() => {
        const harness = (window as Window & { __inspectorSessionAdapterFixture?: InspectorSessionAdapterFixtureHarness }).__inspectorSessionAdapterFixture;
        if (harness === undefined) throw new Error('Inspector fixture harness was not installed.');
        harness.resolveNextTool('completed tool result');
      });
      await page.getByText('completed tool result', { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Protocol' }).click();
      await page.locator('[data-protocol-frame="request:tools/call"]').waitFor({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByText('No request history', { exact: true }).waitFor({ timeout: 5_000 });

      await page.evaluate(() => {
        const harness = (window as Window & { __inspectorSessionAdapterFixture?: InspectorSessionAdapterFixtureHarness }).__inspectorSessionAdapterFixture;
        if (harness === undefined) throw new Error('Inspector fixture harness was not installed.');
        harness.setRuntimeBinding(3, 'definition-digest-only');
      });
      await page.getByText('No request history', { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Tools' }).click();
      await page.getByText('completed tool result', { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Close results' }).click();
      await page.getByRole('button', { name: 'Execute Tool' }).click();
      await page.getByRole('button', { name: 'Cancel' }).waitFor({ timeout: 5_000 });

      await page.evaluate(() => {
        const harness = (window as Window & { __inspectorSessionAdapterFixture?: InspectorSessionAdapterFixtureHarness }).__inspectorSessionAdapterFixture;
        if (harness === undefined) throw new Error('Inspector fixture harness was not installed.');
        harness.setRuntimeBinding(4, 'definition-revision-4');
      });
      await page.getByText('Select a tool to view details', { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Protocol' }).click();
      await page.locator('[data-protocol-frame="request:tools/call"]').waitFor({ timeout: 5_000 });

      await page.evaluate(() => {
        const harness = (window as Window & { __inspectorSessionAdapterFixture?: InspectorSessionAdapterFixtureHarness }).__inspectorSessionAdapterFixture;
        if (harness === undefined) throw new Error('Inspector fixture harness was not installed.');
        harness.resolveNextTool('stale tool result');
      });
      await page.waitForTimeout(100);
      expect(await page.getByText('stale tool result', { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(output, { force: true, recursive: true });
    }
  }, 30_000);
});
