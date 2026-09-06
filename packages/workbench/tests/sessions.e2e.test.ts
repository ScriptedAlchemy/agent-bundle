import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { expect } from '@rstest/playwright';
import type { Page } from 'playwright-core';

import type { HostSession } from '../../agent-bundle/src/contracts/host-sessions.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { copyExample } from './support/example-acceptance.ts';
import {
  expectHeading,
  openWorkbench,
  workbenchTestId,
} from './support/workbench-acceptance.ts';
import {
  buildWorkbench,
  e2e,
  startWorkbenchDevServer,
  withWorkbenchServer,
  workspaceRoot,
} from './support/workbench-e2e.ts';

const browserTimeout = 15_000 * timeScale;
const hostTimeout = 60_000 * timeScale;
const fakeHosts = join(workspaceRoot, 'packages', 'agent-bundle', 'tests', 'support', 'fake-host-cli');

const sessions = (page: Page): Promise<readonly HostSession[]> => page.evaluate(async () => {
  const session = await fetch('/api/project/session').then((response) => response.json()) as { readonly token: string };
  const response = await fetch('/api/sessions', {
    headers: { 'x-agent-bundle-session': session.token },
  });
  return (await response.json() as { readonly sessions: readonly HostSession[] }).sessions;
});

const selectedSessionId = (page: Page): string => {
  const id = new URL(page.url()).searchParams.get('session');
  if (id === null) throw new Error('Sessions pane did not select a session.');
  return id;
};

const waitForTraceSessionId = async (page: Page, id: string): Promise<string> => {
  let traceSessionId: string | undefined;
  await expect.poll(async () => {
    traceSessionId = (await sessions(page)).find((session) => session.id === id)?.traceSessionId;
    return traceSessionId;
  }, { timeout: hostTimeout }).toMatch(/^(?:claude|codex)-session-/u);
  return traceSessionId!;
};

const expectTerminalText = (
  page: Page,
  text: string | RegExp,
): Promise<void> => expect(workbenchTestId(page, 'sessionsTerminal').locator('.xterm-rows'))
  .toContainText(text, { timeout: hostTimeout });

e2e('accepts Claude and Codex host sessions at 1440×900', { timeout: 300_000 * timeScale }, async ({ page }) => {
  await buildWorkbench();
  const homes = await mkdtemp(join(tmpdir(), 'agent-bundle-host-sessions-'));
  const emptyPath = join(homes, 'empty-path');
  await mkdir(emptyPath);
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  };
  process.env.CLAUDE_CONFIG_DIR = join(homes, 'claude');
  process.env.CODEX_HOME = join(homes, 'codex');
  process.env.HOME = join(homes, 'home');
  process.env.PATH = `${fakeHosts}${delimiter}${previous.PATH ?? ''}`;

  await withWorkbenchServer({
    createProject: () => copyExample('audiobook-curator'),
    dispose: (project) => project.release(),
    setup: async (project) => {
      const events = join(project.root, 'src', 'events', 'session');
      await mkdir(events, { recursive: true });
      await writeFile(
        join(events, 'start.ts'),
        "import { Agent } from '@agent-bundle/runtime';\n" +
          "import { createElement } from 'react';\n" +
          "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };\n" +
          "export default async function SessionStart() { return createElement(Agent.Result, null, createElement(Agent.Text, null, 'ready')); }\n",
      );
    },
    start: (project) => startWorkbenchDevServer(project, { installHosts: ['claude', 'codex'] }),
    teardown: [
      () => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      },
      () => rm(homes, { force: true, recursive: true }),
    ],
  }, async (server, project) => {
    await openWorkbench(page, server.url, '/sessions');
    await expectHeading(page, 'Host sessions');
    await expect(page.getByText(/Loading host sessions/u)).toHaveCount(0, { timeout: browserTimeout });
    await expect(workbenchTestId(page, 'sessionsLaunchClaude')).toBeEnabled();
    await expect(workbenchTestId(page, 'sessionsLaunchCodex')).toBeEnabled();

    const unauthorized = await page.evaluate(async () => {
      const response = await fetch('/api/sessions', {
        body: JSON.stringify({ cols: 80, host: 'claude', rows: 24 }),
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      return response.status;
    });
    expect(unauthorized).toBeGreaterThanOrEqual(400);

    const launch = async (host: 'claude' | 'codex'): Promise<string> => {
      await workbenchTestId(page, host === 'claude' ? 'sessionsLaunchClaude' : 'sessionsLaunchCodex').click();
      await expect(page).toHaveURL(/\/sessions\?session=hs_[0-9a-z]{16}$/u, { timeout: hostTimeout });
      const id = selectedSessionId(page);
      await expectTerminalText(page, host === 'claude' ? 'Fake Claude Code host' : 'Fake Codex host');
      const authority = workbenchTestId(page, 'sessionsAuthority');
      await expect(authority).toContainText(project.root);
      await expect(authority).toContainText('Epoch');
      await expect(authority).toContainText('Install');
      await expect(authority).toContainText(/Running · pid \d+/u);
      const traceSessionId = await waitForTraceSessionId(page, id);
      await workbenchTestId(page, 'sessionsTrace').click();
      await expectHeading(page, 'Trace');
      expect(new URL(page.url()).searchParams.get('correlation')).toBe(traceSessionId);
      const group = workbenchTestId(page, 'traceGroup');
      await expect(group).toHaveCount(1, { timeout: hostTimeout });
      await expect(group.locator('[data-source="session"]')).not.toHaveCount(0);
      await expect(group.locator('[data-kind="hook.received"]')).toBeVisible({ timeout: hostTimeout });
      await expect(group).toContainText('tools/call', { timeout: hostTimeout });
      await expect(workbenchTestId(page, 'traceGroupSession')).toBeVisible();
      await workbenchTestId(page, 'traceGroupSession').click();
      await expectHeading(page, 'Host sessions');
      expect(selectedSessionId(page)).toBe(id);
      return id;
    };

    const claude = await launch('claude');
    await workbenchTestId(page, 'sessionsTerminate').click();
    await expect(workbenchTestId(page, 'sessionsState')).toContainText('Terminated', { timeout: hostTimeout });
    await workbenchTestId(page, 'sessionsRestart').click();
    await expect.poll(() => selectedSessionId(page), { timeout: hostTimeout }).not.toBe(claude);
    const restarted = selectedSessionId(page);
    await expect(workbenchTestId(page, 'sessionsAuthority')).toContainText(`Restart of${claude}`);
    await expectTerminalText(page, 'Fake Claude Code host');
    await workbenchTestId(page, 'sessionsTerminate').click();
    await expect(workbenchTestId(page, 'sessionsState')).toContainText('Terminated', { timeout: hostTimeout });
    expect(restarted).toMatch(/^hs_[0-9a-z]{16}$/u);

    await openWorkbench(page, server.url, '/sessions');
    const codex = await launch('codex');
    await workbenchTestId(page, 'sessionsTerminate').click();
    await expect(workbenchTestId(page, 'sessionsState')).toContainText('Terminated', { timeout: hostTimeout });
    expect(codex).toMatch(/^hs_[0-9a-z]{16}$/u);

    await openWorkbench(page, server.url, '/routes/mcp/curator/tool/search_audible');
    await expect(workbenchTestId(page, 'routeOpenInClaude')).toBeEnabled({ timeout: browserTimeout });
    await workbenchTestId(page, 'routeOpenInClaude').click();
    await expectHeading(page, 'Host sessions');
    await expectTerminalText(page, 'Call the tool:curator/search_audible tool of this plugin and explain the result.');
    await workbenchTestId(page, 'sessionsTerminate').click();
    await expect(workbenchTestId(page, 'sessionsState')).toContainText('Terminated', { timeout: hostTimeout });

    process.env.PATH = emptyPath;
    await openWorkbench(page, server.url, '/sessions');
    await expect(workbenchTestId(page, 'sessionsLaunchClaude')).toBeDisabled({ timeout: browserTimeout });
    await expect(workbenchTestId(page, 'sessionsLaunchCodex')).toBeDisabled({ timeout: browserTimeout });
    await expect(page.getByText('claude is not on PATH', { exact: true })).toBeVisible();
    await expect(page.getByText('codex is not on PATH', { exact: true })).toBeVisible();
  });
});
