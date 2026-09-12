import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, type BuildResult } from '../src/api.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-build-source-publication-'));
  await mkdir(join(root, 'src', 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'build-source-publication-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Reviews changes',
        '---',
        'Review the changed files.',
        '',
      ].join('\n'),
    ),
  ]);
  return root;
};

const stubCompile = async (): Promise<BuildResult> => ({
  diagnostics: [],
} as unknown as BuildResult);

it('rejects public build() with AB7101 when source changes after prepare during compile', async () => {
  const root = await createProject();
  try {
    const failure: unknown = await build({
      compile: async () => {
        await writeFile(join(root, 'src', 'skills', 'review', 'SKILL.md'), [
          '---',
          'name: review',
          'description: Reviews changed source',
          '---',
          'Review the changed files.',
          '',
        ].join('\n'));
        return stubCompile();
      },
      output: join(root, 'artifact'),
      root,
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DiagnosticError);
    expect(failure).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7101',
        message: 'Project source changed while the artifact was compiling; publication was rejected.',
      })],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('accepts public build() when compilation leaves prepared source inputs unchanged', async () => {
  const root = await createProject();
  try {
    const result = await build({
      compile: stubCompile,
      output: join(root, 'artifact'),
      root,
    });
    expect(result.build).toMatchObject({ diagnostics: [] });
    expect(result.projectContext.sourceInputs.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
