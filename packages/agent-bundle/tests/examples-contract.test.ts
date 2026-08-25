import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, inspect, validate } from '../src/api.ts';

const examplesRoot = join(process.cwd(), 'examples');

it('builds the Skills Starter through public Agent Bundle APIs', async () => {
  const root = join(examplesRoot, 'skills-starter');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });

  try {
    await expect(inspect({ root })).resolves.toMatchObject({
      model: {
        metadata: { name: 'skills-starter' },
        scripts: [],
        targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
      },
      state: 'ready',
    });
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(readFile(join(output, 'portable', 'skills', 'release-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Release review');
    await expect(readFile(join(
      output,
      'portable',
      'skills',
      'release-review',
      'references',
      'checklist.md',
    ), 'utf8')).resolves.toContain('Confirm the release artifact');
    await expect(readFile(join(
      output,
      'portable',
      'skills',
      'release-review',
      'assets',
      'report-template.md',
    ), 'utf8')).resolves.toContain('# Release report');
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
