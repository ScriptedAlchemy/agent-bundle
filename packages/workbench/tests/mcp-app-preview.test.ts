import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import {
  createMcpAppPreviewController,
  McpAppPreview,
  McpAppPreviewFrame,
  type McpAppFrameRelayFactory,
  type McpAppPreviewClient,
} from '../src/mcp/mcp-app-preview.tsx';
import type {
  McpAppHostContext,
  McpAppJsonValue,
  McpAppPreview as Preview,
  McpAppPreviewCreateRequest,
  McpAppRelayFrame,
  McpAppRouteClose,
  McpAppRouteMessages,
} from '../src/mcp/mcp-app-client.ts';
import type { McpAppFrameIframe, McpAppFrameRelayOptions, McpAppFrameWindow } from '../src/mcp/mcp-app-frame.tsx';

const host: McpAppHostContext = Object.freeze({
  availableDisplayModes: Object.freeze(['inline']),
  containerDimensions: Object.freeze({ height: 480, width: 640 }),
  deviceCapabilities: Object.freeze({}),
  displayMode: 'inline',
  locale: 'en-US',
  platform: 'web',
  safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
  styles: Object.freeze({}),
  theme: 'light',
  timeZone: 'Etc/UTC',
  userAgent: 'Agent Bundle Workbench',
});

const frame: McpAppRelayFrame = Object.freeze({
  allow: '',
  policy: Object.freeze({
    contentSecurityPolicy: "default-src 'none'",
    iframeAllow: '',
    permissionsPolicy: 'camera=()',
  }),
  referrerPolicy: 'no-referrer',
  relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 4 }),
  sandbox: 'allow-scripts allow-same-origin',
  src: 'http://127.0.0.1:43124/#mcp-app-preview',
  targetOrigin: 'http://127.0.0.1:43124',
});

const resource: McpAppJsonValue = Object.freeze({
  csp: Object.freeze({ connectDomains: Object.freeze(['https://api.example.test']) }),
  html: '<main>Forecast</main>',
  kind: 'resource',
  permissions: Object.freeze({}),
});

const preview = (overrides: Partial<Preview> = {}): Preview => Object.freeze({
  bindingId: 'binding-weather',
  frame,
  profile: Object.freeze({ kind: 'apps', profile: 'portable', resourceUri: 'ui://weather/forecast.html' }),
  resource,
  ...overrides,
});

const closed = (): McpAppRouteClose => Object.freeze({ lifecycle: 'closed' });
const messages = (): McpAppRouteMessages => Object.freeze({ accepted: true, lifecycle: 'initialized', messages: Object.freeze([]) });

const fakeClient = (result: Promise<Preview>) => {
  const creates: McpAppPreviewCreateRequest[] = [];
  const forceClosed: string[] = [];
  const client: McpAppPreviewClient = {
    async close() { return closed(); },
    async create(_sessionId, request) {
      creates.push(request);
      return result;
    },
    async forceClose(bindingId) {
      forceClosed.push(bindingId);
      return true;
    },
    async message() { return messages(); },
  };
  return { client, creates, forceClosed };
};

const iframe = (): McpAppFrameIframe => Object.freeze({
  contentWindow: Object.freeze({ postMessage: () => undefined }),
});

const browserWindow: McpAppFrameWindow = Object.freeze({
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

describe('MCP App preview', () => {
  it('creates a preview from immutable tool data and starts a relay bound to the exact sandbox frame', async () => {
    const input: McpAppJsonValue = Object.freeze({ city: 'Paris', nested: Object.freeze({ unit: 'celsius' }) });
    const result: McpAppJsonValue = Object.freeze({ temperature: 22 });
    const { client, creates, forceClosed } = fakeClient(Promise.resolve(preview()));
    const relay = { closeCalls: 0, startCalls: 0 };
    const factoryCalls: McpAppFrameRelayOptions[] = [];
    const frameRelayFactory: McpAppFrameRelayFactory = (options) => {
      factoryCalls.push(options);
      return {
        async close() { relay.closeCalls += 1; },
        start() { relay.startCalls += 1; return true; },
      };
    };
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory,
      host,
      input,
      result,
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();
    const mountedIframe = iframe();
    controller.attachFrame(mountedIframe, browserWindow);

    expect(creates).toEqual([{
      host,
      input: { city: 'Paris', nested: { unit: 'celsius' } },
      previewProfile: 'portable',
      result: { temperature: 22 },
      toolName: 'show-weather',
    }]);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen((input as { readonly nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(controller.state).toMatchObject({ phase: 'ready' });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]).toMatchObject({ bindingId: 'binding-weather', frame, resource, window: browserWindow });
    expect(factoryCalls[0]?.iframe).toBe(mountedIframe);
    expect(relay.startCalls).toBe(1);

    await controller.close();

    expect(relay.closeCalls).toBe(1);
    expect(forceClosed).toEqual([]);
  });

  it('keeps the ordinary fallback visible and closes its unused binding when no canonical App frame is available', async () => {
    const fallback: McpAppJsonValue = Object.freeze({
      input: Object.freeze({ city: 'Paris' }),
      kind: 'fallback',
      reason: 'invalid-resource',
      result: Object.freeze({ text: 'Sunny' }),
    });
    const { client, forceClosed } = fakeClient(Promise.resolve(preview({ frame: undefined, resource: fallback })));
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => { throw new Error('fallback must not start a relay'); },
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();
    await controller.close();

    expect(controller.state).toMatchObject({ fallback: { reason: 'invalid-resource' }, phase: 'fallback' });
    expect(forceClosed).toEqual(['binding-weather']);
  });

  it('refuses a sandbox frame unless its profile proves the canonical ui resource', async () => {
    const { client, forceClosed } = fakeClient(Promise.resolve(preview({
      profile: Object.freeze({ kind: 'apps', profile: 'portable' }),
    })));
    const controller = createMcpAppPreviewController({
      client,
      frameRelayFactory: () => { throw new Error('an unproven resource must not start a relay'); },
      host,
      input: Object.freeze({ city: 'Paris' }),
      result: Object.freeze({ text: 'Sunny' }),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await controller.start();

    expect(controller.state).toMatchObject({ fallback: { reason: 'invalid-resource' }, phase: 'fallback' });
    expect(controller.attachFrame(iframe(), browserWindow)).toBe(false);
    await controller.close();
    expect(forceClosed).toEqual(['binding-weather']);
  });

  it('reports create failures and force-closes a relay when graceful unmount cleanup rejects', async () => {
    const failed = fakeClient(Promise.reject(new Error('preview route failed')));
    const createFailure = createMcpAppPreviewController({
      client: failed.client,
      frameRelayFactory: () => { throw new Error('not reached'); },
      host,
      input: Object.freeze({}),
      result: Object.freeze({}),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });

    await createFailure.start();

    expect(createFailure.state).toMatchObject({ phase: 'error', message: 'preview route failed' });

    const active = fakeClient(Promise.resolve(preview()));
    const relayFailure = createMcpAppPreviewController({
      client: active.client,
      frameRelayFactory: () => ({
        async close() { throw new Error('graceful close failed'); },
        start: () => true,
      }),
      host,
      input: Object.freeze({}),
      result: Object.freeze({}),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    });
    await relayFailure.start();
    relayFailure.attachFrame(iframe(), browserWindow);
    await relayFailure.close();

    expect(active.forceClosed).toEqual(['binding-weather']);
  });

  it('has an SSR-safe accessible loading boundary and an exact credential-free sandbox iframe', () => {
    const { client } = fakeClient(Promise.resolve(preview()));
    const loading = renderToStaticMarkup(createElement(McpAppPreview, {
      client,
      frameRelayFactory: () => ({ async close() {}, start: () => true }),
      host,
      input: Object.freeze({ secret: 'foreground-secret' }),
      result: Object.freeze({}),
      sessionId: 'session-weather',
      toolName: 'show-weather',
    }));
    const sandbox = renderToStaticMarkup(createElement(McpAppPreviewFrame, { frame }));

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain('foreground-secret');
    expect(sandbox).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(sandbox).toContain('src="http://127.0.0.1:43124/#mcp-app-preview"');
    expect(sandbox).toContain('referrerPolicy="no-referrer"');
    expect(sandbox).not.toContain('srcdoc=');
  });
});
