import { supportedCapabilities } from './support/adapter-capabilities.ts';
import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { expect, it } from '@rstest/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { codexArtifactPaths } from '../src/adapters/codex.ts';
import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import {
  artifactManifestName,
  assembleArtifactManifest,
  parseArtifactManifest,
} from '../src/build/manifest.ts';
import { build } from './support/build.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { emptyCompiledRouteGraph } from '../src/routes/graph.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';
import { McpService } from '../src/services/mcp-service.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleMcpServer,
  type NormalizationTargetRegistry,
} from '../src/core/types.ts';

import { agentBundleNodeModules, agentBundlePackageRoot, workbenchNodeModules } from './helpers/workspace-paths.ts';
import { loadedProject } from './support/loaded-project.ts';
import { runNodeScript } from './support/run-node-script.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const testAdapterMetadata = Object.freeze({
  adapterRevision: 'test',
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

it('rejects legacy MCP SSE source declarations with one AB4317 diagnostic', () => {
  const config = {
    mcp: {
      servers: {
        events: {
          transport: 'sse',
          url: 'https://mcp.example.test/events',
        },
      },
    },
    plugin: { name: 'legacy-sse', version: '1.0.0' },
  } as unknown as AgentBundleConfig;
  const diagnostics = validateSource(loadedProject('/workspace', config), { skills: [] }, registry);

  expect(diagnostics).toEqual([expect.objectContaining({
    code: 'AB4317',
    message: 'MCP server "events" URL requires streamable-http transport.',
  })]);
});

it('normalizes local, prebuilt, and HTTP MCP server declarations', async () => {
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
              resourceUri: 'ui://agent-bundle/dashboard.html',
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
      resourceUri: 'ui://agent-bundle/dashboard.html',
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
    } as unknown as AgentBundleConfig;
    const loaded = loadedProject(root, config);

    expect(validateSource(loaded, { skills: [] }, registry).map(({ code }) => code)).toEqual([
      'AB4302',
      'AB4304',
      'AB4313',
      'AB4316',
      'AB4307',
      'AB4317',
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

it('rejects a hostile normalized legacy SSE transport before adapters can plan it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-hostile-model-'));
  try {
    const normalized = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            events: {
              targets: ['portable'],
              transport: 'streamable-http',
              url: 'https://mcp.example.test/events',
            },
          },
        },
        plugin: { name: 'hostile-model', version: '1.0.0' },
      }),
      { skills: [] },
      registry,
    );
    const hostile = {
      ...normalized,
      mcpServers: [{ ...normalized.mcpServers[0]!, transport: 'sse' as unknown as 'streamable-http' }],
    };

    expect(validateModel(hostile, registry)).toEqual([{
      code: 'AB4339',
      message: 'MCP server "events" uses unsupported transport "sse".',
      severity: 'error',
      sourcePath: join(root, 'agent-bundle.config.ts'),
    }]);
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
    await writeFile(join(root, 'views', 'other-dashboard.ts'), 'document.body.textContent = "other";\n');

    const malformed = {
      mcp: {
        servers: {
          fixture: {
            apps: {
              dashboard: {
                entry: './views/dashboard.ts',
                resourceUri: 'ui://agent-bundle/dashboard.html',
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
              // AB4330: the resource URI already belongs to app "dashboard".
              copycat: {
                entry: './views/dashboard.ts',
                resourceUri: 'ui://agent-bundle/dashboard.html',
              },
              // AB4325: same app name as on "fixture" with a conflicting definition.
              dashboard: {
                entry: './views/other-dashboard.ts',
                resourceUri: 'ui://agent-bundle/dashboard.html',
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
                  resourceUri: 'ui://agent-bundle/dashboard.html',
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
                  resourceUri: `ui://agent-bundle/${name}.html`,
                },
              },
              entry: './src/server.ts',
            },
          },
        },
        plugin: { name: 'mcp-app-meta', version: '1.0.0' },
      } as unknown as AgentBundleConfig;

      const diagnostics = validateSource(loadedProject(root, config), { skills: [] }, registry);
      expect(diagnostics.filter(({ severity }) => severity === 'error').map(({ code }) => code)).toEqual([
        'AB4338',
      ]);
      // The self-connecting fixture entry additionally draws the AB4730
      // migration nudge, which must stay informational.
      expect(diagnostics.filter(({ severity }) => severity !== 'error')).toEqual([
        expect.objectContaining({ code: 'AB4730', severity: 'info' }),
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
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
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
      registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph,
    });
    expect(await validateArtifact({ artifactRoot: outputRoot })).toEqual([]);
    // One composite root compiles the entry once; the compiled surface is
    // attributed to the selection as a whole (#555).
    expect(result.compiledMcpEntries).toEqual([
      {
        id: 'mcp:local server',
        name: 'mcp-local-server-f45eb99f',
        output: join(outputRoot, 'mcp', outputName),
        outputKind: 'bundle',
        source: join(root, 'src', 'local server.ts'),
        sourceInputs: [
          join(root, 'agent-bundle.config.ts'),
          join(root, 'src', 'local server.ts'),
          join(root, 'src', 'message.ts'),
        ],
        target: 'claude+codex+portable',
      },
    ]);

    const mcpRoot = join(outputRoot, 'mcp');
    expect(await readdir(mcpRoot)).toEqual([outputName]);
    const bundle = await readFile(join(mcpRoot, outputName), 'utf8');
    expect(bundle).toContain('bundled');
    expect(bundle).not.toContain('./message.ts');
    expect(bundle).not.toContain('agent-bundle');

    // Every selected host's document points at that one bundle in its own
    // dialect: the portable and Claude documents sit at their conventional
    // plugin-root paths, Codex's beside its manifest.
    const [portable, codex, claude] = await Promise.all([
      readFile(join(outputRoot, 'mcp.json'), 'utf8'),
      readFile(join(outputRoot, codexArtifactPaths.mcp), 'utf8'),
      readFile(join(outputRoot, '.mcp.json'), 'utf8'),
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
          args: [`\${CLAUDE_PLUGIN_ROOT}/mcp/${outputName}`, '--fixture'],
          command: 'node',
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
      registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph,
    });
    expect(await readFile(join(secondOutput, 'mcp', outputName), 'utf8')).toBe(bundle);

    const collisionRegistry = new TargetRegistry().register({
      capabilities: supportedCapabilities('mcp'),
      mcpRuntime: createDefaultRegistry().mcpRuntime('portable'),
      metadata: testAdapterMetadata,
      name: 'portable',
      plan: () => ({
        diagnostics: [],
        entries: [{
          content: 'colliding entry\n',
          kind: 'write' as const,
          relativePath: `mcp/${outputName}`,
          sourceInputs: [],
        }],
      }),
    }, { default: true });
    await expect(build({
      model: { ...model, targets: model.targets.filter(({ name }) => name === 'portable') },
      outputRoot: join(root, 'collision'),
      projectRoot: root,
      registry: collisionRegistry,
      routeGraph: emptyCompiledRouteGraph,
    })).rejects.toThrow('Duplicate planned artifact destination');

    await rm(join(secondOutput, 'mcp', outputName));
    expect(await validateArtifact({ artifactRoot: secondOutput })).toMatchObject([
      { code: 'AB6004' },
      { code: 'AB6014', generatedPath: 'mcp' },
      { code: 'AB6007', generatedPath: '.mcp.json' },
      { code: 'AB6007', generatedPath: codexArtifactPaths.mcp },
      { code: 'AB6007', generatedPath: 'mcp.json' },
    ]);

    const previousBundle = bundle;
    await writeFile(join(root, 'src', 'local server.ts'), 'export const = ;\n');
    await expect(build({
      model,
      outputRoot,
      projectRoot: root,
      registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph,
    })).rejects.toThrow();
    expect(await readFile(join(outputRoot, 'mcp', outputName), 'utf8')).toBe(previousBundle);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('inlines agent-bundle/launch-env into a self-connecting entry so it can apply the operator .env layer itself (#469)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-self-connecting-env-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    // No default export: the entry gets no lifecycle shell, so it applies the
    // layer first thing, anchored exactly as a shell would (the documented recipe).
    await writeFile(join(root, 'src', 'probe.ts'), [
      "import { fileURLToPath } from 'node:url';",
      "import { applyOperatorEnv, operatorEnvPluginRoot } from 'agent-bundle/launch-env';",
      '',
      "const layer = applyOperatorEnv({ pluginRoot: operatorEnvPluginRoot(fileURLToPath(new URL('..', import.meta.url))) });",
      "process.stdout.write(`${JSON.stringify({ applied: layer.applied, file: process.env.PROBE_FILE ?? null, host: process.env.PROBE_HOST ?? null })}\\n`);",
      '',
    ].join('\n'));
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: { servers: { probe: { entry: './src/probe.ts' } } },
        plugin: { name: 'mcp-self-connecting-env', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'artifact');
    const result = await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });
    expect(await validateArtifact({ artifactRoot: outputRoot })).toEqual([]);
    const [entry] = result.compiledMcpEntries;
    // The inlined loader is framework runtime, never authored-source evidence.
    expect(entry).toMatchObject({
      id: 'mcp:probe',
      sourceInputs: [join(root, 'agent-bundle.config.ts'), join(root, 'src', 'probe.ts')],
      target: 'portable',
    });

    const bundle = await readFile(entry!.output, 'utf8');
    // Self-contained (the alias resolved to the framework's own module) and
    // still shell-free: the entry's own top-level code is what runs first.
    expect(bundle).not.toMatch(/from\s*["']agent-bundle\//u);
    expect(bundle).not.toContain('runGeneratedStdioMcpEntry');
    expect(bundle).toContain('AGENT_BUNDLE_ENV_FILE');

    // `<plugin root>/.env` is one directory above `mcp/`; it fills the gap and
    // an exported variable still wins.
    const pluginRoot = outputRoot;
    const probe = async (env: Readonly<Record<string, string>>): Promise<unknown> => {
      const run = await runNodeScript({ args: [entry!.output], env });
      expect(run).toMatchObject({ code: 0, stderr: '' });
      return JSON.parse(run.stdout);
    };
    expect(await probe({ PROBE_HOST: 'from-host' })).toEqual({ applied: [], file: null, host: 'from-host' });
    await writeFile(join(pluginRoot, '.env'), 'PROBE_FILE=from-file\nPROBE_HOST=from-file\n');
    expect(await probe({ PROBE_HOST: 'from-host' })).toEqual({ applied: ['PROBE_FILE'], file: 'from-file', host: 'from-host' });
    expect(await probe({ AGENT_BUNDLE_ENV_FILE: 'none', PROBE_HOST: 'from-host' })).toEqual({ applied: [], file: null, host: 'from-host' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('lets the operator .env beat a manifest env default the host passed through, never a host export, before the server module evaluates (#469)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-manifest-env-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    // A factory entry that reports the composed environment twice: once at
    // module top level (what a static import evaluates first) and once when
    // the factory runs, then exits before the lifecycle opens the transport.
    const names = ['MANIFEST_ONLY', 'MANIFEST_KEPT', 'HOST_EXPORTED', 'HOST_ONLY', 'ABSENT_EVERYWHERE'] as const;
    await writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      `const names = ${JSON.stringify(names)};`,
      "const snapshot = () => Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));",
      'const atImport = snapshot();',
      'export default () => {',
      "  process.stderr.write(`${JSON.stringify({ atImport, atRun: snapshot() })}\\n`);",
      '  process.exit(0);',
      "  return new McpServer({ name: 'manifest-env', version: '1.0.0' });",
      '};',
      '',
    ].join('\n'));
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            probe: {
              entry: './src/server.ts',
              env: { HOST_EXPORTED: 'manifest-default', MANIFEST_KEPT: 'manifest-default', MANIFEST_ONLY: 'manifest-default' },
            },
          },
        },
        plugin: { name: 'mcp-manifest-env', version: '1.0.0' },
        targets: ['claude'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'artifact');
    const result = await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });
    const [entry] = result.compiledMcpEntries;
    const pluginRoot = outputRoot;

    // The host reads the manifest, expands its plugin-root token, and merges
    // the `env` block into the child environment beneath its own exports —
    // so the child sees a manifest default and a host export the same way.
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8')) as {
      readonly mcpServers: Readonly<Record<string, { readonly env: Readonly<Record<string, string>> }>>;
    };
    const manifestEnv = Object.fromEntries(Object.entries(manifest.mcpServers['probe']!.env)
      .map(([key, value]) => [key, value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)]));
    expect(manifestEnv).toEqual({
      AGENT_BUNDLE_PLUGIN_ROOT: pluginRoot,
      HOST_EXPORTED: 'manifest-default',
      MANIFEST_KEPT: 'manifest-default',
      MANIFEST_ONLY: 'manifest-default',
    });
    const hostExports = { HOST_EXPORTED: 'from-host', HOST_ONLY: 'from-host' };
    const launch = async (overrides: Readonly<Record<string, string>> = {}): Promise<unknown> => {
      const run = await runNodeScript({ args: [entry!.output], env: { ...manifestEnv, ...hostExports, ...overrides } });
      expect(run).toMatchObject({ code: 0, stdout: '' });
      const report = JSON.parse(run.stderr) as { readonly atImport: unknown; readonly atRun: unknown };
      // The layer lands before the server module's own top level.
      expect(report.atImport).toEqual(report.atRun);
      return report.atRun;
    };
    // No file: the host environment as delivered.
    const delivered = {
      ABSENT_EVERYWHERE: null,
      HOST_EXPORTED: 'from-host',
      HOST_ONLY: 'from-host',
      MANIFEST_KEPT: 'manifest-default',
      MANIFEST_ONLY: 'manifest-default',
    };
    expect(await launch()).toEqual(delivered);

    await writeFile(join(pluginRoot, '.env'), [
      'MANIFEST_ONLY=from-file',
      'HOST_EXPORTED=from-file',
      'HOST_ONLY=from-file',
      'ABSENT_EVERYWHERE=from-file',
      '',
    ].join('\n'));
    // manifest < .env < host: a passed-through manifest default yields to the
    // file, a host export never does, a gap is filled, an untouched manifest
    // default stays.
    expect(await launch()).toEqual({
      ABSENT_EVERYWHERE: 'from-file',
      HOST_EXPORTED: 'from-host',
      HOST_ONLY: 'from-host',
      MANIFEST_KEPT: 'manifest-default',
      MANIFEST_ONLY: 'from-file',
    });
    // `AGENT_BUNDLE_ENV_FILE=none` disables the layer: the manifest default stands.
    expect(await launch({ AGENT_BUNDLE_ENV_FILE: 'none' })).toEqual(delivered);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it('redirects stdout written at module scope by the server module to stderr before the protocol stream opens, and discards a module-scope wrapper over stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-module-scope-stdout-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    // A factory entry whose module top level writes to stdout both ways a
    // consumer module can: the console and the raw stream. The server module
    // is a static import of the shell, so it evaluates before the shell body;
    // only a guard installed by an earlier import keeps these off the wire.
    // It then wraps `process.stdout.write` the way a logging library might:
    // the wrapper sits over the redirect, and the guard must discard it when
    // the protocol stream opens rather than adopt it as the original.
    await writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "console.log('hello');",
      "process.stdout.write('raw\\n');",
      'const previous = process.stdout.write;',
      'process.stdout.write = ((chunk, ...rest) => previous.call(process.stdout, `wrapped:${chunk}`, ...rest)) as typeof process.stdout.write;',
      "process.stdout.write('after wrap\\n');",
      'export default () => {',
      "  console.log('factory');",
      "  const server = new McpServer({ name: 'module-scope-stdout', version: '1.0.0' });",
      "  server.registerTool('ping', { description: 'Reply.' }, async () => {",
      "    console.log('tool');",
      "    return { content: [{ type: 'text' as const, text: 'pong' }] };",
      '  });',
      '  return server;',
      '};',
      '',
    ].join('\n'));
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: { servers: { chatty: { entry: './src/server.ts' } } },
        plugin: { name: 'mcp-module-scope-stdout', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    const result = await build({ model, outputRoot: join(root, 'artifact'), projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });
    const [entry] = result.compiledMcpEntries;

    const stderrChunks: string[] = [];
    const transport = new StdioClientTransport({ args: [entry!.output], command: process.execPath, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk: Buffer | string) => stderrChunks.push(String(chunk)));
    const client = new Client({ name: 'module-scope-stdout-consumer', version: '1.0.0' });
    await client.connect(transport);
    try {
      // initialize completed above; tools/list and a call prove the protocol
      // stream stayed clean end to end.
      expect((await client.listTools()).tools).toMatchObject([{ name: 'ping' }]);
      expect(await client.callTool({ arguments: {}, name: 'ping' })).toMatchObject({ content: [{ text: 'pong', type: 'text' }] });
    } finally {
      await client.close();
    }
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('hello\nraw\nwrapped:after wrap\n');
    expect(stderr).toContain('a module replaced process.stdout.write while console output was redirected to stderr');
    expect(stderr).toContain('factory\n');
    expect(stderr).toContain('tool\n');
    // The frames themselves never went through the wrapper.
    expect(stderr).not.toContain('wrapped:{');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it('builds one deterministic self-contained MCP App view and injects it through the virtual module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-build-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    await symlink(workbenchNodeModules, join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'src', 'server.ts'), [
      "import apps from 'agent-bundle/mcp-apps';",
      'export const bundledApps = apps;',
      '',
    ].join('\n'));
    await writeFile(join(root, 'views', 'dashboard.ts'), [
      "import { createElement } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import './dashboard.css';",
      "createRoot(document.querySelector('#view')!).render(createElement('span', undefined, 'dashboard-ready'));",
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
                  resourceUri: 'ui://agent-bundle/dashboard.html',
                  template: './views/shell.html',
                },
              },
              entry: './src/server.ts',
            },
          },
        },
        plugin: { name: 'mcp-app-build', version: '1.0.0' },
        targets: ['portable', 'codex', 'claude'],
      }),
      { skills: [] },
      registry,
    );
    const outputRoot = join(root, 'dist');
    const result = await build({
      model,
      outputRoot,
      projectRoot: root,
      registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph,
    });
    const compiled = (result as unknown as {
      readonly compiledMcpApps: readonly {
        readonly id: string;
        readonly name: string;
        readonly output: string;
        readonly resourceUri: string;
        readonly sourceInputs: readonly string[];
        readonly target: string;
      }[];
    }).compiledMcpApps;
    const sourceInputs = [
      join(root, 'agent-bundle.config.ts'),
      join(root, 'views', 'dashboard.css'),
      join(root, 'views', 'dashboard.ts'),
      join(root, 'views', 'shell.html'),
    ];
    // One composite root compiles the app once for the whole selection (#555).
    expect(compiled).toEqual([expect.objectContaining({
      _meta: { ui: { prefersBorder: true } },
      id: 'mcp-app:fixture:dashboard',
      mimeType: 'text/html;profile=mcp-app',
      name: 'dashboard',
      output: join(outputRoot, 'mcp-apps', 'dashboard.html'),
      resourceUri: 'ui://agent-bundle/dashboard.html',
      serverIds: ['mcp:fixture'],
      source: join(root, 'views', 'dashboard.ts'),
      sourceInputs,
      target: 'claude+codex+portable',
    })]);
    expect(compiled.every((entry) => Object.isFrozen(entry.sourceInputs))).toBe(true);
    const html = await readFile(join(outputRoot, 'mcp-apps', 'dashboard.html'), 'utf8');
    expect(html).toContain('dashboard-ready');
    expect(html).toContain('<script');
    expect(html).toContain('<style');
    expect(html.indexOf('<script')).toBeGreaterThan(html.indexOf('<main id="view"'));
    expect(html).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=/iu);
    expect(await readdir(join(outputRoot, 'mcp-apps'))).toEqual(['dashboard.html']);
    const serverBundle = await readFile(join(outputRoot, 'mcp', 'mcp-fixture-f16d05ec.mjs'), 'utf8');
    expect(serverBundle).toContain('ui://agent-bundle/dashboard.html');
    expect(serverBundle).toContain('text/html;profile=mcp-app');
    expect(serverBundle).toContain('prefersBorder');
    expect(result.outputProvenance).toContainEqual({
      kind: 'bundle',
      path: 'mcp-apps/dashboard.html',
      sourceInputs: [
        'agent-bundle.config.ts',
        'views/dashboard.css',
        'views/dashboard.ts',
        'views/shell.html',
      ],
    });
    expect(await validateArtifact({ artifactRoot: outputRoot })).toEqual([]);
    expect(result.outputProvenance).toContainEqual({
      kind: 'bundle',
      path: 'mcp/mcp-fixture-f16d05ec.mjs',
      sourceInputs: [
        'agent-bundle.config.ts',
        'src/server.ts',
        'views/dashboard.css',
        'views/dashboard.ts',
        'views/shell.html',
      ],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('injects one release identity into both the Node bundle and the browser MCP App bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-meta-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    // package.json is the only version source: the config declares no
    // plugin.version, so every compiled surface must agree on 4.5.6.
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: '@scope/meta-fixture', version: '4.5.6' })}\n`,
    );
    await symlink(workbenchNodeModules, join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'src', 'server.ts'), [
      "import meta from 'agent-bundle/meta';",
      "import { name, packageName, version } from 'agent-bundle/meta';",
      'export const serverIdentity = [name, version, packageName, meta.packageVersion];',
      '',
    ].join('\n'));
    await writeFile(join(root, 'views', 'dashboard.ts'), [
      "import { createElement } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { name, packageVersion, version } from 'agent-bundle/meta';",
      "createRoot(document.querySelector('#view')!).render(",
      "  createElement('span', undefined, `${name} ${version} ${packageVersion}`),",
      ');',
      '',
    ].join('\n'));
    await writeFile(join(root, 'views', 'shell.html'), '<!doctype html><html><body><main id="view"></main></body></html>\n');

    const loaded = loadedProject(root, {
      mcp: {
        servers: {
          fixture: {
            apps: {
              dashboard: {
                entry: './views/dashboard.ts',
                resourceUri: 'ui://agent-bundle/dashboard.html',
                template: './views/shell.html',
              },
            },
            entry: './src/server.ts',
          },
        },
      },
      plugin: { name: 'meta-fixture' },
      targets: ['portable'],
    });
    const releaseDiagnostics = validateSource(loaded, { skills: [] }, registry, { release: true });
    expect(releaseDiagnostics.filter((diagnostic) => diagnostic.severity !== 'info')).toEqual([]);

    const model = await normalizeProject(loaded, { skills: [] }, registry);
    expect(model.metadata).toMatchObject({
      name: 'meta-fixture',
      packageName: '@scope/meta-fixture',
      packageVersion: '4.5.6',
      version: '4.5.6',
    });

    const outputRoot = join(root, 'dist');
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });

    const serverBundle = await readFile(join(outputRoot, 'mcp', 'mcp-fixture-f16d05ec.mjs'), 'utf8');
    for (const injected of ['meta-fixture', '4.5.6', '@scope/meta-fixture']) {
      expect(serverBundle).toContain(injected);
    }
    expect(serverBundle).not.toContain('agent-bundle/meta');

    const html = await readFile(join(outputRoot, 'mcp-apps', 'dashboard.html'), 'utf8');
    for (const injected of ['meta-fixture', '4.5.6']) {
      expect(html).toContain(injected);
    }
    expect(html).not.toContain('agent-bundle/meta');
    expect(await validateArtifact({ artifactRoot: outputRoot })).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('compiles one shared MCP App once and serves it from every identically declaring server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-shared-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    await symlink(workbenchNodeModules, join(root, 'node_modules'), 'dir');
    const serverSource = [
      "import apps from 'agent-bundle/mcp-apps';",
      'export const bundledApps = apps;',
      '',
    ].join('\n');
    await writeFile(join(root, 'src', 'library.ts'), serverSource);
    await writeFile(join(root, 'src', 'public.ts'), serverSource);
    await writeFile(join(root, 'views', 'widget.ts'), 'document.body.textContent = "widget-ready";\n');

    const widget = {
      _meta: { ui: { prefersBorder: true } },
      entry: './views/widget.ts',
      resourceUri: 'ui://agent-bundle/widget.html',
    };
    const config = {
      mcp: {
        servers: {
          library: { apps: { widget }, entry: './src/library.ts' },
          public: { apps: { widget: { ...widget } }, entry: './src/public.ts' },
        },
      },
      plugin: { name: 'mcp-app-shared', version: '1.0.0' },
      targets: ['portable'],
    };
    // Both fixture entries are deliberately self-connecting registry probes,
    // so validation reports exactly the two informational AB4730 nudges.
    expect(validateSource(loadedProject(root, config), { skills: [] }, registry)).toEqual([
      expect.objectContaining({ code: 'AB4730', severity: 'info' }),
      expect.objectContaining({ code: 'AB4730', severity: 'info' }),
    ]);

    const model = await normalizeProject(loadedProject(root, config), { skills: [] }, registry);
    const outputRoot = join(root, 'dist');
    const result = await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });

    const compiled = (result as unknown as {
      readonly compiledMcpApps: readonly { readonly name: string; readonly serverIds: readonly string[] }[];
    }).compiledMcpApps;
    expect(compiled).toEqual([expect.objectContaining({
      name: 'widget',
      resourceUri: 'ui://agent-bundle/widget.html',
      serverIds: ['mcp:library', 'mcp:public'],
    })]);
    expect(await readdir(join(outputRoot, 'mcp-apps'))).toEqual(['widget.html']);

    const bundleNames = await readdir(join(outputRoot, 'mcp'));
    for (const serverName of ['library', 'public']) {
      const bundleName = bundleNames.find((entry) => entry.startsWith(`mcp-${serverName}-`));
      expect(bundleName).toBeDefined();
      const bundle = await readFile(join(outputRoot, 'mcp', bundleName!), 'utf8');
      expect(bundle).toContain('ui://agent-bundle/widget.html');
      expect(bundle).toContain('widget-ready');
      expect(bundle).toContain('prefersBorder');
    }
    expect(await validateArtifact({ artifactRoot: outputRoot })).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('rejects conflicting same-name MCP App declarations at compilation planning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-conflict-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'src', 'library.ts'), 'export {};\n');
    await writeFile(join(root, 'src', 'public.ts'), 'export {};\n');
    await writeFile(join(root, 'views', 'widget.ts'), 'export {};\n');
    await writeFile(join(root, 'views', 'other.ts'), 'export {};\n');

    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            library: {
              apps: {
                widget: { entry: './views/widget.ts', resourceUri: 'ui://agent-bundle/widget.html' },
              },
              entry: './src/library.ts',
            },
            public: {
              apps: {
                widget: { entry: './views/other.ts', resourceUri: 'ui://agent-bundle/widget.html' },
              },
              entry: './src/public.ts',
            },
          },
        },
        plugin: { name: 'mcp-app-conflict', version: '1.0.0' },
        targets: ['portable'],
      }),
      { skills: [] },
      registry,
    );
    await expect(build({
      model,
      outputRoot: join(root, 'dist'),
      projectRoot: root,
      registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph,
    })).rejects.toThrow(
      'Duplicate compiled MCP App destination "mcp-apps/widget.html"; servers may share an app name only with an identical declaration.',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('rejects the MCP Apps virtual module outside Agent Bundle compilation', async () => {
  await expect(import('../src/mcp-apps.ts')).rejects.toThrow(
    'agent-bundle/mcp-apps is available only while Agent Bundle compiles a local MCP server.',
  );
});

it('rejects the built MCP Apps entrypoint with the intended error, not a TDZ ReferenceError', async () => {
  // The rslib bundle reorders module statements (`export default` above the
  // const initializers), so the stub's contract must hold against dist, not
  // just src. Import in a child process: module evaluation errors are cached
  // per realm, so an in-process import could observe another test's result.
  const distEntry = join(agentBundlePackageRoot, 'dist', 'mcp-apps.js');
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(distEntry).href)});`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('close', (exitCode) => {
      resolve({ code: exitCode, stderr: output });
    });
  });
  expect(code).toBe(1);
  expect(stderr).toContain(
    'agent-bundle/mcp-apps is available only while Agent Bundle compiles a local MCP server.',
  );
  expect(stderr).not.toContain('ReferenceError');
});

it('rejects the built identity module with the intended error, not a TDZ ReferenceError', async () => {
  // `agent-bundle/meta` carries the same dist contract as `agent-bundle/mcp-apps`:
  // a compiled surface resolves it to the generated identity, and anything
  // else must say so rather than report a fabricated identity.
  await expect(import('../src/meta.ts')).rejects.toMatchObject({
    code: 'AB4760',
    message: expect.stringContaining('agent-bundle/meta is available only inside a surface Agent Bundle compiles'),
  });

  const distEntry = join(agentBundlePackageRoot, 'dist', 'meta.js');
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(distEntry).href)});`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('close', (exitCode) => {
      resolve({ code: exitCode, stderr: output });
    });
  });
  expect(code).toBe(1);
  // Node 24 colorizes the uncaught-error property dump even on a piped
  // stderr, so the assertions read the text without its escape sequences.
  const plain = stripVTControlCharacters(stderr);
  expect(plain).toContain('[AB4760] agent-bundle/meta is available only inside a surface Agent Bundle compiles');
  // The recovery rides on the message, so a bare `node` process prints the
  // exact fix without any diagnostic formatter (#386).
  expect(plain).toContain('recovery: Run the test under agentBundleRstest() or agentBundleBrowserRstest()');
  expect(plain).toContain("code: 'AB4760'");
  expect(plain).not.toContain('ReferenceError');
});

it('uses the selected streamable HTTP manifest with propagated cancellation and cleans data before rejecting tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-remote-'));
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
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
    await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });

    const connected: Array<{ readonly options: { readonly signal?: AbortSignal; readonly timeout: number }; readonly transport: unknown }> = [];
    const requested: Array<{ readonly signal?: AbortSignal; readonly timeout: number }> = [];
    const http: Array<{ readonly headers?: Record<string, string>; readonly url: string }> = [];
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

    expect(http).toEqual([{ headers: { 'X-Data': expect.any(String) }, url: 'https://mcp.example.test/tools' }]);
    expect(connected[0]?.options).toEqual({ signal: controller.signal, timeout: 321 });
    expect(requested[0]).toEqual({ signal: controller.signal, timeout: 321 });
    expect(closes).toBe(1);
    await expect(access(http[0]!.headers!['X-Data']!)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(join(artifact, '.claude-plugin', 'plugin.json'), '{"name":"tampered"}\n');
    await expect(service.list({ artifact, server: 'http', target: 'claude' })).rejects.toThrow();
    expect(closes).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a selected projection without its manifest-declared MCP document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-projection-document-'));
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: {
          servers: {
            shared: {
              transport: 'streamable-http',
              url: 'https://mcp.example.test/tools',
            },
          },
        },
        plugin: { name: 'mcp-projection-document', version: '1.0.0' },
        targets: ['claude', 'codex'],
      }),
      { skills: [] },
      registry,
    );
    const artifact = join(root, 'dist');
    await build({
      model,
      outputRoot: artifact,
      projectRoot: root,
      registry: createDefaultRegistry(),
      routeGraph: emptyCompiledRouteGraph,
    });
    const manifestPath = join(artifact, artifactManifestName);
    const manifest = parseArtifactManifest(await readFile(manifestPath, 'utf8'));
    const projections = manifest.projections.map((projection) => {
      if (projection.host !== 'codex') return projection;
      const { mcp: _mcp, ...documents } = projection.documents;
      return { ...projection, documents };
    });
    await writeFile(
      manifestPath,
      assembleArtifactManifest({ ...manifest, projections }).bytes,
    );

    await expect(new McpService().list({
      artifact,
      server: 'shared',
      target: 'codex',
    })).rejects.toThrow('The codex projection has no MCP document.');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('creates session state only after setup succeeds and always inherits the stdio environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-stdio-options-'));
  const inheritedKey = 'AGENT_BUNDLE_TEST_MCP_INHERITED';
  const previousInherited = process.env[inheritedKey];
  // McpService creates session state via mkdtemp('agent-bundle-mcp-') in
  // os.tmpdir(), and other files in the parallel integration pool create
  // identically-prefixed directories there concurrently, so scanning the
  // shared OS tmpdir races with sibling workers. Point TMPDIR (which
  // os.tmpdir() re-reads on every call) at a directory this test owns and
  // scan only that.
  const sessionTmp = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-stdio-options-sessions-'));
  const previousTmpdir = process.env['TMPDIR'];
  const sessionDirectories = async (): Promise<readonly string[]> =>
    (await readdir(sessionTmp)).filter((name) => name.startsWith('agent-bundle-mcp-')).sort();
  try {
    process.env[inheritedKey] = 'inherited-sentinel';
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
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
    await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });

    process.env['TMPDIR'] = sessionTmp;
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
    if (previousTmpdir === undefined) {
      delete process.env['TMPDIR'];
    } else {
      process.env['TMPDIR'] = previousTmpdir;
    }
    if (previousInherited === undefined) {
      delete process.env[inheritedKey];
    } else {
      process.env[inheritedKey] = previousInherited;
    }
    await rm(sessionTmp, { force: true, recursive: true });
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
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
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
                  resourceUri: 'ui://agent-bundle/dashboard.html',
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
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });
    const expectedHtml = await readFile(join(outputRoot, 'mcp-apps', 'dashboard.html'), 'utf8');
    await cp(outputRoot, artifact, { recursive: true });
    await rm(join(root, 'src'), { force: true, recursive: true });
    await rm(join(root, 'views'), { force: true, recursive: true });
    expect(await validateArtifact({ artifactRoot: artifact })).toEqual([]);

    const client = new Client({ name: 'app-resource-consumer', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      args: [join(artifact, 'mcp', 'mcp-fixture-f16d05ec.mjs')],
      command: process.execPath,
      stderr: 'pipe',
    }));
    try {
      const tools = await client.listTools();
      expect(tools.tools).toMatchObject([
        {
          _meta: { ui: { resourceUri: 'ui://agent-bundle/dashboard.html' } },
          name: 'show-dashboard',
        },
      ]);
      const resources = await client.listResources();
      expect(resources.resources).toMatchObject([
        {
          _meta: { ui: { prefersBorder: true }, 'x-fixture': { app: 'dashboard' } },
          mimeType: 'text/html;profile=mcp-app',
          name: 'dashboard',
          uri: 'ui://agent-bundle/dashboard.html',
        },
      ]);
      const resource = await client.readResource({ uri: 'ui://agent-bundle/dashboard.html' });
      expect(resource.contents).toEqual([
        {
          mimeType: 'text/html;profile=mcp-app',
          text: expectedHtml,
          uri: 'ui://agent-bundle/dashboard.html',
        },
      ]);
      const result = await client.callTool({ arguments: {}, name: 'show-dashboard' });
      expect(result).toMatchObject({
        _meta: { ui: { resourceUri: 'ui://agent-bundle/dashboard.html' } },
        content: [{ text: 'dashboard ready', type: 'text' }],
        structuredContent: { resourceUri: 'ui://agent-bundle/dashboard.html', view: 'dashboard' },
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
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
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
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry(), routeGraph: emptyCompiledRouteGraph });
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
    expect(firstSession.root).toBe(artifact);
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
