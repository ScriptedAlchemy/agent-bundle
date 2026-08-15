import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  McpAppRoutes,
  type McpAppRoutePreviewService,
} from '../src/dev/mcp-app-routes.ts';
import type { McpAppBridgeLifecycle, McpAppBridgeMessage } from '../src/dev/mcp-app-bridge.ts';

interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly service: RecordingPreviewService;
  readonly url: string;
}

const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly message: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

const authorize = (request: IncomingMessage): void => {
  if (request.headers.origin !== 'http://127.0.0.1:4567') {
    throw routeError('AB8003', 'Request origin is not this foreground server.', 403);
  }
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

class RecordingPreviewService implements McpAppRoutePreviewService {
  readonly calls: unknown[] = [];
  readonly bridge = {
    lifecycle: 'created' as McpAppBridgeLifecycle,
    publishHostContextChanged: (context: Record<string, unknown>): boolean => {
      this.calls.push({ context, kind: 'host-context' });
      this.outbound.push({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: context });
      return true;
    },
  };
  readonly preview = Object.freeze({
    binding: Object.freeze({ id: 'binding-a' }),
    bridge: this.bridge,
    frame: Object.freeze({ src: 'http://sandbox.test/#fixture' }),
    profile: Object.freeze({ kind: 'apps', profile: 'portable' }),
    resource: Object.freeze({ html: '<main>Weather</main>', kind: 'resource' }),
  });
  readonly outbound: unknown[] = [];
  blockFirstReceive = false;
  readonly closeFrame: McpAppBridgeMessage = Object.freeze({
    id: 'service-close-a',
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
    params: Object.freeze({ canonical: true }),
  });
  closeResult: McpAppBridgeMessage | true = this.closeFrame;
  expiredConsentConsumed = false;
  previewAvailable = true;
  #releaseFirstReceive: (() => void) | undefined;

  consentChallenges(bindingId: string) {
    return bindingId === 'binding-a' ? [{
      expiresAt: 31_000,
      id: 'consent-1',
      request: { capability: 'call-tool' as const, details: { name: 'refresh-weather' }, scope: 'action' as const, summary: 'Allow MCP App call tool?' },
    }] : undefined;
  }

  decideConsent(bindingId: string, challengeId: string, approved: boolean) {
    if (bindingId === 'binding-a' && challengeId === 'expired-consent' && approved && !this.expiredConsentConsumed) {
      this.expiredConsentConsumed = true;
      this.outbound.push({ error: { code: -32001, message: 'ui/open-link requires an approved consent grant.' }, id: 'expired-link', jsonrpc: '2.0' });
      return false;
    }
    if (bindingId !== 'binding-a' || challengeId !== 'consent-1' || !approved) return false;
    return true;
  }

  get(bindingId: string) {
    return this.previewAvailable && bindingId === this.preview.binding.id ? this.preview : undefined;
  }

  async create(options: Parameters<McpAppRoutePreviewService['create']>[0]) {
    this.calls.push({ kind: 'create', options });
    return this.preview;
  }

  async receive(bindingId: string, action: unknown): Promise<boolean> {
    this.calls.push({ action, bindingId, kind: 'receive' });
    if (this.blockFirstReceive) {
      this.blockFirstReceive = false;
      await new Promise<void>((resolvePromise) => {
        this.#releaseFirstReceive = resolvePromise;
      });
    }
    if (this.bridge.lifecycle === 'closing' && (action as { readonly id?: unknown }).id === 'close-a') {
      this.bridge.lifecycle = 'closed';
      this.previewAvailable = false;
      return true;
    }
    this.bridge.lifecycle = 'initialized';
    this.outbound.push({ id: (action as { readonly id?: unknown }).id, jsonrpc: '2.0', result: { accepted: true } });
    return true;
  }

  releaseFirstReceive(): void {
    this.#releaseFirstReceive?.();
  }

  async takeOutbound(bindingId: string): Promise<readonly unknown[]> {
    this.calls.push({ bindingId, kind: 'take-outbound' });
    return this.outbound.splice(0);
  }

  async close(bindingId: string, options: { readonly id: string | number | null; readonly reason?: string }): Promise<McpAppBridgeMessage | true> {
    this.calls.push({ bindingId, kind: 'close', options });
    this.bridge.lifecycle = 'closing';
    return this.closeResult;
  }

  async forceClose(bindingId: string): Promise<boolean> {
    this.calls.push({ bindingId, kind: 'force-close' });
    this.bridge.lifecycle = 'closed';
    return true;
  }
}

const startRoutes = async (): Promise<StartedRoutes> => {
  const service = new RecordingPreviewService();
  const routes = new McpAppRoutes({ authorize, service });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; message: string; status: number }>;
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ diagnostic: {
        code: diagnostic.code ?? 'AB8007',
        message: diagnostic.message ?? 'Request could not be completed.',
      } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    })),
    service,
    url: `http://127.0.0.1:${address.port}`,
  });
};

const headers = (): Readonly<Record<string, string>> => ({
  origin: 'http://127.0.0.1:4567',
  'x-agent-bundle-session': 'test-session-token',
});

const host = Object.freeze({
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
  userAgent: 'agent-bundle-test/1.0',
});

const createBody = () => ({
  host,
  input: { city: 'Paris' },
  previewProfile: 'portable',
  result: { content: [{ text: 'Sunny', type: 'text' }] },
  toolName: 'show-weather',
});

const eventually = async (predicate: () => boolean, milliseconds = 250): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${milliseconds}ms.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
};

it('leaves unrelated MCP paths for the session route handler', async () => {
  const started = await startRoutes();
  try {
    const response = await fetch(`${started.url}/api/mcp/sessions`, {
      headers: { origin: 'http://127.0.0.1:4567', 'x-agent-bundle-session': 'test-session-token' },
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(started.service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('exposes only server-created consent challenges and accepts a decision by opaque challenge id', async () => {
  const started = await startRoutes();
  try {
    const listed = await fetch(`${started.url}/api/mcp/apps/binding-a/consent`, { headers: headers() });
    await expect(listed.json()).resolves.toMatchObject({ challenges: [{ id: 'consent-1', request: { scope: 'action' } }] });
    const forged = await fetch(`${started.url}/api/mcp/apps/binding-a/consent`, {
      body: JSON.stringify({ approved: true, challengeId: 'camera-from-browser' }),
      headers: { ...headers(), 'content-type': 'application/json' }, method: 'POST',
    });
    await expect(forged.json()).resolves.toMatchObject({ approved: false, lifecycle: 'created', messages: [], preview: { bindingId: 'binding-a' } });
    const approved = await fetch(`${started.url}/api/mcp/apps/binding-a/consent`, {
      body: JSON.stringify({ approved: true, challengeId: 'consent-1' }),
      headers: { ...headers(), 'content-type': 'application/json' }, method: 'POST',
    });
    await expect(approved.json()).resolves.toMatchObject({ approved: true, lifecycle: 'created', messages: [], preview: { bindingId: 'binding-a' } });
  } finally {
    await started.close();
  }
});

it('returns the one terminal bridge denial from an exact expired action decision without answering replays', async () => {
  const started = await startRoutes();
  try {
    const expired = await fetch(`${started.url}/api/mcp/apps/binding-a/consent`, {
      body: JSON.stringify({ approved: true, challengeId: 'expired-consent' }),
      headers: { ...headers(), 'content-type': 'application/json' }, method: 'POST',
    });
    await expect(expired.json()).resolves.toMatchObject({
      approved: false,
      messages: [{ error: { code: -32001 }, id: 'expired-link' }],
    });
    const replay = await fetch(`${started.url}/api/mcp/apps/binding-a/consent`, {
      body: JSON.stringify({ approved: true, challengeId: 'expired-consent' }),
      headers: { ...headers(), 'content-type': 'application/json' }, method: 'POST',
    });
    await expect(replay.json()).resolves.toMatchObject({ approved: false, messages: [] });
  } finally {
    await started.close();
  }
});

it('creates an App preview from only session-scoped JSON data', async () => {
  const started = await startRoutes();
  try {
    const response = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify(createBody()),
      headers: { ...headers(), 'content-type': 'application/json; charset=utf-8' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      lifecycle: 'created',
      preview: {
        bindingId: 'binding-a',
        frame: { src: 'http://sandbox.test/#fixture' },
        profile: { kind: 'apps', profile: 'portable' },
        resource: { html: '<main>Weather</main>', kind: 'resource' },
      },
    });
    expect(started.service.calls).toEqual([{
      kind: 'create',
      options: {
        host,
        input: { city: 'Paris' },
        previewProfile: 'portable',
        result: { content: [{ text: 'Sunny', type: 'text' }] },
        sessionId: 'session-a',
        toolName: 'show-weather',
      },
    }]);
  } finally {
    await started.close();
  }
});

it('rejects obsolete browser-created document consent on preview creation', async () => {
  const started = await startRoutes();
  try {
    const response = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ ...createBody(), consent: { permissions: { camera: {} } } }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8021' } });
    expect(started.service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('rejects unauthenticated, non-JSON, oversized, and forged App requests before service calls', async () => {
  const started = await startRoutes();
  try {
    const unauthenticated = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify(createBody()),
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4567' },
      method: 'POST',
    });
    expect(unauthenticated.status).toBe(403);
    await expect(unauthenticated.json()).resolves.toEqual({
      diagnostic: { code: 'AB8004', message: 'A valid same-session token is required.' },
    });

    const nonJson = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify(createBody()),
      headers: headers(),
      method: 'POST',
    });
    expect(nonJson.status).toBe(415);
    await expect(nonJson.json()).resolves.toEqual({
      diagnostic: { code: 'AB8009', message: 'Request body must use application/json.' },
    });

    const forged = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ ...createBody(), command: 'node', epochId: 'forged', serverName: 'forged' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(forged.status).toBe(400);
    await expect(forged.json()).resolves.toEqual({
      diagnostic: { code: 'AB8021', message: 'MCP App request has an invalid shape.' },
    });

    const forgedTool = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ ...createBody(), host: { ...host, toolInfo: { name: 'forged-tool' } } }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(forgedTool.status).toBe(400);
    await expect(forgedTool.json()).resolves.toEqual({
      diagnostic: { code: 'AB8021', message: 'MCP App request has an invalid shape.' },
    });

    const forgedMetadata = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ ...createBody(), toolDefinition: { _meta: { ui: { resourceUri: 'ui://forged/app.html' } } } }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(forgedMetadata.status).toBe(400);
    await expect(forgedMetadata.json()).resolves.toEqual({
      diagnostic: { code: 'AB8021', message: 'MCP App request has an invalid shape.' },
    });

    const oversized = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ ...createBody(), input: 'x'.repeat(65_536) }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      diagnostic: { code: 'AB8010', message: 'Request body exceeds 64 KiB.' },
    });
    expect(started.service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('serializes App message delivery and returns its outbound messages with lifecycle state', async () => {
  const started = await startRoutes();
  started.service.blockFirstReceive = true;
  const send = (id: string) => fetch(`${started.url}/api/mcp/apps/binding-a/messages`, {
    body: JSON.stringify({ message: { id, jsonrpc: '2.0', method: 'ui/message', params: { text: id } } }),
    headers: { ...headers(), 'content-type': 'application/json' },
    method: 'POST',
  });
  try {
    const first = send('first');
    await eventually(() => started.service.calls.some((call) => (call as { readonly kind?: string }).kind === 'receive'));
    const second = send('second');
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 15));
    expect(started.service.calls.filter((call) => (call as { readonly kind?: string }).kind === 'receive')).toHaveLength(1);

    started.service.releaseFirstReceive();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({
      accepted: true,
      actions: [],
      lifecycle: 'initialized',
      messages: [{ id: 'first', jsonrpc: '2.0', result: { accepted: true } }],
    });
    await expect(secondResponse.json()).resolves.toEqual({
      accepted: true,
      actions: [],
      lifecycle: 'initialized',
      messages: [{ id: 'second', jsonrpc: '2.0', result: { accepted: true } }],
    });
    expect(started.service.calls.filter((call) => (call as { readonly kind?: string }).kind === 'receive')).toEqual([
      { action: { id: 'first', jsonrpc: '2.0', method: 'ui/message', params: { text: 'first' } }, bindingId: 'binding-a', kind: 'receive' },
      { action: { id: 'second', jsonrpc: '2.0', method: 'ui/message', params: { text: 'second' } }, bindingId: 'binding-a', kind: 'receive' },
    ]);
  } finally {
    await started.close();
  }
});

it('publishes a complete host context and rejects forged context fields', async () => {
  const started = await startRoutes();
  try {
    const published = await fetch(`${started.url}/api/mcp/apps/binding-a/host-context`, {
      body: JSON.stringify({ host }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toEqual({
      accepted: true,
      actions: [],
      lifecycle: 'created',
      messages: [{
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: host,
      }],
    });

    const forged = await fetch(`${started.url}/api/mcp/apps/binding-a/host-context`, {
      body: JSON.stringify({ host: { ...host, path: '/tmp/forged' } }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(forged.status).toBe(400);
    await expect(forged.json()).resolves.toEqual({
      diagnostic: { code: 'AB8021', message: 'MCP App request has an invalid shape.' },
    });
  } finally {
    await started.close();
  }
});

it('keeps the App acknowledgement route claimed while graceful teardown is pending', async () => {
  const started = await startRoutes();
  try {
    const closing = await fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-a', reason: 'pane closed' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(closing.status).toBe(200);
    await expect(closing.json()).resolves.toEqual({
      actions: [],
      lifecycle: 'closing',
      message: {
        id: 'service-close-a',
        jsonrpc: '2.0',
        method: 'ui/resource-teardown',
        params: { canonical: true },
      },
    });
    expect(started.service.calls).toContainEqual({
      bindingId: 'binding-a',
      kind: 'close',
      options: { id: 'close-a', reason: 'pane closed' },
    });

    const duplicateClose = await fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-b' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(duplicateClose.status).toBe(200);
    await expect(duplicateClose.json()).resolves.toEqual({ actions: [], lifecycle: 'closing' });
    expect(started.service.calls.filter((call) => (call as { readonly kind?: string }).kind === 'close')).toHaveLength(1);

    const acknowledgement = await fetch(`${started.url}/api/mcp/apps/binding-a/messages`, {
      body: JSON.stringify({ message: { id: 'close-a', jsonrpc: '2.0', result: {} } }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(acknowledgement.status).toBe(200);
    await expect(acknowledgement.json()).resolves.toEqual({
      accepted: true,
      actions: [],
      lifecycle: 'closed',
      messages: [],
    });

    const duplicateAcknowledgement = await fetch(`${started.url}/api/mcp/apps/binding-a/messages`, {
      body: JSON.stringify({ message: { id: 'close-a', jsonrpc: '2.0', result: {} } }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(duplicateAcknowledgement.status).toBe(404);
    await expect(duplicateAcknowledgement.json()).resolves.toEqual({
      diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' },
    });
  } finally {
    await started.close();
  }
});

it('does not synthesize a teardown message when the preview closes before initialization', async () => {
  const started = await startRoutes();
  started.service.closeResult = true;
  try {
    const closing = await fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-uninitialized' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(closing.status).toBe(200);
    await expect(closing.json()).resolves.toEqual({ actions: [], lifecycle: 'closing' });
  } finally {
    await started.close();
  }
});

it('force closes an App preview on DELETE', async () => {
  const started = await startRoutes();
  try {
    started.service.previewAvailable = false;
    started.service.bridge.lifecycle = 'closing';
    const closed = await fetch(`${started.url}/api/mcp/apps/binding-a`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toEqual({ closed: true, lifecycle: 'closed' });
    expect(started.service.calls).toContainEqual({ bindingId: 'binding-a', kind: 'force-close' });
  } finally {
    await started.close();
  }
});
