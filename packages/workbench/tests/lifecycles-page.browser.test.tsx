import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { afterAll, beforeAll } from '@rstest/core';
import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { closeServer } from './support/http.ts';
import { workbenchBrowserAliases } from './support/workbench-browser-modules.ts';

const workspaceRoot = process.cwd();
const browserTimeout = 8_000 * timeScale;
const fixtureEntry = join(
  workspaceRoot,
  'packages',
  'workbench',
  'tests',
  'fixtures',
  'lifecycles-page-browser-fixture.tsx',
);

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Lifecycle browser fixture did not receive a TCP address.');
  }
  return `http://127.0.0.1:${String(address.port)}`;
};

const buildFixture = async (): Promise<Readonly<{ close: () => Promise<void>; url: string }>> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-lifecycles-browser-'));
  const dist = join(root, 'dist');
  const rsbuild = await createRsbuild({
    config: {
      output: {
        cleanDistPath: false,
        distPath: { css: 'assets', js: 'assets', root: dist },
        filename: { css: '[name].css', js: '[name].js' },
        filenameHash: false,
      },
      plugins: [pluginReact()],
      resolve: { alias: workbenchBrowserAliases },
      source: {
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        entry: { page: fixtureEntry },
      },
    },
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  if (!(await readdir(dist, { recursive: true })).includes('page.html')) {
    await rm(root, { force: true, recursive: true });
    throw new Error('Lifecycle browser fixture did not produce its browser document.');
  }
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = pathname === '/' ? 'page.html' : pathname.slice(1);
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      const contentType = asset.endsWith('.css')
        ? 'text/css'
        : asset.endsWith('.js')
          ? 'text/javascript'
          : 'text/html';
      response.writeHead(200, { 'content-type': contentType }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const origin = await listen(server);
  return Object.freeze({
    close: async () => {
      await closeServer(server);
      await rm(root, { force: true, recursive: true });
    },
    url: `${origin}/page.html`,
  });
};

let fixture: Awaited<ReturnType<typeof buildFixture>>;

beforeAll(async () => {
  fixture = await buildFixture();
}, 45_000 * timeScale);

afterAll(async () => {
  await fixture?.close();
});

e2e('replays fixture and observed receipts across two materially different hosts', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(`${fixture.url}?scenario=normal`);
    const selector = page.getByLabel('Lifecycle and target');
    await expect(selector).toHaveValue('claude/event:tool/after', { timeout: browserTimeout });
    await expect(page.getByText('Portable cannot project tool/after.')).toBeVisible();
    await expect(page.getByText('Fixture', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByLabel('Replay provenance')).toContainText('Fixture');
    await expect(page.getByLabel('Replay provenance')).toContainText('not evidence that claude dispatched this event');
    await expect(page.getByLabel('Agent Document', { exact: true })).toContainText('Recorded browser.txt from lifecycle replay.');
    await expect(page.getByLabel('Agent Document event timeline')).toContainText('Complete');

    const input = page.locator('#lifecycle-native-input');
    await input.fill('{"edited":true}');
    await expect(page.getByText(/Edited fixture JSON is treated as observed input/u)).toBeVisible();
    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByLabel('Replay provenance')).toContainText('Observed');

    await selector.selectOption('codex/event:tool/after');
    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByLabel('Replay provenance')).toContainText('codex');
    await expect(page.getByText('tool-complete', { exact: true }).first()).toBeVisible();

    await page.getByRole('radio', { name: 'Observed native receipt' }).click();
    await input.fill('{"event":"observed-tool-complete"}');
    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByLabel('Replay provenance')).toContainText('Observed');

    await input.fill('{"unsupported":true}');
    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByText('The native receipt is unsupported.')).toBeVisible();
    await expect(page.getByText('lifecycle.native.unsupported')).toBeVisible();

    const stats = await page.evaluate(() => globalThis.__lifecyclesPageFixture.stats());
    expect(stats.requests).toMatchObject([
      { binding: { target: 'claude' }, source: 'fixture' },
      { binding: { target: 'claude' }, native: { edited: true }, source: 'observed' },
      { binding: { target: 'codex' }, source: 'fixture' },
      { binding: { target: 'codex' }, native: { event: 'observed-tool-complete' }, source: 'observed' },
      { native: { unsupported: true } },
    ]);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
  }
});

e2e('repairs a stale digest without silently rebinding or discarding the draft', async ({ page }) => {
  try {
    await page.goto(`${fixture.url}?scenario=stale`);
    const input = page.locator('#lifecycle-native-input');
    await expect(input).toHaveValue(/PostToolUse/u, { timeout: browserTimeout });
    await input.fill('{"custom":"preserved"}');
    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByRole('heading', { name: 'Stale compiled manifest' })).toBeVisible();
    await expect(page.getByText('The compiled manifest changed.')).toBeVisible();

    await page.getByRole('button', { name: 'Refresh lifecycle list' }).click();
    await expect(page.getByText(/run replay explicitly against the current manifest/u)).toBeVisible();
    await expect(input).toHaveValue('{"custom":"preserved"}');
    let stats = await page.evaluate(() => globalThis.__lifecyclesPageFixture.stats());
    expect(stats.requests).toHaveLength(1);

    await page.getByRole('button', { name: 'Run replay' }).click();
    await expect(page.getByLabel('Replay provenance')).toContainText('Observed');
    stats = await page.evaluate(() => globalThis.__lifecyclesPageFixture.stats());
    expect(stats.requests).toHaveLength(2);
    expect(stats.requests[1]).toMatchObject({
      binding: { manifestDigest: 'manifest-b' },
      native: { custom: 'preserved' },
      source: 'observed',
    });
  } finally {
    await page.close();
  }
});

e2e('aborts and ignores a lifecycle list superseded by a manifest change', async ({ page }) => {
  try {
    await page.goto(`${fixture.url}?scenario=abort`);
    await page.waitForFunction(() => globalThis.__lifecyclesPageFixture.stats().listCalls === 1);
    await page.evaluate(() => globalThis.__lifecyclesPageFixture.rerender?.());
    await expect(page.getByLabel('Lifecycle and target')).toHaveValue(
      'codex/event:session/start',
      { timeout: browserTimeout },
    );
    expect(
      await page.evaluate(() => globalThis.__lifecyclesPageFixture.stats().staleSignalAborted),
    ).toBe(true);

    await page.evaluate(() => globalThis.__lifecyclesPageFixture.resolveStale?.());
    await page.waitForTimeout(25);
    await expect(page.getByLabel('Lifecycle and target')).toHaveValue('codex/event:session/start');
  } finally {
    await page.close();
  }
});
