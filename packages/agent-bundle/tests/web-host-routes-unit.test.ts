import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { isRequestDiagnostic } from '../src/dev/http.ts';
import type { McpAppRoutePreviewService } from '../src/dev/mcp-apps/mcp-app-routes.ts';
import type { McpSession } from '../src/dev/mcp-session/mcp-session.ts';
import type { McpSessionService } from '../src/dev/mcp-session/mcp-session-service.ts';
import { WebHostRoutes, type WebHostEpochSource } from '../src/dev/web-host-routes.ts';

const registry = createDefaultRegistry();
const roots: string[] = [];
const servers: Server[] = [];

const artifactRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-web-routes-')));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const resourceUri = 'ui://status/status.html';

const claudeServer = (): Readonly<Record<string, unknown>> => ({
  args: ['${CLAUDE_PLUGIN_ROOT}/mcp/mcp-status.mjs'],
  command: 'node',
  env: { AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}' },
  type: 'stdio',
});

const portableServer = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  args: ['${PLUGIN_ROOT}/mcp/mcp-status.mjs'],
  command: 'node',
  env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}' },
  type: 'stdio',
  ...overrides,
});

const codexServer = (): Readonly<Record<string, unknown>> => ({
  args: ['./mcp/mcp-status.mjs'],
  command: 'node',
  cwd: './',
  env: { AGENT_BUNDLE_PLUGIN_ROOT: './' },
  type: 'stdio',
});

interface FixtureOptions {
  readonly projections: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly targets: readonly string[];
}

const writeFixture = async (root: string, options: FixtureOptions): Promise<void> => {
  await writeFile(join(root, 'agent-bundle.manifest.json'), JSON.stringify({
    projections: options.targets.map((host) => ({ host })),
    web: {
      apps: [{
        allow: [],
        app: 'status/status',
        args: [],
        entry: 'mcp/mcp-status.mjs',
        env: {},
        name: 'status',
        resourceUri,
        server: 'status',
      }],
      open: 'never',
    },
  }));
  for (const [relativePath, serverEntry] of Object.entries(options.projections)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { status: serverEntry } }));
  }
};

interface OpenedSession {
  readonly epochId: string;
  readonly id: string;
  readonly serverName: string;
  readonly target: string;
}

/** In-memory McpSessionService double: no processes, real lease counting. */
class FakeSessionService {
  readonly closed: string[] = [];
  readonly opened: OpenedSession[] = [];
  toolCalls = 0;
  readOnlyOpeningTool = false;
  failNextToolCall = false;
  readonly toolCallReleases: (() => void)[] = [];
  gateToolCalls = false;
  readonly #leases = new Map<string, number>();
  readonly #retire = new Set<string>();

  async open(options: { readonly epochId: string; readonly serverName: string; readonly target: string }): Promise<McpSession> {
    const id = `session-${String(this.opened.length + 1)}`;
    this.opened.push({ epochId: options.epochId, id, serverName: options.serverName, target: options.target });
    this.#leases.set(id, 0);
    const session = {
      callTool: async () => {
        this.toolCalls += 1;
        if (this.gateToolCalls) await new Promise<void>((release) => this.toolCallReleases.push(release));
        if (this.failNextToolCall) {
          this.failNextToolCall = false;
          throw new Error('opening tool failed');
        }
        return { content: [], structuredContent: { status: 'healthy' } };
      },
      id,
      listResources: async () => [{ mimeType: 'text/html;profile=mcp-app', name: 'status', uri: resourceUri }],
      listTools: async () => [{
        _meta: { ui: { resourceUri } },
        ...(this.readOnlyOpeningTool ? { annotations: { readOnlyHint: true } } : {}),
        inputSchema: { type: 'object' },
        name: 'show-status',
      }],
    };
    return session as unknown as McpSession;
  }

  async acquireAppLease(sessionId: string) {
    if (!this.#leases.has(sessionId)) throw new Error(`Unknown MCP App session ${JSON.stringify(sessionId)}.`);
    this.#leases.set(sessionId, (this.#leases.get(sessionId) ?? 0) + 1);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const remaining = Math.max(0, (this.#leases.get(sessionId) ?? 1) - 1);
        this.#leases.set(sessionId, remaining);
        if (remaining === 0 && this.#retire.delete(sessionId)) void this.closeSession(sessionId);
      },
      session: {},
      watchSessionClosed: () => ({ closed: false, unsubscribe: () => undefined }),
    };
  }

  appLeaseCount(sessionId: string): number {
    return this.#leases.get(sessionId) ?? 0;
  }

  closeSessionWhenUnleased(sessionId: string): boolean {
    if (!this.#leases.has(sessionId)) return false;
    if ((this.#leases.get(sessionId) ?? 0) === 0) {
      void this.closeSession(sessionId);
      return true;
    }
    this.#retire.add(sessionId);
    return false;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    this.closed.push(sessionId);
    this.#leases.delete(sessionId);
    this.#retire.delete(sessionId);
    return true;
  }

  /** Simulates a page holding its own lease on the session, as a bind does. */
  async leaseAsPage(sessionId: string) {
    return this.acquireAppLease(sessionId);
  }
}

interface Harness {
  readonly routes: WebHostRoutes;
  readonly service: FakeSessionService;
  readonly url: string;
  setEpoch(epochId: string): void;
}

const startHarness = async (root: string, initialEpochId = 'epoch-1'): Promise<Harness> => {
  let epochId = initialEpochId;
  const epochs: WebHostEpochSource = {
    acquireActiveEpochReference: async () => ({
      close: async () => undefined,
      epoch: { id: epochId },
      root,
    }),
  };
  const service = new FakeSessionService();
  const routes = new WebHostRoutes({
    authorize: () => undefined,
    epochs,
    launch: { projectRoot: root, registry },
    mcpSessions: service as unknown as McpSessionService,
    previews: {} as unknown as McpAppRoutePreviewService,
    sandboxOrigin: () => 'http://127.0.0.1:1',
    sessionToken: 'test-token',
  });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    }).catch((error: unknown) => {
      response.statusCode = isRequestDiagnostic(error) ? error.status : 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    });
  });
  servers.push(server);
  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
  return {
    routes,
    service,
    setEpoch: (next: string) => { epochId = next; },
    url,
  };
};

const settle = async (): Promise<void> => {
  // Retirement disposes retired sessions off the request path.
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('WebHostRoutes launch selection', () => {
  it('opens the web route from a Claude-only artifact without a portable projection', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root);
    const response = await fetch(`${harness.url}/web/status/status`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"previewProfile":"portable"');
    expect(harness.service.opened).toHaveLength(1);
    expect(harness.service.opened[0]?.target).toBe('claude');
  });

  it('opens the web route from a Codex-only artifact without a portable projection', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.codex-plugin/mcp.json': codexServer() }, targets: ['codex'] });
    const harness = await startHarness(root);
    const response = await fetch(`${harness.url}/web/status/status`);
    expect(response.status).toBe(200);
    expect(harness.service.opened[0]?.target).toBe('codex');
  });

  it('opens without an explicit target when the declared projections share one launch, whatever their order', async () => {
    const root = await artifactRoot();
    await writeFixture(root, {
      projections: { '.mcp.json': claudeServer(), 'mcp.json': portableServer() },
      targets: ['portable', 'claude'],
    });
    const harness = await startHarness(root);
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(1);
    expect(harness.service.opened[0]?.target).toBe('claude');
  });

  it('requires an explicit target for materially different launches and validates it, never falling back', async () => {
    const root = await artifactRoot();
    await writeFixture(root, {
      projections: {
        '.mcp.json': claudeServer(),
        'mcp.json': portableServer({ env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}', STATUS_MODE: 'portable-only' } }),
      },
      targets: ['claude', 'portable'],
    });
    const harness = await startHarness(root);
    const ambiguous = await fetch(`${harness.url}/web/status/status`);
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.text()).toContain('?target=');
    expect(harness.service.opened).toHaveLength(0);

    const invalid = await fetch(`${harness.url}/web/status/status?target=nope`);
    expect(invalid.status).toBe(404);
    expect(await invalid.text()).toContain('nope');
    expect(harness.service.opened).toHaveLength(0);

    const explicit = await fetch(`${harness.url}/web/status/status?target=portable`);
    expect(explicit.status).toBe(200);
    expect(harness.service.opened).toHaveLength(1);
    expect(harness.service.opened[0]?.target).toBe('portable');
  });

  it('keys the session cache on the resolved launch identity, not epoch and server alone', async () => {
    const root = await artifactRoot();
    await writeFixture(root, {
      projections: {
        '.mcp.json': claudeServer(),
        'mcp.json': portableServer({ env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}', STATUS_MODE: 'portable-only' } }),
      },
      targets: ['claude', 'portable'],
    });
    const harness = await startHarness(root);
    expect((await fetch(`${harness.url}/web/status/status?target=claude`)).status).toBe(200);
    expect((await fetch(`${harness.url}/web/status/status?target=portable`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(2);
    expect(harness.service.opened.map((opened) => opened.target)).toEqual(['claude', 'portable']);
    expect((await fetch(`${harness.url}/web/status/status?target=claude`)).status).toBe(200);
    expect((await fetch(`${harness.url}/web/status/status?target=portable`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(2);
  });
});

describe('WebHostRoutes session retirement', () => {
  it('retires an unused old-epoch session on successful epoch publication and acquires the new epoch', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root, 'epoch-1');
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(1);

    harness.setEpoch('epoch-2');
    harness.routes.adoptActiveEpoch('epoch-2');
    await settle();
    expect(harness.service.closed).toEqual(['session-1']);

    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(2);
    expect(harness.service.opened[1]?.epochId).toBe('epoch-2');
  });

  it('keeps an old-epoch session that pages still lease, while no longer handing it out', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root, 'epoch-1');
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    const sessionId = harness.service.opened[0]!.id;
    // Two tabs bind the shared session; one closing (releasing) must not end it.
    const firstTab = await harness.service.leaseAsPage(sessionId);
    const secondTab = await harness.service.leaseAsPage(sessionId);
    await firstTab.release();

    harness.setEpoch('epoch-2');
    harness.routes.adoptActiveEpoch('epoch-2');
    await settle();
    expect(harness.service.closed).toEqual([]);
    expect(harness.service.appLeaseCount(sessionId)).toBeGreaterThan(0);
    await secondTab.release();
    // The retired session closes at the release of its last page lease.
    await settle();
    expect(harness.service.closed).toEqual([sessionId]);

    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(2);
  });

  it('keeps the last working session when a rebuild fails and publishes no epoch', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root, 'epoch-1');
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    // A failed rebuild publishes no artifact.available, so nothing retires.
    await settle();
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.opened).toHaveLength(1);
    expect(harness.service.closed).toEqual([]);
  });
});

describe('WebHostRoutes opening-tool policy', () => {
  it('runs a mutating (unannotated) opening tool once per session and rebinds its result on refresh', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root);
    const first = await (await fetch(`${harness.url}/web/status/status`)).text();
    const second = await (await fetch(`${harness.url}/web/status/status`)).text();
    expect(harness.service.toolCalls).toBe(1);
    const openingOf = (html: string): string => {
      const match = html.match(/"opening":"([^"]+)"/u);
      if (match?.[1] === undefined) throw new Error('Web host seed does not contain opening.');
      return match[1];
    };
    expect(openingOf(second)).not.toBe(openingOf(first));
  });

  it('re-runs an opening tool annotated readOnlyHint on every page load', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root);
    harness.service.readOnlyOpeningTool = true;
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.toolCalls).toBe(2);
  });

  it('shares one in-flight mutating opening call across concurrent first loads', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root);
    harness.service.gateToolCalls = true;
    const loads = Promise.all([
      fetch(`${harness.url}/web/status/status`),
      fetch(`${harness.url}/web/status/status`),
    ]);
    for (let turn = 0; turn < 200 && harness.service.toolCallReleases.length === 0; turn += 1) {
      await new Promise((done) => setTimeout(done, 5));
    }
    await settle();
    harness.service.toolCallReleases.splice(0).forEach((release) => release());
    const responses = await loads;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(harness.service.toolCalls).toBe(1);
  });

  it('drops a failed mutating opening call so the next load retries', async () => {
    const root = await artifactRoot();
    await writeFixture(root, { projections: { '.mcp.json': claudeServer() }, targets: ['claude'] });
    const harness = await startHarness(root);
    harness.service.failNextToolCall = true;
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(502);
    expect((await fetch(`${harness.url}/web/status/status`)).status).toBe(200);
    expect(harness.service.toolCalls).toBe(2);
  });
});
