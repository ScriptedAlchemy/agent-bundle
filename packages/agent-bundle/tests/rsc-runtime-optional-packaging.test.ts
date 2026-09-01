import { execFile as executeFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';

import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const skillsOnlyFixture = join(workspaceRoot, 'fixtures', 'integration', 'skills-only');

type InstalledDependencyTree = Readonly<{
  readonly dependencies?: Readonly<Record<string, InstalledDependencyTree>>;
  readonly name?: string;
  readonly version?: string;
}>;

/**
 * Names npm actually installed. An entry npm records without a version is an
 * unmet optional peer: it names a dependency the consumer chose not to take,
 * and nothing for it exists on disk.
 */
const installedDependencyNames = (tree: InstalledDependencyTree): readonly string[] => {
  const names = new Set<string>();
  const visit = (node: InstalledDependencyTree): void => {
    if (typeof node.name === 'string') names.add(node.name);
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (typeof dependency.version === 'string') names.add(name);
      visit(dependency);
    }
  };
  visit(tree);
  return [...names].sort();
};

const namedFiles = async (root: string, name: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.endsWith(name));
};

describe.sequential('optional RSC runtime package boundary', () => {
  it('runs an ordinary skills-only project from a fresh installed tarball without the RSC runtime', async () => {
    const { tarball } = await sharedPackedTarball('agent-bundle');
    const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-rsc-optional-consumer-'));
    const project = join(consumer, 'project');
    const artifact = join(project, '.agent-bundle', 'artifact');
    try {
      await writeFile(join(consumer, 'package.json'), '{"name":"rsc-optional-consumer","type":"module"}\n');
      const tarListing = (await execFile('tar', ['-tf', tarball])).stdout;
      expect(tarListing).not.toMatch(/examples\/rsc-agent-runtime|react-server-dom-rspack|rsbuild-plugin-rsc/u);

      await execFile('npm', ['install', ...cachedNpmInstallArguments, tarball], { cwd: consumer, env: installedEnvironment() });
      const dependencyTree = JSON.parse((await execFile('npm', ['ls', '--all', '--json'], { cwd: consumer, env: installedEnvironment() })).stdout) as InstalledDependencyTree;
      const installedNames = installedDependencyNames(dependencyTree);
      // The harness subpaths (agent-bundle/test, agent-bundle/rstest) declare
      // Rstest and React as optional peers, so a project that does not test
      // routes installs neither (#103).
      for (const name of [
        '@agent-bundle/runtime',
        '@rstest/core',
        'react',
        'react-dom',
        'react-server-dom-rspack',
        'rsbuild-plugin-rsc',
      ]) {
        expect(installedNames).not.toContain(name);
        expect(existsSync(join(consumer, 'node_modules', name))).toBe(false);
      }

      await cp(skillsOnlyFixture, project, { recursive: true });
      const script = [
        "import { build, inspect, validate } from 'agent-bundle/api';",
        "import { startDevServer } from 'agent-bundle';",
        `const root = ${JSON.stringify(project)};`,
        `const output = ${JSON.stringify(artifact)};`,
        'const inspected = await inspect({ root });',
        "if (inspected.state !== 'ready') throw new Error('skills-only fixture was not ready');",
        'await build({ output, root });',
        'const validated = await validate({ artifact: output, root });',
        'const session = await startDevServer({ open: false, port: 0, root });',
        'try {',
        "  const runtimeResponse = await fetch(new URL('/api/runtime/status', session.url));",
        "  const surfacesResponse = await fetch(new URL('/api/runtime/surfaces', session.url));",
        "  process.stdout.write(JSON.stringify({ diagnostics: validated.diagnostics, runtimeBody: await runtimeResponse.json(), runtimeStatus: runtimeResponse.status, status: session.status(), surfacesBody: await surfacesResponse.json(), surfacesStatus: surfacesResponse.status, targets: inspected.model.targets.map(({ name }) => name) }));",
        '} finally { await session.close(); }',
      ].join('\n');
      const result = JSON.parse((await execFile(process.execPath, ['--input-type=module', '--eval', script], { cwd: consumer, env: installedEnvironment() })).stdout) as Readonly<{
        readonly diagnostics: unknown;
        readonly runtimeBody: unknown;
        readonly runtimeStatus: number;
        readonly status: Readonly<Record<string, unknown>>;
        readonly surfacesBody: unknown;
        readonly surfacesStatus: number;
        readonly targets: readonly string[];
      }>;
      expect(result.targets).toEqual(['portable']);
      expect(result.diagnostics).toEqual([]);
      expect(result.status).not.toHaveProperty('runtime');
      expect(result.runtimeStatus).toBe(200);
      expect(result.runtimeBody).toEqual({ status: null });
      expect(result.surfacesStatus).toBe(200);
      expect(result.surfacesBody).toEqual({ surfaces: [] });
      expect(await namedFiles(consumer, '.runtime-provider-loaded')).toEqual([]);
      expect(await namedFiles(project, '.runtime-provider-loaded')).toEqual([]);
    } finally {
      await rm(consumer, { force: true, recursive: true });
    }
  }, 120_000);
});
