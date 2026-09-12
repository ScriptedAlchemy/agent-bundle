import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';

const mutateStageEnv = 'AB7101_MUTATE_STAGE';

const originalEchoer = [
  'export default () => ({',
  '  close() {},',
  '  async connect(transport: { onmessage?: unknown }) { void transport; },',
  '});',
  '',
].join('\n');

const changedEchoer = [
  'export default () => ({',
  '  close() {},',
  '  async connect(transport: { onmessage?: unknown }) { void transport; },',
  "  changed: true,",
  '});',
  '',
].join('\n');

const treeDigest = async (root: string, prefix = ''): Promise<readonly string[]> => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await treeDigest(root, path));
      continue;
    }
    if (!entry.isFile()) continue;
    const absolute = join(root, prefix, entry.name);
    const [contents, metadata] = await Promise.all([readFile(absolute), stat(absolute)]);
    files.push([
      path,
      String(contents.byteLength),
      String(metadata.mode & 0o777),
      createHash('sha256').update(contents).digest('hex'),
    ].join('\t'));
  }
  return files;
};

const compilerOwnedTempEntries = async (root: string): Promise<readonly string[]> =>
  (await readdir(root)).filter((entry) =>
    /^\.(?:artifact|dist)\.(?:stage|compile)-/u.test(entry));

const publicationConfig = (includeLibrary: boolean): string => `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default ({ projectRoot }) => ({
  plugin: { name: 'ab7101-publication-fixture', version: '1.0.0' },
  targets: ['portable'],
  mcp: { servers: { echoer: {} } },
  ${includeLibrary ? "lib: { dts: false, entry: './src/library.ts' }," : ''}
  tools: {
    rspack(config) {
      const plugins = Array.isArray(config.plugins) ? [...config.plugins] : [];
      plugins.push({
        apply(compiler) {
          compiler.hooks.beforeCompile.tapPromise('ab7101-source-race', async () => {
            const stage = process.env.${mutateStageEnv};
            const outputPath = String(compiler.outputPath ?? '').replaceAll('\\\\', '/');
            if (stage === 'artifact' && outputPath.includes('.stage-')) {
              await writeFile(join(projectRoot, 'src/mcp/echoer.ts'), ${JSON.stringify(changedEchoer)});
            }
            if (stage === 'package' && outputPath.includes('.compile-')) {
              await writeFile(join(projectRoot, 'src/library.ts'), 'export const value = 2;\\n');
            }
          });
        },
      });
      config.plugins = plugins;
    },
  },
});
`;

const writePublicationProject = async (options: {
  readonly includeLibrary?: boolean;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-build-source-publication-'));
  await mkdir(join(root, 'src', 'skills', 'review'), { recursive: true });
  await mkdir(join(root, 'src', 'mcp'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'ab7101-publication-fixture',
      type: 'module',
      version: '1.0.0',
    })}\n`),
    writeFile(join(root, 'agent-bundle.config.ts'), publicationConfig(options.includeLibrary === true)),
    writeFile(join(root, 'src', 'mcp', 'echoer.ts'), originalEchoer),
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
    ...(options.includeLibrary === true
      ? [writeFile(join(root, 'src', 'library.ts'), 'export const value = 1;\n')]
      : []),
  ]);
  return root;
};

const expectAb7101 = (error: unknown): void => {
  expect(error).toBeInstanceOf(DiagnosticError);
  expect(error).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB7101',
      message: 'Project source changed while the artifact was compiling; publication was rejected.',
    })],
  });
};

it('rejects a first artifact build with AB7101 before publishing any output', async () => {
  const root = await writePublicationProject({});
  const output = join(root, 'artifact');
  process.env[mutateStageEnv] = 'artifact';
  try {
    const failure: unknown = await build({ output, root }).then(() => undefined, (error: unknown) => error);
    expectAb7101(failure);
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await compilerOwnedTempEntries(root)).toEqual([]);
    expect(await readFile(join(root, 'src', 'mcp', 'echoer.ts'), 'utf8')).toBe(changedEchoer);
  } finally {
    delete process.env[mutateStageEnv];
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it('rejects a later artifact build with AB7101 and leaves the previous artifact byte-identical', async () => {
  const root = await writePublicationProject({});
  const output = join(root, 'artifact');
  try {
    await build({ output, root });
    const previous = await treeDigest(output);

    process.env[mutateStageEnv] = 'artifact';
    const failure: unknown = await build({ output, root }).then(() => undefined, (error: unknown) => error);
    expectAb7101(failure);
    expect(await treeDigest(output)).toEqual(previous);
    expect(await compilerOwnedTempEntries(root)).toEqual([]);
  } finally {
    delete process.env[mutateStageEnv];
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it('rejects a package-stage race with AB7101 before replacing the previous package output', async () => {
  const root = await writePublicationProject({ includeLibrary: true });
  const artifact = join(root, 'artifact');
  const packageOutput = join(root, 'dist');
  try {
    await build({ output: artifact, packageOutputs: true, root });
    const previousPackage = await treeDigest(packageOutput);

    process.env[mutateStageEnv] = 'package';
    const failure: unknown = await build({ output: artifact, packageOutputs: true, root })
      .then(() => undefined, (error: unknown) => error);
    expectAb7101(failure);
    expect(await treeDigest(packageOutput)).toEqual(previousPackage);
    expect(await compilerOwnedTempEntries(root)).toEqual([]);
    expect(await readFile(join(root, 'src', 'library.ts'), 'utf8')).toBe('export const value = 2;\n');
  } finally {
    delete process.env[mutateStageEnv];
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
