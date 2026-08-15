import { execFile as executeFile } from 'node:child_process';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { ArtifactService } from '../../agent-bundle/src/dev/artifact-service.ts';
import { EpochStore } from '../../agent-bundle/src/dev/epoch-store.ts';
import { ProjectEventHub, startForegroundServer } from '../../agent-bundle/src/dev/index.ts';
import { ProjectService } from '../../agent-bundle/src/dev/project-service.ts';
import { SkillDocumentService } from '../../agent-bundle/src/dev/skill-document-service.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';
import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 5_000;

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

const startFrozenEpochServer = async (root: string) => {
  const epochStore = new EpochStore({ projectRoot: root });
  const projectService = new ProjectService({ root });
  const built = await new ArtifactService({ epochStore }).build(await projectService.prepare('build'));
  if (built.outcome !== 'succeeded') throw new Error('Fixture artifact did not build.');
  const status: ProjectStatus = {
    artifact: {
      activeEpoch: built.epoch,
      currentSourceRevision: built.epoch.projectRevision,
      state: 'active',
    },
    build: { state: 'idle' },
    source: { diagnostics: [], revision: built.epoch.projectRevision, state: 'ready' },
  };
  return startForegroundServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    coordinator: {
      close: async () => undefined,
      rebuild: async () => undefined,
      start: async () => undefined,
      status: () => status,
    },
    eventHub: new ProjectEventHub(),
    port: 0,
    skillDocuments: new SkillDocumentService({ epochStore, projectService, root }),
  });
};

const writeMcpPlaygroundProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(join(workspaceRoot, 'node_modules', '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
    symlink(join(workspaceRoot, 'node_modules', 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      "import { z } from 'zod';",
      '',
      "const server = new McpServer({ name: 'playground-fixture', version: '1.0.0' });",
      "server.registerTool('echo', { description: 'Echo one message.', inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({",
      "  content: [{ type: 'text', text: `Echo: ${message}` }],",
      '}));',
      "server.registerTool('wait', { description: 'Wait for cancellation.' }, async () => new Promise(() => {}));",
      "server.registerResource('fixture', 'ui://fixture/resource.txt', { mimeType: 'text/plain' }, async (uri) => ({",
      "  contents: [{ mimeType: 'text/plain', text: 'fixture resource', uri: uri.href }],",
      '}));',
      "server.registerPrompt('fixture', { description: 'Fixture prompt.' }, async () => ({",
      "  messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }],",
      '}));',
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts', env: { NO_COLOR: '1', SECRET_TOKEN: 'fixture-secret' } } } },",
      "  plugin: { name: 'workbench-mcp-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

e2e('opens one real epoch MCP session and keeps its playground operations responsive', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  let project: Awaited<ReturnType<typeof createProjectFixture>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let cleanupFailure: unknown;
  let testFailure: unknown;
  try {
    project = await createProjectFixture();
    await writeMcpPlaygroundProject(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root: project.root,
    });
    const serverUrl = server.url;
    const serverOrigin = new URL(serverUrl).origin;
    const artifact = server.status().artifact;
    if (artifact.state === 'missing') throw new Error('Expected an active fixture artifact epoch.');
    const epochId = artifact.activeEpoch.id;
    const manifest = JSON.parse(await readFile(join(project.root, '.agent-bundle', 'epochs', epochId, 'portable', 'mcp.json'), 'utf8')) as {
      readonly mcpServers: Readonly<{
        readonly fixture: Readonly<{ readonly args?: readonly string[]; readonly command: string }>;
      }>;
    };
    const compiledEntry = manifest.mcpServers.fixture.args?.[0];
    if (compiledEntry === undefined) throw new Error('Expected the fixture MCP manifest to include its compiled entry.');
    const pageErrors: Error[] = [];
    const artifactMcpSessionRequests: string[] = [];
    const runtimeAssetRequests: string[] = [];
    const runtimeMcpSessionRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== serverOrigin) return;
      if (requestUrl.pathname.startsWith('/api/mcp/sessions')) {
        artifactMcpSessionRequests.push(`${request.method()} ${requestUrl.pathname}`);
      }
      if (requestUrl.pathname.startsWith('/api/runtime/assets/')) runtimeAssetRequests.push(requestUrl.pathname);
      if (requestUrl.pathname.startsWith('/api/runtime/mcp/sessions')) runtimeMcpSessionRequests.push(requestUrl.pathname);
    });
    await page.goto(`${serverUrl}#mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    expect(await page.locator('a[href="#runtime"]').count()).toBe(0);
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    const opened = page.waitForResponse((response) =>
      response.url() === `${serverUrl}/api/mcp/sessions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    const openedSession = await (await opened).json() as { readonly session: Readonly<{
      readonly binding: Readonly<{ readonly epochId: string; readonly serverName: string; readonly target: string }>;
      readonly id: string;
    }> };
    expect(openedSession.session.binding).toEqual({ epochId, serverName: 'fixture', target: 'portable' });
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'echo', exact: true })).toBeVisible({ timeout: browserTimeout });
    const prompts = page.locator('[aria-label="Prompts"]');
    const resources = page.locator('[aria-label="Resources"]');
    await expect(prompts.getByRole('button', { name: 'fixture', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(resources.getByText('fixture', { exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(resources.getByRole('button', { name: 'Read ui://fixture/resource.txt' })).toBeVisible({ timeout: browserTimeout });

    await expect(page.getByRole('radio', { name: 'Form' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-tool-arguments-message').fill('equivalent');
    await page.getByRole('button', { name: 'Call echo' }).click();
    const history = page.getByRole('region', { name: 'Invocation history' });
    await expect(history).toContainText('Echo: equivalent', { timeout: browserTimeout });
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await page.locator('#mcp-tool-arguments-raw').fill('{"message":"equivalent"}');
    await page.getByRole('button', { name: 'Call echo' }).click();
    const historyEntries = history.locator('ol > li');
    await expect(historyEntries).toHaveCount(2, { timeout: browserTimeout });
    const [formInvocation, rawInvocation] = (await historyEntries.locator('pre > code').allTextContents()).map((entry) => JSON.parse(entry));
    const expectedInvocation = {
      request: { arguments: { message: 'equivalent' }, name: 'echo' },
      result: { content: [{ text: 'Echo: equivalent', type: 'text' }] },
    };
    expect({ request: formInvocation.request, result: formInvocation.result }).toEqual(expectedInvocation);
    expect({ request: rawInvocation.request, result: rawInvocation.result }).toEqual(expectedInvocation);
    await page.getByRole('button', { name: /Replay mcp-page-1/u }).click();
    await expect(historyEntries).toHaveCount(3, { timeout: browserTimeout });
    const replayEntry = historyEntries.nth(2);
    await expect(replayEntry).toContainText('Replay of mcp-page-1', { timeout: browserTimeout });
    const replayInvocation = JSON.parse(await replayEntry.locator('pre > code').textContent() ?? 'null');
    expect({ request: replayInvocation.request, result: replayInvocation.result }).toEqual(expectedInvocation);
    const rawTrace = page.getByRole('tabpanel').locator('ol > li > pre > code');
    await expect.poll(async () => (await rawTrace.allTextContents()).some((entry) => {
      const trace = JSON.parse(entry) as Readonly<{
        readonly direction?: string;
        readonly kind?: string;
        readonly message?: Readonly<{ readonly jsonrpc?: string; readonly method?: string; readonly params?: Readonly<{
          readonly arguments?: Readonly<{ readonly message?: string }>;
          readonly name?: string;
        }> }>;
        readonly sequence?: number;
      }>;
      return trace.direction === 'client' && trace.kind === 'frame' && trace.message?.jsonrpc === '2.0' &&
        trace.message.method === 'tools/call' && trace.message.params?.name === 'echo' &&
        trace.message.params.arguments?.message === 'equivalent' && typeof trace.sequence === 'number' &&
        Number.isSafeInteger(trace.sequence) && trace.sequence > 0;
    }), { timeout: browserTimeout }).toBe(true);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Inspector config' }).click();
    const inspectorDownload = await download;
    expect(inspectorDownload.suggestedFilename()).toBe(`mcp-${openedSession.session.id}-inspector.json`);
    const downloadPath = await inspectorDownload.path();
    if (downloadPath === null) throw new Error('Expected the Inspector config download to persist to disk.');
    const inspectorConfig = JSON.parse(await readFile(downloadPath, 'utf8'));
    expect(inspectorConfig).toEqual({
      launch: {
        args: ['[REDACTED]'],
        command: manifest.mcpServers.fixture.command,
        cwd: join(project.root, '.agent-bundle', 'epochs', epochId, 'portable'),
        env: { NO_COLOR: '1' },
        kind: 'stdio',
      },
      origin: 'artifact',
    });
    expect(JSON.stringify(inspectorConfig)).not.toContain(compiledEntry);
    expect(JSON.stringify(inspectorConfig)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(inspectorConfig)).not.toContain('fixture-secret');

    await page.getByRole('button', { name: 'wait', exact: true }).click();
    await page.getByRole('button', { name: 'Call wait' }).click();
    const cancel = page.getByRole('button', { name: /Cancel mcp-page-/u });
    await expect(cancel).toBeVisible({ timeout: browserTimeout });
    await cancel.click();
    await expect(cancel).toBeHidden({ timeout: browserTimeout });

    await page.getByRole('button', { name: 'Close MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session closed', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Reset MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session idle', { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Open MCP session' })).toBeEnabled({ timeout: browserTimeout });
    await expect(history).toContainText('No completed invocations yet.', { timeout: browserTimeout });
    const reopened = page.waitForResponse((response) =>
      response.url() === `${serverUrl}/api/mcp/sessions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    const reopenedSession = await (await reopened).json() as { readonly session: Readonly<{ readonly id: string }> };
    expect(reopenedSession.session.id).not.toBe(openedSession.session.id);
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    expect(artifactMcpSessionRequests).toContain('POST /api/mcp/sessions');
    expect(artifactMcpSessionRequests.some((request) => request.startsWith('POST /api/mcp/sessions/'))).toBe(true);
    expect(runtimeAssetRequests).toEqual([]);
    expect(runtimeMcpSessionRequests).toEqual([]);
    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    testFailure = error;
  } finally {
    const serverCleanup = await Promise.allSettled(server === undefined ? [] : [server.close()]);
    const projectCleanup = await Promise.allSettled(project === undefined ? [] : [removeProjectFixture(project.root)]);
    const failedCleanup = [...serverCleanup, ...projectCleanup].find((result) => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') cleanupFailure = failedCleanup.reason;
  }
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});

e2e('renders and rebuilds the complete responsive Overview against a real foreground server', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await writeFile(project.skillSource, `${project.skillMarkdown}\n\`\`\`mermaid\ngraph TD\n\`\`\`\n\n\`\`\`not-a-shiki-language\nplain fallback\n\`\`\`\n`);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const asyncScripts = new Set<string>();
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && request.url().includes('/static/js/async/')) asyncScripts.add(request.url());
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    for (const name of ['Normalization summary', 'Artifact epoch', 'Generated targets', 'Diagnostics (0)', 'Next action']) {
      await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });

    await page.getByRole('link', { name: 'Skills' }).click();
    await expect(page.locator('#skills .skills-page-heading > div > h1')).toHaveText('Skills', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
    const renderedTab = page.getByRole('tab', { name: 'Rendered' });
    const sourceTab = page.getByRole('tab', { name: 'Source' });
    const generatedTab = page.getByRole('tab', { name: 'Generated' });
    await expect(renderedTab).toBeVisible({ timeout: browserTimeout });
    await renderedTab.focus();
    await page.keyboard.press('End');
    await expect.poll(() => generatedTab.evaluate((element) => document.activeElement === element), { timeout: browserTimeout }).toBe(true);
    await expect(generatedTab).toHaveAttribute('aria-selected', 'true');
    await expect(generatedTab).toHaveAttribute('aria-controls', 'skill-review-panel');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /-tab-generated$/u);
    await page.keyboard.press('Home');
    await expect.poll(() => renderedTab.evaluate((element) => document.activeElement === element), { timeout: browserTimeout }).toBe(true);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => sourceTab.evaluate((element) => document.activeElement === element), { timeout: browserTimeout }).toBe(true);
    await expect(page.locator('.skill-source')).toContainText('---', { timeout: browserTimeout });
    await generatedTab.click();
    await expect(page.getByText(/Generated base ·/)).toBeVisible({ timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.locator('#skills .skills-page-heading > div > h1')).toHaveText('Skills', { timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });

    const rebuild = page.getByRole('button', { name: 'Rebuild' });
    let rebuildPosts = 0;
    await page.route('**/api/project/rebuild', async (route) => {
      rebuildPosts += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      await route.continue();
    });
    const response = page.waitForResponse((candidate) =>
      candidate.request().method() === 'POST' && candidate.url() === `${server.url}/api/project/rebuild`);
    await rebuild.click();
    await expect(page.getByRole('button', { name: 'Rebuilding…' })).toBeDisabled({ timeout: browserTimeout });
    await response;
    expect(rebuildPosts).toBe(1);
    await expect(rebuild).toBeEnabled({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });

    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('loads the lazy Shiki chunk only after a fenced non-Mermaid Skill is rendered', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await writeFile(project.skillSource, `${project.skillMarkdown}\n\`\`\`ts\nconst answer: number = 42;\n\`\`\`\n`);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const asyncScripts = new Set<string>();
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && request.url().includes('/static/js/async/')) asyncScripts.add(request.url());
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.getByRole('link', { name: 'Skills' }).click();
    await expect(page.locator('.skill-code-block')).toContainText('const answer: number = 42;', { timeout: browserTimeout });
    await expect.poll(() => asyncScripts.size, { timeout: browserTimeout }).toBeGreaterThan(0);
    await expect(page.locator('.skill-shiki')).toContainText('const answer: number = 42;', { timeout: browserTimeout });
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('delivers active Skill resources as downloads without letting their page script access the foreground session', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await writeFile(join(project.skillDir, 'assets', 'probe.html'), [
    '<script>',
    'window.__skillResourceExecuted = true;',
    "fetch('/api/project/session');",
    '</script>',
    '',
  ].join('\n'));
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    let protectedRequests = 0;
    page.on('request', (request) => {
      if (/\/api\/project\/(?:session|rebuild)$/u.test(request.url())) protectedRequests += 1;
    });
    const download = page.waitForEvent('download');
    await page.goto(`${server.url}/api/skills/source/skill%3Areview/resources/assets/probe.html`).catch(() => undefined);
    const attachment = await download;

    expect(attachment.suggestedFilename()).toBe('probe.html');
    expect(protectedRequests).toBe(0);
    expect(await page.evaluate(() => (globalThis as { readonly __skillResourceExecuted?: boolean }).__skillResourceExecuted)).toBeUndefined();
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('lists an immutable epoch Skill tree even after the current source Skill is renamed', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const server = await startFrozenEpochServer(project.root);
  try {
    const renamed = join(project.root, 'skills', 'revised');
    await rename(project.skillDir, renamed);
    await writeFile(join(renamed, 'SKILL.md'), project.skillMarkdown.replace('name: review', 'name: revised'));

    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('link', { name: 'Skills' }).click();
    await expect(page.locator('.skill-tree-item')).toContainText('revised', { timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Generated' }).click();
    await expect(page.locator('.skill-tree-item')).toContainText('review', { timeout: browserTimeout });
    await expect(page.getByText(/Generated base ·/)).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('retains the Overview and marks the foreground connection unavailable after an event refresh fails', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await page.route('**/api/project/status', (route) => route.fulfill({
      body: JSON.stringify({ diagnostic: { code: 'AB8007', message: 'Request could not be completed.' } }),
      contentType: 'application/json',
      status: 500,
    }));

    await page.getByRole('button', { name: 'Rebuild' }).click();

    await expect(page.getByRole('status')).toContainText('Foreground server unavailable', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
