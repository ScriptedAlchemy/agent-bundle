import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { TargetRegistry } from '../src/adapters/registry.ts';
import {
  McpProbeService,
  McpProbeTargetNotFoundError,
  mcpProbeInstructionTextLimit,
  mcpProbeToolLimit,
  type McpProbeClient,
  type McpProbeServiceOptions,
  type McpProbeTransport,
} from '../src/dev/playground/mcp-probe-service.ts';

const createBundle = async (
  servers: Readonly<Record<string, unknown>> = {
    timeline: {
      args: ['${CLAUDE_PLUGIN_ROOT}/mcp/timeline.js', '--token=super-secret-value'],
      command: 'node',
      env: { LANG: 'en_US.UTF-8', SECRET_TOKEN: 'super-secret-value' },
      type: 'stdio',
    },
  },
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-'));
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), '{"name":"probe","version":"1.0.0"}');
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  return root;
};

const transport = (
  close: () => Promise<void> = async () => undefined,
): McpProbeTransport => ({
  close,
  send: async () => undefined,
  start: async () => undefined,
});

const client = (
  overrides: Partial<McpProbeClient> = {},
): McpProbeClient => ({
  close: async () => undefined,
  connect: async () => undefined,
  getInstructions: () => 'Use token=abc12345678901234567 at /home/private/config.json',
  getNegotiatedProtocolVersion: () => '2025-11-25',
  getServerCapabilities: () => ({
    experimental: {},
    prompts: {},
    resources: {},
    tools: {},
  }),
  getServerVersion: () => ({
    name: 'timeline',
    title: 'Timeline Server',
    version: '1.2.3',
  }),
  listTools: async () => ({
    tools: Array.from({ length: mcpProbeToolLimit + 1 }, (_, index) => ({
      description: index === 0
        ? 'Reads token=abc12345678901234567 from /home/private/config.json'
        : `Tool ${index}`,
      inputSchema: { type: 'object' as const },
      name: `tool-${index}`,
      title: `Tool ${index}`,
    })),
  }),
  ...overrides,
});

const serviceFor = (
  bundleRoot: string,
  overrides: Partial<McpProbeServiceOptions> = {},
): McpProbeService => new McpProbeService({
  createClient: () => client(),
  createStdioTransport: () => transport(),
  createStreamableHttpTransport: () => transport(),
  now: () => new Date('2026-09-02T07:00:00.000Z'),
  prepared: () => Object.freeze({ bundleSource: bundleRoot }),
  projectRoot: '/workspace/project',
  ...overrides,
});

it('maps a bounded, frozen successful probe snapshot and redacted launch', async () => {
  const root = await createBundle();
  try {
    const report = await serviceFor(root).probe({ host: 'claude', serverName: 'timeline' });

    expect(report.status).toBe('ok');
    expect(report.generatedAt).toBe('2026-09-02T07:00:00.000Z');
    expect(report.launch).toEqual({
      args: [join(root, 'mcp', 'timeline.js'), '[REDACTED]'],
      command: 'node',
      cwd: root,
      env: { LANG: 'en_US.UTF-8' },
      kind: 'stdio',
    });
    expect(report.snapshot).toMatchObject({
      capabilities: {
        experimental: true,
        prompts: true,
        resources: true,
        tools: true,
      },
      protocolVersion: '2025-11-25',
      serverInfo: {
        name: 'timeline',
        title: 'Timeline Server',
        version: '1.2.3',
      },
      toolsTruncated: true,
    });
    expect(report.snapshot?.instructions).toBe('[REDACTED]');
    expect(report.snapshot?.tools).toHaveLength(mcpProbeToolLimit);
    expect(report.snapshot?.tools[0]?.description).toBe('[REDACTED]');
    expect(JSON.stringify(report)).not.toContain('super-secret-value');
    expect(JSON.stringify(report)).not.toContain('abc12345678901234567');
    expect(JSON.stringify(report)).not.toContain('/home/private');
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.snapshot)).toBe(true);
    expect(Object.isFrozen(report.snapshot?.tools)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('redacts absolute paths after key-value and list separators', async () => {
  const root = await createBundle();
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        getInstructions: () => 'config=/home/alice/private.json',
        listTools: async () => ({
          tools: [
            {
              description: String.raw`cwd:C:\Users\alice\private`,
              inputSchema: { type: 'object' as const },
              name: 'windows-path',
            },
            {
              description: 'paths,/var/private/config.json',
              inputSchema: { type: 'object' as const },
              name: 'list-path',
            },
          ],
        }),
      }),
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });

    expect(report.snapshot?.instructions).toBe('[REDACTED]');
    expect(report.snapshot?.tools.map((tool) => tool.description)).toEqual([
      '[REDACTED]',
      '[REDACTED]',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps URLs while redacting real absolute and bundle paths (#316 review)', async () => {
  const root = await createBundle();
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        getInstructions: () => 'See https://example.com/docs/getting-started and http://localhost:8080/health for guidance.',
        getServerVersion: () => ({
          name: 'timeline',
          title: 'Docs: https://docs.example.com/timeline',
          version: '1.2.3',
        }),
        listTools: async () => ({
          tools: [
            {
              description: `Reads ${join(root, 'data', 'catalog.json')} and serves https://example.com/api`,
              inputSchema: { type: 'object' as const },
              name: 'bundle-path-and-url',
            },
            {
              description: 'Docs at https://example.com/docs; config at /etc/private/timeline.json',
              inputSchema: { type: 'object' as const },
              name: 'url-then-absolute-path',
            },
            {
              description: 'cwd:/var/private/timeline',
              inputSchema: { type: 'object' as const },
              name: 'colon-separated-absolute-path',
            },
            {
              description: 'file:///home/alice/private.json',
              inputSchema: { type: 'object' as const },
              name: 'file-url',
            },
            {
              description: 'Private docs at https://alice:hunter2@example.test/private and postgres://svc:pa55@db.internal:5432/app',
              inputSchema: { type: 'object' as const },
              name: 'url-with-userinfo',
            },
            {
              description: 'Bare user https://alice@example.test/private; contact ops@example.test',
              inputSchema: { type: 'object' as const },
              name: 'url-with-bare-user-and-email',
            },
          ],
        }),
      }),
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });

    // A URI scheme's `://` is not a path separator: link guidance survives.
    expect(report.snapshot?.instructions)
      .toBe('See https://example.com/docs/getting-started and http://localhost:8080/health for guidance.');
    expect(report.snapshot?.serverInfo.title).toBe('Docs: https://docs.example.com/timeline');
    expect(report.snapshot?.tools.map((tool) => tool.description)).toEqual([
      // Bundle paths become the <bundle> label and the URL beside them stays.
      'Reads <bundle>/data/catalog.json and serves https://example.com/api',
      // A real absolute path anywhere in the text still fails closed...
      '[REDACTED]',
      // ...including after a genuine `:` separator...
      '[REDACTED]',
      // ...and file: URLs are local paths.
      '[REDACTED]',
      // URL userinfo is a credential: it is masked while the link survives.
      'Private docs at https://[REDACTED]@example.test/private and postgres://[REDACTED]@db.internal:5432/app',
      // A bare user is masked too; an email address is not URL userinfo.
      'Bare user https://[REDACTED]@example.test/private; contact ops@example.test',
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('pa55');
    expect(serialized).not.toContain('alice');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('truncates server instructions to the named text budget', async () => {
  const root = await createBundle();
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        getInstructions: () => 'x'.repeat(mcpProbeInstructionTextLimit + 100),
        listTools: async () => ({ tools: [] }),
      }),
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });

    const instructions = report.snapshot?.instructions;
    expect(instructions).toHaveLength(mcpProbeInstructionTextLimit);
    expect(instructions?.endsWith('…')).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports connect rejection as an honest unreachable probe result', async () => {
  const root = await createBundle();
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        connect: async () => {
          const error = new Error('connect ECONNREFUSED /home/private/server.sock') as NodeJS.ErrnoException;
          error.code = 'ECONNREFUSED';
          throw error;
        },
      }),
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });

    expect(report).toMatchObject({
      failure: { detail: '[REDACTED]', kind: 'connect' },
      status: 'unreachable',
    });
    expect(report).not.toHaveProperty('snapshot');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('times out within the total budget and destroys the transport', async () => {
  const root = await createBundle();
  let transportCloses = 0;
  try {
    const service = serviceFor(root, {
      createClient: () => client({ connect: () => new Promise(() => undefined) }),
      createStdioTransport: () => transport(async () => {
        transportCloses += 1;
      }),
      timeoutMs: 10,
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });

    expect(report.status).toBe('timed-out');
    expect(report.failure?.kind).toBe('connect');
    expect(transportCloses).toBeGreaterThan(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('returns a timed-out report without awaiting stalled teardown', async () => {
  const root = await createBundle();
  let clientCloses = 0;
  let transportCloses = 0;
  let guard: NodeJS.Timeout | undefined;
  try {
    const stalledClose = async (): Promise<void> =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const service = serviceFor(root, {
      createClient: () => client({
        close: async () => {
          clientCloses += 1;
          await stalledClose();
        },
        connect: () => new Promise(() => undefined),
      }),
      createStdioTransport: () => transport(async () => {
        transportCloses += 1;
        await stalledClose();
      }),
      timeoutMs: 10,
    });

    const report = await Promise.race([
      service.probe({ host: 'claude', serverName: 'timeline' }),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(
          () => reject(new Error('The timed-out probe remained blocked on teardown.')),
          150,
        );
      }),
    ]);

    expect(report.status).toBe('timed-out');
    expect(clientCloses).toBe(1);
    expect(transportCloses).toBeGreaterThan(0);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    await rm(root, { force: true, recursive: true });
  }
});

it('returns a timed-out report without awaiting stalled teardown when the budget is spent before connecting', async () => {
  const root = await createBundle();
  let transportCloses = 0;
  let guard: NodeJS.Timeout | undefined;
  let ticks = 0;
  try {
    const service = serviceFor(root, {
      // The clock reads 0 at probe start and the whole budget later at every
      // subsequent read, so the connect step finds no time remaining.
      clock: () => (ticks++ === 0 ? 0 : 10_000),
      createClient: () => client({
        close: async () => new Promise((resolvePromise) => setTimeout(resolvePromise, 250)),
        connect: () => new Promise(() => undefined),
      }),
      createStdioTransport: () => transport(async () => {
        transportCloses += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }),
      timeoutMs: 10,
    });

    const report = await Promise.race([
      service.probe({ host: 'claude', serverName: 'timeline' }),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(
          () => reject(new Error('The budget-exhausted probe remained blocked on teardown.')),
          150,
        );
      }),
    ]);

    expect(report.status).toBe('timed-out');
    expect(report.failure?.kind).toBe('connect');
    expect(transportCloses).toBeGreaterThan(0);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    await rm(root, { force: true, recursive: true });
  }
});

it('coalesces only identical in-flight probes and clears them after settlement', async () => {
  const root = await createBundle();
  const connectStarted = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  let clients = 0;
  try {
    const service = serviceFor(root, {
      createClient: () => {
        clients += 1;
        return client({
          connect: () => {
            connectStarted.resolve();
            return connected.promise;
          },
          listTools: async () => ({ tools: [] }),
        });
      },
    });
    const first = service.probe({ host: 'claude', serverName: 'timeline' });
    const concurrent = service.probe({ host: 'claude', serverName: 'timeline' });
    expect(first).toBe(concurrent);
    await connectStarted.promise;
    expect(clients).toBe(1);

    connected.resolve();
    const [firstReport, concurrentReport] = await Promise.all([first, concurrent]);
    expect(firstReport).toBe(concurrentReport);

    await service.probe({ host: 'claude', serverName: 'timeline' });
    expect(clients).toBe(2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('throws typed not-found errors for unavailable trusted probe targets', async () => {
  const root = await createBundle();
  try {
    await expect(new McpProbeService({
      prepared: () => undefined,
      projectRoot: '/workspace/project',
    }).probe({ host: 'claude', serverName: 'timeline' })).rejects.toBeInstanceOf(McpProbeTargetNotFoundError);

    await expect(serviceFor(root).probe({
      host: 'claude',
      serverName: 'missing',
    })).rejects.toBeInstanceOf(McpProbeTargetNotFoundError);

    const registry = { mcpRuntime: () => undefined } as unknown as TargetRegistry;
    await expect(serviceFor(root, { registry }).probe({
      host: 'claude',
      serverName: 'timeline',
    })).rejects.toBeInstanceOf(McpProbeTargetNotFoundError);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('removes plugin data only after a slow transport teardown settles (#316 review)', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  const events: string[] = [];
  const closeStarted = Promise.withResolvers<void>();
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolvePromise) => {
    releaseClose = resolvePromise;
  });
  try {
    const service = serviceFor(root, {
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      createStdioTransport: () => transport(async () => {
        // A stdio server that takes longer than the 50 ms response-boundary
        // wait to exit: the directory it may still hold must survive until
        // this close settles.
        closeStarted.resolve();
        await closeReleased;
        events.push('transport-closed');
      }),
    });

    const report = await Promise.race([
      service.probe({ host: 'claude', serverName: 'timeline' }),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('The probe response waited on the slow teardown.')),
        2_000,
      ).unref()),
    ]);
    events.push('report-returned');
    await closeStarted.promise;

    // The response came back with teardown still pending and the plugin data intact.
    expect(report.status).toBe('ok');
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).resolves.toBe('present');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).resolves.toBe('present');

    // Once the transport close settles, the detached path removes the directory.
    releaseClose();
    await service.settle();
    events.push('plugin-data-removed');
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).toEqual(['report-returned', 'transport-closed', 'plugin-data-removed']);
  } finally {
    if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});

it('settle() fences in-flight probes, not only already-registered teardowns (#397 review)', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  const events: string[] = [];
  let releaseConnect!: () => void;
  const connectReleased = new Promise<void>((resolvePromise) => {
    releaseConnect = resolvePromise;
  });
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        connect: async () => {
          // A probe that is still connecting when shutdown begins: its
          // teardown is not registered yet, so a fence over teardowns alone
          // would resolve immediately.
          await connectReleased;
        },
      }),
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      createStdioTransport: () => transport(async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
        events.push('transport-closed');
      }),
    });

    const probe = service.probe({ host: 'claude', serverName: 'timeline' });
    void probe.then(() => { events.push('report-returned'); });
    // Let the probe reach its (blocked) connect before shutdown starts.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).resolves.toBe('present');

    let settled = false;
    const settle = service.settle().then(() => { settled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(settled).toBe(false);

    releaseConnect();
    await settle;
    events.push('settled');
    const report = await probe;
    expect(report.status).toBe('ok');
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).toEqual(['report-returned', 'transport-closed', 'settled']);
  } finally {
    if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});

it('still closes the transport and removes plugin data when a close() throws synchronously (#397 review)', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  let transportClosed = false;
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        close: () => {
          // Not a rejection: a synchronous throw from the SDK client's close.
          throw new Error('client close exploded synchronously');
        },
      }),
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      createStdioTransport: () => transport(async () => {
        transportClosed = true;
      }),
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });
    expect(report.status).toBe('ok');
    await service.settle();
    expect(transportClosed).toBe(true);
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});

it('reports a timeout even when the timeout teardown throws synchronously', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  let ticks = 0;
  try {
    const service = serviceFor(root, {
      // Budget already spent at the connect step, so its synchronous-throwing
      // timeout teardown runs on the spent-budget path.
      clock: () => (ticks++ === 0 ? 0 : 10_000),
      createClient: () => client({ connect: () => new Promise(() => undefined) }),
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      createStdioTransport: () => transport(() => {
        throw new Error('transport close exploded synchronously');
      }),
      timeoutMs: 10,
    });
    const report = await service.probe({ host: 'claude', serverName: 'timeline' });
    expect(report.status).toBe('timed-out');
    expect(report.failure?.kind).toBe('connect');
    await service.settle();
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});

it('removes the fresh plugin data directory after every probe', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  try {
    const service = serviceFor(root, {
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
    });

    await service.probe({ host: 'claude', serverName: 'timeline' });

    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});
