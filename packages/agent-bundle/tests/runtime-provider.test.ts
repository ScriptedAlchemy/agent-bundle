import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
  type DevRuntimeMcpSessionBinding,
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
