import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

const skillPath = new URL('../skills/getting-started/SKILL.md', import.meta.url);

it('keeps the getting-started Skill frontmatter aligned with its directory', async () => {
  const contents = await readFile(skillPath, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(contents);
  expect(frontmatter).not.toBeNull();
  expect(frontmatter![1]).toContain('name: getting-started');
  expect(frontmatter![1]).toMatch(/description: \S/u);
  expect(contents).toContain('# Getting started');
});
