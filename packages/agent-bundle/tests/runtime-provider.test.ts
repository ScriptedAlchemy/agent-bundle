import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  DevRuntimeController,
  DevRuntimeGenerationConflictError,
  RuntimeMcpRegistry,
  DevRuntimeUnavailableError,
  type DevRuntimeControllerOptions,
  type DevRuntimeProvider,
  type DevRuntimePreparedProject,
  type DevRuntimeSession,
  type DevRuntimeMcpSessionBinding,
  type DevRuntimeMcpRegistry,
  type DevRuntimeRun,
  type DevRuntimeSurface,
} from '../src/dev/index.ts';
import {
  DevRuntimeProviderLoadError,
  resolveDevRuntimeProvider,
} from '../src/dev/runtime-provider-loader.ts';

const createProviderFixture = async (): Promise<{
  readonly provider: string;
  readonly root: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-provider-'));
  const provider = join(root, 'src', 'dev', 'provider.ts');
  await mkdir(join(root, 'src', 'dev'), { recursive: true });
  await writeFile(provider, [
    "export const createDevRuntimeProvider = () => ({",
    "  descriptor: { environmentVariables: ['RUNTIME_TOKEN'], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },",
    '  start: async () => ({}),',
    '});',
    '',
  ].join('\n'));
  return { provider, root };
};

const fixtureProvider = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  descriptor: {
    environmentVariables: ['RUNTIME_TOKEN'],
    id: 'fixture-runtime',
    label: 'Fixture runtime',
    schemaVersion: 1,
    ...(overrides.descriptor as Record<string, unknown> | undefined),
  },
  start: async () => ({}),
  ...overrides,
});

const vector = {
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'fixture-a',
  stateVersion: 1,
} as const;

const surface = {
  defaultTarget: 'claude',
  fixtures: [{ id: 'after-edit', label: 'After file edit' }],
  id: 'hook.after-edit',
  kind: 'hook',
  label: 'After file edit',
  readOnly: false,
  targets: ['claude', 'codex'],
} satisfies DevRuntimeSurface;

const binding = {
  definitionDigest: 'definition-a',
  providerSessionId: 'provider-a',
  registryRevision: 3,
  serverDigest: 'server-a',
  serverName: 'timeline',
  sessionId: 'mcp-a',
  sessionRevision: 2,
  stateStoreId: 'fixture-a',
  target: 'portable',
  transportDigest: 'transport-a',
} satisfies DevRuntimeMcpSessionBinding;

const run = {
  completedAt: '2026-08-15T00:00:01.000Z',
  id: 'run-a',
  input: { file: 'notes.md' },
  result: {
    agentVisible: { message: 'updated' },
    state: { identity: { stateStoreId: 'fixture-a', stateVersion: 1 } },
    trace: [],
    tree: [],
  },
  startedAt: '2026-08-15T00:00:00.000Z',
  status: 'succeeded',
  surfaceId: 'hook.after-edit',
  target: 'claude',
  vector,
} satisfies DevRuntimeRun;

const reactLikeNode = {
  $$typeof: Symbol.for('react.element'),
  props: {},
  type: 'div',
};

const invalidReactRun = {
  ...run,
  result: {
    ...run.result,
    agentVisible: reactLikeNode,
  },
};

// @ts-expect-error Runtime result values are JSON only and cannot carry React elements.
const jsonOnlyRun: DevRuntimeRun = invalidReactRun;

const targetlessSurface = {
  fixtures: [],
  id: 'hook.before-tool',
  kind: 'hook',
  label: 'Before tool',
  readOnly: true,
} satisfies Omit<DevRuntimeSurface, 'targets'>;

// @ts-expect-error Every browser surface must explicitly declare its supported targets.
const targetfulSurface: DevRuntimeSurface = targetlessSurface;

const incompleteBinding = {
  providerSessionId: 'provider-a',
  serverName: 'timeline',
  sessionId: 'mcp-a',
  stateStoreId: 'fixture-a',
  target: 'portable',
} satisfies Pick<
  DevRuntimeMcpSessionBinding,
  'providerSessionId' | 'serverName' | 'sessionId' | 'stateStoreId' | 'target'
>;

// @ts-expect-error Stable MCP bindings include registry/session revisions and all three digests.
const completeBinding: DevRuntimeMcpSessionBinding = incompleteBinding;

it('publishes JSON-safe runtime run, surface, and stable MCP binding contracts', () => {
  expect(surface.targets).toEqual(['claude', 'codex']);
  expect(binding.sessionRevision).toBe(2);
  expect(run.status).toBe('succeeded');
  expect(invalidReactRun).toBeDefined();
  expect(jsonOnlyRun).toBeDefined();
  expect(targetlessSurface).toBeDefined();
  expect(targetfulSurface).toBeDefined();
  expect(incompleteBinding).toBeDefined();
  expect(completeBinding).toBeDefined();
});

it('uses stable errors for unavailable and stale runtime generations', () => {
  const unavailable = new DevRuntimeUnavailableError();
  const conflict = new DevRuntimeGenerationConflictError('expected-generation', 'actual-generation');

  expect(unavailable).toMatchObject({
    code: 'AB8201',
    message: 'Development runtime is not available.',
    name: 'DevRuntimeUnavailableError',
  });
  expect(conflict).toMatchObject({
    actualGenerationId: 'actual-generation',
    code: 'AB8204',
    expectedGenerationId: 'expected-generation',
    name: 'DevRuntimeGenerationConflictError',
  });
});

it('starts one provider from the trusted prepared snapshot with only declared environment values', async () => {
  const events: unknown[] = [];
  const session = {
    close: async () => undefined,
    mcpRegistry: {},
    providerSessionId: 'upstream-provider-session',
    status: () => ({
      descriptor: { environmentVariables: ['RUNTIME_TOKEN'], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      diagnostics: [],
      hmrReady: true,
      state: 'active',
    }),
  } as unknown as DevRuntimeSession;
  let received: Parameters<DevRuntimeProvider['start']>[0] | undefined;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => events.push(event),
    environment: { RUNTIME_TOKEN: 'allowed', UNDECLARED_SECRET: 'must-not-pass' },
    preparedRuntime: {
      apps: [],
      provider: './src/dev/provider.ts',
      servers: [],
      sourceRevision: 'source-1',
    },
    projectRoot: '/workspace/project',
    provider: {
      descriptor: { environmentVariables: ['RUNTIME_TOKEN'], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      start: async (context) => {
        received = context;
        return session;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();

  expect(received).toMatchObject({
    environment: { RUNTIME_TOKEN: 'allowed' },
    preparedRuntime: { sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    storageRoot: expect.stringMatching(/^\/workspace\/project\/\.agent-bundle\/runtime\//u),
  });
  expect(received?.environment).not.toHaveProperty('UNDECLARED_SECRET');
  expect(controller.providerSessionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(controller.status()).toMatchObject({ hmrReady: true, state: 'active' });
  expect(events).toEqual([]);
  await controller.close();
});

it('refreshes controller endpoint snapshots before publishing a later runtime activation', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  let activated = false;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  const observedEvents: Array<Readonly<{ readonly state: string; readonly surfaceCount: number; readonly type: string }>> = [];
  const endpoint = {
    entryPath: '/',
    httpOrigin: 'http://127.0.0.1:43111',
    httpPathPrefixes: ['/'],
    surfaceId: surface.id,
    webSocketOrigin: 'ws://127.0.0.1:43111',
    webSocketPath: '/rsbuild-hmr' as const,
    webSocketToken: 'rsbuild-token-1234',
  };
  const session = {
    clientSurface: () => activated ? endpoint : undefined,
    close: async () => undefined,
    mcpRegistry: {},
    reconcilePreparedRuntime: async () => undefined,
    status: () => activated
      ? { activeVector: vector, descriptor, diagnostics: [], hmrReady: true, lastGoodVector: vector, state: 'active' as const }
      : { descriptor, diagnostics: [], hmrReady: false, state: 'compiling' as const },
    surfaces: () => activated ? [surface] : [],
  } as unknown as DevRuntimeSession;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => {
      observedEvents.push({ state: controller.status().state, surfaceCount: controller.surfaces().length, type: event.type });
    },
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        emit = context.emit;
        return session;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  expect(controller.status()).toMatchObject({ hmrReady: false, state: 'compiling' });
  expect(controller.status()).not.toHaveProperty('activeVector');
  expect(controller.surfaces()).toEqual([]);
  expect(controller.clientSurface(surface.id)).toBeUndefined();

  activated = true;
  emit?.({ runtimeGenerationId: vector.runtimeGenerationId, type: 'runtime.generation.activated' });

  expect(controller.status()).toMatchObject({
    activeVector: vector,
    hmrReady: true,
    lastGoodVector: vector,
    state: 'active',
  });
  expect(controller.surfaces()).toEqual([surface]);
  expect(Object.isFrozen(controller.status())).toBe(true);
  expect(Object.isFrozen(controller.surfaces())).toBe(true);
  expect(controller.clientSurface(surface.id)).toEqual(endpoint);
  expect(observedEvents).toEqual([{ state: 'active', surfaceCount: 1, type: 'runtime.generation.activated' }]);

  await controller.close();
  emit?.({ runtimeGenerationId: vector.runtimeGenerationId, type: 'runtime.generation.activated' });
  expect(controller.status()).toMatchObject({ state: 'closed' });
});

it('refreshes authoritative failed and status snapshots before forwarding their runtime events', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const sourceBuildDiagnostic = {
    code: 'AB8206',
    message: 'RSC runtime source build failed.',
    phase: 'source/build' as const,
    severity: 'error' as const,
  };
  let failed = false;
  let malformed = false;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  const observed: Array<Readonly<{
    readonly diagnostics: readonly Readonly<{ readonly code: string; readonly phase: string }> [];
    readonly surfaceCount: number;
    readonly type: string;
  }>> = [];
  const session = {
    close: async () => undefined,
    mcpRegistry: {},
    reconcilePreparedRuntime: async () => undefined,
    status: () => malformed
      ? { activeVector: { runtimeGenerationId: 7 }, descriptor, diagnostics: [], hmrReady: true, state: 'active' as const }
      : {
          activeVector: vector,
          descriptor,
          diagnostics: failed ? [sourceBuildDiagnostic] : [],
          hmrReady: true,
          lastGoodVector: vector,
          state: 'active' as const,
        },
    surfaces: () => [surface],
  } as unknown as DevRuntimeSession;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => {
      observed.push({
        diagnostics: controller.status().diagnostics.map((diagnostic) => ({ code: diagnostic.code, phase: diagnostic.phase })),
        surfaceCount: controller.surfaces().length,
        type: event.type,
      });
    },
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        emit = context.emit;
        return session;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  expect(controller.status()).toMatchObject({ activeVector: vector, diagnostics: [], state: 'active' });
  expect(controller.surfaces()).toEqual([surface]);

  failed = true;
  emit?.({ type: 'runtime.generation.failed' });
  expect(observed.at(-1)).toEqual({
    diagnostics: [{ code: 'AB8206', phase: 'source/build' }],
    surfaceCount: 1,
    type: 'runtime.generation.failed',
  });
  expect(controller.status()).toMatchObject({ activeVector: vector, lastGoodVector: vector, state: 'active' });
  expect(Object.isFrozen(controller.status().diagnostics[0])).toBe(true);

  failed = false;
  emit?.({ type: 'runtime.status' });
  expect(observed.at(-1)).toEqual({ diagnostics: [], surfaceCount: 1, type: 'runtime.status' });

  malformed = true;
  emit?.({ type: 'runtime.generation.failed' });
  expect(controller.status()).toMatchObject({
    activeVector: vector,
    diagnostics: [{ code: 'AB8200', phase: 'provider-lifecycle' }],
    lastGoodVector: vector,
    state: 'degraded',
  });
  expect(observed.slice(-2).map((event) => event.type)).toEqual(['runtime.status', 'runtime.generation.failed']);
  await controller.close();
});

it('refreshes terminal run snapshots before completed or failed events without refreshing started runs', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  let stateVersion = 0;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  const observed: Array<Readonly<{ readonly stateVersion: number | undefined; readonly type: string }>> = [];
  const session = {
    close: async () => undefined,
    mcpRegistry: {},
    reconcilePreparedRuntime: async () => undefined,
    status: () => {
      const current = Object.freeze({ ...vector, stateVersion });
      return Object.freeze({
        activeVector: current,
        descriptor,
        diagnostics: Object.freeze([]),
        hmrReady: true,
        lastGoodVector: current,
        state: 'active' as const,
      });
    },
    surfaces: () => [surface],
  } as unknown as DevRuntimeSession;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => {
      observed.push(Object.freeze({
        stateVersion: controller.status().activeVector?.stateVersion,
        type: event.type,
      }));
    },
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        emit = context.emit;
        return session;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  expect(controller.status().activeVector?.stateVersion).toBe(0);

  stateVersion = 1;
  emit?.({ runId: 'completed-after-mutation', type: 'runtime.run.completed' });
  expect(observed.at(-1)).toEqual({ stateVersion: 1, type: 'runtime.run.completed' });
  expect(controller.status().activeVector?.stateVersion).toBe(1);

  stateVersion = 2;
  emit?.({ runId: 'failed-after-mutation', type: 'runtime.run.failed' });
  expect(observed.at(-1)).toEqual({ stateVersion: 2, type: 'runtime.run.failed' });
  expect(controller.status().activeVector?.stateVersion).toBe(2);

  stateVersion = 3;
  emit?.({ runId: 'started-without-mutation', type: 'runtime.run.started' });
  expect(observed.at(-1)).toEqual({ stateVersion: 2, type: 'runtime.run.started' });
  expect(controller.status().activeVector?.stateVersion).toBe(2);
  await controller.close();
});

it('does not overwrite a controller-owned lifecycle failure while publishing its status event', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async () => ({
        close: async () => undefined,
        mcpRegistry: {},
        reconcilePreparedRuntime: async () => { throw new Error('Reconcile failed.'); },
        status: () => ({ activeVector: vector, descriptor, diagnostics: [], hmrReady: true, lastGoodVector: vector, state: 'active' as const }),
        surfaces: () => [surface],
      } as unknown as DevRuntimeSession),
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  await controller.reconcileDeclaration({ apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-2' });

  expect(controller.status()).toMatchObject({
    activeVector: vector,
    diagnostics: [{ code: 'AB8200', phase: 'provider-lifecycle' }],
    lastGoodVector: vector,
    state: 'degraded',
  });
  await controller.close();
});

it('detaches and freezes complete activation status and surface snapshots', async () => {
  const mutableDescriptor = {
    environmentVariables: ['RUNTIME_TOKEN'],
    id: 'fixture-runtime',
    label: 'Fixture runtime',
    schemaVersion: 1 as const,
  };
  const mutableVector = { ...vector } as {
    providerSessionId: string;
    runtimeGenerationId: string;
    sourceRevision: string;
    stateStoreId: string;
    stateVersion: number;
  };
  const mutableDiagnostic = {
    code: 'AB9000',
    message: 'Runtime compiled.',
    phase: 'source/build' as const,
    severity: 'info' as const,
  };
  const mutableSurface = {
    ...surface,
    fixtures: [{ id: 'after-edit', label: 'After file edit', seed: { nested: ['initial'] } }],
    inputSchema: { properties: { title: { type: 'string' } }, type: 'object' },
    targets: ['claude', 'codex'],
  } satisfies DevRuntimeSurface;
  let activated = false;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor: mutableDescriptor,
      start: async (context) => {
        emit = context.emit;
        return {
          close: async () => undefined,
          mcpRegistry: {},
          reconcilePreparedRuntime: async () => undefined,
          status: () => activated
            ? {
                activeVector: mutableVector,
                descriptor: mutableDescriptor,
                diagnostics: [mutableDiagnostic],
                hmrReady: true,
                lastGoodVector: mutableVector,
                state: 'active' as const,
              }
            : { descriptor: mutableDescriptor, diagnostics: [], hmrReady: false, state: 'compiling' as const },
          surfaces: () => activated ? [mutableSurface] : [],
        } as unknown as DevRuntimeSession;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  activated = true;
  emit?.({ type: 'runtime.generation.activated' });

  mutableDescriptor.environmentVariables[0] = 'MUTATED_TOKEN';
  mutableVector.runtimeGenerationId = 'mutated-generation';
  mutableDiagnostic.message = 'Mutated diagnostic.';
  mutableSurface.targets[0] = 'mutated-target';
  mutableSurface.fixtures[0].label = 'Mutated fixture.';
  (mutableSurface.fixtures[0].seed as { nested: string[] }).nested[0] = 'mutated';
  ((mutableSurface.inputSchema as { properties: { title: { type: string } } }).properties.title).type = 'number';

  const status = controller.status();
  const snapshot = controller.surfaces()[0];
  expect(status).toMatchObject({
    activeVector: vector,
    descriptor: { environmentVariables: ['RUNTIME_TOKEN'] },
    diagnostics: [{ message: 'Runtime compiled.' }],
  });
  expect(snapshot).toMatchObject({
    fixtures: [{ label: 'After file edit', seed: { nested: ['initial'] } }],
    inputSchema: { properties: { title: { type: 'string' } } },
    targets: ['claude', 'codex'],
  });
  expect(Object.isFrozen(status.activeVector)).toBe(true);
  expect(Object.isFrozen(status.descriptor.environmentVariables)).toBe(true);
  expect(Object.isFrozen(status.diagnostics[0])).toBe(true);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.targets)).toBe(true);
  expect(Object.isFrozen(snapshot.fixtures[0].seed)).toBe(true);
  expect(Object.isFrozen(snapshot.inputSchema)).toBe(true);
  await controller.close();
});

it('degrades instead of publishing malformed activation snapshots', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const cyclicSchema: Record<string, unknown> = { type: 'object' };
  cyclicSchema.self = cyclicSchema;
  const malformed = [
    {
      name: 'partial vector',
      status: { activeVector: { runtimeGenerationId: 7 }, descriptor, diagnostics: [], hmrReady: true, state: 'active' },
      surfaces: [],
    },
    {
      name: 'malformed surface',
      status: { activeVector: vector, descriptor, diagnostics: [], hmrReady: true, state: 'active' },
      surfaces: [{}],
    },
    {
      name: 'cyclic schema',
      status: { activeVector: vector, descriptor, diagnostics: [], hmrReady: true, state: 'active' },
      surfaces: [{ ...surface, inputSchema: cyclicSchema }],
    },
    {
      name: 'BigInt fixture seed',
      status: { activeVector: vector, descriptor, diagnostics: [], hmrReady: true, state: 'active' },
      surfaces: [{ ...surface, fixtures: [{ id: 'after-edit', label: 'After file edit', seed: 1n }] }],
    },
  ] as const;

  for (const invalid of malformed) {
    let activated = false;
    let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
    const published: string[] = [];
    const controller = new DevRuntimeController({
      artifactStatus: () => ({ state: 'missing' }),
      emit: (event) => { published.push(event.type); },
      environment: {},
      preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
      projectRoot: '/workspace/project',
      provider: {
        descriptor,
        start: async (context) => {
          emit = context.emit;
          return {
            close: async () => undefined,
            mcpRegistry: {},
            reconcilePreparedRuntime: async () => undefined,
            status: () => activated
              ? invalid.status
              : { descriptor, diagnostics: [], hmrReady: false, state: 'compiling' as const },
            surfaces: () => activated ? invalid.surfaces : [],
          } as unknown as DevRuntimeSession;
        },
      },
      storageRoot: '/workspace/project/.agent-bundle/runtime',
    });

    await controller.start();
    activated = true;
    emit?.({ type: 'runtime.generation.activated' });

    expect(controller.status(), invalid.name).toMatchObject({
      diagnostics: [{ code: 'AB8200', phase: 'provider-lifecycle' }],
      state: 'degraded',
    });
    expect(controller.surfaces(), invalid.name).toEqual([]);
    expect(published, invalid.name).toEqual(['runtime.status', 'runtime.generation.activated']);
    await controller.close();
  }
});

it('accepts acyclic shared JSON fragments in activation snapshots', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const sharedSchema = { type: 'string' };
  const sharedSeed = { value: 'shared' };
  let activated = false;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        emit = context.emit;
        return {
          close: async () => undefined,
          mcpRegistry: {},
          reconcilePreparedRuntime: async () => undefined,
          status: () => activated
            ? { activeVector: vector, descriptor, diagnostics: [], hmrReady: true, state: 'active' as const }
            : { descriptor, diagnostics: [], hmrReady: false, state: 'compiling' as const },
          surfaces: () => activated
            ? [{
                ...surface,
                fixtures: [{ id: 'after-edit', label: 'After file edit', seed: { first: sharedSeed, second: sharedSeed } }],
                inputSchema: { properties: { first: sharedSchema, second: sharedSchema }, type: 'object' },
              }]
            : [],
        } as unknown as DevRuntimeSession;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  activated = true;
  emit?.({ type: 'runtime.generation.activated' });

  expect(controller.status()).toMatchObject({ state: 'active' });
  expect(controller.surfaces()).toMatchObject([{
    fixtures: [{ seed: { first: { value: 'shared' }, second: { value: 'shared' } } }],
    inputSchema: { properties: { first: { type: 'string' }, second: { type: 'string' } } },
  }]);
  await controller.close();
});

it('buffers synchronous startup failure and status until controller snapshots install', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const sourceBuildDiagnostic = {
    code: 'AB8206',
    message: 'RSC runtime source build failed.',
    phase: 'source/build' as const,
    severity: 'error' as const,
  };
  const seen: Array<Readonly<{
    readonly detail?: string;
    readonly diagnostics: readonly string[];
    readonly state: string;
    readonly surfaceCount: number;
    readonly type: string;
  }>> = [];
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => {
      seen.push({
        ...(typeof event.details?.sequence === 'string' ? { detail: event.details.sequence } : {}),
        diagnostics: controller.status().diagnostics.map((diagnostic) => diagnostic.code),
        state: controller.status().state,
        surfaceCount: controller.surfaces().length,
        type: event.type,
      });
    },
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        context.emit(Object.freeze({ details: Object.freeze({ sequence: 'failed' }), type: 'runtime.generation.failed' }));
        context.emit(Object.freeze({ details: Object.freeze({ sequence: 'stale' }), type: 'runtime.status' }));
        context.emit(Object.freeze({ details: Object.freeze({ sequence: 'latest' }), type: 'runtime.status' }));
        return {
          close: async () => undefined,
          mcpRegistry: {},
          reconcilePreparedRuntime: async () => undefined,
          status: () => ({ descriptor, diagnostics: [sourceBuildDiagnostic], hmrReady: true, state: 'degraded' as const }),
          surfaces: () => [surface],
        } as unknown as DevRuntimeSession;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();

  expect(seen).toEqual([
    { detail: 'failed', diagnostics: ['AB8206'], state: 'degraded', surfaceCount: 1, type: 'runtime.generation.failed' },
    { detail: 'latest', diagnostics: ['AB8206'], state: 'degraded', surfaceCount: 1, type: 'runtime.status' },
  ]);
  await controller.close();
});

it('buffers synchronous startup activation until controller snapshots install', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const seen: Array<Readonly<{ readonly generation?: string; readonly state: string; readonly surfaceCount: number; readonly type: string }>> = [];
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => {
      seen.push({
        ...(event.runtimeGenerationId === undefined ? {} : { generation: event.runtimeGenerationId }),
        state: controller.status().state,
        surfaceCount: controller.surfaces().length,
        type: event.type,
      });
    },
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        context.emit({ type: 'runtime.generation.compiling' });
        context.emit({ runtimeGenerationId: 'superseded-generation', type: 'runtime.generation.activated' });
        context.emit({ runtimeGenerationId: vector.runtimeGenerationId, type: 'runtime.generation.activated' });
        return {
          close: async () => undefined,
          mcpRegistry: {},
          reconcilePreparedRuntime: async () => undefined,
          status: () => ({ activeVector: vector, descriptor, diagnostics: [], hmrReady: true, lastGoodVector: vector, state: 'active' as const }),
          surfaces: () => [surface],
        } as unknown as DevRuntimeSession;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();

  expect(seen).toEqual([
    { state: 'starting', surfaceCount: 0, type: 'runtime.generation.compiling' },
    { generation: vector.runtimeGenerationId, state: 'active', surfaceCount: 1, type: 'runtime.generation.activated' },
  ]);
  await controller.close();
});

it('drops buffered startup lifecycle events after close or topology failure', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const prepared = { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' } as const;
  for (const transition of ['close', 'topology'] as const) {
    let closeCalls = 0;
    let resolveSession: ((session: DevRuntimeSession) => void) | undefined;
    const pendingSession = new Promise<DevRuntimeSession>((resolvePromise) => { resolveSession = resolvePromise; });
    const published: string[] = [];
    const controller = new DevRuntimeController({
      artifactStatus: () => ({ state: 'missing' }),
      emit: (event) => { published.push(event.type); },
      environment: {},
      preparedRuntime: prepared,
      projectRoot: '/workspace/project',
      provider: {
        descriptor,
        start: async (context) => {
          context.emit({ type: 'runtime.generation.failed' });
          context.emit({ type: 'runtime.status' });
          context.emit({ runtimeGenerationId: vector.runtimeGenerationId, type: 'runtime.generation.activated' });
          return pendingSession;
        },
      },
      storageRoot: '/workspace/project/.agent-bundle/runtime',
    });
    const starting = controller.start();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const closing = transition === 'close'
      ? controller.close()
      : controller.reconcileDeclaration(undefined);
    resolveSession?.({
      close: async () => { closeCalls += 1; },
      mcpRegistry: {},
      reconcilePreparedRuntime: async () => undefined,
      status: () => ({ activeVector: vector, descriptor, diagnostics: [], hmrReady: true, state: 'active' }),
      surfaces: () => [surface],
    } as unknown as DevRuntimeSession);
    await starting;
    await closing;

    expect(published, transition).toEqual(['runtime.status']);
    expect(published, transition).not.toContain('runtime.generation.activated');
    expect(published, transition).not.toContain('runtime.generation.failed');
    expect(closeCalls, transition).toBe(1);
    if (transition === 'topology') await controller.close();
  }
});

it('sanitizes a failed activation refresh without recursively publishing runtime events', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const published: string[] = [];
  let activated = false;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: (event) => { published.push(event.type); },
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        emit = context.emit;
        return {
          close: async () => undefined,
          mcpRegistry: {},
          reconcilePreparedRuntime: async () => undefined,
          status: () => ({ descriptor, diagnostics: [], hmrReady: activated, state: activated ? 'active' as const : 'compiling' as const }),
          surfaces: () => {
            if (activated) throw new Error('Activation surface snapshot failed.');
            return [];
          },
        } as unknown as DevRuntimeSession;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  activated = true;
  emit?.({ type: 'runtime.generation.activated' });

  expect(controller.status()).toMatchObject({
    diagnostics: [{ phase: 'provider-lifecycle' }],
    state: 'degraded',
  });
  expect(published).toEqual(['runtime.status', 'runtime.generation.activated']);
  await controller.close();
});

it('aborts a timed-out provider start and closes a late session exactly once', async () => {
  let resolveLate: ((session: DevRuntimeSession) => void) | undefined;
  const late = new Promise<DevRuntimeSession>((resolvePromise) => { resolveLate = resolvePromise; });
  let context: Parameters<DevRuntimeProvider['start']>[0] | undefined;
  let closes = 0;
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      start: async (received) => {
        context = received;
        return late;
      },
    },
    startupTimeoutMs: 5,
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();

  expect(context?.signal.aborted).toBe(true);
  expect(controller.status()).toMatchObject({
    diagnostics: [{ phase: 'provider-lifecycle' }],
    state: 'failed',
  });
  resolveLate?.({ close: async () => { closes += 1; } } as unknown as DevRuntimeSession);
  await controller.close();
  expect(closes).toBe(1);
});

it('contains synchronous provider and malformed status failures as failed runtime state', async () => {
  const options: Omit<DevRuntimeControllerOptions, 'provider'> = {
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  } as const;
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const synchronousFailure = new DevRuntimeController({
    ...options,
    provider: { descriptor, start: () => { throw new Error('synchronous provider failure'); } },
  });
  const malformedStatus = new DevRuntimeController({
    ...options,
    provider: { descriptor, start: async () => ({ close: async () => undefined }) as unknown as DevRuntimeSession },
  });
  const throwingStatus = new DevRuntimeController({
    ...options,
    provider: {
      descriptor,
      start: async () => ({ close: async () => undefined, status: () => { throw new Error('status failure'); } }) as unknown as DevRuntimeSession,
    },
  });

  await expect(synchronousFailure.start()).resolves.toBeUndefined();
  await expect(malformedStatus.start()).resolves.toBeUndefined();
  await expect(throwingStatus.start()).resolves.toBeUndefined();
  for (const controller of [synchronousFailure, malformedStatus, throwingStatus]) {
    expect(controller.status()).toMatchObject({
      diagnostics: [{ phase: 'provider-lifecycle' }],
      state: 'failed',
    });
    await expect(controller.close()).resolves.toBeUndefined();
  }
});

it('reconciles the newest revision exactly once after a deferred provider start publishes its session', async () => {
  let resolveSession: ((session: DevRuntimeSession) => void) | undefined;
  const deferredSession = new Promise<DevRuntimeSession>((resolvePromise) => { resolveSession = resolvePromise; });
  const reconciled: string[] = [];
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      start: async () => deferredSession,
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });
  const starting = controller.start();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  await controller.reconcilePreparedRuntime({
    apps: [],
    provider: './src/dev/provider.ts',
    servers: [],
    sourceRevision: 'source-2',
  });
  resolveSession?.({
    close: async () => undefined,
    mcpRegistry: {},
    reconcilePreparedRuntime: async (prepared: DevRuntimePreparedProject) => { reconciled.push(prepared.sourceRevision); },
    status: () => ({ descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: 'active' }),
    surfaces: () => [],
  } as unknown as DevRuntimeSession);

  await starting;
  expect(reconciled).toEqual(['source-2']);
  await controller.close();
});

it('latches declaration topology failures and revokes registry capabilities captured while active', async () => {
  let executions = 0;
  const view = {
    execute: async () => { executions += 1; return {}; },
    snapshot: () => ({}),
    watchClosed: () => ({ closed: false, unsubscribe: () => undefined }),
  };
  const registry = {
    close: async () => undefined,
    closeSession: async () => undefined,
    open: async () => ({ ...view, close: async () => undefined }),
    reconcile: async () => ({}),
    restart: async () => ({}),
    session: () => view,
    snapshot: () => undefined,
    subscribe: () => ({ unsubscribe: () => undefined }),
  };
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      start: async () => ({
        close: async () => undefined,
        mcpRegistry: registry,
        status: () => ({ descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: 'active' }),
        surfaces: () => [],
      }) as unknown as DevRuntimeSession,
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });
  await controller.start();
  const capturedRegistry = controller.mcpRegistry;
  const capturedView = capturedRegistry.session('mcp-a');
  if (capturedView === undefined) throw new Error('Expected a captured runtime MCP view.');
  const capturedSession = await capturedRegistry.open({ serverName: 'timeline', target: 'portable' });
  await capturedView.execute({ expectedSessionRevision: 1, kind: 'list-tools' });
  expect(executions).toBe(1);

  await controller.reconcileDeclaration({
    apps: [],
    provider: './src/dev/replaced-provider.ts',
    servers: [],
    sourceRevision: 'source-2',
  });

  expect(controller.status()).toMatchObject({ state: 'failed' });
  await expect(capturedRegistry.open({ serverName: 'timeline', target: 'portable' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(capturedView.execute({ expectedSessionRevision: 1, kind: 'list-tools' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(capturedSession.close()).rejects.toMatchObject({ code: 'AB8201' });
  expect(() => capturedView.snapshot()).toThrow(DevRuntimeUnavailableError);
  await controller.close();
});

it('preserves private registry and session receivers through the stable MCP facade', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const prepared = { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' } as const;
  const status = () => ({ descriptor, diagnostics: [], hmrReady: true, state: 'active' as const });
  const controllerFor = (mcpRegistry: DevRuntimeMcpRegistry): DevRuntimeController => new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: prepared,
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async () => ({
        close: async () => undefined,
        mcpRegistry,
        status,
        surfaces: () => [],
      }) as unknown as DevRuntimeSession,
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });
  const actualRegistry = new RuntimeMcpRegistry({
    artifactEpochId: () => undefined,
    connector: { connect: async () => { throw new Error('Connection is not needed by this receiver test.'); } } as never,
    emit: () => undefined,
    executor: async () => ({}) as never,
    generationStore: {} as never,
    initialRegistry: { definitionDigest: 'definition-1', runtimeGenerationId: 'generation-1', servers: [], transportDigest: 'transport-1' },
    providerSessionId: 'provider-1',
    stateStoreId: 'state-1',
  });
  const actualController = controllerFor(actualRegistry);
  await actualController.start();
  expect(actualController.mcpRegistry.snapshot()).toMatchObject({
    providerSessionId: 'provider-1',
    registryRevision: 1,
  });
  await actualController.close();

  class PrivateSession {
    #closed = false;
    #executions = 0;

    async close(): Promise<void> {
      this.#closed = true;
    }

    async execute(): Promise<unknown> {
      if (this.#closed) throw new Error('Private MCP session is closed.');
      this.#executions += 1;
      return { executions: this.#executions };
    }

    snapshot(): unknown {
      return { closed: this.#closed, executions: this.#executions };
    }

    watchClosed(): unknown {
      return { closed: this.#closed, unsubscribe: () => undefined };
    }
  }

  class PrivateRegistry {
    #calls: string[] = [];
    #session = new PrivateSession();

    get calls(): readonly string[] {
      return this.#calls;
    }

    async close(): Promise<void> { this.#calls.push('close'); }
    async closeSession(): Promise<void> { this.#calls.push('closeSession'); }
    async open(): Promise<PrivateSession> { this.#calls.push('open'); return this.#session; }
    async reconcile(): Promise<unknown> { this.#calls.push('reconcile'); return {}; }
    async restart(): Promise<unknown> { this.#calls.push('restart'); return {}; }
    session(): PrivateSession { this.#calls.push('session'); return this.#session; }
    snapshot(): unknown { this.#calls.push('snapshot'); return { registry: 'private' }; }
    subscribe(): unknown { this.#calls.push('subscribe'); return { unsubscribe: () => undefined }; }
  }

  const privateRegistry = new PrivateRegistry();
  const controller = controllerFor(privateRegistry as unknown as DevRuntimeMcpRegistry);
  await controller.start();
  const facade = controller.mcpRegistry;
  expect(facade.snapshot()).toEqual({ registry: 'private' });
  expect(facade.subscribe({}, () => undefined)).toEqual({ unsubscribe: expect.any(Function) });
  const view = facade.session('class-session');
  if (view === undefined) throw new Error('Expected private MCP session view.');
  await expect(view.execute({ expectedSessionRevision: 1, kind: 'list-tools' })).resolves.toEqual({ executions: 1 });
  expect(view.snapshot()).toEqual({ closed: false, executions: 1 });
  expect(view.watchClosed(() => undefined)).toEqual({ closed: false, unsubscribe: expect.any(Function) });
  const opened = await facade.open({ serverName: 'timeline', target: 'portable' });
  await expect(opened.execute({ expectedSessionRevision: 1, kind: 'list-tools' })).resolves.toEqual({ executions: 2 });
  await expect(opened.close()).resolves.toBeUndefined();
  await expect(facade.closeSession({ expectedSessionRevision: 1, sessionId: 'class-session' })).resolves.toBeUndefined();
  await expect(facade.reconcile({ definitionDigest: 'definition-2', runtimeGenerationId: 'generation-2', servers: [], transportDigest: 'transport-2' })).resolves.toEqual({});
  await expect(facade.restart({ expectedSessionRevision: 1, sessionId: 'class-session' })).resolves.toEqual({});
  await expect(facade.close()).resolves.toBeUndefined();
  expect(privateRegistry.calls).toEqual([
    'snapshot',
    'subscribe',
    'session',
    'session',
    'session',
    'session',
    'open',
    'closeSession',
    'reconcile',
    'restart',
    'close',
  ]);

  await controller.reconcileDeclaration({ ...prepared, provider: './src/dev/replaced-provider.ts', sourceRevision: 'source-2' });
  await expect(facade.open({ serverName: 'timeline', target: 'portable' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(view.execute({ expectedSessionRevision: 1, kind: 'list-tools' })).rejects.toMatchObject({ code: 'AB8201' });
  await expect(opened.close()).rejects.toMatchObject({ code: 'AB8201' });
  await controller.close();
});

it('latches every topology failure across a pending runtime start', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const prepared = { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' } as const;
  const topologyChanges: readonly Readonly<{
    readonly apply: (controller: DevRuntimeController) => Promise<void>;
    readonly name: string;
  }>[] = [
    { apply: (controller) => controller.reconcileDeclaration(undefined), name: 'removal' },
    { apply: (controller) => controller.reconcileDeclaration({ ...prepared, sourceRevision: 'source-2' }, { code: 'AB8200' }), name: 'diagnostic' },
    { apply: (controller) => controller.reconcileDeclaration({ ...prepared, provider: './src/dev/replaced-provider.ts', sourceRevision: 'source-2' }), name: 'provider path' },
  ];

  for (const topology of topologyChanges) {
    let closeCalls = 0;
    let resolveSession: ((session: DevRuntimeSession) => void) | undefined;
    const pendingSession = new Promise<DevRuntimeSession>((resolvePromise) => { resolveSession = resolvePromise; });
    const controller = new DevRuntimeController({
      artifactStatus: () => ({ state: 'missing' }),
      emit: () => undefined,
      environment: {},
      preparedRuntime: prepared,
      projectRoot: '/workspace/project',
      provider: { descriptor, start: async () => pendingSession },
      storageRoot: '/workspace/project/.agent-bundle/runtime',
    });
    const starting = controller.start();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await topology.apply(controller);
    await controller.reconcilePreparedRuntime({ ...prepared, sourceRevision: 'source-3' });
    resolveSession?.({
      close: async () => { closeCalls += 1; },
      mcpRegistry: {},
      reconcilePreparedRuntime: async () => undefined,
      status: () => ({ descriptor, diagnostics: [], hmrReady: true, state: 'active' }),
      surfaces: () => [],
    } as unknown as DevRuntimeSession);
    await starting;

    expect(controller.status(), topology.name).toMatchObject({ state: 'failed' });
    await expect(controller.mcpRegistry.open({ serverName: 'timeline', target: 'portable' }), topology.name).rejects.toMatchObject({ code: 'AB8201' });
    await controller.close();
    expect(closeCalls, topology.name).toBe(1);
  }
});

it('retains a topology failure when it races an accepted runtime reconcile', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const prepared = { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' } as const;
  let closeCalls = 0;
  let emit: Parameters<DevRuntimeProvider['start']>[0]['emit'] | undefined;
  let resolveReconcile: (() => void) | undefined;
  const reconcileGate = new Promise<void>((resolvePromise) => { resolveReconcile = resolvePromise; });
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: prepared,
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async (context) => {
        emit = context.emit;
        return {
        close: async () => { closeCalls += 1; },
        mcpRegistry: {},
        reconcilePreparedRuntime: async () => reconcileGate,
        status: () => ({ descriptor, diagnostics: [], hmrReady: true, state: 'active' }),
        surfaces: () => [],
        } as unknown as DevRuntimeSession;
      },
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });
  await controller.start();
  const capturedRegistry = controller.mcpRegistry;
  const reconciling = controller.reconcilePreparedRuntime({ ...prepared, sourceRevision: 'source-2' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await controller.reconcileDeclaration(undefined);
  emit?.({ type: 'runtime.generation.activated' });
  resolveReconcile?.();
  await reconciling;

  expect(controller.status()).toMatchObject({ state: 'failed' });
  await expect(capturedRegistry.open({ serverName: 'timeline', target: 'portable' })).rejects.toMatchObject({ code: 'AB8201' });
  await controller.close();
  expect(closeCalls).toBe(1);
});

it('latches runtime removal and diagnostics as restart-required failures', async () => {
  const descriptor = { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 } as const;
  const prepared = { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' } as const;
  const controller = () => new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: prepared,
    projectRoot: '/workspace/project',
    provider: {
      descriptor,
      start: async () => ({
        close: async () => undefined,
        status: () => ({ descriptor, diagnostics: [], hmrReady: true, state: 'active' }),
        surfaces: () => [],
      }) as unknown as DevRuntimeSession,
    },
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });
  const removed = controller();
  await removed.start();
  await removed.reconcileDeclaration(undefined);
  expect(removed.status()).toMatchObject({
    diagnostics: [{ message: expect.stringContaining('restart required') }],
    state: 'failed',
  });

  const diagnosed = controller();
  await diagnosed.start();
  await diagnosed.reconcileDeclaration(prepared, { code: 'AB8200' });
  expect(diagnosed.status()).toMatchObject({
    diagnostics: [{ message: expect.stringContaining('restart required') }],
    state: 'failed',
  });
  await Promise.all([removed.close(), diagnosed.close()]);
});

it('observes a late provider close rejection and preserves it across a concurrent close race', async () => {
  let resolveSession: ((session: DevRuntimeSession) => void) | undefined;
  const deferredSession = new Promise<DevRuntimeSession>((resolvePromise) => { resolveSession = resolvePromise; });
  const closeFailure = new Error('Late provider close failed.');
  let closeCalls = 0;
  let lateClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolvePromise) => { lateClosed = resolvePromise; });
  const controller = new DevRuntimeController({
    artifactStatus: () => ({ state: 'missing' }),
    emit: () => undefined,
    environment: {},
    preparedRuntime: { apps: [], provider: './src/dev/provider.ts', servers: [], sourceRevision: 'source-1' },
    projectRoot: '/workspace/project',
    provider: {
      descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      start: async () => deferredSession,
    },
    startupTimeoutMs: 5,
    storageRoot: '/workspace/project/.agent-bundle/runtime',
  });

  await controller.start();
  const firstClose = controller.close();
  const secondClose = controller.close();
  resolveSession?.({ close: async () => { closeCalls += 1; lateClosed?.(); throw closeFailure; } } as unknown as DevRuntimeSession);
  await closed;

  expect(controller.status()).toMatchObject({ state: 'failed' });
  expect(closeCalls).toBe(1);
  await expect(firstClose).rejects.toBe(closeFailure);
  await expect(secondClose).rejects.toBe(closeFailure);
  expect(closeCalls).toBe(1);
});

it('loads one contained named runtime provider export with a frozen descriptor', async () => {
  const { root } = await createProviderFixture();
  let imports = 0;
  let factories = 0;
  try {
    const provider = await resolveDevRuntimeProvider(
      root,
      { provider: './src/dev/provider.ts' },
      async (path) => {
        imports += 1;
        expect(path).toBe(join(root, 'src', 'dev', 'provider.ts'));
        return {
          createDevRuntimeProvider: () => {
            factories += 1;
            return fixtureProvider();
          },
        };
      },
    );

    expect(imports).toBe(1);
    expect(factories).toBe(1);
    expect(provider.descriptor).toEqual({
      environmentVariables: ['RUNTIME_TOKEN'],
      id: 'fixture-runtime',
      label: 'Fixture runtime',
      schemaVersion: 1,
    });
    expect(Object.isFrozen(provider.descriptor)).toBe(true);
    expect(Object.isFrozen(provider.descriptor.environmentVariables)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects lexical, symlink, and directory provider escapes before importing', async () => {
  const { root } = await createProviderFixture();
  const outside = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-provider-outside-'));
  const linked = join(root, 'linked');
  let imports = 0;
  const importer = async () => {
    imports += 1;
    return { createDevRuntimeProvider: () => fixtureProvider() };
  };
  try {
    await symlink(outside, linked, 'dir');
    await expect(resolveDevRuntimeProvider(root, { provider: '../outside/provider.ts' }, importer))
      .rejects.toBeInstanceOf(DevRuntimeProviderLoadError);
    await expect(resolveDevRuntimeProvider(root, { provider: './linked/provider.ts' }, importer))
      .rejects.toMatchObject({ code: 'AB8200' });
    await expect(resolveDevRuntimeProvider(root, { provider: './src/dev' }, importer))
      .rejects.toMatchObject({ code: 'AB8200' });
    expect(imports).toBe(0);
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ]);
  }
});

it('rejects missing exports and malformed provider descriptors without leaking environment values', async () => {
  const { root } = await createProviderFixture();
  try {
    await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ({})))
      .rejects.toMatchObject({ code: 'AB8200' });
    await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ({
      createDevRuntimeProvider: () => fixtureProvider({
        descriptor: { environmentVariables: ['RUNTIME_TOKEN', 'RUNTIME_TOKEN'], id: '', label: '', schemaVersion: 2 },
      }),
    }))).rejects.toMatchObject({ code: 'AB8200' });
    const error = await resolveDevRuntimeProvider(
      root,
      { provider: './src/dev/provider.ts' },
      async () => ({
        createDevRuntimeProvider: () => fixtureProvider({
          descriptor: { environmentVariables: ['RUNTIME_TOKEN=must-not-leak'], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
        }),
      }),
    ).then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'AB8200' });
    expect((error as Error).message).not.toContain('must-not-leak');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('normalizes provider property accessor failures to the stable load error', async () => {
  const { root } = await createProviderFixture();
  try {
    await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ({
      createDevRuntimeProvider: () => Object.defineProperty({ start: async () => ({}) }, 'descriptor', {
        get: () => {
          throw new Error('provider descriptor accessor failed');
        },
      }),
    }))).rejects.toMatchObject({ code: 'AB8200' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains the factory provider as the start method receiver', async () => {
  const { root } = await createProviderFixture();
  try {
    class StatefulProvider {
      #starts = 0;

      readonly descriptor = {
        environmentVariables: [],
        id: 'stateful-runtime',
        label: 'Stateful runtime',
        schemaVersion: 1,
      } as const;

      async start(): Promise<number> {
        this.#starts += 1;
        return this.#starts;
      }
    }

    const candidate = new StatefulProvider();
    const provider = await resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ({
      createDevRuntimeProvider: () => candidate,
    }));

    await expect((provider.start as unknown as () => Promise<number>)()).resolves.toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('captures a named factory export only from an own data property', async () => {
  const { root } = await createProviderFixture();
  let factoryCalls = 0;
  let getterCalls = 0;
  const secret = 'provider-export-secret';
  try {
    const ownModule = {
      createDevRuntimeProvider: () => {
        factoryCalls += 1;
        return fixtureProvider();
      },
    };
    await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ownModule))
      .resolves.toMatchObject({ descriptor: { id: 'fixture-runtime' } });
    expect(factoryCalls).toBe(1);

    const accessorModule = Object.defineProperty({}, 'createDevRuntimeProvider', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error(secret);
      },
    });
    const accessorError = await resolveDevRuntimeProvider(
      root,
      { provider: './src/dev/provider.ts' },
      async () => accessorModule,
    ).then(() => undefined, (reason: unknown) => reason);
    expect(accessorError).toMatchObject({ code: 'AB8200' });
    expect((accessorError as Error).message).not.toContain(secret);
    expect(getterCalls).toBe(0);

    const inheritedModule = Object.create({ createDevRuntimeProvider: () => fixtureProvider() });
    await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => inheritedModule))
      .rejects.toMatchObject({ code: 'AB8200' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects sparse, accessor-backed, and extended descriptor environment lists without reading accessors', async () => {
  const { root } = await createProviderFixture();
  let getterCalls = 0;
  try {
    const sparse = ['RUNTIME_TOKEN'];
    sparse.length = 2;
    const extended = ['RUNTIME_TOKEN'];
    Object.defineProperty(extended, 'extra', { enumerable: true, value: 'unexpected' });
    const accessorBacked = ['RUNTIME_TOKEN'];
    Object.defineProperty(accessorBacked, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'RUNTIME_TOKEN';
      },
    });

    for (const environmentVariables of [sparse, extended, accessorBacked]) {
      await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ({
        createDevRuntimeProvider: () => fixtureProvider({
          descriptor: { environmentVariables, id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
        }),
      }))).rejects.toMatchObject({ code: 'AB8200' });
    }
    expect(getterCalls).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('snapshots a dense environment list without reading its indexed values or length', async () => {
  const { root } = await createProviderFixture();
  let lengthReads = 0;
  const environmentVariables = new Proxy(['RUNTIME_TOKEN'], {
    get: (target, key, receiver) => {
      if (key === 'length') {
        lengthReads += 1;
        throw new Error('environment-length-secret');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    const provider = await resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, async () => ({
      createDevRuntimeProvider: () => fixtureProvider({
        descriptor: { environmentVariables, id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },
      }),
    }));

    expect(provider.descriptor.environmentVariables).toEqual(['RUNTIME_TOKEN']);
    expect(lengthReads).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
