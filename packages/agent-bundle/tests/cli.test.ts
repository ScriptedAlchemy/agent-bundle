import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');
const cliPath = join(packageRoot, 'dist/cli.js');
let buildPackage: Promise<void> | undefined;

const buildCliPackage = async (): Promise<void> => {
  buildPackage ??= execFile('npm', ['run', 'build'], { cwd: workspaceRoot }).then(() => undefined);
  await buildPackage;
};

const runCli = async (root: string, args: readonly string[]) => {
  try {
    const result = await execFile(process.execPath, [cliPath, ...args], { cwd: root });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = error as Error & { readonly code?: number; readonly stderr?: string; readonly stdout?: string };
    return {
      code: failure.code ?? 1,
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
    };
  }
};

const createCliProject = async (): Promise<{ readonly output: string; readonly root: string }> => {
  const parent = await mkdtemp(join(tmpdir(), 'agent bundle cli parent-'));
  const root = join(parent, 'project with spaces');
  const output = join(root, 'artifact with spaces');
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default ({ command, mode, projectRoot, selectedTargets }) => ({',
        "  plugin: { name: 'cli-fixture', version: '1.0.0' },",
        '  targets: selectedTargets.length === 0 ? [\'portable\'] : selectedTargets,',
        '  fixtureContext: { command, mode, projectRoot, selectedTargets },',
        '});',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
  ]);
  return { output, root };
};

it('builds a selected target through the built executable from a path containing spaces', async () => {
  await buildCliPackage();
  const project = await createCliProject();
  try {
    const { stdout, stderr } = await execFile(process.execPath, [
      cliPath,
      'build',
      '--root', project.root,
      '--output', project.output,
      '--target', 'portable',
      '--json',
    ], { cwd: project.root });

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      build: { outputRoot: resolve(project.output) },
      model: { metadata: { name: 'cli-fixture' }, targets: [{ name: 'portable' }] },
    });
    expect(JSON.parse(await readFile(join(project.output, 'agent-bundle.manifest.json'), 'utf8'))).toMatchObject({
      targets: ['portable'],
    });
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('keeps inspect JSON stable and validates only the supplied artifact', async () => {
  await buildCliPackage();
  const project = await createCliProject();
  try {
    const inspectArgs = ['inspect', '--root', project.root, '--json'];
    const [firstInspection, secondInspection] = await Promise.all([
      runCli(project.root, inspectArgs),
      runCli(project.root, inspectArgs),
    ]);
    expect(firstInspection).toEqual(secondInspection);
    expect(firstInspection).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(firstInspection.stdout)).toMatchObject({
      model: { metadata: { name: 'cli-fixture' } },
      plans: [{ target: 'portable' }],
    });

    const built = await runCli(project.root, [
      'build', '--root', project.root, '--output', project.output, '--json',
    ]);
    expect(built).toMatchObject({ code: 0, stderr: '' });

    await writeFile(join(project.root, 'agent-bundle.config.ts'), 'this source must not be loaded\n');
    const artifactValidation = await runCli(project.root, [
      'validate', '--root', project.root, '--artifact', project.output, '--json',
    ]);
    expect(artifactValidation).toEqual({
      code: 0,
      stderr: '',
      stdout: '{"diagnostics":[]}\n',
    });

    const humanValidation = await runCli(project.root, [
      'validate', '--root', project.root, '--artifact', project.output,
    ]);
    expect(humanValidation).toEqual({ code: 0, stderr: '', stdout: 'Validation succeeded\n' });
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('reports source validation diagnostics on stderr before staging an artifact', async () => {
  await buildCliPackage();
  const project = await createCliProject();
  const output = join(project.root, 'must remain untouched');
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'sentinel.txt'), 'keep\n');
    await writeFile(
      join(project.root, 'agent-bundle.config.ts'),
      "export default { plugin: { version: '1.0.0' } };\n",
    );

    const result = await runCli(project.root, [
      'build', '--root', project.root, '--output', output, '--json',
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject([{ code: 'AB4000', severity: 'error' }]);
    expect(await readFile(join(output, 'sentinel.txt'), 'utf8')).toBe('keep\n');
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000);
