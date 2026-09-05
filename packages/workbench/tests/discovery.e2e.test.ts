import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
          await writeFile(configSource, source.replace(anchor, `    servers: {
      'probe-down': {
        args: ['-e', 'process.exit(0)'],
        command: 'node',
        targets: ['portable', 'claude', 'codex'],
        transport: 'stdio',
      },
      timeline: {`));
          const output = join(root, 'dist', 'plugins');
          const result = await build({ output, root });
          const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          if (errors.length > 0) {
            throw new Error(`Discovery probe fixture build failed: ${JSON.stringify(errors)}`);
          }
          await cp(join(output, 'claude'), join(root, 'dist', 'claude'), { recursive: true });
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
      const claudeMcp = claude.getByLabel('Claude MCP servers');
      try {
        await expect(claudeMcp.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
      } catch (reason) {
        throw new Error(`Claude MCP discovery was not populated:\n${await claude.innerText()}`, {
          cause: reason,
        });
      }
      await expect(claudeMcp.getByText('timeline', { exact: true })).toBeVisible();
      await expect(claudeMcp.getByText('stdio', { exact: true }).first()).toBeVisible();
      expect(probeRequests).toEqual([]);

      await claudeMcp.getByRole('button', { name: 'Probe timeline' }).click();
      await expect(claudeMcp.getByRole('heading', { name: 'Consent required' })).toBeVisible();
      await expect(claudeMcp).toContainText('read-only live probe');
      await expect(claudeMcp).toContainText('Nothing is stored');
      await claudeMcp.getByRole('button', { name: 'Cancel' }).click();
      expect(probeRequests).toEqual([]);

      await claudeMcp.getByRole('button', { name: 'Probe timeline' }).click();
      await claudeMcp.getByRole('button', { name: 'Run live probe' }).click();
      await expect.poll(() => probeRequests).toEqual(['POST']);
      await expect(claudeMcp.getByText('Connected', { exact: true })).toBeVisible({
        timeout: browserTimeout,
      });
      const protocol = claudeMcp.locator('.discovery-mcp-server-facts > div')
        .filter({ hasText: 'Protocol' })
        .locator('dd');
      await expect(protocol).not.toHaveText('');
      await expect.poll(() => claudeMcp.getByLabel('timeline tools').getByRole('row').count())
        .toBeGreaterThan(1);
      await expect(claudeMcp.getByLabel('Redacted launch summary')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);

      const downServer = claudeMcp.locator(':scope > ul > li').filter({ hasText: 'probe-down' });
      await claudeMcp.getByRole('button', { name: 'Probe probe-down' }).click();
      await downServer.getByRole('button', { name: 'Run live probe' }).click();
      await expect.poll(() => probeRequests).toEqual(['POST', 'POST']);
      const downBadge = downServer.getByText(/^(?:Timed out|Unreachable)$/u);
      await expect(downBadge).toBeVisible({ timeout: browserTimeout });
      await expect(downBadge).toHaveClass(/(?:^|\s)discovery-badge--neutral(?:\s|$)/u);
      await expect(downServer).toContainText(/connect|handshake|protocol/u);
      await expect(page.getByRole('alert')).toHaveCount(0);

      await page.getByRole('button', { name: 'Re-run discovery' }).first().click();
      await expect(page.getByText('Loading host discovery', { exact: true })).toHaveCount(0, {
        timeout: browserTimeout,
      });
      await expect(claudeMcp.getByText('Connected', { exact: true })).toHaveCount(0);
      await expect(claudeMcp.getByText(/^(?:Timed out|Unreachable)$/u)).toHaveCount(0);
      await expect(claudeMcp.getByRole('button', { name: 'Probe timeline' })).toBeVisible();

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
