import type { IncomingMessage, ServerResponse } from 'node:http';

import { expect, it } from '@rstest/core';

import type { McpProbeReport } from '../src/contracts/mcp-probe.ts';
import {
  McpProbeRoutes,
  type McpProbeRouteService,
} from '../src/dev/playground/mcp-probe-routes.ts';
import { McpProbeTargetNotFoundError } from '../src/dev/playground/mcp-probe-service.ts';
import {
  authorize,
  originHeaders,
  routeError,
  startRoutes as startRouteServer,
} from './support/route-harness.ts';

const unreachableReport = Object.freeze({
  durationMs: 12,
  failure: Object.freeze({ detail: 'connect ECONNREFUSED', kind: 'connect' }),
  generatedAt: '2026-09-02T07:00:00.000Z',
  host: 'claude',
  launch: Object.freeze({
    args: Object.freeze(['mcp/timeline.js']),
    command: 'node',
    env: Object.freeze({}),
    kind: 'stdio',
  }),
  serverName: 'timeline',
  status: 'unreachable',
}) satisfies McpProbeReport;

class RecordingService implements McpProbeRouteService {
  calls: { readonly host: 'claude' | 'codex' | 'cursor'; readonly serverName: string }[] = [];
  result: McpProbeReport = unreachableReport;

  async probe(options: {
    readonly host: 'claude' | 'codex' | 'cursor';
    readonly serverName: string;
  }): Promise<McpProbeReport> {
    this.calls.push(options);
    return this.result;
  }
}

const startRoutes = async (
  service?: McpProbeRouteService,
  responseByteLimit?: number,
) => startRouteServer(new McpProbeRoutes({
  authorize,
  ...(responseByteLimit === undefined ? {} : { responseByteLimit }),
  ...(service === undefined ? {} : { service }),
}), { closeMode: 'awaited' });

const post = (
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = originHeaders(),
) => fetch(url, {
  body: JSON.stringify(body),
  headers: { ...headers, 'content-type': 'application/json' },
  method: 'POST',
});

it('authorizes before probing', async () => {
  let probed = false;
  const started = await startRouteServer(new McpProbeRoutes({
    authorize: () => {
      throw routeError('AB8004', 'A valid same-session token is required.', 403);
    },
    service: {
      probe: async () => {
        probed = true;
        return unreachableReport;
      },
    },
  }), { closeMode: 'awaited' });
  try {
    const response = await post(`${started.url}/api/discovery/probes`, {
      host: 'claude',
      serverName: 'timeline',
    }, {});
    expect(response.status).toBe(403);
    expect(probed).toBe(false);
  } finally {
    await started.close();
  }
});

it('returns false for the host discovery root', async () => {
  let authorized = false;
  const routes = new McpProbeRoutes({
    authorize: () => {
      authorized = true;
    },
    service: new RecordingService(),
  });

  await expect(routes.handle(
    { url: '/api/discovery' } as IncomingMessage,
    {} as ServerResponse,
  )).resolves.toBe(false);
  expect(authorized).toBe(false);
});

it('rejects longer probe paths with AB8219', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const response = await post(`${started.url}/api/discovery/probes/extra`, {});
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8219',
        message: 'MCP probe route path is not valid.',
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects methods and query parameters with AB8220', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    const getResponse = await fetch(`${started.url}/api/discovery/probes`, {
      headers: originHeaders(),
    });
    expect(getResponse.status).toBe(405);
    await expect(getResponse.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8220',
        message: 'MCP probe request is not valid.',
      },
    });

    const queryResponse = await post(
      `${started.url}/api/discovery/probes?refresh=true`,
      { host: 'claude', serverName: 'timeline' },
    );
    expect(queryResponse.status).toBe(400);
    await expect(queryResponse.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8220',
        message: 'MCP probe request is not valid.',
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects request shapes outside the host and server-name selector', async () => {
  const started = await startRoutes(new RecordingService());
  try {
    for (const body of [
      { extra: true, host: 'claude', serverName: 'timeline' },
      { host: 'portable', serverName: 'timeline' },
      { host: 'claude', serverName: '' },
      { host: 'claude', serverName: 'x'.repeat(257) },
      { host: 'claude' },
    ]) {
      const response = await post(`${started.url}/api/discovery/probes`, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        diagnostic: {
          code: 'AB8220',
          message: 'MCP probe request is not valid.',
        },
      });
    }
  } finally {
    await started.close();
  }
});

it('maps typed target misses to AB8221', async () => {
  const started = await startRoutes({
    probe: async () => {
      throw new McpProbeTargetNotFoundError('MCP server "missing" was not found for claude.');
    },
  });
  try {
    const response = await post(`${started.url}/api/discovery/probes`, {
      host: 'claude',
      serverName: 'missing',
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8221',
        message: 'MCP server "missing" was not found for claude.',
      },
    });
  } finally {
    await started.close();
  }
});

it('serves honest unreachable reports as HTTP 200', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await post(`${started.url}/api/discovery/probes`, {
      host: 'claude',
      serverName: 'timeline',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(unreachableReport);
    expect(service.calls).toEqual([{ host: 'claude', serverName: 'timeline' }]);
  } finally {
    await started.close();
  }
});

it('rejects probe reports over the named response budget', async () => {
  const started = await startRoutes(new RecordingService(), 32);
  try {
    const response = await post(`${started.url}/api/discovery/probes`, {
      host: 'claude',
      serverName: 'timeline',
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8222',
        message: 'MCP probe exceeds the 16 MiB response limit.',
      },
    });
  } finally {
    await started.close();
  }
});

it('reports the probe unavailable when no service was provided or routes closed', async () => {
  const absent = await startRoutes();
  try {
    const response = await post(`${absent.url}/api/discovery/probes`, {
      host: 'claude',
      serverName: 'timeline',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8223',
        message: 'MCP probing is not available.',
      },
    });
  } finally {
    await absent.close();
  }
});

it('maps unexpected probe failures to a bounded AB8220 response', async () => {
  const started = await startRoutes({
    probe: async () => {
      throw new Error('unexpected internal detail');
    },
  });
  try {
    const response = await post(`${started.url}/api/discovery/probes`, {
      host: 'claude',
      serverName: 'timeline',
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8220',
        message: 'MCP probe could not be completed.',
      },
    });
  } finally {
    await started.close();
  }
});
