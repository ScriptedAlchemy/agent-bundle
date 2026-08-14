import { execFile as executeFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
let built: Promise<void> | undefined;

const buildPackage = async (force = false): Promise<void> => {
  if (force) {
    await execFile('npm', ['run', 'build'], { cwd: workspaceRoot });
    return;
  }
  built ??= execFile('npm', ['run', 'build'], { cwd: workspaceRoot }).then(() => undefined);
  await built;
};

describe.sequential('workbench package build', () => {
it('copies stable prebuilt workbench assets and Inspector notices into the package distribution', async () => {
  await buildPackage();

  await expect(access(join(packageRoot, 'dist', 'workbench', 'index.html'))).resolves.toBeUndefined();
  await expect(readFile(join(packageRoot, 'dist', 'workbench', 'static', 'js', 'index.js'), 'utf8')).resolves.toContain('Project overview');
  await expect(readFile(join(packageRoot, 'dist', 'workbench', 'THIRD_PARTY_NOTICES'), 'utf8')).resolves.toContain('MCP Inspector');
}, 60_000);

it('prunes stale copied workbench assets without removing the package library output', async () => {
  await buildPackage();
  const workbench = join(packageRoot, 'dist', 'workbench');
  const stale = join(workbench, 'static', 'js', 'async', 'stale-nested.js');
  await mkdir(join(workbench, 'static', 'js', 'async'), { recursive: true });
  await writeFile(stale, 'obsolete workbench output\n');
  await expect(access(stale)).resolves.toBeUndefined();

  await buildPackage(true);

  await expect(access(stale)).rejects.toThrow();
  await expect(access(join(packageRoot, 'dist', 'cli.js'))).resolves.toBeUndefined();
  expect(await readdir(workbench, { recursive: true })).not.toContain('index.js.map');
}, 60_000);

it('serves prebuilt workbench assets from an installed tarball without the repository source tree', async () => {
  await buildPackage();
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-consumer-'));
  const project = join(consumer, 'project');
  try {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', consumer], { cwd: packageRoot });
    const [packed] = JSON.parse(stdout) as Array<{ readonly filename: string }>;
    const tarball = join(consumer, packed.filename);
    const listing = await execFile('tar', ['-tf', tarball]);
    expect(listing.stdout).toContain('package/dist/workbench/index.html');
    expect(listing.stdout).toContain('package/dist/workbench/THIRD_PARTY_NOTICES');
    expect(listing.stdout).not.toMatch(/package\/dist\/workbench\/.*\.map$/mu);
    expect(listing.stdout).not.toMatch(/package\/dist\/workbench\/.*-[a-f0-9]{8,}/iu);

    await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer });
    await mkdir(join(project, 'skills', 'review'), { recursive: true });
    await Promise.all([
      writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(project, 'agent-bundle.config.ts'), "export default { plugin: { name: 'packed-workbench', version: '1.0.0' }, targets: ['portable'] };\n"),
      writeFile(join(project, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Reviews changes\n---\n# Review\n'),
    ]);

    const script = [
      "import { startDevServer } from 'agent-bundle';",
      `const session = await startDevServer({ open: false, root: ${JSON.stringify(project)} });`,
      'try {',
      '  const response = await fetch(session.url);',
      '  console.log(JSON.stringify({ body: await response.text(), status: response.status }));',
      '} finally { await session.close(); }',
    ].join('\n');
    const served = await execFile(process.execPath, ['--input-type=module', '--eval', script], { cwd: consumer });
    expect(JSON.parse(served.stdout)).toMatchObject({
      body: expect.stringContaining('Agent Bundle workbench'),
      status: 200,
    });
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 60_000);
});
