import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { chromium } from 'playwright';
import { describe, expect, it } from '@rstest/core';

import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';
import { browserLaunchOptions } from './support/workbench-e2e.ts';

declare global {
  interface Window {
    __discoveryAtoms: {
      mount(mode: 'never' | 'probe-never' | 'resolving'): void;
      readonly stats: {
        neverAborted: number;
        neverCalls: number;
        probeAborted: number;
        probeCalls: number;
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
    const file = pathname === '/' ? 'discovery-atoms-fixture.html' : pathname.slice(1);
    const path = normalize(join(root, file));
    if (relative(root, path).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then(
      (body) => response.writeHead(200, { 'content-type': contentType(path) }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Discovery atom fixture did not expose a TCP address.');
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const fixtureSource = (root: string): string => `
  import { RegistryProvider } from '@effect/atom-react';
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { DiscoveryPage } from ${JSON.stringify(join(root, 'packages/workbench/src/discovery/discovery-page.tsx'))};

  const report = {
    diagnostics: [],
    endpoints: {
      diagnostics: [],
      directory: '/tmp/agent-bundle',
      findings: [],
      status: 'healthy',
      summary: { live: 0, staleLocks: 0, staleSockets: 0 },
    },
    generatedAt: '2026-09-01T12:00:00.000Z',
    hosts: [{
      bundle: {
        bundleRoot: '/workspace/dist',
        mcpServers: [{ name: 'timeline', transport: 'stdio' }],
        name: 'agent-bundle',
        state: 'installed',
      },
      diagnostics: [],
      host: 'claude',
      inventory: { findings: [], status: 'known' },
      probe: { status: 'available', version: '1.2.3' },
    }],
    manifestDigest: 'manifest-current',
    summary: { errors: 0, infos: 0, warnings: 0 },
  } as const;
  const probeReport = {
    durationMs: 12,
    generatedAt: '2026-09-01T12:00:01.000Z',
    host: 'claude',
    launch: { args: ['dist/timeline.js'], command: 'node', env: {}, kind: 'stdio' },
    serverName: 'timeline',
    snapshot: {
      capabilities: { tools: true },
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'timeline-server', version: '1.0.0' },
      tools: [{ description: 'Lists entries.', name: 'timeline_list', title: 'List timeline' }],
      toolsTruncated: false,
    },
    status: 'ok',
  } as const;
  const stats = {
    neverAborted: 0,
    neverCalls: 0,
    probeAborted: 0,
    probeCalls: 0,
    resolvingCalls: 0,
    unmounts: 0,
  };
  const neverClient = {
    discover: (signal?: AbortSignal) => {
      stats.neverCalls += 1;
      return new Promise<never>(() => {
        signal?.addEventListener('abort', () => { stats.neverAborted += 1; }, { once: true });
      });
    },
    probe: async () => probeReport,
  };
  const resolvingClient = {
    discover: async () => {
      stats.resolvingCalls += 1;
      return report;
    },
    probe: async () => {
      stats.probeCalls += 1;
      return probeReport;
    },
  };
  const probeNeverClient = {
    discover: async () => {
      stats.resolvingCalls += 1;
      return report;
    },
    probe: (_request: unknown, signal?: AbortSignal) => {
      stats.probeCalls += 1;
      return new Promise<never>(() => {
        signal?.addEventListener('abort', () => { stats.probeAborted += 1; }, { once: true });
      });
    },
  };

  const Fixture = () => {
    const [state, setState] = useState<{
      mounted: boolean;
      mode: 'never' | 'probe-never' | 'resolving';
    }>({
      mode: 'never',
      mounted: false,
    });
    window.__discoveryAtoms = {
      mount: (mode: 'never' | 'probe-never' | 'resolving') => {
        setState({ mode, mounted: true });
      },
      stats,
      unmount: () => {
        stats.unmounts += 1;
        setState((current) => ({ ...current, mounted: false }));
      },
    };
    return state.mounted
      ? <DiscoveryPage
          client={state.mode === 'never'
            ? neverClient
            : state.mode === 'probe-never'
              ? probeNeverClient
              : resolvingClient}
          manifestDigest="manifest-current"
        />
      : <p>Discovery unmounted</p>;
  };

  createRoot(document.getElementById('root')!).render(
    <RegistryProvider><Fixture /></RegistryProvider>,
  );
`;

describe('Discovery atoms', () => {
  it('interrupts disposed requests, bounds remount loads, and re-runs with a fresh key', async () => {
    const root = process.cwd();
    const temp = await mkdtemp(join(root, 'packages/workbench/.discovery-atoms-'));
    const entry = join(temp, 'discovery-atoms-fixture.tsx');
    const output = join(temp, 'dist');
    await writeFile(entry, fixtureSource(root));
    const rsbuild = await createRsbuild({
      config: createWorkbenchFixtureConfig({ distRoot: output, entry: { 'discovery-atoms-fixture': entry } }),
      cwd: root,
    });
    const buildResult = await rsbuild.build();
    await buildResult.close();
    const { server, url } = await startStaticServer(output);
    const browser = await chromium.launch(browserLaunchOptions);
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
      await page.getByText('Discovery unmounted', { exact: true }).waitFor({ timeout: 5_000 });

      for (let cycle = 1; cycle <= 5; cycle += 1) {
        await page.evaluate(() => window.__discoveryAtoms.mount('never'));
        await expect.poll(() => page.evaluate(() => window.__discoveryAtoms.stats.neverCalls)).toBe(cycle);
        await page.evaluate(() => window.__discoveryAtoms.unmount());
        await expect.poll(() => page.evaluate(() => window.__discoveryAtoms.stats.neverAborted)).toBe(cycle);
      }
      expect(await page.evaluate(() => window.__discoveryAtoms.stats.neverAborted)).toBe(
        await page.evaluate(() => window.__discoveryAtoms.stats.unmounts),
      );

      for (let cycle = 1; cycle <= 5; cycle += 1) {
        await page.evaluate(() => window.__discoveryAtoms.mount('resolving'));
        await page.getByRole('region', { name: 'Host discovery' }).waitFor({ timeout: 5_000 });
        await page.getByText('Generated at', { exact: true }).waitFor({ timeout: 5_000 });
        expect(await page.evaluate(() => window.__discoveryAtoms.stats.resolvingCalls)).toBeLessThanOrEqual(cycle);
        await page.evaluate(() => window.__discoveryAtoms.unmount());
        await page.getByText('Discovery unmounted', { exact: true }).waitFor({ timeout: 5_000 });
      }

      await page.evaluate(() => window.__discoveryAtoms.mount('resolving'));
      await page.getByText('Generated at', { exact: true }).waitFor({ timeout: 5_000 });
      const callsBeforeRerun = await page.evaluate(() => window.__discoveryAtoms.stats.resolvingCalls);
      await page.getByRole('button', { name: 'Re-run discovery' }).first().click();
      await expect.poll(() => page.evaluate(() => window.__discoveryAtoms.stats.resolvingCalls)).toBe(callsBeforeRerun + 1);

      expect(await page.evaluate(() => window.__discoveryAtoms.stats.probeCalls)).toBe(0);
      await page.getByRole('button', { name: 'Probe timeline' }).click();
      await page.getByRole('button', { name: 'Cancel' }).click();
      expect(await page.evaluate(() => window.__discoveryAtoms.stats.probeCalls)).toBe(0);
      await page.getByRole('button', { name: 'Probe timeline' }).click();
      await page.getByRole('button', { name: 'Run live probe' }).click();
      await page.getByText('Connected', { exact: true }).waitFor({ timeout: 5_000 });
      expect(await page.evaluate(() => window.__discoveryAtoms.stats.probeCalls)).toBe(1);

      await page.evaluate(() => window.__discoveryAtoms.unmount());
      await page.getByText('Discovery unmounted', { exact: true }).waitFor({ timeout: 5_000 });
      await page.evaluate(() => window.__discoveryAtoms.mount('resolving'));
      await page.getByRole('button', { name: 'Probe timeline' }).waitFor({ timeout: 5_000 });
      await expect.poll(() => page.getByText('Connected', { exact: true }).count()).toBe(0);

      await page.evaluate(() => window.__discoveryAtoms.unmount());
      await page.evaluate(() => window.__discoveryAtoms.mount('probe-never'));
      await page.getByRole('button', { name: 'Probe timeline' }).click();
      await page.getByRole('button', { name: 'Run live probe' }).click();
      await expect.poll(() => page.evaluate(() => window.__discoveryAtoms.stats.probeCalls)).toBe(2);
      await page.evaluate(() => window.__discoveryAtoms.unmount());
      await expect.poll(() => page.evaluate(() => window.__discoveryAtoms.stats.probeAborted)).toBe(1);
      await page.evaluate(() => window.__discoveryAtoms.mount('resolving'));
      await page.getByRole('button', { name: 'Probe timeline' }).waitFor({ timeout: 5_000 });
      await expect.poll(() => page.getByText('Connected', { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(temp, { force: true, recursive: true });
    }
  }, 60_000);
});
