import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

const hostContext = {
  availableDisplayModes: ['inline'],
  containerDimensions: { height: 360, width: 640 },
  deviceCapabilities: {},
  displayMode: 'inline',
  locale: 'en-US',
  platform: 'web',
  safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
  styles: {},
  theme: 'light',
  timeZone: 'UTC',
  userAgent: 'agent-bundle-dev-web-host-test/1.0',
};

const seedString = (html: string, field: string): string => {
  const match = html.match(new RegExp(`"${field}":"([^"]+)"`, 'u'));
  if (match?.[1] === undefined) throw new Error(`Web host seed does not contain ${field}.`);
  return match[1];
};

it('serves an exposed App and registers its opening call for page binding', async () => {
  const project = await createProjectFixture({ prefix: 'agent-bundle-dev-web-host-' });
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    await Promise.all([
      mkdir(join(project.root, 'src'), { recursive: true }),
      mkdir(join(project.root, 'views'), { recursive: true }),
    ]);
    await symlink(
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(project.root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await Promise.all([
      writeFile(project.configPath, [
        "import { defineConfig } from 'agent-bundle';",
        '',
        'export default defineConfig({',
        '  mcp: { servers: { status: {',
        "    apps: { status: { entry: './views/status.ts', resourceUri: 'ui://fixture/status.html', template: './views/status.html' } },",
        "    entry: './src/server.ts',",
        '  } } },',
        "  plugin: { name: 'dev-web-host-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  web: { apps: [{ app: 'status/status', input: { service: 'compiler' }, tool: 'show-status' }] },",
        '});',
        '',
      ].join('\n')),
      writeFile(join(project.root, 'src', 'server.ts'), [
        "import { McpServer } from '@modelcontextprotocol/server';",
        '',
        "const server = new McpServer({ name: 'dev-web-host-fixture', version: '1.0.0' });",
        "server.registerResource('status', 'ui://fixture/status.html', { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({",
        "  contents: [{ mimeType: 'text/html;profile=mcp-app', text: '<main>Fixture status</main>', uri: uri.href }],",
        '}));',
        "server.registerTool('show-status', { _meta: { ui: { resourceUri: 'ui://fixture/status.html' } } }, async () => ({",
        "  content: [{ text: 'Fixture status ready.', type: 'text' }],",
        "  structuredContent: { service: 'compiler', status: 'healthy' },",
        '}));',
        'export default () => server;',
        '',
      ].join('\n')),
      writeFile(join(project.root, 'views', 'status.ts'), "document.body.dataset.ready = 'true';\n"),
      writeFile(join(project.root, 'views', 'status.html'), '<!doctype html><main id="status">Fixture status</main>\n'),
    ]);

    server = await startDevServer({ open: false, port: 0, root: project.root });
    const pageResponse = await fetch(`${server.url}/web/status/status`);
    const html = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get('cache-control')).toBe('no-store');
    expect(pageResponse.headers.get('content-security-policy')).toContain('http://127.0.0.1:');
    expect(pageResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(pageResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html).toContain('"tokenHeader":"x-agent-bundle-session"');
    expect(html).toContain('"previewProfile":"portable"');

    const sessionResponse = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const session = await sessionResponse.json() as { readonly token: string };
    expect(html).toContain(JSON.stringify(session.token));

    const sessionId = seedString(html, 'sessionId');
    const toolName = seedString(html, 'toolName');
    const opening = seedString(html, 'opening');
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    const url = server.url;
    const bind = (body: Readonly<Record<string, unknown>>) => fetch(`${url}/api/mcp/sessions/${encodeURIComponent(sessionId)}/apps`, {
      body: JSON.stringify({ host: hostContext, previewProfile: 'portable', toolName, ...body }),
      headers,
      method: 'POST',
    });
    const previewResponse = await bind({ opening });
    const preview = await previewResponse.json() as {
      readonly preview?: Readonly<{ readonly resource?: Readonly<{ readonly kind?: string }> }>;
    };
    expect(previewResponse.status).toBe(200);
    expect(preview.preview?.resource?.kind).toBe('resource');

    // A second page load of the same App shares the session but gets its own
    // opening id; a bind that names no opening, or another page's, is refused
    // rather than handed a call the page never saw.
    const secondHtml = await (await fetch(`${server.url}/web/status/status`)).text();
    const secondOpening = seedString(secondHtml, 'opening');
    expect(seedString(secondHtml, 'sessionId')).toBe(sessionId);
    expect(secondOpening).not.toBe(opening);
    expect((await bind({})).status).toBe(400);
    expect((await bind({ opening: 'not-a-page' })).status).toBe(400);
    expect((await bind({ opening: secondOpening })).status).toBe(200);

    const missingResponse = await fetch(`${server.url}/web/status/nope`);
    const missing = await missingResponse.json() as {
      readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>;
    };
    expect(missingResponse.status).toBe(404);
    expect(missing.diagnostic.code).toBe('AB8020');
    expect(missing.diagnostic.message).toContain('status/status');
  } finally {
    await server?.close();
    await removeProjectFixture(project.root);
  }
});
