import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import {
  EvalFixtureError,
  materializeEvalFixture,
  normalizeEvalCase,
  planEvalFixture,
  type EvalCase,
} from '../src/eval/index.ts';

const run = promisify(execFile);

const caseWith = (fixture: EvalCase['fixture'] | string): EvalCase => normalizeEvalCase({
  assertions: [{ expected: 0, id: 'ignored', kind: 'exit-code', minimumEvidence: 'observed' }],
  fixture,
  hosts: { claude: { model: 'claude-sonnet-4-5' } },
  id: 'case',
  invocation: { mode: 'automatic' },
  prompt: 'Do the task.',
});

const withProject = async (task: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle eval fixture '));
  try {
    await task(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const seedFixture = async (root: string): Promise<string> => {
  const source = join(root, 'fixtures', 'repo');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(join(source, 'README.md'), '# fixture\n');
  await writeFile(join(source, 'notes.txt'), 'excluded\n');
  return source;
};

it('records the fixture digest from the allowlisted file set before any trial begins', async () => {
  await withProject(async (root) => {
    const source = await seedFixture(root);
    const plan = await planEvalFixture({
      baseDir: root,
      fixture: caseWith({ git: false, include: ['README.md', 'src/**'], path: './fixtures/repo' }).fixture,
    });

    expect(plan.entries.map((entry) => entry.path)).toEqual(['README.md', 'src/index.ts']);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.sourcePath).toBe(source);

    await writeFile(join(source, 'notes.txt'), 'still excluded but different\n');
    const unchanged = await planEvalFixture({
      baseDir: root,
      fixture: caseWith({ git: false, include: ['README.md', 'src/**'], path: './fixtures/repo' }).fixture,
    });
    expect(unchanged.digest).toBe(plan.digest);

    await writeFile(join(source, 'README.md'), '# changed\n');
    const changed = await planEvalFixture({
      baseDir: root,
      fixture: caseWith({ git: false, include: ['README.md', 'src/**'], path: './fixtures/repo' }).fixture,
    });
    expect(changed.digest).not.toBe(plan.digest);
  });
});

it('gives every trial an equal fresh fixture that no other trial can mutate', async () => {
  await withProject(async (root) => {
    const source = await seedFixture(root);
    const plan = await planEvalFixture({ baseDir: root, fixture: caseWith('./fixtures/repo').fixture });

    const first = await materializeEvalFixture({ destination: join(root, 'trials', 'trial-1'), plan });
    const second = await materializeEvalFixture({ destination: join(root, 'trials', 'trial-2'), plan });

    expect(first.digest).toBe(plan.digest);
    expect(second.digest).toBe(plan.digest);
    expect(first.path).not.toBe(second.path);
    expect((await lstat(first.path)).isSymbolicLink()).toBe(false);

    await writeFile(join(first.path, 'src', 'index.ts'), 'export const value = 99;\n');
    await rm(join(first.path, 'README.md'));

    expect(await readFile(join(second.path, 'src', 'index.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect(await readFile(join(second.path, 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(await readFile(join(source, 'src', 'index.ts'), 'utf8')).toBe('export const value = 1;\n');
  });
});

it('preserves the executable bit and refuses an existing destination', async () => {
  await withProject(async (root) => {
    const source = await seedFixture(root);
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(source, 'run.sh'), 0o755);
    const plan = await planEvalFixture({ baseDir: root, fixture: caseWith('./fixtures/repo').fixture });

    const materialized = await materializeEvalFixture({ destination: join(root, 'trials', 'trial-1'), plan });
    expect((await lstat(join(materialized.path, 'run.sh'))).mode & 0o111).toBeGreaterThan(0);
    expect((await lstat(join(materialized.path, 'README.md'))).mode & 0o111).toBe(0);

    await expect(materializeEvalFixture({ destination: join(root, 'trials', 'trial-1'), plan }))
      .rejects.toThrow(EvalFixtureError);
  });
});

it('initializes a Git repository and baseline commit without copying an existing one', async () => {
  await withProject(async (root) => {
    const source = await seedFixture(root);
    await run('git', ['init', '--quiet'], { cwd: source });
    await writeFile(join(source, '.git', 'MARKER'), 'source repository\n');

    const plan = await planEvalFixture({
      baseDir: root,
      fixture: caseWith({ git: true, include: ['**'], path: './fixtures/repo' }).fixture,
    });
    expect(plan.entries.some((entry) => entry.path.startsWith('.git/'))).toBe(false);

    const materialized = await materializeEvalFixture({ destination: join(root, 'trials', 'trial-1'), plan });
    const log = await run('git', ['log', '--oneline'], { cwd: materialized.path });
    const status = await run('git', ['status', '--porcelain'], { cwd: materialized.path });

    expect(log.stdout.trim().split('\n')).toHaveLength(1);
    expect(status.stdout).toBe('');
    expect(await readdir(join(materialized.path, '.git'))).not.toContain('MARKER');
  });
});

it('rejects a symlinked fixture entry, a missing source, and an escaping fixture', async () => {
  await withProject(async (root) => {
    const source = await seedFixture(root);
    await symlink(join(source, 'README.md'), join(source, 'link.md'));

    await expect(planEvalFixture({ baseDir: root, fixture: caseWith('./fixtures/repo').fixture }))
      .rejects.toThrow(EvalFixtureError);
    await expect(planEvalFixture({ baseDir: root, fixture: caseWith('./fixtures/absent').fixture }))
      .rejects.toThrow(EvalFixtureError);
    await expect(planEvalFixture({
      baseDir: join(root, 'fixtures'),
      fixture: { git: false, include: ['**'], path: '../fixtures/repo' },
    })).rejects.toThrow(EvalFixtureError);
  });
});

it('refuses to materialize when the fixture source changed after the plan was recorded', async () => {
  await withProject(async (root) => {
    const source = await seedFixture(root);
    const plan = await planEvalFixture({ baseDir: root, fixture: caseWith('./fixtures/repo').fixture });

    await writeFile(join(source, 'README.md'), '# drifted\n');

    await expect(materializeEvalFixture({ destination: join(root, 'trials', 'trial-1'), plan }))
      .rejects.toThrow(/changed/iu);
  });
});
