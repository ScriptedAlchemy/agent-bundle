import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('nudges AB4734 when explicit skills configuration shadows a conventional skill', async () => {
    const { diagnostics, root } = await discoveredAndValidated(
      { skills: ['skills/covered'] },
      {
        'skills/covered/SKILL.md': skillMarkdown('covered'),
        'skills/shadowed/SKILL.md': skillMarkdown('shadowed'),
      },
    );
    expect(diagnostics).toEqual([{
      code: 'AB4734',
      message: expect.stringContaining('skills/shadowed/SKILL.md'),
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
      sourcePath: `${root}/skills/shadowed/SKILL.md`,
    }]);
  });

  it('stays silent when skills config is absent or covers every conventional skill', async () => {
    const files = {
      'skills/one/SKILL.md': skillMarkdown('one'),
      'skills/two/SKILL.md': skillMarkdown('two'),
    };
    const conventional = await discoveredAndValidated({}, files);
    expect(conventional.diagnostics).toEqual([]);

    const globCovered = await discoveredAndValidated({ skills: ['skills/*'] }, files);
    expect(globCovered.diagnostics).toEqual([]);

    const literalCovered = await discoveredAndValidated(
      { skills: ['skills/one', 'skills/two/SKILL.md'] },
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
