import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { build } from '../../agent-bundle/src/api.ts';
import type {
  DoctorCommandRunner,
  DoctorCommandResult,
} from '../../agent-bundle/src/install/doctor.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { browserLaunchOptions, browserTrace, workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 30_000 * timeScale;

const e2e = test.extend({
  playwright: {
    launchOptions: browserLaunchOptions,
    contextOptions: { viewport: { height: 900, width: 1440 } },
    trace: browserTrace,
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
    const probeRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/discovery/probes') {
        probeRequests.push(request.method());
      }
    });

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
        prepare: async ({ configSource, root }) => {
          const source = await readFile(configSource, 'utf8');
          const anchor = '    servers: {\n      timeline: {';
          if (!source.includes(anchor)) throw new Error('Discovery probe fixture config anchor is missing.');
          const outputAnchor = '  dev: { runtime:';
          if (!source.includes(outputAnchor)) throw new Error('Discovery probe fixture config output anchor is missing.');
          // The example packages into `dist/plugins` (its prebuilt payloads
          // live beside it under `dist/`); declare that as the artifact dist
          // path so Doctor reads the composite root the build wrote (#555).
          await writeFile(configSource, source.replace(anchor, `    servers: {
      'probe-down': {
        args: ['-e', 'process.exit(0)'],
        command: 'node',
        targets: ['portable', 'claude', 'codex'],
        transport: 'stdio',
      },
      timeline: {`).replace(outputAnchor, `  output: { distPath: 'dist/plugins' },
${outputAnchor}`));
          const output = join(root, 'dist', 'plugins');
          const result = await build({ output, root });
          const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          if (errors.length > 0) {
            throw new Error(`Discovery probe fixture build failed: ${JSON.stringify(errors)}`);
          }
        },
      });
      await page.goto(workbenchUrl(fixture.url, '/advanced/hosts'));
      try {
        await expect(page.getByRole('heading', { name: 'Host diagnostics' })).toBeVisible({ timeout: browserTimeout });
      } catch (reason) {
        throw new Error(
          `Host diagnostics did not become ready at ${page.url()}.\n${await page.locator('body').innerText()}`,
          { cause: reason },
        );
      }
      await expect(page.getByText('Loading host diagnostics', { exact: true })).toHaveCount(0, { timeout: browserTimeout });
      await expect(page.getByTestId('workbench-nav').getByRole('link', { name: 'Advanced' })).toHaveAttribute('aria-current', 'page');

      const claude = page.getByRole('group', { name: 'Claude Code' });
      await expect(claude.locator('.discovery-badge').first()).toHaveText('Installed');
      await expect(claude.getByText('1.2.3', { exact: true })).toBeVisible();
      const handshake = claude.getByLabel('Claude Code MCP handshake');
      try {
        await expect(handshake.getByRole('heading', { name: 'MCP handshake' })).toBeVisible();
      } catch (reason) {
        throw new Error(`Claude MCP handshake was not populated:\n${await claude.innerText()}`, {
          cause: reason,
        });
      }
      expect(probeRequests).toEqual([]);

      await handshake.getByRole('button', { name: /Probe MCP handshake/u }).click();
      await expect(handshake.getByRole('heading', { name: 'Consent required' })).toBeVisible();
      await expect(handshake).toContainText('read-only live probe');
      await expect(handshake).toContainText('Nothing is stored');
      await handshake.getByRole('button', { name: 'Cancel' }).click();
      expect(probeRequests).toEqual([]);

      await handshake.getByRole('button', { name: /Probe MCP handshake/u }).click();
      await handshake.getByRole('button', { name: 'Run handshake' }).click();
      await expect.poll(() => probeRequests).toEqual(['POST']);
      const handshakeBadge = handshake.getByText(/Handshake (?:ok|timed out|unreachable)/u);
      await expect(handshakeBadge).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('alert')).toHaveCount(0);

      await page.getByRole('button', { name: 'Re-run discovery' }).first().click();
      await expect(page.getByText('Loading host diagnostics', { exact: true })).toHaveCount(0, {
        timeout: browserTimeout,
      });
      await expect(handshake.getByText(/Handshake (?:ok|timed out|unreachable)/u)).toHaveCount(0);
      await expect(handshake.getByRole('button', { name: /Probe MCP handshake/u })).toBeVisible();

      const codex = page.getByRole('group', { name: 'Codex' });
      const absentBadge = codex.getByText('Not installed', { exact: true });
      await expect(absentBadge).toBeVisible();
      await expect(absentBadge).toHaveClass(/(?:^|\s)discovery-badge--neutral(?:\s|$)/u);
      await expect(page.getByRole('alert')).toHaveCount(0);

      const cursor = page.getByRole('group', { name: 'Cursor' });
      await expect(cursor).toBeVisible();
      await expect(cursor.getByRole('heading', { name: 'Cursor' })).toBeVisible();

      const staleBanner = page.locator('.discovery-stale[role="status"]');
      await expect(staleBanner).toHaveCount(0);
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
      await expect(page.getByText('Loading host diagnostics', { exact: true })).toHaveCount(0, { timeout: browserTimeout });
      await expect(staleBanner).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await fixture?.close();
      await rm(doctorRoot, { force: true, recursive: true });
    }
  },
);
