import { execFile as executeFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchRoot = join(workspaceRoot, 'packages', 'workbench');

it('compiles the approved Inspector category closure under Rsbuild', async () => {
  await expect(execFile('pnpm', ['--filter', 'agent-bundle-workbench', 'build'], {
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH ?? '' },
  })).resolves.toBeDefined();

  await expect(access(join(workbenchRoot, 'dist', 'inspector-closure.html'))).resolves.toBeUndefined();
  await expect(readFile(join(workbenchRoot, 'dist', 'static', 'js', 'inspector-closure.js'), 'utf8')).resolves.toContain('ToolsScreen');
});
