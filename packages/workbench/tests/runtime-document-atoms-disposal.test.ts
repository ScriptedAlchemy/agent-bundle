import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { chromium } from 'playwright';
import { describe, expect, it } from '@rstest/core';

import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';

declare global {
  interface Window {
    __runtimeDocumentAtoms: {
      mount(mode: 'never' | 'resolving'): void;
      readonly stats: {
        neverAborted: number;
        neverCalls: number;
        resolvingCalls: number;
        unmounts: number;
      };
      unmount(): void;
    };
  }
}

const contentType = (path: string): string => path.endsWith('.css')
  ? 'text/css'
  : path.endsWith('.js')
    ? 'text/javascript'
    : 'text/html';

const startStaticServer = async (root: string) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = pathname === '/' ? 'runtime-document-atoms-fixture.html' : pathname.slice(1);
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
  if (address === null || typeof address === 'string') throw new Error('Runtime Document atom fixture did not expose a TCP address.');
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const fixtureSource = (root: string): string => `
  import { RegistryProvider } from '@effect/atom-react';
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { RuntimeInspector } from ${JSON.stringify(join(root, 'packages/workbench/src/runtime-inspector.tsx'))};

  const run = {
    completedAt: '2026-08-15T12:00:01.000Z',
    id: 'run-document-disposal',
    input: {},
    result: {
      flight: { bytes: 24, preview: 'Flight payload', truncated: false },
      protocol: {},
      state: { identity: { stateStoreId: 'state-document', stateVersion: 1 } },
      trace: [],
      tree: [],
    },
    startedAt: '2026-08-15T12:00:00.000Z',
    status: 'succeeded',
    surfaceId: 'tool/document',
    target: 'portable',
    vector: {
      providerSessionId: 'provider',
      runtimeGenerationId: 'generation',
      sourceRevision: 'source',
      stateStoreId: 'state-document',
      stateVersion: 1,
    },
  } as const;
  const agentDocument = {
    root: { children: [{ kind: 'markdown', text: '# Disposal document' }], kind: 'result' },
    status: 'success',
    version: 1,
  } as const;
  const stats = { neverAborted: 0, neverCalls: 0, resolvingCalls: 0, unmounts: 0 };
  const neverLoader = (_runId: string, signal?: AbortSignal) => {
    stats.neverCalls += 1;
    return new Promise<never>(() => {
      signal?.addEventListener('abort', () => { stats.neverAborted += 1; }, { once: true });
    });
  };
  const resolvingLoader = async () => {
    stats.resolvingCalls += 1;
    return [
      { document: agentDocument, sequence: 0, type: 'shell' },
      { document: agentDocument, sequence: 1, type: 'complete' },
    ] as const;
  };

  const Fixture = () => {
    const [state, setState] = useState<{ mounted: boolean; mode: 'never' | 'resolving' }>({
      mode: 'never',
      mounted: false,
    });
    window.__runtimeDocumentAtoms = {
      mount: (mode: 'never' | 'resolving') => { setState({ mode, mounted: true }); },
      stats,
      unmount: () => {
        stats.unmounts += 1;
        setState((current) => ({ ...current, mounted: false }));
      },
    };
    return state.mounted
      ? <RuntimeInspector
          loadDocumentEvents={state.mode === 'never' ? neverLoader : resolvingLoader}
          run={run}
          tab="document"
        />
      : <p>Inspector unmounted</p>;
  };

  createRoot(document.getElementById('root')!).render(
    <RegistryProvider><Fixture /></RegistryProvider>,
  );
`;

describe('Runtime Document atoms', () => {
  it('interrupts disposed requests and remains reusable across repeated mounts', async () => {
    const root = process.cwd();
    const temp = await mkdtemp(join(root, 'packages/workbench/.runtime-document-atoms-'));
    const entry = join(temp, 'runtime-document-atoms-fixture.tsx');
    const output = join(temp, 'dist');
    await writeFile(entry, fixtureSource(root));
    const rsbuild = await createRsbuild({
      config: createWorkbenchFixtureConfig({ distRoot: output, entry: { 'runtime-document-atoms-fixture': entry } }),
      cwd: root,
    });
    const buildResult = await rsbuild.build();
    await buildResult.close();
    const { server, url } = await startStaticServer(output);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
      await page.getByText('Inspector unmounted', { exact: true }).waitFor({ timeout: 5_000 });

      for (let cycle = 1; cycle <= 5; cycle += 1) {
        await page.evaluate(() => window.__runtimeDocumentAtoms.mount('never'));
        await expect.poll(() => page.evaluate(() => window.__runtimeDocumentAtoms.stats.neverCalls)).toBe(cycle);
        await page.evaluate(() => window.__runtimeDocumentAtoms.unmount());
        await expect.poll(() => page.evaluate(() => window.__runtimeDocumentAtoms.stats.neverAborted)).toBe(cycle);
      }
      const neverStats = await page.evaluate(() => window.__runtimeDocumentAtoms.stats);
      expect(neverStats.neverAborted).toBe(neverStats.unmounts);

      for (let cycle = 1; cycle <= 5; cycle += 1) {
        await page.evaluate(() => window.__runtimeDocumentAtoms.mount('resolving'));
        await page.getByRole('heading', { name: 'Disposal document' }).waitFor({ timeout: 5_000 });
        expect(await page.evaluate(() => window.__runtimeDocumentAtoms.stats.resolvingCalls)).toBeLessThanOrEqual(cycle);
        await page.evaluate(() => window.__runtimeDocumentAtoms.unmount());
        await page.getByText('Inspector unmounted', { exact: true }).waitFor({ timeout: 5_000 });
      }
      expect(await page.evaluate(() => window.__runtimeDocumentAtoms.stats)).toEqual({
        neverAborted: 5,
        neverCalls: 5,
        resolvingCalls: 5,
        unmounts: 10,
      });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(temp, { force: true, recursive: true });
    }
  }, 60_000);
});

