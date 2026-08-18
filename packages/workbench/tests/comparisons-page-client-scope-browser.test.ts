import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const workspaceRoot = process.cwd();
const comparisonsPage = join(workspaceRoot, 'packages', 'workbench', 'src', 'comparisons', 'comparisons-page.tsx');
const browserTimeout = 8_000;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1024 } },
  } satisfies PlaywrightOptions,
});

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Comparison client-scope fixture did not receive a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
};

const mountedComparisonsFixture = async (): Promise<{ readonly close: () => Promise<void>; readonly url: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-comparisons-client-scope-'));
  const entry = join(root, 'page.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { flushSync } from 'react-dom';",
    "import { createRoot } from 'react-dom/client';",
    `import { ComparisonsPage } from ${JSON.stringify(comparisonsPage)};`,
    '',
    "const deferred = () => { let resolve; const promise = new Promise((nextResolve) => { resolve = nextResolve; }); return { promise, resolve }; };",
    "const digest = 'a'.repeat(64); const identifier = `a${'b'.repeat(127)}`;",
    "const run = (id) => ({ agentBundleVersion: '0.1.0', artifact: { manifestPath: 'manifest.json', source: 'run-owned', targetDigests: { portable: digest } }, createdAt: '2026-08-18T00:00:00.000Z', harness: 'deterministic', id, projectRevision: digest, schemaVersion: 1 });",
    "const metrics = (runId) => ({ durationMs: 1, evidence: 'smoke', fail: 0, harnessFailures: 0, inconclusive: 0, meanDurationMs: 1, outcome: 'pass', passRate: 1, passes: 1, provenance: { hostCliVersion: identifier, invocation: `explicit:${identifier}`, semanticGrader: `${identifier}@${identifier}/v1` }, runId, trials: 1, usage: { inputTokens: 1, outputTokens: 1, recordedTrials: 1, totalTokens: 2 } });",
    "const comparison = (id) => ({ baselineRunId: `${id}-base`, candidateRunId: `${id}-candidate`, rows: [{ baseline: metrics(`${id}-base`), candidate: metrics(`${id}-candidate`), caseId: id, comparable: true, delta: { meanDurationMs: 0, passRate: 0, passes: 0, totalTokens: 0, trials: 0 }, evidence: 'smoke', host: 'portable', model: 'deterministic', unverifiedFacets: [] }], sampleSize: 1, summary: { comparable: 1, nonComparable: 0, reliability: 0, smoke: 1 } });",
    "const runs = (id) => [run(`${id}-base`), run(`${id}-candidate`)];",
    "let compareCallsA = 0; let lateA = deferred(); let signalA;",
    "const comparisonClientA = { compare: (_request, signal) => { compareCallsA += 1; signalA = signal; return compareCallsA === 1 ? Promise.resolve(comparison('settled-a')) : lateA.promise; }, forgetAuthentication: () => undefined };",
    "const evalClientA = { runs: () => Promise.resolve(runs('settled-a')) };",
    "const comparisonClientB = { compare: () => Promise.resolve(comparison('client-b')), forgetAuthentication: () => undefined };",
    "const evalClientB = { runs: () => Promise.resolve(runs('client-b')) };",
    "const root = createRoot(document.getElementById('root'));",
    "const mount = (comparisonClient, evalClient) => flushSync(() => root.render(React.createElement(ComparisonsPage, { comparisonClient, evalClient })));",
    'mount(comparisonClientA, evalClientA);',
    'globalThis.__comparisonsClientScopeFixture = {',
    '  replaceWithB: () => mount(comparisonClientB, evalClientB),',
    "  resolveLateA: () => lateA.resolve(comparison('late-a')),",
    '  stats: () => ({ compareCallsA, signalAborted: signalA?.aborted === true }),',
    '};',
  ].join('\n'));
  const rsbuild = await createRsbuild({
    config: {
      output: {
        cleanDistPath: false,
        distPath: { css: 'assets', js: 'assets', root: dist },
        filename: { css: '[name].css', js: '[name].js' },
        filenameHash: false,
      },
      plugins: [pluginReact()],
      resolve: {
        alias: {
          react: join(workspaceRoot, 'node_modules', 'react'),
          'react-dom': join(workspaceRoot, 'node_modules', 'react-dom'),
          'react-dom/client': join(workspaceRoot, 'node_modules', 'react-dom', 'client.js'),
        },
      },
      source: {
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        entry: { page: entry },
      },
    },
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const assets = await readdir(dist, { recursive: true });
  if (!assets.includes('page.html')) throw new Error('Comparison client-scope fixture did not produce its browser document.');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = pathname === '/' ? 'page.html' : pathname.slice(1);
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) return response.writeHead(404).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const origin = await listen(server);
  return {
    close: async () => {
      await closeServer(server);
      await rm(root, { force: true, recursive: true });
    },
    url: `${origin}/page.html`,
  };
};

e2e('aborts and hides a stale comparison synchronously when its client is replaced', { timeout: 45_000 }, async ({ page }) => {
  const fixture = await mountedComparisonsFixture();
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(fixture.url);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => '__comparisonsClientScopeFixture' in globalThis)).toBe(true);
    const compare = page.getByRole('button', { name: 'Compare runs' });
    expect(await page.locator('body').innerText()).toContain('Compare runs');
    await expect(compare).toBeEnabled({ timeout: browserTimeout });
    await compare.click();
    await page.waitForTimeout(100);
    expect(await page.locator('body').innerText()).toContain('settled-a');
    const layout = await page.evaluate(() => {
      const table = document.querySelector('.comparison-matrix table');
      const values = [...document.querySelectorAll('.comparison-cell-rows dd')];
      return {
        contained: document.documentElement.scrollWidth <= window.innerWidth && values.every((value) => value.scrollWidth <= value.clientWidth),
        tableLayout: table === null ? undefined : getComputedStyle(table).tableLayout,
      };
    });
    expect(layout).toEqual({ contained: true, tableLayout: 'fixed' });

    await compare.click();
    await page.waitForFunction(() => (globalThis as typeof globalThis & {
      __comparisonsClientScopeFixture: { stats(): { readonly compareCallsA: number } };
    }).__comparisonsClientScopeFixture.stats().compareCallsA === 2);
    await page.evaluate(() => (globalThis as typeof globalThis & {
      __comparisonsClientScopeFixture: { replaceWithB(): void };
    }).__comparisonsClientScopeFixture.replaceWithB());
    expect(await page.locator('body').innerText()).not.toContain('settled-a');
    expect(await page.evaluate(() => (globalThis as typeof globalThis & {
      __comparisonsClientScopeFixture: { stats(): { readonly signalAborted: boolean } };
    }).__comparisonsClientScopeFixture.stats().signalAborted)).toBe(true);

    await page.evaluate(() => (globalThis as typeof globalThis & {
      __comparisonsClientScopeFixture: { resolveLateA(): void };
    }).__comparisonsClientScopeFixture.resolveLateA());
    await page.waitForTimeout(25);
    expect(await page.locator('body').innerText()).not.toContain('late-a');
    await expect(page.locator('#comparison-base')).toHaveValue('client-b-base');
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
