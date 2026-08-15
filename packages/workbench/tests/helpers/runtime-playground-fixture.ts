import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createWorkbenchAssetSource } from '../../../agent-bundle/src/dev/workbench-assets.ts';
import type { DevRuntimeClientSurfaceProxyBinding } from '../../../agent-bundle/src/dev/runtime-provider.ts';
import { startDevServer } from '../../../agent-bundle/src/dev/workbench-server.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const runtimeExample = join(workspaceRoot, 'examples', 'rsc-agent-runtime');
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');

export interface RuntimePlaygroundFixture {
  close(): Promise<void>;
  openRuntimeClientSurface(surfaceId: string): Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  readonly appStyles: string;
  readonly closed: Promise<void>;
  readonly root: string;
  readonly serverComponentSource: string;
  readonly url: string;
}

const buildWorkbench = async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
};

/** Starts the real RSC example in an isolated workspace-local copy. */
export const startRuntimePlaygroundFixture = async (): Promise<RuntimePlaygroundFixture> => {
  await buildWorkbench();
  // The real example resolves workspace modules two levels above its project.
  // Copy that topology, including only workspace-local symlinks, into one root.
  const fixtureWorkspace = await mkdtemp(join(workspaceRoot, '.runtime-playground-'));
  const root = join(fixtureWorkspace, 'examples', 'rsc-agent-runtime');
  let server: Awaited<ReturnType<typeof startDevServer>>;
  try {
    await cp(runtimeExample, root, {
      filter: (source) => !['.agent-bundle', 'dist', 'node_modules'].includes(source.split('/').at(-1) ?? ''),
      recursive: true,
    });
    await Promise.all([
      symlink(join(workspaceRoot, 'node_modules'), join(fixtureWorkspace, 'node_modules'), 'dir'),
      symlink(join(workspaceRoot, 'packages'), join(fixtureWorkspace, 'packages'), 'dir'),
      symlink(join(workspaceRoot, 'tsconfig.json'), join(fixtureWorkspace, 'tsconfig.json')),
    ]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root,
    });
  } catch (error) {
    await rm(fixtureWorkspace, { force: true, recursive: true });
    throw error;
  }
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const clientSurfaces = new Set<DevRuntimeClientSurfaceProxyBinding>();
  const openRuntimeClientSurface = async (surfaceId: string): Promise<DevRuntimeClientSurfaceProxyBinding | undefined> => {
    const binding = await server.openRuntimeClientSurface(surfaceId);
    if (binding === undefined) return undefined;
    const managed: DevRuntimeClientSurfaceProxyBinding = Object.freeze({
      ...binding,
      close: async (): Promise<void> => {
        try {
          await binding.close();
        } finally {
          clientSurfaces.delete(managed);
        }
      },
    });
    clientSurfaces.add(managed);
    return managed;
  };
  const close = async (): Promise<void> => {
    if (closed) return closedPromise;
    closed = true;
    let clientSurfaceFailure: unknown;
    try {
      const results = await Promise.allSettled([...clientSurfaces].map((binding) => binding.close()));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      clientSurfaceFailure = failed?.reason;
      await server.close();
    } finally {
      await rm(fixtureWorkspace, { force: true, recursive: true });
      resolveClosed();
    }
    if (clientSurfaceFailure !== undefined) throw clientSurfaceFailure;
    return closedPromise;
  };
  return Object.freeze({
    appStyles: join(root, 'src', 'widget', 'styles.css'),
    close,
    closed: closedPromise,
    openRuntimeClientSurface,
    root,
    serverComponentSource: join(root, 'src', 'rsc', 'components.tsx'),
    url: server.url,
  });
};
