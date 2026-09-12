import { expect, it } from '@rstest/core';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProjectContext, ProjectService } from '../src/dev/index.ts';

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-walk-bound-'));
  await mkdir(join(root, 'src', 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'dev-service-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'skills', 'review', 'SKILL.md'), [
      '---',
      'name: review',
      'description: Reviews changes',
      '---',
      'Review the changed files.',
      '',
    ].join('\n')),
  ]);
  return root;
};

it('accepts a deep missing payload path without overflowing the walk', async () => {
  const root = await createProject();
  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const model = prepared.model;
    if (model === undefined) throw new Error('Expected a prepared model.');
    const source = join(
      root,
      'built',
      ...Array.from({ length: 80 }, (_, index) => `seg${String(index)}`),
    );
    const context = createProjectContext({
      configPath: prepared.configPath,
      model: {
        ...model,
        payloads: [{
          files: [],
          id: 'payload:runtime',
          name: 'runtime',
          provenance: model.metadata.provenance,
          runtimeDependencies: [],
          source,
          targets: ['portable'],
        }],
      },
      root,
      sourceInputs: prepared.projectContext?.sourceInputs ?? [],
    });
    expect(context.modelDigest).toEqual(expect.any(String));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
