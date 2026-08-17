import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
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
    "const challenge = (id) => ({ expiresAt: 10, id, request: { actionFingerprint: `runtime-app:${id}:v1`, capability: 'call-tool', details: {}, scope: 'action', summary: `Call ${id}` } });",
    'const App = () => {',
    '  const [current, setCurrent] = useState();',
    '  const [decisions, setDecisions] = useState([]);',
    '  const queue = useRef();',
    '  if (queue.current === undefined) queue.current = createRuntimeConsentQueue(setCurrent);',
    '  const request = () => {',
    '    const second = new AbortController();',
    '    globalThis.__abortSecondConsent = () => second.abort(new DOMException(\'Second request cancelled.\', \'AbortError\'));',
    '    const settle = (id, promise) => { void promise.then((decision) => setDecisions((entries) => [...entries, `${id}:${decision}`])).catch(() => undefined); };',
    '    settle(\'first\', queue.current.request(challenge(\'first\')));',
    '    settle(\'second\', queue.current.request(challenge(\'second\'), second.signal));',
    '    settle(\'third\', queue.current.request(challenge(\'third\')));',
    '  };',
    '  return <>',
    '    <main id="background" inert={current !== undefined || undefined}><button id="request" onClick={request} type="button">Request actions</button></main>',
    '    {current === undefined ? undefined : <RuntimeConsentDialog challenge={current} onResolve={(decision) => { queue.current.resolve(decision); }} />}',
    '    <output id="decisions">{decisions.join(\',\')}</output>',
    '  </>;',
    '};',
    "createRoot(document.getElementById('root')).render(<App />);",
  ].join('\n'));
  const rsbuild = await createRsbuild({
    config: {
      output: { assetPrefix: '/', distPath: { root: dist }, filename: { js: '[name].js' } },
      plugins: [pluginReact()],
      resolve: {
        alias: {
          react: join(workspaceRoot, 'node_modules', 'react'),
          'react-dom/client': join(workspaceRoot, 'node_modules', 'react-dom', 'client.js'),
        },
      },
      source: { define: { 'process.env.NODE_ENV': JSON.stringify('production') }, entry: { consent: entry } },
    },
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

it('keeps the queue-driven Runtime App consent dialog modal, focus-contained, and focused on its original trigger after the final settlement', async () => {
  const fixture = await mountedConsentFixture();
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
  try {
    await page.goto(fixture.url);
    const trigger = page.getByRole('button', { name: 'Request actions' });
    const background = page.locator('#background');
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Runtime App consent' });
    const deny = dialog.getByRole('button', { name: 'Deny' });
    const allow = dialog.getByRole('button', { name: 'Allow once' });
    await page.locator('#runtime-consent-summary').waitFor({ state: 'visible' });
    expect(await page.locator('#runtime-consent-summary').textContent()).toBe('Call first');
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    expect(await background.getAttribute('inert')).toBe('');
    expect(await isFocused(deny)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await isFocused(allow)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await isFocused(deny)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await isFocused(allow)).toBe(true);

    await allow.click();
    await page.waitForFunction(() => document.querySelector('#runtime-consent-summary')?.textContent === 'Call second');
    expect(await background.getAttribute('inert')).toBe('');
    expect(await isFocused(deny)).toBe(true);

    await page.evaluate(() => (globalThis as typeof globalThis & { __abortSecondConsent?: () => void }).__abortSecondConsent?.());
    await page.waitForFunction(() => document.querySelector('#runtime-consent-summary')?.textContent === 'Call third');
    expect(await background.getAttribute('inert')).toBe('');
    expect(await isFocused(deny)).toBe(true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await background.getAttribute('inert')).toBeNull();
    expect(await isFocused(trigger)).toBe(true);
    expect(await page.locator('#decisions').textContent()).toBe('first:allow-once,third:deny');
  } finally {
    await browser.close();
    await fixture.close();
  }
}, 30_000);
