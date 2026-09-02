import { expect, it } from '@rstest/core';

import {
  DiscoveryClient,
  DiscoveryClientError,
} from '../src/discovery/discovery-client.ts';
import type { ForegroundRequestAuthority } from '../src/mcp/mcp-route-client.ts';

interface RecordedRequest {
  readonly body?: BodyInit | null;
  readonly contentType?: string;
  readonly method: string;
  readonly signal?: AbortSignal;
  readonly url: string;
}

const durableState = {
  diagnostics: [{
    code: 'durable.store.old',
    message: 'A durable store predates the current bundle.',
    recovery: 'Re-run discovery after rebuilding the bundle.',
    severity: 'warning' as const,
    target: 'claude',
  }],
  directory: '/home/user/.claude/state',
  findings: [{
    bytes: 512,
    file: 'state.sqlite',
    mtime: '2026-09-01T11:59:00.000Z',
    path: '/home/user/.claude/state/state.sqlite',
  }],
  status: 'warnings' as const,
  summary: { bytes: 512, stores: 1 },
};

const fullReport = {
  bundleSource: '/workspace/dist/agent-bundle.tgz',
  diagnostics: [{
    code: 'discovery.partial',
    message: 'One host inventory is not readable.',
    recovery: 'Review the host-owned registry manually.',
    severity: 'info' as const,
  }],
  endpoints: {
    diagnostics: [{
      code: 'endpoint.stale',
      message: 'A stale socket was found.',
      recovery: 'Restart the owning host before reconnecting.',
      severity: 'warning' as const,
      target: '/tmp/agent-bundle/stale.sock',
    }],
    directory: '/tmp/agent-bundle',
    findings: [{
      path: '/tmp/agent-bundle/live.sock',
      state: 'live' as const,
    }, {
      path: '/tmp/agent-bundle/stale.lock',
      state: 'stale-lock' as const,
    }],
    status: 'warnings' as const,
    summary: { live: 1, staleLocks: 1, staleSockets: 0 },
  },
  generatedAt: '2026-09-01T12:00:00.000Z',
  hosts: [{
    diagnostics: [],
    host: 'claude' as const,
    inventory: {
      findings: [{
        name: 'agent-bundle',
        path: '/home/user/.claude/plugins/agent-bundle',
        state: 'installed' as const,
        version: '1.2.3',
      }],
      status: 'known' as const,
    },
    probe: { status: 'unavailable' as const },
  }, {
    bundle: {
      bundleRoot: '/home/user/.codex/plugins/agent-bundle',
      durableState,
      marketplace: 'local',
      mcpServers: [{
        name: 'timeline',
        transport: 'stdio' as const,
      }],
      name: 'agent-bundle',
      state: 'drifted' as const,
      version: '1.2.2',
    },
    diagnostics: [],
    host: 'codex' as const,
    inventory: { findings: [], status: 'unknown' as const },
    probe: { status: 'available' as const, version: '0.4.0' },
  }, {
    diagnostics: [],
    host: 'cursor' as const,
    inventory: { findings: [], status: 'skipped' as const },
    probe: { evidence: 'directory' as const, status: 'available' as const },
  }],
  manifestDigest: 'manifest-a',
  summary: { errors: 0, infos: 1, warnings: 2 },
};

const jsonResponse = (body: unknown, status = 200): Response => ({
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
}) as Response;

const authority = (
  calls: RecordedRequest[],
  reply: (path: string, init: RequestInit) => Response,
): ForegroundRequestAuthority => ({
  protectedRequest: async (path, init = {}) => {
    calls.push({
      ...(init.body === null || init.body === undefined ? {} : { body: init.body }),
      ...(new Headers(init.headers).get('content-type') === null
        ? {}
        : { contentType: new Headers(init.headers).get('content-type')! }),
      method: init.method ?? 'GET',
      ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
      url: String(path),
    });
    return reply(String(path), init);
  },
});

it('decodes and deeply freezes a full discovery report through the foreground authority', async () => {
  const calls: RecordedRequest[] = [];
  const signal = new AbortController().signal;
  const client = new DiscoveryClient({ foreground: authority(calls, () => jsonResponse(fullReport)) });

  const result = await client.discover(signal);

  expect(result).toEqual(fullReport);
  expect(calls).toEqual([{ method: 'GET', signal, url: '/api/discovery' }]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.hosts)).toBe(true);
  expect(Object.isFrozen(result.hosts[1]!.bundle!.durableState!.findings)).toBe(true);
  expect(result.hosts[1]!.bundle!.mcpServers).toEqual([{
    name: 'timeline',
    transport: 'stdio',
  }]);
  expect(result.hosts[0]!.bundle?.mcpServers).toBeUndefined();
});

it('rejects unknown keys at every discovery response boundary', async () => {
  const firstHost = fullReport.hosts[1]!;
  const firstEndpointFinding = fullReport.endpoints.findings[0]!;
  const malformed = [
    { ...fullReport, extra: true },
    { ...fullReport, summary: { ...fullReport.summary, extra: true } },
    { ...fullReport, diagnostics: [{ ...fullReport.diagnostics[0]!, extra: true }] },
    { ...fullReport, endpoints: { ...fullReport.endpoints, extra: true } },
    { ...fullReport, endpoints: { ...fullReport.endpoints, summary: { ...fullReport.endpoints.summary, extra: true } } },
    { ...fullReport, endpoints: { ...fullReport.endpoints, diagnostics: [{ ...fullReport.endpoints.diagnostics[0]!, extra: true }] } },
    { ...fullReport, endpoints: { ...fullReport.endpoints, findings: [{ ...firstEndpointFinding, extra: true }] } },
    { ...fullReport, hosts: [{ ...firstHost, extra: true }] },
    { ...fullReport, hosts: [{ ...firstHost, probe: { ...firstHost.probe, extra: true } }] },
    { ...fullReport, hosts: [{ ...firstHost, inventory: { ...firstHost.inventory, extra: true } }] },
    { ...fullReport, hosts: [{ ...firstHost, bundle: { ...firstHost.bundle!, extra: true } }] },
    {
      ...fullReport,
      hosts: [{
        ...firstHost,
        bundle: {
          ...firstHost.bundle!,
          mcpServers: [{ name: 'timeline', transport: 'stdio', extra: true }],
        },
      }],
    },
    {
      ...fullReport,
      hosts: [{
        ...firstHost,
        bundle: { ...firstHost.bundle!, durableState: { ...durableState, extra: true } },
      }],
    },
    {
      ...fullReport,
      hosts: [{
        ...firstHost,
        bundle: {
          ...firstHost.bundle!,
          durableState: { ...durableState, summary: { ...durableState.summary, extra: true } },
        },
      }],
    },
    {
      ...fullReport,
      hosts: [{
        ...firstHost,
        bundle: {
          ...firstHost.bundle!,
          durableState: { ...durableState, findings: [{ ...durableState.findings[0]!, extra: true }] },
        },
      }],
    },
  ];

  for (const body of malformed) {
    const client = new DiscoveryClient({ foreground: authority([], () => jsonResponse(body)) });
    await expect(client.discover()).rejects.toMatchObject({
      code: 'AB8234',
      message: 'Host discovery route returned an invalid response.',
    });
  }
});

it('rejects every out-of-range discovery enum value', async () => {
  const firstHost = fullReport.hosts[1]!;
  const malformed = [
    { ...fullReport, diagnostics: [{ ...fullReport.diagnostics[0]!, severity: 'debug' }] },
    { ...fullReport, endpoints: { ...fullReport.endpoints, status: 'offline' } },
    { ...fullReport, endpoints: { ...fullReport.endpoints, findings: [{ state: 'ready' }] } },
    { ...fullReport, hosts: [{ ...firstHost, host: 'portable' }] },
    { ...fullReport, hosts: [{ ...firstHost, inventory: { ...firstHost.inventory, status: 'partial' } }] },
    { ...fullReport, hosts: [{ ...firstHost, probe: { status: 'ready' } }] },
    { ...fullReport, hosts: [{ ...firstHost, probe: { evidence: 'file', status: 'available' } }] },
    {
      ...fullReport,
      hosts: [{
        ...firstHost,
        bundle: {
          ...firstHost.bundle!,
          mcpServers: [{ name: 'timeline', transport: 'websocket' }],
        },
      }],
    },
    {
      ...fullReport,
      hosts: [{
        ...firstHost,
        bundle: {
          ...firstHost.bundle!,
          durableState: { ...durableState, status: 'failed' },
        },
      }],
    },
  ];

  for (const body of malformed) {
    const client = new DiscoveryClient({ foreground: authority([], () => jsonResponse(body)) });
    await expect(client.discover()).rejects.toMatchObject({ code: 'AB8234' });
  }
});

it('rejects a report missing a required key', async () => {
  const { generatedAt: _generatedAt, ...missingGeneratedAt } = fullReport;
  const client = new DiscoveryClient({
    foreground: authority([], () => jsonResponse(missingGeneratedAt)),
  });

  await expect(client.discover()).rejects.toMatchObject({ code: 'AB8234' });
});

it('surfaces a server diagnostic from a non-success response', async () => {
  const client = new DiscoveryClient({
    foreground: authority([], () => jsonResponse({
      diagnostic: {
        code: 'discovery.probe.denied',
        message: 'Host discovery is unavailable in this session.',
      },
    }, 403)),
  });

  const failure = await client.discover().catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(DiscoveryClientError);
  expect(failure).toMatchObject({
    code: 'discovery.probe.denied',
    message: 'Host discovery is unavailable in this session.',
    status: 403,
  });
});

const okProbeReport = {
  durationMs: 42,
  generatedAt: '2026-09-01T12:01:00.000Z',
  host: 'claude' as const,
  launch: {
    args: ['dist/timeline.js'],
    command: 'node',
    cwd: '/workspace/dist',
    env: { NODE_ENV: 'production' },
    kind: 'stdio' as const,
  },
  serverName: 'timeline',
  snapshot: {
    capabilities: { tools: true },
    instructions: 'Read-only timeline inspection.',
    protocolVersion: '2025-06-18',
    serverInfo: {
      name: 'timeline-server',
      title: 'Timeline',
      version: '1.0.0',
    },
    tools: [{
      description: 'Lists timeline entries.',
      name: 'timeline_list',
      title: 'List timeline',
    }],
    toolsTruncated: false,
  },
  status: 'ok' as const,
};

const unreachableProbeReport = {
  durationMs: 7,
  failure: {
    detail: 'The redacted server command exited before initialize completed.',
    kind: 'connect' as const,
  },
  generatedAt: '2026-09-01T12:02:00.000Z',
  host: 'claude' as const,
  launch: {
    args: ['-e', 'process.exit(0)'],
    command: 'node',
    env: {},
    kind: 'stdio' as const,
  },
  serverName: 'probe-down',
  status: 'unreachable' as const,
};

it('posts a probe request and deeply freezes a successful report', async () => {
  const calls: RecordedRequest[] = [];
  const signal = new AbortController().signal;
  const client = new DiscoveryClient({
    foreground: authority(calls, () => jsonResponse(okProbeReport)),
  });

  const result = await client.probe({ host: 'claude', serverName: 'timeline' }, signal);

  expect(result).toEqual(okProbeReport);
  expect(calls).toEqual([{
    body: JSON.stringify({ host: 'claude', serverName: 'timeline' }),
    contentType: 'application/json',
    method: 'POST',
    signal,
    url: '/api/discovery/probes',
  }]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.snapshot?.tools)).toBe(true);
  expect(Object.isFrozen(result.launch)).toBe(true);
});

it('decodes an honest unreachable probe report', async () => {
  const client = new DiscoveryClient({
    foreground: authority([], () => jsonResponse(unreachableProbeReport)),
  });

  await expect(client.probe({ host: 'claude', serverName: 'probe-down' }))
    .resolves.toEqual(unreachableProbeReport);
});

it('rejects probe invariant violations and unknown keys with AB8235', async () => {
  const { snapshot: _snapshot, ...okWithoutSnapshot } = okProbeReport;
  const { failure: _failure, ...unreachableWithoutFailure } = unreachableProbeReport;
  const malformed = [
    okWithoutSnapshot,
    unreachableWithoutFailure,
    { ...okProbeReport, failure: unreachableProbeReport.failure },
    { ...unreachableProbeReport, snapshot: okProbeReport.snapshot },
    { ...okProbeReport, extra: true },
  ];

  for (const body of malformed) {
    const client = new DiscoveryClient({
      foreground: authority([], () => jsonResponse(body)),
    });
    await expect(client.probe({ host: 'claude', serverName: 'timeline' })).rejects.toMatchObject({
      code: 'AB8235',
      message: 'MCP probe route returned an invalid response.',
    });
  }
});

it('surfaces a server diagnostic from a failed probe request', async () => {
  const client = new DiscoveryClient({
    foreground: authority([], () => jsonResponse({
      diagnostic: {
        code: 'AB8221',
        message: 'MCP server timeline was not found for claude.',
      },
    }, 404)),
  });

  const failure = await client.probe({ host: 'claude', serverName: 'timeline' })
    .catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(DiscoveryClientError);
  expect(failure).toMatchObject({
    code: 'AB8221',
    message: 'MCP server timeline was not found for claude.',
    status: 404,
  });
});

it('uses AB8235 with status for a malformed probe failure body', async () => {
  const client = new DiscoveryClient({
    foreground: authority([], () => jsonResponse({ error: 'unavailable' }, 503)),
  });

  await expect(client.probe({ host: 'claude', serverName: 'timeline' })).rejects.toMatchObject({
    code: 'AB8235',
    message: 'MCP probe request failed with HTTP 503.',
    status: 503,
  });
});
