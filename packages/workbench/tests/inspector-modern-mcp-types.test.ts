import { execFile as executeFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const consumer = 'packages/workbench/tests/inspector-modern-mcp-types.consumer.ts';

it('type checks Inspector MCP consumers with only modern transports', async () => {
  await expect(execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
    '--ignoreConfig',
    '--module', 'nodenext',
    '--moduleResolution', 'nodenext',
    '--noEmit',
    '--skipLibCheck',
    '--strict',
    '--target', 'es2022',
    '--types', 'node',
    consumer,
  ], {
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH ?? '' },
  })).resolves.toMatchObject({ stderr: '', stdout: '' });
});
