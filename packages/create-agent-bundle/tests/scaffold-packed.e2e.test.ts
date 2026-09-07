import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, expect, it } from '@rstest/core';

import { openPackedMcpServer, removeProjectSource } from '../../agent-bundle/src/test/packed.ts';
import { installedEnvironment } from '../../agent-bundle/tests/support/shared-pack.ts';
import {
  cleanupScaffoldFixture,
  expectCleanValidate,
  installScaffoldedProject,
  npmRun,
  scaffoldProject,
  scaffoldProjectWithMismatchedRuntime,
  scaffoldReleasePairing,
} from './support/scaffold-fixture.ts';

afterAll(cleanupScaffoldFixture);

it('rejects a local framework tarball paired with an incompatible runtime version', async () => {
  const pairing = await scaffoldReleasePairing();
  await expect(scaffoldProjectWithMismatchedRuntime('mismatched-runtime-project')).rejects.toMatchObject({
    code: 2,
    stdout: expect.stringContaining(
      `expected agent-bundle ${pairing.framework} and @agent-bundle/runtime ${pairing.runtime}, `
      + `received agent-bundle ${pairing.framework} and @agent-bundle/runtime 999.0.0`,
    ),
  });
}, 600_000);

it('scaffolds with differently versioned release tarballs and runs after source deletion', async () => {
  const pairing = await scaffoldReleasePairing();
  expect(pairing.framework).not.toBe(pairing.runtime);

  const projectRoot = await scaffoldProject('mcp-server', 'paired-runtime-project', ['--no-install']);
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    readonly devDependencies: Record<string, string>;
  };
  expect(manifest.devDependencies['agent-bundle']?.endsWith(`agent-bundle-${pairing.framework}.tgz`)).toBe(true);
  expect(manifest.devDependencies['@agent-bundle/runtime']
    ?.endsWith(`agent-bundle-runtime-${pairing.runtime}.tgz`)).toBe(true);

  await installScaffoldedProject(projectRoot);
  await npmRun(projectRoot, 'build');

  const artifact = join(projectRoot, 'artifact');
  const mcp = JSON.parse(await readFile(join(artifact, 'mcp.json'), 'utf8')) as {
    readonly mcpServers: { readonly status: { readonly args: readonly [string, ...string[]] } };
  };
  const deletedSource = await removeProjectSource({ projectRoot });
  expect(deletedSource.removed).toEqual(['agent-bundle.config.ts', 'src']);
  const session = await openPackedMcpServer({
    cwd: projectRoot,
    deletedSource,
    entry: join(artifact, mcp.mcpServers.status.args[0]),
    env: Object.fromEntries(
      Object.entries(installedEnvironment()).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  try {
    await expect(session.client.callTool({
      arguments: { service: 'docs' },
      name: 'report-status',
    })).resolves.toMatchObject({
      structuredContent: { service: 'docs', status: 'healthy' },
    });
  } finally {
    await session.close();
  }
}, 600_000);

/**
 * The minimal-template smoke covers the scaffolder-driven install and full
 * project check. The release-boundary matrix runs every check for the routed
 * templates through `test:packed:release` and the nightly schedule.
 */
it('scaffolds the minimal template, auto-installs, and passes its own check', async () => {
  // No --no-install: this run covers the scaffolder-driven `npm install` path.
  const projectRoot = await scaffoldProject('minimal', 'minimal-project', []);

  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    readonly devDependencies: Record<string, string>;
    readonly name: string;
  };
  expect(manifest.name).toBe('minimal-project');
  expect(manifest.devDependencies['agent-bundle']).toMatch(/^file:.*\.tgz$/u);
  await expect(readFile(join(projectRoot, '.gitignore'), 'utf8')).resolves.toContain('node_modules/');

  await npmRun(projectRoot, 'check');
  await expectCleanValidate(projectRoot);
  await expect(readFile(join(projectRoot, 'artifact', 'skills', 'getting-started', 'SKILL.md'), 'utf8'))
    .resolves.toContain('# Getting started');
}, 600_000);
