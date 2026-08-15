import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

it('returns an output-independent project context without absolute project paths', async () => {
  const [leftRoot, rightRoot] = await Promise.all([createProject(), createProject()]);
  try {
    const [left, right] = await Promise.all([
      build({ output: join(leftRoot, 'custom-artifact'), root: leftRoot, targets: ['portable'] }),
      build({ output: join(rightRoot, 'another-artifact'), root: rightRoot, targets: ['portable'] }),
    ]);

    expect(left.projectContext).toEqual(right.projectContext);
    expect(Object.keys(left.projectContext)).toEqual([
      'configDigest',
      'configPath',
      'modelDigest',
      'revision',
      'sourceInputs',
    ]);
    expect(JSON.stringify(left.projectContext)).not.toContain(leftRoot);
    expect(JSON.stringify(right.projectContext)).not.toContain(rightRoot);
    expect(JSON.stringify(left.projectContext)).not.toContain('custom-artifact');
    expect(JSON.stringify(right.projectContext)).not.toContain('another-artifact');
    expect(Object.isFrozen(left.projectContext)).toBe(true);
  } finally {
    await Promise.all([
      rm(join(leftRoot, '..'), { force: true, recursive: true }),
      rm(join(rightRoot, '..'), { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('rejects an output beneath an escaping symlink before loading source or writing outside the project', async () => {
  const root = await createProject();
  const external = join(root, '..', 'external-output');
  const marker = join(external, 'config-evaluated.txt');
  try {
    await mkdir(external, { recursive: true });
    await symlink(external, join(root, 'escape'), 'dir');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'evaluated\\n');`,
      'export default {',
      "  plugin: { name: 'escaping-output', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));

    await expect(build({ output: 'escape/artifact', root })).rejects.toThrow(/outside project root/i);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(external, 'artifact'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('rejects a dangling output symlink before loading source', async () => {
  const root = await createProject();
  const marker = join(root, '..', 'config-evaluated.txt');
  try {
    await symlink(join(root, '..', 'missing-output', 'artifact'), join(root, 'escape'), 'dir');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'evaluated\\n');`,
      'export default {',
      "  plugin: { name: 'dangling-output', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));

    await expect(build({ output: 'escape/artifact', root })).rejects.toThrow(/output root|symlink/i);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('rejects an output symlink to the project root before loading source', async () => {
  const root = await createProject();
  const marker = join(root, '..', 'config-evaluated.txt');
  try {
    await symlink(root, join(root, 'alias'), 'dir');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'evaluated\\n');`,
      'export default {',
      "  plugin: { name: 'root-output', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));

    await expect(build({ output: 'alias', root })).rejects.toThrow(/project root/i);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('excludes a contained symlinked output tree from project context identity', async () => {
  const [leftRoot, rightRoot] = await Promise.all([createProject(), createProject()]);
  try {
    const fixtures = [
      { bytes: 'first generated output\n', root: leftRoot },
      { bytes: 'second generated output\n', root: rightRoot },
    ];
    await Promise.all(fixtures.map(async ({ bytes, root }) => {
      const actual = join(root, 'actual-output');
      await mkdir(join(actual, 'artifact'), { recursive: true });
      await Promise.all([
        symlink(actual, join(root, 'output-alias'), 'dir'),
        writeFile(join(actual, 'artifact', 'generated.js'), bytes),
      ]);
    }));

    const [left, right] = await Promise.all([
      build({ output: 'output-alias/artifact', root: leftRoot, targets: ['portable'] }),
      build({ output: 'output-alias/artifact', root: rightRoot, targets: ['portable'] }),
    ]);

    expect(left.projectContext).toEqual(right.projectContext);
    expect(left.projectContext.sourceInputs.map((input) => input.path)).not.toContain(
      'actual-output/artifact/generated.js',
    );
    expect(JSON.stringify(left.projectContext)).not.toContain('actual-output');
    expect(JSON.stringify(right.projectContext)).not.toContain('actual-output');
  } finally {
    await Promise.all([
      rm(join(leftRoot, '..'), { force: true, recursive: true }),
      rm(join(rightRoot, '..'), { force: true, recursive: true }),
    ]);
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

    const manifest = JSON.parse(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly { readonly mode?: number; readonly path: string }[];
    };
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 0o751, path: 'portable/scripts/shell.sh' }),
      expect.objectContaining({ mode: 0o711, path: 'portable/scripts/python.py' }),
    ]));
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });

    await chmod(join(output, 'portable', 'scripts', 'shell.sh'), 0o644);
    await expect(validate({ artifact: output, root })).resolves.toMatchObject({
      diagnostics: [{ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }],
    });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 30_000);

it('documents a versioned MCP App resource URI accepted by source validation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-readme-uri-parent-'));
  const root = join(parent, 'project');
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
  const resourceUri = /resourceUri: '([^']+)'/u.exec(readme)?.[1];
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'views'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'readme-uri-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '  mcp: { servers: { local: {',
        "    entry: './src/server.ts',",
        `    apps: { dashboard: { entry: './views/dashboard.ts', resourceUri: ${JSON.stringify(resourceUri)} } },`,
        '  } } },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'server.ts'), 'export {}\n'),
    writeFile(join(root, 'views', 'dashboard.ts'), 'export {}\n'),
  ]);

  try {
    const result = await validate({ root });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('AB4329');
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

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
