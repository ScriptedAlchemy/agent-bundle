import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { build, serveApp } from '../src/api.ts';
import {
  AppClientError,
  type AppMessageEvent,
  type AppMessageTarget,
  type AppWindow,
  createAppClient,
} from '../src/app/index.ts';
import { MCP_APP_PROTOCOL_VERSION } from '../src/dev/mcp-apps/mcp-app-bridge.ts';
import { SERVE_APP_TOKEN_HEADER } from '../src/serve-app/serve-app-page.ts';
import { timeScale } from './support/time-scale.ts';

/**
 * `agent-bundle serve-app` end to end over a real packed server: build the
 * public MCP App example, serve its App, and drive the host through
 * `createAppClient` — the same `/api/mcp/...` routes the Workbench relay
 * uses — from the initialize handshake through a consented `tools/call`,
 * then close and verify every listener is gone.
 */

const sourceExampleRoot = join(process.cwd(), 'examples', 'mcp-app');

interface JsonRpc {
  readonly error?: { readonly code: number; readonly message: string };
  readonly id?: string | number | null;
  readonly jsonrpc: '2.0';
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

interface Seed {
  readonly autoApprove: readonly string[];
  readonly input: unknown;
  readonly previewProfile: string;
  readonly result: unknown;
  readonly sessionId: string;
  readonly title: string;
  readonly token: string;
  readonly toolName: string;
}

const seedOf = (html: string): Seed => {
  const match = /<script type="application\/json" id="agent-bundle-serve-app-seed">([^<]*)<\/script>/u.exec(html);
  if (match?.[1] === undefined) throw new Error('The host document carries no seed.');
  return JSON.parse(match[1]) as Seed;
};

const browserHost = Object.freeze({
  availableDisplayModes: ['inline'],
  containerDimensions: { height: 900, width: 1440 },
  deviceCapabilities: {},
  displayMode: 'inline',
  locale: 'en',
  platform: 'web',
  safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
  styles: {},
  theme: 'light',
  timeZone: 'UTC',
  userAgent: 'agent-bundle-serve-app-test',
});

let fixtureRoot = '';
let exampleRoot = '';
let output = '';

/**
 * A private copy of the example: artifacts must live inside their project
 * root, and the shared `examples/mcp-app/.agent-bundle` is owned by the
 * examples-contract suite, which removes it wholesale.
 */
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-serve-app-'));
  exampleRoot = join(fixtureRoot, 'project');
  output = join(exampleRoot, 'artifact');
  await cp(sourceExampleRoot, exampleRoot, {
    filter: (source) => !['.agent-bundle', 'artifact', 'dist', 'node_modules'].includes(source.slice(source.lastIndexOf('/') + 1)),
    recursive: true,
  });
  const fixtureTsconfig = await readFile(join(exampleRoot, 'tsconfig.json'), 'utf8');
  await writeFile(join(exampleRoot, 'tsconfig.json'), fixtureTsconfig.replace('../../tsconfig.json', join(process.cwd(), 'tsconfig.json')));
  await symlink(join(sourceExampleRoot, 'node_modules'), join(exampleRoot, 'node_modules'), 'dir');
  await build({ output, root: exampleRoot, targets: ['portable'] });
}, 180_000 * timeScale);

afterAll(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

/** Sends one request with an explicit `Host` header, which `fetch` would overwrite. */
const statusWithHost = (url: string, host: string, headers: Record<string, string>, body?: string): Promise<number> =>
  new Promise((resolveStatus, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      headers: { ...headers, host },
      hostname: target.hostname,
      method: body === undefined ? 'GET' : 'POST',
      path: `${target.pathname}${target.search}`,
      port: target.port,
      setHost: false,
    }, (response) => {
      response.resume();
      response.once('end', () => resolveStatus(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });

const refused = async (url: string): Promise<boolean> => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

it('serves the MCP App example standalone over its packed server and relays the MCP Apps protocol through the Workbench routes', async () => {
  const opened: string[] = [];
  const served = await serveApp({
    app: 'status/status',
    artifact: output,
    autoApprove: ['call-tool'],
    input: { service: 'compiler' },
    open: true,
    openBrowser: (url) => { opened.push(url); },
    root: exampleRoot,
    target: 'portable',
    timeoutMs: 30_000 * timeScale,
  });
  let closed = false;
  void served.closed.then(() => { closed = true; });
  try {
    expect(served).toMatchObject({
      resourceUri: 'ui://mcp-app-example/status.html',
      server: 'status',
      tool: 'show-status',
    });
    expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect(served.sandboxOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(served.sandboxOrigin).not.toBe(new URL(served.url).origin);
    expect(opened).toEqual([served.url]);
    const origin = new URL(served.url).origin;

    // The host document: one page, one seed, its own CSP, no directory listing.
    const page = await fetch(served.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toContain(`frame-src ${served.sandboxOrigin}`);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('<title>status/status</title>');
    const seed = seedOf(html);
    expect(seed).toMatchObject({
      autoApprove: ['call-tool'],
      input: { service: 'compiler' },
      previewProfile: 'portable',
      result: { structuredContent: { service: 'compiler', status: 'healthy' } },
      title: 'status/status',
      toolName: 'show-status',
    });
    expect(seed.token.length).toBeGreaterThanOrEqual(32);
    expect((await fetch(`${origin}/mcp-apps/status.html`)).status).toBe(404);
    expect((await fetch(`${origin}/api/serve-app`)).status).toBe(404);
    expect((await fetch(served.url, { method: 'POST' })).status).toBe(405);

    // Authenticated routes: the per-launch token and a same-origin request are both required.
    const createPath = `${origin}/api/mcp/sessions/${encodeURIComponent(seed.sessionId)}/apps`;
    const createBody = JSON.stringify({ host: browserHost, input: seed.input, previewProfile: seed.previewProfile, result: seed.result, toolName: seed.toolName });
    const withoutToken = await fetch(createPath, { body: createBody, headers: { 'content-type': 'application/json', origin }, method: 'POST' });
    expect(withoutToken.status).toBe(403);
    expect(await withoutToken.json()).toMatchObject({ diagnostic: { code: 'AB8004' } });
    const crossOrigin = await fetch(createPath, {
      body: createBody,
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', [SERVE_APP_TOKEN_HEADER]: seed.token },
      method: 'POST',
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ diagnostic: { code: 'AB8003' } });
    // DNS rebinding: a request that reached the loopback socket under another name is refused before any route runs.
    expect(await statusWithHost(createPath, 'dashboard.example:80', { 'content-type': 'application/json', origin, [SERVE_APP_TOKEN_HEADER]: seed.token }, createBody)).toBe(403);
    expect(await statusWithHost(served.url, 'dashboard.example:80', {})).toBe(403);

    const api = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(`${origin}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          origin,
          [SERVE_APP_TOKEN_HEADER]: seed.token,
        },
        method,
      });
      const json = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`${method} ${path} → ${String(response.status)} ${JSON.stringify(json)}`);
      return json;
    };

    // Binding the App through the same preview service the Workbench uses —
    // by tool name alone, as the page does: the host already made the opening
    // call, so its result never crosses the request-body bound (#562).
    expect(html).not.toContain('result: seed.result, toolName');
    const created = await api('POST', `/api/mcp/sessions/${encodeURIComponent(seed.sessionId)}/apps`, {
      host: browserHost, previewProfile: seed.previewProfile, toolName: seed.toolName,
    });
    const preview = created.preview as {
      readonly bindingId: string;
      readonly frame: { readonly policy: { readonly contentSecurityPolicy: string }; readonly src: string; readonly targetOrigin: string };
      readonly profile: { readonly kind: string };
      readonly resource: { readonly html: string; readonly kind: string };
    };
    expect(created.lifecycle).toBe('created');
    expect(preview.profile.kind).toBe('apps');
    expect(preview.resource.kind).toBe('resource');
    expect(preview.resource.html).toContain('aria-label="Service checks"');
    expect(preview.frame.targetOrigin).toBe(served.sandboxOrigin);
    expect(preview.frame.src.startsWith(`${served.sandboxOrigin}/#`)).toBe(true);
    const sandboxDocument = await fetch(preview.frame.src);
    expect(sandboxDocument.status).toBe(200);
    expect(await sandboxDocument.text()).toContain('MCP App sandbox');

    const messagesPath = `/api/mcp/apps/${encodeURIComponent(preview.bindingId)}/messages`;
    const consentPath = `/api/mcp/apps/${encodeURIComponent(preview.bindingId)}/consent`;
    const hostMethods: string[] = [];
    const openingInputs: unknown[] = [];
    let approveCalls = true;

    const decideConsent = async (approved: boolean): Promise<readonly JsonRpc[]> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const listed = await api('GET', consentPath);
        const challenges = listed.challenges as readonly { readonly id: string }[];
        const challenge = challenges[0];
        if (challenge !== undefined) {
          const decided = await api('POST', consentPath, { approved, challengeId: challenge.id });
          return (decided.messages ?? []) as readonly JsonRpc[];
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('The serve-app host did not publish a consent challenge.');
    };

    const listeners = new Set<(event: AppMessageEvent) => void>();
    const parent: AppMessageTarget = {
      postMessage(message) {
        void (async () => {
          try {
            const relayed = await api('POST', messagesPath, { message }) as {
              readonly messages: readonly JsonRpc[];
            };
            let incoming = relayed.messages;
            if (
              incoming.length === 0
              && typeof message === 'object'
              && message !== null
              && 'method' in message
              && message.method === 'tools/call'
            ) {
              incoming = await decideConsent(approveCalls);
            }
            for (const data of incoming) {
              if (typeof data === 'object' && data !== null && typeof data.method === 'string') {
                hostMethods.push(data.method);
              }
              for (const listener of [...listeners]) {
                listener({ data, origin, source: parent });
              }
            }
          } catch {
            // The client's pending request keeps its own timeout.
          }
        })();
      },
    };
    const window: AppWindow = {
      parent,
      addEventListener(_type, listener) { listeners.add(listener); },
      removeEventListener(_type, listener) { listeners.delete(listener); },
    };

    const client = createAppClient({
      appInfo: { name: 'mcp-app-example', version: '1.0.0' },
      window,
    });
    client.onToolInput('tool:status/show-status', (input) => { openingInputs.push(input); });

    const initialized = await client.connect();
    expect(initialized).toMatchObject({
      hostInfo: { name: 'agent-bundle' },
      protocolVersion: MCP_APP_PROTOCOL_VERSION,
    });
    expect(client.connected).toBe(true);
    await expect.poll(() => openingInputs, { timeout: 5_000 * timeScale }).toEqual([{ service: 'compiler' }]);
    await expect.poll(() => hostMethods.includes('ui/notifications/tool-result'), { timeout: 5_000 * timeScale }).toBe(true);

    await expect(client.call('tool:status/show-status', { service: 'payments-api' }))
      .resolves.toMatchObject({ service: 'payments-api', status: 'degraded' });
    expect(await api('GET', consentPath)).toMatchObject({ challenges: [] });

    approveCalls = false;
    const denied = client.call('tool:status/show-status', { service: 'payments-api' });
    await expect(denied).rejects.toBeInstanceOf(AppClientError);
    await expect(denied).rejects.toMatchObject({ code: 'consent-required' });
    expect(closed).toBe(false);
    client.dispose();
  } finally {
    await served.close();
  }
  await served.closed;
  expect(closed).toBe(true);
  // Closing again is idempotent, and nothing listens any more: host, sandbox proxy, or server.
  await served.close();
  expect(await refused(served.url)).toBe(true);
  expect(await refused(`${served.sandboxOrigin}/`)).toBe(true);
}, 120_000 * timeScale);

it('names the Apps a server actually serves when the requested one is missing, and rejects malformed selectors', async () => {
  await expect(serveApp({ app: 'status/dashboard', artifact: output, root: exampleRoot }))
    .rejects.toThrow(/serves no MCP App "dashboard"; available: status\/status\./u);
  await expect(serveApp({ app: 'status/status', artifact: output, root: exampleRoot, tool: 'missing-tool' }))
    .rejects.toThrow(/Tool "missing-tool" does not open MCP App ui:\/\/mcp-app-example\/status\.html; tools that do: show-status\./u);
  await expect(serveApp({ app: 'status', artifact: output, root: exampleRoot }))
    .rejects.toThrow(/must be named as <server>\/<app>/u);
  await expect(serveApp({ app: 'status/a/b', artifact: output, root: exampleRoot }))
    .rejects.toThrow(/must not contain a slash/u);
}, 120_000 * timeScale);
