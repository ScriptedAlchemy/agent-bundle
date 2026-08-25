import { execFile as executeFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { build, inspect, listHooks, simulateHook, validate } from '../src/api.ts';

const execFile = promisify(executeFile);
const examplesRoot = join(process.cwd(), 'examples');

it('builds the Skills Starter through public Agent Bundle APIs', async () => {
  const root = join(examplesRoot, 'skills-starter');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });

  try {
    await expect(inspect({ root })).resolves.toMatchObject({
      model: {
        metadata: { name: 'skills-starter' },
        scripts: [],
        targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
      },
      state: 'ready',
    });
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(readFile(join(output, 'portable', 'skills', 'release-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Release review');
    await expect(readFile(join(
      output,
      'portable',
      'skills',
      'release-review',
      'references',
      'checklist.md',
    ), 'utf8')).resolves.toContain('Confirm the release artifact');
    await expect(readFile(join(
      output,
      'portable',
      'skills',
      'release-review',
      'assets',
      'report-template.md',
    ), 'utf8')).resolves.toContain('# Release report');
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});

it('simulates the Hooks example and executes both scripts', async () => {
  const root = join(examplesRoot, 'hooks-and-scripts');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });

  try {
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    const hooks = await listHooks({ artifact: output, root });
    expect(hooks).toHaveLength(2);
    const hook = hooks.find(({ target }) => target === 'codex');
    expect(hook).toBeDefined();
    await expect(simulateHook({
      artifact: output,
      hook: hook!.id,
      input: {
        cwd: root,
        sessionId: 'example',
        source: 'workbench',
        transcriptPath: join(root, 'transcript.json'),
      },
      root,
      target: hook!.target,
    })).resolves.toEqual({ additionalContext: 'example session from workbench', outcome: 'continue' });
    await expect(execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'succeed.mjs'),
    ], { cwd: root })).resolves.toMatchObject({
      stderr: 'example warning\n',
      stdout: 'example success\n',
    });
    await expect(execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'fail.mjs'),
    ], { cwd: root })).rejects.toMatchObject({
      code: 2,
      stderr: 'example failure\n',
    });
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
