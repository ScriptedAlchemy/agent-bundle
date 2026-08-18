import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { runCli } from '../src/cli.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import {
  closeDevServerLifecycle,
  DevServerLifecycleCloseError,
  DevServerStartError,
  RuntimeClientSurfaceBindings,
  startDevServer,
} from '../src/dev/workbench-server.ts';
import type { ForegroundCoordinator } from '../src/dev/foreground-server.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const next = await reader.read();
    if (next.done) return output;
    output += decoder.decode(next.value, { stream: true });
  }
};

const within = async <Value>(promise: Promise<Value>, milliseconds: number): Promise<Value> => Promise.race([
  promise,
  new Promise<Value>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

it('requires one canonical foreground origin before opening runtime client surfaces', async () => {
  const bindings = new RuntimeClientSurfaceBindings(undefined, async () => {
    throw new Error('Runtime lookup must not open a proxy without a bound foreground.');
  });
  await expect(bindings.open('mcp.edit-timeline')).rejects.toThrow('not bound');
  expect(() => bindings.bindHostOrigin('http://127.0.0.1:42000/not-an-origin')).toThrow('canonical foreground');
  bindings.bindHostOrigin('http://127.0.0.1:42000');
  expect(() => bindings.bindHostOrigin('http://127.0.0.1:42000')).toThrow('one canonical foreground origin binding');
  await expect(bindings.open('mcp.edit-timeline')).resolves.toBeUndefined();
  await expect(bindings.close()).resolves.toBeUndefined();
});

const openProjectEventStream = (url: string, cookie: string): Readonly<{
  readonly close: () => void;
  readonly opened: Promise<void>;
  readonly until: (marker: string) => Promise<string>;
}> => {
  let response: import('node:http').IncomingMessage | undefined;
  let received = '';
  let awaitedMarker: string | undefined;
  let resolveMatch: ((value: string) => void) | undefined;
  let rejectMatch: ((error: Error) => void) | undefined;
  let resolveOpened: () => void = () => undefined;
  let rejectOpened: (error: Error) => void = () => undefined;
  const opened = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveOpened = resolvePromise;
    rejectOpened = rejectPromise;
  });
  const request = httpGet(`${url}/api/project/events`, { headers: { cookie, origin: url } }, (stream) => {
    response = stream;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      received += chunk;
      if (awaitedMarker !== undefined && received.includes(awaitedMarker)) resolveMatch?.(received);
    });
    stream.once('error', (error: Error) => rejectMatch?.(error));
    resolveOpened();
  });
  request.once('error', (error: Error) => {
    rejectOpened(error);
    rejectMatch?.(error);
  });
  return Object.freeze({
    close: () => {
      response?.destroy();
      request.destroy();
    },
    opened,
    until: (marker) => {
      if (received.includes(marker)) return Promise.resolve(received);
      awaitedMarker = marker;
      return new Promise<string>((resolvePromise, rejectPromise) => {
        resolveMatch = resolvePromise;
        rejectMatch = rejectPromise;
      });
    },
  });
};

const writeMcpProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(
      join(process.cwd(), 'node_modules', '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    ),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      '',
      "const server = new McpServer({ name: 'workbench-fixture', version: '1.0.0' });",
      "server.registerTool('wait', { description: 'Wait for shutdown.' }, async () => new Promise(() => {}));",
      "server.registerResource('app', 'ui://fixture/app.html', { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({",
      "  contents: [{ mimeType: 'text/html;profile=mcp-app', text: '<main>Fixture App</main>', uri: uri.href }],",
      '}));',
      "server.registerTool('show-app', { _meta: { ui: { resourceUri: 'ui://fixture/app.html' } } }, async () => ({",
      "  content: [{ type: 'text', text: 'Fixture App ready.' }],",
      '}));',
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'workbench-mcp-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

const writeHookProject = async (root: string): Promise<void> => {
  await mkdir(join(root, 'src', 'hooks'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'hooks', 'session-start.ts'), [
      'export default (event: { source?: string }) => ({',
      "  additionalContext: `workbench:${event.source}`,",
      "  outcome: 'continue' as const,",
      '});',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  hooks: { sessionStart: './src/hooks/session-start.ts' },",
      "  plugin: { name: 'workbench-hook-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['claude'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

const appPreviewBody = () => ({
  host: {
    availableDisplayModes: ['inline'],
    containerDimensions: { height: 360, width: 640 },
    deviceCapabilities: {},
    displayMode: 'inline',
    locale: 'en-US',
    platform: 'web',
    safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
    styles: {},
    theme: 'light',
    timeZone: 'UTC',
    userAgent: 'agent-bundle-dev-workbench-test/1.0',
  },
  input: { city: 'Paris' },
  previewProfile: 'portable',
  result: { content: [{ text: 'Fixture App ready.', type: 'text' }] },
  toolName: 'show-app',
});

interface CompilingRuntimeAppState {
  emit: ((event: { readonly type: 'runtime.generation.activated' | 'runtime.status' }) => void) | undefined;
  phase: 'active' | 'compiling';
  subscribes: number;
  unsubscribes: number;
}

const writeCompilingRuntimeAppProject = async (root: string, stateKey: string): Promise<void> => {
  await mkdir(join(root, 'src', 'dev'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'src', 'dev', 'provider.ts'), [
      `const state = globalThis[${JSON.stringify(stateKey)}];`,
      "if (state === undefined) throw new Error('Missing compiling Runtime Apps test state.');",
      'const registry = {',
      '  close: async () => undefined,',
      '  closeSession: async () => undefined,',
      '  open: async () => { throw new Error(\'unused\'); },',
      '  reconcile: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
      '  restart: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
      '  session: () => undefined,',
      '  snapshot: () => undefined,',
      "  subscribe: () => { state.subscribes += 1; state.emit?.({ type: 'runtime.status' }); return { unsubscribe: () => { state.unsubscribes += 1; } }; },",
      '};',
      'export const createDevRuntimeProvider = () => ({',
      "  descriptor: { environmentVariables: [], id: 'compiling-runtime-apps', label: 'Compiling Runtime Apps', schemaVersion: 1 },",
      '  start: async (context) => {',
      '    state.emit = context.emit;',
      '    return {',
      '      clientSurface: () => undefined,',
      '      close: async () => undefined,',
      '      invoke: async () => { throw new Error(\'unused\'); },',
      '      mcpRegistry: registry,',
      "      providerSessionId: 'provider-compiling-runtime-apps',",
      '      readAsset: async () => undefined,',
      '      readRunFlight: async () => undefined,',
      '      reconcilePreparedRuntime: async () => undefined,',
      '      replay: async () => { throw new Error(\'unused\'); },',
      "      resetState: async () => ({ stateStoreId: 'state-compiling-runtime-apps', stateVersion: 0 }),",
      '      run: () => undefined,',
      '      runs: () => [],',
      "      status: () => ({ descriptor: { environmentVariables: [], id: 'compiling-runtime-apps', label: 'Compiling Runtime Apps', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: state.phase }),",
      '      surfaces: () => [],',
      '    };',
      '  },',
      '});',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  dev: { runtime: { provider: './src/dev/provider.ts' } },",
      "  plugin: { name: 'compiling-runtime-apps', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

const workbenchSyntheticAdapter: TargetAdapter = Object.freeze({
  artifactLayout: Object.freeze({
    scripts: Object.freeze({
      allowedSuffixes: Object.freeze(['.txt']),
      directory: 'scripts',
    }),
  }),
  capabilities: Object.freeze({}),
  configExtension: Object.freeze({ key: 'workbenchSynthetic' }),
  metadata: Object.freeze({
    adapterRevision: 'test',
    capabilityRevision: 'test',
    capabilitySha256: '0'.repeat(64),
    observedVersion: 'test',
    schemas: Object.freeze([]),
  }),
  name: 'workbench-synthetic',
  plan: (model: NormalizedPlugin) => Object.freeze({
    diagnostics: Object.freeze([]),
    entries: Object.freeze([{
      content: 'synthetic workbench target\n',
      kind: 'write' as const,
      // Custom target plans use the same declared compiled-script namespace
      // as production adapters; root files are deliberately rejected.
      relativePath: 'scripts/synthetic.txt',
      sourceInputs: [model.metadata.provenance.sourcePath],
    }]),
  }),
  validateModel: () => [],
});

it('contains prebuilt workbench asset reads to their declared root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-assets-'));
  try {
    await mkdir(join(root, 'static'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'index.html'), '<!doctype html><title>Workbench</title>'),
      writeFile(join(root, 'static', 'index.js'), 'export {};\n'),
    ]);
    const assets = createWorkbenchAssetSource({ root });

    await expect(assets.read('index.html')).resolves.toMatchObject({ contentType: 'text/html; charset=utf-8' });
    await expect(assets.read('static/index.js')).resolves.toMatchObject({ contentType: 'text/javascript; charset=utf-8' });
    await expect(assets.read('../secret.txt')).resolves.toBeUndefined();
    await expect(assets.read('static/../../secret.txt')).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('starts a loopback server with prebuilt assets, does not open on --no-open, and closes its coordinator', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-page-'));
  let openCalls = 0;
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>');
  try {
    const server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      openBrowser: async () => { openCalls += 1; },
      port: 0,
      root: project.root,
    });

    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    await expect(fetch(server.url).then(async (response) => ({ body: await response.text(), status: response.status }))).resolves.toEqual({
      body: '<!doctype html><title>Agent Bundle workbench</title>',
      status: 200,
    });
    await expect(fetch(`${server.url}/api/skills/source/skill%3Areview`).then(async (response) => ({
      body: await response.json(),
      status: response.status,
    }))).resolves.toMatchObject({
      body: { document: { id: 'skill:review', frontmatter: { name: 'review' } } },
      status: 200,
    });
    expect(openCalls).toBe(0);
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(server.url)).rejects.toThrow();
  } finally {
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('normalizes a relative project root once before constructing every dev service', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-relative-root-'));
  const root = relative(process.cwd(), project.root);
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>');
  try {
    expect(root).not.toBe(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root,
    });

    expect(server.status().artifact.state).toBe('active');
    await expect(fetch(`${server.url}/api/skills/source/skill%3Areview`).then((response) => response.json())).resolves.toMatchObject({
      document: { id: 'skill:review' },
    });
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('latches a runtime declaration added to an ordinary Workbench session as restart-required', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-runtime-topology-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let events: ReturnType<typeof openProjectEventStream> | undefined;
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>');
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    await expect(fetch(`${server.url}/api/project/status`).then((response) => response.json())).resolves.toMatchObject({
      status: { artifact: { state: 'active' } },
    });
    const initialProjectStatus = await fetch(`${server.url}/api/project/status`).then((response) => response.json()) as {
      readonly status: Record<string, unknown>;
    };
    expect(Object.hasOwn(initialProjectStatus.status, 'runtime')).toBe(false);
    await expect(fetch(`${server.url}/api/runtime/status`).then((response) => response.json())).resolves.toEqual({ status: null });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    const cookie = bootstrap.headers.get('set-cookie');
    if (cookie === null) throw new Error('Expected foreground session bootstrap cookie.');
    events = openProjectEventStream(server.url, cookie);
    await events.opened;
    await writeFile(project.configPath, [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  dev: { runtime: { provider: './src/dev/provider.ts' } },",
      "  plugin: { name: 'review', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      '});',
      '',
    ].join('\n'));
    await expect(fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers: { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': token },
      method: 'POST',
    }).then((response) => response.status)).resolves.toBe(200);
    const received = await within(events.until('"restartRequired":true'), 5_000);
    expect(received).toContain('"state":"failed"');
    const afterTopologyChangeStatus = await fetch(`${server.url}/api/project/status`).then((response) => response.json()) as {
      readonly status: Record<string, unknown>;
    };
    expect(Object.hasOwn(afterTopologyChangeStatus.status, 'runtime')).toBe(false);
    await expect(fetch(`${server.url}/api/runtime/status`).then((response) => response.json())).resolves.toEqual({ status: null });
  } finally {
    events?.close();
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('keeps the ordinary foreground and artifact lane available when provider startup fails', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-runtime-failed-provider-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(join(project.root, 'src', 'dev'), { recursive: true });
  await Promise.all([
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
    writeFile(join(project.root, 'src', 'dev', 'provider.ts'), [
      'export const createDevRuntimeProvider = () => ({',
      "  descriptor: { environmentVariables: [], id: 'failed-runtime', label: 'Failed runtime', schemaVersion: 1 },",
      "  start: () => { throw new Error('Provider startup failed.'); },",
      '});',
      '',
    ].join('\n')),
    writeFile(project.configPath, [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  dev: { runtime: { provider: './src/dev/provider.ts' } },",
      "  plugin: { name: 'review', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      '});',
      '',
    ].join('\n')),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    expect(server.status().artifact.state).toBe('active');
    await expect(fetch(server.url).then(async (response) => ({ body: await response.text(), status: response.status }))).resolves.toEqual({
      body: '<!doctype html><title>Agent Bundle workbench</title>',
      status: 200,
    });
    await expect(fetch(`${server.url}/api/runtime/status`).then((response) => response.json())).resolves.toMatchObject({
      status: { diagnostics: [{ phase: 'provider-lifecycle' }], state: 'failed' },
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    await expect(fetch(`${server.url}/api/runtime/apps`, {
      body: JSON.stringify({ expectedGenerationId: 'missing-generation', profileId: 'portable', runId: 'missing-run' }),
      headers: { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': token },
      method: 'POST',
    }).then(async (response) => ({ body: await response.json(), status: response.status }))).resolves.toEqual({
      body: { diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' } },
      status: 404,
    });
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('retains Runtime App routes through invalid config updates and reconciles only repaired or removed declarations', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-late-runtime-apps-'));
  const stateKey = `__agentBundleLateRuntimeApps${Date.now()}${Math.random().toString(16).slice(2)}`;
  const runtimeState = { calls: [] as string[], closes: 0, reconciles: 0, subscribes: 0, unsubscribes: 0 };
  const runtimeGlobal = globalThis as typeof globalThis & Record<string, typeof runtimeState | undefined>;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  const config = (targets: string[], marker: string, extension?: string, includeRuntime = true): string => [
    "import { defineConfig } from 'agent-bundle';",
    '',
    'export default defineConfig({',
    ...(includeRuntime ? ["  dev: { runtime: { provider: './src/dev/provider.ts' } },"] : []),
    `  fixtureMarker: ${JSON.stringify(marker)},`,
    "  plugin: { name: 'late-runtime-apps', version: '1.0.0' },",
    "  skills: ['skills/review'],",
    `  targets: ${JSON.stringify(targets)},`,
    ...(extension === undefined ? [] : [`  portable: ${extension},`]),
    '});',
    '',
  ].join('\n');
  try {
    runtimeGlobal[stateKey] = runtimeState;
    await mkdir(join(project.root, 'src', 'dev'), { recursive: true });
    await Promise.all([
      writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
      writeFile(join(project.root, 'src', 'dev', 'provider.ts'), [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        "if (state === undefined) throw new Error('Missing late Runtime Apps test state.');",
        'const registry = {',
        '  close: async () => undefined,',
        '  closeSession: async () => undefined,',
        '  open: async () => { throw new Error(\'unused\'); },',
        '  reconcile: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
        '  restart: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
        '  session: () => undefined,',
        '  snapshot: () => undefined,',
        "  subscribe: () => { state.calls.push('subscribe'); state.subscribes += 1; return { unsubscribe: () => { state.calls.push('unsubscribe'); state.unsubscribes += 1; } }; },",
        '};',
        'export const createDevRuntimeProvider = () => ({',
        "  descriptor: { environmentVariables: [], id: 'late-runtime-apps', label: 'Late Runtime Apps', schemaVersion: 1 },",
        '  start: async () => ({',
        '    clientSurface: () => undefined,',
        "    close: async () => { state.calls.push('close'); state.closes += 1; },",
        '    invoke: async () => { throw new Error(\'unused\'); },',
        '    mcpRegistry: registry,',
        "    providerSessionId: 'provider-late-runtime-apps',",
        '    readAsset: async () => undefined,',
        '    readRunFlight: async () => undefined,',
        "    reconcilePreparedRuntime: async () => { state.calls.push('reconcile'); state.reconciles += 1; },",
        '    replay: async () => { throw new Error(\'unused\'); },',
        "    resetState: async () => ({ stateStoreId: 'state-late-runtime-apps', stateVersion: 0 }),",
        '    run: () => undefined,',
        '    runs: () => [],',
        "    status: () => ({ descriptor: { environmentVariables: [], id: 'late-runtime-apps', label: 'Late Runtime Apps', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: 'active' }),",
        '    surfaces: () => [],',
        '  }),',
        '});',
        '',
      ].join('\n')),
      // An unknown target is a model failure, but the valid development
      // declaration still constructs the fixed runtime controller.
      writeFile(project.configPath, config(['portable', 'unknown-target'], 'invalid-initial')),
    ]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    await expect(fetch(`${server.url}/api/runtime/status`).then((response) => response.json())).resolves.toMatchObject({
      status: { descriptor: { id: 'late-runtime-apps' }, state: 'active' },
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': token };
    const create = () => fetch(`${server!.url}/api/runtime/apps`, {
      body: JSON.stringify({ expectedGenerationId: 'missing-generation', profileId: 'portable', runId: 'missing-run' }),
      headers,
      method: 'POST',
    });
    const history = () => fetch(`${server!.url}/api/runtime/runs`, { headers }).then(async (response) => ({ body: await response.json(), status: response.status }));

    await expect(create().then(async (response) => ({ body: await response.json(), status: response.status }))).resolves.toEqual({
      body: { diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' } },
      status: 404,
    });
    expect(runtimeState.subscribes).toBe(0);

    await writeFile(project.configPath, config(['portable'], 'valid-first', '{}'));
    await within((async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await create();
        const result = { body: await response.json(), status: response.status };
        if (result.status === 404 && result.body.diagnostic?.code === 'AB8201') return;
        await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 25); });
      }
      throw new Error('Runtime MCP App preview did not attach after the valid config update.');
    })(), 5_000);
    expect(runtimeState.subscribes).toBe(1);
    const stableHistory = await history();
    expect(stableHistory).toEqual({
      body: { providerSessionId: expect.any(String), runs: [] },
      status: 200,
    });
    const stableRuntime = {
      calls: [...runtimeState.calls],
      closes: runtimeState.closes,
      reconciles: runtimeState.reconciles,
      subscribes: runtimeState.subscribes,
      unsubscribes: runtimeState.unsubscribes,
    };

    await writeFile(project.configPath, config(['portable'], 'invalid-nonfinite', 'Number.NaN'));
    const invalid = await fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers,
      method: 'POST',
    }).then(async (response) => ({ body: await response.json(), status: response.status }));
    expect(invalid).toMatchObject({
      body: {
        status: {
          source: {
            diagnostics: [{
              code: 'AB4500',
              message: 'A registered config extension must contain strict finite JSON data.',
              sourcePath: project.configPath,
            }],
            state: 'invalid',
          },
        },
      },
      status: 200,
    });
    expect(runtimeState).toEqual(stableRuntime);
    await expect(history()).resolves.toEqual(stableHistory);
    await expect(create().then(async (response) => ({ body: await response.json(), status: response.status }))).resolves.toEqual({
      body: { diagnostic: { code: 'AB8201', message: 'Runtime MCP App run is not available.' } },
      status: 404,
    });

    await expect(fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers,
      method: 'POST',
    }).then((response) => response.status)).resolves.toBe(200);
    expect(runtimeState).toEqual(stableRuntime);

    await writeFile(project.configPath, config(['portable'], 'valid-repair', '{}'));
    await expect(fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers,
      method: 'POST',
    }).then((response) => response.status)).resolves.toBe(200);
    expect(runtimeState).toEqual({
      calls: [...stableRuntime.calls, 'reconcile'],
      closes: stableRuntime.closes,
      reconciles: stableRuntime.reconciles + 1,
      subscribes: stableRuntime.subscribes,
      unsubscribes: stableRuntime.unsubscribes,
    });

    await writeFile(project.configPath, config(['portable'], 'valid-removal', undefined, false));
    await expect(fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers,
      method: 'POST',
    }).then((response) => response.status)).resolves.toBe(200);
    expect(runtimeState).toEqual({
      calls: [...stableRuntime.calls, 'reconcile'],
      closes: stableRuntime.closes,
      reconciles: stableRuntime.reconciles + 1,
      subscribes: stableRuntime.subscribes,
      unsubscribes: stableRuntime.unsubscribes,
    });
    await expect(fetch(`${server.url}/api/runtime/status`).then((response) => response.json())).resolves.toMatchObject({
      status: {
        diagnostics: [{ code: 'AB8200', message: 'Development runtime declaration changed; restart required.', phase: 'provider-lifecycle' }],
        state: 'failed',
      },
    });
    await expect(create().then(async (response) => ({ body: await response.json(), status: response.status }))).resolves.toEqual({
      body: { diagnostic: { code: 'AB8023', message: 'MCP App operation could not be completed.' } },
      status: 502,
    });

    await expect(server.close()).resolves.toBeUndefined();
    expect(runtimeState.unsubscribes).toBe(1);
  } finally {
    delete runtimeGlobal[stateKey];
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('fences a closing foreground before a held valid runtime reconcile can attach an App preview service', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-late-runtime-close-'));
  const stateKey = `__agentBundleLateRuntimeClose${Date.now()}${Math.random().toString(16).slice(2)}`;
  let enteredReconcile: () => void = () => undefined;
  let releaseReconcile: () => void = () => undefined;
  const reconcileEntered = new Promise<void>((resolvePromise) => { enteredReconcile = resolvePromise; });
  const reconcileReleased = new Promise<void>((resolvePromise) => { releaseReconcile = resolvePromise; });
  const runtimeState = { subscribes: 0, unsubscribes: 0, enteredReconcile, reconcileReleased };
  const runtimeGlobal = globalThis as typeof globalThis & Record<string, typeof runtimeState | undefined>;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  const config = (targets: string[]): string => [
    "import { defineConfig } from 'agent-bundle';",
    '',
    'export default defineConfig({',
    "  dev: { runtime: { provider: './src/dev/provider.ts' } },",
    "  plugin: { name: 'late-runtime-close', version: '1.0.0' },",
    "  skills: ['skills/review'],",
    `  targets: ${JSON.stringify(targets)},`,
    '});',
    '',
  ].join('\n');
  try {
    runtimeGlobal[stateKey] = runtimeState;
    await mkdir(join(project.root, 'src', 'dev'), { recursive: true });
    await Promise.all([
      writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
      writeFile(join(project.root, 'src', 'dev', 'provider.ts'), [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        "if (state === undefined) throw new Error('Missing late Runtime Apps close state.');",
        'const registry = {',
        '  close: async () => undefined,',
        '  closeSession: async () => undefined,',
        '  open: async () => { throw new Error(\'unused\'); },',
        '  reconcile: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
        '  restart: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
        '  session: () => undefined,',
        '  snapshot: () => undefined,',
        '  subscribe: () => { state.subscribes += 1; return { unsubscribe: () => { state.unsubscribes += 1; } }; },',
        '};',
        'export const createDevRuntimeProvider = () => ({',
        "  descriptor: { environmentVariables: [], id: 'late-runtime-close', label: 'Late Runtime Close', schemaVersion: 1 },",
        '  start: async () => ({',
        '    clientSurface: () => undefined,',
        '    close: async () => undefined,',
        '    invoke: async () => { throw new Error(\'unused\'); },',
        '    mcpRegistry: registry,',
        "    providerSessionId: 'provider-late-runtime-close',",
        '    readAsset: async () => undefined,',
        '    readRunFlight: async () => undefined,',
        '    reconcilePreparedRuntime: async () => { state.enteredReconcile(); await state.reconcileReleased; },',
        '    replay: async () => { throw new Error(\'unused\'); },',
        "    resetState: async () => ({ stateStoreId: 'state-late-runtime-close', stateVersion: 0 }),",
        '    run: () => undefined,',
        '    runs: () => [],',
        "    status: () => ({ descriptor: { environmentVariables: [], id: 'late-runtime-close', label: 'Late Runtime Close', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: 'active' }),",
        '    surfaces: () => [],',
        '  }),',
        '});',
        '',
      ].join('\n')),
      writeFile(project.configPath, config(['portable', 'unknown-target'])),
    ]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': token };
    await writeFile(project.configPath, config(['portable']));
    const rebuilding = fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers,
      method: 'POST',
    });
    await within(reconcileEntered, 5_000);
    const closing = server.close();
    releaseReconcile();
    await Promise.allSettled([rebuilding]);
    await expect(closing).resolves.toBeUndefined();
    expect(runtimeState.subscribes).toBe(0);
    expect(runtimeState.unsubscribes).toBe(0);
  } finally {
    releaseReconcile();
    delete runtimeGlobal[stateKey];
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('does not reconcile a valid preparation released after foreground close begins', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-prepared-runtime-close-'));
  const stateKey = `__agentBundlePreparedRuntimeClose${Date.now()}${Math.random().toString(16).slice(2)}`;
  let enteredPrepare: () => void = () => undefined;
  let releasePrepare: () => void = () => undefined;
  const preparationEntered = new Promise<void>((resolvePromise) => { enteredPrepare = resolvePromise; });
  const preparationReleased = new Promise<void>((resolvePromise) => { releasePrepare = resolvePromise; });
  const runtimeState = {
    calls: [] as string[],
    closes: 0,
    enteredPrepare,
    preparationReleased,
    reconciles: 0,
    subscribes: 0,
    unsubscribes: 0,
  };
  const runtimeGlobal = globalThis as typeof globalThis & Record<string, typeof runtimeState | undefined>;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  const config = (marker: string, holdPreparation = false): string => {
    const declaration = [
      "  dev: { runtime: { provider: './src/dev/provider.ts' } },",
      `  fixtureMarker: ${JSON.stringify(marker)},`,
      "  plugin: { name: 'prepared-runtime-close', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
    ];
    return [
      "import { defineConfig } from 'agent-bundle';",
      '',
      ...(holdPreparation ? [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        "if (state === undefined) throw new Error('Missing prepared Runtime Apps close state.');",
        'export default async () => {',
        '  state.enteredPrepare();',
        '  await state.preparationReleased;',
        '  return defineConfig({',
        ...declaration,
        '  });',
        '};',
      ] : [
        'export default defineConfig({',
        ...declaration,
        '});',
      ]),
      '',
    ].join('\n');
  };
  try {
    runtimeGlobal[stateKey] = runtimeState;
    await mkdir(join(project.root, 'src', 'dev'), { recursive: true });
    await Promise.all([
      writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
      writeFile(join(project.root, 'src', 'dev', 'provider.ts'), [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        "if (state === undefined) throw new Error('Missing prepared Runtime Apps close state.');",
        'const registry = {',
        '  close: async () => undefined,',
        '  closeSession: async () => undefined,',
        '  open: async () => { throw new Error(\'unused\'); },',
        '  reconcile: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
        '  restart: async () => ({ invalidatedBindings: [], registryRevision: 0 }),',
        '  session: () => undefined,',
        '  snapshot: () => undefined,',
        "  subscribe: () => { state.calls.push('subscribe'); state.subscribes += 1; return { unsubscribe: () => { state.calls.push('unsubscribe'); state.unsubscribes += 1; } }; },",
        '};',
        'export const createDevRuntimeProvider = () => ({',
        "  descriptor: { environmentVariables: [], id: 'prepared-runtime-close', label: 'Prepared Runtime Close', schemaVersion: 1 },",
        '  start: async () => ({',
        '    clientSurface: () => undefined,',
        "    close: async () => { state.calls.push('close'); state.closes += 1; },",
        '    invoke: async () => { throw new Error(\'unused\'); },',
        '    mcpRegistry: registry,',
        "    providerSessionId: 'provider-prepared-runtime-close',",
        '    readAsset: async () => undefined,',
        '    readRunFlight: async () => undefined,',
        "    reconcilePreparedRuntime: async () => { state.calls.push('reconcile'); state.reconciles += 1; },",
        '    replay: async () => { throw new Error(\'unused\'); },',
        "    resetState: async () => ({ stateStoreId: 'state-prepared-runtime-close', stateVersion: 0 }),",
        '    run: () => undefined,',
        '    runs: () => [],',
        "    status: () => ({ descriptor: { environmentVariables: [], id: 'prepared-runtime-close', label: 'Prepared Runtime Close', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: 'active' }),",
        '    surfaces: () => [],',
        '  }),',
        '});',
        '',
      ].join('\n')),
      writeFile(project.configPath, config('initial')),
    ]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': token };
    const stableRuntime = {
      closes: runtimeState.closes,
      reconciles: runtimeState.reconciles,
      subscribes: runtimeState.subscribes,
    };

    await writeFile(project.configPath, config('held-after-close', true));
    const rebuilding = fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['agent-bundle.config.ts'] }),
      headers,
      method: 'POST',
    });
    await within(preparationEntered, 5_000);
    const closing = server.close();
    releasePrepare();
    await Promise.allSettled([rebuilding]);
    await expect(closing).resolves.toBeUndefined();
    expect(runtimeState).toMatchObject({
      closes: stableRuntime.closes + 1,
      reconciles: stableRuntime.reconciles,
      subscribes: stableRuntime.subscribes,
      unsubscribes: 1,
    });
    expect(runtimeState.calls).not.toContain('reconcile');
  } finally {
    releasePrepare();
    delete runtimeGlobal[stateKey];
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('does not publish a prepared runtime topology after foreground close begins', async () => {
  const project = await createProjectFixture();
  const stateKey = `__agentBundlePreparedTopologyClose${Date.now()}${Math.random().toString(16).slice(2)}`;
  let enteredPrepare: () => void = () => undefined;
  let releasePrepare: () => void = () => undefined;
  const preparationEntered = new Promise<void>((resolvePromise) => { enteredPrepare = resolvePromise; });
  const preparationReleased = new Promise<void>((resolvePromise) => { releasePrepare = resolvePromise; });
  const preparationState = { enteredPrepare, preparationReleased };
  const runtimeGlobal = globalThis as typeof globalThis & Record<string, typeof preparationState | undefined>;
  let coordinator: ForegroundCoordinator | undefined;
  let unsubscribeEvents: (() => void) | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let restartRequiredEvents = 0;
  try {
    runtimeGlobal[stateKey] = preparationState;
    server = await startDevServer({
      open: false,
      port: 0,
      root: project.root,
      testing: {
        startForegroundServer: async (options) => {
          await options.coordinator.start();
          coordinator = options.coordinator;
          const subscription = options.eventHub.subscribe((event) => {
            if (
              event.type === 'runtime.event' && event.payload.type === 'runtime.status' &&
              event.payload.details?.restartRequired === true
            ) restartRequiredEvents += 1;
          });
          unsubscribeEvents = () => subscription.unsubscribe();
          return {
            close: () => options.coordinator.close(),
            url: 'http://127.0.0.1:49123',
          };
        },
      },
    });
    await writeFile(project.configPath, [
      "import { defineConfig } from 'agent-bundle';",
      `const state = globalThis[${JSON.stringify(stateKey)}];`,
      "if (state === undefined) throw new Error('Missing prepared topology close state.');",
      'export default async () => {',
      '  state.enteredPrepare();',
      '  await state.preparationReleased;',
      '  return defineConfig({',
      "    dev: { runtime: { provider: './src/dev/provider.ts' } },",
      "    plugin: { name: 'prepared-topology-close', version: '1.0.0' },",
      "    skills: ['skills/review'],",
      "    targets: ['portable'],",
      '  });',
      '};',
      '',
    ].join('\n'));
    const rebuilding = coordinator?.rebuild({
      occurredAt: new Date().toISOString(),
      paths: ['agent-bundle.config.ts'],
      reason: 'manual',
    });
    if (rebuilding === undefined) throw new Error('Foreground coordinator was not captured.');
    await within(preparationEntered, 5_000);
    const closing = server.close();
    releasePrepare();
    await Promise.allSettled([rebuilding]);
    await expect(closing).resolves.toBeUndefined();
    expect(restartRequiredEvents).toBe(0);
  } finally {
    releasePrepare();
    unsubscribeEvents?.();
    delete runtimeGlobal[stateKey];
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 30_000);

it('attaches Runtime App routes once when a compiling provider later activates, even if registry subscription re-enters status delivery', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-compiling-runtime-apps-'));
  const stateKey = `__agentBundleCompilingRuntimeApps${Date.now()}${Math.random().toString(16).slice(2)}`;
  const runtimeState: CompilingRuntimeAppState = { emit: undefined, phase: 'compiling', subscribes: 0, unsubscribes: 0 };
  const runtimeGlobal = globalThis as typeof globalThis & Record<string, CompilingRuntimeAppState | undefined>;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    runtimeGlobal[stateKey] = runtimeState;
    await Promise.all([
      writeCompilingRuntimeAppProject(project.root, stateKey),
      writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
    ]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    const create = () => fetch(`${server!.url}/api/runtime/apps`, {
      body: JSON.stringify({ expectedGenerationId: 'missing-generation', profileId: 'portable', runId: 'missing-run' }),
      headers: { 'content-type': 'application/json', origin: server!.url, 'x-agent-bundle-session': token },
      method: 'POST',
    });

    await expect(create().then(async (response) => ({ body: await response.json(), status: response.status }))).resolves.toEqual({
      body: { diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' } },
      status: 404,
    });
    expect(runtimeState.subscribes).toBe(0);

    runtimeState.phase = 'active';
    runtimeState.emit?.({ type: 'runtime.generation.activated' });
    await expect(create().then(async (response) => ({ body: await response.json(), status: response.status }))).resolves.toEqual({
      body: { diagnostic: { code: 'AB8201', message: 'Runtime MCP App run is not available.' } },
      status: 404,
    });
    expect(runtimeState.subscribes).toBe(1);
    runtimeState.emit?.({ type: 'runtime.generation.activated' });
    runtimeState.emit?.({ type: 'runtime.status' });
    expect(runtimeState.subscribes).toBe(1);

    await expect(server.close()).resolves.toBeUndefined();
    expect(runtimeState.unsubscribes).toBe(1);
  } finally {
    delete runtimeGlobal[stateKey];
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('does not attach a compiling Runtime App preview service after foreground close fences a late activation', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-compiling-runtime-close-'));
  const stateKey = `__agentBundleCompilingRuntimeClose${Date.now()}${Math.random().toString(16).slice(2)}`;
  const runtimeState: CompilingRuntimeAppState = { emit: undefined, phase: 'compiling', subscribes: 0, unsubscribes: 0 };
  const runtimeGlobal = globalThis as typeof globalThis & Record<string, CompilingRuntimeAppState | undefined>;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    runtimeGlobal[stateKey] = runtimeState;
    await Promise.all([
      writeCompilingRuntimeAppProject(project.root, stateKey),
      writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
    ]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const closing = server.close();
    runtimeState.phase = 'active';
    runtimeState.emit?.({ type: 'runtime.generation.activated' });
    await expect(closing).resolves.toBeUndefined();
    expect(runtimeState.subscribes).toBe(0);
    expect(runtimeState.unsubscribes).toBe(0);
  } finally {
    delete runtimeGlobal[stateKey];
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('prepares the optional runtime once with the development config context before provider startup', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-runtime-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let failedServer: Awaited<ReturnType<typeof startDevServer>> | undefined;
  const boundOrigins: string[] = [];
  let resolveSurface: ((binding: { readonly bootstrapUrl: string; close(): Promise<void>; readonly origin: string; readonly surfaceId: string; readonly webSocketPath: '/rsbuild-hmr' }) => void) | undefined;
  const pendingSurface = new Promise<{ readonly bootstrapUrl: string; close(): Promise<void>; readonly origin: string; readonly surfaceId: string; readonly webSocketPath: '/rsbuild-hmr' }>((resolvePromise) => {
    resolveSurface = resolvePromise;
  });
  let proxyCalls = 0;
  let surfaceCloseCalls = 0;
  await mkdir(join(project.root, 'src', 'dev'), { recursive: true });
  await Promise.all([
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
    writeFile(join(project.root, 'src', 'dev', 'provider.ts'), [
      "import { writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      '',
      'export const createDevRuntimeProvider = () => ({',
      "  descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 },",
      '  start: async (context) => {',
      "    await writeFile(join(context.projectRoot, 'provider-context.json'), JSON.stringify({",
      '      artifact: context.artifactStatus(),',
      '      environment: context.environment,',
      '      preparedRuntime: context.preparedRuntime,',
      '      providerSessionId: context.providerSessionId,',
      '      projectRoot: context.projectRoot,',
      '      storageRoot: context.storageRoot,',
      '    }));',
      '    return {',
      "      clientSurface: (surfaceId) => surfaceId === 'timeline' ? { entryPath: '/', httpOrigin: 'http://127.0.0.1:41111', httpPathPrefixes: ['/'], surfaceId, webSocketOrigin: 'ws://127.0.0.1:41111', webSocketPath: '/rsbuild-hmr', webSocketToken: 'rsbuild-token-1234' } : undefined,",
      '      close: async () => undefined,',
      '      mcpRegistry: {},',
      '      providerSessionId: context.providerSessionId,',
      '      status: () => ({ descriptor: { environmentVariables: [], id: \'fixture-runtime\', label: \'Fixture runtime\', schemaVersion: 1 }, diagnostics: [], hmrReady: false, state: \'active\' }),',
      '      surfaces: () => [],',
      '    };',
      '  },',
      '});',
      '',
    ].join('\n')),
    writeFile(project.configPath, [
      "import { appendFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig(async ({ command, mode, projectRoot }) => {',
      "  await appendFile(join(projectRoot, 'config-calls.ndjson'), JSON.stringify({ command, mode }) + '\\n');",
      '  return {',
      "    dev: { runtime: { provider: './src/dev/provider.ts' } },",
      "    plugin: { name: 'runtime-fixture', version: '1.0.0' },",
      "    skills: ['skills/review'],",
      '  };',
      '});',
      '',
    ].join('\n')),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
      testing: {
        openRuntimeClientSurface: async (_endpoint, _listener, hostOrigin) => {
          proxyCalls += 1;
          boundOrigins.push(hostOrigin);
          return pendingSurface.then((binding) => binding);
        },
      },
    });

    const [calls, context, runtimeStatus, projectStatus] = await Promise.all([
      readFile(join(project.root, 'config-calls.ndjson'), 'utf8'),
      readFile(join(project.root, 'provider-context.json'), 'utf8').then(JSON.parse) as Promise<Record<string, unknown>>,
      fetch(`${server.url}/api/runtime/status`).then((response) => response.json()),
      fetch(`${server.url}/api/project/status`).then((response) => response.json()),
    ]);
    expect(calls.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { command: 'dev', mode: 'development' },
    ]);
    expect(context).toMatchObject({
      artifact: { state: 'active' },
      environment: {},
      preparedRuntime: { provider: './src/dev/provider.ts' },
      projectRoot: project.root,
      storageRoot: expect.stringMatching(new RegExp(`^${join(project.root, '.agent-bundle', 'runtime').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/`)),
    });
    expect(runtimeStatus).toMatchObject({ status: { descriptor: { id: 'fixture-runtime' }, state: 'active' } });
    expect(projectStatus).toMatchObject({ status: { runtime: { state: 'configured' } } });
    expect((projectStatus as { readonly status: { readonly runtime?: unknown } }).status.runtime).toEqual({ state: 'configured' });
    await expect(server.openRuntimeClientSurface('unknown-surface')).resolves.toBeUndefined();
    const opening = server.openRuntimeClientSurface('timeline');
    // The test seam records synchronously before returning its unresolved
    // promise, proving foreground shutdown races an actually pending open.
    expect(proxyCalls).toBe(1);
    expect(boundOrigins).toEqual([server.url]);
    const closing = server.close();
    expect(surfaceCloseCalls).toBe(0);
    resolveSurface?.({
      bootstrapUrl: 'http://127.0.0.1:41112/bootstrap',
      close: async () => { surfaceCloseCalls += 1; },
      origin: 'http://127.0.0.1:41112',
      surfaceId: 'timeline',
      webSocketPath: '/rsbuild-hmr',
    });
    await expect(opening).rejects.toThrow('closed');
    await expect(closing).resolves.toBeUndefined();
    expect(proxyCalls).toBe(1);
    expect(surfaceCloseCalls).toBe(1);
    await expect(server.openRuntimeClientSurface('unknown-surface')).rejects.toThrow('closed');
    let failedCloseCalls = 0;
    failedServer = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
      testing: {
        openRuntimeClientSurface: async () => ({
          bootstrapUrl: 'http://127.0.0.1:41113/bootstrap',
          close: async () => { failedCloseCalls += 1; throw new Error('Completed client surface close failed.'); },
          origin: 'http://127.0.0.1:41113',
          surfaceId: 'timeline',
          webSocketPath: '/rsbuild-hmr',
        }),
      },
    });
    await expect(failedServer.openRuntimeClientSurface('timeline')).resolves.toMatchObject({ surfaceId: 'timeline' });
    await expect(failedServer.close()).rejects.toMatchObject({ name: 'ForegroundServerCloseError' });
    expect(failedCloseCalls).toBe(1);
  } finally {
    await server?.close().catch(() => undefined);
    await failedServer?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('builds and serves a target owned only by the workbench registry', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-custom-registry-'));
  const registry = new TargetRegistry().register(workbenchSyntheticAdapter, { default: true });
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    await Promise.all([
      writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
      writeFile(join(project.root, 'agent-bundle.config.ts'), [
        'export default {',
        "  plugin: { name: 'workbench-custom-registry', version: '1.0.0' },",
        "  targets: ['workbench-synthetic'],",
        '  workbenchSynthetic: { enabled: true },',
        '};',
        '',
      ].join('\n')),
    ]);

    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      registry,
      root: project.root,
    });
    const status = server.status().artifact;
    if (status.state !== 'active') throw new Error('Expected the custom target to produce an active artifact.');
    expect(status.activeEpoch.targetDigests).toHaveProperty('workbench-synthetic');
    await expect(fetch(`${server.url}/api/project/status`).then((response) => response.status)).resolves.toBe(200);
    expect(registry.names()).toEqual(['workbench-synthetic']);
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('binds real epoch MCP sessions to the workbench lifecycle and drains trace readers before cleanup', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-mcp-'));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    writeMcpProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };
    const created = await fetch(`${server.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: artifact.activeEpoch.id, serverName: 'fixture', target: 'portable' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(200);
    const { session } = await created.json() as { readonly session: { readonly id: string } };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/u);

    const config = await fetch(`${server.url}/api/mcp/sessions/${session.id}/config`, { headers });
    const configBody = await config.json() as { readonly config: { readonly origin: string } };
    expect(configBody.config.origin).toBe('artifact');

    const trace = await fetch(`${server.url}/api/mcp/sessions/${session.id}/stream?after=0`, { headers });
    reader = trace.body?.getReader();
    if (reader === undefined) throw new Error('Expected an MCP trace stream.');

    const closing = server.close();
    await expect(within(readToEnd(reader), 1_000)).resolves.toContain('"kind":"operation"');
    await expect(closing).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${server.url}/api/mcp/sessions/${session.id}`, { headers })).rejects.toThrow();
    await expect(access(join(project.root, '.agent-bundle', 'epochs', artifact.activeEpoch.id))).resolves.toBeUndefined();
  } finally {
    await reader?.cancel();
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 60_000);

it('hosts real MCP App previews only on the foreground origin and closes their leases with the dev lifecycle', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-mcp-app-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    writeMcpProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };
    const created = await fetch(`${server.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: artifact.activeEpoch.id, serverName: 'fixture', target: 'portable' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(200);
    const { session } = await created.json() as { readonly session: { readonly id: string } };

    const preview = await fetch(`${server.url}/api/mcp/sessions/${session.id}/apps`, {
      body: JSON.stringify(appPreviewBody()),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(preview.status).toBe(200);
    const body = await preview.json() as { readonly preview: { readonly bindingId: string; readonly frame?: { readonly src: string } } };
    expect(body.preview.bindingId).toMatch(/^[0-9a-f-]{36}$/u);
    if (body.preview.frame === undefined) throw new Error('Expected the portable preview to include a sandbox frame.');
    const sandboxOrigin = new URL(body.preview.frame.src).origin;
    expect(sandboxOrigin).not.toBe(server.url);

    await expect(fetch(`${sandboxOrigin}/api/project/session`, { headers }).then((response) => response.status)).resolves.toBe(404);
    await expect(fetch(`${sandboxOrigin}/api/mcp/sessions`, { headers }).then((response) => response.status)).resolves.toBe(404);

    await expect(fetch(`${server.url}/api/mcp/apps/${body.preview.bindingId}`, {
      headers,
      method: 'DELETE',
    }).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${server.url}/api/mcp/sessions/${session.id}`, {
      headers,
      method: 'DELETE',
    }).then((response) => response.status)).resolves.toBe(200);
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(sandboxOrigin)).rejects.toThrow();
    await expect(access(join(project.root, '.agent-bundle', 'epochs', artifact.activeEpoch.id))).resolves.toBeUndefined();
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 60_000);

it('simulates and replays real epoch-bound hooks through the packaged foreground server', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-hooks-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    writeHookProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const epochId = artifact.activeEpoch.id;
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };

    const unauthorized = await fetch(`${server.url}/api/hooks?epochId=${epochId}`, { headers: { origin: server.url } });
    expect(unauthorized.status).toBe(403);

    const listed = await fetch(`${server.url}/api/hooks?epochId=${epochId}&target=claude`, { headers });
    expect(listed.status).toBe(200);
    const { hooks } = await listed.json() as {
      readonly hooks: readonly { readonly binding: { readonly epochId: string; readonly hook: string; readonly target: string } }[];
    };
    expect(hooks).toHaveLength(1);
    const binding = hooks[0]!.binding;
    expect(binding.epochId).toBe(epochId);
    expect(binding.target).toBe('claude');

    const simulated = await fetch(`${server.url}/api/hooks/simulations`, {
      body: JSON.stringify({
        ...binding,
        input: {
          inline: {
            cwd: '/workspace',
            sessionId: 'session-1',
            source: 'startup',
            transcriptPath: '/workspace/transcript.json',
          },
        },
      }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(simulated.status).toBe(200);
    const { simulation } = await simulated.json() as {
      readonly simulation: {
        readonly binding: typeof binding;
        readonly canonicalResult?: Readonly<Record<string, unknown>>;
        readonly hostMapping: { readonly canonicalEvent: string; readonly nativeEvent: string; readonly wrapperPath: string };
        readonly replay: { readonly binding: typeof binding; readonly input: Readonly<Record<string, unknown>> };
      };
    };
    expect(simulation.binding).toEqual(binding);
    expect(simulation.hostMapping.canonicalEvent).toBe('sessionStart');
    expect(simulation.hostMapping.nativeEvent).toBe('SessionStart');
    expect(simulation.canonicalResult).toMatchObject({ additionalContext: 'workbench:startup' });

    const replayed = await fetch(`${server.url}/api/hooks/replays`, {
      body: JSON.stringify(simulation.replay),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual({ simulation });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${server.url}/api/hooks?epochId=${epochId}`, { headers })).rejects.toThrow();
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 60_000);

it('records a durable playground trace and promotes it through the packaged foreground server', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-playground-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    writeHookProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const epoch = artifact.activeEpoch;
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };
    const jsonHeaders = { ...headers, 'content-type': 'application/json' };

    const opened = await fetch(`${server.url}/api/playground/sessions`, {
      body: JSON.stringify({
        epoch: { digest: epoch.targetDigests.claude, id: epoch.id },
        fixture: { digest: 'sha256-fixture', id: 'fixture-a' },
        invocation: { intent: { hook: 'session-start' }, kind: 'hook' },
        target: { digest: epoch.targetDigests.claude, name: 'claude' },
        task: { id: 'task-a', text: 'Record one hook simulation.' },
      }),
      headers: jsonHeaders,
      method: 'POST',
    });
    expect(opened.status).toBe(200);
    const { session } = await opened.json() as { readonly session: { readonly id: string; readonly state: string } };
    expect(session.state).toBe('open');

    const appended = await fetch(`${server.url}/api/playground/sessions/${session.id}/events`, {
      body: JSON.stringify({
        kind: 'hook.simulated',
        raw: { outcome: 'continue' },
        source: 'hook',
        summary: 'Simulated the session start hook.',
      }),
      headers: jsonHeaders,
      method: 'POST',
    });
    expect(appended.status).toBe(200);
    const { event } = await appended.json() as { readonly event: { readonly rawEventRef: string; readonly sequence: number } };
    expect(event.sequence).toBe(1);

    const finalized = await fetch(`${server.url}/api/playground/sessions/${session.id}/finalize`, {
      body: JSON.stringify({ response: 'continued', status: 'passed' }),
      headers: jsonHeaders,
      method: 'POST',
    });
    expect(finalized.status).toBe(200);

    const exported = await fetch(`${server.url}/api/playground/sessions/${session.id}/export`, { headers });
    expect(exported.status).toBe(200);
    const exportBody = await exported.json() as {
      readonly export: {
        readonly events: readonly { readonly rawEventRef: string }[];
        readonly schemaVersion: number;
        readonly session: { readonly identity: { readonly epoch: { readonly id: string } } };
      };
    };
    expect(exportBody.export.schemaVersion).toBe(1);
    expect(exportBody.export.session.identity.epoch.id).toBe(epoch.id);
    expect(exportBody.export.events.map((entry) => entry.rawEventRef)).toEqual([event.rawEventRef]);

    const promoted = await fetch(`${server.url}/api/playground/sessions/${session.id}/draft-eval`, {
      body: JSON.stringify({
        assertions: [{ evidence: event.rawEventRef, expectation: 'continue', id: 'assertion-a', kind: 'hook-outcome' }],
      }),
      headers: jsonHeaders,
      method: 'POST',
    });
    expect(promoted.status).toBe(200);
    const { draftEvalCase } = await promoted.json() as {
      readonly draftEvalCase: {
        readonly epoch: { readonly id: string };
        readonly outcome: { readonly status: string };
        readonly schemaVersion: number;
      };
    };
    expect(draftEvalCase).toMatchObject({
      epoch: { id: epoch.id },
      outcome: { status: 'passed' },
      schemaVersion: 1,
    });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${server.url}/api/playground/sessions/${session.id}`, { headers })).rejects.toThrow();
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 60_000);

it('inspects and diffs published epochs through the packaged foreground server', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-artifacts-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    writeHookProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const epochId = artifact.activeEpoch.id;
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };

    const inspected = await fetch(`${server.url}/api/artifacts/epochs/${epochId}`, { headers });
    expect(inspected.status).toBe(200);
    const { inspection } = await inspected.json() as {
      readonly inspection: {
        readonly epochId: string;
        readonly provenance: readonly { readonly outputPath: string }[];
        readonly runtime: {
          readonly hooks: readonly { readonly event: string; readonly file: { readonly sha256: string }; readonly path: string }[];
        };
        readonly targets: readonly { readonly name: string }[];
      };
    };
    expect(inspection.epochId).toBe(epochId);
    expect(inspection.targets.map((target) => target.name)).toEqual(['claude']);
    expect(inspection.runtime.hooks.map((hook) => hook.event)).toEqual(['sessionStart']);
    const hookPath = inspection.runtime.hooks[0]!.path;
    expect(inspection.runtime.hooks[0]!.file.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.provenance.map((entry) => entry.outputPath)).toContain(hookPath);

    const selfDiff = await fetch(`${server.url}/api/artifacts/diff?base=${epochId}&candidate=${epochId}`, { headers });
    expect(selfDiff.status).toBe(200);
    const { diff } = await selfDiff.json() as {
      readonly diff: { readonly added: readonly unknown[]; readonly changed: readonly unknown[]; readonly removed: readonly unknown[] };
    };
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);

    const missing = await fetch(`${server.url}/api/artifacts/epochs/epoch-does-not-exist`, { headers });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      diagnostic: { code: 'AB8067', message: 'Artifact epoch was not found.' },
    });

    const unauthorized = await fetch(`${server.url}/api/artifacts/epochs/${epochId}`, { headers: { origin: server.url } });
    expect(unauthorized.status).toBe(403);
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 60_000);

it('retains a playground cleanup failure alongside every other lifecycle resource', async () => {
  const playgroundFailure = new Error('Playground cleanup failed.');
  const closeOrder: string[] = [];

  await expect(closeDevServerLifecycle({
    coordinator: { close: async () => { closeOrder.push('coordinator'); } },
    mcpApps: { close: async () => { closeOrder.push('mcp-apps'); } },
    mcpSessions: { close: async () => { closeOrder.push('mcp-sessions'); } },
    playground: { close: async () => { closeOrder.push('playground'); throw playgroundFailure; } },
  })).rejects.toEqual(expect.objectContaining({
    failures: [{ error: playgroundFailure, resource: 'playground' }],
    name: DevServerLifecycleCloseError.name,
  }));
  expect(closeOrder).toEqual(['mcp-apps', 'mcp-sessions', 'playground', 'coordinator']);
});

it('keeps MCP and coordinator cleanup failures structural while releasing both resources', async () => {
  const mcpFailure = new Error('MCP cleanup failed.');
  const coordinatorFailure = new Error('Coordinator cleanup failed.');
  let mcpCloseCalls = 0;
  let coordinatorCloseCalls = 0;

  await expect(closeDevServerLifecycle({
    coordinator: { close: async () => { coordinatorCloseCalls += 1; throw coordinatorFailure; } },
    mcpSessions: { close: async () => { mcpCloseCalls += 1; throw mcpFailure; } },
  })).rejects.toEqual(expect.objectContaining({
    failures: [
      { error: mcpFailure, resource: 'mcp-sessions' },
      { error: coordinatorFailure, resource: 'coordinator' },
    ],
    name: DevServerLifecycleCloseError.name,
  }));
  expect(mcpCloseCalls).toBe(1);
  expect(coordinatorCloseCalls).toBe(1);
});

it('closes MCP Apps before sessions and the coordinator while retaining every cleanup failure', async () => {
  const appFailure = new Error('MCP App cleanup failed.');
  const mcpFailure = new Error('MCP cleanup failed.');
  const coordinatorFailure = new Error('Coordinator cleanup failed.');
  const closeOrder: string[] = [];

  await expect(closeDevServerLifecycle({
    coordinator: { close: async () => { closeOrder.push('coordinator'); throw coordinatorFailure; } },
    mcpApps: { close: async () => { closeOrder.push('mcp-apps'); throw appFailure; } },
    mcpSessions: { close: async () => { closeOrder.push('mcp-sessions'); throw mcpFailure; } },
  })).rejects.toEqual(expect.objectContaining({
    failures: [
      { error: appFailure, resource: 'mcp-apps' },
      { error: mcpFailure, resource: 'mcp-sessions' },
      { error: coordinatorFailure, resource: 'coordinator' },
    ],
    name: DevServerLifecycleCloseError.name,
  }));
  expect(closeOrder).toEqual(['mcp-apps', 'mcp-sessions', 'coordinator']);
});

it('closes every named lifecycle resource in ownership order without losing failures', async () => {
  const clientFailure = new Error('Runtime client surface cleanup failed.');
  const appFailure = new Error('MCP App cleanup failed.');
  const runtimeFailure = new Error('Runtime cleanup failed.');
  const mcpFailure = new Error('MCP cleanup failed.');
  const playgroundFailure = new Error('Playground cleanup failed.');
  const coordinatorFailure = new Error('Coordinator cleanup failed.');
  const closeOrder: string[] = [];

  await expect(closeDevServerLifecycle({
    coordinator: { close: async () => { closeOrder.push('coordinator'); throw coordinatorFailure; } },
    mcpApps: { close: async () => { closeOrder.push('mcp-apps'); throw appFailure; } },
    mcpSessions: { close: async () => { closeOrder.push('mcp-sessions'); throw mcpFailure; } },
    runtimeResources: {
      clientSurfaces: { close: async () => { closeOrder.push('runtime-client-surfaces'); throw clientFailure; } },
      runtime: { close: async () => { closeOrder.push('runtime'); throw runtimeFailure; } },
    },
    playground: { close: async () => { closeOrder.push('playground'); throw playgroundFailure; } },
  })).rejects.toEqual(expect.objectContaining({
    failures: [
      { error: appFailure, resource: 'mcp-apps' },
      { error: clientFailure, resource: 'runtime-client-surfaces' },
      { error: runtimeFailure, resource: 'runtime' },
      { error: mcpFailure, resource: 'mcp-sessions' },
      { error: playgroundFailure, resource: 'playground' },
      { error: coordinatorFailure, resource: 'coordinator' },
    ],
    name: DevServerLifecycleCloseError.name,
  }));
  expect(closeOrder).toEqual([
    'mcp-apps',
    'runtime-client-surfaces',
    'runtime',
    'mcp-sessions',
    'playground',
    'coordinator',
  ]);
});

it('retains sandbox startup and foreground cleanup failures structurally', async () => {
  const project = await createProjectFixture();
  const sandboxFailure = new Error('Sandbox startup failed.');
  const cleanupFailure = new Error('Foreground cleanup failed.');
  const calls: string[] = [];
  try {
    await expect(startDevServer({
      root: project.root,
      testing: {
        createSandboxProxy: async () => {
          calls.push('sandbox-start');
          throw sandboxFailure;
        },
        startForegroundServer: async (options) => ({
          close: async () => {
            calls.push('foreground-close');
            await options.coordinator.close();
            throw cleanupFailure;
          },
          url: 'http://127.0.0.1:43123',
        }),
      },
    })).rejects.toEqual(expect.objectContaining({
      failures: [
        { error: sandboxFailure, resource: 'start' },
        { error: cleanupFailure, resource: 'cleanup' },
      ],
      name: DevServerStartError.name,
    }));
    expect(calls).toEqual(['sandbox-start', 'foreground-close']);
  } finally {
    await removeProjectFixture(project.root);
  }
});

it('passes --no-open and the requested port from the CLI to the public dev API', async () => {
  const stdout: string[] = [];
  const received: unknown[] = [];
  const exitCode = await runCli(['dev', '--root', '/project', '--no-open', '--port', '4100'], {
    stdout: { write: (value) => stdout.push(value) },
  }, {
    startDevServer: async (options) => {
      received.push(options);
      return {
        close: async () => undefined,
        openRuntimeClientSurface: async () => undefined,
        status: () => ({}) as never,
        url: 'http://127.0.0.1:4100',
      };
    },
  });

  expect(exitCode).toBe(0);
  expect(received).toEqual([expect.objectContaining({ open: false, port: 4100, root: '/project' })]);
  expect(stdout.join('')).toBe('Development workbench at http://127.0.0.1:4100\n');
});

it('closes the foreground session once when the dev CLI receives a termination signal', async () => {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const removed: NodeJS.Signals[] = [];
  let closeCalls = 0;

  await expect(runCli(['dev', '--root', '/project', '--no-open'], {}, {
    signals: {
      once: (signal, listener) => { handlers.set(signal, listener); },
      removeListener: (signal) => { removed.push(signal); },
    },
    startDevServer: async () => ({
      close: async () => { closeCalls += 1; },
      openRuntimeClientSurface: async () => undefined,
      status: () => ({}) as never,
      url: 'http://127.0.0.1:4100',
    }),
  })).resolves.toBe(0);

  handlers.get('SIGINT')?.();
  handlers.get('SIGTERM')?.();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(closeCalls).toBe(1);
  expect(removed).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
});
