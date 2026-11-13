import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  openCodeAdapter,
  openCodeArtifactPaths,
  openCodePluginEntrySource,
  openCodePluginPackage,
  openCodePluginValidator,
  openCodeConfigValidator,
  openCodeMcpValidator,
} from '../src/adapters/opencode.ts';
import { readTargetMcpServers } from '../src/services/mcp-runtime.ts';
import { removeTree } from './support/remove-tree.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const plugin = (): NormalizedPlugin => ({
  projectRoot: '/workspace',
  extensions: {},
  hooks: [],
  metadata: {
    description: 'Browse a local movie library.',
    id: 'plugin:movie-library',
    name: 'movie-library',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.2.3',
  },
  mcpServers: [
    {
      args: [`${pathTokens.pluginRoot}/mcp/library.mjs`, '--data', pathTokens.pluginData],
      command: 'node',
      cwd: pathTokens.pluginRoot,
      env: {
        AGENT_BUNDLE_PLUGIN_ROOT: pathTokens.pluginRoot,
        CACHE_DIR: `${pathTokens.workspaceRoot}/cache`,
      },
      id: 'mcp:library',
      name: 'library',
      provenance: { kind: 'config', sourcePath: configPath },
      source: '/workspace/src/mcp/library/server.ts',
      targets: ['opencode'],
      transport: 'stdio',
    },
    {
      headers: { Authorization: 'Bearer literal' },
      id: 'mcp:remote',
      name: 'remote',
      provenance: { kind: 'config', sourcePath: configPath },
      targets: ['opencode'],
      transport: 'streamable-http',
      url: 'https://mcp.example.test/stream',
    },
  ],
  runtime: { node: '22.19.0' },
  scripts: [],
  skills: [
    {
      body: '# Movie library\n\nSearch before answering.\n',
      description: 'Search and manage movies.',
      dir: '/workspace/src/skills/movie-library',
      frontmatter: { description: 'Search and manage movies.', name: 'movie-library' },
      id: 'skill:movie-library',
      name: 'movie-library',
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/skills/movie-library/SKILL.md' },
      resources: [
        { bytes: 45, relativePath: 'SKILL.md', source: '/workspace/src/skills/movie-library/SKILL.md' },
        { bytes: 8, relativePath: 'references/api.md', source: '/workspace/src/skills/movie-library/references/api.md' },
      ],
      source: '/workspace/src/skills/movie-library/SKILL.md',
      targets: ['opencode'],
    },
  ],
  targets: [
    { id: 'target:opencode', name: 'opencode', provenance: { kind: 'config', sourcePath: configPath } },
  ],
});

const writes = (model: NormalizedPlugin): Record<string, string> => Object.fromEntries(
  openCodeAdapter.plan(model).entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]),
);

it('registers OpenCode V2 as a first-class target with native document and runtime contracts', () => {
  const registry = createDefaultRegistry();
  expect(registry.names()).toContain('opencode');
  expect(registry.builtInHost('opencode')).toBe('opencode');
  expect(registry.defaultTargetNames()).toEqual(['portable']);
  for (const capability of ['mcp', 'skills', 'commands', 'hooks', 'install', 'cli']) {
    expect(registry.supports('opencode', capability), capability).toBe(true);
  }
  expect(registry.supports('opencode', 'marketplace')).toBe(false);
  expect(registry.supports('opencode', 'rules')).toBe(false);
  expect(registry.hookContract('opencode')?.registration).toBe('api');
  expect(registry.mcpRuntime('opencode')?.manifestPath).toBe(openCodeArtifactPaths.mcp);
  expect(registry.artifactLayout('opencode').skills).toBe('skills');
  expect(registry.artifactLayout('opencode').rootDocuments).toEqual([
    'INSTALL.md',
    'agent-bundle.mcp.json',
    'index.js',
    'package.json',
  ]);
  expect(registry.artifactValidation('opencode').documents).toEqual([
    { path: '.opencode/opencode.json', required: true, schema: 'config' },
    { path: 'agent-bundle.mcp.json', required: false, schema: 'mcp' },
    { path: 'package.json', required: true, schema: 'package' },
  ]);
});

it('emits the artifact root as a relocatable native V2 package and project config', () => {
  const model = plugin();
  model.commands = [{
    body: 'Find $ARGUMENTS and summarize the result.\n',
    frontmatter: { description: 'Find a movie' },
    id: 'command:find-movie',
    markdown: '---\ndescription: Find a movie\n---\nFind $ARGUMENTS and summarize the result.\n',
    name: 'find-movie',
    provenance: { kind: 'conventional', sourcePath: '/workspace/src/commands/find-movie.md' },
    source: '/workspace/src/commands/find-movie.md',
    targets: ['opencode'],
  }];
  const plan = openCodeAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);
  const documents = writes(model);
  const config = JSON.parse(documents['.opencode/opencode.json']!) as Record<string, unknown>;
  expect(config).toEqual({
    $schema: 'https://opencode.ai/config.json',
    plugins: ['..'],
  });
  expect(openCodeConfigValidator(config)).toBe(true);

  const manifest = JSON.parse(documents['package.json']!) as Record<string, unknown>;
  expect(manifest).toEqual(openCodePluginPackage(model));
  expect(manifest).toMatchObject({
    exports: { '.': './index.js' },
    name: 'movie-library',
    type: 'module',
    version: '1.2.3',
  });
  expect(openCodePluginValidator(manifest)).toBe(true);
  expect(plan.documents).toEqual({ entry: 'index.js', plugin: 'package.json' });

  expect(plan.entries).toContainEqual(expect.objectContaining({
    kind: 'write',
    relativePath: 'commands/find-movie.md',
    content: 'Find $ARGUMENTS and summarize the result.\n',
  }));
  expect(plan.entries).toContainEqual(expect.objectContaining({
    kind: 'copy',
    relativePath: 'skills/movie-library/references/api.md',
  }));
});

it('lowers canonical MCP servers to the native V2 local and remote transform shapes', async () => {
  const model = plugin();
  const documents = writes(model);
  const internal = JSON.parse(documents[openCodeArtifactPaths.mcp]!) as {
    readonly mcpServers: Record<string, Record<string, unknown>>;
  };
  expect(openCodeMcpValidator(internal)).toBe(true);
  expect(internal.mcpServers['library']).toEqual({
    args: [`${pathTokens.pluginRoot}/mcp/library.mjs`, '--data', pathTokens.pluginData],
    command: 'node',
    cwd: pathTokens.pluginRoot,
    env: {
      AGENT_BUNDLE_PLUGIN_ROOT: pathTokens.pluginRoot,
      CACHE_DIR: `${pathTokens.workspaceRoot}/cache`,
    },
    type: 'stdio',
  });
  expect(internal.mcpServers['remote']).toEqual({
    headers: { Authorization: 'Bearer literal' },
    type: 'streamable-http',
    url: 'https://mcp.example.test/stream',
  });

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-mcp-emission-'));
  try {
    await mkdir(join(root, 'skills', 'movie-library'), { recursive: true });
    await writeFile(join(root, 'skills', 'movie-library', 'SKILL.md'), '# Movie library\n');
    await writeFile(join(root, 'index.js'), openCodePluginEntrySource(model, internal, []));
    const plugin = await import(pathToFileURL(join(root, 'index.js')).href);
    const registered: Record<string, unknown> = {};
    await plugin.default.setup({
      location: { directory: '/work' },
      mcp: {
        transform: async (apply: (editor: { set(name: string, value: Record<string, unknown>): void }) => void) => {
          apply({ set: (name, value) => { registered[name] = value; } });
          return { dispose: async () => undefined };
        },
      },
      skill: {
        transform: async (apply: (editor: { add(value: unknown): void }) => void) => {
          apply({ add: () => undefined });
          return { dispose: async () => undefined };
        },
      },
    });
    expect(registered).toEqual({
      library: {
        command: [
          'node',
          `${resolve(root)}/mcp/library.mjs`,
          '--data',
          `${resolve(root, 'state')}`,
        ],
        cwd: resolve(root),
        environment: {
          AGENT_BUNDLE_PLUGIN_ROOT: resolve(root),
          CACHE_DIR: '/work/cache',
        },
        type: 'local',
      },
      remote: {
        headers: { Authorization: 'Bearer literal' },
        type: 'remote',
        url: 'https://mcp.example.test/stream',
      },
    });
  } finally {
    await removeTree(root);
  }

  const result = readTargetMcpServers(openCodeAdapter.mcpRuntime!, internal);
  expect(result.status).toBe('found');
  if (result.status === 'found') {
    expect(result.servers.map((entry) => [entry.name, entry.server.kind])).toEqual([
      ['library', 'stdio'],
      ['remote', 'streamable-http'],
    ]);
  }
});

it('fails closed on unsupported MCP path tokens and invalid native documents', () => {
  const model = plugin();
  model.mcpServers = [{
    args: ['${CLAUDE_PLUGIN_ROOT}/mcp/library.mjs'],
    command: 'node',
    id: 'mcp:library',
    name: 'library',
    provenance: { kind: 'config', sourcePath: configPath },
    targets: ['opencode'],
    transport: 'stdio',
  }];
  expect(openCodeAdapter.plan(model).diagnostics).toEqual([
    expect.objectContaining({ code: 'opencode.mcp.token', severity: 'error', target: 'opencode' }),
  ]);
  expect(openCodePluginValidator({ name: 'bad name' })).toBe(false);
  expect(openCodeConfigValidator({ plugins: 'not-an-array' })).toBe(false);
  expect(openCodeMcpValidator({ mcpServers: { bad: { type: 'sse', url: 'http://localhost' } } })).toBe(false);
});
