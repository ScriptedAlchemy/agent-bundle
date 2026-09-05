import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { TargetRegistry } from '../src/adapters/registry.ts';
import {
  artifactManifestName,
  assembleArtifactManifest,
  type ArtifactManifest,
} from '../src/build/manifest.ts';
import { digest, sha256Hex } from '../src/core/digest.ts';
import {
  McpProbeService,
  McpProbeTargetNotFoundError,
  mcpProbeInstructionTextLimit,
  mcpProbePluginDataTeardownCapMs,
  mcpProbeTeardownWaitMs,
  mcpProbeToolLimit,
  type McpProbeClient,
  type McpProbeServiceOptions,
  type McpProbeTimers,
  type McpProbeTransport,
} from '../src/dev/playground/mcp-probe-service.ts';

interface ManualTimer {
  readonly callback: () => void;
  readonly delayMs: number;
}

/**
 * Manual scheduler for the probe's timer seam: nothing fires on its own. A test
 * waits for the service to arm a timer with a given delay (event-ordered — the
 * promise settles when the code under test reaches that point), then fires it.
 */
const manualTimers = (): Readonly<{
  readonly fire: (delayMs: number) => Promise<void>;
  readonly pending: () => readonly number[];
  readonly timers: McpProbeTimers;
}> => {
  const armed = new Set<ManualTimer>();
  const waiters = new Set<() => void>();
  const find = (delayMs: number): ManualTimer | undefined =>
    [...armed].find((timer) => timer.delayMs === delayMs);
  return Object.freeze({
    fire: async (delayMs) => {
      let timer = find(delayMs);
      while (timer === undefined) {
        await new Promise<void>((resolvePromise) => { waiters.add(resolvePromise); });
        timer = find(delayMs);
      }
      armed.delete(timer);
      timer.callback();
    },
    pending: () => [...armed].map((timer) => timer.delayMs),
    timers: {
      schedule: (callback, delayMs) => {
        const timer: ManualTimer = { callback, delayMs };
        armed.add(timer);
        for (const wake of [...waiters]) {
          waiters.delete(wake);
          wake();
        }
        return () => {
          armed.delete(timer);
        };
      },
    },
  });
};

/** Never settles: a teardown that hangs for the rest of the test. */
const stalled = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * Whether `promise` has already settled, decided at the next macrotask so every
 * microtask chained off the current turn has run first — no wall-clock wait.
 */
const settledBeforeNextTurn = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolvePromise) => { setImmediate(() => resolvePromise(false)); }),
  ]);

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
  await writeFile(join(root, '.claude-plugin', 'marketplace.json'), '{"name":"probe-marketplace"}');
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  const sourceInputs = Object.freeze([Object.freeze({
    path: 'agent-bundle.config.ts',
    sha256: sha256Hex('mcp probe fixture config\n'),
  })]);
  const documentPaths = [
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.mcp.json',
  ] as const;
  const files = await Promise.all(documentPaths.map(async (path) => {
    const bytes = await readFile(join(root, path));
    return {
      bytes: bytes.length,
      kind: 'generated' as const,
      path,
      sha256: sha256Hex(bytes),
      sourceInputs: ['agent-bundle.config.ts'],
    };
  }));
  const manifest: ArtifactManifest = {
    agentSkills: {
      schemaSha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
      sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
      specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
    },
    application: { id: 'application:probe', name: 'probe', version: '1.0.0' },
    distribution: { channels: ['local'] },
    executables: {
      bins: [],
      hooks: [],
      mcpServers: Object.keys(servers).sort().map((name) => ({
        apps: [],
        hosts: ['claude'],
        id: `mcp:${name}`,
        kind: 'command',
        name,
        transport: 'stdio',
      })),
      scripts: [],
    },
    files,
    manifestVersion: 2,
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: sourceInputs[0]!.sha256,
      configPath: sourceInputs[0]!.path,
      modelDigest: sha256Hex('mcp probe fixture model\n'),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    projections: [{
      adapterRevision: 'claude-fixture-v1',
      documents: {
        marketplace: '.claude-plugin/marketplace.json',
        mcp: '.mcp.json',
        plugin: '.claude-plugin/plugin.json',
      },
      host: 'claude',
      marketplace: { name: 'probe-marketplace' },
      observedVersion: 'fixture',
      schemas: [],
    }],
    routes: {
      digest: sha256Hex('mcp probe fixture routes\n'),
      events: [],
      layouts: [],
      providers: [],
      scripts: [],
      servers: [],
    },
    runtime: { node: '22.12.0' },
    validation: {
      artifact: { status: 'passed' },
      projections: [{ host: 'claude', status: 'passed' }],
      source: { status: 'passed' },
    },
  };
  await writeFile(join(root, artifactManifestName), assembleArtifactManifest(manifest).bytes);
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
              description: 'Private docs at https://alice:hunter2@example.test/private and wss://svc:pa55@relay.example.test:5432/app',
              inputSchema: { type: 'object' as const },
              name: 'url-with-userinfo',
            },
            {
              description: 'Socket unix:///home/alice/private.sock',
              inputSchema: { type: 'object' as const },
              name: 'local-uri-empty-authority',
            },
            {
              description: 'Open vscode://file/home/alice/project in the editor',
              inputSchema: { type: 'object' as const },
              name: 'local-uri-authority-then-path',
            },
            {
              description: 'Database postgres://svc:pa55@db.internal:5432/app',
              inputSchema: { type: 'object' as const },
              name: 'non-network-scheme-with-path',
            },
            {
              description: 'Registry oci://registry.example.test stays a link',
              inputSchema: { type: 'object' as const },
              name: 'non-network-scheme-without-path',
            },
            {
              description: 'Whitespace https://alice:se cret@example.test/private and tab https://bob:x\ty@example.test/',
              inputSchema: { type: 'object' as const },
              name: 'url-with-whitespace-in-userinfo',
            },
            {
              description: 'Path-less https://example.test then ops@example.test before any slash',
              inputSchema: { type: 'object' as const },
              name: 'path-less-url-then-email',
            },
            {
              description: 'Bare user https://alice@example.test/private; contact ops@example.test',
              inputSchema: { type: 'object' as const },
              name: 'url-with-bare-user-and-email',
            },
            {
              description: 'Raw @ in the password https://alice:pa@ss@example.test/private?next=me@x and quote https://al"ice:s3cret@example.test/#top',
              inputSchema: { type: 'object' as const },
              name: 'url-with-at-and-quote-in-userinfo',
            },
            {
              description: String.raw`Backslash in the password https://bob:pw\x@example.test/ and ws://carol:a\b@example.test/feed`,
              inputSchema: { type: 'object' as const },
              name: 'url-with-backslash-in-userinfo',
            },
            {
              description: 'Glued id_https://dave:pw1@example.test/private and ref9https://gwen:pw2@example.test/',
              inputSchema: { type: 'object' as const },
              name: 'url-userinfo-after-identifier',
            },
            {
              description: 'Glued sock_unix:///home/frank/private.sock',
              inputSchema: { type: 'object' as const },
              name: 'local-uri-after-identifier',
            },
            {
              description: 'Glued ref9https://example.test/docs and x_wss://relay.example.test/feed survive',
              inputSchema: { type: 'object' as const },
              name: 'network-url-after-identifier',
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
      // URL userinfo is a credential: it is masked while the network link survives.
      'Private docs at https://[REDACTED]@example.test/private and wss://[REDACTED]@relay.example.test:5432/app',
      // Only network schemes are exempt from the path rule: a local-resource
      // URI with an empty authority...
      '[REDACTED]',
      // ...or with a path after its authority carries a machine-local path...
      '[REDACTED]',
      // ...and any other scheme with a path component fails closed too.
      '[REDACTED]',
      // A non-network scheme without a path component is not a path.
      'Registry oci://registry.example.test stays a link',
      // Whitespace inside userinfo is encoded (spaces) or stripped (tabs) by URL
      // parsers, so it does not end the mask early.
      'Whitespace https://[REDACTED]@example.test/private and tab https://[REDACTED]@example.test/',
      // The documented trade-off: an `@` after a path-less URL, before any
      // `/`, `?`, or `#`, is masked as if it were userinfo (over-redaction).
      'Path-less https://[REDACTED]@example.test before any slash',
      // A bare user is masked too; an email address is not URL userinfo.
      'Bare user https://[REDACTED]@example.test/private; contact ops@example.test',
      // Masking runs through the final authority `@` (the delimiter URL parsers
      // honour), so a raw `@` or quote inside the password leaves nothing behind,
      // while an `@` in the query is not userinfo.
      'Raw @ in the password https://[REDACTED]@example.test/private?next=me@x and quote https://[REDACTED]@example.test/#top',
      // A backslash inside userinfo is masked with the rest of the credential.
      'Backslash in the password https://[REDACTED]@example.test/ and ws://[REDACTED]@example.test/feed',
      // Neither rule is anchored to a word boundary: a URL glued to a preceding
      // identifier (`_` or a digit in front of the scheme) is still masked...
      'Glued id_https://[REDACTED]@example.test/private and ref9https://[REDACTED]@example.test/',
      // ...a glued local-resource URI still fails closed...
      '[REDACTED]',
      // ...and a glued network link is still exempt from the path rule.
      'Glued ref9https://example.test/docs and x_wss://relay.example.test/feed survive',
    ]);
    const serialized = JSON.stringify(report);
    for (const secret of ['hunter2', 'pa55', 'alice', 'pa@ss', '@ss@', 's3cret', 'bob', 'carol', 'dave', 'gwen', 'frank', 'pw1', 'pw2']) {
      expect(serialized).not.toContain(secret);
    }
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
  const timers = manualTimers();
  try {
    const service = serviceFor(root, {
      // A frozen clock keeps the whole budget for the connect step, so the
      // budget timer is armed with exactly `timeoutMs`.
      clock: () => 0,
      createClient: () => client({
        close: () => {
          clientCloses += 1;
          return stalled();
        },
        connect: () => stalled(),
      }),
      createStdioTransport: () => transport(() => {
        transportCloses += 1;
        return stalled();
      }),
      timeoutMs: 10,
      timers: timers.timers,
    });

    const probe = service.probe({ host: 'claude', serverName: 'timeline' });
    // The budget expires while connect is still pending: the timeout starts
    // the transport close, and the report path arms the bounded teardown wait.
    await timers.fire(10);
    // Both closes hang forever; only the teardown wait may release the report.
    await timers.fire(mcpProbeTeardownWaitMs);
    expect(await settledBeforeNextTurn(probe)).toBe(true);

    const report = await probe;
    expect(report.status).toBe('timed-out');
    expect(clientCloses).toBe(1);
    expect(transportCloses).toBeGreaterThan(0);
    // The detached plugin-data cap is the only timer still armed: teardown is
    // running in the background, not on the response path. Firing it releases
    // the plugin-data removal, which `settle()` then fences.
    expect(timers.pending()).toEqual([mcpProbePluginDataTeardownCapMs]);
    await timers.fire(mcpProbePluginDataTeardownCapMs);
    await service.settle();
    expect(timers.pending()).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('returns a timed-out report without awaiting stalled teardown when the budget is spent before connecting', async () => {
  const root = await createBundle();
  let transportCloses = 0;
  let ticks = 0;
  const timers = manualTimers();
  try {
    const service = serviceFor(root, {
      // The clock reads 0 at probe start and the whole budget later at every
      // subsequent read, so the connect step finds no time remaining.
      clock: () => (ticks++ === 0 ? 0 : 10_000),
      createClient: () => client({
        close: () => stalled(),
        connect: () => stalled(),
      }),
      createStdioTransport: () => transport(() => {
        transportCloses += 1;
        return stalled();
      }),
      timeoutMs: 10,
      timers: timers.timers,
    });

    const probe = service.probe({ host: 'claude', serverName: 'timeline' });
    // No budget timer is armed on this path; the report waits only for the
    // bounded teardown wait, never for the stalled closes.
    await timers.fire(mcpProbeTeardownWaitMs);
    expect(await settledBeforeNextTurn(probe)).toBe(true);

    const report = await probe;
    expect(report.status).toBe('timed-out');
    expect(report.failure?.kind).toBe('connect');
    expect(transportCloses).toBeGreaterThan(0);
    expect(timers.pending()).toEqual([mcpProbePluginDataTeardownCapMs]);
    await timers.fire(mcpProbePluginDataTeardownCapMs);
    await service.settle();
    expect(timers.pending()).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('chains plugin-data removal to the close a timeout already started, not a duplicate close (#397 review)', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  let ticks = 0;
  let closeCalls = 0;
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolvePromise) => {
    releaseClose = resolvePromise;
  });
  try {
    const service = serviceFor(root, {
      clock: () => (ticks++ === 0 ? 0 : 10_000),
      createClient: () => client({ connect: () => new Promise(() => undefined) }),
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      // A non-reentrant transport: the first close runs the real (slow)
      // TERM/KILL path, any duplicate close answers immediately.
      createStdioTransport: () => transport(async () => {
        closeCalls += 1;
        if (closeCalls > 1) return;
        await closeReleased;
      }),
      timeoutMs: 10,
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });
    expect(report.status).toBe('timed-out');
    expect(closeCalls).toBe(1);

    // The response is back but the first close is still running: the plugin
    // data must survive until that close — not a duplicate — settles.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).resolves.toBe('present');

    releaseClose();
    await service.settle();
    expect(closeCalls).toBe(1);
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    releaseClose();
    if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
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
  let connectReached!: () => void;
  const connectStarted = new Promise<void>((resolvePromise) => {
    connectReached = resolvePromise;
  });
  try {
    const service = serviceFor(root, {
      createClient: () => client({
        connect: async () => {
          // A probe that is still connecting when shutdown begins: its
          // teardown is not registered yet, so a fence over teardowns alone
          // would resolve immediately.
          connectReached();
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
    // Wait for the probe to reach its (blocked) connect before shutdown
    // starts: plugin data exists by then, and the teardown is not registered.
    await connectStarted;
    await expect(readFile(join(pluginData!, 'proof.txt'), 'utf8')).resolves.toBe('present');

    let settled = false;
    const settle = service.settle().then(() => { settled = true; });
    // A fence over registered teardowns alone would resolve within the
    // current macrotask; draining one is enough to observe that regression.
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
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

it('retries plugin-data removal once a capped teardown finally settles (#397 review)', async () => {
  const root = await createBundle();
  // While the transport is "alive" the injected removal rejects the way a
  // still-running child makes `rm` fail on Windows (EPERM); once the transport
  // has closed it delegates to the real removal. No mode bits are involved, so
  // the failure is identical as root, in containers, and on Windows.
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-held-'));
  const pluginData = join(parent, 'plugin-data');
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolvePromise) => {
    releaseClose = resolvePromise;
  });
  const events: string[] = [];
  let transportAlive = true;
  try {
    const service = serviceFor(root, {
      createPluginData: async () => {
        await mkdir(pluginData);
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      createStdioTransport: () => transport(async () => {
        await closeReleased;
        transportAlive = false;
        events.push('transport-closed');
      }),
      pluginDataTeardownCapMs: 100,
      removePluginData: async (target) => {
        if (transportAlive) {
          events.push('removal-rejected');
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        await rm(target, { force: true, recursive: true });
      },
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });
    expect(report.status).toBe('ok');
    // The cap fires and the first removal fails against the held directory.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    await expect(readFile(join(pluginData, 'proof.txt'), 'utf8')).resolves.toBe('present');

    // The fence stays bounded by the cap: a transport that never settles must
    // not hold Workbench shutdown open, so settle() resolves with the retry
    // still outstanding.
    await Promise.race([
      service.settle(),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('settle() waited on the stalled transport past the cap.')),
        500,
      ).unref()),
    ]);
    events.push('settled');
    await expect(readFile(join(pluginData, 'proof.txt'), 'utf8')).resolves.toBe('present');

    // Once the transport finishes closing and releases the directory, the
    // best-effort retry chained to that settlement removes it.
    releaseClose();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await readFile(join(pluginData, 'proof.txt'), 'utf8');
      } catch {
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    events.push('plugin-data-removed');
    expect(events).toEqual(['removal-rejected', 'settled', 'transport-closed', 'plugin-data-removed']);
    await expect(readFile(join(pluginData, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(parent, { force: true, recursive: true });
    await rm(root, { force: true, recursive: true });
  }
});

it('retries removal once, fenced, when the teardown settled but the directory was still held (#397 review)', async () => {
  const root = await createBundle();
  let pluginData: string | undefined;
  let removals = 0;
  try {
    const service = serviceFor(root, {
      createPluginData: async () => {
        pluginData = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-probe-data-'));
        await writeFile(join(pluginData, 'proof.txt'), 'present');
        return pluginData;
      },
      // The transport's close fails fast, so the teardown settles at once
      // while (on Windows) the child still holds the directory for a moment.
      createStdioTransport: () => transport(() => Promise.reject(new Error('close failed fast'))),
      removePluginData: async (target) => {
        removals += 1;
        if (removals === 1) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        await rm(target, { force: true, recursive: true });
      },
    });

    const report = await service.probe({ host: 'claude', serverName: 'timeline' });
    expect(report.status).toBe('ok');
    // The fence covers the delayed retry: settle() resolves only after it ran.
    await service.settle();
    expect(removals).toBe(2);
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
