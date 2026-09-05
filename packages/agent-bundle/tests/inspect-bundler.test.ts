import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { inspect, type BundlerInspectionEntry, type ReadyInspectResult } from '../src/api.ts';
import { stableJson } from '../src/core/digest.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createProject = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-inspect-bundler-')));
  roots.push(parent);
  const root = join(parent, 'project');
  await mkdir(join(root, 'src', 'mcp'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'bundler-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  scripts: { tool: './src/tool.ts' },",
        '  mcp: {',
        '    servers: {',
        '      curator: {',
        '        apps: {',
        "          dashboard: { entry: './src/view.tsx', resourceUri: 'ui://bundler-fixture/dashboard' },",
        '        },',
        '      },',
        '    },',
        '  },',
        '  tools: {',
        "    rsbuild: { output: { legalComments: 'linked' } },",
        "    rspack: { resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } },",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'tool.ts'), 'export const main = async () => 0;\n'),
    writeFile(join(root, 'src', 'cli.ts'), 'export const main = async () => 0;\n'),
    writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n'),
    writeFile(
      join(root, 'src', 'mcp', 'curator.ts'),
      'export default () => ({ close() {}, async connect() {} });\n',
    ),
    writeFile(join(root, 'src', 'view.tsx'), 'export default () => null;\n'),
  ]);
  return root;
};

const bundlerEntries = (result: ReadyInspectResult): readonly BundlerInspectionEntry[] => {
  const bundler = result.selected?.bundler;
  if (bundler === undefined) throw new Error('Bundler inspection was not selected.');
  return bundler.entries;
};

const entryOf = (
  entries: readonly BundlerInspectionEntry[],
  kind: BundlerInspectionEntry['kind'],
  name: string,
): BundlerInspectionEntry => {
  const entry = entries.find((candidate) => candidate.kind === kind && candidate.name === name);
  if (entry === undefined) throw new Error(`Missing bundler inspection entry ${kind}:${name}.`);
  return entry;
};

it('surfaces every synthesized bundler config with the tools hatch merged over the profile', async () => {
  const root = await createProject();
  const result = await inspect({ focus: 'bundler', root });
  expect(result.state).toBe('ready');
  const ready = result as ReadyInspectResult;
  const entries = bundlerEntries(ready);

  expect(entries.map((entry) => `${entry.target ?? 'package'}:${entry.kind}:${entry.name}`)).toEqual([
    'package:bin:bundler-fixture',
    'package:lib:index',
    'portable:mcp-apps:mcp-apps',
    'portable:mcp-entry:curator',
    'portable:script:tool',
  ]);

  const script = entryOf(entries, 'script', 'tool');
  expect(script).toMatchObject({
    bundler: 'rslib',
    outputPath: 'portable/scripts/tool.mjs',
    source: `${root}/src/tool.ts`,
    target: 'portable',
  });
  // The generated executable envelope wraps the `main` export.
  expect(script.generatedEntry).toContain('process.argv.slice(2)');
  expect(script.config).toMatchObject({
    id: 'agent-bundle-scripts-tool',
    // Routes are authored as TSX, so every Rslib entry carries the React
    // plugin: without it JSX lowers to a `React` factory that no generated
    // executable has in scope.
    plugins: [{ name: 'rsbuild:react' }],
    output: {
      distPath: { root: '<output>/portable' },
      filename: { js: 'scripts/tool.mjs' },
      // The consumer rsbuild hatch merges over the framework profile value.
      legalComments: 'linked',
      target: 'node',
    },
    syntax: 'es2022',
    tools: {
      // Rslib's `new URL()` rule is switched off so filesystem URLs in
      // generated and plugin code survive verbatim.
      bundlerChain: '[function preserveResourceReferences]',
      // The consumer rspack hatch is merged before the framework invariant
      // hook, which always runs last.
      rspack: [
        { resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } },
        '[function enforceInvariants]',
      ],
    },
  });

  const mcpEntry = entryOf(entries, 'mcp-entry', 'curator');
  expect(mcpEntry.generatedEntry).toContain('runGeneratedStdioMcpEntry');
  expect(mcpEntry.source).toBe(`${root}/src/mcp/curator.ts`);
  expect(mcpEntry.outputPath).toMatch(/^portable\/mcp\/mcp-curator-[a-f\d]{8}\.mjs$/u);

  const bin = entryOf(entries, 'bin', 'bundler-fixture');
  expect(bin).toMatchObject({
    config: {
      banner: { js: '#!/usr/bin/env node' },
      output: { distPath: { root: 'dist' } },
    },
    outputPath: 'dist/bin/bundler-fixture.js',
    source: `${root}/src/cli.ts`,
  });
  expect(bin.generatedEntry).toContain('process.argv.slice(2)');

  const lib = entryOf(entries, 'lib', 'index');
  expect(lib).toMatchObject({
    config: {
      dts: true,
      source: { tsconfigPath: '<generated-dts-tsconfig>' },
    },
    outputPath: 'dist/index.js',
  });

  const apps = entryOf(entries, 'mcp-apps', 'mcp-apps');
  expect(apps.bundler).toBe('rsbuild');
  expect(apps.config).toMatchObject({
    environments: {
      dashboard: { source: { entry: { dashboard: `${root}/src/view.tsx` } } },
    },
    output: {
      distPath: { html: 'mcp-apps', root: '<output>/portable' },
      inlineScripts: true,
      // The consumer rsbuild hatch also merges over the view profile.
      legalComments: 'linked',
    },
    tools: {
      rspack: [
        { resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } },
        '[function enforceInvariants]',
      ],
    },
  });
});

it('keeps the bundler inspection deterministic and JSON-serializable', async () => {
  const root = await createProject();
  const [first, second] = await Promise.all([
    inspect({ focus: 'bundler', root }),
    inspect({ focus: 'bundler', root }),
  ]);
  expect(first.state).toBe('ready');
  expect(stableJson((first as ReadyInspectResult).selected))
    .toBe(stableJson((second as ReadyInspectResult).selected));
});

it('keeps the bundler focus out of unfocused inspections', async () => {
  const root = await createProject();
  const result = await inspect({ root });
  expect(result.state).toBe('ready');
  expect((result as ReadyInspectResult).selected).toBeUndefined();
});
