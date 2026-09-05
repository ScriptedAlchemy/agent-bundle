import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  McpAppRoutes,
  type McpAppRoutePreviewService,
  type McpAppRoutesOptions,
} from '../src/dev/mcp-apps/mcp-app-routes.ts';
import { runtimeAppMessageLimits } from '../src/dev/runtime-app-message-limits.ts';
import { McpAppRuntimePreviewError } from '../src/dev/mcp-app-runtime-preview-service.ts';
import type { McpAppRuntimeRoutePreviewService } from '../src/dev/mcp-app-runtime-preview-service.ts';
import type { McpAppBridgeLifecycle, McpAppBridgeMessage } from '../src/dev/mcp-apps/mcp-app-bridge.ts';
import { deepFreeze } from '../src/core/freeze.ts';


interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly routes: McpAppRoutes;
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
  blockClose = false;
  forceCloseFailure: Error | undefined;
  forceCloseResult = true;
  previewAvailable = true;
  #releaseClose: (() => void) | undefined;
  #releaseFirstReceive: (() => void) | undefined;

  consentChallenges(bindingId: string) {
    return bindingId === 'binding-a' ? [{
      expiresAt: 31_000,
      id: 'consent-1',
      request: { actionFingerprint: 'act-route-demo12', capability: 'call-tool' as const, details: { name: 'refresh-weather' }, scope: 'action' as const, summary: 'Allow MCP App call tool?' },
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
    if (this.blockClose) {
      await new Promise<void>((resolvePromise) => {
        this.#releaseClose = resolvePromise;
      });
    }
    return this.closeResult;
  }

  releaseClose(): void {
    this.#releaseClose?.();
  }

  async forceClose(bindingId: string): Promise<boolean> {
    this.calls.push({ bindingId, kind: 'force-close' });
    if (this.forceCloseFailure !== undefined) throw this.forceCloseFailure;
    if (!this.forceCloseResult) return false;
    this.bridge.lifecycle = 'closed';
    return true;
  }
}

const startRoutes = async (
  service = new RecordingPreviewService(),
  gracefulCloseReceiptTimeoutMs?: number,
  openingCall?: McpAppRoutesOptions['openingCall'],
): Promise<StartedRoutes> => {
  const routes = new McpAppRoutes({
    authorize,
    ...(gracefulCloseReceiptTimeoutMs === undefined ? {} : { gracefulCloseReceiptTimeoutMs }),
    ...(openingCall === undefined ? {} : { openingCall }),
    service,
  });
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
    routes,
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

it('dispatches only the fixed authenticated runtime App create route to the optional runtime lane', async () => {
  const calls: unknown[] = [];
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async (request) => {
      calls.push(request);
      return Object.freeze({ binding: Object.freeze({ id: 'runtime-binding' }), kind: 'fallback' }) as never;
    },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: () => undefined,
    operate: async () => { throw new Error('unused'); },
  };
  const service = Object.assign(new RecordingPreviewService(), { runtime });
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/runtime/apps`, {
      body: JSON.stringify({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview: { binding: { id: 'runtime-binding' }, kind: 'fallback' } });
    expect(calls).toEqual([{ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' }]);
    expect(started.service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('rejects query-bearing runtime App routes before they reach the preview lane', async () => {
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new Error('runtime create must not receive a query-bearing route'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: () => undefined,
    operate: async () => { throw new Error('unused'); },
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    const response = await fetch(`${started.url}/api/runtime/apps?attempt=1`, {
      body: JSON.stringify({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      diagnostic: { code: 'AB8020', message: 'MCP App route path is not valid.' },
    });
  } finally {
    await started.close();
  }
});

it('authenticates runtime App snapshots before lookup and distinguishes a revoked binding from an unknown id', async () => {
  const lookups: string[] = [];
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new Error('unused'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: (bindingId) => {
      lookups.push(bindingId);
      return bindingId === 'binding-a'
        ? Object.freeze({ binding: Object.freeze({ id: bindingId }), kind: 'fallback' }) as never
        : undefined;
    },
    isRevoked: (bindingId) => bindingId === 'revoked-a',
    operate: async () => { throw new Error('unused'); },
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    const missingToken = await fetch(`${started.url}/api/runtime/apps/binding-a`, {
      headers: { origin: 'http://127.0.0.1:4567' },
    });
    expect(missingToken.status).toBe(403);
    const wrongOrigin = await fetch(`${started.url}/api/runtime/apps/binding-a`, {
      headers: { 'x-agent-bundle-session': 'test-session-token' },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(lookups).toEqual([]);

    const available = await fetch(`${started.url}/api/runtime/apps/binding-a`, { headers: headers() });
    expect(available.status).toBe(200);
    expect(available.headers.get('cache-control')).toBe('no-store');
    expect(available.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(available.json()).resolves.toEqual({ preview: { binding: { id: 'binding-a' }, kind: 'fallback' } });
    expect(lookups).toEqual(['binding-a']);

    const revoked = await fetch(`${started.url}/api/runtime/apps/revoked-a`, { headers: headers() });
    expect(revoked.status).toBe(410);
    const unknown = await fetch(`${started.url}/api/runtime/apps/unknown-a`, { headers: headers() });
    expect(unknown.status).toBe(404);
  } finally {
    await started.close();
  }
});

it('classifies unavailable runtime App operations as unknown or revoked before delegating', async () => {
  const operations: string[] = [];
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new Error('unused'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: () => undefined,
    isRevoked: (bindingId) => bindingId === 'revoked-a',
    operate: async (bindingId) => {
      operations.push(bindingId);
      throw new Error('unavailable runtime operation must not delegate');
    },
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    for (const [bindingId, status] of [['unknown-a', 404], ['revoked-a', 410]] as const) {
      const response = await fetch(`${started.url}/api/runtime/apps/${bindingId}/operations`, {
        body: JSON.stringify({ kind: 'tools/list' }),
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(status);
    }
    expect(operations).toEqual([]);
  } finally {
    await started.close();
  }
});

it('forwards one request-owned abort signal to each admitted runtime App operation', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new Error('unused'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: (bindingId) => bindingId === 'runtime-binding'
      ? Object.freeze({ binding: Object.freeze({ id: bindingId }), kind: 'fallback' }) as never
      : undefined,
    operate: async (_bindingId, _operation, options?: Readonly<{ readonly signal?: AbortSignal }>) => {
      signals.push(options?.signal);
      return deepFreeze({ result: { content: Object.freeze([]) } }) as never;
    },
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    const response = await fetch(`${started.url}/api/runtime/apps/runtime-binding/operations`, {
      body: JSON.stringify({ kind: 'tools/list' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(signals).toEqual([expect.any(AbortSignal)]);
    expect(signals[0]?.aborted).toBe(false);
  } finally {
    await started.close();
  }
});

it('aborts an admitted runtime App operation when its HTTP client disconnects', async () => {
  let operationSignal: AbortSignal | undefined;
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new Error('unused'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: (bindingId) => bindingId === 'runtime-binding'
      ? Object.freeze({ binding: Object.freeze({ id: bindingId }), kind: 'fallback' }) as never
      : undefined,
    operate: async (_bindingId, _operation, options?: Readonly<{ readonly signal?: AbortSignal }>) => new Promise((_resolve, reject) => {
      operationSignal = options?.signal;
      operationSignal?.addEventListener('abort', () => reject(operationSignal?.reason), { once: true });
    }),
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    const target = new URL(`/api/runtime/apps/runtime-binding/operations`, started.url);
    const pending = httpRequest(target, {
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    pending.on('error', () => undefined);
    pending.end(JSON.stringify({ kind: 'tools/list' }));
    await eventually(() => operationSignal !== undefined);
    pending.destroy();
    await eventually(() => operationSignal?.aborted === true);
    expect(operationSignal?.reason).toBeInstanceOf(Error);
  } finally {
    await started.close();
  }
});

it('serializes complete runtime App operation results within the directional UTF-8 transport bound', async () => {
  const resultFor = (text: string) => ({ result: { content: [{ text, type: 'text' }] } });
  const maximumBytes = runtimeAppMessageLimits.hostToAppBytes;
  const fixedBytes = Buffer.byteLength(JSON.stringify(resultFor('')), 'utf8');
  const exactText = 'x'.repeat(maximumBytes - fixedBytes);
  const multibyteText = 'é'.repeat(Math.floor((maximumBytes - fixedBytes - 1) / 2));
  let result = resultFor(exactText);
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new Error('unused'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: (bindingId) => bindingId === 'runtime-binding'
      ? Object.freeze({ binding: Object.freeze({ id: bindingId }), kind: 'fallback' }) as never
      : undefined,
    operate: async () => result as never,
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  const operation = () => fetch(`${started.url}/api/runtime/apps/runtime-binding/operations`, {
    body: JSON.stringify({ kind: 'tools/list' }),
    headers: { ...headers(), 'content-type': 'application/json' },
    method: 'POST',
  });
  try {
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(maximumBytes);
    const exact = await operation();
    expect(exact.status).toBe(200);
    expect(exact.headers.get('content-length')).toBe(String(maximumBytes));
    await expect(exact.json()).resolves.toEqual(result);

    result = resultFor(multibyteText);
    const multibyteBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(multibyteBytes).toBeLessThanOrEqual(maximumBytes);
    expect(multibyteBytes).toBeGreaterThan(maximumBytes - 3);
    const multibyte = await operation();
    expect(multibyte.status).toBe(200);
    expect(multibyte.headers.get('content-length')).toBe(String(multibyteBytes));
    await expect(multibyte.json()).resolves.toEqual(result);

    result = resultFor(`${exactText}x`);
    const rejected = await operation();
    expect(rejected.status).toBe(413);
    expect(rejected.headers.get('content-length')).toBeNull();
    await expect(rejected.json()).resolves.toEqual({
      diagnostic: { code: 'AB8023', message: 'Runtime MCP App operation response exceeds its transport bound.' },
    });
  } finally {
    await started.close();
  }
});

it('permits an authenticated DELETE retry for a revoked runtime App cleanup but never for an unknown id', async () => {
  const closes: string[] = [];
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async (bindingId) => { closes.push(bindingId); },
    create: async () => { throw new Error('unused'); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: () => undefined,
    isRevoked: (bindingId) => bindingId === 'revoked-a',
    operate: async () => { throw new Error('unused'); },
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    const retry = await fetch(`${started.url}/api/runtime/apps/revoked-a`, { headers: headers(), method: 'DELETE' });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ closed: true });

    const unknown = await fetch(`${started.url}/api/runtime/apps/unknown-a`, { headers: headers(), method: 'DELETE' });
    expect(unknown.status).toBe(404);
    expect(closes).toEqual(['revoked-a']);
  } finally {
    await started.close();
  }
});

it('returns a phase-safe 409 when a runtime App create request names a stale run generation', async () => {
  const runtime: McpAppRuntimeRoutePreviewService = {
    close: async () => undefined,
    create: async () => { throw new McpAppRuntimePreviewError('AB8204', 'Runtime MCP App run generation does not match the expected generation.', 409); },
    createConsent: async () => { throw new Error('unused'); },
    decideConsent: async () => { throw new Error('unused'); },
    get: () => undefined,
    operate: async () => { throw new Error('unused'); },
  };
  const started = await startRoutes(Object.assign(new RecordingPreviewService(), { runtime }));
  try {
    const response = await fetch(`${started.url}/api/runtime/apps`, {
      body: JSON.stringify({ expectedGenerationId: 'stale-generation', profileId: 'portable', runId: 'run-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      diagnostic: { code: 'AB8204', message: 'Runtime MCP App run generation does not match the expected generation.' },
    });
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

it('binds the host\'s own opening call when a create request omits input and result (#562)', async () => {
  // A result far past the 64 KiB request-body bound: the host holds it, so the
  // page never sends it back.
  const large = { structuredContent: { rows: Array.from({ length: 4000 }, (_, index) => ({ index, text: 'x'.repeat(24) })) } };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(64 * 1024);
  const service = new RecordingPreviewService();
  const openings: (string | undefined)[] = [];
  const started = await startRoutes(service, undefined, (sessionId, toolName, opening) => {
    openings.push(opening);
    return sessionId === 'session-a' && toolName === 'show-weather' && opening !== 'stale-page'
      ? { input: { city: 'Oslo' }, result: large }
      : undefined;
  });
  try {
    const bound = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ host, previewProfile: 'portable', toolName: 'show-weather' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(bound.status).toBe(200);
    expect(service.calls).toEqual([{
      kind: 'create',
      options: { host, input: { city: 'Oslo' }, previewProfile: 'portable', result: large, sessionId: 'session-a', toolName: 'show-weather' },
    }]);
    // A page's opaque opening id reaches the host verbatim, so a many-page
    // host can hand each page its own call.
    const named = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ host, opening: 'page-7', previewProfile: 'portable', toolName: 'show-weather' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(named.status).toBe(200);
    expect(openings).toEqual([undefined, 'page-7']);

    // Another tool, a session the host did not open, an opening the host no
    // longer holds, a blank opening, or an opening sent alongside the
    // Workbench's own call: none has a call to bind.
    for (const body of [
      { host, previewProfile: 'portable', toolName: 'other-tool' },
      { host, input: { city: 'Oslo' }, previewProfile: 'portable', toolName: 'show-weather' },
      { host, opening: 'stale-page', previewProfile: 'portable', toolName: 'show-weather' },
      { host, opening: '', previewProfile: 'portable', toolName: 'show-weather' },
      { host, input: { city: 'Oslo' }, opening: 'page-7', previewProfile: 'portable', result: large, toolName: 'show-weather' },
    ]) {
      const response = await fetch(`${started.url}/api/mcp/sessions/session-a/apps`, {
        body: JSON.stringify(body),
        headers: { ...headers(), 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ diagnostic: { code: 'AB8021', message: 'MCP App request has an invalid shape.' } });
    }
    const otherSession = await fetch(`${started.url}/api/mcp/sessions/session-b/apps`, {
      body: JSON.stringify({ host, previewProfile: 'portable', toolName: 'show-weather' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(otherSession.status).toBe(400);
    expect(service.calls).toHaveLength(2);
  } finally {
    await started.close();
  }

  // Without a host-made call, the Workbench shape stays required.
  const plain = await startRoutes();
  try {
    const response = await fetch(`${plain.url}/api/mcp/sessions/session-a/apps`, {
      body: JSON.stringify({ host, previewProfile: 'portable', toolName: 'show-weather' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(plain.service.calls).toEqual([]);
  } finally {
    await plain.close();
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

it('uses a graceful-close receipt for one fallback DELETE after its binding releases', async () => {
  const started = await startRoutes();
  try {
    const closing = await fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(closing.status).toBe(200);

    started.service.forceCloseResult = false;
    const fallback = await fetch(`${started.url}/api/mcp/apps/binding-a`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(fallback.status).toBe(200);
    await expect(fallback.json()).resolves.toEqual({ closed: true, lifecycle: 'closed' });

    const retry = await fetch(`${started.url}/api/mcp/apps/binding-a`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(retry.status).toBe(404);
    await expect(retry.json()).resolves.toEqual({
      diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' },
    });
    expect(started.service.calls.filter((call) => (call as { readonly kind?: string }).kind === 'force-close')).toHaveLength(2);

    const unknown = await fetch(`${started.url}/api/mcp/apps/forged-binding`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(unknown.status).toBe(404);
  } finally {
    await started.close();
  }
});

it('serializes a fallback DELETE behind an accepted graceful close', async () => {
  const started = await startRoutes();
  try {
    started.service.blockClose = true;
    started.service.forceCloseResult = false;
    const closing = fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    await eventually(() => started.service.calls.some((call) => (call as { readonly kind?: string }).kind === 'close'));
    const fallback = fetch(`${started.url}/api/mcp/apps/binding-a`, { headers: headers(), method: 'DELETE' });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    const forceCloseCalls = started.service.calls.filter((call) => (call as { readonly kind?: string }).kind === 'force-close');
    started.service.releaseClose();

    expect(forceCloseCalls).toHaveLength(0);
    expect((await closing).status).toBe(200);
    expect((await fallback).status).toBe(200);
  } finally {
    started.service.releaseClose();
    await started.close();
  }
});

it('expires a graceful-close receipt before a later fallback DELETE', async () => {
  // The production window is 35s (it must dominate the relay's 30s force-close
  // cap); expiry semantics are what matters here, so the window is shortened
  // through the injectable seam instead of sleeping for real.
  const started = await startRoutes(undefined, 1_000);
  try {
    const closing = await fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(closing.status).toBe(200);

    started.service.forceCloseResult = false;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_100));
    const fallback = await fetch(`${started.url}/api/mcp/apps/binding-a`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(fallback.status).toBe(404);
  } finally {
    await started.close();
  }
}, 7_000);

it('does not treat a rejected force close as a completed graceful close', async () => {
  const started = await startRoutes();
  try {
    const closing = await fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(closing.status).toBe(200);

    started.service.forceCloseFailure = new Error('binding release rejected');
    const fallback = await fetch(`${started.url}/api/mcp/apps/binding-a`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(fallback.status).toBe(502);
    await expect(fallback.json()).resolves.toEqual({
      diagnostic: { code: 'AB8023', message: 'MCP App operation could not be completed.' },
    });
  } finally {
    await started.close();
  }
});

it('does not retain a graceful-close receipt after routes close during an admitted request', async () => {
  const started = await startRoutes();
  const originalSetTimeout = globalThis.setTimeout;
  const receiptTimers: number[] = [];
  try {
    started.service.blockClose = true;
    const closing = fetch(`${started.url}/api/mcp/apps/binding-a/close`, {
      body: JSON.stringify({ id: 'close-a' }),
      headers: { ...headers(), 'content-type': 'application/json' },
      method: 'POST',
    });
    await eventually(() => started.service.calls.some((call) => (call as { readonly kind?: string }).kind === 'close'));
    started.routes.close();
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) => {
      const timer = originalSetTimeout(callback, delay, ...arguments_);
      if (delay === 5_000) receiptTimers.push(timer);
      return timer;
    }) as typeof setTimeout;
    started.service.releaseClose();

    expect((await closing).status).toBe(200);
    expect(receiptTimers).toEqual([]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    for (const timer of receiptTimers) clearTimeout(timer);
    started.service.releaseClose();
    await started.close();
  }
});
