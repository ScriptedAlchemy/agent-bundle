import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { nativeHookWrapperSource, type TargetHookWrapper } from '../src/adapters/hook-contract.ts';
import { buildWithRslib } from '../src/build/compiler.ts';
import type { CompileResult } from '../src/build/compile-result.ts';
import {
  cliEntryRuntimePath,
  cliEntryRuntimeSpecifier,
  generatedCliBinEntrySource,
  generatedExecutableEntrySource,
  generatedInstallBinEntrySource,
  generatedStdioMcpEntrySource,
  installEntryRuntimePath,
  installEntryRuntimeSpecifier,
  launchEnvRuntimePath,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  stdioPreludeVirtualModule,
  terminalCapabilityRuntimePath,
  terminalCapabilityRuntimeSpecifier,
} from '../src/build/entry-shell.ts';
import { launchEnvRuntimeSpecifier, operatorEnvLayerVirtualModule } from '../src/build/launch-env-shell.ts';
import type { RslibEntry } from '../src/build/rslib.ts';
import { runtimeIgnoredRoot } from '../src/build/runtime-path.ts';
import type { NormalizedHook, SourceProvenance } from '../src/core/types.ts';
import type { AgentBundleMeta } from '../src/meta.ts';
import type { CompiledAgentRoute, CompiledCliCommand } from '../src/routes/types.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const testMeta: AgentBundleMeta = Object.freeze({
  name: 'fixture',
  packageName: '@fixture/plugin',
  packageVersion: '1.0.0',
  version: '1.0.0',
});

const plugin = { name: 'fixture', version: '1.0.0' };

const provenance = (root: string): SourceProvenance => ({
  kind: 'config',
  sourcePath: join(root, 'agent-bundle.config.ts'),
});

const fixtureRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-generated-module-evidence-')));
  roots.push(root);
  for (const directory of ['src/cli', 'src/mcp', 'src/hooks']) {
    await mkdir(join(root, ...directory.split('/')), { recursive: true });
  }
  await writeFile(
    join(root, 'package.json'),
    '{"name":"generated-module-evidence-fixture","type":"module","private":true,"dependencies":{"@agent-bundle/runtime":"*"}}\n',
  );
  await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'src', 'cli.ts'), 'export const main = async (): Promise<number> => 0;\n');
  await writeFile(join(root, 'src', 'cli', 'report.ts'), 'export const run = async (): Promise<number> => 0;\n');
  await writeFile(join(root, 'src', 'mcp', 'curator.ts'), 'export default (): Record<string, never> => ({});\n');
  await writeFile(join(root, 'src', 'hooks', 'probe.ts'), 'export default async (): Promise<void> => undefined;\n');
  await symlink(agentBundleNodeModules, join(root, 'node_modules'), 'dir');
  return root;
};

const cliRoute = (root: string): CompiledAgentRoute => ({
  config: {},
  id: 'cli:report',
  kind: 'cli',
  provenance: { kind: 'conventional', relativePath: 'src/cli/report.ts' },
  source: join(root, 'src', 'cli', 'report.ts'),
});

const plainCommand: CompiledCliCommand = {
  aliases: [],
  exitCode: 'zero',
  options: [],
  path: ['report'],
  rendered: false,
  routeId: 'cli:report',
};

const configHook = (root: string): NormalizedHook => ({
  event: 'sessionStart',
  id: 'hook:sessionStart:probe',
  name: 'probe',
  provenance: provenance(root),
  source: join(root, 'src', 'hooks', 'probe.ts'),
  targets: ['claude'],
  tools: [],
});

const claudeWrapper = (root: string): TargetHookWrapper => ({
  event: 'sessionStart',
  hook: configHook(root),
  nativeEvent: 'SessionStart',
  relativePath: 'hooks/probe.mjs',
  target: 'claude',
});

const entryOf = (
  options: Pick<RslibEntry, 'aliases' | 'name' | 'outputRelativePath' | 'source' | 'virtualModules' | 'virtualSource'>,
): RslibEntry => ({
  ...options,
  sourceInputs: [options.source],
});

const generators: ReadonlyArray<{
  readonly label: string;
  readonly plan: (root: string) => RslibEntry;
}> = [
  {
    label: 'generatedExecutableEntrySource (main, cli)',
    plan: (root) => {
      const source = join(root, 'src', 'cli.ts');
      return entryOf({
        aliases: { [terminalCapabilityRuntimeSpecifier]: terminalCapabilityRuntimePath() },
        name: 'bin-main',
        outputRelativePath: 'bin/main.js',
        source,
        virtualSource: generatedExecutableEntrySource({
          entrySource: source,
          exportName: 'main',
          hostSurface: 'cli',
        }),
      });
    },
  },
  {
    label: 'generatedCliBinEntrySource (plain)',
    plan: (root) => entryOf({
      aliases: { [cliEntryRuntimeSpecifier]: cliEntryRuntimePath() },
      name: 'bin-cli',
      outputRelativePath: 'bin/cli.js',
      source: join(root, 'src', 'cli', 'report.ts'),
      virtualSource: generatedCliBinEntrySource({
        commands: [plainCommand],
        plugin,
        routes: [cliRoute(root)],
      }),
    }),
  },
  {
    label: 'generatedInstallBinEntrySource',
    plan: (root) => entryOf({
      aliases: { [installEntryRuntimeSpecifier]: installEntryRuntimePath() },
      name: 'bin-install',
      outputRelativePath: 'bin/installer.js',
      source: join(root, 'src', 'cli.ts'),
      virtualSource: generatedInstallBinEntrySource({
        artifactRelativeUrl: '../../artifact/',
        hosts: ['claude', 'codex', 'cursor'],
        name: 'installer',
      }),
    }),
  },
  {
    label: 'generatedStdioMcpEntrySource',
    plan: (root) => {
      const source = join(root, 'src', 'mcp', 'curator.ts');
      return entryOf({
        aliases: {
          [launchEnvRuntimeSpecifier]: launchEnvRuntimePath(),
          [mcpEntryRuntimeSpecifier]: mcpEntryRuntimePath(),
        },
        name: 'mcp-curator',
        outputRelativePath: 'mcp/curator.mjs',
        source,
        virtualModules: [stdioPreludeVirtualModule()],
        virtualSource: generatedStdioMcpEntrySource({ entrySource: source, serverName: 'curator' }),
      });
    },
  },
  {
    label: 'nativeHookWrapperSource (Claude)',
    plan: (root) => entryOf({
      aliases: { [launchEnvRuntimeSpecifier]: launchEnvRuntimePath() },
      name: 'hooks-probe',
      outputRelativePath: 'hooks/probe.mjs',
      source: join(root, 'src', 'hooks', 'probe.ts'),
      virtualModules: [operatorEnvLayerVirtualModule()],
      virtualSource: nativeHookWrapperSource(claudeWrapper(root), 'Claude'),
    }),
  },
];

const compileGenerator = async (root: string, entry: RslibEntry): Promise<CompileResult> => {
  const ignored = [...new Set(Object.values(entry.aliases ?? {}).map(runtimeIgnoredRoot))];
  return buildWithRslib({
    cwd: root,
    entries: [entry],
    ...(ignored.length === 0 ? {} : { ignoredSourcePaths: ignored }),
    logLevel: 'error',
    meta: testMeta,
    outputRoot: join(root, 'dist'),
  });
};

describe('framework-generated modules compile with only Node builtin externals', () => {
  it.each(generators)('$label', async ({ plan }) => {
    const root = await fixtureRoot();
    const result = await compileGenerator(root, plan(root));
    expect(result.externals.every((external) => external.kind === 'builtin')).toBe(true);
  }, 120_000);
});
