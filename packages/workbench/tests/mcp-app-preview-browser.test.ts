import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { chromium } from 'playwright';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const previewComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-app-preview.tsx');

const mountedPreviewFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-preview-'));
  const entry = join(root, 'preview.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { McpAppPreview } from ${JSON.stringify(previewComponent)};`,
    '',
    "const frame = { allow: '', policy: { contentSecurityPolicy: \"default-src 'none'\", iframeAllow: '', permissionsPolicy: 'camera=()' }, referrerPolicy: 'no-referrer', relay: { maxMessageBytes: 4096, maxQueuedMessages: 4 }, sandbox: 'allow-scripts allow-same-origin', src: 'http://127.0.0.1:43124/#mcp-app-preview', targetOrigin: 'http://127.0.0.1:43124' };",
    "const resource = { csp: {}, html: '<main>Forecast</main>', kind: 'resource', permissions: {} };",
    "const profile = { kind: 'apps', profile: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', resourceUri: 'ui://weather/forecast.html' };",
    "const host = { availableDisplayModes: ['inline'], containerDimensions: { height: 480, width: 640 }, deviceCapabilities: {}, displayMode: 'inline', locale: 'en-US', platform: 'web', safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 }, styles: {}, theme: 'light', timeZone: 'Etc/UTC', userAgent: 'Agent Bundle Workbench' };",
    "const ready = { bindingId: 'binding-weather', frame, profile, resource };",
    "const fallback = { bindingId: 'binding-weather', profile: { kind: 'fallback', profile: 'portable' }, resource: { input: { city: 'Paris' }, kind: 'fallback', reason: 'invalid-resource', result: { text: 'Sunny' } } };",
    'let settle;',
    'let pending = new Promise((resolve, reject) => { settle = { reject, resolve }; });',
    'const forceClosed = [];',
    "const client = { close: async () => ({ lifecycle: 'closed' }), create: async () => pending, forceClose: async (bindingId) => { forceClosed.push(bindingId); return true; }, message: async () => ({ accepted: true, lifecycle: 'initialized', messages: [] }) };",
    "const frameRelayFactory = () => ({ close: async () => undefined, start: () => true });",
    "const root = createRoot(document.getElementById('root'));",
    "root.render(React.createElement(McpAppPreview, { client, frameRelayFactory, host, input: { city: 'Paris' }, result: { text: 'Sunny' }, sessionId: 'session-weather', title: 'MCP App preview boundary', toolName: 'show-weather' }));",
    "globalThis.__mcpAppPreviewFixture = { reject: () => settle.reject(new Error('preview route failed')), resolve: (kind) => settle.resolve(kind === 'fallback' ? fallback : ready), stats: () => ({ forceClosed: [...forceClosed] }), unmount: () => root.unmount() };",
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
          'react-dom/client': join(workspaceRoot, 'node_modules', 'react-dom', 'client.js'),
        },
      },
      source: {
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        entry: { preview: entry },
      },
    },
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const assets = await readdir(dist, { recursive: true });
  if (!assets.includes('preview.html')) throw new Error('Mounted preview fixture did not produce its browser document.');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Mounted preview fixture did not receive a TCP address.');
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      await rm(root, { force: true, recursive: true });
    },
    url: `http://127.0.0.1:${address.port}/preview.html`,
  };
};

describe('MCP App preview browser', () => {
  it('mounts the preview in Chrome for ready, error, fallback, unmount-race, and 390px layouts', async () => {
    const fixture = await mountedPreviewFixture();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const browserErrors: string[] = [];
    const responses: string[] = [];
    page.on('pageerror', (error) => { browserErrors.push(error.message); });
    page.on('response', (response) => { responses.push(`${response.status()} ${response.url()}`); });
    try {
      const load = async () => {
        await page.goto(fixture.url);
        try {
          await page.waitForFunction(() => '__mcpAppPreviewFixture' in globalThis, undefined, { timeout: 5_000 });
        } catch (error) {
          throw new Error(
            `Mounted preview fixture did not initialize: ${browserErrors.join('\n')} ${responses.join('\n')} ${String(error)}`,
            { cause: error },
          );
        }
      };
      const resolve = async (kind: 'fallback' | 'ready') => {
        await page.evaluate((next) => (globalThis as typeof globalThis & {
          __mcpAppPreviewFixture: { resolve(kind: 'fallback' | 'ready'): void };
        }).__mcpAppPreviewFixture.resolve(next), kind);
      };

      await load();
      await resolve('ready');
      const frame = page.getByTitle('MCP App preview boundary');
      await frame.waitFor();
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
      expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(await frame.getAttribute('src')).toBe('http://127.0.0.1:43124/#mcp-app-preview');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await load();
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { reject(): void };
      }).__mcpAppPreviewFixture.reject());
      await page.getByRole('alert').waitFor();
      expect(await page.getByLabel('MCP App fallback').textContent()).toContain('Sunny');

      await load();
      await resolve('fallback');
      await page.getByLabel('MCP App fallback').waitFor();
      expect(await page.locator('iframe').count()).toBe(0);

      await load();
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { unmount(): void };
      }).__mcpAppPreviewFixture.unmount());
      await resolve('ready');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { stats(): { forceClosed: readonly string[] } };
      }).__mcpAppPreviewFixture.stats().forceClosed.length === 1);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { stats(): { forceClosed: readonly string[] } };
      }).__mcpAppPreviewFixture.stats().forceClosed)).toEqual(['binding-weather']);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 30_000);
});
