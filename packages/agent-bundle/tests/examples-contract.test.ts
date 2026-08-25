import { execFile as executeFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { build, inspect, invokeMcp, listHooks, listMcp, runEvals, simulateHook, validate } from '../src/api.ts';

const execFile = promisify(executeFile);
const examplesRoot = join(process.cwd(), 'examples');

it('documents the local command flow and each example-specific interaction', async () => {
  const [skills, hooks, mcpApp] = await Promise.all([
    readFile(join(examplesRoot, 'skills-starter', 'README.md'), 'utf8'),
    readFile(join(examplesRoot, 'hooks-and-scripts', 'README.md'), 'utf8'),
    readFile(join(examplesRoot, 'mcp-app', 'README.md'), 'utf8'),
  ]);

  for (const readme of [skills, hooks, mcpApp]) {
    expect(readme).toContain('pnpm validate');
    expect(readme).toContain('pnpm build');
    expect(readme).toContain('pnpm dev');
  }
  expect(skills).toContain('dist/agent-bundle.manifest.json');
  expect(hooks).toContain('Replay saved simulation');
  expect(mcpApp).toContain('Restart MCP session');
});

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

it('invokes the MCP App example and exposes its official App resource', async () => {
  const root = join(examplesRoot, 'mcp-app');
  const stateRoot = join(root, '.agent-bundle');
  const output = join(stateRoot, 'example-contract');
  await rm(stateRoot, { force: true, recursive: true });

  try {
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(listMcp({
      artifact: output,
      root,
      server: 'status',
      target: 'portable',
    })).resolves.toMatchObject({ tools: [{ name: 'show-status' }] });
    await expect(invokeMcp({
      artifact: output,
      input: { service: 'compiler' },
      root,
      server: 'status',
      target: 'portable',
      tool: 'show-status',
    })).resolves.toMatchObject({
      result: {
        _meta: { ui: { resourceUri: 'ui://mcp-app-example/status.html' } },
        content: [{ text: 'compiler is healthy', type: 'text' }],
        structuredContent: { service: 'compiler', status: 'healthy' },
      },
    });
    await expect(runEvals({
      artifact: output,
      caseIds: ['status-is-healthy'],
      root,
      trials: 1,
    })).resolves.toMatchObject({
      run: {
        harness: 'deterministic',
        summary: { cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 },
      },
      trials: [{ caseId: 'status-is-healthy', host: 'portable', outcome: 'pass' }],
    });
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
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
