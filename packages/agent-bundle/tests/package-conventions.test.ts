import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pluginReact } from '@rsbuild/plugin-react';
import { afterEach, describe, expect, it } from '@rstest/core';

import {
  discoverProject,
  normalizeProject,
  validateSource,
  type NormalizationTargetRegistry,
} from '../src/config/index.ts';
import { normalizePackageBuild } from '../src/config/normalize.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import type { LoadedConfig } from '../src/config/load.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const projectRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-conventions-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

const loadedProject = (config: AgentBundleConfig, root: string): LoadedConfig => ({
  config,
  configPath: `${root}/agent-bundle.config.ts`,
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

describe('package build normalization', () => {
  it('normalizes explicit bin and lib config with config provenance', async () => {
    const root = await projectRoot({
      'src/entry.ts': 'export const main = async () => 0;\n',
      'src/library.ts': 'export const answer = 42;\n',
    });
    const model = await normalizeProject(loadedProject({
      bin: { 'my-tool': './src/entry.ts', other: { entry: './src/entry.ts' } },
      lib: { dts: false, entry: './src/library.ts' },
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);

    expect(model.packageBuild).toEqual({
      bins: [
        {
          id: 'bin:my-tool',
          name: 'my-tool',
          provenance: { kind: 'config', sourcePath: `${root}/agent-bundle.config.ts` },
          source: `${root}/src/entry.ts`,
        },
        {
          id: 'bin:other',
          name: 'other',
          provenance: { kind: 'config', sourcePath: `${root}/agent-bundle.config.ts` },
          source: `${root}/src/entry.ts`,
        },
      ],
      lib: {
        dts: false,
        id: 'lib:library',
        name: 'library',
        provenance: { kind: 'config', sourcePath: `${root}/agent-bundle.config.ts` },
        source: `${root}/src/library.ts`,
      },
      outputDir: 'dist',
    });
  });

  it('defaults lib dts to true for the string form', async () => {
    const root = await projectRoot({ 'src/index.ts': 'export const a = 1;\n' });
    const packageBuild = normalizePackageBuild(
      { lib: './src/index.ts', plugin: { name: 'p', version: '1.0.0' } },
      root,
      `${root}/agent-bundle.config.ts`,
    );
    expect(packageBuild?.lib).toMatchObject({ dts: true, name: 'index' });
  });

  it('discovers src/cli.ts and src/index.ts conventions with conventional provenance', async () => {
    const root = await projectRoot({
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/index.ts': 'export const answer = 42;\n',
    });
    const model = await normalizeProject(loadedProject({
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);

    expect(model.packageBuild).toEqual({
      bins: [{
        id: 'bin:review-tools',
        name: 'review-tools',
        provenance: { kind: 'conventional', sourcePath: `${root}/src/cli.ts` },
        source: `${root}/src/cli.ts`,
      }],
      lib: {
        dts: true,
        id: 'lib:index',
        name: 'index',
        provenance: { kind: 'conventional', sourcePath: `${root}/src/index.ts` },
        source: `${root}/src/index.ts`,
      },
      outputDir: 'dist',
    });
  });

  it('lets config win over convention and false disable it', async () => {
    const root = await projectRoot({
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/index.ts': 'export const answer = 42;\n',
      'src/other.ts': 'export const main = async () => 0;\n',
    });
    const explicit = await normalizeProject(loadedProject({
      bin: { renamed: './src/other.ts' },
      lib: false,
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);
    expect(explicit.packageBuild?.bins.map((bin) => bin.name)).toEqual(['renamed']);
    expect(explicit.packageBuild?.lib).toBeUndefined();

    const disabled = await normalizeProject(loadedProject({
      bin: false,
      lib: false,
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);
    expect(disabled.packageBuild).toBeUndefined();
  });

  it('skips the bin convention when the plugin name is not a safe output name', async () => {
    const root = await projectRoot({ 'src/cli.ts': 'export const main = async () => 0;\n' });
    const model = await normalizeProject(loadedProject({
      plugin: { name: '@scope/unsafe name', version: '1.0.0' },
    }, root), { skills: [] }, registry);
    expect(model.packageBuild).toBeUndefined();
  });

  it('leaves projects without package entries untouched', async () => {
    const root = await projectRoot({});
    const model = await normalizeProject(loadedProject({
      plugin: { name: 'plain', version: '1.0.0' },
    }, root), { skills: [] }, registry);
    expect(model.packageBuild).toBeUndefined();
  });
});

describe('conventional MCP entries', () => {
  it('discovers src/mcp/<server-id>.ts for servers naming no entry, command, or url', async () => {
    const root = await projectRoot({
      'src/mcp/curator.ts': 'export default () => ({ close() {}, async connect() {} });\n',
    });
    const loaded = loadedProject({
      mcp: { servers: { curator: {} } },
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root);

    expect(validateSource(loaded, { skills: [] }, registry)).toEqual([]);
    const model = await normalizeProject(loaded, { skills: [] }, registry);
    expect(model.mcpServers).toEqual([{
      args: [expect.stringMatching(/^mcp\/mcp-curator-[a-f\d]{8}\.mjs$/u)],
      command: 'node',
      cwd: 'agent-bundle:path:plugin-root',
      id: 'mcp:curator',
      name: 'curator',
      provenance: { kind: 'conventional', sourcePath: `${root}/src/mcp/curator.ts` },
      source: `${root}/src/mcp/curator.ts`,
      targets: ['portable'],
      transport: 'stdio',
    }]);
  });

  it('lets an explicit entry win over the conventional file', async () => {
    const root = await projectRoot({
      'src/explicit.ts': 'export default () => ({});\n',
      'src/mcp/curator.ts': 'export default () => ({});\n',
    });
    const model = await normalizeProject(loadedProject({
      mcp: { servers: { curator: { entry: './src/explicit.ts' } } },
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);
    expect(model.mcpServers[0]).toMatchObject({
      provenance: { kind: 'config' },
      source: `${root}/src/explicit.ts`,
    });
  });

  it('still rejects servers without any entry, command, url, or conventional file', async () => {
    const root = await projectRoot({});
    const diagnostics = validateSource(loadedProject({
      mcp: { servers: { curator: {} } },
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB4304',
      message: expect.stringContaining('src/mcp/curator.ts'),
    })]);
  });
});

describe('bin, lib, and tools validation', () => {
  const validated = async (
    config: Omit<AgentBundleConfig, 'plugin'>,
    files: Readonly<Record<string, string>> = {},
  ) => {
    const root = await projectRoot(files);
    return validateSource(loadedProject({
      ...config,
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);
  };

  it('accepts well-formed bin, lib, and tools configuration', async () => {
    const diagnostics = await validated({
      bin: { tool: './src/cli.ts' },
      lib: { entry: './src/index.ts' },
      tools: { rsbuild: { output: { legalComments: 'none' } }, rspack: (config: object) => config },
    }, {
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/index.ts': 'export const a = 1;\n',
    });
    expect(diagnostics).toEqual([]);
  });

  it.each([
    { code: 'AB4700', config: { bin: 'nope' as never }, label: 'non-object bin' },
    { code: 'AB4701', config: { bin: { 'bad name': './src/cli.ts' } }, label: 'unsafe bin name' },
    { code: 'AB4702', config: { bin: { tool: 7 as never } }, label: 'non-path bin declaration' },
    { code: 'AB4703', config: { bin: { tool: '../outside.ts' } }, label: 'escaping bin entry' },
    { code: 'AB4704', config: { bin: { tool: './src/cli.sh' } }, label: 'unsupported bin extension' },
    { code: 'AB4705', config: { bin: { tool: './src/missing.ts' } }, label: 'missing bin entry' },
    { code: 'AB4710', config: { lib: 7 as never }, label: 'malformed lib' },
    { code: 'AB4712', config: { lib: '../outside.ts' }, label: 'escaping lib entry' },
    { code: 'AB4714', config: { lib: './src/missing.ts' }, label: 'missing lib entry' },
    { code: 'AB4715', config: { lib: { dts: 'yes' as never, entry: './src/index.ts' } }, label: 'non-boolean lib dts' },
    { code: 'AB4720', config: { tools: 'nope' as never }, label: 'non-object tools' },
    { code: 'AB4721', config: { tools: { webpack: {} } as never }, label: 'unknown tools key' },
    { code: 'AB4722', config: { tools: { rsbuild: 7 } as never }, label: 'non-object rsbuild hatch' },
    { code: 'AB4723', config: { tools: { rspack: 'nope' } as never }, label: 'malformed rspack hatch' },
  ])('rejects $label with $code', async ({ code, config }) => {
    const diagnostics = await validated(config, {
      'src/cli.sh': 'echo hi\n',
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/index.ts': 'export const a = 1;\n',
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it.each([
    { config: { source: { alias: {} } }, path: 'source.alias', replacement: 'resolve.alias' },
    { config: { source: { aliasStrategy: 'prefer-alias' } }, path: 'source.aliasStrategy', replacement: 'resolve.aliasStrategy' },
    { config: { performance: { bundleAnalyze: {} } }, path: 'performance.bundleAnalyze', replacement: 'Rsdoctor' },
    { config: { performance: { removeMomentLocale: true } }, path: 'performance.removeMomentLocale', replacement: 'Remove' },
    { config: { performance: { profile: true } }, path: 'performance.profile', replacement: 'custom Rsbuild plugin' },
    { config: { performance: { chunkSplit: { strategy: 'all-in-one' } } }, path: 'performance.chunkSplit', replacement: 'splitChunks' },
    { config: { output: { sourceMap: { extract: { js: true } } } }, path: 'output.sourceMap.extract.js', replacement: 'output.sourceMap.extract' },
    { config: { provider: 'rspack' }, path: 'provider', replacement: 'Remove' },
    { config: { tools: { webpack: {} } }, path: 'tools.webpack', replacement: 'tools.rspack' },
    { config: { tools: { webpackChain: () => {} } }, path: 'tools.webpackChain', replacement: 'tools.bundlerChain' },
    { config: { dev: { setupMiddlewares: () => {} } }, path: 'dev.setupMiddlewares', replacement: 'server.setup' },
    {
      config: { server: { proxy: [{ context: '/api', target: 'https://example.com' }] } },
      path: 'server.proxy[].context',
      replacement: 'pathFilter',
    },
    {
      config: { server: { proxy: { '/api': { onOpen: () => {} } } } },
      path: 'server.proxy.*.onOpen',
      replacement: 'on.open',
    },
    {
      config: { server: { proxy: { '/api': { onClose: () => {} } } } },
      path: 'server.proxy.*.onClose',
      replacement: 'on.close',
    },
    {
      config: { server: { proxy: { '/api': { onError: () => {} } } } },
      path: 'server.proxy.*.onError',
      replacement: 'on.error',
    },
    {
      config: { server: { proxy: { '/api': { onProxyReq: () => {} } } } },
      path: 'server.proxy.*.onProxyReq',
      replacement: 'on.proxyReq',
    },
    {
      config: { server: { proxy: { '/api': { onProxyRes: () => {} } } } },
      path: 'server.proxy.*.onProxyRes',
      replacement: 'on.proxyRes',
    },
  ])('rejects deprecated Rsbuild v2 hatch key $path with AB4726', async ({ config, path, replacement }) => {
    const diagnostics = await validated({ tools: { rsbuild: config as never } });
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB4726',
      message: `Tools rsbuild ${path} is a deprecated Rsbuild v2 configuration key.`,
      recovery: expect.stringContaining(replacement),
      severity: 'error',
    })]);
  });

  it('allows authored template variables named after removed HtmlRspackPlugin defaults', async () => {
    const diagnostics = await validated({
      tools: {
        rsbuild: {
          html: {
            templateParameters: {
              htmlWebpackPlugin: 'author-defined',
              webpackConfig: 'author-defined',
            },
          },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it('does not apply Rsbuild v2 key rejection to tools.rspack configuration', async () => {
    const diagnostics = await validated({
      tools: {
        rspack: {
          performance: { chunkSplit: true },
          output: { sourceMap: { extract: { js: true } } },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  // AB4724: Rsbuild appends every plugin it is handed without deduping by
  // name, and the hatch merges beside the framework profile, so a consumer
  // re-adding a framework-owned plugin would register it twice.
  it('rejects a framework-owned plugin re-added through tools.rsbuild.plugins with AB4724', async () => {
    const diagnostics = await validated({
      tools: { rsbuild: { plugins: [pluginReact(), [false, pluginReact({ fastRefresh: true })]] } },
    });
    const collisions = diagnostics.filter((diagnostic) => diagnostic.code === 'AB4724');
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      message: expect.stringContaining('"rsbuild:react" (@rsbuild/plugin-react) is already registered by agent-bundle'),
      recovery: expect.stringContaining('Remove @rsbuild/plugin-react from tools.rsbuild.plugins'),
      severity: 'error',
    });
    expect(collisions[0]!.sourcePath).toMatch(/agent-bundle\.config\.ts$/u);
  });

  it('accepts unrelated plugins in tools.rsbuild.plugins without a collision diagnostic', async () => {
    const diagnostics = await validated({
      tools: {
        rsbuild: {
          plugins: [
            { name: 'consumer:banner', setup: () => undefined },
            [null, { name: 'consumer:nested', setup: () => undefined }],
            Promise.resolve(pluginReact()),
          ],
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  const toolsExternalization = {
    message: 'generated executables bundle every dependency that is not a Node built-in.',
    recovery: 'Remove the externalization from tools; the compiler bundles the dependency and fails the build if a non-built-in stays external (AB6005).',
    severity: 'error' as const,
  };

  it('rejects tools.rsbuild.output.autoExternal that is not false with AB4725', async () => {
    const diagnostics = await validated({
      tools: { rsbuild: { output: { autoExternal: true } } },
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB4725',
      message: 'Tools rsbuild output.autoExternal must stay false; generated executables bundle every dependency that is not a Node built-in.',
      recovery: toolsExternalization.recovery,
      severity: 'error',
    })]);
    expect(diagnostics[0]!.sourcePath).toMatch(/agent-bundle\.config\.ts$/u);
  });

  it.each([
    { externals: 'left-pad', label: 'string' },
    { externals: ['left-pad'], label: 'array' },
    { externals: { 'left-pad': true }, label: 'object' },
  ])('rejects a tools.rsbuild.output.externals $label that externalizes a non-built-in with AB4725', async ({ externals }) => {
    const diagnostics = await validated({
      tools: { rsbuild: { output: { externals } } },
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      ...toolsExternalization,
      code: 'AB4725',
      message: `Tools rsbuild output.externals externalizes ${JSON.stringify('left-pad')}; ${toolsExternalization.message}`,
    })]);
  });

  it('accepts tools.rsbuild.output.externals that only name Node built-ins or use a RegExp', async () => {
    const diagnostics = await validated({
      tools: { rsbuild: { output: { externals: ['node:fs', 'fs', /^node:/] } } },
    });
    expect(diagnostics).toEqual([]);
  });

  it('accepts a tools.rsbuild.output.externals object that opts out with false', async () => {
    const diagnostics = await validated({
      tools: { rsbuild: { output: { externals: { 'left-pad': false } } } },
    });
    expect(diagnostics).toEqual([]);
  });

  it('rejects tools.rspack object-form externals that externalize a non-built-in with AB4725', async () => {
    const diagnostics = await validated({
      tools: { rspack: { externals: ['left-pad'] } },
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      ...toolsExternalization,
      code: 'AB4725',
      message: `Tools rspack externals externalizes ${JSON.stringify('left-pad')}; ${toolsExternalization.message}`,
    })]);
  });

  it('rejects tools.rspack array-form object fragments that externalize a non-built-in with AB4725', async () => {
    const diagnostics = await validated({
      tools: { rspack: [{ externals: 'left-pad' }, () => {}] },
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      ...toolsExternalization,
      code: 'AB4725',
      message: `Tools rspack externals externalizes ${JSON.stringify('left-pad')}; ${toolsExternalization.message}`,
    })]);
  });

  it('accepts a mutator-only tools.rspack without an AB4725', async () => {
    const diagnostics = await validated({
      tools: { rspack: (config: object) => config },
    });
    expect(diagnostics).toEqual([]);
  });
});

describe('artifact output validation', () => {
  const validated = async (output: unknown) => {
    const root = await projectRoot({});
    return validateSource(loadedProject({
      output: output as never,
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root), { skills: [] }, registry);
  };

  it.each([
    { code: 'AB4707', label: 'an undefined block', output: undefined },
    { code: 'AB4707', label: 'an array block', output: [] },
    { code: 'AB4707', label: 'a string block', output: 'artifact' },
    { code: 'AB4707', label: 'an undefined path', output: { distPath: undefined } },
    { code: 'AB4707', label: 'a non-string path', output: { distPath: 7 } },
    { code: 'AB4707', label: 'an empty path', output: { distPath: '' } },
    { code: 'AB4708', label: 'an absolute path', output: { distPath: '/abs/path' } },
    { code: 'AB4708', label: 'a parent path', output: { distPath: '../out' } },
    { code: 'AB4708', label: 'nested parent traversal', output: { distPath: 'a/../../b' } },
    { code: 'AB4708', label: 'the project root', output: { distPath: '.' } },
    { code: 'AB4708', label: 'a backslash path', output: { distPath: 'a\\b' } },
    { code: 'AB4708', label: 'an empty segment', output: { distPath: 'a//b' } },
    { code: 'AB4709', label: 'the framework namespace', output: { distPath: '.agent-bundle' } },
    { code: 'AB4709', label: 'the source namespace', output: { distPath: 'src' } },
    { code: 'AB4709', label: 'the dependency namespace', output: { distPath: 'node_modules/x' } },
    { code: 'AB4709', label: 'the VCS namespace', output: { distPath: '.git' } },
  ])('rejects $label with $code', async ({ code, output }) => {
    const diagnostics = await validated(output);
    expect(diagnostics).toEqual([expect.objectContaining({
      code,
      recovery: expect.any(String),
      severity: 'error',
    })]);
  });

  it.each(['artifact', 'build/artifact', 'dist'])('accepts %s', async (distPath) => {
    await expect(validated({ distPath })).resolves.toEqual([]);
  });

  it('accepts an explicit sourceMap opt-in without a distPath', async () => {
    await expect(validated({ sourceMap: true })).resolves.toEqual([]);
    await expect(validated({ distPath: 'artifact', sourceMap: false })).resolves.toEqual([]);
  });

  it('rejects a non-boolean output.sourceMap with AB4707', async () => {
    const diagnostics = await validated({ sourceMap: 'inline-source-map' });
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB4707',
      recovery: expect.any(String),
      severity: 'error',
    })]);
  });
});

describe('migration nudges (AB473x)', () => {
  const factoryEntry = 'export default () => ({ close() {}, async connect() {} });\n';
  const selfConnectingEntry = [
    "import { connect } from './transport.js';",
    'await connect();',
    '',
  ].join('\n');

  const validated = async (
    config: Omit<AgentBundleConfig, 'plugin'>,
    files: Readonly<Record<string, string>> = {},
  ) => {
    const root = await projectRoot(files);
    return {
      diagnostics: validateSource(loadedProject({
        ...config,
        plugin: { name: 'review-tools', version: '1.0.0' },
      }, root), { skills: [] }, registry),
      root,
    };
  };

  it('nudges AB4730 for a self-connecting explicit stdio entry', async () => {
    const { diagnostics, root } = await validated(
      { mcp: { servers: { curator: { entry: './src/server.ts' } } } },
      { 'src/server.ts': selfConnectingEntry },
    );
    expect(diagnostics).toEqual([{
      code: 'AB4730',
      message: expect.stringContaining('self-connecting'),
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
      sourcePath: `${root}/src/server.ts`,
    }]);
  });

  it('nudges AB4730 for a self-connecting conventional stdio entry', async () => {
    const { diagnostics, root } = await validated(
      { mcp: { servers: { curator: {} } } },
      { 'src/mcp/curator.ts': selfConnectingEntry },
    );
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB4730',
      severity: 'info',
      sourcePath: `${root}/src/mcp/curator.ts`,
    })]);
  });

  it('stays silent for factory-exporting stdio entries', async () => {
    const { diagnostics } = await validated(
      {
        mcp: {
          servers: {
            curator: {},
            explicit: { entry: './src/factory.ts' },
          },
        },
      },
      {
        'src/factory.ts': factoryEntry,
        'src/mcp/curator.ts': factoryEntry,
      },
    );
    expect(diagnostics).toEqual([]);
  });

  it('nudges AB4731 when explicit bin configuration shadows src/cli.ts', async () => {
    const { diagnostics, root } = await validated(
      { bin: { other: './src/other.ts' } },
      {
        'src/cli.ts': 'export const main = async () => 0;\n',
        'src/other.ts': 'export const main = async () => 0;\n',
      },
    );
    expect(diagnostics).toEqual([{
      code: 'AB4731',
      message: expect.stringContaining('src/cli.ts'),
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
      sourcePath: `${root}/src/cli.ts`,
    }]);
  });

  it('stays silent when bin config references src/cli.ts or opts out with false', async () => {
    const files = {
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/other.ts': 'export const main = async () => 0;\n',
    };
    const referencing = await validated(
      { bin: { other: './src/other.ts', tool: './src/cli.ts' } },
      files,
    );
    expect(referencing.diagnostics).toEqual([]);

    const optedOut = await validated({ bin: false }, files);
    expect(optedOut.diagnostics).toEqual([]);
  });

  it('nudges AB4732 when explicit lib configuration shadows src/index.ts', async () => {
    const { diagnostics, root } = await validated(
      { lib: { entry: './src/other.ts' } },
      {
        'src/index.ts': 'export const a = 1;\n',
        'src/other.ts': 'export const b = 2;\n',
      },
    );
    expect(diagnostics).toEqual([{
      code: 'AB4732',
      message: expect.stringContaining('src/index.ts'),
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
      sourcePath: `${root}/src/index.ts`,
    }]);
  });

  it('stays silent when lib config references src/index.ts or opts out with false', async () => {
    const files = {
      'src/index.ts': 'export const a = 1;\n',
      'src/other.ts': 'export const b = 2;\n',
    };
    const referencing = await validated({ lib: './src/index.ts' }, files);
    expect(referencing.diagnostics).toEqual([]);

    const optedOut = await validated({ lib: false }, files);
    expect(optedOut.diagnostics).toEqual([]);
  });

  it('nudges AB4733 when explicit server configuration shadows src/mcp/<id>.ts', async () => {
    const entryShadow = await validated(
      { mcp: { servers: { curator: { entry: './src/factory.ts' } } } },
      {
        'src/factory.ts': factoryEntry,
        'src/mcp/curator.ts': factoryEntry,
      },
    );
    expect(entryShadow.diagnostics).toEqual([{
      code: 'AB4733',
      message: expect.stringContaining('src/mcp/curator.ts'),
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
      sourcePath: `${entryShadow.root}/src/mcp/curator.ts`,
    }]);

    const commandShadow = await validated(
      { mcp: { servers: { curator: { command: 'curator-server' } } } },
      { 'src/mcp/curator.ts': factoryEntry },
    );
    expect(commandShadow.diagnostics).toEqual([expect.objectContaining({
      code: 'AB4733',
      severity: 'info',
    })]);
  });

  it('stays silent when the explicit entry is the conventional file itself', async () => {
    const { diagnostics } = await validated(
      { mcp: { servers: { curator: { entry: './src/mcp/curator.ts' } } } },
      { 'src/mcp/curator.ts': factoryEntry },
    );
    expect(diagnostics).toEqual([]);
  });

  const skillMarkdown = (name: string): string =>
    `---\nname: ${name}\ndescription: The ${name} skill for nudge coverage.\n---\n\n# ${name}\n\nBody.\n`;

  const discoveredAndValidated = async (
    config: Omit<AgentBundleConfig, 'plugin'>,
    files: Readonly<Record<string, string>>,
  ) => {
    const root = await projectRoot(files);
    const loaded = loadedProject({
      ...config,
      plugin: { name: 'review-tools', version: '1.0.0' },
    }, root);
    const discovered = await discoverProject(root, loaded.config);
    return { diagnostics: validateSource(loaded, discovered, registry), root };
  };

  it('errors with AB4736 for a skill in the removed top-level conventional location', async () => {
    const { diagnostics, root } = await discoveredAndValidated(
      {},
      { 'skills/legacy/SKILL.md': skillMarkdown('legacy') },
    );

    expect(diagnostics).toEqual([{
      code: 'AB4736',
      message: expect.stringContaining('skills/legacy/SKILL.md'),
      recovery: expect.stringContaining('src/skills/legacy/SKILL.md'),
      severity: 'error',
      sourcePath: `${root}/skills/legacy/SKILL.md`,
    }]);
  });

  it('does not report AB4736 when explicit skills config claims a top-level skill', async () => {
    const { diagnostics } = await discoveredAndValidated(
      { skills: ['skills/legacy'] },
      { 'skills/legacy/SKILL.md': skillMarkdown('legacy') },
    );

    expect(diagnostics.filter(({ code }) => code === 'AB4736')).toEqual([]);
  });

  it('errors with AB4736 for top-level command and rule documents', async () => {
    const { diagnostics, root } = await discoveredAndValidated(
      {},
      {
        'commands/legacy.md': '# Legacy command\n',
        'rules/legacy.mdc': '---\ndescription: Legacy rule\n---\nAlways verify.\n',
      },
    );

    expect(diagnostics).toEqual([
      {
        code: 'AB4736',
        message: expect.stringContaining('commands/legacy.md'),
        recovery: expect.stringContaining('src/commands/legacy.md'),
        severity: 'error',
        sourcePath: `${root}/commands/legacy.md`,
      },
      {
        code: 'AB4736',
        message: expect.stringContaining('rules/legacy.mdc'),
        recovery: expect.stringContaining('src/rules/legacy.mdc'),
        severity: 'error',
        sourcePath: `${root}/rules/legacy.mdc`,
      },
    ]);
  });

  it('discovers skills from the src convention', async () => {
    const root = await projectRoot({
      'src/skills/review/SKILL.md': skillMarkdown('review'),
    });

    const discovered = await discoverProject(root, {
      plugin: { name: 'review-tools', version: '1.0.0' },
    });

    expect(discovered.skills).toMatchObject([{
      dir: `${root}/src/skills/review`,
      source: `${root}/src/skills/review/SKILL.md`,
    }]);
  });

  it('nudges AB4734 when explicit skills configuration shadows a conventional skill', async () => {
    const { diagnostics, root } = await discoveredAndValidated(
      { skills: ['src/skills/covered'] },
      {
        'src/skills/covered/SKILL.md': skillMarkdown('covered'),
        'src/skills/shadowed/SKILL.md': skillMarkdown('shadowed'),
      },
    );
    expect(diagnostics).toEqual([{
      code: 'AB4734',
      message: expect.stringContaining('src/skills/shadowed/SKILL.md'),
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
      sourcePath: `${root}/src/skills/shadowed/SKILL.md`,
    }]);
  });

  it('stays silent when skills config is absent or covers every conventional skill', async () => {
    const files = {
      'src/skills/one/SKILL.md': skillMarkdown('one'),
      'src/skills/two/SKILL.md': skillMarkdown('two'),
    };
    const conventional = await discoveredAndValidated({}, files);
    expect(conventional.diagnostics).toEqual([]);

    const globCovered = await discoveredAndValidated({ skills: ['src/skills/*'] }, files);
    expect(globCovered.diagnostics).toEqual([]);

    const literalCovered = await discoveredAndValidated(
      { skills: ['src/skills/one', 'src/skills/two/SKILL.md'] },
      files,
    );
    expect(literalCovered.diagnostics).toEqual([]);
  });

  it('never raises nudges above info severity', async () => {
    const { diagnostics } = await validated(
      {
        bin: { other: './src/other.ts' },
        lib: { entry: './src/other.ts' },
        mcp: { servers: { curator: { entry: './src/server.ts' } } },
      },
      {
        'src/cli.ts': 'export const main = async () => 0;\n',
        'src/index.ts': 'export const a = 1;\n',
        'src/mcp/curator.ts': factoryEntry,
        'src/other.ts': 'export const main = async () => 0;\n',
        'src/server.ts': selfConnectingEntry,
      },
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      'AB4730', 'AB4731', 'AB4732', 'AB4733',
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'info')).toBe(true);
  });
});
