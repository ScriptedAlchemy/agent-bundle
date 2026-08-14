import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

it('normalizes named top-level scripts with stable IDs, modes, and sorted targets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-scripts-parent-'));
  const root = join(parent, 'project with spaces');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'script-fixture', version: '1.0.0' },",
        "  targets: ['codex', 'claude'],",
        '  scripts: {',
        "    bundle: { entry: './src/bundle.ts', targets: ['codex', 'claude'] },",
        "    shell: './src/run.sh',",
        "    python: './src/run.py',",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'bundle.ts'), "export const value = 'bundled';\n"),
    writeFile(join(root, 'src', 'run.sh'), '#!/usr/bin/env sh\nprintf shell\\n'),
    writeFile(join(root, 'src', 'run.py'), '#!/usr/bin/env python3\nprint("python")\n'),
  ]);

  try {
    const result = await inspect({ root });

    expect(result.model.scripts).toEqual([
      {
        id: 'script:bundle',
        mode: 'bundle',
        name: 'bundle',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'bundle.ts'),
        targets: ['claude', 'codex'],
      },
      {
        id: 'script:python',
        mode: 'copy',
        name: 'python',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'run.py'),
        targets: ['claude', 'codex'],
      },
      {
        id: 'script:shell',
        mode: 'copy',
        name: 'shell',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'run.sh'),
        targets: ['claude', 'codex'],
      },
    ]);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('copies named shell and Python scripts byte-for-byte with source modes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-copy-scripts-parent-'));
  const root = join(parent, 'project with spaces');
  const sourceShell = join(root, 'src', 'run.sh');
  const sourcePython = join(root, 'src', 'run.py');
  const output = join(root, 'artifact');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'copy-script-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '  scripts: {',
        "    shell: './src/run.sh',",
        "    python: './src/run.py',",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(sourceShell, '#!/usr/bin/env sh\nprintf "shell\\n"\r\n'),
    writeFile(sourcePython, '#!/usr/bin/env python3\r\nprint("python")\r\n'),
  ]);
  await Promise.all([chmod(sourceShell, 0o751), chmod(sourcePython, 0o711)]);

  try {
    await build({ output, root });

    const checks = await Promise.all([
      [sourceShell, join(output, 'portable', 'scripts', 'shell.sh')],
      [sourcePython, join(output, 'portable', 'scripts', 'python.py')],
    ].map(async ([source, generated]) => {
      const [sourceContents, generatedContents, sourceMetadata, generatedMetadata] = await Promise.all([
        readFile(source!),
        readFile(generated!),
        stat(source!),
        stat(generated!),
      ]);
      return {
        generatedContents,
        generatedMode: generatedMetadata.mode & 0o777,
        sourceContents,
        sourceMode: sourceMetadata.mode & 0o777,
      };
    }));

    for (const check of checks) {
      expect(check.generatedContents).toEqual(check.sourceContents);
      expect(check.generatedMode).toBe(check.sourceMode);
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 30_000);

it('rejects unsafe, unsupported, missing, non-file, and unknown-target named scripts', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-invalid-scripts-parent-'));
  const root = join(parent, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'invalid-script-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '  scripts: {',
        "    '../unsafe': './src/run.sh',",
        "    unsupported: './src/run.txt',",
        "    missing: './src/missing.ts',",
        "    directory: './src',",
        "    outside: '../outside.ts',",
        "    target: { entry: './src/run.sh', targets: ['unknown'] },",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'run.sh'), '#!/usr/bin/env sh\n'),
    writeFile(join(root, 'src', 'run.txt'), 'unsupported\n'),
    writeFile(join(parent, 'outside.ts'), 'export {};\n'),
  ]);

  try {
    const result = await validate({ root });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'AB4401',
      'AB4403',
      'AB4404',
      'AB4405',
      'AB4406',
    ]));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

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
