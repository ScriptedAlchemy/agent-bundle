import { expect, it } from '@rstest/core';

import { InspectorRoutes, type InspectorRouteService } from '../src/dev/inspector-routes.ts';
import type { InspectorLauncherStatus } from '../src/dev/inspector-launcher.ts';
import {
  authorize,
  originHeaders as headers,
  startRoutes as startRouteServer,
  type StartedRoutes,
} from './support/route-harness.ts';

const tokenUrl = 'http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=inspector-token';

class RecordingService implements InspectorRouteService {
  readonly calls: string[] = [];
  failure: Error | undefined;
  state: InspectorLauncherStatus = Object.freeze({ state: 'idle' });

  async launch(): Promise<{ readonly url: string }> {
    this.calls.push('launch');
    if (this.failure !== undefined) throw this.failure;
    return Object.freeze({ url: tokenUrl });
  }

  status(): InspectorLauncherStatus {
    this.calls.push('status');
    return this.state;
  }
}

const startRoutes = async (service?: InspectorRouteService): Promise<StartedRoutes<InspectorRoutes>> =>
  startRouteServer(new InspectorRoutes({
    authorize,
    ...(service === undefined ? {} : { service }),
  }), { closeMode: 'awaited' });

const jsonHeaders = (): Readonly<Record<string, string>> => ({ ...headers(), 'content-type': 'application/json' });

const launchRequest = (url: string, body = '{}'): Promise<Response> => fetch(`${url}/api/inspector/launch`, {
  body,
  headers: jsonHeaders(),
  method: 'POST',
});

it('reports the launcher status without starting anything', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const idle = await fetch(`${started.url}/api/inspector/status`, { headers: headers() });
    expect(idle.status).toBe(200);
    await expect(idle.json()).resolves.toEqual({ status: { state: 'idle' } });

    service.state = Object.freeze({ state: 'running', url: tokenUrl });
    const running = await fetch(`${started.url}/api/inspector/status`, { headers: headers() });
    expect(running.status).toBe(200);
    await expect(running.json()).resolves.toEqual({ status: { state: 'running', url: tokenUrl } });

    expect(service.calls).toEqual(['status', 'status']);
  } finally {
    await started.close();
  }
});

it('launches the inspector on demand and returns its tokenized URL', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const launched = await launchRequest(started.url);
    expect(launched.status).toBe(200);
    await expect(launched.json()).resolves.toEqual({ url: tokenUrl });
    expect(service.calls).toEqual(['launch']);
  } finally {
    await started.close();
  }
});

it('rejects invalid inspector paths, queries, methods, and smuggled bodies', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    for (const path of ['/api/inspector', '/api/inspector/', '/api/inspector/launch/extra', '/api/inspector/unknown']) {
      const rejected = await fetch(`${started.url}${path}`, { headers: headers() });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8110', message: 'Inspector route path is not valid.' },
      });
    }

    const query = await fetch(`${started.url}/api/inspector/status?extra=1`, { headers: headers() });
    expect(query.status).toBe(400);
    await expect(query.json()).resolves.toEqual({
      diagnostic: { code: 'AB8111', message: 'Inspector request has an invalid shape.' },
    });

    const statusPost = await fetch(`${started.url}/api/inspector/status`, { headers: headers(), method: 'POST' });
    expect(statusPost.status).toBe(405);
    await expect(statusPost.json()).resolves.toEqual({
      diagnostic: { code: 'AB8007', message: 'Route does not accept this method.' },
    });

    const launchGet = await fetch(`${started.url}/api/inspector/launch`, { headers: headers() });
    expect(launchGet.status).toBe(405);

    const smuggled = await launchRequest(started.url, JSON.stringify({ command: '/tmp/untrusted' }));
    expect(smuggled.status).toBe(400);
    await expect(smuggled.json()).resolves.toEqual({
      diagnostic: { code: 'AB8111', message: 'Inspector request has an invalid shape.' },
    });

    const media = await fetch(`${started.url}/api/inspector/launch`, {
      body: 'launch=1',
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });
    expect(media.status).toBe(415);

    const unrelated = await fetch(`${started.url}/api/other`, { headers: headers() });
    expect(unrelated.status).toBe(404);

    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('requires the same-session guard before reaching the launcher', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const unauthorized = await fetch(`${started.url}/api/inspector/status`, {
      headers: { origin: 'http://127.0.0.1:4567' },
    });
    expect(unauthorized.status).toBe(403);
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('reports an absent or closed launcher without leaking internals', async () => {
  const absent = await startRoutes();
  try {
    const unavailable = await fetch(`${absent.url}/api/inspector/status`, { headers: headers() });
    expect(unavailable.status).toBe(404);
    await expect(unavailable.json()).resolves.toEqual({
      diagnostic: { code: 'AB8113', message: 'Inspector routes are not available.' },
    });
  } finally {
    await absent.close();
  }

  const service = new RecordingService();
  service.failure = new Error('/private/npx/path could not be spawned');
  const started = await startRoutes(service);
  try {
    const failed = await launchRequest(started.url);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8112', message: 'MCP Inspector could not be launched.' },
    });

    started.routes.close();
    const closed = await fetch(`${started.url}/api/inspector/status`, { headers: headers() });
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8113', message: 'Inspector routes are not available.' },
    });
  } finally {
    await started.close();
  }
});
