import { execFile as executeFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer, type DevServerSession, type StartDevServerOptions } from '../../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture, type ProjectFixture } from '../../../agent-bundle/tests/helpers/project-fixture.ts';

export const execFile = promisify(executeFile);
export const workspaceRoot = process.cwd();
export const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');

export const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

let workbenchBuild: Promise<void> | undefined;

export const buildWorkbench = (): Promise<void> => workbenchBuild ??= (async (): Promise<void> => {
  if (process.env['AGENT_BUNDLE_WORKBENCH_PREBUILT'] === '1') return;
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('pnpm', ['--filter', 'agent-bundle-workbench', 'build'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
})();

export type WorkbenchServer = DevServerSession;

/** Starts the packaged Workbench dev server against a project root with the e2e defaults. */
export const startWorkbenchDevServer = (
  project: Pick<ProjectFixture, 'root'>,
  overrides: Partial<StartDevServerOptions> = {},
): Promise<WorkbenchServer> => startDevServer({
  assets: createWorkbenchAssetSource({ root: workbenchAssets }),
  open: false,
  port: 0,
  root: project.root,
  ...overrides,
});

export interface WithWorkbenchServerOptions<TServer, TProject> {
  /** Closes the started server. Defaults to calling `.close()` on it. */
  readonly close?: (server: TServer) => unknown;
  readonly createProject: () => Promise<TProject>;
  /** Releases the project created by `createProject`. */
  readonly dispose: (project: TProject) => unknown;
  /** Runs after the project is created but before the server starts. */
  readonly setup?: (project: TProject) => Promise<void>;
  readonly start: (project: TProject) => Promise<TServer>;
  /** Extra cleanup steps folded into the same hardened epilogue as the server close and project dispose. */
  readonly teardown?: readonly (() => unknown)[];
}

/**
 * Boots a project + dev-server pair for one e2e test and always tears both down through the
 * hardened epilogue: every cleanup step runs via `Promise.allSettled` regardless of outcome, the
 * test body's own failure is preferred over a cleanup failure, and a cleanup failure only
 * surfaces when the test body itself succeeded.
 */
export const withWorkbenchServer = async <TServer, TProject, TResult>(
  options: WithWorkbenchServerOptions<TServer, TProject>,
  run: (server: TServer, project: TProject) => Promise<TResult>,
): Promise<TResult> => {
  const project = await options.createProject();
  const closeServer = options.close ?? ((server: TServer): unknown => (server as unknown as { close: () => unknown }).close());
  let server: TServer | undefined;
  let testFailure: unknown;
  let cleanupFailure: unknown;
  let result: TResult | undefined;
  try {
    if (options.setup !== undefined) await options.setup(project);
    server = await options.start(project);
    result = await run(server, project);
  } catch (error) {
    testFailure = error;
  } finally {
    // Sequential on purpose: the server must finish closing (dev-lock release,
    // directory syncs) before the project root underneath it is removed —
    // disposing concurrently makes the close fail against a vanishing root.
    const startedServer = server;
    const cleanups = [
      // Teardown first: gate releases and env restoration act on state the
      // server close and project removal depend on (a held gate blocks the
      // server's shutdown path, and gate files live inside the project root).
      ...await Promise.allSettled((options.teardown ?? []).map(async (task) => task())),
      ...await Promise.allSettled([
        startedServer === undefined ? Promise.resolve() : Promise.resolve(closeServer(startedServer)),
      ]),
      ...await Promise.allSettled([Promise.resolve(options.dispose(project))]),
    ];
    const failedCleanup = cleanups.find((cleanup) => cleanup.status === 'rejected');
    if (failedCleanup?.status === 'rejected') cleanupFailure = failedCleanup.reason;
  }
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result as TResult;
};

/** Convenience wrapper for the common case: a fresh `ProjectFixture` and the standard packaged dev server. */
export const withWorkbenchProjectServer = <TResult>(
  run: (server: WorkbenchServer, project: ProjectFixture) => Promise<TResult>,
  options: Readonly<{
    setup?: (project: ProjectFixture) => Promise<void>;
    startOverrides?: Partial<StartDevServerOptions>;
    teardown?: readonly (() => unknown)[];
  }> = {},
): Promise<TResult> => withWorkbenchServer({
  close: (server) => server.close(),
  createProject: createProjectFixture,
  dispose: (project) => removeProjectFixture(project.root),
  setup: options.setup,
  start: (project) => startWorkbenchDevServer(project, options.startOverrides),
  teardown: options.teardown,
}, run);
