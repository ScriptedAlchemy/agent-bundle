import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { TargetRegistry } from '../src/adapters/registry.ts';
import type { HostDiscoveryReport } from '../src/contracts/discovery.ts';
import { HostDiscoveryService } from '../src/dev/playground/host-discovery-service.ts';
import type {
  DoctorCommandRunner,
  DoctorOptions,
  DoctorReport,
} from '../src/install/doctor.ts';

const diagnostic = Object.freeze({
  code: 'AB7300',
  message: 'Claude is available.',
  recovery: 'No recovery is required.',
  severity: 'info',
  target: 'claude',
} as const);

const doctorReport = Object.freeze({
  diagnostics: Object.freeze([diagnostic]),
  endpoints: Object.freeze({
    diagnostics: Object.freeze([]),
    directory: '/tmp/agent-bundle-test',
    findings: Object.freeze([
      Object.freeze({ path: '/tmp/agent-bundle-test/event-live.sock', state: 'live' as const }),
    ]),
    status: 'healthy' as const,
    summary: Object.freeze({ live: 1, staleLocks: 0, staleSockets: 0 }),
  }),
  hosts: Object.freeze([
    Object.freeze({
      bundle: Object.freeze({
        bundleRoot: '/project/dist/claude',
        marketplace: 'agent-bundle',
        name: 'example',
        state: 'registered' as const,
        version: '1.0.0',
      }),
      diagnostics: Object.freeze([diagnostic]),
      host: 'claude' as const,
      inventory: Object.freeze({
        findings: Object.freeze([]),
        status: 'unknown' as const,
      }),
      probe: Object.freeze({ status: 'available' as const, version: '2.1.250' }),
    }),
  ]),
  summary: Object.freeze({ errors: 0, infos: 1, warnings: 0 }),
}) satisfies DoctorReport;

it('forwards Doctor options and projects the prepared bundle into the discovery envelope', async () => {
  const calls: DoctorOptions[] = [];
  const commandRunner: DoctorCommandRunner = async () => Object.freeze({
    exitCode: 0,
    signal: null,
    stderr: '',
    stdout: '1.0.0',
  });
  const service = new HostDiscoveryService({
    doctor: async (options) => {
      calls.push(options);
      return doctorReport;
    },
    doctorOptions: {
      commandRunner,
      endpointDirectory: '/tmp/endpoints',
      home: '/home/test',
      platform: 'linux',
    },
    now: () => new Date('2026-09-02T05:00:00.000Z'),
    prepared: () => Object.freeze({
      bundleSource: '/project/dist',
      manifestDigest: 'revision-a',
    }),
  });

  const report = await service.discover();

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    commandRunner,
    endpointDirectory: '/tmp/endpoints',
    from: '/project/dist',
    home: '/home/test',
    platform: 'linux',
  });
  expect(report).toEqual({
    bundleSource: '/project/dist',
    diagnostics: doctorReport.diagnostics,
    endpoints: doctorReport.endpoints,
    generatedAt: '2026-09-02T05:00:00.000Z',
    hosts: doctorReport.hosts,
    manifestDigest: 'revision-a',
    summary: doctorReport.summary,
  } satisfies HostDiscoveryReport);
  expect(Object.isFrozen(report)).toBe(true);
});

it('reports an absent prepared build without treating it as an error', async () => {
  let received: DoctorOptions | undefined;
  const service = new HostDiscoveryService({
    doctor: async (options) => {
      received = options;
      return doctorReport;
    },
    doctorOptions: { home: '/home/test' },
    now: () => new Date('2026-09-02T06:00:00.000Z'),
    prepared: () => undefined,
  });

  const report = await service.discover();

  expect(received).toEqual({ home: '/home/test' });
  expect(report).not.toHaveProperty('bundleSource');
  expect(report).not.toHaveProperty('manifestDigest');
  expect(report.summary.errors).toBe(0);
  expect(report.diagnostics).toEqual(doctorReport.diagnostics);
  expect(report.hosts).toEqual(doctorReport.hosts);
  expect(report.endpoints).toEqual(doctorReport.endpoints);
  expect(report.summary).toEqual(doctorReport.summary);
});

it('shares only an in-flight scan and starts a fresh scan after settlement', async () => {
  const firstScan = Promise.withResolvers<DoctorReport>();
  let calls = 0;
  const service = new HostDiscoveryService({
    doctor: async () => {
      calls += 1;
      if (calls === 1) return firstScan.promise;
      return doctorReport;
    },
    now: () => new Date('2026-09-02T07:00:00.000Z'),
  });

  const first = service.discover();
  const concurrent = service.discover();
  expect(calls).toBe(1);

  firstScan.resolve(doctorReport);
  const [firstReport, concurrentReport] = await Promise.all([first, concurrent]);
  expect(firstReport).toBe(concurrentReport);

  const freshReport = await service.discover();
  expect(calls).toBe(2);
  expect(freshReport).not.toBe(firstReport);
});

it('enumerates sorted modern MCP servers from a valid bundle manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-discovery-mcp-'));
  try {
    await writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        zeta: { headers: {}, type: 'http', url: 'https://example.com/mcp' },
        alpha: { args: [], command: 'node', type: 'stdio' },
      },
    }));
    const service = new HostDiscoveryService({
      doctor: async () => Object.freeze({
        ...doctorReport,
        hosts: Object.freeze([
          Object.freeze({
            ...doctorReport.hosts[0]!,
            bundle: Object.freeze({ ...doctorReport.hosts[0]!.bundle!, bundleRoot: root }),
          }),
        ]),
      }),
    });

    const report = await service.discover();

    expect(report.hosts[0]?.bundle?.mcpServers).toEqual([
      { name: 'alpha', transport: 'stdio' },
      { name: 'zeta', transport: 'streamable-http' },
    ]);
    expect(Object.isFrozen(report.hosts[0]?.bundle?.mcpServers)).toBe(true);
    expect(Object.isFrozen(report.hosts[0]?.bundle?.mcpServers?.[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('distinguishes empty MCP manifests from manifests that could not be enumerated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-discovery-mcp-empty-'));
  try {
    const service = new HostDiscoveryService({
      doctor: async () => Object.freeze({
        ...doctorReport,
        hosts: Object.freeze([
          Object.freeze({
            ...doctorReport.hosts[0]!,
            bundle: Object.freeze({ ...doctorReport.hosts[0]!.bundle!, bundleRoot: root }),
          }),
        ]),
      }),
    });

    await writeFile(join(root, '.mcp.json'), '{"mcpServers":{}}');
    expect((await service.discover()).hosts[0]?.bundle?.mcpServers).toEqual([]);

    await writeFile(join(root, '.mcp.json'), '{"mcpServers":{"broken":');
    expect((await service.discover()).hosts[0]?.bundle).not.toHaveProperty('mcpServers');

    await unlink(join(root, '.mcp.json'));
    expect((await service.discover()).hosts[0]?.bundle).not.toHaveProperty('mcpServers');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('leaves MCP server enumeration absent when the host has no MCP runtime', async () => {
  const registry = {
    mcpRuntime: () => undefined,
  } as unknown as TargetRegistry;
  const service = new HostDiscoveryService({
    doctor: async () => doctorReport,
    registry,
  });

  const report = await service.discover();

  expect(report.hosts[0]?.bundle).not.toHaveProperty('mcpServers');
});
