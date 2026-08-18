import { execFile as executeFile } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 8_000;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const buildWorkbench = async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
};

const writePlaygroundProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src', 'hooks'), { recursive: true }),
    symlink(join(workspaceRoot, 'node_modules', '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
    symlink(join(workspaceRoot, 'node_modules', 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'hooks', 'session-start.ts'), [
      'export default (event: { source?: string }) => ({',
      "  additionalContext: `playground:${event.source}`,",
      "  outcome: 'continue' as const,",
      '});',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'review.ts'), [
      "process.stdout.write('playground script stdout\\n');",
      "process.stderr.write('playground script stderr\\n');",
      'process.exitCode = 17;',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'large-output.ts'), "process.stdout.write('x'.repeat(64 * 1024));\n"),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      "import { z } from 'zod';",
      '',
      "const server = new McpServer({ name: 'playground-real-fixture', version: '1.0.0' });",
      "server.registerTool('echo', { description: 'Echo one message.', inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({",
      "  content: [{ type: 'text', text: `Echo: ${message}` }],",
      '}));',
      "server.registerTool('wait', { description: 'Wait until the foreground cancels this operation.' }, async () => new Promise(() => {}));",
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  hooks: { sessionStart: './src/hooks/session-start.ts' },",
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'playground-real-fixture', version: '1.0.0' },",
      "  scripts: { large: './src/large-output.ts', review: './src/review.ts' },",
      "  skills: ['skills/review'],",
      "  targets: ['claude'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

const runRequest = (origin: string) => (response: { readonly request: () => { readonly method: () => string }; readonly url: () => string }): boolean =>
  response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST';

e2e('executes server-owned Playground operations with pinned traces, export, promotion, and cancellation', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  let project: Awaited<ReturnType<typeof createProjectFixture>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    project = await createProjectFixture();
    await writePlaygroundProject(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root: project.root,
    });
    const runBodies: unknown[] = [];
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url() === `${server!.url}/api/playground/runs` && request.method() === 'POST') {
        runBodies.push(JSON.parse(request.postData() ?? 'null'));
      }
    });

    await page.goto(`${server.url}#hooks`);
    await expect(page.getByRole('heading', { name: 'Hooks' })).toBeVisible({ timeout: browserTimeout });
    const hookOption = page.locator('#hook-binding option').first();
    await expect(hookOption).toBeAttached({ timeout: browserTimeout });
    const hookKey = await hookOption.getAttribute('value');
    if (hookKey === null || !hookKey.startsWith('claude/')) throw new Error('Expected the fixture to publish one selectable Claude Hook binding.');
    const hookId = hookKey.slice('claude/'.length);

    await page.goto(`${server.url}#playground`);
    await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#playground-target').selectOption('claude');

    const waitForRun = (): Promise<{ readonly run: { readonly id: string; readonly session: { readonly identity: { readonly epoch: { readonly id: string } } } } }> =>
      page.waitForResponse(runRequest(server!.url)).then(async (response) => response.json());

    await page.locator('#playground-skill-id').fill('skill:review');
    const skillStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('skill.inspected')).toBeVisible({ timeout: browserTimeout });
    await skillStarted;

    await page.locator('#playground-operation').selectOption('hook.simulate');
    await page.locator('#playground-hook').fill(hookId);
    await page.locator('#playground-hook-input').fill(JSON.stringify({
      cwd: '/workspace', sessionId: 'browser-session', source: 'startup', transcriptPath: '/workspace/transcript.json',
    }));
    const hookStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('hook.simulated')).toBeVisible({ timeout: browserTimeout });
    await hookStarted;

    await page.locator('#playground-operation').selectOption('mcp.call-tool');
    await page.locator('#playground-mcp-server').fill('fixture');
    await page.locator('#playground-mcp-tool').fill('echo');
    await page.locator('#playground-mcp-arguments').fill('{"message":"browser"}');
    const mcpStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('mcp.tool.called')).toBeVisible({ timeout: browserTimeout });
    await mcpStarted;

    await page.locator('#playground-mcp-tool').fill('wait');
    await page.locator('#playground-mcp-arguments').fill('{}');
    const waitingStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    const waiting = await waitingStarted;
    const pinnedEpoch = waiting.run.session.identity.epoch.id;
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeEnabled({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });

    await page.getByRole('link', { name: 'Overview' }).click();
    const rebuildCompleted = page.waitForResponse((response) =>
      response.url() === `${server!.url}/api/project/rebuild` && response.request().method() === 'POST' && response.ok(),
    );
    await page.getByRole('button', { name: /Rebuild/u }).click();
    const rebuilt = await rebuildCompleted;
    const rebuiltStatus = await rebuilt.json() as { readonly status: { readonly artifact: { readonly activeEpoch?: { readonly id: string } } } };
    expect(rebuiltStatus.status.artifact.activeEpoch?.id).not.toBe(pinnedEpoch);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('link', { name: 'Playground', exact: true }).click();
    await expect(page.getByText(pinnedEpoch, { exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });

    await page.locator('#playground-target').selectOption('claude');
    await page.locator('#playground-operation').selectOption('script.run');
    await expect(page.locator('#playground-script-id option[value="script:review"]')).toBeAttached({ timeout: browserTimeout });
    await page.locator('#playground-script-id').selectOption('script:review');
    const scriptStarted = waitForRun();
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.getByText('script.completed')).toBeVisible({ timeout: browserTimeout });
    const scriptTrace = await page.locator('.playground-trace').innerText();
    expect(scriptTrace).toContain('playground script stdout');
    expect(scriptTrace).toContain('playground script stderr');
    expect(scriptTrace).toContain('17');
    await scriptStarted;

    await page.locator('#playground-script-id').selectOption('script:large');
    const largeStarted = waitForRun();
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.locator('.playground-trace .playground-json').last()).toContainText('x'.repeat(64), { timeout: browserTimeout });
    await largeStarted;
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole('button', { name: 'Export trace' }).click();
    await expect(page.getByRole('heading', { name: /Exported trace/u })).toBeVisible({ timeout: browserTimeout });
    const firstReference = page.getByRole('checkbox').first();
    await firstReference.check();
    await expect(page.getByText(/events\.jsonl#\d+/u).first()).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Promote to draft eval case' }).click();
    await expect(page.getByRole('heading', { name: /Draft eval case/u })).toBeVisible({ timeout: browserTimeout });

    expect(runBodies).toHaveLength(6);
    expect(runBodies).toContainEqual({ operation: 'script.run', scriptId: 'script:review', target: 'claude' });
    expect(runBodies).toContainEqual({ operation: 'script.run', scriptId: 'script:large', target: 'claude' });
    for (const body of runBodies) {
      expect(body).not.toHaveProperty('epochId');
      expect(body).not.toHaveProperty('path');
      expect(body).not.toHaveProperty('command');
      expect(body).not.toHaveProperty('cwd');
      expect(body).not.toHaveProperty('env');
      expect(body).not.toHaveProperty('evidence');
      expect(body).not.toHaveProperty('outcome');
      expect(body).not.toHaveProperty('session');
      expect(body).not.toHaveProperty('fixture');
      expect(body).not.toHaveProperty('task');
      expect(body).not.toHaveProperty('script');
    }
    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.allSettled(server === undefined ? [] : [server.close()]);
    await Promise.allSettled(project === undefined ? [] : [removeProjectFixture(project.root)]);
  }
});
