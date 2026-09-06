import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { ProjectEventHub } from '../src/dev/events.ts';
import { startForegroundServer, type ForegroundCoordinator } from '../src/dev/foreground-server.ts';
import type { Invalidation, ProjectStatus } from '../src/dev/types.ts';
import {
  createWorkbenchAssetSource,
  workbenchAssetCacheControl,
  workbenchDocumentCacheControl,
  workbenchHashedAssetCacheControl,
} from '../src/dev/workbench-assets.ts';

const status = (): ProjectStatus => ({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
});

const coordinator: ForegroundCoordinator = {
  close: async () => undefined,
  rebuild: async (_invalidation: Invalidation) => undefined,
  start: async () => undefined,
  status,
};

it('treats only content-hashed workbench filenames as immutable', () => {
  expect(workbenchAssetCacheControl('index.html')).toBe(workbenchDocumentCacheControl);
  expect(workbenchAssetCacheControl('THIRD_PARTY_NOTICES')).toBe(workbenchDocumentCacheControl);
  expect(workbenchAssetCacheControl('src/mcp/APP-RENDERER-LICENSE')).toBe(workbenchDocumentCacheControl);
  expect(workbenchAssetCacheControl('static/js/index.js')).toBe(workbenchDocumentCacheControl);
  expect(workbenchAssetCacheControl('static/js/index.deadbeef.js')).toBe(workbenchHashedAssetCacheControl);
  expect(workbenchAssetCacheControl('static/css/index.feedface.css')).toBe(workbenchHashedAssetCacheControl);
  expect(workbenchAssetCacheControl('static/image/logo.abcdef12.png')).toBe(workbenchHashedAssetCacheControl);
  expect(workbenchDocumentCacheControl).toBe('no-store');
  expect(workbenchHashedAssetCacheControl).toBe('public, max-age=31536000, immutable');
});

it('serves hashed workbench assets as immutable and documents as no-store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-asset-cache-'));
  await Promise.all([
    mkdir(join(root, 'static', 'js'), { recursive: true }),
    mkdir(join(root, 'static', 'css'), { recursive: true }),
    mkdir(join(root, 'static', 'image'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'index.html'), '<!doctype html><title>Workbench</title>'),
    writeFile(join(root, 'THIRD_PARTY_NOTICES'), 'notice\n'),
    writeFile(join(root, 'static', 'js', 'index.js'), 'export {};\n'),
    writeFile(join(root, 'static', 'js', 'index.deadbeef.js'), 'export {};\n'),
    writeFile(join(root, 'static', 'css', 'index.feedface.css'), 'body{}\n'),
    writeFile(join(root, 'static', 'image', 'logo.abcdef12.png'), 'png\n'),
  ]);
  const server = await startForegroundServer({
    assets: createWorkbenchAssetSource({ root }),
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });
  try {
    const [document, shell, hashedJs, hashedCss, hashedImage, unhashedJs, notices] = await Promise.all([
      fetch(server.url),
      fetch(`${server.url}/routes/mcp/curator/tool/search`),
      fetch(`${server.url}/static/js/index.deadbeef.js`),
      fetch(`${server.url}/static/css/index.feedface.css`),
      fetch(`${server.url}/static/image/logo.abcdef12.png`),
      fetch(`${server.url}/static/js/index.js`),
      fetch(`${server.url}/THIRD_PARTY_NOTICES`),
    ]);
    expect(document.status).toBe(200);
    expect(document.headers.get('cache-control')).toBe('no-store');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('cache-control')).toBe('no-store');
    expect(await shell.text()).toContain('Workbench');
    expect(hashedJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(hashedCss.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(hashedImage.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(unhashedJs.headers.get('cache-control')).toBe('no-store');
    expect(notices.headers.get('cache-control')).toBe('no-store');
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});
