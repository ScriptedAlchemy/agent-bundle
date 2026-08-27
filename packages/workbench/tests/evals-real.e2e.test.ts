import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect } from '@rstest/playwright';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { seedEvalProject, writeEvalSuite } from '../../agent-bundle/tests/support/eval-project.ts';
import { readFinalizedEvalRun } from '../src/evals/evals-page.tsx';
import { closeServer } from './support/http.ts';
import { workbenchBrowserAliases } from './support/workbench-browser-modules.ts';
import { buildWorkbench, e2e, workbenchAssets, workspaceRoot } from './support/workbench-e2e.ts';

const evalsPage = join(workspaceRoot, 'packages', 'workbench', 'src', 'evals', 'evals-page.tsx');
const browserTimeout = 12_000;

e2e('retries a terminal canonical read until the durable run finalization is visible', async () => {
  let reads = 0;
  const waits: number[] = [];
  const result = await readFinalizedEvalRun({
    client: {
      read: async () => ++reads === 1
        ? { run: { completedAt: undefined } } as never
        : { run: { completedAt: '2026-08-18T00:00:02.000Z' } } as never,
    },
    runId: 'run-terminal-race',
    signal: new AbortController().signal,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  expect(reads).toBe(2);
  expect(waits).toHaveLength(1);
  expect(result.run.completedAt).toBe('2026-08-18T00:00:02.000Z');
});

e2e('surfaces a terminal canonical-read error without retrying it', async () => {
  let reads = 0;
  let waits = 0;

  await expect(readFinalizedEvalRun({
    client: { read: async () => { reads += 1; throw new Error('invalid durable DTO'); } },
    runId: 'run-terminal-error',
    signal: new AbortController().signal,
    wait: async () => { waits += 1; },
  })).rejects.toThrow('invalid durable DTO');

  expect(reads).toBe(1);
  expect(waits).toBe(0);
});

e2e('stops bounded terminal finalization polling instead of looping forever', async () => {
  let reads = 0;
  let waits = 0;

  await expect(readFinalizedEvalRun({
    client: { read: async () => { reads += 1; return { run: { completedAt: undefined } } as never; } },
    runId: 'run-terminal-timeout',
    signal: new AbortController().signal,
    wait: async () => { waits += 1; },
  })).rejects.toThrow('Recorded eval results were not finalized in time.');

  expect(reads).toBe(8);
  expect(waits).toBe(7);
});

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Eval client-scope fixture did not receive a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const mountedEvalClientScopeFixture = async (): Promise<{ readonly close: () => Promise<void>; readonly url: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-eval-client-scope-'));
  const entry = join(root, 'page.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { flushSync } from 'react-dom';",
    "import { createRoot } from 'react-dom/client';",
    `import { EvalsPage } from ${JSON.stringify(evalsPage)};`,
    '',
    "const deferred = () => { let resolve; const promise = new Promise((nextResolve) => { resolve = nextResolve; }); return { promise, resolve }; };",
    "const digest = 'a'.repeat(64);",
    "const event = (kind, sequence) => ({ kind, payload: {}, sequence, timestamp: `2026-08-18T00:00:0${sequence}.000Z` });",
    "const run = (id) => ({ agentBundleVersion: '0.1.0', artifact: { manifestPath: 'manifest.json', source: 'run-owned', targetDigests: { portable: digest } }, createdAt: '2026-08-18T00:00:00.000Z', harness: 'deterministic', id, projectRevision: digest });",
    "const listing = (name, caseId) => ({ diagnostics: [], suites: [{ cases: [{ assertions: [], digest, hosts: ['portable'], id: caseId, invocation: { mode: 'none' }, prompt: `Prompt for ${caseId}`, trials: 1 }], digest, name, sourcePath: `evals/${name}.eval.ts` }] });",
    "const result = (record, caseId) => ({ aggregates: [], diagnostics: [], run: record, trials: [{ assertions: [], caseDigest: digest, caseId, completedAt: '2026-08-18T00:00:02.000Z', durationMs: 1, evidence: { mcp: { calls: [], level: 'unavailable' }, process: { level: 'unavailable', timedOut: false }, scripts: { level: 'unavailable', results: {} }, skillActivation: { activated: [], level: 'unavailable' } }, fixtureDigest: digest, host: 'portable', id: `${record.id}-trial`, model: 'deterministic', outcome: 'pass', prompt: `Prompt for ${caseId}`, provenance: { hostCliVersion: 'agent-bundle@0.1.0', invocation: { mode: 'automatic' }, semanticGrader: null }, rawArtifacts: [], startedAt: '2026-08-18T00:00:01.000Z', targetDigest: digest, trialIndex: 0 }] });",
    "const emptyStream = () => ({ close: () => undefined, done: new Promise(() => undefined) });",
    '',
    "const runA = run('run-a'); const resultA = result(runA, 'case-a');",
    'const lateRunsA = deferred(); const lateReadA = deferred(); const lateCancelA = deferred(); let streamA; let readsA = 0; let runsA = 0; let cancelsA = 0; const eventsA = [];',
    'const clientA = {',
    "  artifact: async () => ({ blob: new Blob([]), filename: 'none', mediaType: 'text/plain' }),",
    '  cancel: () => { cancelsA += 1; return lateCancelA.promise; },',
    '  events: async (runId) => { eventsA.push(runId); return { cursor: { afterSequence: 2 }, events: [event(\'run.started\', 1), event(\'trial.completed\', 2)] }; },',
    '  read: () => readsA++ === 0 ? Promise.resolve(resultA) : lateReadA.promise,',
    '  runs: () => runsA++ === 0 ? lateRunsA.promise : Promise.resolve([runA]),',
    '  start: async () => ({ run: runA }),',
    '  stream: (options) => { streamA = options; return emptyStream(); },',
    "  suites: async () => listing('suite-a', 'case-a'),",
    '};',
    '',
    "const runB = run('run-b'); const resultB = result(runB, 'case-b');",
    'const suitesB = deferred(); const runsB = deferred(); let cancelsB = 0; const eventsB = [];',
    'const clientB = {',
    "  artifact: async () => ({ blob: new Blob([]), filename: 'none', mediaType: 'text/plain' }),",
    "  cancel: (runId) => { cancelsB += 1; return Promise.resolve({ cancelled: true, runId }); },",
    '  events: async (runId) => { eventsB.push(runId); return { cursor: { afterSequence: 0 }, events: [] }; },',
    '  read: async () => resultB,',
    '  runs: () => runsB.promise,',
    '  start: async () => ({ run: runB }),',
    '  stream: () => emptyStream(),',
    '  suites: () => suitesB.promise,',
    '};',
    '',
    "const slowSuitesA = deferred(); const slowRunsA = deferred(); const slowA = { ...clientA, runs: () => slowRunsA.promise, suites: () => slowSuitesA.promise };",
    'const root = createRoot(document.getElementById(\'root\'));',
    'const mount = (client) => flushSync(() => root.render(React.createElement(EvalsPage, { client })));',
    'mount(clientA);',
    'globalThis.__evalClientScopeFixture = {',
    '  emitLateA: () => streamA?.onEvent(event(\'trial.completed\', 3)),',
    '  mountSlowA: () => mount(slowA),',
    '  replaceWithB: () => mount(clientB),',
    '  resolveB: () => { suitesB.resolve(listing(\'suite-b\', \'case-b\')); runsB.resolve([]); },',
    '  resolveLateA: () => { lateRunsA.resolve([runA]); lateReadA.resolve(resultA); lateCancelA.resolve({ cancelled: true, runId: runA.id }); streamA?.onEvent(event(\'run.failed\', 4)); },',
    '  resolveSlowA: () => { slowSuitesA.resolve(listing(\'suite-slow-a\', \'case-slow-a\')); slowRunsA.resolve([runA]); },',
    '  stats: () => ({ cancelsA, cancelsB, eventsA: [...eventsA], eventsB: [...eventsB], readsA, runsA }),',
    '};',
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
        alias: workbenchBrowserAliases,
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
  if (!assets.includes('page.html')) throw new Error('Eval client-scope fixture did not produce its browser document.');
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

const seedGatedEvalProject = async (root: string): Promise<{ readonly release: () => Promise<void> }> => {
  await seedEvalProject(root);
  const gate = join(root, 'evals', '.release-gated-run');
  await writeEvalSuite(root, 'gated.eval.ts', {
    cases: [{ id: 'wait-for-cancel', kind: 'pass' }],
    name: 'gated-cancel',
  });
  await writeFile(join(root, 'evals', 'graders', 'reads-result.ts'), [
    "import { access } from 'node:fs/promises';",
    '',
    `const gate = ${JSON.stringify(gate)};`,
    'const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));',
    '',
    'export default async () => {',
    '  for (let attempt = 0; attempt < 400; attempt += 1) {',
    '    try {',
    '      await access(gate);',
    "      return { detail: 'The gate was released.', outcome: 'pass' as const };",
    '    } catch {',
    '      await wait(25);',
    '    }',
    '  }',
    "  throw new Error('The deterministic cancel gate was not released.');",
    '};',
    '',
  ].join('\n'));
  return { release: async () => writeFile(gate, 'released\n') };
};

e2e('admits a deterministic Eval promptly and renders refreshed durable evidence without desktop overflow', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await seedEvalProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const pageErrors: Error[] = [];
    const durableReads: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/evals/runs/')) durableReads.push(request.url());
    });
    await page.goto(`${server.url}#/evals`);
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Run deterministic suite' })).toBeEnabled({ timeout: browserTimeout });
    await expect(page.getByLabel('Harness')).toHaveValue('deterministic');
    await expect(page.getByText('Authored model pins are read-only')).toBeVisible();

    const started = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const admissionResponse = await started;
    const admission = await admissionResponse.json() as { readonly run: Readonly<{ readonly id: string }> };
    const runId = admission.run.id;
    expect(admissionResponse.request().postDataJSON()).toEqual({ harness: 'deterministic', suites: ['review-change'] });

    await expect(page.getByText(`Run ${runId} finished:`)).toBeVisible({ timeout: browserTimeout });
    expect(durableReads).toContain(`${server.url}/api/evals/runs/${encodeURIComponent(runId)}`);
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Durable event timeline' })).toBeVisible({ timeout: browserTimeout });
    const sequences = await page.locator('.eval-timeline .eval-event-sequence').allTextContents();
    expect(sequences.map((value) => Number(value.slice(1)))).toEqual(sequences.map((_, index) => index + 1));
    expect(sequences.length).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('heading', { name: 'Host / model matrix' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('unavailable evidence').first()).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('observed evidence').first()).toBeVisible({ timeout: browserTimeout });

    const artifactResponse = page.waitForResponse((response) => response.url().includes(`/api/evals/runs/${encodeURIComponent(runId)}/artifacts/`));
    await page.getByRole('button', { name: 'Preview safe text' }).first().click();
    expect((await artifactResponse).status()).toBe(200);
    const rawArtifact = page.locator('.eval-raw-artifact').first();
    await expect(rawArtifact).toContainText('Download evidence.json', { timeout: browserTimeout });
    const downloadLink = page.getByRole('link', { name: 'Download evidence.json' }).first();
    await expect(downloadLink).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.eval-raw-result pre code').first()).not.toHaveText('');
    const download = page.waitForEvent('download');
    await downloadLink.click();
    await (await download).path();

    const restarted = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const replacement = await (await restarted).json() as { readonly run: Readonly<{ readonly id: string }> };
    expect(replacement.run.id).not.toBe(runId);
    await expect(page.getByText(`Run ${replacement.run.id} finished:`)).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Download evidence.json' })).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('keeps a gated deterministic run cancellable exactly once and rejects stale run-list refreshes', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const gate = await seedGatedEvalProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  let releaseStaleList: (() => void) | undefined;
  let releaseCancel: (() => void) | undefined;
  try {
    let listRequests = 0;
    let resolveSecondList: (() => void) | undefined;
    const secondList = new Promise<void>((resolve) => { resolveSecondList = resolve; });
    const staleList = new Promise<void>((resolve) => { releaseStaleList = resolve; });
    const heldCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let cancellations = 0;
    let resolveCancellation: (() => void) | undefined;
    const cancellationSeen = new Promise<void>((resolve) => { resolveCancellation = resolve; });
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(`${server.url}/api/evals/runs`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      listRequests += 1;
      if (listRequests === 1) {
        await staleList;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ runs: [] }), status: 200 });
        return;
      }
      resolveSecondList?.();
      await route.continue();
    });
    await page.route(`${server.url}/api/evals/runs/*/cancel`, async (route) => {
      cancellations += 1;
      resolveCancellation?.();
      await heldCancel;
      await route.continue();
    });
    await page.goto(`${server.url}#/evals`);
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
    await page.getByLabel('Suite').selectOption('gated-cancel');
    const admitted = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const admission = await (await admitted).json() as { readonly run: Readonly<{ readonly id: string }> };
    const runId = admission.run.id;
    await secondList;
    releaseStaleList?.();
    await expect(page.getByLabel('Recorded run')).toHaveValue(runId, { timeout: browserTimeout });

    const cancel = page.getByRole('button', { name: 'Cancel run' });
    await expect(cancel).toBeVisible({ timeout: browserTimeout });
    await cancel.evaluate((button) => {
      if (button instanceof HTMLButtonElement) {
        button.click();
        button.click();
      }
    });
    await cancellationSeen;
    await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(cancellations).toBe(1);
    releaseCancel?.();
    await expect(page.getByText('Cancellation was recorded for this run.')).toBeVisible({ timeout: browserTimeout });
    await gate.release();
    await expect(page.getByText(`Run ${runId} was cancelled after recording`)).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('run.cancelled')).toBeVisible({ timeout: browserTimeout });
    expect(cancellations).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    releaseStaleList?.();
    releaseCancel?.();
    await gate.release();
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('does not cancel a gated run when a newer admission replaces it or the Eval page unmounts', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const gate = await seedGatedEvalProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    let cancellations = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/cancel')) cancellations += 1;
    });
    await page.goto(`${server.url}#/evals`);
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
    await page.getByLabel('Suite').selectOption('gated-cancel');
    const firstAdmission = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const first = await (await firstAdmission).json() as { readonly run: Readonly<{ readonly id: string }> };
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible({ timeout: browserTimeout });

    const replacementAdmission = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const replacement = await (await replacementAdmission).json() as { readonly run: Readonly<{ readonly id: string }> };
    await expect(page.locator('.eval-summary')).toContainText(replacement.run.id, { timeout: browserTimeout });
    await page.waitForTimeout(150);
    await expect(page.locator('.eval-summary')).not.toContainText(first.run.id);
    await page.goto(`${server.url}#/overview`);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    expect(cancellations).toBe(0);
  } finally {
    await gate.release();
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('fails closed while replacing an active Eval client and ignores every late client-A completion', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await mountedEvalClientScopeFixture();
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(fixture.url);
    await page.waitForFunction(() => '__evalClientScopeFixture' in globalThis);
    await expect(page.getByRole('button', { name: 'Run deterministic suite' })).toBeEnabled({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    await expect(page.getByText('Run run-a is running.')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('Evidence channels')).toBeVisible({ timeout: browserTimeout });
    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { emitLateA(): void; stats(): { readonly readsA: number } };
    }).__evalClientScopeFixture.emitLateA());
    await page.waitForFunction(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { stats(): { readonly readsA: number } };
    }).__evalClientScopeFixture.stats().readsA === 2);
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();

    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { replaceWithB(): void };
    }).__evalClientScopeFixture.replaceWithB());
    const firstBRender = await page.locator('body').innerText();
    expect(firstBRender).toContain('Looking for authored eval suites…');
    expect(firstBRender).not.toContain('Run run-a is running.');
    expect(firstBRender).not.toContain('Evidence channels');
    expect(firstBRender).not.toContain('evals/suite-a.eval.ts');
    const beforeB = await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { stats(): { readonly cancelsA: number; readonly cancelsB: number; readonly eventsB: readonly string[] } };
    }).__evalClientScopeFixture.stats());
    expect(beforeB).toMatchObject({ cancelsA: 1, cancelsB: 0, eventsB: [] });

    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { resolveB(): void };
    }).__evalClientScopeFixture.resolveB());
    await page.waitForTimeout(50);
    expect(await page.locator('body').innerText()).toContain('evals/suite-b.eval.ts');
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.waitForFunction(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { stats(): { readonly cancelsB: number } };
    }).__evalClientScopeFixture.stats().cancelsB === 1);

    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { resolveLateA(): void };
    }).__evalClientScopeFixture.resolveLateA());
    await page.waitForTimeout(50);
    await expect(page.getByText('Run run-a is running.')).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { stats(): { readonly eventsB: readonly string[] } };
    }).__evalClientScopeFixture.stats().eventsB)).toEqual(['run-b']);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

e2e('ignores delayed client-A suite and run-list completions after the client scope changes', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await mountedEvalClientScopeFixture();
  try {
    await page.goto(fixture.url);
    await page.waitForFunction(() => '__evalClientScopeFixture' in globalThis);
    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { mountSlowA(): void; replaceWithB(): void };
    }).__evalClientScopeFixture.mountSlowA());
    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { replaceWithB(): void };
    }).__evalClientScopeFixture.replaceWithB());
    expect(await page.locator('body').innerText()).toContain('Looking for authored eval suites…');

    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { resolveB(): void; resolveSlowA(): void };
    }).__evalClientScopeFixture.resolveSlowA());
    await page.evaluate(() => (globalThis as typeof globalThis & {
      __evalClientScopeFixture: { resolveB(): void };
    }).__evalClientScopeFixture.resolveB());
    await page.waitForTimeout(50);
    const body = await page.locator('body').innerText();
    expect(body).toContain('evals/suite-b.eval.ts');
    expect(body).not.toContain('evals/suite-slow-a.eval.ts');
    expect(body).not.toContain('run-a');
  } finally {
    await fixture.close();
  }
});
