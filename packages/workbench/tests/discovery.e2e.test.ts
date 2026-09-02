import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import type {
  DoctorCommandRunner,
  DoctorCommandResult,
} from '../../agent-bundle/src/install/doctor.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 30_000 * timeScale;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const successfulCommand = (stdout: string): DoctorCommandResult => Object.freeze({
  exitCode: 0,
  signal: null,
  stderr: '',
  stdout,
});

const unavailableCommand = (executable: string): NodeJS.ErrnoException => {
  const error = new Error(`spawn ${executable} ENOENT`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  error.errno = -2;
  error.path = executable;
  error.syscall = `spawn ${executable}`;
  return error;
};

e2e(
  'renders populated and honestly absent hosts, then repairs discovery after a real rebuild',
  { timeout: 180_000 },
  async ({ page }) => {
    const doctorRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-discovery-e2e-'));
    const endpointDirectory = join(doctorRoot, 'endpoints');
    const home = join(doctorRoot, 'home');
    const cursorPluginRoot = join(
      home,
      '.cursor',
      'plugins',
      'local',
      'host-discovery-fixture',
      '.cursor-plugin',
    );
    let fixture: Awaited<ReturnType<typeof startRuntimePlaygroundFixture>> | undefined;
    let generatedAtTick = 0;
    const commandRunner: DoctorCommandRunner = async (request) => {
      if (request.executable === 'codex') throw unavailableCommand(request.executable);
      if (request.executable !== 'claude') {
        throw new Error(`Unexpected Doctor command ${JSON.stringify(request.executable)}.`);
      }
      return successfulCommand(request.args[0] === '--version'
        ? 'Claude Code 1.2.3\n'
        : '[{"id":"rsc-agent-runtime-demo@inline"}]\n');
    };
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await Promise.all([
      mkdir(cursorPluginRoot, { recursive: true }),
      mkdir(endpointDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(cursorPluginRoot, 'plugin.json'), JSON.stringify({
        name: 'host-discovery-fixture',
        version: '4.5.6',
      })),
      writeFile(join(endpointDirectory, 'event-discovery-stale.sock'), ''),
    ]);

    try {
      fixture = await startRuntimePlaygroundFixture({
        hostDiscoveryOptions: {
          doctorOptions: {
            commandRunner,
            endpointDirectory,
            home,
            platform: 'linux',
          },
          now: () => new Date(Date.UTC(2026, 8, 2, 5, 0, generatedAtTick++)),
        },
      });
      await page.goto(workbenchUrl(fixture.url, 'hosts'));
      try {
        await expect(page.getByText('Generated at', { exact: true })).toBeVisible({ timeout: browserTimeout });
      } catch (reason) {
        throw new Error(
          `Host discovery page did not become ready at ${page.url()}.\n${await page.locator('body').innerText()}`,
          { cause: reason },
        );
      }
      await expect(page.getByText('Loading host discovery', { exact: true })).toHaveCount(0, { timeout: browserTimeout });

      await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
      await expect(page.getByRole('link', { exact: true, name: 'Hosts' })).toHaveAttribute('aria-current', 'page');

      const claude = page.getByRole('group', { name: 'Claude' });
      await expect(claude.locator('.discovery-badge').first()).toHaveText('Available');
      await expect(claude.getByText('1.2.3', { exact: true })).toBeVisible();

      const codex = page.getByRole('group', { name: 'Codex' });
      const absentBadge = codex.getByText('Not installed', { exact: true });
      await expect(absentBadge).toBeVisible();
      await expect(absentBadge).toHaveClass(/(?:^|\s)discovery-badge--neutral(?:\s|$)/u);
      await expect(page.getByRole('alert')).toHaveCount(0);

      const cursor = page.getByRole('group', { name: 'Cursor' });
      await expect(cursor.getByRole('table').getByText('host-discovery-fixture', { exact: true })).toBeVisible();
      await expect(cursor.getByLabel('Bundle check').locator('.discovery-badge')).toHaveText('Failed');

      const endpoints = page.getByLabel('Runtime endpoints');
      await expect(endpoints.getByRole('heading', { name: 'Endpoints' })).toBeVisible();
      await expect(endpoints).toContainText(endpointDirectory);
      try {
        await expect(endpoints.getByText('Stale socket', { exact: true })).toBeVisible();
      } catch (reason) {
        throw new Error(`Unexpected endpoint report:\n${await endpoints.innerText()}`, { cause: reason });
      }

      const diagnostics = page.getByLabel('Discovery diagnostics');
      await expect(diagnostics.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
      await expect(diagnostics.getByText('Recovery:', { exact: true }).first()).toBeVisible();

      const staleBanner = page.locator('.discovery-stale[role="status"]');
      await expect(staleBanner).toHaveCount(0);
      const generatedAt = page.locator('.discovery-toolbar dl > div')
        .filter({ has: page.getByText('Generated at', { exact: true }) })
        .locator('dd');
      const generatedAtBefore = await generatedAt.innerText();
      const source = await readFile(fixture.definitionSource, 'utf8');
      await replaceWatchedSource(
        fixture.root,
        fixture.definitionSource,
        `${source}\n// host discovery stale-repair ${Date.now()}\n`,
      );

      await expect(staleBanner.getByRole('heading', {
        name: 'Discovery report is from an older build',
      })).toBeVisible({ timeout: browserTimeout });
      await staleBanner.getByRole('button', { name: 'Re-run discovery' }).click();
      await expect(generatedAt).not.toHaveText(generatedAtBefore, { timeout: browserTimeout });
      await expect(page.getByText('Loading host discovery', { exact: true })).toHaveCount(0, { timeout: browserTimeout });
      await expect(staleBanner).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await fixture?.close();
      await rm(doctorRoot, { force: true, recursive: true });
    }
  },
);
