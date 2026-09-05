import { describe, expect, it } from '@rstest/core';

import type { McpSessionInspectorConfig } from '../../agent-bundle/src/contracts/mcp-session.ts';
import {
  createMcpInspectorLaunchController,
  type McpInspectorLaunchController,
  type McpInspectorLaunchRoutes,
} from '../src/mcp/mcp-inspector-launch-controller.ts';
import {
  createMcpInspectorLaunchModel,
  mcpInspectorDeepLink,
  reduceMcpInspectorLaunch,
  type McpInspectorLaunchModel,
} from '../src/mcp/mcp-inspector-launch-model.ts';
import type { McpInspectorRouteStatus } from '../src/mcp/mcp-route-client.ts';

const inspectorUrl = 'http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=tok-123';
const launchFailure = Object.freeze({ code: 'AB8112', message: 'MCP Inspector could not be launched.' });
const routesUnavailable = Object.freeze({ code: 'AB8113', message: 'Inspector routes are not available.' });

const stdioConfig: McpSessionInspectorConfig = {
  launch: {
    args: ['dist/mcp/weather.mjs', '--flag'],
    command: 'node',
    cwd: '/proj',
    env: { SAFE: 'true', SECRET_TOKEN: '[redacted]' },
    kind: 'stdio',
  },
  origin: 'artifact',
};

const streamableConfig = (url: string): McpSessionInspectorConfig => ({ launch: { kind: 'streamable-http', url }, origin: 'artifact' });

const codedError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const deferred = <Value>() => {
  let reject: (reason?: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const tick = async (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeRouteBehavior {
  readonly launch?: () => Promise<Readonly<{ readonly url: string }>>;
  readonly status?: () => Promise<McpInspectorRouteStatus>;
}

const fakeRoutes = (behavior: FakeRouteBehavior = {}) => {
  const calls = { launch: 0, status: 0 };
  const routes: McpInspectorLaunchRoutes = {
    inspectorLaunch: async () => {
      calls.launch += 1;
      return behavior.launch === undefined ? { url: inspectorUrl } : behavior.launch();
    },
    inspectorStatus: async () => {
      calls.status += 1;
      return behavior.status === undefined ? { state: 'idle' } : behavior.status();
    },
  };
  return { calls, routes };
};

const observed = (controller: McpInspectorLaunchController): McpInspectorLaunchModel[] => {
  const models: McpInspectorLaunchModel[] = [];
  controller.subscribe((model) => { models.push(model); });
  return models;
};

describe('MCP Inspector launch model', () => {
  it('starts idle and frozen without a URL or diagnostic', () => {
    const model = createMcpInspectorLaunchModel();

    expect(model).toEqual({ phase: 'idle' });
    expect(model.url).toBeUndefined();
    expect(model.diagnostic).toBeUndefined();
    expect(Object.isFrozen(model)).toBe(true);
  });

  it('walks idle to starting to ready and back to idle through launch, running, and stopped', () => {
    const idle = createMcpInspectorLaunchModel();
    const starting = reduceMcpInspectorLaunch(idle, { type: 'launch' });
    const ready = reduceMcpInspectorLaunch(starting, { type: 'running', url: inspectorUrl });
    const stopped = reduceMcpInspectorLaunch(ready, { type: 'stopped' });

    expect(starting).toEqual({ phase: 'starting' });
    expect(starting.url).toBeUndefined();
    expect(starting.diagnostic).toBeUndefined();
    expect(ready).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(ready.diagnostic).toBeUndefined();
    expect(stopped).toEqual({ phase: 'idle' });
    expect(stopped.url).toBeUndefined();
    for (const model of [idle, starting, ready, stopped]) expect(Object.isFrozen(model)).toBe(true);
  });

  it('ignores stopped while starting and returns the same model reference', () => {
    const starting = reduceMcpInspectorLaunch(createMcpInspectorLaunchModel(), { type: 'launch' });

    expect(reduceMcpInspectorLaunch(starting, { type: 'stopped' })).toBe(starting);
    expect(reduceMcpInspectorLaunch(createMcpInspectorLaunchModel(), { type: 'stopped' })).toEqual({ phase: 'idle' });
  });

  it('records a failure without a URL and clears the diagnostic on the next launch', () => {
    const starting = reduceMcpInspectorLaunch(createMcpInspectorLaunchModel(), { type: 'launch' });
    const ready = reduceMcpInspectorLaunch(starting, { type: 'running', url: inspectorUrl });
    const failed = reduceMcpInspectorLaunch(ready, { diagnostic: launchFailure, type: 'failed' });
    const relaunched = reduceMcpInspectorLaunch(failed, { type: 'launch' });

    expect(failed).toEqual({ diagnostic: launchFailure, phase: 'error' });
    expect(failed.url).toBeUndefined();
    expect(relaunched).toEqual({ phase: 'starting' });
    expect(relaunched.diagnostic).toBeUndefined();
    expect(relaunched.url).toBeUndefined();
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(relaunched)).toBe(true);
  });

  it('accepts running and failed from any phase so a refresh can adopt an already-running Inspector', () => {
    const idle = createMcpInspectorLaunchModel();
    const ready = reduceMcpInspectorLaunch(idle, { type: 'running', url: inspectorUrl });
    const failed = reduceMcpInspectorLaunch(idle, { diagnostic: routesUnavailable, type: 'failed' });

    expect(ready).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(failed).toEqual({ diagnostic: routesUnavailable, phase: 'error' });
    expect(reduceMcpInspectorLaunch(failed, { type: 'stopped' })).toEqual({ phase: 'idle' });
    expect(reduceMcpInspectorLaunch(ready, { type: 'launch' })).toEqual({ phase: 'starting' });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
  });
});

describe('mcpInspectorDeepLink', () => {
  it('never carries a stdio command, arguments, cwd, or environment into the link', () => {
    const link = mcpInspectorDeepLink(inspectorUrl, stdioConfig);

    expect(link).toBe(inspectorUrl);
    for (const leak of ['serverUrl', 'serverCommand', 'serverArgs', 'autoConnect', 'node', 'weather', 'SAFE', 'redacted', '/proj']) {
      expect(link).not.toContain(leak);
    }
  });

  it('normalizes a slashless Inspector origin while preserving the token', () => {
    expect(mcpInspectorDeepLink('http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=tok-123', stdioConfig)).toBe(inspectorUrl);
    expect(mcpInspectorDeepLink('http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=tok-123', undefined)).toBe(inspectorUrl);
  });

  it('adds the Inspector 2.x auto-connect parameters for a streamable HTTP session', () => {
    const link = new URL(mcpInspectorDeepLink(inspectorUrl, streamableConfig('http://127.0.0.1:3100/mcp/host/weather')));

    expect(link.origin).toBe('http://127.0.0.1:6274');
    expect(link.pathname).toBe('/');
    expect([...link.searchParams.keys()].sort()).toEqual(['MCP_INSPECTOR_API_TOKEN', 'autoConnect', 'serverUrl', 'transport']);
    expect(link.searchParams.get('MCP_INSPECTOR_API_TOKEN')).toBe('tok-123');
    expect(link.searchParams.get('serverUrl')).toBe('http://127.0.0.1:3100/mcp/host/weather');
    expect(link.searchParams.get('transport')).toBe('http');
    expect(link.searchParams.get('autoConnect')).toBe('tok-123');
  });

  it('round-trips a server URL with its own query string through one encoded parameter', () => {
    const serverUrl = 'http://127.0.0.1:3100/mcp?a=1&b=2';
    const link = new URL(mcpInspectorDeepLink(inspectorUrl, streamableConfig(serverUrl)));

    expect(link.searchParams.get('serverUrl')).toBe(serverUrl);
    expect(link.searchParams.has('a')).toBe(false);
    expect(link.searchParams.has('b')).toBe(false);
    expect([...link.searchParams.keys()]).toHaveLength(4);
  });

  it('leaves the link untouched without a config, without a token, or with a non-HTTP server URL', () => {
    const tokenless = 'http://127.0.0.1:6274/';

    expect(mcpInspectorDeepLink(inspectorUrl, undefined)).toBe(inspectorUrl);
    expect(mcpInspectorDeepLink(tokenless, streamableConfig('http://127.0.0.1:3100/mcp'))).toBe(tokenless);
    expect(mcpInspectorDeepLink('http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=', streamableConfig('http://127.0.0.1:3100/mcp'))).toBe('http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=');
    expect(mcpInspectorDeepLink(inspectorUrl, streamableConfig('javascript:alert(1)'))).toBe(inspectorUrl);
    expect(mcpInspectorDeepLink(inspectorUrl, streamableConfig('not a url'))).toBe(inspectorUrl);
  });

  it('returns an unparseable Inspector URL unchanged', () => {
    expect(mcpInspectorDeepLink('not a url', streamableConfig('http://127.0.0.1:3100/mcp'))).toBe('not a url');
  });
});

describe('MCP Inspector launch controller', () => {
  it('publishes starting then ready and shares one in-flight launch across concurrent calls', async () => {
    const launch = deferred<Readonly<{ readonly url: string }>>();
    const { calls, routes } = fakeRoutes({ launch: () => launch.promise });
    const controller = createMcpInspectorLaunchController({ routes });
    const models = observed(controller);

    expect(models).toEqual([{ phase: 'idle' }]);
    const first = controller.launch();
    await tick();
    expect(controller.model.phase).toBe('starting');
    const second = controller.launch();
    await tick();
    expect(calls.launch).toBe(1);

    launch.resolve({ url: inspectorUrl });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(models).toEqual([{ phase: 'idle' }, { phase: 'starting' }, { phase: 'ready', url: inspectorUrl }]);
    expect(calls.launch).toBe(1);
    expect(calls.status).toBe(0);
  });

  it('maps a rejected launch to an error diagnostic, resolves, and lets a later launch retry', async () => {
    let failing = true;
    const { calls, routes } = fakeRoutes({
      launch: async () => {
        if (failing) throw codedError(launchFailure.code, launchFailure.message);
        return { url: inspectorUrl };
      },
    });
    const controller = createMcpInspectorLaunchController({ routes });
    const models = observed(controller);

    await expect(controller.launch()).resolves.toBeUndefined();

    expect(controller.model).toEqual({ diagnostic: launchFailure, phase: 'error' });
    expect(controller.model.url).toBeUndefined();
    expect(models.map((model) => model.phase)).toEqual(['idle', 'starting', 'error']);

    failing = false;
    await controller.launch();

    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(calls.launch).toBe(2);
    expect(models.map((model) => model.phase)).toEqual(['idle', 'starting', 'error', 'starting', 'ready']);
  });

  it('falls back to a launch diagnostic code and message when the failure carries none', async () => {
    const uncoded = createMcpInspectorLaunchController({ routes: fakeRoutes({ launch: async () => { throw new Error('spawn ENOENT'); } }).routes });
    const silent = createMcpInspectorLaunchController({ routes: fakeRoutes({ launch: async () => { throw new Error(''); } }).routes });

    await uncoded.launch();
    await silent.launch();

    expect(uncoded.model).toEqual({ diagnostic: { code: 'mcp.inspector.launch.failed', message: 'spawn ENOENT' }, phase: 'error' });
    expect(silent.model).toEqual({ diagnostic: { code: 'mcp.inspector.launch.failed', message: 'MCP Inspector could not be launched.' }, phase: 'error' });
  });

  it('adopts a running Inspector from a status refresh and returns to idle once it exits', async () => {
    let status: McpInspectorRouteStatus = { state: 'running', url: inspectorUrl };
    const { calls, routes } = fakeRoutes({ status: async () => status });
    const controller = createMcpInspectorLaunchController({ routes });
    const models = observed(controller);

    await expect(controller.refresh()).resolves.toBeUndefined();
    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });

    status = { state: 'exited' };
    await controller.refresh();

    expect(controller.model).toEqual({ phase: 'idle' });
    expect(controller.model.url).toBeUndefined();
    expect(calls.status).toBe(2);
    expect(calls.launch).toBe(0);
    expect(models.map((model) => model.phase)).toEqual(['idle', 'ready', 'idle']);
  });

  it('does not publish when a status refresh lands while a launch is still starting', async () => {
    const launch = deferred<Readonly<{ readonly url: string }>>();
    const { calls, routes } = fakeRoutes({ launch: () => launch.promise, status: async () => ({ state: 'starting' }) });
    const controller = createMcpInspectorLaunchController({ routes });
    const models = observed(controller);
    const pending = controller.launch();
    await tick();
    const starting = controller.model;

    await expect(controller.refresh()).resolves.toBeUndefined();

    expect(starting.phase).toBe('starting');
    expect(controller.model).toBe(starting);
    expect(calls.status).toBe(1);
    expect(models).toHaveLength(2);

    launch.resolve({ url: inspectorUrl });
    await pending;

    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(models.map((model) => model.phase)).toEqual(['idle', 'starting', 'ready']);
  });

  it('discards a status refresh that began before a launch and lands after the launch is ready', async () => {
    const status = deferred<McpInspectorRouteStatus>();
    const { routes } = fakeRoutes({ status: () => status.promise });
    const controller = createMcpInspectorLaunchController({ routes });
    const models = observed(controller);

    const refreshing = controller.refresh();
    await controller.launch();
    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });

    status.resolve({ state: 'idle' });
    await expect(refreshing).resolves.toBeUndefined();

    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(models.map((model) => model.phase)).toEqual(['idle', 'starting', 'ready']);
  });

  it('keeps a launch diagnostic when a superseded status refresh reports idle afterwards', async () => {
    const status = deferred<McpInspectorRouteStatus>();
    const { routes } = fakeRoutes({
      launch: async () => { throw codedError(launchFailure.code, launchFailure.message); },
      status: () => status.promise,
    });
    const controller = createMcpInspectorLaunchController({ routes });

    const refreshing = controller.refresh();
    await controller.launch();
    expect(controller.model).toEqual({ diagnostic: launchFailure, phase: 'error' });

    status.resolve({ state: 'idle' });
    await refreshing;

    expect(controller.model).toEqual({ diagnostic: launchFailure, phase: 'error' });
  });

  it('ignores a status refresh failure that lands while a launch is in flight', async () => {
    const launch = deferred<Readonly<{ readonly url: string }>>();
    const { routes } = fakeRoutes({
      launch: () => launch.promise,
      status: async () => { throw codedError(routesUnavailable.code, routesUnavailable.message); },
    });
    const controller = createMcpInspectorLaunchController({ routes });
    const models = observed(controller);
    const pending = controller.launch();

    await expect(controller.refresh()).resolves.toBeUndefined();
    expect(controller.model).toEqual({ phase: 'starting' });

    launch.resolve({ url: inspectorUrl });
    await pending;

    expect(controller.model).toEqual({ phase: 'ready', url: inspectorUrl });
    expect(models.map((model) => model.phase)).toEqual(['idle', 'starting', 'ready']);
  });

  it('applies a status refresh that begins after a launch has settled', async () => {
    let status: McpInspectorRouteStatus = { state: 'running', url: inspectorUrl };
    const { routes } = fakeRoutes({ status: async () => status });
    const controller = createMcpInspectorLaunchController({ routes });

    await controller.launch();
    status = { state: 'exited' };
    await controller.refresh();

    expect(controller.model).toEqual({ phase: 'idle' });
  });

  it('maps a rejected status refresh to an error diagnostic without rejecting', async () => {
    const coded = createMcpInspectorLaunchController({
      routes: fakeRoutes({ status: async () => { throw codedError(routesUnavailable.code, routesUnavailable.message); } }).routes,
    });
    const silent = createMcpInspectorLaunchController({ routes: fakeRoutes({ status: async () => { throw new Error(''); } }).routes });

    await expect(coded.refresh()).resolves.toBeUndefined();
    await expect(silent.refresh()).resolves.toBeUndefined();

    expect(coded.model).toEqual({ diagnostic: routesUnavailable, phase: 'error' });
    expect(silent.model).toEqual({ diagnostic: { code: 'mcp.inspector.status.failed', message: 'MCP Inspector status is not available.' }, phase: 'error' });
  });

  it('notifies subscribers immediately, survives a throwing listener, and stops after unsubscribe', async () => {
    const controller = createMcpInspectorLaunchController({ routes: fakeRoutes().routes });
    const phases: string[] = [];
    controller.subscribe(() => { throw new Error('listener failure'); });
    const unsubscribe = controller.subscribe((model) => { phases.push(model.phase); });

    expect(phases).toEqual(['idle']);
    await expect(controller.launch()).resolves.toBeUndefined();
    expect(phases).toEqual(['idle', 'starting', 'ready']);

    unsubscribe();
    await controller.refresh();

    expect(controller.model).toEqual({ phase: 'idle' });
    expect(phases).toEqual(['idle', 'starting', 'ready']);
  });
});
