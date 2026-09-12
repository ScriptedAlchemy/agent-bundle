import { expect, it, rs } from '@rstest/core';

rs.mock('node:fs', { spy: true });

import * as nodeFs from 'node:fs';
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

it('bounds filesystem probes for deep missing payload paths', async () => {
  const root = await createProject();
  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const model = prepared.model;
    if (model === undefined) throw new Error('Expected a prepared model.');
    const realpath = rs.mocked(nodeFs.realpathSync);
    const lstat = rs.mocked(nodeFs.lstatSync);
    const probe = (depth: number): number => {
      realpath.mockClear();
      lstat.mockClear();
      const source = join(root, 'built', ...Array.from({ length: depth }, (_, index) => `seg${String(index)}`));
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
      return realpath.mock.calls.length + lstat.mock.calls.length;
    };
    const depth6 = probe(6);
    const depth14 = probe(14);
    expect(depth6).toBeGreaterThan(0);
    expect(depth14).toBeLessThan(200);
    expect(depth14).toBeLessThan(depth6 * 4);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
