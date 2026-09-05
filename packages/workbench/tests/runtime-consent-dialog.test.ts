import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';

import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';
import { browserLaunchOptions } from './support/workbench-e2e.ts';
import { chromium, type Locator } from 'playwright';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const dialogComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'runtime-consent-dialog.tsx');
const queueComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'runtime-consent-queue.ts');

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Consent dialog fixture did not bind a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const mountedConsentFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-consent-dialog-'));
  const entry = join(root, 'consent.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React, { useRef, useState } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { RuntimeConsentDialog } from ${JSON.stringify(dialogComponent)};`,
    `import { createRuntimeConsentQueue } from ${JSON.stringify(queueComponent)};`,
    '',
    "const challenge = (id) => ({ expiresAt: 10, id, request: { actionFingerprint: `runtime-app:${id}:v1`, capability: 'call-tool', details: {}, scope: 'action', summary: 'Call Runtime App tool' } });",
    'const App = () => {',
    '  const [current, setCurrent] = useState();',
    '  const [decisions, setDecisions] = useState([]);',
    '  const queue = useRef();',
    '  if (queue.current === undefined) queue.current = createRuntimeConsentQueue(setCurrent);',
    '  const enqueue = (first, second) => {',
    '    const settle = (id, promise) => { void promise.then((decision) => setDecisions((entries) => [...entries, `${id}:${decision}`])).catch(() => undefined); };',
    '    settle(first, queue.current.request(challenge(first)));',
    '    settle(second, queue.current.request(challenge(second)));',
    '  };',
    '  return <>',
    '    <main id="background" inert={current !== undefined || undefined}>',
    '      <button id="request-allows" onClick={() => enqueue(\'allow-first\', \'allow-second\')} type="button">Request allows</button>',
    '      <button id="request-denies" onClick={() => enqueue(\'deny-first\', \'deny-second\')} type="button">Request denies</button>',
    '    </main>',
    '    {current === undefined ? undefined : <RuntimeConsentDialog current={current} onResolve={(entry, decision) => queue.current.resolve(entry, decision)} />}',
    '    <output id="decisions">{decisions.join(\',\')}</output>',
    '    <output id="visible-position">{current === undefined ? \'none\' : current.challenge.id.endsWith(\'second\') ? \'second\' : \'first\'}</output>',
    '  </>;',
    '};',
    "createRoot(document.getElementById('root')).render(<App />);",
  ].join('\n'));
  const rsbuild = await createRsbuild({
    config: createWorkbenchFixtureConfig({ distRoot: dist, entry: { consent: entry } }),
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const server = createServer(async (request, response) => {
    const asset = request.url === '/' ? 'consent.html' : request.url?.replace(/^\//u, '') ?? '';
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) return response.writeHead(404).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': asset.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const url = await listen(server);
  return {
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); });
      await rm(root, { force: true, recursive: true });
    },
    url: `${url}/consent.html`,
  };
};

const isFocused = async (locator: Locator): Promise<boolean> =>
  locator.evaluate((element) => document.activeElement === element);

const waitForDenyFocus = async (page: import('playwright').Page): Promise<void> => {
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.querySelector('button') === document.activeElement;
  });
};

it('keeps each indistinguishable Runtime App consent gesture bound to its displayed FIFO entry', async () => {
  const fixture = await mountedConsentFixture();
  const browser = await chromium.launch(browserLaunchOptions);
  const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
  try {
    await page.goto(fixture.url);
    const allowTrigger = page.getByRole('button', { name: 'Request allows' });
    const denyTrigger = page.getByRole('button', { name: 'Request denies' });
    const background = page.locator('#background');
    await allowTrigger.focus();
    await allowTrigger.click();
    const dialog = page.getByRole('dialog', { name: 'Runtime App consent' });
    const deny = dialog.getByRole('button', { name: 'Deny' });
    const allow = dialog.getByRole('button', { name: 'Allow once' });
    await page.locator('#runtime-consent-summary').waitFor({ state: 'visible' });
    expect(await page.locator('#runtime-consent-summary').textContent()).toBe('Call Runtime App tool');
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    expect(await background.getAttribute('inert')).toBe('');
    expect(await isFocused(deny)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await isFocused(allow)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await isFocused(deny)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await isFocused(allow)).toBe(true);

    await allow.dblclick();
    await page.waitForFunction(() => document.querySelector('#decisions')?.textContent === 'allow-first:allow-once');
    expect(await background.getAttribute('inert')).toBe('');
    await waitForDenyFocus(page);
    expect(await isFocused(deny)).toBe(true);
    expect(await dialog.isVisible()).toBe(true);
    expect(await page.locator('#decisions').textContent()).toBe('allow-first:allow-once');
    await allow.click();
    await dialog.waitFor({ state: 'hidden' });
    expect(await page.locator('#decisions').textContent()).toBe('allow-first:allow-once,allow-second:allow-once');

    await denyTrigger.focus();
    await denyTrigger.click();
    await page.locator('#runtime-consent-summary').waitFor({ state: 'visible' });
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await page.waitForFunction(() => document.querySelector('#decisions')?.textContent?.includes('deny-first:deny'));
    expect(await page.locator('#decisions').textContent()).toBe('allow-first:allow-once,allow-second:allow-once,deny-first:deny');
    expect(await page.locator('#visible-position').textContent()).toBe('second');
    expect(await background.getAttribute('inert')).toBe('');
    await waitForDenyFocus(page);
    expect(await isFocused(deny)).toBe(true);
    expect(await deny.isDisabled()).toBe(false);
    await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await dialog.waitFor({ state: 'hidden' });
    expect(await background.getAttribute('inert')).toBeNull();
    expect(await isFocused(denyTrigger)).toBe(true);
    expect(await page.locator('#decisions').textContent()).toBe('allow-first:allow-once,allow-second:allow-once,deny-first:deny,deny-second:deny');
  } finally {
    await browser.close();
    await fixture.close();
  }
}, 30_000);
