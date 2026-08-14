import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, inspect, listHooks, validate } from '../src/api.ts';

const createProject = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-api-parent-'));
  const root = join(parent, 'project with spaces');
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default ({ command, mode, projectRoot, selectedTargets }) => ({',
        "  plugin: { name: 'api-fixture', version: '1.0.0' },",
        '  targets: selectedTargets.length === 0 ? [\'codex\', \'claude\'] : selectedTargets,',
        "  hooks: { sessionStart: { handler: './src/hook.ts' } },",
        '  fixtureContext: { command, mode, projectRoot, selectedTargets },',
        '});',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
    writeFile(join(root, 'src', 'hook.ts'), 'export default () => undefined;\n'),
  ]);
  return root;
};

it('prepares a factory-configured project into a frozen inspection and build result', async () => {
  const root = await createProject();
  try {
    const inspection = await inspect({ root, targets: ['portable'] });

    expect(inspection.model).toMatchObject({
      metadata: { name: 'api-fixture' },
      targets: [{ name: 'portable' }],
    });
    expect(inspection.plans).toHaveLength(1);
    expect(Object.isFrozen(inspection.model)).toBe(true);

    const result = await build({ output: join(root, 'artifact'), root, targets: ['portable'] });
    expect(result).toMatchObject({
      build: { outputRoot: join(root, 'artifact') },
      model: { metadata: { name: 'api-fixture' } },
    });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('lists hooks across artifact targets and rejects an explicit unknown target', async () => {
  const root = await createProject();
  try {
    const artifact = join(root, 'artifact');
    await build({ output: artifact, root });

    await expect(listHooks({ artifact, root })).resolves.toMatchObject([
      { event: 'sessionStart', target: 'claude' },
      { event: 'sessionStart', target: 'codex' },
    ]);
    await expect(listHooks({ artifact, root, target: 'unsupported' })).rejects.toThrow('Unknown target');
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('validates an explicit artifact without loading its project source', async () => {
  const root = await createProject();
  try {
    const artifact = join(root, 'artifact');
    await build({ output: artifact, root });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'this source must not be loaded\n');

    const result = await validate({ artifact, root });

    expect(result).toEqual({ diagnostics: [] });
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);
