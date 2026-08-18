import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expect, it } from '@rstest/core';

import { workspaceDiff } from '../src/eval/workspace-diff.ts';

it('reports bounded relative workspace changes by opaque identity and digest without file contents or absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workspace-diff-'));
  try {
    await writeFile(join(root, 'known.txt'), 'changed');
    await writeFile(join(root, 'new.txt'), 'new');
    const diff = await workspaceDiff({
      plan: Object.freeze({
        digest: 'fixture-digest',
        entries: Object.freeze([Object.freeze({ executable: false, path: 'known.txt', sha256: 'expected-digest' })]),
        git: false,
        sourcePath: '/private/source-fixture',
      }),
      workspace: root,
    });
    expect(diff).toMatchObject({ changes: [
      { kind: 'modified' },
      { kind: 'added' },
    ] });
    expect(JSON.stringify(diff)).not.toContain(root);
    expect(JSON.stringify(diff)).not.toContain('/private/source-fixture');
    expect(JSON.stringify(diff)).not.toContain('changed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('marks an oversized diff as truncated instead of expanding unbounded native workspace evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workspace-diff-'));
  try {
    await Promise.all(Array.from({ length: 5 }, async (_value, index) => {
      await writeFile(join(root, `change-${index}.txt`), `${index}`);
    }));
    await expect(workspaceDiff({
      limit: 2,
      plan: Object.freeze({ digest: 'fixture-digest', entries: Object.freeze([]), git: false, sourcePath: '/private/source-fixture' }),
      workspace: root,
    })).resolves.toMatchObject({ changes: expect.any(Array), truncated: true });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('bounds workspace traversal and file bytes before producing native evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workspace-diff-'));
  try {
    await Promise.all([
      writeFile(join(root, 'a.txt'), 'four'),
      writeFile(join(root, 'b.txt'), 'five!'),
      writeFile(join(root, 'c.txt'), 'sixsix'),
    ]);
    const plan = Object.freeze({
      digest: 'fixture-digest',
      entries: Object.freeze([]),
      git: false,
      sourcePath: '/private/source-fixture',
    });

    await expect(workspaceDiff({ fileByteLimit: 4, plan, scanLimit: 3, totalByteLimit: 12, workspace: root }))
      .resolves.toMatchObject({ changes: [{ kind: 'added' }], truncated: true });
    await expect(workspaceDiff({ fileByteLimit: 8, plan, scanLimit: 2, totalByteLimit: 16, workspace: root }))
      .resolves.toMatchObject({ changes: expect.any(Array), truncated: true });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('charges every visited empty directory against the native workspace traversal budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workspace-diff-'));
  try {
    await mkdir(join(root, 'first', 'second'), { recursive: true });

    await expect(workspaceDiff({
      plan: Object.freeze({ digest: 'fixture-digest', entries: Object.freeze([]), git: false, sourcePath: '/private/source-fixture' }),
      scanLimit: 1,
      workspace: root,
    })).resolves.toEqual(Object.freeze({ changes: Object.freeze([]), truncated: true }));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
