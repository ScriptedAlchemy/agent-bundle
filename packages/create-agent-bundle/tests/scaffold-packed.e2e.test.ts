import { access, readFile, rm, writeFile } from 'node:fs/promises';
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
  scaffoldProjectFromReleasePairing,
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

it('uses the packed release pair when no framework override is passed', async () => {
  const pairing = await scaffoldReleasePairing();
  const projectRoot = await scaffoldProjectFromReleasePairing('mcp-server', 'registry-pair-project');
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    readonly devDependencies: Record<string, string>;
  };
  expect(manifest.devDependencies).toMatchObject({
    '@agent-bundle/runtime': pairing.runtime,
    'agent-bundle': pairing.framework,
  });
}, 600_000);

it('scaffolds with independently versioned release tarballs and runs after source deletion', async () => {
  const pairing = await scaffoldReleasePairing();
  const projectRoot = await scaffoldProject('mcp-server', 'paired-runtime-project', ['--no-install']);
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    readonly devDependencies: Record<string, string>;
  };
  expect(manifest.devDependencies['agent-bundle']?.endsWith(`agent-bundle-${pairing.framework}.tgz`)).toBe(true);
  expect(manifest.devDependencies['@agent-bundle/runtime']
    ?.endsWith(`agent-bundle-runtime-${pairing.runtime}.tgz`)).toBe(true);

  await installScaffoldedProject(projectRoot);

  // `typecheck` on a clean checkout (#748): nothing has published the
  // generated declaration yet, the script's `validate` step publishes it, and
  // the program then consumes the registration — a wrong tool id is a compile
  // error, not a `string` that type-checks.
  const routeTypes = join(projectRoot, '.agent-bundle', 'routes.d.ts');
  await expect(access(routeTypes)).rejects.toMatchObject({ code: 'ENOENT' });
  await npmRun(projectRoot, 'typecheck');
  await expect(readFile(routeTypes, 'utf8')).resolves.toContain('"tool:status/report-status"');
  const wrongId = join(projectRoot, 'tests', 'route-unit', 'wrong-id.test.ts');
  await writeFile(wrongId, [
    "import { renderRoute } from 'agent-bundle/test';",
    "void renderRoute('tool:status/does-not-exist', { input: {} });",
    '',
  ].join('\n'));
  await expect(npmRun(projectRoot, 'typecheck')).rejects.toMatchObject({
    stdout: expect.stringContaining("'\"tool:status/does-not-exist\"' is not assignable"),
  });
  await rm(wrongId);

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
  // `amp` is here because project creation only started offering it in #745: a
  // target the scaffolder accepts has to survive the packed build too.
  const projectRoot = await scaffoldProject('minimal', 'minimal-project', ['--targets', 'portable,amp']);

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
  await expect(readFile(
    join(projectRoot, 'artifact', '.amp', 'plugins', 'minimal-project', 'skills', 'getting-started', 'SKILL.md'),
    'utf8',
  )).resolves.toContain('# Getting started');
}, 600_000);
