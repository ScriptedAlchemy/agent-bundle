import { execFile as executeFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { packageBinEntries } from '../src/core/package-dependencies.ts';
import { removeProjectSource } from '../src/test/packed.ts';
import { runBin } from './support/bin-process.ts';
import { within } from './support/eventually.ts';
import { packedNativeNodeCommand } from './support/packed-native-smoke.ts';
import {
  cachedNpmInstallArguments,
  installedEnvironment,
  packOutputFromJson,
  sharedPackedTarball,
} from './support/shared-pack.ts';
import { timeScale } from './support/time-scale.ts';

const execFile = promisify(executeFile);
const packageName = 'install-bin-fixture';
const binName = 'demo-install';
const agentBundleImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]agent-bundle(?:\/[^'"]*)?['"]/u;
const homeEnvKeys = new Set(['home', 'userprofile']);

let consumer = '';
let home = '';
let bin = '';
let childEnvironment: NodeJS.ProcessEnv = {};

interface Run {
  readonly code: number | null;
  readonly json: <T>() => T;
  readonly stderr: string;
  readonly stdout: string;
}

/** npm's JavaScript CLI, never the extensionless `.bin` shim or `npm.cmd`. */
const resolveNpmCli = (): string => {
  const fromEnv = process.env['npm_execpath'];
  if (fromEnv !== undefined && fromEnv.length > 0 && fromEnv.endsWith('npm-cli.js') && existsSync(fromEnv)) {
    return fromEnv;
  }
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(besideNode)) return besideNode;
  return createRequire(import.meta.url).resolve('npm/bin/npm-cli.js');
};

const runNodeEntrypoint = async (
  entrypoint: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly stdout: string }> => {
  const command = packedNativeNodeCommand(entrypoint, args);
  return execFile(command.executable, [...command.args], {
    cwd: options.cwd,
    env: options.env,
  });
};

const packageBinPath = async (packageRoot: string, name: string): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Readonly<Record<string, unknown>>;
  const entry = packageBinEntries(manifest).find(([bin]) => bin === name);
  if (entry === undefined) {
    throw new Error(`${packageRoot} package.json does not declare the ${name} bin.`);
  }
  return resolve(packageRoot, entry[1]);
};

/**
 * Isolates the installer's home. `os.homedir()` follows HOME on POSIX and
 * USERPROFILE on Windows; leftover `UserProfile` spellings must not win.
 */
const isolatedHomeEnvironment = (homeDirectory: string): NodeJS.ProcessEnv => {
  const isolated: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(installedEnvironment())) {
    if (homeEnvKeys.has(key.toLowerCase())) continue;
    isolated[key] = value;
  }
  isolated.HOME = homeDirectory;
  isolated.USERPROFILE = homeDirectory;
  return isolated;
};

/** Runs the installed bin from a directory that is neither the package nor the artifact, with an isolated home. */
const run = async (args: readonly string[]): Promise<Run> => {
  const child = runBin(bin, args, { cwd: consumer, env: childEnvironment });
  const { code } = await within(child.exit, 60_000 * timeScale);
  const stdout = child.stdout();
  return { code, json: <T>() => JSON.parse(stdout) as T, stderr: child.stderr(), stdout };
};

beforeAll(async () => {
  const { tarball: agentBundle } = await sharedPackedTarball('agent-bundle');
  consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-install-bin-'));
  home = join(consumer, 'home');
  childEnvironment = isolatedHomeEnvironment(home);
  const project = join(consumer, 'project');
  const npmCli = resolveNpmCli();
  const installEnv = installedEnvironment();
  await mkdir(join(project, 'src', 'skills', 'demo'), { recursive: true });
  await Promise.all([
    // Installers never create a Cursor home (AB7002); the fixture host has one.
    mkdir(join(home, '.cursor'), { recursive: true }),
    writeFile(join(project, 'package.json'), `${JSON.stringify({
      bin: { [binName]: `./dist/bin/${binName}.js` },
      name: packageName,
      private: true,
      type: 'module',
      version: '1.0.0',
    }, null, 2)}\n`),
    writeFile(join(project, 'agent-bundle.config.ts'), [
      'export default {',
      `  bin: { '${binName}': './src/install-bin.ts' },`,
      "  output: { distPath: 'artifact' },",
      `  plugin: { description: 'Installs itself through agent-bundle/install.', name: '${packageName}' },`,
      "  targets: ['cursor'],",
      '};',
      '',
    ].join('\n')),
    // The whole installer a consumer writes: the npm root is the artifact, so
    // the bin under `bin/` binds its parent directory and nothing is probed.
    writeFile(join(project, 'src', 'install-bin.ts'), [
      "import { fileURLToPath } from 'node:url';",
      '',
      "import { runInstallCli } from 'agent-bundle/install';",
      '',
      'export const main = (argv: readonly string[]): Promise<number> =>',
      `  runInstallCli(argv, { from: fileURLToPath(new URL('..', import.meta.url)), name: '${binName}' });`,
      '',
    ].join('\n')),
    writeFile(join(project, 'src', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A demo skill.\n---\n\nDemo.\n'),
    writeFile(join(project, 'README.md'), '# install-bin fixture\n'),
  ]);
  await runNodeEntrypoint(npmCli, ['install', '--save-dev', ...cachedNpmInstallArguments, agentBundle], {
    cwd: project,
    env: installEnv,
  });
  const frameworkRoot = join(project, 'node_modules', 'agent-bundle');
  const cli = await packageBinPath(frameworkRoot, 'agent-bundle');
  await runNodeEntrypoint(cli, ['prepack', '--root', project, '--output', 'artifact'], {
    cwd: project,
    env: installEnv,
  });

  const tarballs = join(consumer, 'tarballs');
  const installed = join(consumer, 'installed');
  await Promise.all([mkdir(tarballs), mkdir(installed)]);
  const { stdout: packJson } = await runNodeEntrypoint(
    npmCli,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs],
    { cwd: join(project, 'dist'), env: installEnv },
  );
  const packed = packOutputFromJson(packJson, packageName);
  expect(packed.files.map((file) => file.path)).toEqual(expect.arrayContaining([
    'agent-bundle.manifest.json',
    `bin/${binName}.js`,
  ]));
  await writeFile(join(installed, 'package.json'), '{"private":true}\n');
  await runNodeEntrypoint(npmCli, ['install', ...cachedNpmInstallArguments, join(tarballs, packed.filename)], {
    cwd: installed,
    env: installEnv,
  });
  bin = await packageBinPath(join(installed, 'node_modules', packageName), binName);
  // `os.homedir()` must resolve to the fixture before any install/doctor/uninstall.
  const { stdout: resolvedHome } = await execFile(
    process.execPath,
    ['--input-type=module', '--eval', "import { homedir } from 'node:os'; process.stdout.write(homedir());"],
    { cwd: consumer, env: childEnvironment },
  );
  expect(resolvedHome).toBe(home);
  // `packed-deleted-source`: the source project, its build, and its node_modules
  // (the only `agent-bundle` on disk) are gone before the bin runs.
  await removeProjectSource({ projectRoot: project });
  await rm(project, { force: true, recursive: true });
}, 300_000);

afterAll(async () => {
  if (consumer.length > 0) await rm(consumer, { force: true, recursive: true });
});

it('ships a self-contained installer bin that binds its own npm root', async () => {
  const source = await readFile(bin, 'utf8');
  expect(source).not.toMatch(agentBundleImport);
  expect(source).not.toContain('agent-bundle-src');
  await expect(access(join(consumer, 'installed', 'node_modules', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });

  const help = await run(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain(`Usage: ${binName}`);
  expect(help.stdout).not.toContain('--from');
  const rejected = await run(['install', 'cursor', '--from', consumer]);
  expect(rejected.code).toBe(2);
  expect(rejected.stderr).toContain("unknown option '--from'");
});

it('installs, reports, replaces, plans, and uninstalls through the framework lifecycle with receipts', async () => {
  const destination = join(home, '.cursor', 'plugins', 'local', packageName);
  const installedRoot = resolve(bin, '..', '..');

  const installed = await run(['install', 'cursor', '--json']);
  expect(installed.stderr).toBe('');
  expect(installed.code).toBe(0);
  expect(installed.json()).toMatchObject({
    bundleRoot: installedRoot,
    destination,
    host: 'cursor',
    plugin: packageName,
    receipt: join(destination, '.agent-bundle-install.json'),
    state: 'installed',
    version: '1.0.0',
  });
  await expect(readFile(join(destination, 'skills', 'demo', 'SKILL.md'), 'utf8')).resolves.toContain('Demo.');

  const again = await run(['install', 'cursor', '--json']);
  expect(again.code).toBe(0);
  expect(again.json()).toMatchObject({ state: 'already-installed' });

  // Same-version content drift in the installed copy is replaced, never adopted.
  await writeFile(join(destination, 'skills', 'demo', 'SKILL.md'), 'edited\n');
  const replaced = await run(['install', 'cursor', '--json']);
  expect(replaced.code).toBe(0);
  expect(replaced.json()).toMatchObject({ state: 'replaced' });
  await expect(readFile(join(destination, 'skills', 'demo', 'SKILL.md'), 'utf8')).resolves.toContain('Demo.');

  const doctor = await run(['doctor', '--host', 'cursor', '--json']);
  expect(doctor.code).toBe(0);
  expect(doctor.json<{ readonly hosts: readonly { readonly bundle?: { readonly comparison?: { readonly status: string } }; readonly host: string }[] }>().hosts)
    .toEqual([expect.objectContaining({ bundle: expect.objectContaining({ comparison: expect.objectContaining({ status: 'current' }) }), host: 'cursor' })]);

  const plan = await run(['uninstall', 'cursor', '--plan', '--json']);
  expect(plan.code).toBe(0);
  const planned = plan.json<{ readonly removed: { readonly files: readonly string[] }; readonly state: string }>();
  expect(planned.state).toBe('planned');
  expect(planned.removed.files).toContain(join(destination, 'skills', 'demo', 'SKILL.md'));
  await expect(access(destination)).resolves.toBeUndefined();

  const uninstalled = await run(['uninstall', 'cursor', '--json']);
  expect(uninstalled.code).toBe(0);
  expect(uninstalled.json()).toMatchObject({ state: 'uninstalled' });
  await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });

  const human = await run(['uninstall', 'cursor']);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain(`Not installed ${packageName}@1.0.0 for cursor`);
}, 120_000);
