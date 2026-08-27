import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
