import { join } from 'node:path';

import { expect } from '@rstest/playwright';
import { createRsbuild, type Rspack, type StartDevServerResult } from '@rsbuild/core';

import type { StartDevServerOptions } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture, type ProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { availablePort } from '../../agent-bundle/tests/support/available-port.ts';
import { within } from '../../agent-bundle/tests/support/eventually.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { createWorkbenchConfig } from '../rsbuild.config.ts';
import {
  buildWorkbench,
  e2e,
  startWorkbenchDevServer,
  withWorkbenchServer,
  workbenchUrl,
  workspaceRoot,
  type WorkbenchServer,
} from './support/workbench-e2e.ts';

/**
 * The documented contributor HMR loop (#572 §3 P1):
 *
 *   agent-bundle dev --workbench-dev-origin http://localhost:3000
 *   AGENT_BUNDLE_WORKBENCH_API_PROXY=<foreground url> pnpm --filter agent-bundle-workbench dev
 *
 * The browser page lives on the Rsbuild dev origin while every `/api` request
 * is proxied to the foreground server, so the page origin and the foreground
 * origin differ. This proves that loop completes a Workbench session through
 * the DOCUMENTED proxy config (`createWorkbenchConfig`, no header rewriting):
 *
 * 1. Bootstrap: the Overview renders on the dev origin — the client accepts
 *    the `devOrigins` disclosed by `GET /api/project/session`, and the
 *    cookie-authenticated event stream connects through the proxy (the
 *    connection gate would otherwise replace the page).
 * 2. Mutation: a real `POST /api/project/rebuild` carrying the browser's own
 *    `Origin: http://localhost:<port>` is admitted (200, no request error).
 * 3. No laundering: the proxy forwards `Origin` untouched, so a request that
 *    reaches the dev server with a foreign loopback origin is still refused
 *    by the foreground with AB8003, while the allowlisted origin is disclosed
 *    as `devOrigins` next to the unchanged foreground `origin`.
 * 4. The documented no-flag failure: with the same dev server and page origin
 *    but the foreground restarted on its port WITHOUT `--workbench-dev-origin`,
 *    the bootstrap succeeds as HTTP 200 yet names only the foreground origin,
 *    so the client refuses it as AB8003 and the page stays on the "Foreground
 *    connection unavailable" gate whose alert names the code, the foreground
 *    URL to open instead, and the exact flag to add; the foreground refuses
 *    the page's `Origin` outright.
 *
 * Deliberately not covered: MCP App preview and runtime client-surface
 * iframes stay bound to the foreground origin (their sandbox and proxy
 * bindings are created from the foreground URL), so the contributor loop does
 * not exercise them through the dev origin.
 */

const workbenchRoot = join(workspaceRoot, 'packages', 'workbench');
const browserTimeout = 15_000 * timeScale;
/** Rsbuild's first dev compile of the Workbench app; the browser budget starts only after it. */
const compileTimeout = 90_000;
/** Rsbuild's default `server.host`, and the hostname the documented loop puts in the browser. */
const devHost = 'localhost';

interface ContributorLoop {
  readonly dev: StartDevServerResult;
  readonly devOrigin: string;
  /** The foreground behind the dev server's `/api` proxy: the replacement once `restartForeground` has run. */
  readonly foreground: WorkbenchServer;
  /** Closes the running foreground; a no-op while a restart left none running. */
  readonly closeForeground: () => Promise<void>;
  /**
   * Closes the foreground and starts another on the SAME port with the e2e
   * defaults plus `overrides`, so the already-compiled dev server keeps proxying
   * `/api` to it — an `agent-bundle dev` restart that drops the allowlist unless
   * `overrides` names `workbenchDevOrigins` again.
   */
  readonly restartForeground: (overrides?: Partial<StartDevServerOptions>) => Promise<WorkbenchServer>;
}

const startContributorLoop = async (project: ProjectFixture): Promise<ContributorLoop> => {
  // The port is reserved before the dev server exists — the contributor loop's
  // own order (`--workbench-dev-origin http://localhost:3000`, then `rsbuild
  // dev`) — on the host Rsbuild will bind, or `strictPort` could fail.
  const port = await availablePort(devHost);
  const devOrigin = `http://${devHost}:${port}`;
  const foreground = await startWorkbenchDevServer(project, { workbenchDevOrigins: [devOrigin] });
  const foregroundPort = Number(new URL(foreground.url).port);
  let current: WorkbenchServer | undefined = foreground;
  const closeForeground = async (): Promise<void> => {
    const closing = current;
    current = undefined;
    await closing?.close();
  };
  try {
    const documented = createWorkbenchConfig(foreground.url);
    if (!('server' in documented)) throw new Error('The documented Workbench config did not configure the /api proxy.');
    const rsbuild = await createRsbuild({
      config: {
        ...documented,
        logLevel: 'warn',
        mode: 'development',
        // The documented `strictPort` stays: the port is the one the foreground allowlisted.
        server: { ...documented.server, host: devHost, open: false, port, printUrls: false },
      },
      cwd: workbenchRoot,
    });
    const firstCompile = new Promise<Rspack.Stats | Rspack.MultiStats>((resolvePromise) => {
      rsbuild.onDevCompileDone(({ isFirstCompile, stats }) => {
        if (isFirstCompile) resolvePromise(stats);
      });
    });
    const dev = await rsbuild.startDevServer();
    try {
      const stats = await within(firstCompile, compileTimeout);
      if (stats.hasErrors()) {
        throw new Error(`Workbench dev compile failed:\n${stats.toString({ all: false, colors: false, errors: true })}`);
      }
    } catch (error) {
      await Promise.allSettled([dev.server.close()]);
      throw error;
    }
    return {
      closeForeground,
      dev,
      devOrigin,
      get foreground(): WorkbenchServer {
        if (current === undefined) throw new Error('No foreground server is running behind the dev server proxy.');
        return current;
      },
      restartForeground: async (overrides = {}): Promise<WorkbenchServer> => {
        await closeForeground();
        current = await startWorkbenchDevServer(project, { ...overrides, port: foregroundPort });
        return current;
      },
    };
  } catch (error) {
    await Promise.allSettled([closeForeground()]);
    throw error;
  }
};

/** The dev server closes first: its proxy holds upstream connections into the foreground. */
const closeContributorLoop = async ({ closeForeground, dev }: ContributorLoop): Promise<void> => {
  const [devClosed] = await Promise.allSettled([dev.server.close()]);
  await closeForeground();
  if (devClosed?.status === 'rejected') throw devClosed.reason;
};

const sessionThroughProxy = (devOrigin: string, origin?: string): Promise<Response> =>
  fetch(`${devOrigin}/api/project/session`, origin === undefined ? {} : { headers: { origin } });

// 180 s covered one foreground start plus the compile and browser budgets; the no-flag step adds a second foreground start.
e2e('completes a Workbench session through the documented contributor HMR proxy and gates a foreground started without the allowlist', { timeout: 210_000 }, async ({ page }) => {
  await buildWorkbench();
  await withWorkbenchServer({
    close: closeContributorLoop,
    createProject: () => createProjectFixture(),
    dispose: (project) => removeProjectFixture(project.root),
    start: startContributorLoop,
  }, async (loop) => {
    const { devOrigin, foreground } = loop;
    expect(devOrigin).not.toBe(foreground.url);
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    // 1. Bootstrap through the proxy: the client-side origin check accepts the dev origin.
    await page.goto(workbenchUrl(devOrigin, 'overview'));
    try {
      await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    } catch (reason) {
      throw new Error(
        `Overview did not render on the dev origin ${page.url()}.\n${await page.locator('body').innerText()}`,
        { cause: reason },
      );
    }
    expect(new URL(page.url()).origin).toBe(devOrigin);
    await expect(page.getByRole('heading', { name: /^Foreground connection/u })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Foreground server connected' })).toBeVisible();
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });

    // 2. A mutation carrying the browser's real Origin header, admitted through the allowlist.
    const rebuild = page.getByRole('button', { name: 'Rebuild' });
    const rebuildResponse = page.waitForResponse((candidate) =>
      candidate.request().method() === 'POST' && candidate.url() === `${devOrigin}/api/project/rebuild`);
    await rebuild.click();
    const response = await rebuildResponse;
    expect(response.status()).toBe(200);
    expect((await response.request().allHeaders())['origin']).toBe(devOrigin);
    await expect(rebuild).toBeEnabled({ timeout: browserTimeout });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });
    await expect(page.getByRole('status').filter({ hasText: 'Foreground server connected' })).toBeVisible();
    expect(foreground.status().artifact.state).toBe('active');
    expect(pageErrors).toEqual([]);

    // 3. The proxy does not launder origins: the foreground still decides per Origin,
    //    and a request without one gains no same-origin provenance on the way through.
    const foreign = await sessionThroughProxy(devOrigin, 'http://127.0.0.1:65500');
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ diagnostic: { code: 'AB8003' } });
    const anonymous = await sessionThroughProxy(devOrigin);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ diagnostic: { code: 'AB8003' } });
    const admitted = await sessionThroughProxy(devOrigin, devOrigin);
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({ devOrigins: [devOrigin], origin: foreground.url });

    // 4. The documented no-flag failure on the same dev server: the foreground
    //    restarts on its port without `--workbench-dev-origin`, so the proxy
    //    target is unchanged and only the allowlist is gone. The page leaves
    //    first so its event stream and recovery polling are not proxied into a
    //    foreground that is going away; the fresh load below is the documented
    //    "open http://localhost:<port>" moment.
    await page.goto('about:blank');
    const unlisted = await loop.restartForeground();
    expect(unlisted.url).toBe(foreground.url);
    const bootstrap = page.waitForResponse((candidate) =>
      candidate.request().method() === 'GET' && candidate.url() === `${devOrigin}/api/project/session`);
    await page.goto(workbenchUrl(devOrigin, 'overview'));
    // The bootstrap itself succeeds — the browser's same-origin GET carries no
    // `Origin` — but its body names only the foreground origin and no `devOrigins`,
    // so the refusal below is the client's own, not an HTTP failure.
    const bootstrapResponse = await bootstrap;
    expect((await bootstrapResponse.request().allHeaders())['origin']).toBeUndefined();
    expect(bootstrapResponse.status()).toBe(200);
    const bootstrapBody: unknown = await bootstrapResponse.json();
    expect(bootstrapBody).toMatchObject({ origin: unlisted.url });
    expect(bootstrapBody).not.toHaveProperty('devOrigins');
    try {
      await expect(page.getByRole('heading', { name: 'Foreground connection unavailable' })).toBeVisible({ timeout: browserTimeout });
    } catch (reason) {
      throw new Error(
        `The connection gate did not appear on ${page.url()} without the dev-origin allowlist.\n${await page.locator('body').innerText()}`,
        { cause: reason },
      );
    }
    expect(new URL(page.url()).origin).toBe(devOrigin);
    // The gate's alert is the diagnostic itself: the code, the foreground URL to
    // open instead, and the exact flag that is missing — not a bare HTTP status.
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('AB8003', { timeout: browserTimeout });
    await expect(alert).toContainText(`--workbench-dev-origin ${devOrigin}`);
    await expect(alert).toHaveText(
      `AB8003 — Origin ${devOrigin} is not allowed by the foreground server at ${unlisted.url}. `
      + `Open ${unlisted.url} instead, or start agent-bundle dev with --workbench-dev-origin ${devOrigin} to allow this origin.`,
    );
    await expect(alert).not.toContainText('HTTP 200');
    await expect(alert).not.toContainText('Workbench request failed');
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toHaveCount(0);
    expect(pageErrors).toEqual([]);

    // The server-side half of the same sentence: the Origin admitted in step 3 is
    // refused outright once the allowlist is gone, so no mutation from this page
    // could be admitted either.
    const refused = await sessionThroughProxy(devOrigin, devOrigin);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ diagnostic: { code: 'AB8003' } });
  });
});
