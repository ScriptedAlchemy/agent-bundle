import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createWorkbenchAssetSource } from '../../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../../agent-bundle/src/dev/workbench-server.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const runtimeExample = join(workspaceRoot, 'examples', 'rsc-agent-runtime');
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');

export interface RuntimePlaygroundFixture {
  close(): Promise<void>;
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
  const close = async (): Promise<void> => {
    if (closed) return closedPromise;
    closed = true;
    try {
      await server.close();
    } finally {
      await rm(fixtureWorkspace, { force: true, recursive: true });
      resolveClosed();
    }
    return closedPromise;
  };
  return Object.freeze({
    appStyles: join(root, 'src', 'widget', 'styles.css'),
    close,
    closed: closedPromise,
    root,
    serverComponentSource: join(root, 'src', 'rsc', 'components.tsx'),
    url: server.url,
  });
};
