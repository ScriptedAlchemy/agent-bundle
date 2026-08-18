import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const workspaceRoot = process.cwd();
const playgroundPage = join(workspaceRoot, 'packages', 'workbench', 'src', 'playground', 'playground-page.tsx');
const browserTimeout = 8_000;

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
  if (address === null || typeof address === 'string') throw new Error('Playground client-scope fixture did not receive a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
};

const mountedPlaygroundClientScopeFixture = async (): Promise<{ readonly close: () => Promise<void>; readonly url: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-playground-client-scope-'));
  const entry = join(root, 'page.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { flushSync } from 'react-dom';",
    "import { createRoot } from 'react-dom/client';",
    `import { PlaygroundPage } from ${JSON.stringify(playgroundPage)};`,
    '',
    "const deferred = () => { let resolve; const promise = new Promise((nextResolve) => { resolve = nextResolve; }); return { promise, resolve }; };",
    "const identity = { epoch: { digest: 'sha256-a', id: 'epoch-a' }, fixture: { digest: 'sha256-fixture', id: 'fixture-a' }, invocation: { intent: { skillId: 'review' }, kind: 'skill.inspect' }, target: { digest: 'sha256-portable', name: 'portable' }, task: { id: 'task-a', text: 'Review.' } };",
    "const openSession = { cleanupFailures: [], createdAt: '2026-08-18T00:00:00.000Z', id: 'session-a', identity, state: 'open' };",
    "const terminalSession = { ...openSession, outcome: { status: 'passed' }, state: 'finalized' };",
    "const openRun = { id: 'run-a', session: openSession }; const terminalRun = { id: 'run-a', session: terminalSession };",
    "const event = (summary) => ({ kind: 'native.response', raw: { summary }, rawEventRef: 'events.jsonl#1', sequence: 1, source: 'response', summary, timestamp: '2026-08-18T00:00:01.000Z' });",
    "const replay = (session, events = []) => ({ cursor: { afterSequence: events.at(-1)?.sequence ?? 0 }, events, session });",
    "const exported = { events: [event('Late export evidence')], schemaVersion: 1, session: terminalSession };",
    "const draft = { assertions: [{ evidence: { rawEventRef: 'events.jsonl#1' }, expectation: { kind: 'native.response' }, id: 'assertion-a', kind: 'evidence' }], epoch: identity.epoch, fixture: identity.fixture, invocation: identity.invocation, outcome: { status: 'passed' }, schemaVersion: 1, target: identity.target, task: identity.task };",
    "let mode = 'start'; let action = deferred(); let callbacks = []; let signals = {}; let calls = { cancel: 0, export: 0, promote: 0, start: 0 };",
    'const clientA = {',
    "  run: (_input, signal) => { calls.start += 1; signals.start = signal; return action.promise; },",
    "  cancel: (_runId, signal) => { calls.cancel += 1; signals.cancel = signal; return action.promise; },",
    "  replay: (_sessionId, _after, signal) => { signals.replay = signal; return Promise.resolve(replay(mode === 'cancel' ? terminalSession : terminalSession, mode === 'cancel' ? [event('Late cancel evidence')] : [event('Initial evidence')])); },",
    "  session: (_sessionId, signal) => { signals.session = signal; return Promise.resolve(openSession); },",
    "  stream: () => { const done = deferred(); return { close: () => done.resolve(), done: done.promise }; },",
    "  export: (_sessionId, signal) => { calls.export += 1; signals.export = signal; return action.promise; },",
    "  promoteToDraftEval: (_sessionId, _refs, signal) => { calls.promote += 1; signals.promote = signal; return action.promise; },",
    '};',
    'const clientB = { ...clientA,',
    "  cancel: () => Promise.reject(new Error('client B should not receive client-A cancellation')),",
    "  export: () => Promise.reject(new Error('client B should not receive client-A export')),",
    "  promoteToDraftEval: () => Promise.reject(new Error('client B should not receive client-A promotion')),",
    "  run: () => Promise.reject(new Error('client B should not receive client-A start')),",
    '};',
    "const epoch = { digest: 'sha256-current', id: 'epoch-current' };",
    "const root = createRoot(document.getElementById('root'));",
    "const mount = (client, run) => flushSync(() => root.render(React.createElement(PlaygroundPage, { client, epoch, onRunChange: (next) => callbacks.push(next?.id), run, scripts: [], targets: [{ digest: 'sha256-portable', name: 'portable' }] })));",
    'const prepare = (nextMode) => {',
    '  mode = nextMode; action = deferred(); callbacks = []; signals = {}; calls = { cancel: 0, export: 0, promote: 0, start: 0 };',
    "  mount(clientA, nextMode === 'start' ? undefined : nextMode === 'cancel' ? openRun : terminalRun);",
    '};',
    'globalThis.__playgroundClientScopeFixture = {',
    '  prepare, replaceWithB: () => mount(clientB, undefined),',
    "  resolve: () => action.resolve(mode === 'start' ? terminalRun : mode === 'cancel' ? replay(terminalSession, [event('Late cancel evidence')]) : mode === 'export' ? exported : draft),",
    '  stats: () => ({ callbacks: [...callbacks], calls: { ...calls }, signals: Object.fromEntries(Object.entries(signals).map(([key, signal]) => [key, signal?.aborted === true])) }),',
    '};',
    "prepare('start');",
    '',
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
  if (!assets.includes('page.html')) throw new Error('Playground client-scope fixture did not produce its browser document.');
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

e2e('rejects every late client-A Playground action after a synchronously mounted client-B replacement', { timeout: 45_000 }, async ({ page }) => {
  const fixture = await mountedPlaygroundClientScopeFixture();
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(fixture.url);
    await page.waitForFunction(() => '__playgroundClientScopeFixture' in globalThis);
    const replaceWithB = async (): Promise<number> => {
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __playgroundClientScopeFixture: { replaceWithB(): void; stats(): { readonly callbacks: readonly unknown[] } };
      }).__playgroundClientScopeFixture.replaceWithB());
      await page.waitForTimeout(0);
      return await page.evaluate(() => (globalThis as typeof globalThis & {
        __playgroundClientScopeFixture: { stats(): { readonly callbacks: readonly unknown[] } };
      }).__playgroundClientScopeFixture.stats().callbacks.length);
    };
    const stats = async () => page.evaluate(() => (globalThis as typeof globalThis & {
      __playgroundClientScopeFixture: { stats(): { readonly callbacks: readonly string[]; readonly calls: Readonly<Record<string, number>>; readonly signals: Readonly<Record<string, boolean>> } };
    }).__playgroundClientScopeFixture.stats());
    const resolve = async () => page.evaluate(() => (globalThis as typeof globalThis & {
      __playgroundClientScopeFixture: { resolve(): void };
    }).__playgroundClientScopeFixture.resolve());

    await page.evaluate(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { prepare(mode: string): void } }).__playgroundClientScopeFixture.prepare('start'));
    await page.locator('#playground-target').selectOption('portable');
    await page.locator('#playground-skill-id').fill('review');
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.waitForFunction(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { stats(): { readonly calls: { readonly start: number } } } }).__playgroundClientScopeFixture.stats().calls.start === 1);
    const startCallbacks = await replaceWithB();
    await resolve();
    await page.waitForTimeout(25);
    expect((await stats()).callbacks).toHaveLength(startCallbacks);
    expect((await stats()).signals.start).toBe(true);

    await page.evaluate(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { prepare(mode: string): void } }).__playgroundClientScopeFixture.prepare('cancel'));
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.waitForFunction(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { stats(): { readonly calls: { readonly cancel: number } } } }).__playgroundClientScopeFixture.stats().calls.cancel === 1);
    const cancelCallbacks = await replaceWithB();
    await resolve();
    await page.waitForTimeout(25);
    expect((await stats()).callbacks).toHaveLength(cancelCallbacks);
    await expect(page.getByText('Late cancel evidence')).toHaveCount(0);
    expect((await stats()).signals.cancel).toBe(true);

    await page.evaluate(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { prepare(mode: string): void } }).__playgroundClientScopeFixture.prepare('export'));
    await page.getByRole('button', { name: 'Export trace' }).click();
    await page.waitForFunction(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { stats(): { readonly calls: { readonly export: number } } } }).__playgroundClientScopeFixture.stats().calls.export === 1);
    await replaceWithB();
    await resolve();
    await page.waitForTimeout(25);
    await expect(page.getByRole('heading', { name: /Exported trace/u })).toHaveCount(0);
    expect((await stats()).signals.export).toBe(true);

    await page.evaluate(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { prepare(mode: string): void } }).__playgroundClientScopeFixture.prepare('promote'));
    await expect(page.getByLabel('Select events.jsonl#1 for the draft eval case')).toBeVisible({ timeout: browserTimeout });
    await page.getByLabel('Select events.jsonl#1 for the draft eval case').check();
    await page.getByRole('button', { name: 'Promote to draft eval case' }).click();
    await page.waitForFunction(() => (globalThis as typeof globalThis & { __playgroundClientScopeFixture: { stats(): { readonly calls: { readonly promote: number } } } }).__playgroundClientScopeFixture.stats().calls.promote === 1);
    await replaceWithB();
    await resolve();
    await page.waitForTimeout(25);
    await expect(page.getByRole('heading', { name: /Draft eval case/u })).toHaveCount(0);
    expect((await stats()).signals.promote).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
