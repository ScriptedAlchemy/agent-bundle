import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { DevCoordinator, ProjectService } from '../src/dev/index.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

/**
 * End-to-end dev-watch parity for the package build (RFC #50 §3.5): a real
 * DevCoordinator rebuild pass — real project service, artifact service, and
 * package build — writes `dist/` bin outputs, skips the package build when
 * no tracked input changed, and rebuilds it when the bin entry changes.
 */
it('rebuilds the package build inside the dev loop when its entries change', async () => {
  const fixture = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'dev-package-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"type":"module"}\n',
      'src/cli.ts': 'export const main = async () => 0;\n',
    },
    prefix: 'agent-bundle-dev-package-',
  });
  const root = fixture.root;
  const binOutput = join(root, 'dist', 'bin', 'dev-package-fixture.js');
  const coordinator = new DevCoordinator({
    projectService: new ProjectService({ root }),
    root,
  });

  try {
    await coordinator.start();
    expect(coordinator.status().build).toMatchObject({ state: 'idle' });
    expect(coordinator.status().build.lastAttempt).toMatchObject({ outcome: 'succeeded' });

    const initial = await readFile(binOutput, 'utf8');
    expect(initial.startsWith('#!/usr/bin/env node')).toBe(true);
    const initialStat = await stat(binOutput);

    // An untracked change rebuilds the artifact but skips the package build.
    await writeFile(join(root, 'notes.md'), 'untracked change\n');
    const skipped = await coordinator.rebuild({
      occurredAt: new Date().toISOString(),
      paths: ['notes.md'],
      reason: 'source-change',
    });
    expect(skipped.outcome).toBe('succeeded');
    expect((await stat(binOutput)).mtimeMs).toBe(initialStat.mtimeMs);

    // Changing the bin entry rebuilds the published dist output.
    await writeFile(
      join(root, 'src', 'cli.ts'),
      "export const main = async () => { console.error('rebuilt-marker'); return 0; };\n",
    );
    const rebuilt = await coordinator.rebuild({
      occurredAt: new Date().toISOString(),
      paths: ['src/cli.ts'],
      reason: 'source-change',
    });
    expect(rebuilt.outcome).toBe('succeeded');
    expect(await readFile(binOutput, 'utf8')).toContain('rebuilt-marker');

    // Removing the last package entry removes the outputs this session published.
    await rm(join(root, 'src', 'cli.ts'));
    const removed = await coordinator.rebuild({
      occurredAt: new Date().toISOString(),
      paths: ['src/cli.ts'],
      reason: 'source-change',
    });
    expect(removed.outcome).toBe('succeeded');
    expect(existsSync(binOutput)).toBe(false);
  } finally {
    await coordinator.close();
    await removeProjectFixture(root);
  }
}, 120_000);
