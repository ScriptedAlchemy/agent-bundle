import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import type { Client } from '@modelcontextprotocol/client';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';

import stateDefinition from '../../fixtures/route-harness/src/state.ts';
import { createEventRuntimeServer } from '../../src/events/ipc.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import {
  compileTestManifest,
  MCP_IN_MEMORY_PROOF_LEVEL,
  proofLevelLabel,
  type AgentBundleTestManifest,
} from '../../src/test/manifest.ts';
import {
  runContractMatrix,
  runInstalledHostContractMatrix,
  runPackedContractMatrix,
  type ContractMatrixOptions,
} from '../../src/test/contract.ts';
import type { InstalledHostMcpSession } from '../../src/test/installed.ts';
import { openInMemoryMcpServer, type InMemoryMcpSession } from '../../src/test/mcp.ts';
import type { PackedMcpSession } from '../../src/test/packed.ts';
import {
  routeHarnessContractFixtures,
  routeHarnessLifecycleWithoutLiveProgress,
} from '../support/contract-matrix-fixtures.ts';

const proofLabel = proofLevelLabel(MCP_IN_MEMORY_PROOF_LEVEL);
const fixtureRoot = resolve(import.meta.dirname, '../../fixtures/route-harness');

const withStatefulMatrix = async <T>(
  fixtures: ContractMatrixOptions['fixtures'],
  body: (options: ContractMatrixOptions) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-contract-matrix-'));
  let restarted: InMemoryMcpSession | undefined;
  try {
    const options = {
      fixtures,
      restart: async () => {
        restarted = await openInMemoryMcpServer({
          state: {
            definition: stateDefinition,
            driver: createSqliteStateDriver({ root }),
          },
        });
        return restarted;
      },
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    } as unknown as ContractMatrixOptions;
    return await body(options);
  } finally {
    await restarted?.close();
    await rm(root, { force: true, recursive: true });
  }
};

const PANEL_URI = 'ui://harness/panel';
const PANEL_MIME = 'text/html;profile=mcp-app';

/**
 * Stands in for the packed server's inline MCP App registry: the in-memory
 * level never registers app resources, so a packed-shaped session over it
 * needs the compiled `ui://` surface added on the client side. Every other
 * call, and the progress-handler map the lifecycle replay composes, delegates
 * to the real client.
 */
const withAppSurface = (client: Client): Client => appSurface(client, 'serves');

const withRejectingAppSurface = (client: Client): Client => appSurface(client, 'rejects');

const appSurface = (client: Client, read: 'rejects' | 'serves'): Client => {
  const panelListing = { mimeType: PANEL_MIME, name: 'panel', uri: PANEL_URI };
  const wrapper = {
    _notificationHandlers: (client as unknown as { readonly _notificationHandlers: unknown })
      ._notificationHandlers,
    callTool: (...arguments_: Parameters<Client['callTool']>) => client.callTool(...arguments_),
    getPrompt: (...arguments_: Parameters<Client['getPrompt']>) => client.getPrompt(...arguments_),
    listPrompts: (...arguments_: Parameters<Client['listPrompts']>) => client.listPrompts(...arguments_),
    listResources: async (...arguments_: Parameters<Client['listResources']>) => {
      const listed = await client.listResources(...arguments_);
      return { ...listed, resources: [...listed.resources, panelListing] };
    },
    listTools: (...arguments_: Parameters<Client['listTools']>) => client.listTools(...arguments_),
    readResource: async (...arguments_: Parameters<Client['readResource']>) => {
      const [params] = arguments_;
      if (params.uri !== PANEL_URI) return client.readResource(...arguments_);
      if (read === 'rejects') throw new Error('panel resource handler exploded');
      return { contents: [{ mimeType: PANEL_MIME, text: '<!doctype html><span>route-harness panel</span>', uri: PANEL_URI }] };
    },
  };
  return wrapper as unknown as Client;
};

/** Drops the abort signal from `callTool` for one tool so the abort is never delivered to the server. */
const ignoringAbortFor = (toolName: string) => (client: Client): Client => {
  const wrapper = {
    _notificationHandlers: (client as unknown as { readonly _notificationHandlers: unknown })
      ._notificationHandlers,
    callTool: (...arguments_: Parameters<Client['callTool']>) => {
      const [params, options] = arguments_;
      if (params.name !== toolName || options === undefined) return client.callTool(...arguments_);
      const withoutSignal = { ...options };
      delete withoutSignal.signal;
      return client.callTool(params, withoutSignal);
    },
    getPrompt: (...arguments_: Parameters<Client['getPrompt']>) => client.getPrompt(...arguments_),
    listPrompts: (...arguments_: Parameters<Client['listPrompts']>) => client.listPrompts(...arguments_),
    listResources: (...arguments_: Parameters<Client['listResources']>) => client.listResources(...arguments_),
    listTools: (...arguments_: Parameters<Client['listTools']>) => client.listTools(...arguments_),
    readResource: (...arguments_: Parameters<Client['readResource']>) => client.readResource(...arguments_),
  };
  return wrapper as unknown as Client;
};

/**
 * Opens the route-harness server in memory and presents it as a packed-stdio
 * session so the shared matrix runs with `registersAppResources: true`.
 */
const withPackedShapedSession = async <T>(
  options: {
    readonly decorate?: (client: Client) => Client;
    readonly entry: string;
    readonly includeApps: boolean;
  },
  body: (session: PackedMcpSession, manifest: AgentBundleTestManifest) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-contract-packed-shaped-'));
  const compiledManifest = await compileTestManifest({ root: fixtureRoot });
  const manifest = options.includeApps
    ? compiledManifest
    : Object.freeze({
      ...compiledManifest,
      apps: Object.freeze({}),
      routes: Object.freeze(Object.fromEntries(
        Object.entries(compiledManifest.routes).filter(([, route]) => route.kind !== 'app'),
      )),
    });
  const session = await openInMemoryMcpServer({
    manifest,
    state: {
      definition: stateDefinition,
      driver: createSqliteStateDriver({ root }),
    },
  });
  const packedSession: PackedMcpSession = Object.freeze({
    client: options.decorate === undefined ? session.client : options.decorate(session.client),
    close: session.close,
    provenance: Object.freeze({
      entry: options.entry,
      pid: undefined,
      proofLevel: 'packed-stdio' as const,
    }),
    stderr: () => '',
    [Symbol.asyncDispose]: session[Symbol.asyncDispose],
  });
  try {
    return await body(packedSession, manifest);
  } finally {
    await session.close();
    await rm(root, { force: true, recursive: true });
  }
};

describe('the generated-plugin contract matrix', () => {
  it('passes every check for the route-harness server at mcp-in-memory', async () => {
    const report = await withStatefulMatrix(routeHarnessContractFixtures(), (options) =>
      runContractMatrix(options));

    expect(report.provenance.proofLevel).toBe('mcp-in-memory');
    expect(report.routes['tool:harness/wait']?.checks.cancellation).toEqual({ status: 'passed' });
    expect(report.routes['tool:harness/ticket']?.checks['version-skew']).toEqual({ status: 'passed' });
    expect(report.routes['tool:harness/lifecycle']?.checks['lifecycle-replay']).toEqual({ status: 'passed' });
    expect(report.routes['tool:harness/lifecycle']?.checks['live-progress-before-terminal']).toEqual({
      status: 'passed',
    });
    expect(report.routes['tool:harness/lifecycle']?.checks['state-idempotency']).toEqual({ status: 'passed' });
    expect(report.routes['tool:harness/lifecycle']?.checks['state-budget']).toEqual({ status: 'passed' });
    expect(report.routes['tool:harness/lifecycle']?.checks['state-catalog']).toEqual({ status: 'passed' });
    expect(report.checks['runtime-instance-identity']).toEqual({
      reason: 'the mcp-in-memory boundary has no generated event runtime.',
      status: 'not-applicable',
    });
    expect(report.routes['tool:harness/lifecycle']?.checks['restart-durability']).toEqual({ status: 'passed' });
    expect(report.routes['app:harness/panel']?.checks['surface-completeness']).toEqual({
      reason: 'MCP Apps are not registered by the in-memory projection level.',
      status: 'not-applicable',
    });
    expect(report.routes['tool:harness/unavailable']?.checks.sweep).toEqual({
      reason: 'Invocation returned isError; sweep proves successful invocation paths only.',
      status: 'not-applicable',
    });
  }, 30_000);

  it('reports lifecycle progress that was not live before settlement', async () => {
    const error = await withStatefulMatrix(routeHarnessLifecycleWithoutLiveProgress(), (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/lifecycle');
    expect((error as AgentTestError).message).toContain('live-progress-before-terminal');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('rejects a lifecycle fixture whose mounted-state declaration drifts from the manifest catalog', async () => {
    const fixtures = routeHarnessContractFixtures();
    const lifecycleFixture = fixtures['tool:harness/lifecycle'];
    if (lifecycleFixture?.lifecycle?.state === undefined) {
      throw new TypeError('Lifecycle state fixture is unavailable.');
    }
    const error = await withStatefulMatrix({
      ...fixtures,
      'tool:harness/lifecycle': {
        ...lifecycleFixture,
        lifecycle: {
          ...lifecycleFixture.lifecycle,
          state: {
            ...lifecycleFixture.lifecycle.state,
            catalog: {
              id: 'route-harness/not-the-mounted-store',
              lifetime: 'workspace-durable',
            },
          },
        },
      },
    }, (options) => runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).message).toContain('state-catalog');
    expect((error as AgentTestError).message).toContain('route-harness/journal');
    expect((error as AgentTestError).message).toContain('route-harness/not-the-mounted-store');
  }, 30_000);

  it('composes and restores a caller-owned progress handler after lifecycle replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-contract-handler-'));
    const runtime = await createEventRuntimeServer({
      artifactEpoch: 'route-harness@1.0.0',
      endpointId: `contract-matrix-progress:${root}`,
      handle: async () => undefined,
      status: () => ({
        artifactEpoch: 'route-harness@1.0.0',
        availability: 'available',
        instanceId: 'runtime-instance-a',
        pid: process.pid,
      }),
    });
    const compiledManifest = await compileTestManifest({ root: fixtureRoot });
    const manifest = Object.freeze({
      ...compiledManifest,
      apps: Object.freeze({}),
      routes: Object.freeze(Object.fromEntries(
        Object.entries(compiledManifest.routes).filter(([, route]) => route.kind !== 'app'),
      )),
    });
    const session = await openInMemoryMcpServer({
      manifest,
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    });
    const packedSession: PackedMcpSession = Object.freeze({
      client: session.client,
      close: session.close,
      provenance: Object.freeze({
        entry: 'in-memory progress-handler regression fixture',
        pid: undefined,
        proofLevel: 'packed-stdio' as const,
      }),
      stderr: () => '',
      [Symbol.asyncDispose]: session[Symbol.asyncDispose],
    });
    type NotificationHandler = (...arguments_: readonly unknown[]) => void | Promise<void>;
    const notificationHandlers = (
      session.client as unknown as {
        readonly _notificationHandlers: Map<string, NotificationHandler>;
      }
    )._notificationHandlers;
    let callerProgress = 0;
    session.client.setNotificationHandler('notifications/progress', () => {
      callerProgress += 1;
    });
    const callerHandler = notificationHandlers.get('notifications/progress');
    try {
      const report = await runPackedContractMatrix({
        eventRuntime: { endpoint: runtime.endpoint },
        fixtures: routeHarnessContractFixtures(),
        manifest,
        server: 'harness',
        session: packedSession,
      });

      expect(report.routes['tool:harness/lifecycle']?.checks['lifecycle-replay']).toEqual({
        status: 'passed',
      });
      expect(report.checks['runtime-instance-identity']).toEqual({
        status: 'passed',
      });
      expect(callerProgress).toBeGreaterThan(0);
      expect(notificationHandlers.get('notifications/progress')).toBe(callerHandler);
    } finally {
      await session.close();
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('fails when the packed event runtime instance changes during sequential matrix events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-contract-identity-drift-'));
    let statusCalls = 0;
    const runtime = await createEventRuntimeServer({
      artifactEpoch: 'route-harness@1.0.0',
      endpointId: `contract-matrix-identity-drift:${root}`,
      handle: async () => undefined,
      status: () => ({
        artifactEpoch: 'route-harness@1.0.0',
        availability: 'available',
        instanceId: statusCalls++ === 0 ? 'runtime-instance-a' : 'runtime-instance-b',
        pid: process.pid,
      }),
    });
    const compiledManifest = await compileTestManifest({ root: fixtureRoot });
    const manifest = Object.freeze({
      ...compiledManifest,
      apps: Object.freeze({}),
      routes: Object.freeze(Object.fromEntries(
        Object.entries(compiledManifest.routes).filter(([, route]) => route.kind !== 'app'),
      )),
    });
    const session = await openInMemoryMcpServer({
      manifest,
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    });
    const packedSession: PackedMcpSession = Object.freeze({
      client: session.client,
      close: session.close,
      provenance: Object.freeze({
        entry: 'in-memory runtime-identity regression fixture',
        pid: undefined,
        proofLevel: 'packed-stdio' as const,
      }),
      stderr: () => '',
      [Symbol.asyncDispose]: session[Symbol.asyncDispose],
    });
    try {
      const error = await runPackedContractMatrix({
        eventRuntime: { endpoint: runtime.endpoint },
        fixtures: routeHarnessContractFixtures(),
        manifest,
        server: 'harness',
        session: packedSession,
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AgentTestError);
      expect((error as AgentTestError).message).toContain('runtime-instance-identity');
      expect((error as AgentTestError).message).toContain('runtime-instance-a');
      expect((error as AgentTestError).message).toContain('runtime-instance-b');
    } finally {
      await session.close();
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('does not require identity from a generated server that does not own the event runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-contract-non-owner-'));
    const compiledManifest = await compileTestManifest({ root: fixtureRoot });
    const manifest = Object.freeze({
      ...compiledManifest,
      apps: Object.freeze({}),
      eventRuntimeServerId: 'mcp:not-harness',
      routes: Object.freeze(Object.fromEntries(
        Object.entries(compiledManifest.routes).filter(([, route]) => route.kind !== 'app'),
      )),
    });
    const session = await openInMemoryMcpServer({
      manifest,
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    });
    const packedSession: PackedMcpSession = Object.freeze({
      client: session.client,
      close: session.close,
      provenance: Object.freeze({
        entry: 'in-memory non-owning-server regression fixture',
        pid: undefined,
        proofLevel: 'packed-stdio' as const,
      }),
      stderr: () => '',
      [Symbol.asyncDispose]: session[Symbol.asyncDispose],
    });
    try {
      const report = await runPackedContractMatrix({
        eventRuntime: { endpoint: join(root, 'must-not-be-read.sock') },
        fixtures: routeHarnessContractFixtures(),
        manifest,
        server: 'harness',
        session: packedSession,
      });

      expect(report.checks['runtime-instance-identity']).toEqual({
        reason: 'compiled server "mcp:harness" does not own the event runtime; owner is "mcp:not-harness".',
        status: 'not-applicable',
      });
    } finally {
      await session.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('reads one warm runtime identity across installed-host matrix events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-installed-identity-'));
    const runtime = await createEventRuntimeServer({
      artifactEpoch: 'route-harness@1.0.0',
      endpointId: `installed-contract-matrix:${root}`,
      handle: async () => undefined,
      status: () => ({
        artifactEpoch: 'route-harness@1.0.0',
        availability: 'available',
        instanceId: 'installed-runtime-instance-a',
        pid: process.pid,
      }),
    });
    const compiledManifest = await compileTestManifest({ root: fixtureRoot });
    const manifest = Object.freeze({
      ...compiledManifest,
      apps: Object.freeze({}),
      routes: Object.freeze(Object.fromEntries(
        Object.entries(compiledManifest.routes).filter(([, route]) => route.kind !== 'app'),
      )),
    });
    const session = await openInMemoryMcpServer({
      manifest,
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    });
    const checks = Object.freeze({
      'component-paths': Object.freeze({ status: 'passed' as const }),
      'hook-commands': Object.freeze({ status: 'passed' as const }),
      'manifest-schema': Object.freeze({ status: 'passed' as const }),
      'mcp-command': Object.freeze({ status: 'passed' as const }),
      resources: Object.freeze({ status: 'passed' as const }),
      'version-digests': Object.freeze({ status: 'passed' as const }),
      'version-quadruple': Object.freeze({ status: 'passed' as const }),
    });
    const installedSession: InstalledHostMcpSession = Object.freeze({
      client: session.client,
      close: session.close,
      eventRuntimeEndpoint: runtime.endpoint,
      observation: Object.freeze({
        checks,
        host: 'claude' as const,
        metadata: Object.freeze({
          adapterRevision: 'test',
          frameworkVersion: '0.1.0',
          hostBinaryVersion: Object.freeze({ reason: 'test fixture', status: 'unavailable' as const }),
          manifestSchemaDigest: '0'.repeat(64),
        }),
        proofLevel: 'host-install test fixture',
        sessionEvidence: 'installed-host runtime-identity regression fixture',
        versions: Object.freeze({
          builtArtifact: '1.0.0',
          installedArtifact: '1.0.0',
          runningProcess: '1.0.0',
          source: '1.0.0',
        }),
      }),
      provenance: Object.freeze({
        entry: 'mcp/harness.mjs',
        host: 'claude' as const,
        pid: process.pid,
        proofLevel: 'host-install' as const,
      }),
      stderr: () => '',
      [Symbol.asyncDispose]: session[Symbol.asyncDispose],
    });
    try {
      const report = await runInstalledHostContractMatrix({
        fixtures: routeHarnessContractFixtures(),
        manifest,
        server: 'harness',
        session: installedSession,
      });

      expect(report.matrix.checks['runtime-instance-identity']).toEqual({ status: 'passed' });
      expect(report.matrix.routes['tool:harness/lifecycle']?.checks['state-catalog']).toEqual({
        status: 'passed',
      });
    } finally {
      await session.close();
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it('aggregates missing route coverage with the proof-level label', async () => {
    const fixtures = { ...routeHarnessContractFixtures() };
    delete fixtures['tool:harness/echo'];

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/echo');
    expect((error as AgentTestError).message).toContain('coverage');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates unknown fixture keys with the proof-level label', async () => {
    const fixtures = {
      ...routeHarnessContractFixtures(),
      'tool:harness/missing-route': { input: {} },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/missing-route');
    expect((error as AgentTestError).message).toContain('coverage');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates additive declared on a closed schema with the proof-level label', async () => {
    const fixtures = {
      ...routeHarnessContractFixtures(),
      'tool:harness/strict-report': { input: {}, resultCompat: 'additive' as const },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/strict-report');
    expect((error as AgentTestError).message).toContain('compat-probe');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates closed declared on an additive schema with the proof-level label', async () => {
    const fixtures = {
      ...routeHarnessContractFixtures(),
      'tool:harness/ticket': { input: { status: 'completed' }, resultCompat: 'closed' as const },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/ticket');
    expect((error as AgentTestError).message).toContain('compat-probe');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates previousResults schema violations with the proof-level label', async () => {
    const fixtures = {
      ...routeHarnessContractFixtures(),
      'tool:harness/ticket': {
        input: { status: 'completed' },
        previousResults: [{ status: 'not-a-valid-status' }],
        resultCompat: 'additive' as const,
      },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/ticket');
    expect((error as AgentTestError).message).toContain('version-skew');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('auto-covers a compiled app route at the packed level without a fixture entry', async () => {
    const fixtures = routeHarnessContractFixtures();
    expect(fixtures['app:harness/panel']).toBeUndefined();

    const report = await withPackedShapedSession(
      { decorate: withAppSurface, entry: 'in-memory app auto-coverage fixture', includeApps: true },
      (session, manifest) => runPackedContractMatrix({ fixtures, manifest, server: 'harness', session }),
    );

    expect(report.provenance.proofLevel).toBe('packed-stdio');
    expect(report.routes['app:harness/panel']?.checks).toMatchObject({
      coverage: { reason: expect.stringContaining('auto-covered'), status: 'passed' },
      'surface-completeness': { status: 'passed' },
      sweep: { status: 'passed' },
    });
    expect(report.routes['app:harness/panel']?.checks.cancellation).toEqual({
      reason: 'applies to tool routes only.',
      status: 'not-applicable',
    });
  }, 30_000);

  it('accepts an explicit { kind: "resource" } fixture for app and resource routes at the packed level', async () => {
    const fixtures = {
      ...routeHarnessContractFixtures(),
      'app:harness/panel': { kind: 'resource' as const },
      'resource:harness/notes': { kind: 'resource' as const },
    };

    const report = await withPackedShapedSession(
      { decorate: withAppSurface, entry: 'in-memory explicit resource fixture', includeApps: true },
      (session, manifest) => runPackedContractMatrix({
        apps: 'explicit',
        fixtures,
        manifest,
        server: 'harness',
        session,
      }),
    );

    expect(report.routes['app:harness/panel']?.checks).toMatchObject({
      coverage: { status: 'passed' },
      'surface-completeness': { status: 'passed' },
      sweep: { status: 'passed' },
    });
    expect(report.routes['resource:harness/notes']?.checks).toMatchObject({
      coverage: { status: 'passed' },
      sweep: { status: 'passed' },
    });
  }, 30_000);

  it('records a rejected auto-covered app read as a sweep failure inside the aggregated violation', async () => {
    const error = await withPackedShapedSession(
      { decorate: withRejectingAppSurface, entry: 'in-memory rejecting app read fixture', includeApps: true },
      (session, manifest) => runPackedContractMatrix({
        fixtures: routeHarnessContractFixtures(),
        manifest,
        server: 'harness',
        session,
      }).catch((thrown: unknown) => thrown),
    );

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('app:harness/panel / sweep');
    expect((error as AgentTestError).message).toContain('readResource threw for "ui://harness/panel"');
    expect((error as AgentTestError).message).toContain('panel resource handler exploded');
  }, 30_000);

  it('requires an app fixture entry only when apps: "explicit" is requested', async () => {
    const error = await withPackedShapedSession(
      { decorate: withAppSurface, entry: 'in-memory explicit app coverage fixture', includeApps: true },
      (session, manifest) => runPackedContractMatrix({
        apps: 'explicit',
        fixtures: routeHarnessContractFixtures(),
        manifest,
        server: 'harness',
        session,
      }).catch((thrown: unknown) => thrown),
    );

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('app:harness/panel / coverage');
    expect((error as AgentTestError).message).toContain('apps: "explicit"');
    expect((error as AgentTestError).message).toContain(proofLevelLabel('packed-stdio'));
  }, 30_000);

  it('keeps app routes not-applicable at mcp-in-memory regardless of app fixtures', async () => {
    const report = await withStatefulMatrix({
      ...routeHarnessContractFixtures(),
      'app:harness/panel': { kind: 'resource' as const },
      'resource:harness/notes': { kind: 'resource' as const },
    }, (options) => runContractMatrix({ ...options, apps: 'explicit' }));

    expect(report.routes['app:harness/panel']?.checks).toEqual({
      'surface-completeness': {
        reason: 'MCP Apps are not registered by the in-memory projection level.',
        status: 'not-applicable',
      },
    });
    expect(report.routes['resource:harness/notes']?.checks).toMatchObject({
      coverage: { status: 'passed' },
      sweep: { status: 'passed' },
    });
  }, 30_000);

  it('rejects a { kind: "resource" } fixture declared for a tool route', async () => {
    const error = await withStatefulMatrix({
      ...routeHarnessContractFixtures(),
      'tool:harness/echo': { kind: 'resource' as const },
    }, (options) => runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/echo / coverage');
    expect((error as AgentTestError).message).toContain('resource fixtures apply to resource and app routes only');
  }, 30_000);

  it('reports cancellation as not-applicable when the invocation settles before the abort fires', async () => {
    const report = await withStatefulMatrix({
      ...routeHarnessContractFixtures(),
      'tool:harness/wait': {
        cancellation: { abortAfterMs: 1_500, input: { holdMs: 1 } },
        input: { holdMs: 1 },
        resultCompat: 'additive' as const,
      },
    }, (options) => runContractMatrix(options));

    expect(report.routes['tool:harness/wait']?.checks.cancellation).toEqual({
      reason: expect.stringContaining('invocation completed before abort; use an input that stays in flight'),
      status: 'not-applicable',
    });
  }, 30_000);

  it('fails cancellation when the abort is delivered in flight and the call still settles without rejecting', async () => {
    const error = await withPackedShapedSession(
      { decorate: ignoringAbortFor('wait'), entry: 'in-memory abort-ignoring fixture', includeApps: false },
      (session, manifest) => runPackedContractMatrix({
        fixtures: {
          ...routeHarnessContractFixtures(),
          'tool:harness/wait': {
            cancellation: { abortAfterMs: 50, input: { holdMs: 400 } },
            input: { holdMs: 1 },
            resultCompat: 'additive' as const,
          },
        },
        manifest,
        server: 'harness',
        session,
      }).catch((thrown: unknown) => thrown),
    );

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/wait / cancellation');
    expect((error as AgentTestError).message).toContain('aborted callTool settled without throwing or rejecting');
  }, 30_000);

  it('aggregates missing resultCompat on a tool with the proof-level label', async () => {
    const fixtures = {
      ...routeHarnessContractFixtures(),
      'tool:harness/echo': { input: { message: 'no policy' } },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/echo');
    expect((error as AgentTestError).message).toContain('compat-probe');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);
});
