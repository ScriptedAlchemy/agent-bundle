import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';
import { McpService } from '../src/services/mcp-service.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleMcpServer,
  type NormalizationTargetRegistry,
} from '../src/core/types.ts';
import type { LoadedConfig } from '../src/config/load.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const loadedProject = (root: string, config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

it('normalizes local, prebuilt, HTTP, and SSE MCP server declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'answer.ts'), 'export const answer = 42;\n');
    await writeFile(
      join(root, 'src', 'local server.ts'),
      'import { answer } from "./answer.ts";\nconsole.error(answer);\n',
    );
    const servers = Object.create(null) as Record<string, AgentBundleMcpServer>;
    Object.assign(servers, {
      'local server': {
        args: ['--author-flag', pathTokens.pluginData],
        entry: './src/local server.ts',
        env: { WORKSPACE: pathTokens.workspaceRoot },
        targets: ['claude', 'portable', 'claude'],
      },
      prebuilt: {
        args: ['serve'],
        command: 'example-server',
        cwd: './tools',
        env: { MODE: 'test' },
      },
      'remote-http': {
        headers: { Authorization: 'Bearer literal' },
        transport: 'streamable-http',
        url: 'https://mcp.example.test/http',
      },
      'remote-sse': {
        headers: { 'X-Mode': 'events' },
        transport: 'sse',
        url: 'https://mcp.example.test/sse',
      },
    });
    Object.defineProperty(servers, '__proto__', {
      enumerable: true,
      value: { command: 'prototype-safe' },
    });

    const model = await normalizeProject(
      loadedProject(root, {
        mcp: { servers },
        plugin: { name: 'mcp-fixture', version: '1.0.0' },
        targets: ['portable', 'codex', 'claude'],
      }),
      { skills: [] },
      registry,
    );

    expect(model.mcpServers).toEqual([
      {
        command: 'prototype-safe',
        id: 'mcp:__proto__',
        name: '__proto__',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'stdio',
      },
      {
        args: ['mcp/mcp-local-server-f45eb99f.mjs', '--author-flag', pathTokens.pluginData],
        command: 'node',
        cwd: pathTokens.pluginRoot,
        env: { WORKSPACE: pathTokens.workspaceRoot },
        id: 'mcp:local server',
        name: 'local server',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'local server.ts'),
        targets: ['claude', 'portable'],
        transport: 'stdio',
      },
      {
        args: ['serve'],
        command: 'example-server',
        cwd: './tools',
        env: { MODE: 'test' },
        id: 'mcp:prebuilt',
        name: 'prebuilt',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'stdio',
      },
      {
        id: 'mcp:remote-http',
        headers: { Authorization: 'Bearer literal' },
        name: 'remote-http',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'streamable-http',
        url: 'https://mcp.example.test/http',
      },
      {
        headers: { 'X-Mode': 'events' },
        id: 'mcp:remote-sse',
        name: 'remote-sse',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'sse',
        url: 'https://mcp.example.test/sse',
      },
    ]);
    expect(Object.isFrozen(model.mcpServers)).toBe(true);
    expect(Object.isFrozen(model.mcpServers[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('normalizes deeply frozen local MCP App declarations independently of the project root', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-first-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-second-'));
  const config = {
    mcp: {
      servers: {
        fixture: {
          apps: {
            dashboard: {
              _meta: { ui: { prefersBorder: true }, 'x-fixture': { stable: true } },
              entry: './views/dashboard.ts',
              resourceUri: 'ui://agent-bundle/dashboard-v1.html',
              targets: ['claude'],
              template: './views/shell.html',
            },
          },
          entry: './src/server.ts',
          targets: ['portable', 'claude'],
        },
      },
    },
    plugin: { name: 'mcp-app-fixture', version: '1.0.0' },
    targets: ['portable', 'claude'],
  } as unknown as AgentBundleConfig;
  try {
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'views'), { recursive: true });
      await writeFile(join(root, 'src', 'server.ts'), 'export {};\n');
      await writeFile(join(root, 'views', 'dashboard.ts'), 'document.body.textContent = "dashboard";\n');
      await writeFile(join(root, 'views', 'shell.html'), '<!doctype html><html><body><div id="root"></div></body></html>\n');
    }
    const [first, second] = await Promise.all([
      normalizeProject(loadedProject(firstRoot, config), { skills: [] }, registry),
      normalizeProject(loadedProject(secondRoot, config), { skills: [] }, registry),
    ]);
    const firstApp = (first as unknown as { readonly mcpApps: readonly Record<string, unknown>[] }).mcpApps[0]!;
    const secondApp = (second as unknown as { readonly mcpApps: readonly Record<string, unknown>[] }).mcpApps[0]!;
    expect(firstApp).toMatchObject({
      _meta: { ui: { prefersBorder: true }, 'x-fixture': { stable: true } },
      id: 'mcp-app:fixture:dashboard',
      name: 'dashboard',
      resourceUri: 'ui://agent-bundle/dashboard-v1.html',
      serverId: 'mcp:fixture',
      serverName: 'fixture',
      source: join(firstRoot, 'views', 'dashboard.ts'),
      targets: ['claude'],
      template: join(firstRoot, 'views', 'shell.html'),
    });
    expect(Object.isFrozen(firstApp)).toBe(true);
    expect(Object.isFrozen(firstApp._meta)).toBe(true);
    expect(Object.isFrozen((firstApp._meta as { readonly ui: unknown }).ui)).toBe(true);
    const portableIdentity = (app: Record<string, unknown>) => ({
      ...app,
      provenance: { ...(app.provenance as Record<string, unknown>), sourcePath: '<root>' },
      source: '<root>',
      template: '<root>',
    });
    expect(portableIdentity(firstApp)).toEqual(portableIdentity(secondApp));
  } finally {
    await Promise.all([
      rm(firstRoot, { force: true, recursive: true }),
      rm(secondRoot, { force: true, recursive: true }),
    ]);
  }
});

it('keeps local MCP server identities and output aliases independent of the project root', async () => {
  const left = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-left-'));
  const right = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-right-'));
  try {
    for (const root of [left, right]) {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'server.ts'), 'export {};\n');
    }
    const config: AgentBundleConfig = {
      mcp: { servers: { 'same server': { entry: './src/server.ts' } } },
      plugin: { name: 'mcp-fixture', version: '1.0.0' },
    };
    const [leftModel, rightModel] = await Promise.all([left, right].map((root) =>
      normalizeProject(loadedProject(root, config), { skills: [] }, registry)));

    expect(leftModel.mcpServers[0]).toMatchObject({
      args: ['mcp/mcp-same-server-bb8870fe.mjs'],
      id: 'mcp:same server',
      source: join(left, 'src', 'server.ts'),
    });
    expect(rightModel.mcpServers[0]).toMatchObject({
      args: ['mcp/mcp-same-server-bb8870fe.mjs'],
      id: 'mcp:same server',
      source: join(right, 'src', 'server.ts'),
    });
  } finally {
    await Promise.all([rm(left, { force: true, recursive: true }), rm(right, { force: true, recursive: true })]);
  }
});

it('reports source and model diagnostics before an MCP server can be compiled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-invalid-'));
  try {
    const config = {
      mcp: {
        servers: {
          '': { command: 'ignored' },
          ambiguous: { command: 'server', entry: './missing.ts' },
          'bad command': { command: '' },
          'bad remote': { transport: 'streamable-http', url: 'not a URL' },
          'missing entry': { entry: './missing.ts' },
          'remote options': {
            args: ['not-supported'],
            transport: 'sse',
            url: 'https://mcp.example.test/events',
          },
          'unknown target': { command: 'server', targets: ['unknown'] },
        },
      },
      plugin: { name: 'mcp-fixture', version: '1.0.0' },
    } satisfies AgentBundleConfig;
    const loaded = loadedProject(root, config);

    expect(validateSource(loaded, { skills: [] }, registry).map(({ code }) => code)).toEqual([
      'AB4302',
      'AB4304',
      'AB4313',
      'AB4316',
      'AB4307',
      'AB4318',
    ]);

    const normalized = await normalizeProject(
      loadedProject(root, {
        mcp: { servers: { unsafe: { command: 'server', targets: ['unknown'] } } },
        plugin: config.plugin,
      }),
      { skills: [] },
      registry,
    );
    expect(validateModel(normalized, registry)).toMatchObject([
      { code: 'AB4320', target: 'unknown' },
    ]);
    const unsafe = {
      ...normalized,
      mcpServers: [{
        ...normalized.mcpServers[0]!,
        args: ['../escaped.mjs'],
        source: join(root, 'src', 'server.ts'),
      }],
    };
    expect(validateModel(unsafe, registry)).toMatchObject([
      { code: 'AB4320', target: 'unknown' },
      { code: 'AB4321' },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects unsafe, duplicate, and nonlocal MCP App declarations before browser compilation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-invalid-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export {};\n');
    await writeFile(join(root, 'src', 'other.ts'), 'export {};\n');
    await writeFile(join(root, 'views', 'dashboard.ts'), 'document.body.textContent = "dashboard";\n');

    const malformed = {
      mcp: {
        servers: {
          fixture: {
            apps: {
              dashboard: {
                entry: './views/dashboard.ts',
                resourceUri: 'ui://agent-bundle/dashboard-v1.html',
                targets: ['portable'],
              },
              'not_stable': {
                _meta: [],
                entry: './views/missing.ts',
                resourceUri: 'https://example.test/not-ui',
                template: './views/missing.txt',
              },
              malformed: [],
            },
            entry: './src/server.ts',
            targets: ['claude'],
          },
          other: {
            apps: {
              dashboard: {
                entry: './views/dashboard.ts',
                resourceUri: 'ui://agent-bundle/dashboard-v1.html',
              },
            },
            entry: './src/other.ts',
          },
          prebuilt: {
            apps: {},
            command: 'fixture-server',
          },
        },
      },
      plugin: { name: 'mcp-app-invalid', version: '1.0.0' },
    } as unknown as AgentBundleConfig;

    expect(validateSource(loadedProject(root, malformed), { skills: [] }, registry).map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'AB4322',
        'AB4324',
        'AB4325',
        'AB4326',
        'AB4328',
        'AB4329',
        'AB4330',
        'AB4332',
        'AB4334',
        'AB4335',
      ]),
    );

    const normalized = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            fixture: {
              apps: {
                dashboard: {
                  entry: './views/dashboard.ts',
                  resourceUri: 'ui://agent-bundle/dashboard-v1.html',
                },
              },
              entry: './src/server.ts',
              targets: ['unknown'],
            },
          },
        },
        plugin: { name: 'mcp-app-invalid', version: '1.0.0' },
      }),
      { skills: [] },
      registry,
    );
    expect(validateModel(normalized, registry)).toMatchObject([
      { code: 'AB4320', target: 'unknown' },
      { code: 'AB4336', target: 'unknown' },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects non-JSON MCP App metadata before normalization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-meta-'));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export {};\n');
    await writeFile(join(root, 'views', 'dashboard.ts'), 'document.body.textContent = "dashboard";\n');

    for (const [name, value] of [
      ['function', () => undefined],
      ['bigint', 1n],
      ['nonfinite', Number.POSITIVE_INFINITY],
      ['cycle', cyclic],
    ] as const) {
      const config = {
        mcp: {
          servers: {
            fixture: {
              apps: {
                dashboard: {
                  _meta: { value },
                  entry: './views/dashboard.ts',
                  resourceUri: `ui://agent-bundle/${name}-v1.html`,
                },
              },
              entry: './src/server.ts',
            },
          },
        },
        plugin: { name: 'mcp-app-meta', version: '1.0.0' },
      } as unknown as AgentBundleConfig;

      expect(validateSource(loadedProject(root, config), { skills: [] }, registry).map(({ code }) => code)).toEqual([
        'AB4338',
      ]);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('bundles each local MCP entry once and maps every target manifest to that artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-build-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'message.ts'), 'export const message = "bundled";\n');
    await writeFile(
      join(root, 'src', 'local server.ts'),
      [
        'import { message } from "./message.ts";',
        'process.stderr.write(`${message}\\n`);',
        '',
      ].join('\n'),
    );
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            'local server': {
              args: ['--fixture'],
              entry: './src/local server.ts',
              env: { FIXTURE: 'local' },
            },
          },
        },
        plugin: { name: 'mcp-fixture', version: '1.0.0' },
        targets: ['portable', 'codex', 'claude'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'artifact with spaces');
    const outputName = 'mcp-local-server-f45eb99f.mjs';
    const result = await build({
      model,
      outputRoot,
      projectRoot: root,
      registry: createDefaultRegistry(),
    });
    expect(result.compiledMcpEntries).toEqual([
      {
        id: 'mcp:local server',
        name: 'mcp-local-server-f45eb99f',
        output: join(outputRoot, 'portable', 'mcp', outputName),
        source: join(root, 'src', 'local server.ts'),
        target: 'portable',
      },
      {
        id: 'mcp:local server',
        name: 'mcp-local-server-f45eb99f',
        output: join(outputRoot, 'codex', 'mcp', outputName),
        source: join(root, 'src', 'local server.ts'),
        target: 'codex',
      },
      {
        id: 'mcp:local server',
        name: 'mcp-local-server-f45eb99f',
        output: join(outputRoot, 'claude', 'mcp', outputName),
        source: join(root, 'src', 'local server.ts'),
        target: 'claude',
      },
    ]);

    const bundles = await Promise.all(['portable', 'codex', 'claude'].map(async (target) => {
      const mcpRoot = join(outputRoot, target, 'mcp');
      expect(await readdir(mcpRoot)).toEqual([outputName]);
      const bundle = await readFile(join(mcpRoot, outputName), 'utf8');
      expect(bundle).toContain('bundled');
      expect(bundle).not.toContain('./message.ts');
      expect(bundle).not.toContain('agent-bundle');
      return bundle;
    }));
    expect(new Set(bundles).size).toBe(1);

    const [portable, codex, claude] = await Promise.all([
      readFile(join(outputRoot, 'portable', 'mcp.json'), 'utf8'),
      readFile(join(outputRoot, 'codex', '.mcp.json'), 'utf8'),
      readFile(join(outputRoot, 'claude', '.mcp.json'), 'utf8'),
    ]);
    expect(JSON.parse(portable)).toMatchObject({
      mcpServers: {
        'local server': {
          args: [`mcp/${outputName}`, '--fixture'],
          command: 'node',
          cwd: '${PLUGIN_ROOT}',
          env: { FIXTURE: 'local' },
          type: 'stdio',
        },
      },
    });
    expect(JSON.parse(codex)).toMatchObject({
      mcpServers: {
        'local server': {
          args: [`./mcp/${outputName}`, '--fixture'],
          command: 'node',
          cwd: './',
          env: { FIXTURE: 'local' },
          type: 'stdio',
        },
      },
    });
    expect(JSON.parse(claude)).toMatchObject({
      mcpServers: {
        'local server': {
          args: [`mcp/${outputName}`, '--fixture'],
          command: 'node',
          cwd: '${CLAUDE_PLUGIN_ROOT}',
          env: { FIXTURE: 'local' },
          type: 'stdio',
        },
      },
    });

    const secondOutput = join(root, 'artifact copy');
    await build({
      model,
      outputRoot: secondOutput,
      projectRoot: root,
      registry: createDefaultRegistry(),
    });
    expect(await readFile(join(secondOutput, 'portable', 'mcp', outputName), 'utf8')).toBe(
      bundles[0],
    );

    const collisionRegistry = new TargetRegistry().register({
      capabilities: { mcp: true },
      name: 'portable',
      plan: () => ({
        diagnostics: [],
        entries: [{
          content: 'colliding entry\n',
          kind: 'write' as const,
          relativePath: `mcp/${outputName}`,
        }],
      }),
      validateModel: () => [],
    }, { default: true });
    await expect(build({
      model: { ...model, targets: model.targets.filter(({ name }) => name === 'portable') },
      outputRoot: join(root, 'collision'),
      projectRoot: root,
      registry: collisionRegistry,
    })).rejects.toThrow('Duplicate planned artifact destination');

    await rm(join(secondOutput, 'portable', 'mcp', outputName));
    expect(await validateArtifact({ artifactRoot: secondOutput })).toMatchObject([
      { code: 'AB6004' },
      { code: 'AB6007', generatedPath: 'portable/mcp.json' },
    ]);

    const previousBundle = bundles[0]!;
    await writeFile(join(root, 'src', 'local server.ts'), 'export const = ;\n');
    await expect(build({
      model,
      outputRoot,
      projectRoot: root,
      registry: createDefaultRegistry(),
    })).rejects.toThrow();
    expect(await readFile(join(outputRoot, 'portable', 'mcp', outputName), 'utf8')).toBe(
      previousBundle,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('builds one deterministic self-contained MCP App view and injects it through the virtual module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-build-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), [
      "import apps from 'agent-bundle/mcp-apps';",
      'export const bundledApps = apps;',
      '',
    ].join('\n'));
    await writeFile(join(root, 'views', 'dashboard.ts'), [
      "import './dashboard.css';",
      "document.querySelector('#view')!.textContent = 'dashboard-ready';",
      '',
    ].join('\n'));
    await writeFile(join(root, 'views', 'dashboard.css'), '#view { color: rebeccapurple; }\n');
    await writeFile(join(root, 'views', 'shell.html'), '<!doctype html><html><body><main id="view"></main></body></html>\n');
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            fixture: {
              apps: {
                dashboard: {
                  _meta: { ui: { prefersBorder: true } },
                  entry: './views/dashboard.ts',
                  resourceUri: 'ui://agent-bundle/dashboard-v1.html',
                  template: './views/shell.html',
                },
              },
              entry: './src/server.ts',
            },
          },
        },
        plugin: { name: 'mcp-app-build', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'dist');
    const result = await build({
      model,
      outputRoot,
      projectRoot: root,
      registry: createDefaultRegistry(),
    });
    const compiled = (result as unknown as {
      readonly compiledMcpApps: readonly {
        readonly id: string;
        readonly name: string;
        readonly output: string;
        readonly resourceUri: string;
        readonly target: string;
      }[];
    }).compiledMcpApps;
    expect(compiled).toMatchObject([
      {
        _meta: { ui: { prefersBorder: true } },
        id: 'mcp-app:fixture:dashboard',
        mimeType: 'text/html;profile=mcp-app',
        name: 'dashboard',
        output: join(outputRoot, 'portable', 'mcp-apps', 'dashboard.html'),
        resourceUri: 'ui://agent-bundle/dashboard-v1.html',
        serverId: 'mcp:fixture',
        source: join(root, 'views', 'dashboard.ts'),
        target: 'portable',
      },
    ]);
    const html = await readFile(join(outputRoot, 'portable', 'mcp-apps', 'dashboard.html'), 'utf8');
    expect(html).toContain('dashboard-ready');
    expect(html).toContain('<script');
    expect(html).toContain('<style');
    expect(html).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=/iu);
    expect(await readdir(join(outputRoot, 'portable', 'mcp-apps'))).toEqual(['dashboard.html']);
    const serverBundle = await readFile(join(outputRoot, 'portable', 'mcp', 'mcp-fixture-f16d05ec.mjs'), 'utf8');
    expect(serverBundle).toContain('ui://agent-bundle/dashboard-v1.html');
    expect(serverBundle).toContain('text/html;profile=mcp-app');
    expect(serverBundle).toContain('prefersBorder');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('rejects the MCP Apps virtual module outside Agent Bundle compilation', async () => {
  await expect(import('../src/mcp-apps.ts')).rejects.toThrow(
    'agent-bundle/mcp-apps is available only while Agent Bundle compiles a local MCP server.',
  );
});

it('uses the selected remote manifest with propagated cancellation and cleans data before rejecting tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-remote-'));
  try {
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            events: {
              headers: { 'X-Mode': 'events' },
              transport: 'sse',
              url: 'https://mcp.example.test/events',
            },
            http: {
              headers: { 'X-Data': pathTokens.pluginData },
              transport: 'streamable-http',
              url: 'https://mcp.example.test/tools',
            },
          },
        },
        plugin: { name: 'mcp-remote-fixture', version: '1.0.0' },
        targets: ['claude'],
      }),
      { skills: [] },
      registry,
    );
    const artifact = join(root, 'dist');
    await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

    const connected: Array<{ readonly options: { readonly signal?: AbortSignal; readonly timeout: number }; readonly transport: unknown }> = [];
    const requested: Array<{ readonly signal?: AbortSignal; readonly timeout: number }> = [];
    const http: Array<{ readonly headers?: Record<string, string>; readonly url: string }> = [];
    const sse: Array<{ readonly headers?: Record<string, string>; readonly url: string }> = [];
    let closes = 0;
    const service = new McpService({
      createClient: () => ({
        callTool: async () => ({ content: [] }) as never,
        close: async () => {
          closes += 1;
        },
        connect: async (transport, options) => {
          connected.push({ options: options!, transport });
        },
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listTools: async (_params, options) => {
          requested.push(options!);
          return { tools: [] };
        },
      }),
      createSseTransport: (url, options) => {
        sse.push({ ...options, url: url.href });
        return {} as never;
      },
      createStreamableHttpTransport: (url, options) => {
        http.push({ ...options, url: url.href });
        return {} as never;
      },
    });
    const controller = new AbortController();
    await service.list({
      artifact,
      server: 'http',
      signal: controller.signal,
      target: 'claude',
      timeoutMs: 321,
      workspaceRoot: join(root, 'workspace'),
    });
    await service.list({ artifact, server: 'events', target: 'claude' });

    expect(http).toEqual([{ headers: { 'X-Data': expect.any(String) }, url: 'https://mcp.example.test/tools' }]);
    expect(sse).toEqual([{ headers: { 'X-Mode': 'events' }, url: 'https://mcp.example.test/events' }]);
    expect(connected[0]?.options).toEqual({ signal: controller.signal, timeout: 321 });
    expect(requested[0]).toEqual({ signal: controller.signal, timeout: 321 });
    expect(closes).toBe(2);
    await expect(access(http[0]!.headers!['X-Data']!)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(join(artifact, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"tampered"}\n');
    await expect(service.list({ artifact, server: 'http', target: 'claude' })).rejects.toThrow();
    expect(closes).toBe(2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('creates session state only after setup succeeds and always inherits the stdio environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-stdio-options-'));
  const inheritedKey = 'AGENT_BUNDLE_TEST_MCP_INHERITED';
  const previousInherited = process.env[inheritedKey];
  const sessionDirectories = async (): Promise<readonly string[]> =>
    (await readdir(tmpdir())).filter((name) => name.startsWith('agent-bundle-mcp-')).sort();
  try {
    process.env[inheritedKey] = 'inherited-sentinel';
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export {};\n');
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            configured: {
              entry: './src/server.ts',
              env: { AGENT_BUNDLE_TEST_MCP_OVERRIDE: 'configured' },
            },
            inherited: { entry: './src/server.ts' },
          },
        },
        plugin: { name: 'mcp-stdio-options', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    const artifact = join(root, 'dist');
    await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

    const beforeInvalidTimeout = await sessionDirectories();
    await expect(new McpService().list({
      artifact,
      server: 'configured',
      target: 'portable',
      timeoutMs: 0,
    })).rejects.toThrow('timeoutMs must be a positive finite number');
    expect(await sessionDirectories()).toEqual(beforeInvalidTimeout);

    const beforeFactoryFailure = await sessionDirectories();
    await expect(new McpService({
      createClient: () => {
        throw new Error('fixture client factory failure');
      },
    }).list({ artifact, server: 'configured', target: 'portable' })).rejects.toThrow(
      'fixture client factory failure',
    );
    expect(await sessionDirectories()).toEqual(beforeFactoryFailure);

    const stdio: Array<{ readonly env?: Record<string, string> }> = [];
    const service = new McpService({
      createClient: () => ({
        callTool: async () => ({ content: [] }) as never,
        close: async () => undefined,
        connect: async () => undefined,
        getServerCapabilities: () => undefined,
        getServerVersion: () => undefined,
        listTools: async () => ({ tools: [] }),
      }),
      createStdioTransport: (options) => {
        stdio.push(options);
        return { close: async () => undefined, stderr: null } as never;
      },
    });
    await service.list({ artifact, server: 'configured', target: 'portable' });
    await service.list({ artifact, server: 'inherited', target: 'portable' });

    expect(stdio).toHaveLength(2);
    expect(stdio[0]?.env).toMatchObject({
      [inheritedKey]: 'inherited-sentinel',
      AGENT_BUNDLE_TEST_MCP_OVERRIDE: 'configured',
    });
    expect(stdio[1]?.env).toMatchObject({ [inheritedKey]: 'inherited-sentinel' });
  } finally {
    if (previousInherited === undefined) {
      delete process.env[inheritedKey];
    } else {
      process.env[inheritedKey] = previousInherited;
    }
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('serves compiler-bundled MCP App resources from a copied artifact without project source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-resource-'));
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-consumer-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(
      join(process.cwd(), 'node_modules', '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(root, 'views', 'dashboard.ts'), "document.body.dataset.fixture = 'app-resource';\n");
    await writeFile(join(root, 'views', 'shell.html'), '<!doctype html><html><body><main id="view"></main></body></html>\n');
    await writeFile(
      join(root, 'src', 'server.ts'),
      [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
        "import apps from 'agent-bundle/mcp-apps';",
        '',
        "const server = new McpServer({ name: 'app-resource-fixture', version: '1.0.0' });",
        'for (const app of apps) {',
        '  server.registerResource(app.name, app.resourceUri, {',
        '    mimeType: app.mimeType,',
        '    _meta: app._meta,',
        '  }, async (uri) => ({',
        '    contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],',
        '  }));',
        '}',
        'const [app] = apps;',
        "if (app === undefined) throw new Error('Expected bundled MCP App.');",
        "server.registerTool('show-dashboard', {",
        "  description: 'Open the bundled dashboard.',",
        '  _meta: { ui: { resourceUri: app.resourceUri } },',
        '}, async () => ({',
        '  _meta: { ui: { resourceUri: app.resourceUri } },',
        "  content: [{ type: 'text', text: 'dashboard ready' }],",
        '  structuredContent: { resourceUri: app.resourceUri, view: app.name },',
        '}));',
        'await server.connect(new StdioServerTransport());',
        '',
      ].join('\n'),
    );
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            fixture: {
              apps: {
                dashboard: {
                  _meta: { ui: { prefersBorder: true }, 'x-fixture': { app: 'dashboard' } },
                  entry: './views/dashboard.ts',
                  resourceUri: 'ui://agent-bundle/dashboard-v1.html',
                  template: './views/shell.html',
                },
              },
              entry: './src/server.ts',
            },
          },
        },
        plugin: { name: 'mcp-app-resource', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'dist');
    const artifact = join(consumer, 'installed-plugin');
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    const expectedHtml = await readFile(join(outputRoot, 'portable', 'mcp-apps', 'dashboard.html'), 'utf8');
    await cp(outputRoot, artifact, { recursive: true });
    await rm(join(root, 'src'), { force: true, recursive: true });
    await rm(join(root, 'views'), { force: true, recursive: true });
    expect(await validateArtifact({ artifactRoot: artifact })).toEqual([]);

    const client = new Client({ name: 'app-resource-consumer', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      args: [join(artifact, 'portable', 'mcp', 'mcp-fixture-f16d05ec.mjs')],
      command: process.execPath,
      stderr: 'pipe',
    }));
    try {
      const tools = await client.listTools();
      expect(tools.tools).toMatchObject([
        {
          _meta: { ui: { resourceUri: 'ui://agent-bundle/dashboard-v1.html' } },
          name: 'show-dashboard',
        },
      ]);
      const resources = await client.listResources();
      expect(resources.resources).toMatchObject([
        {
          _meta: { ui: { prefersBorder: true }, 'x-fixture': { app: 'dashboard' } },
          mimeType: 'text/html;profile=mcp-app',
          name: 'dashboard',
          uri: 'ui://agent-bundle/dashboard-v1.html',
        },
      ]);
      const resource = await client.readResource({ uri: 'ui://agent-bundle/dashboard-v1.html' });
      expect(resource.contents).toEqual([
        {
          mimeType: 'text/html;profile=mcp-app',
          text: expectedHtml,
          uri: 'ui://agent-bundle/dashboard-v1.html',
        },
      ]);
      const result = await client.callTool({ arguments: {}, name: 'show-dashboard' });
      expect(result).toMatchObject({
        _meta: { ui: { resourceUri: 'ui://agent-bundle/dashboard-v1.html' } },
        content: [{ text: 'dashboard ready', type: 'text' }],
        structuredContent: { resourceUri: 'ui://agent-bundle/dashboard-v1.html', view: 'dashboard' },
      });
    } finally {
      await client.close();
    }
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(consumer, { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('lists tools from a validated copied artifact without reading project source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-service-source-'));
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-service-consumer-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(
      join(process.cwd(), 'node_modules', '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(root, 'src', 'server.ts'),
      [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
        '',
        "const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });",
        "server.registerTool('inspect', { description: 'Inspect the launched artifact.' }, async () => {",
        "  process.stderr.write('fixture stderr\\n');",
        '  return {',
        "    content: [{ type: 'text' as const, text: JSON.stringify({",
        '      args: process.argv.slice(2),',
        '      data: process.env.FIXTURE_DATA,',
        '      root: process.env.FIXTURE_ROOT,',
        '    }) }],',
        '  };',
        '});',
        "server.registerTool('tool-error', { description: 'Return a tool-level error.' }, async () => ({",
        "  content: [{ type: 'text' as const, text: 'expected failure' }],",
        '  isError: true,',
        '}));',
        "server.registerTool('noisy', { description: 'Exceed the stderr limit.' }, async () => {",
        "  process.stderr.write('x'.repeat(1_000_001));",
        "  return { content: [{ type: 'text' as const, text: 'too noisy' }] };",
        '});',
        "server.registerTool('hang', { description: 'Wait for cancellation.' }, async () => new Promise(() => {}));",
        "server.registerTool('rich', {",
        "  _meta: { 'openai/outputTemplate': 'ui://fixture/tool.html', ui: { resourceUri: 'ui://fixture/tool.html' } },",
        "  description: 'Return an Apps-compatible result.',",
        "}, async () => ({",
        '  _meta: { ui: { resourceUri: \'ui://fixture/result.html\' } },',
        '  content: [',
        "    { type: 'resource_link' as const, name: 'fixture', uri: 'ui://fixture/tool.html' },",
        "    { type: 'resource' as const, resource: { mimeType: 'text/plain', text: 'embedded fixture', uri: 'ui://fixture/embedded.txt' } },",
        '  ],',
        "  structuredContent: { view: 'fixture', value: 42 },",
        '}));',
        'await server.connect(new StdioServerTransport());',
        '',
      ].join('\n'),
    );
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            fixture: {
              args: ['--fixture-argument'],
              entry: './src/server.ts',
              env: {
                FIXTURE_DATA: pathTokens.pluginData,
                FIXTURE_ROOT: pathTokens.pluginRoot,
              },
            },
          },
        },
        plugin: { name: 'mcp-service-fixture', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'dist');
    const artifact = join(consumer, 'installed-plugin');
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await cp(outputRoot, artifact, { recursive: true });
    await rm(join(root, 'src'), { force: true, recursive: true });

    const api = await import('../src/api.ts') as {
      readonly McpService?: new () => {
        invoke(options: {
          readonly artifact: string;
          readonly input: Record<string, unknown>;
          readonly server: string;
          readonly signal?: AbortSignal;
          readonly target: string;
          readonly timeoutMs?: number;
          readonly tool: string;
        }): Promise<unknown>;
        list(options: { readonly artifact: string; readonly server: string; readonly target: string }): Promise<unknown>;
      };
    };
    expect(api.McpService).toBeTypeOf('function');
    const result = await new api.McpService!().list({ artifact, server: 'fixture', target: 'portable' });
    expect(result).toMatchObject({
      server: { name: 'fixture-server', version: '1.0.0' },
      stderr: '',
      tools: [
        { name: 'inspect' },
        { name: 'tool-error' },
        { name: 'noisy' },
        { name: 'hang' },
        {
          _meta: {
            'openai/outputTemplate': 'ui://fixture/tool.html',
            ui: { resourceUri: 'ui://fixture/tool.html' },
          },
          name: 'rich',
        },
      ],
    });
    const invoked = await new api.McpService!().invoke({
      artifact,
      input: {},
      server: 'fixture',
      target: 'portable',
      tool: 'inspect',
    });
    expect(invoked).toMatchObject({
      result: { content: [{ text: expect.any(String), type: 'text' }] },
      stderr: 'fixture stderr\n',
    });
    const inspected = invoked as {
      readonly result: { readonly content: readonly [{ readonly text: string }] };
    };
    const firstSession = JSON.parse(inspected.result.content[0].text) as {
      readonly data: string;
      readonly root: string;
    };
    expect(firstSession.root).toBe(join(artifact, 'portable'));
    await expect(access(firstSession.data)).rejects.toMatchObject({ code: 'ENOENT' });

    const nextInvocation = await new api.McpService!().invoke({
      artifact,
      input: {},
      server: 'fixture',
      target: 'portable',
      tool: 'inspect',
    }) as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const secondSession = JSON.parse(nextInvocation.result.content[0].text) as { readonly data: string };
    expect(secondSession.data).not.toBe(firstSession.data);
    await expect(access(secondSession.data)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(new api.McpService!().invoke({
      artifact,
      input: {},
      server: 'fixture',
      target: 'portable',
      tool: 'tool-error',
    })).resolves.toMatchObject({ result: { isError: true } });
    await expect(new api.McpService!().invoke({
      artifact,
      input: {},
      server: 'fixture',
      target: 'portable',
      tool: 'rich',
    })).resolves.toMatchObject({
      result: {
        _meta: { ui: { resourceUri: 'ui://fixture/result.html' } },
        content: [
          { name: 'fixture', type: 'resource_link', uri: 'ui://fixture/tool.html' },
          {
            resource: {
              mimeType: 'text/plain',
              text: 'embedded fixture',
              uri: 'ui://fixture/embedded.txt',
            },
            type: 'resource',
          },
        ],
        structuredContent: { value: 42, view: 'fixture' },
      },
    });
    await expect(new api.McpService!().invoke({
      artifact,
      input: {},
      server: 'fixture',
      target: 'portable',
      tool: 'noisy',
    })).rejects.toThrow('stderr exceeds the 1 MB limit');

    const controller = new AbortController();
    const pending = new api.McpService!().invoke({
      artifact,
      input: {},
      server: 'fixture',
      signal: controller.signal,
      target: 'portable',
      timeoutMs: 1_000,
      tool: 'hang',
    });
    setTimeout(() => controller.abort(new Error('test cancellation')), 25);
    await expect(pending).rejects.toBeDefined();
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(consumer, { force: true, recursive: true }),
    ]);
  }
}, 30_000);
