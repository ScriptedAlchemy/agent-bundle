import { afterEach, expect, it } from '@rstest/core';

import { mountBrowserApp, type MountBrowserAppOptions, type MountedBrowserApp } from 'agent-bundle/test/browser';

type BindingOperations = MountBrowserAppOptions['operations'];
type ToolCallResult = Awaited<ReturnType<BindingOperations['callTool']>>;

const statusResult = Object.freeze({
  content: Object.freeze([Object.freeze({
    text: 'Payment latency is above the release threshold.',
    type: 'text',
  })]),
  structuredContent: Object.freeze({
    checks: Object.freeze([
      Object.freeze({ label: 'Availability', status: 'passing' }),
      Object.freeze({ label: 'P95 latency', status: 'failing' }),
    ]),
    service: 'payments-api',
    status: 'degraded',
    summary: 'Payment latency is above the release threshold.',
  }),
});

const mounted: MountedBrowserApp[] = [];

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((app) => app.dispose()));
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the status panel.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const operations = (options: {
  readonly callTool?: () => Promise<ToolCallResult>;
  readonly calls?: string[];
  readonly reads?: string[];
} = {}): BindingOperations => ({
  callTool: async (_bindingId: string, request: { readonly name: string }) => {
    options.calls?.push(request.name);
    return options.callTool?.() ?? statusResult;
  },
  closeBinding: async () => true,
  readResource: async (_bindingId: string, request: { readonly uri: string }) => {
    options.reads?.push(request.uri);
    return {
      contents: [{
        mimeType: 'text/plain',
        text: 'Only passing checks permit release.',
        uri: request.uri,
      }],
    };
  },
});

const mountStatus = async (overrides: Partial<Parameters<typeof mountBrowserApp>[1]> = {}) => {
  const app = await mountBrowserApp('status', {
    operations: operations(),
    toolInput: { service: 'payments-api' },
    toolResult: statusResult,
    ...overrides,
  });
  mounted.push(app);
  return app;
};

const appToHostMethods = (app: MountedBrowserApp): readonly string[] =>
  app.traffic
    .filter((entry) => entry.direction === 'app-to-host')
    .map((entry) => entry.message.method)
    .filter((method): method is string => typeof method === 'string');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const messageParam = (message: { readonly params?: unknown }, key: string): unknown =>
  isRecord(message.params) ? message.params[key] : undefined;

it('mounts the compiled panel, initializes the bridge, and renders the published result accessibly', async () => {
  const app = await mountStatus();
  await waitFor(() => app.document.querySelector('#status')?.textContent === 'degraded');

  expect(app.bridge.lifecycle).toBe('initialized');
  expect(app.document.querySelector('main')).not.toBeNull();
  expect(app.document.querySelector('h1')?.textContent).toBe('payments-api');
  expect(app.document.querySelector('#summary')?.textContent).toBe(
    'Payment latency is above the release threshold.',
  );
  expect(app.document.querySelector('[aria-label="Service checks"]')).not.toBeNull();
  expect([...app.document.querySelectorAll('#checks li')].map((item) => item.textContent)).toEqual([
    'Availabilitypassing',
    'P95 latencyfailing',
  ]);
  expect(app.provenance).toMatchObject({ proofLevel: 'browser-app', target: 'portable' });
  expect(app.traffic.some(({ message }) => message.method === 'ui/notifications/tool-input')).toBe(true);
  expect(app.traffic.some(({ message }) => message.method === 'ui/notifications/tool-result')).toBe(true);
});

it('uses the public App client without author wildcard or ext-apps plumbing', async () => {
  const app = await mountStatus();
  await waitFor(() => app.document.querySelector('#status')?.textContent === 'degraded');

  const html = app.iframe.srcdoc ?? '';
  expect(html).not.toContain('@modelcontextprotocol/ext-apps');
  expect(html).not.toContain('PostMessageTransport');
  expect(html).not.toContain('window.parent.postMessage');
  expect(appToHostMethods(app)).toEqual([
    'ui/initialize',
    'ui/notifications/initialized',
  ]);
});

it('round-trips a resource read from the real App through binding operations', async () => {
  const reads: string[] = [];
  const app = await mountStatus({ operations: operations({ reads }) });

  app.document.querySelector<HTMLButtonElement>('#read-policy')!.click();
  await waitFor(() => app.document.querySelector('#bridge-outcome')?.textContent?.includes('passing checks') === true);

  expect(reads).toEqual(['ui://mcp-app-example/readiness-policy']);
  expect(appToHostMethods(app)).toContain('resources/read');
  expect(app.traffic.some(({ message }) => (
    message.method === 'resources/read'
    && messageParam(message, 'uri') === 'ui://mcp-app-example/readiness-policy'
  ))).toBe(true);
});

it('holds a tool call for consent, resumes approval once, and denies without calling the binding', async () => {
  const approvedCalls: string[] = [];
  const approved = await mountStatus({ operations: operations({ calls: approvedCalls }) });
  approved.document.querySelector<HTMLButtonElement>('#refresh-status')!.click();
  await waitFor(() => approved.pendingConsentChallenges.length === 1);

  const challenge = approved.pendingConsentChallenges[0]!;
  expect(challenge.request.capability).toBe('call-tool');
  expect(approvedCalls).toEqual([]);
  await expect(approved.decideConsent(challenge.id, true)).resolves.toBe(true);
  await waitFor(() => approved.document.querySelector('#bridge-outcome')?.textContent === 'Status refreshed.');
  expect(approvedCalls).toEqual(['refresh-status']);
  expect(appToHostMethods(approved)).toContain('tools/call');
  expect(approved.traffic.some(({ message }) => (
    message.method === 'tools/call'
    && messageParam(message, 'name') === 'refresh-status'
  ))).toBe(true);

  const deniedCalls: string[] = [];
  const denied = await mountStatus({ operations: operations({ calls: deniedCalls }) });
  denied.document.querySelector<HTMLButtonElement>('#refresh-status')!.click();
  await waitFor(() => denied.pendingConsentChallenges.length === 1);
  await expect(denied.decideConsent(denied.pendingConsentChallenges[0]!.id, false)).resolves.toBe(true);
  await waitFor(() => denied.document.querySelector('#bridge-outcome')?.textContent === 'Refresh unavailable.');

  expect(deniedCalls).toEqual([]);
  expect(denied.traffic.some(({ message }) => message.error?.code === -32001)).toBe(true);
});

it('fails closed when a consented binding operation is unavailable', async () => {
  const calls: string[] = [];
  const app = await mountStatus({
    operations: operations({
      calls,
      callTool: async () => {
        throw new Error('unavailable');
      },
    }),
  });
  app.document.querySelector<HTMLButtonElement>('#refresh-status')!.click();
  await waitFor(() => app.pendingConsentChallenges.length === 1);
  await app.decideConsent(app.pendingConsentChallenges[0]!.id, true);
  await waitFor(() => app.document.querySelector('#bridge-outcome')?.textContent === 'Refresh unavailable.');

  expect(calls).toEqual(['refresh-status']);
  expect(app.traffic.some(({ message }) => message.error?.code === -32000)).toBe(true);
  expect(app.document.querySelector('#bridge-outcome')?.textContent).not.toBe('Status refreshed.');
});
