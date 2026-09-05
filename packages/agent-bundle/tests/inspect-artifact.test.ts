import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  artifactManifestName,
  assembleArtifactManifest,
  parseArtifactManifest,
} from '../src/build/manifest.ts';
import { runCli as runSourceCli } from '../src/cli.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';

const runSourceCliWithOutput = async (
  args: string[],
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> => {
  const terminal = captureCliTerminal();
  const code = await runSourceCli(args, terminal.output);
  return { code, stderr: terminal.stderr(), stdout: terminal.stdout() };
};

const writeCursorArtifactRoot = async (root: string): Promise<void> => {
  await mkdir(join(root, '.cursor-plugin'), { recursive: true });
  await writeFile(join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo',
    version: '1.0.0',
  }));
  await mkdir(join(root, 'native'), { recursive: true });
  await writeFile(join(root, 'native', 'addon.node'), 'native');
  await mkdir(join(root, 'tools'), { recursive: true });
  await writeFile(join(root, 'tools', 'load.mjs'), 'export {}\n');
  await writeInstallFixtureManifest(root, { name: 'demo', version: '1.0.0' }, [{ host: 'cursor' }]);
  const manifestPath = join(root, artifactManifestName);
  const manifest = parseArtifactManifest(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, assembleArtifactManifest({
    ...manifest,
    distribution: {
      ...manifest.distribution,
      payloads: [
        { hosts: ['cursor'], name: 'native', runtimeDependencies: ['ffmpeg'] },
        { hosts: ['cursor'], name: 'tools', runtimeDependencies: ['sharp'] },
      ],
    },
    files: manifest.files.map((file) =>
      file.path.startsWith('native/') || file.path.startsWith('tools/')
        ? { ...file, kind: 'prebuilt' as const }
        : file
    ),
  }).bytes);
};

it('inspect --artifact --json projects the fixture manifest and Workbench application tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspect-artifact-'));
  try {
    await writeCursorArtifactRoot(root);
    const result = await runSourceCliWithOutput(['inspect', '--artifact', root, '--json']);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const document = JSON.parse(result.stdout) as {
      readonly application: {
        readonly distribution: {
          readonly payloads: readonly {
            readonly hosts: readonly string[];
            readonly name: string;
            readonly runtimeDependencies: readonly string[];
          }[];
        };
        readonly identity: { readonly id: string };
      };
      readonly manifest: { readonly application: { readonly id: string } };
    };
    expect(document.manifest.application.id).toBe('application:demo');
    expect(document.application.identity.id).toBe('application:demo');
    expect(document.application.distribution.payloads).toEqual([
      { hosts: ['cursor'], name: 'native', runtimeDependencies: ['ffmpeg'] },
      { hosts: ['cursor'], name: 'tools', runtimeDependencies: ['sharp'] },
    ]);

    const human = await runSourceCliWithOutput(['inspect', '--artifact', root]);
    expect(human).toMatchObject({ code: 0, stderr: '' });
    expect(human.stdout).toContain('Application: demo (application:demo) 1.0.0');
    expect(human.stdout).toContain('Projections: cursor');
    expect(human.stdout).toContain('Payloads: native (cursor: ffmpeg); tools (cursor: sharp)');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('inspect --artifact on a directory with no manifest fails AB7001 and exits 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspect-artifact-missing-'));
  try {
    const result = await runSourceCliWithOutput(['inspect', '--artifact', root, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject([{ code: 'AB7001', severity: 'error' }]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('inspect --help names the --artifact option', async () => {
  const result = await runSourceCliWithOutput(['inspect', '--help']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('--artifact <path>');
  expect(result.stdout).toContain('Inspect exactly this built artifact');
});

it('inspect --artifact together with --root is a usage error', async () => {
  const result = await runSourceCliWithOutput([
    'inspect', '--artifact', '/tmp/artifact', '--root', '/tmp/project',
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("error: option '--artifact <path>' cannot be used with option '--root <root>'");
  expect(result.stderr).not.toContain('AB5000');
});
