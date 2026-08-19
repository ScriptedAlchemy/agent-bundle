import { execFile as executeFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchRoot = join(workspaceRoot, 'packages', 'workbench');

it('compiles the approved Inspector category closure under Rsbuild', async () => {
  await expect(execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH ?? '' },
  })).resolves.toMatchObject({ stderr: '' });

  await expect(access(join(workbenchRoot, 'dist', 'inspector-closure.html'))).resolves.toBeUndefined();
  await expect(readFile(join(workbenchRoot, 'dist', 'static', 'js', 'inspector-closure.js'), 'utf8')).resolves.toContain('ToolsScreen');

  const [bridgeSource, frameSource, facadeSource] = await Promise.all([
    readFile(join(workbenchRoot, 'src', 'inspector', 'adapter', 'runtime-app-bridge.ts'), 'utf8'),
    readFile(join(workbenchRoot, 'src', 'mcp', 'mcp-app-frame.tsx'), 'utf8'),
    readFile(join(workbenchRoot, 'src', 'inspector', 'adapter', 'inspector-closure-vendor.js'), 'utf8'),
  ]);
  expect(bridgeSource).not.toContain('/vendor/');
  expect(frameSource).not.toContain('/vendor/');
  expect(facadeSource).toContain('AppRenderer/AppRenderer.tsx');

  const files = await readdir(join(workbenchRoot, 'dist', 'static', 'js'), { recursive: true });
  const chunks = await Promise.all(files.filter((file) => file.endsWith('.js')).map(async (file) =>
    readFile(join(workbenchRoot, 'dist', 'static', 'js', file), 'utf8')));
  const rendererMarkers = chunks.reduce((count, chunk) => count + (chunk.match(/data-app-status/g)?.length ?? 0), 0);
  expect(rendererMarkers).toBe(1);
});
