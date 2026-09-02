import type { IncomingMessage, ServerResponse } from 'node:http';

import { expect, it } from '@rstest/core';

import type { HostDiscoveryReport } from '../src/contracts/discovery.ts';
import {
  HostDiscoveryRoutes,
  type HostDiscoveryRouteService,
} from '../src/dev/playground/host-discovery-routes.ts';
import {
  authorize,
  originHeaders,
  routeError,
  startRoutes as startRouteServer,
} from './support/route-harness.ts';

const report = Object.freeze({
  bundleSource: '/project/dist',
  diagnostics: Object.freeze([]),
  endpoints: Object.freeze({
    diagnostics: Object.freeze([]),
    directory: '/tmp/agent-bundle-test',
    findings: Object.freeze([]),
    status: 'healthy',
    summary: Object.freeze({ live: 0, staleLocks: 0, staleSockets: 0 }),
  }),
  generatedAt: '2026-09-02T05:00:00.000Z',
  hosts: Object.freeze([]),
  manifestDigest: 'revision-a',
  summary: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
}) satisfies HostDiscoveryReport;

class RecordingService implements HostDiscoveryRouteService {
  result: HostDiscoveryReport = report;

  async discover(): Promise<HostDiscoveryReport> {
    return this.result;
  }
}

const startRoutes = async (
  service?: HostDiscoveryRouteService,
  responseByteLimit?: number,
) => startRouteServer(new HostDiscoveryRoutes({
  authorize,
  ...(responseByteLimit === undefined ? {} : { responseByteLimit }),
  ...(service === undefined ? {} : { service }),
}), { closeMode: 'awaited' });

it('propagates authorization failures before serving discovery', async () => {
  const started = await startRouteServer(new HostDiscoveryRoutes({
    authorize: () => {
      throw routeError('AB8004', 'A valid same-session token is required.', 403);
    },
    service: new RecordingService(),
  }), { closeMode: 'awaited' });
  try {
    const response = await fetch(`${started.url}/api/discovery`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8004',
        message: 'A valid same-session token is required.',
      },
    });
  } finally {
    await started.close();
  }
});

it('returns false for paths outside the discovery route', async () => {
  let authorized = false;
  const routes = new HostDiscoveryRoutes({
    authorize: () => {
      authorized = true;
    },
    service: new RecordingService(),
  });

  await expect(routes.handle(
    { url: '/api/project/status' } as IncomingMessage,
    {} as ServerResponse,
  )).resolves.toBe(false);
  expect(authorized).toBe(false);
});

it('leaves the live MCP probe route for its dedicated handler', async () => {
  let authorized = false;
  const routes = new HostDiscoveryRoutes({
    authorize: () => {
      authorized = true;
    },
    service: new RecordingService(),
  });

  await expect(routes.handle(
    { url: '/api/discovery/probes' } as IncomingMessage,
    {} as ServerResponse,
  )).resolves.toBe(false);
  expect(authorized).toBe(false);
});

it('rejects discovery subpaths', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const response = await fetch(`${started.url}/api/discovery/extra`, {
      headers: originHeaders(),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8215',
        message: 'Host discovery route path is not valid.',
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects non-GET discovery requests', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const response = await fetch(`${started.url}/api/discovery`, {
      headers: originHeaders(),
      method: 'POST',
    });
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8216',
        message: 'Host discovery request is not valid.',
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects discovery query parameters', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const response = await fetch(`${started.url}/api/discovery?refresh=true`, {
      headers: originHeaders(),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8216',
        message: 'Host discovery request is not valid.',
      },
    });
  } finally {
    await started.close();
  }
});

it('reports discovery as unavailable when no service was provided', async () => {
  const started = await startRoutes();
  try {
    const response = await fetch(`${started.url}/api/discovery`, {
      headers: originHeaders(),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8218',
        message: 'Host discovery is not available.',
      },
    });
  } finally {
    await started.close();
  }
});

it('serves the exact discovery report on GET', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const response = await fetch(`${started.url}/api/discovery`, {
      headers: originHeaders(),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(report);
  } finally {
    await started.close();
  }
});

it('rejects discovery reports over the named response budget', async () => {
  const service = new RecordingService();
  service.result = Object.freeze({
    ...report,
    diagnostics: Object.freeze([
      Object.freeze({
        code: 'AB7300',
        message: 'x'.repeat(512),
        recovery: 'No recovery is required.',
        severity: 'info',
      }),
    ]),
  });
  const started = await startRoutes(service, 256);
  try {
    const response = await fetch(`${started.url}/api/discovery`, {
      headers: originHeaders(),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8217',
        message: 'Host discovery exceeds the 16 MiB response limit.',
      },
    });
  } finally {
    await started.close();
  }
});
