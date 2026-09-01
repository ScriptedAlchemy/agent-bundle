import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createWorkbenchAssetSource } from '../../../agent-bundle/src/dev/workbench-assets.ts';
import type { ProjectEventHub } from '../../../agent-bundle/src/dev/events.ts';
import { startForegroundServer, type ForegroundProjectEventStreamHandle } from '../../../agent-bundle/src/dev/foreground-server.ts';
import type { DevRuntimeClientSurfaceProxyBinding } from '../../../agent-bundle/src/dev/runtime-provider.ts';
import { startDevServer } from '../../../agent-bundle/src/dev/workbench-server.ts';
import { ensureRuntimeExamplePayload, runtimeExamplePayloads } from './runtime-example-payload.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const runtimeExample = join(workspaceRoot, 'examples', 'rsc-agent-runtime');
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');

export interface RuntimePlaygroundFixture {
  close(): Promise<void>;
  disconnectProjectEventStream(): void;
  openRuntimeClientSurface(surfaceId: string): Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  publishReplayNoise(): void;
  readonly appStyles: string;
  readonly closed: Promise<void>;
  readonly configSource: string;
  readonly definitionSource: string;
  readonly eventHubState: Readonly<{ readonly latestSequence: number; readonly subscriptionCount: number }>;
  readonly root: string;
  readonly serverComponentSource: string;
  readonly url: string;
  readonly widgetAppSource: string;
}

/** A narrow pre-start hook for a copied example configuration in real-browser tests. */
export interface RuntimePlaygroundFixtureOptions {
  readonly prepare?: (fixture: Readonly<{ readonly configSource: string; readonly root: string }>) => Promise<void> | void;
}

const buildWorkbench = async (): Promise<void> => {
  if (process.env['AGENT_BUNDLE_WORKBENCH_PREBUILT'] === '1') return;
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('pnpm', ['--filter', 'agent-bundle-workbench', 'build'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
};


/** Starts the real RSC example in an isolated workspace-local copy. */
export const startRuntimePlaygroundFixture = async (
  options: RuntimePlaygroundFixtureOptions = {},
): Promise<RuntimePlaygroundFixture> => {
  await buildWorkbench();
  await ensureRuntimeExamplePayload();
  // The real example resolves workspace modules two levels above its project.
  // Copy that topology, including only workspace-local symlinks, into one root.
  const fixtureWorkspace = await mkdtemp(join(workspaceRoot, '.runtime-playground-'));
  const root = join(fixtureWorkspace, 'examples', 'rsc-agent-runtime');
  let server: Awaited<ReturnType<typeof startDevServer>>;
  let eventHub: ProjectEventHub | undefined;
  let projectEventStream: ForegroundProjectEventStreamHandle | undefined;
  try {
    await cp(runtimeExample, root, {
      filter: (source) => !['.agent-bundle', 'dist', 'node_modules'].includes(source.split('/').at(-1) ?? ''),
      recursive: true,
    });
    // The declared prebuilt payload trees ride along: the dev artifact epoch
    // packages them, exactly as `agent-bundle build` would.
    await Promise.all(runtimeExamplePayloads.map((payload) =>
      cp(join(runtimeExample, 'dist', payload), join(root, 'dist', payload), { recursive: true })));
    await Promise.all([
      symlink(join(runtimeExample, 'node_modules'), join(root, 'node_modules'), 'dir'),
      symlink(join(workspaceRoot, 'node_modules'), join(fixtureWorkspace, 'node_modules'), 'dir'),
      symlink(join(workspaceRoot, 'packages'), join(fixtureWorkspace, 'packages'), 'dir'),
      // Copy the inheriting root configs: the RSC build resolves their relative extends
      // from the disposable workspace rather than through a symlink target.
      cp(join(workspaceRoot, 'tsconfig.base.json'), join(fixtureWorkspace, 'tsconfig.base.json')),
      cp(join(workspaceRoot, 'tsconfig.json'), join(fixtureWorkspace, 'tsconfig.json')),
    ]);
    await options.prepare?.(Object.freeze({ configSource: join(root, 'agent-bundle.config.ts'), root }));
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root,
      testing: {
        startForegroundServer: async (options) => {
          eventHub = options.eventHub;
          return startForegroundServer({
            ...options,
            testing: {
              ...options.testing,
              onProjectEventStream: (handle) => { projectEventStream = handle; },
            },
          });
        },
      },
    });
  } catch (error) {
    await rm(fixtureWorkspace, { force: true, recursive: true });
    throw error;
  }
  if (eventHub === undefined) {
    await server.close();
    await rm(fixtureWorkspace, { force: true, recursive: true });
    throw new Error('Runtime playground fixture did not receive the foreground event hub.');
  }
  const foregroundEventHub = eventHub;
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
    configSource: join(root, 'agent-bundle.config.ts'),
    definitionSource: join(root, 'src', 'definition.ts'),
    disconnectProjectEventStream: () => { projectEventStream?.disconnect(); },
    get eventHubState() {
      return Object.freeze({
        latestSequence: foregroundEventHub.latestSequence,
        subscriptionCount: foregroundEventHub.subscriptionCount,
      });
    },
    openRuntimeClientSurface,
    publishReplayNoise: () => {
      for (let index = 0; index < 257; index += 1) {
        foregroundEventHub.publish({
          payload: Object.freeze({
            occurredAt: '2026-08-17T00:00:00.000Z',
            paths: Object.freeze([`src/replay-noise-${String(index)}.ts`]),
            reason: 'source-change' as const,
          }),
          type: 'source.changed',
        });
      }
    },
    root,
    serverComponentSource: join(root, 'src', 'rsc', 'components.tsx'),
    url: server.url,
    widgetAppSource: join(root, 'src', 'widget', 'App.tsx'),
  });
};
