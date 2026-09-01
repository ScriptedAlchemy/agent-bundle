import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, expect, it } from '@rstest/core';

import {
  cleanupScaffoldFixture,
  expectCleanValidate,
  npmRun,
  scaffoldProject,
  scaffoldProjectWithMismatchedRuntime,
} from './support/scaffold-fixture.ts';

afterAll(cleanupScaffoldFixture);

it('rejects a local framework tarball paired with the wrong runtime package', async () => {
  await expect(scaffoldProjectWithMismatchedRuntime('mismatched-runtime-project')).rejects.toMatchObject({ code: 2 });
}, 600_000);

/**
 * Per-PR scaffolder smoke: one template through the full consumer journey —
 * installed scaffolder bin, template scaffold, scaffolder-driven npm install,
 * project check, clean validate. The mcp-server and cli-tool templates run in
 * the release-boundary matrix (scaffold-packed-matrix.e2e.test.ts) via
 * `test:packed:release` and the nightly schedule.
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
  await expect(readFile(join(projectRoot, 'artifact', 'portable', 'skills', 'getting-started', 'SKILL.md'), 'utf8'))
    .resolves.toContain('# Getting started');
}, 600_000);
