import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');

it('packs generated Workbench legal companion files', async () => {
  const tarballRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-release-audit-'));

  try {
    await execFile('npm', ['run', 'build'], {
      cwd: workspaceRoot,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const { stdout } = await execFile('npm', [
      'pack',
      '--json',
      '--pack-destination',
      tarballRoot,
    ], { cwd: packageRoot });
    const [{ files }] = JSON.parse(stdout) as Array<{ readonly files: readonly { readonly path: string }[] }>;

    expect(files.map((file) => file.path)).toContainEqual(
      expect.stringMatching(/^dist\/workbench\/.*\.LICENSE\.txt$/u),
    );
  } finally {
    await rm(tarballRoot, { force: true, recursive: true });
  }
}, 120_000);
