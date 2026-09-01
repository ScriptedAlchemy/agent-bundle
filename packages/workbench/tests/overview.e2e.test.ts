import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';
import type { Locator, Page } from 'playwright';

import { agentBundleNodeModules, workbenchNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { createDefaultRegistry } from '../../agent-bundle/src/adapters/registry.ts';
import { ArtifactInspectionService } from '../../agent-bundle/src/dev/artifacts/artifact-inspection-service.ts';
import { ArtifactService } from '../../agent-bundle/src/dev/artifacts/artifact-service.ts';
import { EpochStore } from '../../agent-bundle/src/dev/epoch-store.ts';
import { EvalService } from '../../agent-bundle/src/dev/eval/eval-service.ts';
import { ProjectEventHub, runtimeClientSurfaceReloadChannelPath, startForegroundServer } from '../../agent-bundle/src/dev/index.ts';
import { ProjectService } from '../../agent-bundle/src/dev/project-service.ts';
import { SkillDocumentService } from '../../agent-bundle/src/dev/skill-document-service.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';
import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { buildWorkbench } from './support/workbench-e2e.ts';

const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 15_000 * timeScale;

interface RuntimeAppOperation {
  readonly body: unknown;
  readonly path: string;
  readonly response?: unknown;
}

interface RuntimeAppWireMessage {
  readonly href: string;
  readonly message: unknown;
  readonly senderOrigin: string;
}

const requestBody = (body: string | null): unknown => {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const startFrozenEpochServer = async (root: string) => {
  const registry = createDefaultRegistry();
  const epochStore = new EpochStore({ projectRoot: root });
  const projectService = new ProjectService({ registry, root });
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
  const eventHub = new ProjectEventHub();
  const evals = new EvalService({ projectRoot: root, registry });
  const server = await startForegroundServer({
    artifacts: new ArtifactInspectionService(epochStore, registry),
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    coordinator: {
      close: async () => undefined,
      rebuild: async () => undefined,
      start: async () => undefined,
      status: () => status,
    },
    evalLifecycle: evals,
    evals,
    eventHub,
    port: 0,
    skillDocuments: new SkillDocumentService({ epochStore, projectService, root }),
  });
  return { eventHub, server };
};

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
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

e2e('preserves a direct Runtime deep link until capability discovery succeeds', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  let releaseRuntimeStatus = (): void => undefined;
  const runtimeStatusGate = new Promise<void>((resolve) => { releaseRuntimeStatus = resolve; });
  let runtimeStatusRequests = 0;
  await page.route(`${fixture.url}/api/runtime/status`, async (route) => {
    runtimeStatusRequests += 1;
    await runtimeStatusGate;
    await route.continue();
  });
  try {
    await page.goto(`${fixture.url}#runtime`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => runtimeStatusRequests, { timeout: browserTimeout }).toBe(1);
    expect(new URL(page.url()).hash).toBe('#runtime');

    releaseRuntimeStatus();
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    expect(new URL(page.url()).hash).toBe('#runtime');
  } finally {
    releaseRuntimeStatus();
    await fixture.close();
  }
});

e2e('redirects a direct Runtime deep link only after capability discovery reports unavailable', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const { server } = await startFrozenEpochServer(project.root);
  let releaseProjectStatus = (): void => undefined;
  const projectStatusGate = new Promise<void>((resolve) => { releaseProjectStatus = resolve; });
  let projectStatusRequests = 0;
  await page.route(`${server.url}/api/project/status`, async (route) => {
    projectStatusRequests += 1;
    await projectStatusGate;
    await route.continue();
  });
  try {
    await page.goto(`${server.url}#runtime`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => projectStatusRequests, { timeout: browserTimeout }).toBe(1);
    expect(new URL(page.url()).hash).toBe('#runtime');

    releaseProjectStatus();
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    expect(new URL(page.url()).hash).toBe('#overview');
    expect(await page.locator('a[href="#runtime"]').count()).toBe(0);
  } finally {
    releaseProjectStatus();
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('offers the host-owned MCP playground handoff only after a selected Runtime App succeeds', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  let clientPage: Page | undefined;
  let clientSurface: Awaited<ReturnType<typeof fixture.openRuntimeClientSurface>> | undefined;
  const pageErrors: Error[] = [];
  const artifactMcpSessionRequests: string[] = [];
  const projectEventStreams: string[] = [];
  const runtimeAppRequests: string[] = [];
  const runtimeAppResponses: unknown[] = [];
  const runtimeAppOperationRequests: RuntimeAppOperation[] = [];
  const runtimeAppOperationResponses: RuntimeAppOperation[] = [];
  const runtimeAppWireMessages: RuntimeAppWireMessage[] = [];
  const runtimeMcpSessionRequests: string[] = [];
  const runtimePreviewHmrSockets: string[] = [];
  const runtimePreviewHmrMessages: string[] = [];
  await page.exposeBinding('__recordOverviewRuntimeAppMessage', (_source, payload: unknown) => {
    if (payload !== null && typeof payload === 'object') runtimeAppWireMessages.push(payload as RuntimeAppWireMessage);
  });
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message === null || typeof message !== 'object' || (message as { readonly jsonrpc?: unknown }).jsonrpc !== '2.0') return;
      const record = (globalThis as typeof globalThis & {
        __recordOverviewRuntimeAppMessage?: (payload: unknown) => Promise<void>;
      }).__recordOverviewRuntimeAppMessage;
      if (record !== undefined) void record({ href: window.location.href, message, senderOrigin: event.origin });
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== runtimeClientSurfaceReloadChannelPath) return;
    runtimePreviewHmrSockets.push(socket.url());
    socket.on('framereceived', (frame) => {
      runtimePreviewHmrMessages.push(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString());
    });
  });
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== fixture.url) return;
    if (requestUrl.pathname.startsWith('/api/mcp/sessions')) artifactMcpSessionRequests.push(`${request.method()} ${requestUrl.pathname}`);
    if (requestUrl.pathname === '/api/project/events') projectEventStreams.push(`${request.method()} ${requestUrl.pathname}`);
    if (requestUrl.pathname.startsWith('/api/runtime/apps')) {
      runtimeAppRequests.push(`${request.method()} ${requestUrl.pathname}`);
      if (request.method() === 'POST' && requestUrl.pathname.endsWith('/operations')) {
        runtimeAppOperationRequests.push(Object.freeze({ body: requestBody(request.postData()), path: requestUrl.pathname }));
      }
    }
    if (requestUrl.pathname.startsWith('/api/runtime/mcp/sessions')) {
      runtimeMcpSessionRequests.push(`${request.method()} ${requestUrl.pathname}`);
    }
  });
  page.on('response', (response) => {
    const requestUrl = new URL(response.url());
    if (requestUrl.origin !== fixture.url || response.request().method() !== 'POST') return;
    if (requestUrl.pathname === '/api/runtime/apps') {
      void response.json().then((body: unknown) => { runtimeAppResponses.push(body); }).catch(() => undefined);
    }
    if (requestUrl.pathname.endsWith('/operations')) {
      void response.json().then((body: unknown) => {
        runtimeAppOperationResponses.push(Object.freeze({
          body: requestBody(response.request().postData()),
          path: requestUrl.pathname,
          response: body,
        }));
      }).catch(() => undefined);
    }
  });
  try {
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    const runtimeIdentity = page.locator('[data-runtime-provider-session]');
    const runtimeSurface = page.getByLabel('Runtime surface');
    await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: browserTimeout });
    await runtimeSurface.selectOption('mcp.edit-timeline');
    clientSurface = await fixture.openRuntimeClientSurface('mcp.edit-timeline');
    if (clientSurface === undefined) throw new Error('Runtime client surface was not available.');
    clientPage = await page.context().newPage();
    clientPage.on('pageerror', (error) => pageErrors.push(error));
    const bootstrapResponse = await clientPage.goto(clientSurface.bootstrapUrl, { waitUntil: 'domcontentloaded' });
    expect(bootstrapResponse?.status()).toBe(200);
    await expect.poll(async () => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: browserTimeout }).toBe('1');
    await expect(page.locator('.runtime-status')).toHaveText('HMR endpoint ready · active', { timeout: browserTimeout });
    await runtimeSurface.selectOption('mcp.render_edit_timeline');
    await page.getByLabel('Runtime target').selectOption('portable');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await page.locator('#runtime-input-raw').fill('{}');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li').count(), { timeout: browserTimeout }).toBeGreaterThan(0);

    await expect(page.getByRole('button', { name: 'Open in MCP playground' })).toBeEnabled({ timeout: browserTimeout });
    await expect.poll(() => runtimeAppRequests.filter((request) => request === 'POST /api/runtime/apps').length, { timeout: browserTimeout }).toBe(1);
    await expect.poll(() => runtimeAppResponses.length, { timeout: browserTimeout }).toBe(1);
    const expectedRegisteredConfiguration = [
      { configured: true, id: 'extension:claude', key: 'claude', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'claude' },
      { configured: true, id: 'extension:codex', key: 'codex', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'codex' },
      { configured: true, id: 'extension:portable', key: 'portable', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'portable' },
    ] as const;
    const configInspection = (runtimeAppResponses[0] as {
      readonly preview: { readonly kind: string; readonly profile: { readonly configExtensions: unknown } };
    }).preview.profile.configExtensions;
    expect(runtimeAppResponses[0]).toMatchObject({ preview: { kind: 'apps' } });
    expect(configInspection).toEqual({ entries: expectedRegisteredConfiguration, sourceRevision: expect.any(String) });
    const configInspectionSnapshot = JSON.stringify(configInspection);
    const sourceRevision = (configInspection as { readonly sourceRevision: string }).sourceRevision;
    expect(sourceRevision.length).toBeGreaterThan(0);
    type ProjectSourceStatus = Readonly<{
      readonly diagnostics: readonly Readonly<{ readonly code: string; readonly message: string }>[];
      readonly revision?: string;
      readonly state: string;
    }>;
    const readProjectSource = async (): Promise<ProjectSourceStatus> => page.evaluate(async (origin) => {
      const response = await fetch(new URL('/api/project/status', origin));
      if (!response.ok) throw new Error(`Project status failed with ${String(response.status)}.`);
      return (await response.json() as { readonly status: { readonly source: ProjectSourceStatus } }).status.source;
    }, fixture.url);
    type RuntimeStatus = Readonly<{
      readonly activeVector?: Readonly<{ readonly providerSessionId: string }>;
      readonly diagnostics: readonly Readonly<{ readonly code?: string; readonly message?: string }>[];
      readonly state: string;
    }>;
    const readRuntimeStatus = async (): Promise<RuntimeStatus> => page.evaluate(async (origin) => {
      const response = await fetch(new URL('/api/runtime/status', origin));
      if (!response.ok) throw new Error(`Runtime status failed with ${String(response.status)}.`);
      return (await response.json() as { readonly status: RuntimeStatus }).status;
    }, fixture.url);
    const initialProjectSource = await readProjectSource();
    // Pin flip (#94 stages 1-2): source status now carries the package identity derived from package.json.
    expect(initialProjectSource).toEqual({ diagnostics: [], packageName: '@agent-bundle/rsc-agent-runtime-demo', revision: sourceRevision, state: 'ready' });
    const expectRuntimeProfileInspection = async (preview: Locator, expectedSourceRevision: string): Promise<void> => {
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText('Portable MCP Apps');
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText('agent-bundle:mcp-apps:2026-01-26');
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText('Not certified for real-host parity');
      const configuration = preview.getByLabel('Registered configuration');
      await expect(configuration).toContainText(expectedSourceRevision);
      await expect(configuration.getByRole('listitem')).toHaveCount(3);
      await expect(configuration.getByRole('listitem').nth(0)).toContainText('extension:claude');
      await expect(configuration.getByRole('listitem').nth(1)).toContainText('extension:codex');
      await expect(configuration.getByRole('listitem').nth(2)).toContainText('extension:portable');
    };
    await page.locator('iframe').waitFor({ state: 'attached', timeout: browserTimeout });
    await expectRuntimeProfileInspection(page.locator('.runtime-stage .mcp-app-preview'), sourceRevision);
    const sourceBinding = (runtimeAppResponses[0] as {
      readonly preview: { readonly binding: Readonly<{
        readonly id: string;
        readonly runVector: Readonly<{ readonly runtimeGenerationId: string; readonly sourceRevision: string; readonly stateVersion: number }>;
        readonly sessionId: string;
        readonly sessionRevision: number;
      }> };
    }).preview.binding;
    expect(sourceBinding).toMatchObject({
      id: expect.any(String),
      runVector: { runtimeGenerationId: expect.any(String), sourceRevision: expect.any(String), stateVersion: expect.any(Number) },
      sessionId: expect.any(String),
      sessionRevision: expect.any(Number),
    });
    const sourcePreview = page.locator('.runtime-stage .mcp-app-preview iframe');
    await expect(sourcePreview).toBeVisible({ timeout: browserTimeout });
    const sourcePreviewHandle = await sourcePreview.elementHandle();
    if (sourcePreviewHandle === null) throw new Error('Runtime App outer preview iframe was unavailable.');
    const sourcePreviewUrl = await sourcePreviewHandle.getAttribute('src');
    if (sourcePreviewUrl === null) throw new Error('Runtime App outer preview iframe did not expose its binding source.');
    const hmrSentinel = `runtime-hmr-sentinel-${Math.random().toString(36).slice(2)}`;
    await sourcePreviewHandle.evaluate((element, value) => { element.setAttribute('data-runtime-hmr-sentinel', value); }, hmrSentinel);
    const source = await readFile(fixture.widgetAppSource, 'utf8');
    const styles = await readFile(fixture.appStyles, 'utf8');
    const hmrMarker = `Runtime HMR marker ${Math.random().toString(36).slice(2)}`;
    const editedSource = source.replace(
      '<h1>Runtime edit timeline</h1>',
      `<h1>Runtime edit timeline</h1><p data-testid="runtime-hmr-marker">${hmrMarker}</p>`,
    );
    const editedStyles = `${styles}\n.timeline__header [data-testid="runtime-hmr-marker"] { color: rgb(1, 2, 3); }\n`;
    expect(editedSource).not.toBe(source);
    await Promise.all([
      replaceWatchedSource(fixture.root, fixture.widgetAppSource, editedSource),
      replaceWatchedSource(fixture.root, fixture.appStyles, editedStyles),
    ]);
    // The owned reload channel carries provider-authored frames only; a
    // changed App compile advances the generation past the connect replay.
    const ownedReloadFrames = (): readonly number[] => runtimePreviewHmrMessages.flatMap((message) => {
      try {
        const parsed = JSON.parse(message) as Readonly<{ readonly generation?: unknown; readonly kind?: unknown }>;
        return parsed.kind === 'runtime-app-reload' && typeof parsed.generation === 'number' ? [parsed.generation] : [];
      } catch {
        return [];
      }
    });
    await expect.poll(() => ownedReloadFrames().some((generation) => generation > 0), { timeout: browserTimeout })
      .toBe(true);
    const refreshedWidget = async () => {
      for (const frame of page.frames()) {
        if (await frame.getByTestId('runtime-hmr-marker').count() === 1) return frame;
      }
      return undefined;
    };
    await expect.poll(refreshedWidget, { timeout: browserTimeout }).toBeDefined();
    const refreshedFrame = await refreshedWidget();
    if (refreshedFrame === undefined) throw new Error('Runtime App did not receive the App compiler full reload.');
    await expect(refreshedFrame.getByTestId('runtime-hmr-marker')).toHaveText(hmrMarker);
    await expect(refreshedFrame.getByTestId('runtime-hmr-marker')).toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(await sourcePreviewHandle.evaluate((element) => element.isConnected &&
      document.querySelector('.runtime-stage .mcp-app-preview iframe') === element)).toBe(true);
    expect(await sourcePreviewHandle.getAttribute('data-runtime-hmr-sentinel')).toBe(hmrSentinel);
    expect(await sourcePreviewHandle.getAttribute('src')).toBe(sourcePreviewUrl);
    expect(runtimePreviewHmrSockets).toHaveLength(1);
    expect(runtimeAppRequests.filter((request) => request === 'POST /api/runtime/apps')).toHaveLength(1);
    expect(runtimeAppRequests.filter((request) => request.startsWith('DELETE /api/runtime/apps/'))).toHaveLength(0);
    expect(runtimeAppResponses).toHaveLength(1);
    const hmrMessagesBeforeConfigReconcile = [...runtimePreviewHmrMessages];
    const runtimeAttribute = async (name: string): Promise<string> => {
      const value = await runtimeIdentity.getAttribute(name);
      if (value === null) throw new Error(`Runtime identity omitted ${name}.`);
      return value;
    };
    const sourceRuntimeIdentity = {
      hmrClients: await runtimeAttribute('data-runtime-hmr-client-count'),
      providerSession: await runtimeAttribute('data-runtime-provider-session'),
      sourceRevision: await runtimeAttribute('data-runtime-source-revision'),
      stateVersion: await runtimeAttribute('data-runtime-state-version'),
    };
    const expectOriginalPreview = async (): Promise<void> => {
      await expectRuntimeProfileInspection(page.locator('.runtime-stage .mcp-app-preview'), sourceRevision);
      expect(JSON.stringify((runtimeAppResponses[0] as {
        readonly preview: { readonly profile: { readonly configExtensions: unknown } };
      }).preview.profile.configExtensions)).toBe(configInspectionSnapshot);
      expect(await sourcePreviewHandle.evaluate((element) => element.isConnected &&
        document.querySelector('.runtime-stage .mcp-app-preview iframe') === element)).toBe(true);
      await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-client-count', sourceRuntimeIdentity.hmrClients);
      await expect(runtimeIdentity).toHaveAttribute('data-runtime-provider-session', sourceRuntimeIdentity.providerSession);
      await expect(runtimeIdentity).toHaveAttribute('data-runtime-source-revision', sourceRuntimeIdentity.sourceRevision);
      await expect(runtimeIdentity).toHaveAttribute('data-runtime-state-version', sourceRuntimeIdentity.stateVersion);
      expect(runtimePreviewHmrSockets).toHaveLength(1);
      expect(runtimePreviewHmrMessages).toEqual(hmrMessagesBeforeConfigReconcile);
      expect(runtimeAppRequests.filter((request) => request === 'POST /api/runtime/apps')).toHaveLength(1);
      expect(runtimeAppRequests.filter((request) => request.startsWith('DELETE /api/runtime/apps/'))).toHaveLength(0);
      expect(runtimeAppResponses).toHaveLength(1);
    };
    const expectRetainedRuntime = async (): Promise<void> => {
      const status = await readRuntimeStatus();
      expect(status.state).toBe('active');
      expect(status.activeVector?.providerSessionId).toBe(sourceRuntimeIdentity.providerSession);
      expect(status.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('AB8200');
      expect(status.diagnostics.map((diagnostic) => diagnostic.message)).not.toContain('Development runtime declaration changed; restart required.');
    };
    const sourceConfig = await readFile(fixture.configSource, 'utf8');
    const finiteConfigMarker = `config-reconcile-finite-${Math.random().toString(36).slice(2)}`;
    const finiteConfig = sourceConfig.replace('  codex: {},', `  codex: { configReconcileMarker: '${finiteConfigMarker}' },`);
    expect(finiteConfig).not.toBe(sourceConfig);
    await replaceWatchedSource(fixture.root, fixture.configSource, finiteConfig);
    // Config reconcile polls scale with contention: each reconcile recompiles
    // the config plus the rsc/widget/app bundles (~4s apiece on a pinned
    // two-core runner), so a raw 15s budget fails deterministically under
    // taskset -c 0,1 while the change itself is delivered fine.
    await expect.poll(async () => {
      const source = await readProjectSource();
      return source.state === 'ready' && source.revision !== sourceRevision ? source.revision : undefined;
    }, { timeout: browserTimeout }).toEqual(expect.any(String));
    const finiteSource = await readProjectSource();
    const finiteSourceRevision = finiteSource.revision;
    if (finiteSourceRevision === undefined) throw new Error('Finite configuration update did not expose a source revision.');
    expect(finiteSource.diagnostics).toEqual([]);
    await expectOriginalPreview();
    const invalidConfig = finiteConfig.replace(
      `configReconcileMarker: '${finiteConfigMarker}'`,
      'configReconcileMarker: Number.NaN',
    );
    expect(invalidConfig).not.toBe(finiteConfig);
    await replaceWatchedSource(fixture.root, fixture.configSource, invalidConfig);
    await expect.poll(async () => {
      const source = await readProjectSource();
      const diagnostic = source.diagnostics.find((candidate) => candidate.code === 'AB4500');
      return source.state === 'invalid' && diagnostic?.message === 'A registered config extension must contain strict finite JSON data.'
        ? source
        : undefined;
    }, { timeout: browserTimeout }).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB4500',
        message: 'A registered config extension must contain strict finite JSON data.',
      })],
      state: 'invalid',
    });
    const invalidSource = await readProjectSource();
    expect(invalidSource.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('AB7001');
    await expect(page.getByRole('button', { name: 'Open in MCP playground' })).toBeEnabled();
    await expect(refreshedFrame.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expectOriginalPreview();
    await expectRetainedRuntime();
    const sourceControllerOrigin = new URL(sourcePreviewUrl).origin;
    const resourceUri = 'ui://rsc-agent-runtime/edit-timeline-v1.html';
    const resourceRequestId = `config-reconcile-resource-${Math.random().toString(36).slice(2)}`;
    const resourceOperationPath = `/api/runtime/apps/${encodeURIComponent(sourceBinding.id)}/operations`;
    const resourceOperationRequests = (): readonly RuntimeAppOperation[] => runtimeAppOperationRequests.filter((operation) =>
      operation.path === resourceOperationPath && JSON.stringify(operation.body) === JSON.stringify({ kind: 'resources/read', uri: resourceUri }));
    const resourceOperationResponses = (): readonly RuntimeAppOperation[] => runtimeAppOperationResponses.filter((operation) =>
      operation.path === resourceOperationPath && JSON.stringify(operation.body) === JSON.stringify({ kind: 'resources/read', uri: resourceUri }));
    const wireMessage = (
      receiverOrigin: string,
      senderOrigin: string,
      matches: (message: Readonly<Record<string, unknown>>) => boolean,
    ): RuntimeAppWireMessage | undefined => runtimeAppWireMessages.find((candidate) =>
      new URL(candidate.href).origin === receiverOrigin && candidate.senderOrigin === senderOrigin && candidate.message !== null && typeof candidate.message === 'object' &&
      matches(candidate.message as Readonly<Record<string, unknown>>));
    await refreshedFrame.evaluate(({ id, uri }) => {
      window.parent.postMessage({ id, jsonrpc: '2.0', method: 'resources/read', params: { uri } }, '*');
    }, { id: resourceRequestId, uri: resourceUri });
    await expect.poll(resourceOperationRequests, { timeout: browserTimeout }).toHaveLength(1);
    expect(resourceOperationRequests()[0]?.body).toEqual({ kind: 'resources/read', uri: resourceUri });
    await expect.poll(resourceOperationResponses, { timeout: browserTimeout }).toHaveLength(1);
    const resourceOperationResult = (resourceOperationResponses()[0]?.response as Readonly<{ readonly result?: unknown }> | undefined)?.result;
    expect(resourceOperationResult).toMatchObject({
      operationId: expect.any(String),
      sessionId: sourceBinding.sessionId,
      sessionRevision: sourceBinding.sessionRevision,
      value: {
        contents: [{
          mimeType: 'text/html;profile=mcp-app',
          text: expect.stringMatching(/^<!doctype html>/iu),
          uri: resourceUri,
        }],
      },
      vector: sourceBinding.runVector,
    });
    const resourceValue = (resourceOperationResult as Readonly<{ readonly value?: unknown }> | undefined)?.value;
    if (resourceValue === null || typeof resourceValue !== 'object') throw new Error('Retained Runtime App resource operation omitted its result value.');
    await expect.poll(() => wireMessage(fixture.url, sourceControllerOrigin, (message) =>
      message.id === resourceRequestId && message.method === 'resources/read'), { timeout: browserTimeout }).toBeDefined();
    expect(wireMessage(fixture.url, sourceControllerOrigin, (message) =>
      message.id === resourceRequestId && message.method === 'resources/read')?.message).toEqual({
      id: resourceRequestId,
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: resourceUri },
    });
    await expect.poll(() => wireMessage(sourceControllerOrigin, fixture.url, (message) =>
      message.id === resourceRequestId && Object.hasOwn(message, 'result')), { timeout: browserTimeout }).toBeDefined();
    expect(wireMessage(sourceControllerOrigin, fixture.url, (message) =>
      message.id === resourceRequestId && Object.hasOwn(message, 'result'))?.message).toEqual({
      id: resourceRequestId,
      jsonrpc: '2.0',
      result: resourceValue,
    });
    await expectRetainedRuntime();
    const repairedConfigMarker = `config-reconcile-repaired-${Math.random().toString(36).slice(2)}`;
    const repairedConfig = invalidConfig.replace(
      'configReconcileMarker: Number.NaN',
      `configReconcileMarker: '${repairedConfigMarker}'`,
    );
    await replaceWatchedSource(fixture.root, fixture.configSource, repairedConfig);
    await expect.poll(async () => {
      const source = await readProjectSource();
      return source.state === 'ready' && source.revision !== finiteSourceRevision ? source.revision : undefined;
    }, { timeout: browserTimeout }).toEqual(expect.any(String));
    const repairedSource = await readProjectSource();
    const repairedSourceRevision = repairedSource.revision;
    if (repairedSourceRevision === undefined) throw new Error('Repaired configuration update did not expose a source revision.');
    expect(repairedSource.diagnostics).toEqual([]);
    await expectOriginalPreview();
    const handoff = page.getByRole('button', { name: 'Open in MCP playground' });
    await handoff.click({ timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect.poll(() => runtimeAppRequests.filter((request) => request === 'POST /api/runtime/apps').length, { timeout: browserTimeout }).toBe(2);
    await expect.poll(() => runtimeAppResponses.length, { timeout: browserTimeout }).toBe(2);
    await expect.poll(() => runtimeAppRequests.findIndex((request) => request.startsWith('DELETE /api/runtime/apps/')), { timeout: browserTimeout }).toBeGreaterThan(-1);

    const runtimeDelete = runtimeAppRequests.findIndex((request) => request.startsWith('DELETE /api/runtime/apps/'));
    const secondRuntimeCreate = runtimeAppRequests.lastIndexOf('POST /api/runtime/apps');
    expect(runtimeDelete).toBeGreaterThan(0);
    expect(runtimeDelete).toBeLessThan(secondRuntimeCreate);
    expect(artifactMcpSessionRequests).toEqual([]);
    expect(runtimeMcpSessionRequests.filter((request) => request === 'POST /api/runtime/mcp/sessions')).toEqual([]);
    expect(projectEventStreams).toEqual(['GET /api/project/events']);
    await page.locator('.mcp-page-app-preview iframe').waitFor({ state: 'attached', timeout: browserTimeout });
    expect(await page.locator('.mcp-page-app-preview iframe').count()).toBe(1);
    const handedOffConfigInspection = (runtimeAppResponses[1] as {
      readonly preview: { readonly profile: { readonly configExtensions: { readonly sourceRevision: string } } };
    }).preview.profile.configExtensions;
    expect(handedOffConfigInspection).toEqual({ entries: expectedRegisteredConfiguration, sourceRevision: repairedSourceRevision });
    expect(JSON.stringify(handedOffConfigInspection)).not.toContain(repairedConfigMarker);
    await expectRuntimeProfileInspection(page.locator('.mcp-page-app-preview'), repairedSourceRevision);
    const handedOffBinding = (runtimeAppResponses[1] as {
      readonly preview: { readonly binding: Readonly<{
        readonly id: string;
        readonly runVector: typeof sourceBinding.runVector;
        readonly sessionId: string;
        readonly sessionRevision: number;
      }> };
    }).preview.binding;
    expect(handedOffBinding.id).not.toBe(sourceBinding.id);
    expect(handedOffBinding.runVector).toEqual(sourceBinding.runVector);
    expect(handedOffBinding.sessionId).toBe(sourceBinding.sessionId);
    expect(handedOffBinding.sessionRevision).toBe(sourceBinding.sessionRevision);
    expect(runtimeAppRequests.filter((request) => request === 'POST /api/runtime/apps')).toHaveLength(2);
    expect(runtimeAppRequests.filter((request) => request.startsWith('DELETE /api/runtime/apps/'))).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await clientPage?.close();
    await clientSurface?.close();
    await fixture.close();
  }
});

e2e('keeps runtime MCP routing constrained after direct navigation from a bound source', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  let clientPage: Page | undefined;
  let clientSurface: Awaited<ReturnType<typeof fixture.openRuntimeClientSurface>> | undefined;
  const artifactMcpSessionRequests: string[] = [];
  const unsupportedOperationRequests: string[] = [];
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === fixture.url && requestUrl.pathname.startsWith('/api/mcp/sessions')) {
      artifactMcpSessionRequests.push(`${request.method()} ${requestUrl.pathname}`);
    }
    if (requestUrl.origin === fixture.url && requestUrl.pathname.startsWith('/api/runtime/apps/') && requestUrl.pathname.endsWith('/operations')) {
      unsupportedOperationRequests.push(`${request.method()} ${requestUrl.pathname}`);
    }
  });
  try {
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    const runtimeIdentity = page.locator('[data-runtime-provider-session]');
    const runtimeSurface = page.getByLabel('Runtime surface');
    await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: browserTimeout });
    await runtimeSurface.selectOption('mcp.edit-timeline');
    clientSurface = await fixture.openRuntimeClientSurface('mcp.edit-timeline');
    if (clientSurface === undefined) throw new Error('Runtime client surface was not available.');
    clientPage = await page.context().newPage();
    const bootstrapResponse = await clientPage.goto(clientSurface.bootstrapUrl, { waitUntil: 'domcontentloaded' });
    expect(bootstrapResponse?.status()).toBe(200);
    await expect.poll(async () => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: browserTimeout }).toBe('1');
    await runtimeSurface.selectOption('mcp.render_edit_timeline');
    await page.getByLabel('Runtime target').selectOption('portable');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await page.locator('#runtime-input-raw').fill('{}');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.locator('.runtime-stage .mcp-app-preview iframe').waitFor({ state: 'attached', timeout: browserTimeout });

    await page.getByRole('link', { name: 'MCP playground' }).click();
    await expect(page.getByLabel('Runtime-bound MCP session')).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('#mcp-epoch')).toHaveCount(0, { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Open MCP session' })).toHaveCount(0, { timeout: browserTimeout });
    expect(artifactMcpSessionRequests).toEqual([]);
    await expect.poll(() => unsupportedOperationRequests.length, { timeout: browserTimeout }).toBe(0);
  } finally {
    await clientPage?.close();
    await clientSurface?.close();
    await fixture.close();
  }
});

e2e('restarts the real Runtime MCP App session when definition or transport authority changes', { timeout: 150_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const serverOwnedProjectSubscriptions = fixture.eventHubState.subscriptionCount;
  expect(serverOwnedProjectSubscriptions).toBe(1);
  const pageErrors: Error[] = [];
  const artifactMcpSessionRequests: string[] = [];
  const projectEventStreams: string[] = [];
  const projectEventStreamCursors = new Map<number, string>();
  const runtimeMcpSessionRequests: string[] = [];
  const runtimeAppRequests: string[] = [];
  const runtimeRunRequests: string[] = [];
  const runtimeAppCreates: Array<{ readonly body: unknown; response?: unknown; readonly sessionToken: string | undefined }> = [];
  const runtimeRuns: Array<{ readonly body: unknown; response?: unknown }> = [];
  let runtimeAppResponseCount = 0;
  const runtimeAppResponseWaiters = new Map<number, () => void>();
  const awaitRuntimeAppResponse = (count: number): Promise<void> => {
    if (runtimeAppResponseCount >= count) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (runtimeAppResponseWaiters.get(count) !== settle) return;
        runtimeAppResponseWaiters.delete(count);
        reject(new Error(`Runtime App create ${String(count)} did not return a response.`));
      }, browserTimeout);
      const settle = () => {
        clearTimeout(timeout);
        runtimeAppResponseWaiters.delete(count);
        resolve();
      };
      runtimeAppResponseWaiters.set(count, settle);
    });
  };
  const runtimeEvents: Array<Readonly<{
    readonly lastEventId: string;
    readonly payload: Readonly<{
      readonly details?: Readonly<Record<string, unknown>>;
      readonly mcpRegistryRevision?: number;
      readonly mcpSessionId?: string;
      readonly mcpSessionRevision?: number;
      readonly runtimeGenerationId?: string;
      readonly type?: string;
    }>;
    readonly type?: string;
  }>> = [];
  const replayGaps: Array<Readonly<{ readonly data: string; readonly lastEventId: string }>> = [];
  await page.exposeBinding('__recordRuntimeRestartEvent', (_source, value: unknown) => {
    if (value === null || typeof value !== 'object') return;
    const payload = value as Readonly<{ readonly data?: unknown; readonly lastEventId?: unknown }>;
    if (typeof payload.data !== 'string' || typeof payload.lastEventId !== 'string') return;
    try {
      const parsed = JSON.parse(payload.data) as Readonly<{
        readonly payload?: unknown;
        readonly type?: unknown;
      }>;
      if (parsed.type !== 'runtime.event' || parsed.payload === null || typeof parsed.payload !== 'object') return;
      runtimeEvents.push(Object.freeze({ ...parsed, lastEventId: payload.lastEventId }) as (typeof runtimeEvents)[number]);
    } catch {
      // The real EventSource listener remains authoritative; malformed test observation is ignored.
    }
  });
  await page.exposeBinding('__recordRuntimeReplayGap', (_source, payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return;
    const value = payload as Readonly<{ readonly data?: unknown; readonly lastEventId?: unknown }>;
    if (typeof value.data !== 'string' || typeof value.lastEventId !== 'string') return;
    replayGaps.push(Object.freeze({ data: value.data, lastEventId: value.lastEventId }));
  });
  await page.addInitScript(() => {
    const addEventListener = EventSource.prototype.addEventListener;
    Object.defineProperty(EventSource.prototype, 'addEventListener', { value: function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const wrapped = function (this: EventSource, event: Event): void {
        const data = (event as Event & Readonly<{ readonly data?: unknown }>).data;
        if (type === 'runtime.event' && typeof data === 'string') {
          const record = (globalThis as typeof globalThis & {
            __recordRuntimeRestartEvent?: (payload: Readonly<{ readonly data: string; readonly lastEventId: string }>) => Promise<void>;
          }).__recordRuntimeRestartEvent;
          if (record !== undefined) {
            void record(Object.freeze({
              data,
              lastEventId: (event as Event & Readonly<{ readonly lastEventId?: unknown }>).lastEventId === undefined
                ? ''
                : String((event as Event & Readonly<{ readonly lastEventId?: unknown }>).lastEventId),
            }));
          }
        }
        if (type === 'replay.gap' && typeof data === 'string') {
          const record = (globalThis as typeof globalThis & {
            __recordRuntimeReplayGap?: (payload: Readonly<{ readonly data: string; readonly lastEventId: string }>) => Promise<void>;
          }).__recordRuntimeReplayGap;
          if (record !== undefined) {
            void record(Object.freeze({
              data,
              lastEventId: (event as Event & Readonly<{ readonly lastEventId?: unknown }>).lastEventId === undefined
                ? ''
                : String((event as Event & Readonly<{ readonly lastEventId?: unknown }>).lastEventId),
            }));
          }
        }
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      };
      Reflect.apply(addEventListener, this, [type, wrapped, options]);
    } });
  });
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== fixture.url) return;
    if (url.pathname.startsWith('/api/mcp/sessions')) artifactMcpSessionRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.startsWith('/api/runtime/mcp/sessions')) runtimeMcpSessionRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/runtime/runs') {
      runtimeRunRequests.push(`${request.method()} ${url.pathname}`);
      if (request.method() === 'POST') runtimeRuns.push({ body: requestBody(request.postData()) });
    }
    if (!url.pathname.startsWith('/api/runtime/apps')) return;
    runtimeAppRequests.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'POST' && url.pathname === '/api/runtime/apps') {
      runtimeAppCreates.push({ body: requestBody(request.postData()), sessionToken: request.headers()['x-agent-bundle-session'] });
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === fixture.url && response.request().method() === 'GET' && response.status() === 200 && url.pathname === '/api/project/events') {
      const streamIndex = projectEventStreams.length;
      projectEventStreams.push(`${response.request().method()} ${url.pathname}`);
      void response.request().allHeaders().then((headers) => {
        projectEventStreamCursors.set(streamIndex, headers['last-event-id'] ?? url.searchParams.get('after') ?? '');
      }).catch(() => undefined);
    }
    if (url.origin !== fixture.url || response.request().method() !== 'POST' || url.pathname !== '/api/runtime/apps') return;
    const index = runtimeAppCreates.findIndex((candidate) => candidate.response === undefined && JSON.stringify(candidate.body) === response.request().postData());
    if (index < 0) return;
    void response.json().then((body: unknown) => {
      runtimeAppCreates[index]!.response = body;
      runtimeAppResponseCount += 1;
      for (const [count, settle] of runtimeAppResponseWaiters) {
        if (runtimeAppResponseCount >= count) settle();
      }
    }).catch(() => undefined);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== fixture.url || response.request().method() !== 'POST' || url.pathname !== '/api/runtime/runs') return;
    const index = runtimeRuns.findIndex((candidate) => candidate.response === undefined && JSON.stringify(candidate.body) === response.request().postData());
    if (index < 0) return;
    void response.json().then((body: unknown) => { runtimeRuns[index]!.response = body; }).catch(() => undefined);
  });
  type Binding = Readonly<{
    readonly definitionDigest: string;
    readonly id: string;
    readonly registryRevision: number;
    readonly runVector: Readonly<{ readonly runtimeGenerationId: string; readonly sourceRevision: string }>;
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly transportDigest: string;
  }>;
  type RunOutcome = Readonly<{
    readonly diagnostics: readonly Readonly<{ readonly code: string; readonly message: string; readonly phase: string; readonly severity: string }>[];
    readonly id: string;
    readonly status: 'failed' | 'succeeded';
    readonly vector: Readonly<{ readonly runtimeGenerationId: string }>;
  }>;
  const binding = (index: number): Binding => {
    const body = runtimeAppCreates[index]?.response as { readonly preview?: { readonly binding?: Binding } } | undefined;
    const value = body?.preview?.binding;
    if (value === undefined) throw new Error(`Runtime App create ${String(index)} omitted its binding.`);
    return value;
  };
  const eventsSince = (index: number, type: string, session: Binding): readonly (typeof runtimeEvents)[number][] => runtimeEvents.slice(index).filter((event) =>
    event.payload.type === type && event.payload.mcpSessionId === session.sessionId,
  );
  type RuntimeStatus = Readonly<{
    readonly activeVector?: Readonly<{
      readonly providerSessionId: string;
      readonly runtimeGenerationId: string;
    }>;
    readonly state: string;
  }>;
  const readRuntimeStatus = async (): Promise<RuntimeStatus> => page.evaluate(async (origin) => {
    const response = await fetch(new URL('/api/runtime/status', origin));
    if (!response.ok) throw new Error(`Runtime status failed with ${String(response.status)}.`);
    const body = await response.json() as Readonly<{ readonly status?: RuntimeStatus }>;
    if (body.status === undefined) throw new Error('Runtime status is unavailable.');
    return body.status;
  }, fixture.url);
  const run = async (runCount: number, previewCreateCount?: number): Promise<Readonly<{ readonly binding?: Binding; readonly run: RunOutcome }>> => {
    const initialAppCreateResponse = runCount === 1 && previewCreateCount !== undefined
      ? awaitRuntimeAppResponse(previewCreateCount)
      : undefined;
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Run mutable runtime surface?' }).getByRole('button', { name: 'Confirm' });
    if (await confirmation.count() === 1) await confirmation.click();
    await expect.poll(() => runtimeRunRequests.filter((request) => request === 'POST /api/runtime/runs').length, { timeout: browserTimeout }).toBe(runCount);
    await expect.poll(() => runtimeRuns.filter((candidate) => candidate.response !== undefined).length, { timeout: browserTimeout }).toBe(runCount);
    const response = runtimeRuns[runCount - 1]?.response as { readonly run?: RunOutcome } | undefined;
    const outcome = response?.run;
    if (outcome === undefined || typeof outcome.id !== 'string' || (outcome.status !== 'succeeded' && outcome.status !== 'failed')) {
      throw new Error('Explicit Runtime run omitted a canonical history result.');
    }
    let appCreateResponse = initialAppCreateResponse;
    if (runCount > 1) {
      await expect.poll(() => runtimeAppCreates.length, { timeout: 1_000 }).toBe((previewCreateCount ?? 3) - 1);
      const runId = outcome.id;
      const history = page.locator(`[data-runtime-run-id="${runId}"]`);
      await expect(history).toHaveCount(1, { timeout: browserTimeout });
      if (outcome.status === 'succeeded' && previewCreateCount !== undefined) appCreateResponse = awaitRuntimeAppResponse(previewCreateCount);
      await history.getByRole('button').first().click();
      await expect(history.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    }
    if (appCreateResponse === undefined) return Object.freeze({ run: outcome });
    await appCreateResponse;
    if (previewCreateCount === undefined) throw new Error('Runtime App preview response lacks a create count.');
    expect(runtimeAppCreates).toHaveLength(previewCreateCount);
    expect(runtimeAppCreates.filter((candidate) => candidate.response !== undefined)).toHaveLength(previewCreateCount);
    // A restart can satisfy waitFor(attached) with the outgoing binding's
    // iframe and then unmount it before the replacement mounts, so an instant
    // count() reads a transient 0 on contended runners. toHaveCount retries
    // until exactly one preview iframe is attached (still failing duplicates).
    await expect(page.locator('.runtime-stage .mcp-app-preview iframe')).toHaveCount(1, { timeout: browserTimeout });
    return Object.freeze({ binding: binding(previewCreateCount - 1), run: outcome });
  };
  try {
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    const runtimeIdentity = page.locator('[data-runtime-provider-session]');
    await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: browserTimeout });
    await page.getByLabel('Runtime surface').selectOption('mcp.render_edit_timeline');
    await page.getByLabel('Runtime target').selectOption('portable');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await page.locator('#runtime-input-raw').fill('{}');

    const initialResult = await run(1, 1);
    const initial = initialResult.binding;
    if (initial === undefined) throw new Error('Initial Runtime run did not create an App binding.');
    expect(runtimeAppCreates[0]?.body).toEqual({
      expectedGenerationId: initial.runVector.runtimeGenerationId,
      profileId: 'portable',
      runId: expect.any(String),
    });
    const resourceUri = 'ui://rsc-agent-runtime/edit-timeline-v1.html';
    const resourceOperationPath = `/api/runtime/apps/${encodeURIComponent(initial.id)}/operations`;
    const initialSessionToken = runtimeAppCreates[0]?.sessionToken;
    if (initialSessionToken === undefined) throw new Error('Initial Runtime App create omitted the foreground session token.');
    const initialProviderSession = await runtimeIdentity.getAttribute('data-runtime-provider-session');
    if (initialProviderSession === null) throw new Error('Runtime identity omitted the provider session.');
    const definitionSource = await readFile(fixture.definitionSource, 'utf8');
    const changedDefinitionDescription = `Render the timeline after definition restart ${Math.random().toString(36).slice(2)}.`;
    const changedDefinition = definitionSource.replace(
      "description: 'Render the interactive file edit timeline.'",
      `description: '${changedDefinitionDescription}'`,
    );
    expect(changedDefinition).not.toBe(definitionSource);
    const definitionEventStart = runtimeEvents.length;
    await replaceWatchedSource(fixture.root, fixture.definitionSource, changedDefinition);
    await expect.poll(() => eventsSince(definitionEventStart, 'runtime.mcp.restarting', initial), { timeout: browserTimeout }).not.toEqual([]);
    await expect.poll(() => eventsSince(definitionEventStart, 'runtime.mcp.ready', initial), { timeout: browserTimeout }).not.toEqual([]);
    expect(runtimeEvents.findIndex((event, index) => index >= definitionEventStart && event.payload.type === 'runtime.mcp.restarting')).toBeLessThan(
      runtimeEvents.findIndex((event, index) => index >= definitionEventStart && event.payload.type === 'runtime.mcp.ready'),
    );
    await expect.poll(() => runtimeEvents.slice(definitionEventStart).find((event) =>
      event.payload.type === 'runtime.app.updated' && event.payload.details?.bindingId === initial.id &&
      event.payload.details.reason === 'session-restarted' && event.payload.details.state === 'revoked'), { timeout: browserTimeout }).toBeDefined();
    await page.locator('.runtime-stage .mcp-app-preview iframe').waitFor({ state: 'detached', timeout: browserTimeout });
    expect(await page.locator('.runtime-stage .mcp-app-preview iframe').count()).toBe(0);
    expect(runtimeAppRequests.filter((request) => request === `DELETE /api/runtime/apps/${encodeURIComponent(initial.id)}`)).toEqual([]);
    const revokedInitialOperation = await page.evaluate(async ({ body, path, sessionToken }) => {
      const response = await fetch(path, {
        body: JSON.stringify(body),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-agent-bundle-session': sessionToken },
        method: 'POST',
      });
      return Object.freeze({ body: await response.json(), status: response.status });
    }, { body: { kind: 'resources/read', uri: resourceUri }, path: resourceOperationPath, sessionToken: initialSessionToken });
    expect(revokedInitialOperation).toEqual({
      body: { diagnostic: { code: 'AB8022', message: 'Runtime MCP App preview was revoked.' } },
      status: 410,
    });
    await expect.poll(() => runtimeAppCreates.length, { timeout: 1_000 }).toBe(1);
    const definitionReady = eventsSince(definitionEventStart, 'runtime.mcp.ready', initial).at(-1);
    expect(definitionReady?.payload.mcpSessionRevision).toBeGreaterThan(initial.sessionRevision);
    expect(definitionReady?.payload.mcpRegistryRevision).toBeGreaterThan(initial.registryRevision);

    const definitionResult = await run(2, 2);
    const definitionRun = definitionResult.binding;
    if (definitionRun === undefined) throw new Error('Definition Runtime run did not create an App binding.');
    expect(definitionRun.id).not.toBe(initial.id);
    expect(definitionRun.sessionId).toBe(initial.sessionId);
    expect(definitionRun.sessionRevision).toBeGreaterThan(initial.sessionRevision);
    expect(definitionRun.registryRevision).toBeGreaterThan(initial.registryRevision);
    expect(definitionRun.runVector.runtimeGenerationId).not.toBe(initial.runVector.runtimeGenerationId);
    expect(definitionRun.runVector.sourceRevision).not.toBe(initial.runVector.sourceRevision);
    expect(definitionRun.definitionDigest).not.toBe(initial.definitionDigest);
    expect(definitionRun.transportDigest).toBe(initial.transportDigest);
    expect(await runtimeIdentity.getAttribute('data-runtime-provider-session')).toBe(initialProviderSession);

    const configSource = await readFile(fixture.configSource, 'utf8');
    const transportMarker = `transport-restart-${Math.random().toString(36).slice(2)}`;
    const changedTransport = configSource.replace(
      "entry: { prebuilt: './dist/runtime/mcp/stdio.js' },",
      `entry: { prebuilt: './dist/runtime/mcp/stdio.js' },\n        env: { TIMELINE_TRANSPORT_SENTINEL: '${transportMarker}' },`,
    );
    expect(changedTransport).not.toBe(configSource);
    const transportEventStart = runtimeEvents.length;
    await expect.poll(() => fixture.eventHubState.subscriptionCount, { timeout: browserTimeout })
      .toBe(serverOwnedProjectSubscriptions + 1);
    await page.locator('.connection-content').evaluate((element) => {
      element.setAttribute('data-recovery-probe', 'same-instance');
    });
    await page.context().setOffline(true);
    fixture.disconnectProjectEventStream();
    await expect.poll(() => fixture.eventHubState.subscriptionCount, { timeout: browserTimeout })
      .toBe(serverOwnedProjectSubscriptions);
    await replaceWatchedSource(fixture.root, fixture.configSource, changedTransport);
    const definitionOperationPath = `/api/runtime/apps/${encodeURIComponent(definitionRun.id)}/operations`;
    await expect.poll(async () => {
      const response = await fetch(new URL(definitionOperationPath, fixture.url), {
        body: JSON.stringify({ kind: 'resources/read', uri: resourceUri }),
        headers: {
          'content-type': 'application/json',
          origin: fixture.url,
          'x-agent-bundle-session': initialSessionToken,
        },
        method: 'POST',
      });
      return Object.freeze({ body: await response.json(), status: response.status });
    }, { timeout: browserTimeout }).toEqual({
      body: { diagnostic: { code: 'AB8022', message: 'Runtime MCP App preview was revoked.' } },
      status: 410,
    });
    await expect.poll(async () => {
      const response = await fetch(new URL('/api/runtime/status', fixture.url), {
        headers: { origin: fixture.url, 'x-agent-bundle-session': initialSessionToken },
      });
      if (!response.ok) return false;
      const body = await response.json() as Readonly<{ readonly status?: RuntimeStatus }>;
      return body.status?.state === 'active' && body.status.activeVector?.providerSessionId === initialProviderSession;
    }, { timeout: browserTimeout }).toBe(true);
    const sequenceBeforeReplayNoise = fixture.eventHubState.latestSequence;
    fixture.publishReplayNoise();
    expect(fixture.eventHubState.latestSequence).toBe(sequenceBeforeReplayNoise + 257);
    await page.context().setOffline(false);
    await expect.poll(() => fixture.eventHubState.subscriptionCount, { timeout: browserTimeout })
      .toBe(serverOwnedProjectSubscriptions + 1);
    await expect.poll(() => projectEventStreams, { timeout: browserTimeout }).toEqual([
      'GET /api/project/events',
      'GET /api/project/events',
    ]);
    await expect.poll(() => projectEventStreamCursors.size, { timeout: browserTimeout }).toBe(2);
    expect(projectEventStreamCursors.get(0)).toBe('');
    const reconnectCursor = projectEventStreamCursors.get(1);
    if (reconnectCursor === undefined || !/^(0|[1-9]\d*)$/u.test(reconnectCursor)) {
      throw new Error('Replacement EventSource did not carry a canonical replay cursor.');
    }
    await expect.poll(() => replayGaps.length, { timeout: browserTimeout }).toBe(1);
    const replayGap = replayGaps[0];
    if (replayGap === undefined) throw new Error('Project EventSource did not deliver a replay gap.');
    // The replacement source is seeded by its query, while an id-less gap leaves the
    // browser-owned Last-Event-ID empty until the first sequenced frame arrives.
    expect(replayGap.lastEventId).toBe('');
    expect(JSON.parse(replayGap.data)).toMatchObject({
      latestDroppedSequence: expect.any(Number),
      requestedAfterSequence: Number(reconnectCursor),
      type: 'replay.gap',
    });
    await page.locator('.runtime-stage .mcp-app-preview iframe').waitFor({ state: 'detached', timeout: browserTimeout });
    expect(await page.locator('.runtime-stage .mcp-app-preview iframe').count()).toBe(0);
    await expect(page.locator('.connection-content')).toHaveAttribute('data-recovery-probe', 'same-instance');
    // Scaled budget: the fallback section renders after the invalidation
    // cleanup settles, which lags the iframe detach on a contended runner.
    // toHaveText also reports the actual reason if the wrong invalidation won.
    await expect(page.locator('.runtime-stage .mcp-app-preview__fallback > p[role="status"]'))
      .toHaveText('Interactive App rendering is unavailable (registry-replay-gap). Showing the ordinary tool result instead.', { timeout: browserTimeout });
    expect(runtimeAppRequests.filter((request) => request.startsWith('DELETE /api/runtime/apps/'))).toEqual([]);
    await expect.poll(() => runtimeAppCreates.length, { timeout: 1_000 }).toBe(2);

    const runButton = page.getByRole('button', { name: 'Run', exact: true });
    await expect.poll(async () => {
      const status = await readRuntimeStatus();
      const latestActivation = runtimeEvents.slice(transportEventStart).filter((event) =>
        event.payload.type === 'runtime.generation.activated' && typeof event.payload.runtimeGenerationId === 'string'
      ).at(-1);
      const activatedGeneration = latestActivation?.payload.runtimeGenerationId;
      const statusGeneration = status.activeVector?.runtimeGenerationId;
      const uiGeneration = await runtimeIdentity.getAttribute('data-runtime-generation');
      return (await runButton.isEnabled()) && statusGeneration !== undefined && statusGeneration === uiGeneration &&
        (activatedGeneration === undefined || activatedGeneration === statusGeneration);
    }, { timeout: browserTimeout }).toBe(true);
    const authoritativeStatus = await readRuntimeStatus();
    const activeGenerationId = authoritativeStatus.activeVector?.runtimeGenerationId;
    if (typeof activeGenerationId !== 'string') throw new Error('Transport restart did not expose an active runtime generation.');
    expect(authoritativeStatus.state).toBe('active');
    expect(authoritativeStatus.activeVector?.providerSessionId).toBe(initialProviderSession);
    expect(await runtimeIdentity.getAttribute('data-runtime-generation')).toBe(activeGenerationId);
    await expect(runButton).toBeEnabled();

    const firstTransportResult = await run(3, 3);
    let transportRun: Binding | undefined = firstTransportResult.binding;
    if (firstTransportResult.run.status === 'failed') {
      const conflict = firstTransportResult.run.diagnostics.find((diagnostic) => diagnostic.phase === 'rsc-render');
      expect(conflict?.code).toBe('AB8203');
      expect(conflict?.message).toBe(`Expected runtime generation ${JSON.stringify(firstTransportResult.run.vector.runtimeGenerationId)} is not active.`);
      await expect.poll(() => runtimeAppCreates.length, { timeout: 1_000 }).toBe(2);
      expect(runtimeRunRequests.filter((request) => request === 'POST /api/runtime/runs')).toHaveLength(3);
      await expect(page.locator('#runtime-input-raw')).toHaveValue('{}');
      await expect(runButton).toBeEnabled();
      const failedGenerationId = firstTransportResult.run.vector.runtimeGenerationId;
      let stableSnapshots = 0;
      let stableGenerationId: string | undefined;
      await expect.poll(async () => {
        const status = await readRuntimeStatus();
        const generationId = status.activeVector?.runtimeGenerationId;
        const uiGeneration = await runtimeIdentity.getAttribute('data-runtime-generation');
        const runEnabled = await runButton.isEnabled();
        if (!runEnabled || generationId === undefined || uiGeneration !== generationId) {
          stableSnapshots = 0;
          stableGenerationId = undefined;
          return 0;
        }
        stableSnapshots = stableGenerationId === generationId ? stableSnapshots + 1 : 1;
        stableGenerationId = generationId;
        return stableSnapshots;
      }, { interval: 200, timeout: browserTimeout }).toBeGreaterThanOrEqual(3);
      expect(stableGenerationId).toBe(failedGenerationId);
      const retryResult = await run(4, 3);
      expect(retryResult.run.status).toBe('succeeded');
      transportRun = retryResult.binding;
    }
    if (transportRun === undefined) throw new Error('Transport Runtime run did not create an App binding.');
    expect(transportRun.id).not.toBe(definitionRun.id);
    expect(transportRun.sessionId).toBe(initial.sessionId);
    expect(transportRun.sessionRevision).toBeGreaterThan(definitionRun.sessionRevision);
    expect(transportRun.registryRevision).toBeGreaterThan(definitionRun.registryRevision);
    await expect.poll(async () => {
      const status = await readRuntimeStatus();
      return status.activeVector?.runtimeGenerationId === transportRun.runVector.runtimeGenerationId &&
        await runtimeIdentity.getAttribute('data-runtime-generation') === transportRun.runVector.runtimeGenerationId;
    }, { timeout: browserTimeout }).toBe(true);
    const finalRuntimeStatus = await readRuntimeStatus();
    expect(transportRun.runVector.runtimeGenerationId).toBe(finalRuntimeStatus.activeVector?.runtimeGenerationId);
    expect(transportRun.definitionDigest).toBe(definitionRun.definitionDigest);
    expect(transportRun.transportDigest).not.toBe(definitionRun.transportDigest);
    expect(await runtimeIdentity.getAttribute('data-runtime-provider-session')).toBe(initialProviderSession);
    expect(artifactMcpSessionRequests).toEqual([]);
    expect(runtimeMcpSessionRequests.filter((request) => request === 'POST /api/runtime/mcp/sessions')).toEqual([]);
    expect(projectEventStreams).toEqual([
      'GET /api/project/events',
      'GET /api/project/events',
    ]);
    expect(await page.locator('.runtime-stage .mcp-app-preview iframe').count()).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

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
    const manifest = JSON.parse(await readFile(join(project.root, '.agent-bundle', 'epochs', epochId, 'portable', 'mcp.json'), 'utf8')) as {
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
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible();
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

e2e('renders and rebuilds the complete desktop Overview against a real foreground server', { timeout: 60_000 }, async ({ page }) => {
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
    await page.setViewportSize({ height: 900, width: 1_440 });
    const asyncScripts = new Set<string>();
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && request.url().includes('/static/js/async/')) asyncScripts.add(request.url());
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    for (const name of ['Build health', 'Diagnostics (0)']) {
      await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: browserTimeout });
    }
    await page.getByText('Inspect build details', { exact: true }).click();
    for (const name of ['Source and build state', 'Published build', 'Generated targets']) {
      await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });

    await page.getByRole('link', { name: 'Skills', exact: true }).click();
    await expect(page.locator('#skills .skills-page-heading > div > h1')).toHaveText('Skills', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
    const documentTabs = page.getByRole('tablist', { name: 'Skill document' });
    const viewTabs = page.getByRole('tablist', { name: 'Document view' });
    const sourceTab = documentTabs.getByRole('tab', { name: 'Source' });
    const generatedTab = documentTabs.getByRole('tab', { name: 'Generated' });
    const renderedTab = viewTabs.getByRole('tab', { name: 'Rendered' });
    const markdownTab = viewTabs.getByRole('tab', { name: 'Markdown' });
    await expect(renderedTab).toBeVisible({ timeout: browserTimeout });
    await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Source skills', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('#skills .skill-target')).toHaveCount(0);
    await renderedTab.focus();
    await page.keyboard.press('End');
    await expect.poll(() => markdownTab.evaluate((element) => document.activeElement === element), { timeout: browserTimeout }).toBe(true);
    await expect(markdownTab).toHaveAttribute('aria-selected', 'true');
    await expect(markdownTab).toHaveAttribute('aria-controls', 'skill-review-panel');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /-view-tab-markdown$/u);
    await page.keyboard.press('Home');
    await expect.poll(() => renderedTab.evaluate((element) => document.activeElement === element), { timeout: browserTimeout }).toBe(true);
    await markdownTab.click();
    await expect(page.locator('.skill-source')).toContainText('---', { timeout: browserTimeout });
    await generatedTab.click();
    await expect.poll(() => generatedTab.evaluate((element) => document.activeElement === element), { timeout: browserTimeout }).toBe(true);
    await expect(generatedTab).toHaveAttribute('aria-selected', 'true');
    await expect(generatedTab).toHaveAttribute('aria-controls', 'skill-review-panel');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /-document-tab-generated/u);
    await expect(page.getByRole('heading', { name: 'Generated skills', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('#skills .skill-target')).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.skill-provenance')).toHaveText('Generated for portable', { timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });

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
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });

    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('renders the latest changed files from a replayed foreground source event on desktop', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const { eventHub, server } = await startFrozenEpochServer(project.root);
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    eventHub.publish({
      payload: {
        occurredAt: '2026-08-16T12:00:00.000Z',
        paths: [
          'src/very/deeply/nested/path/that/needs/to/wrap/without/causing/a/horizontal/scrollbar/on/a/narrow/viewport.ts',
          'src/config.ts',
        ],
        reason: 'source-change',
      },
      type: 'source.changed',
    });
    await page.setViewportSize({ height: 900, width: 1_440 });
    await page.goto(`${server.url}#overview`);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await page.getByText('Inspect build details', { exact: true }).click();

    const changedFiles = page.getByRole('region', { name: 'Latest changed files (2)' });
    await expect(changedFiles).toBeVisible({ timeout: browserTimeout });
    await expect(changedFiles.getByRole('listitem')).toHaveText([
      'src/config.ts',
      'src/very/deeply/nested/path/that/needs/to/wrap/without/causing/a/horizontal/scrollbar/on/a/narrow/viewport.ts',
    ], { timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
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
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.getByRole('link', { name: 'Skills', exact: true }).click();
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
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
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

e2e('lists an immutable build Skill tree even after the current source Skill is renamed', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const { server } = await startFrozenEpochServer(project.root);
  try {
    const renamed = join(project.root, 'skills', 'revised');
    await rename(project.skillDir, renamed);
    await writeFile(join(renamed, 'SKILL.md'), project.skillMarkdown.replace('name: review', 'name: revised'));

    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('link', { name: 'Skills', exact: true }).click();
    await expect(page.locator('.skill-tree-item')).toContainText('revised', { timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Generated' }).click();
    await expect(page.locator('.skill-tree-item')).toContainText('review', { timeout: browserTimeout });
    await expect(page.locator('.skill-provenance')).toHaveText('Generated for portable', { timeout: browserTimeout });
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
    const eventsConnected = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/project/events' && response.ok());
    await page.goto(server.url);
    await eventsConnected;
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    let failedStatusRequests = 0;
    await page.route('**/api/project/status', async (route) => {
      failedStatusRequests += 1;
      await route.fulfill({
        body: JSON.stringify({ diagnostic: { code: 'AB8007', message: 'Request could not be completed.' } }),
        contentType: 'application/json',
        status: 500,
      });
    });

    await replaceWatchedSource(project.root, join(project.skillDir, 'SKILL.md'), `${project.skillMarkdown}\n\nThe source refresh failure fixture changed.\n`);

    await expect.poll(() => failedStatusRequests, { timeout: browserTimeout }).toBe(1);
    await expect(page.getByRole('status')).toContainText('Foreground server unavailable', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });
    expect(pageErrors).toEqual([]);
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
    const firstEvents = eventHubs[0];
    if (firstEvents === undefined) throw new Error('Expected the first foreground event hub.');
    firstEvents.publish({
      payload: {
        occurredAt: '2026-08-19T12:00:00.000Z',
        paths: ['src/restart-a.ts'],
        reason: 'source-change',
      },
      type: 'source.changed',
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await page.getByText('Inspect build details', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Latest changed files (1)' })).toContainText('src/restart-a.ts', { timeout: browserTimeout });

    await page.getByRole('link', { name: 'MCP playground', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.locator('.connection-content').evaluate((element) => {
      element.setAttribute('data-recovery-probe', 'foreground-a');
    });

    const port = Number(new URL(server.url).port);
    await server.close();
    await expect(page.getByRole('heading', { name: 'Foreground connection unavailable' })).toBeVisible({ timeout: browserTimeout });
    const retainedNavigation = page.getByRole('link', { name: 'Overview' });
    await expect(page.locator('.connection-content')).toHaveAttribute('inert', '');
    await expect(retainedNavigation).toBeVisible();
    await retainedNavigation.focus();
    expect(await retainedNavigation.evaluate((element) => element === document.activeElement)).toBe(false);

    server = await startRestartableServer(port);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.connection-content')).not.toHaveAttribute('data-recovery-probe', 'foreground-a');
    await expect(page.locator('#mcp-target')).toHaveValue('portable');
    await expect(page.locator('#mcp-server-name')).toHaveValue('fixture');
    await expect(page.getByRole('button', { name: 'Open MCP session' })).toBeEnabled({ timeout: browserTimeout });
    await expect.poll(() => releasedMcpSessions.length, { timeout: browserTimeout }).toBe(1);
    expect(releasedMcpSessions).toEqual([{ token: 'foreground-token-a' }]);

    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByText('Inspect build details', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Latest changed files (0)' })).toContainText('No source changes have been reported in this browser session.', { timeout: browserTimeout });
    const rebuild = page.getByRole('button', { name: 'Rebuild' });
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
