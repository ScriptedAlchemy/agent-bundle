import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';

import stateDefinition from '../../fixtures/route-harness/src/state.ts';
import { createEventRuntimeServer } from '../../src/events/ipc.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import {
  compileTestManifest,
  MCP_IN_MEMORY_PROOF_LEVEL,
  proofLevelLabel,
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
