import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { agentBundleNodeModules, workbenchNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { ProjectEventHub, startForegroundServer } from '../../agent-bundle/src/dev/index.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { browserLaunchOptions, browserTrace, buildWorkbench, waitForWorkbenchIdle, workbenchUrl } from './support/workbench-e2e.ts';
import { expectHeading } from './support/workbench-acceptance.ts';

const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 15_000 * timeScale;
const skillReviewPath = '/routes/skills/skill%3Areview';

const e2e = test.extend({
  playwright: {
    launchOptions: browserLaunchOptions,
    contextOptions: { viewport: { height: 900, width: 1440 } },
    trace: browserTrace,
  } satisfies PlaywrightOptions,
});

const writeMcpPlaygroundProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(join(agentBundleNodeModules, '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
    symlink(join(workbenchNodeModules, 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
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
      '  claude: {},',
      '  codex: {},',
      "  mcp: { servers: { fixture: { entry: './src/server.ts', env: { NO_COLOR: '1', SECRET_TOKEN: 'fixture-secret' } } } },",
      "  portable: { fixtureMarker: 'artifact-extension-initial' },",
      "  plugin: { name: 'workbench-mcp-fixture', version: '1.0.0' },",
      "  skills: ['src/skills/review'],",
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
    const modelDigest = artifact.activeEpoch.modelDigest;
    await expect(server.openRuntimeClientSurface('mcp.edit-timeline')).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile(join(project.root, '.agent-bundle', 'epochs', epochId, 'mcp.json'), 'utf8')) as {
      readonly mcpServers: Readonly<{
        readonly fixture: Readonly<{ readonly args?: readonly string[]; readonly command: string }>;
      }>;
    };
    const compiledEntry = manifest.mcpServers.fixture.args?.[0];
    if (compiledEntry === undefined) throw new Error('Expected the fixture MCP manifest to include its compiled entry.');
    const pageErrors: Error[] = [];
    const artifactMcpSessionRequests: string[] = [];
    const projectEventRequests: string[] = [];
    const runtimeRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== serverOrigin) return;
      if (requestUrl.pathname.startsWith('/api/mcp/sessions')) {
        artifactMcpSessionRequests.push(`${request.method()} ${requestUrl.pathname}`);
      }
      if (requestUrl.pathname === '/api/project/events') projectEventRequests.push(`${request.method()} ${requestUrl.pathname}`);
      if (requestUrl.pathname.startsWith('/api/runtime/')) runtimeRequests.push(`${request.method()} ${requestUrl.pathname}`);
    });
    await page.goto(`${serverUrl}/advanced/protocol`);
    await expectHeading(page, 'MCP playground');
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
    await expectHeading(page, 'Tools');
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
        cwd: join(project.root, '.agent-bundle', 'epochs', epochId),
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

    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    const close = page.getByRole('button', { name: 'Close MCP session' });
    await expect(close).toBeEnabled({ timeout: browserTimeout });
    await close.click();
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

    const initialConfigValue = 'artifact-extension-initial';
    const changedConfigValue = `artifact-extension-${Math.random().toString(36).slice(2)}`;
    const configPath = join(project.root, 'agent-bundle.config.ts');
    const sourceConfig = await readFile(configPath, 'utf8');
    const changedConfig = sourceConfig.replace(initialConfigValue, changedConfigValue);
    expect(changedConfig).not.toBe(sourceConfig);
    await replaceWatchedSource(project.root, configPath, changedConfig);
    await expect.poll(() => {
      const next = server!.status().artifact;
      return next.state === 'active' && next.activeEpoch.id !== epochId && next.activeEpoch.modelDigest !== modelDigest
        ? next.activeEpoch
        : undefined;
    }, { timeout: browserTimeout }).toEqual(expect.objectContaining({ modelDigest: expect.any(String) }));
    const changedArtifact = server.status().artifact;
    if (changedArtifact.state === 'missing') throw new Error('Registered extension update removed the active artifact epoch.');
    expect(changedArtifact.activeEpoch.id).not.toBe(epochId);
    expect(changedArtifact.activeEpoch.modelDigest).not.toBe(modelDigest);
    await expect(server.openRuntimeClientSurface('mcp.edit-timeline')).resolves.toBeUndefined();
    expect(await page.locator('body').textContent()).not.toContain(initialConfigValue);
    expect(await page.locator('body').textContent()).not.toContain(changedConfigValue);
    await expectHeading(page, 'MCP playground');
    expect(artifactMcpSessionRequests).toContain('POST /api/mcp/sessions');
    expect(artifactMcpSessionRequests.some((request) => request.startsWith('POST /api/mcp/sessions/'))).toBe(true);
    expect(runtimeRequests).toEqual([]);
    expect(projectEventRequests).toEqual(['GET /api/project/events']);
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
    await waitForWorkbenchIdle(page, browserTimeout);
    await expect(page.getByTestId('workspace-empty')).toBeVisible({ timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.goto(workbenchUrl(server.url, skillReviewPath));
    await expect(page.getByLabel('review Skill').getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
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
    await waitForWorkbenchIdle(page, browserTimeout);
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

e2e('gates the Workbench and resets browser-local state for a same-origin replacement foreground generation', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await writeMcpPlaygroundProject(project.root);
  const eventHubs: ProjectEventHub[] = [];
  const sessions = [
    { instanceId: 'foreground-a', token: 'foreground-token-a' },
    { instanceId: 'foreground-b', token: 'foreground-token-b' },
  ];
  let started = 0;
  const startRestartableServer = async (port: number) => startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port,
    root: project.root,
    testing: {
      startForegroundServer: async (options) => {
        const session = sessions[started];
        started += 1;
        if (session === undefined) throw new Error('Unexpected foreground server restart.');
        eventHubs.push(options.eventHub);
        return startForegroundServer({ ...options, instanceId: session.instanceId, sessionToken: session.token });
      },
    },
  });
  let server = await startRestartableServer(0);
  const pageErrors: Error[] = [];
  const releasedMcpSessions: Readonly<{ readonly token: string | undefined }>[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && /\/api\/mcp\/sessions\/[^/]+$/u.test(new URL(request.url()).pathname)) {
      releasedMcpSessions.push({ token: request.headers()['x-agent-bundle-session'] });
    }
  });
  try {
    await page.goto(`${server.url}/advanced/protocol`);
    await expectHeading(page, 'MCP playground');
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.locator('.connection-content').evaluate((element) => {
      element.setAttribute('data-recovery-probe', 'foreground-a');
    });

    const port = Number(new URL(server.url).port);
    await server.close();
    await expectHeading(page, 'Foreground connection unavailable');
    const retainedNavigation = page.getByTestId('workbench-nav').getByRole('link', { name: 'Application' });
    await expect(page.locator('.connection-content')).toHaveAttribute('inert', '');
    await expect(retainedNavigation).toBeVisible();
    await retainedNavigation.focus();
    expect(await retainedNavigation.evaluate((element) => element === document.activeElement)).toBe(false);

    server = await startRestartableServer(port);
    await expectHeading(page, 'MCP playground');
    await expect(page.locator('.connection-content')).not.toHaveAttribute('data-recovery-probe', 'foreground-a');
    await expect(page.locator('#mcp-target')).toHaveValue('portable');
    await expect(page.locator('#mcp-server-name')).toHaveValue('fixture');
    await expect(page.getByRole('button', { name: 'Open MCP session' })).toBeEnabled({ timeout: browserTimeout });
    await expect.poll(() => releasedMcpSessions.length, { timeout: browserTimeout }).toBe(1);
    expect(releasedMcpSessions).toEqual([{ token: 'foreground-token-a' }]);

    await page.goto(`${server.url}/problems`);
    await expect(page.getByRole('heading', { name: /^Problems/u })).toBeVisible({ timeout: browserTimeout });
    const rebuild = page.getByTestId('problems-repair');
    const rebuildRequest = page.waitForRequest((request) =>
      request.method() === 'POST' && request.url() === `${server.url}/api/project/rebuild`);
    const rebuildResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url() === `${server.url}/api/project/rebuild`, { timeout: 60_000 });
    await rebuild.click();
    expect((await rebuildRequest).headers()['x-agent-bundle-session']).toBe('foreground-token-b');
    expect((await rebuildResponse).status()).toBe(200);
    await expect(rebuild).toBeEnabled({ timeout: 60_000 });
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.allSettled([server.close()]);
    await removeProjectFixture(project.root);
  }
});
