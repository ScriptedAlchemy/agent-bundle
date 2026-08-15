import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import {
  ArtifactService,
  ProjectService,
} from '../../../packages/agent-bundle/src/dev/index.ts';
import { EpochStore } from '../../../packages/agent-bundle/src/dev/epoch-store.ts';
import { createDevRuntimeProvider } from '../src/dev/provider.js';

const exampleRoot = process.cwd();
const workspaceNodeModules = join(exampleRoot, '../../node_modules');

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the RSC runtime provider.');
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
};

interface CopiedExample {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
}

const copyExample = async (): Promise<CopiedExample> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-provider-'));
  const projectRoot = join(workspaceRoot, 'examples', 'rsc-agent-runtime');
  await cp(exampleRoot, projectRoot, {
    filter: (source) => !['.agent-bundle', 'dist', 'node_modules'].includes(source.split('/').at(-1) ?? ''),
    recursive: true,
  });
  await symlink(workspaceNodeModules, join(workspaceRoot, 'node_modules'), 'dir');
  await symlink(join(exampleRoot, '../../tsconfig.json'), join(workspaceRoot, 'tsconfig.json'));
  return Object.freeze({ projectRoot, workspaceRoot });
};

test('declares an optional runtime while keeping Claude and Codex artifacts buildable', async () => {
  const copied = await copyExample();
  try {
    const root = copied.projectRoot;
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root }).prepare('dev');

    expect(prepared.source.state).toBe('ready');
    expect(prepared.devRuntime).toMatchObject({
      apps: [expect.objectContaining({ name: 'timeline', resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' })],
      provider: './src/dev/provider.ts',
      servers: [expect.objectContaining({ name: 'timeline', transport: 'stdio' })],
    });
    expect(prepared.model?.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ targets: expect.arrayContaining(['claude', 'codex']) }),
    ]));

    const artifact = await new ArtifactService({ epochStore: new EpochStore({ projectRoot: root }) }).build(prepared);
    if (artifact.outcome !== 'succeeded') throw new Error(JSON.stringify(artifact.diagnostics));
    expect(artifact).toMatchObject({ outcome: 'succeeded' });
    const provider = createDevRuntimeProvider();
    expect(provider.descriptor).toEqual({
      environmentVariables: [],
      id: 'rsc-agent-runtime',
      label: 'RSC agent runtime',
      schemaVersion: 1,
    });
    const session = await provider.start({
      artifactStatus: () => Object.freeze({ state: 'missing' as const }),
      emit: () => undefined,
      environment: Object.freeze({}),
      projectRoot: root,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-test',
      signal: new AbortController().signal,
      storageRoot: join(root, '.agent-bundle', 'runtime-test'),
    });
    try {
      await waitFor(() => session.status().state === 'active');
      expect(session.status()).toMatchObject({ hmrReady: true, state: 'active' });
      expect(session.clientSurface('mcp.edit-timeline')).toMatchObject({
        entryPath: '/edit-timeline-v1.html',
        httpPathPrefixes: ['/'],
        surfaceId: 'mcp.edit-timeline',
        webSocketOrigin: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/u),
        webSocketPath: '/rsbuild-hmr',
      });
      expect(session.status()).not.toHaveProperty('clientSurface');
      expect(session.surfaces()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'hook' }),
        expect.objectContaining({ id: 'mcp.render_edit_timeline', kind: 'mcp-tool' }),
        expect.objectContaining({ id: 'mcp.edit-timeline', kind: 'mcp-resource' }),
        expect.objectContaining({ id: 'mcp.timeline', kind: 'mcp-app' }),
      ]));
      const registry = session.mcpRegistry.snapshot();
      expect(registry).toMatchObject({ runtimeGenerationId: expect.any(String) });
      expect([...new Set([
        registry!.definitionDigest,
        registry!.servers[0]!.serverDigest,
        registry!.transportDigest,
      ])]).toHaveLength(3);

      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.timeline',
      })).resolves.toMatchObject({ contentType: 'text/html' });
      await expect(session.readAsset({
        path: ['..'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.timeline',
      })).resolves.toBeUndefined();
      await expect(session.readAsset({
        path: ['rsc', 'index.html'],
        runtimeGenerationId: registry!.runtimeGenerationId,
        surfaceId: 'mcp.unknown',
      })).resolves.toBeUndefined();

      const mcp = await session.mcpRegistry.open({ serverName: 'timeline', target: 'portable' });
      const list = await mcp.execute({ expectedSessionRevision: mcp.snapshot().binding.sessionRevision, kind: 'list-tools' });
      expect(list.value).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'render_edit_timeline' })]));
      const originalBinding = mcp.snapshot().binding;
      await session.reconcilePreparedRuntime({
        ...prepared.devRuntime!,
        apps: prepared.devRuntime!.apps.map((app) => ({
          ...app,
          _meta: { ...app._meta, 'openai/widgetDescription': 'Updated timeline description.' },
        })),
        sourceRevision: `${prepared.devRuntime!.sourceRevision}-app-metadata`,
      });
      const reconciledRegistry = session.mcpRegistry.snapshot();
      expect(reconciledRegistry!.definitionDigest).not.toBe(registry!.definitionDigest);
      expect(reconciledRegistry).toMatchObject({
        registryRevision: originalBinding.registryRevision + 1,
        runtimeGenerationId: registry!.runtimeGenerationId,
      });
      expect(mcp.snapshot().binding.sessionRevision).toBe(originalBinding.sessionRevision + 1);
      await expect(mcp.execute({ expectedSessionRevision: originalBinding.sessionRevision, kind: 'list-tools' })).rejects.toThrow();
      await expect(mcp.execute({ expectedSessionRevision: mcp.snapshot().binding.sessionRevision, kind: 'list-tools' })).resolves.toMatchObject({
        vector: { runtimeGenerationId: registry!.runtimeGenerationId },
      });
      await mcp.close();
      await session.close();
      expect(session.status()).toMatchObject({ hmrReady: false, state: 'closed' });
      expect(session.clientSurface('mcp.edit-timeline')).toBeUndefined();
    } finally {
      await session.close();
    }
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 30_000);

test('rejects an already-aborted provider start before creating a runtime session', async () => {
  const copied = await copyExample();
  try {
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
    const controller = new AbortController();
    const reason = new Error('provider startup cancelled');
    controller.abort(reason);

    await expect(createDevRuntimeProvider().start({
      artifactStatus: () => Object.freeze({ state: 'missing' as const }),
      emit: () => undefined,
      environment: Object.freeze({}),
      projectRoot: copied.projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'provider-aborted',
      signal: controller.signal,
      storageRoot: join(copied.projectRoot, '.agent-bundle', 'runtime-aborted'),
    })).rejects.toBe(reason);
  } finally {
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
});
