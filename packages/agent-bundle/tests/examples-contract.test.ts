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
    await expect(readFile(join(output, 'portable', 'skills', 'release-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('## When to use');
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
      'references',
      'release-policy.md',
    ), 'utf8')).resolves.toContain('# Release readiness policy');
    await expect(readFile(join(
      output,
      'portable',
      'skills',
      'release-review',
      'assets',
      'report-template.md',
    ), 'utf8')).resolves.toContain('# Release readiness report');
    await expect(runEvals({
      artifact: output,
      caseIds: ['release-artifact-is-ready'],
      root,
      trials: 1,
    })).resolves.toMatchObject({
      run: {
        harness: 'deterministic',
        summary: { cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 },
      },
      trials: [{
        caseId: 'release-artifact-is-ready',
        host: 'portable',
        outcome: 'pass',
        provenance: { invocation: { mode: 'explicit', skill: 'release-review' } },
      }],
    });
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

it('simulates the Hooks example and executes release checks', async () => {
  const root = join(examplesRoot, 'hooks-and-scripts');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });

  try {
    const built = await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    const artifactCatalog = built.build.compiledEntries.map(({ name }) => name);
    expect(artifactCatalog).toEqual(expect.arrayContaining(['verify-release', 'detect-risk']));
    const hooks = await listHooks({ artifact: output, root });
    expect(hooks).toHaveLength(2);
    const hook = hooks.find(({ target }) => target === 'codex');
    expect(hook).toBeDefined();
    const result = await simulateHook({
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
    });
    expect(result.additionalContext).toContain('release preparation');
    const verify = await execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'verify-release.mjs'),
    ], { cwd: root });
    expect(verify.stdout).toContain('Release 2.4.0 is ready for packaging.');
    const blocker = await execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'detect-risk.mjs'),
    ], { cwd: root }).then(
      () => {
        throw new Error('Expected detect-risk to block release packaging.');
      },
      (error: unknown) => error as { readonly code: number; readonly stderr: string },
    );
    expect(blocker.stderr).toContain('REL-204');
    expect(blocker.code).toBe(2);
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
