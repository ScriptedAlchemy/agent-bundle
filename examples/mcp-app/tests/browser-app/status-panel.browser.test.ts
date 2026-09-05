import { afterEach, expect, it } from '@rstest/core';

import {
  type BrowserAppTraffic,
  mountBrowserApp,
  type MountBrowserAppOptions,
  type MountedBrowserApp,
} from 'agent-bundle/test/browser';

type BindingOperations = MountBrowserAppOptions['operations'];
type ToolCallResult = Awaited<ReturnType<BindingOperations['callTool']>>;

/**
 * The opening tool as `src/mcp/status.ts` registers it. Framework hosts put
 * the leased tool definition in the initialize `hostContext.toolInfo`, and the
 * App client delivers `onToolInput`/`onToolResult` only to listeners on that
 * tool's route, so the harness has to open the panel with `show-status` for
 * the populated-state tests to go through the `tool:status/show-status`
 * listeners.
 */
const showStatusTool = Object.freeze({
  _meta: Object.freeze({ ui: Object.freeze({ resourceUri: 'ui://mcp-app-example/status.html' }) }),
  description: 'Show the health of one example service.',
  inputSchema: Object.freeze({
    properties: Object.freeze({
      service: Object.freeze({ enum: Object.freeze(['compiler', 'payments-api']), type: 'string' }),
    }),
    required: Object.freeze(['service']),
    type: 'object',
  }),
  name: 'show-status',
});

const openingHostContext = Object.freeze({
  availableDisplayModes: Object.freeze(['inline']),
  displayMode: 'inline',
  platform: 'desktop',
  toolInfo: Object.freeze({ tool: showStatusTool }),
});

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

/**
 * An opening `show-status` call that failed. The bridge forwards an `isError`
 * result unchanged and the App client hands it to `onToolError`, never to the
 * typed `onToolResult` listener. The structured payload is deliberately
 * healthy-shaped: it is the tripwire that would paint the panel `healthy` with
 * a passing check if the success listener ran on an error result.
 */
const failedStatusResult = Object.freeze({
  content: Object.freeze([Object.freeze({
    text: 'payments-api is not reachable from this host.',
    type: 'text',
  })]),
  isError: true,
  structuredContent: Object.freeze({
    checks: Object.freeze([Object.freeze({ label: 'Availability', status: 'passing' })]),
    service: 'payments-api',
    status: 'healthy',
    summary: 'Every check is passing.',
  }),
});

/** A result the bridge accepts but the App client cannot type: no `structuredContent`. */
const unstructuredStatusResult = Object.freeze({
  content: Object.freeze([Object.freeze({ text: 'payments-api looks fine.', type: 'text' })]),
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
    host: { context: openingHostContext },
    operations: operations(),
    toolDefinition: showStatusTool,
    toolInput: { service: 'payments-api' },
    toolName: showStatusTool.name,
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

const initializeResult = (app: MountedBrowserApp): unknown => {
  const requestId = app.traffic.find(({ message }) => message.method === 'ui/initialize')?.message.id;
  if (requestId === undefined) return undefined;
  return app.traffic.find(({ direction, message }) => direction === 'host-to-app' && message.id === requestId)
    ?.message.result;
};

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
  expect(initializeResult(app)).toMatchObject({ hostContext: { toolInfo: { tool: { name: 'show-status' } } } });
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

const openingToolResults = (app: MountedBrowserApp): readonly BrowserAppTraffic[] =>
  app.traffic.filter(({ direction, message }) => (
    direction === 'host-to-app' && message.method === 'ui/notifications/tool-result'
  ));

it('exits checking and renders an unavailable outcome when the opening result is an error', async () => {
  const app = await mountStatus({ toolResult: failedStatusResult });
  await waitFor(() => app.document.querySelector('#status')?.textContent === 'unavailable');

  expect(app.bridge.lifecycle).toBe('initialized');
  expect(app.traffic.some(({ message }) => message.method === 'ui/notifications/tool-input')).toBe(true);
  const results = openingToolResults(app);
  expect(results).toHaveLength(1);
  expect(messageParam(results[0]!.message, 'isError')).toBe(true);
  expect(messageParam(results[0]!.message, 'structuredContent')).toMatchObject({ status: 'healthy' });

  // The requested service stays in the heading; the verdict is the panel's own.
  expect(app.document.querySelector('h1')?.textContent).toBe('payments-api');
  expect(app.document.querySelector<HTMLElement>('#status-indicator')?.dataset.state).toBe('unavailable');
  expect(app.document.querySelector('#summary')?.textContent).toBe(
    'Readiness is unavailable: payments-api is not reachable from this host.',
  );

  // Nothing from the healthy-shaped payload behind `isError` reached the DOM:
  // the typed `onToolResult` listener never ran.
  expect(app.document.querySelector('#status')?.textContent).not.toBe('healthy');
  expect(app.document.querySelector('#summary')?.textContent).not.toBe('Every check is passing.');
  expect(app.document.querySelectorAll('#checks li')).toHaveLength(0);
});

it('renders the unavailable outcome when the opening result has no structured content', async () => {
  const app = await mountStatus({ toolResult: unstructuredStatusResult });
  await waitFor(() => app.document.querySelector('#status')?.textContent === 'unavailable');

  expect(openingToolResults(app)).toHaveLength(1);
  expect(app.document.querySelector('h1')?.textContent).toBe('payments-api');
  expect(app.document.querySelector<HTMLElement>('#status-indicator')?.dataset.state).toBe('unavailable');
  expect(app.document.querySelector('#summary')?.textContent).toBe(
    'Readiness is unavailable: The opening tool did not return structured content.',
  );
  expect(app.document.querySelectorAll('#checks li')).toHaveLength(0);
});
