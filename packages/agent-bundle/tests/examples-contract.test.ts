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

it('publishes the MCP App example service readiness across targets and returns degraded check details', async () => {
  const root = join(examplesRoot, 'mcp-app');
  const stateRoot = join(root, '.agent-bundle');
  const output = join(stateRoot, 'example-contract');
  await rm(stateRoot, { force: true, recursive: true });

  try {
    const built = await build({ output, root });
    const inspected = await inspect({ root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(listMcp({
      artifact: output,
      root,
      server: 'status',
      target: 'portable',
    })).resolves.toMatchObject({ tools: [{ name: 'show-status' }] });
    await expect(invokeMcp({
      artifact: output,
      input: { service: 'payments-api' },
      root,
      server: 'status',
      target: 'portable',
      tool: 'show-status',
    })).resolves.toMatchObject({
      result: {
        _meta: { ui: { resourceUri: 'ui://mcp-app-example/status.html' } },
        content: [{ text: 'Payment latency is above the release threshold.', type: 'text' }],
        structuredContent: {
          checks: [
            { label: 'Availability', status: 'passing' },
            { label: 'P95 latency', status: 'failing' },
          ],
          service: 'payments-api',
          status: 'degraded',
          summary: 'Payment latency is above the release threshold.',
        },
      },
    });
    expect(inspected.model).toMatchObject({
      hooks: [{ event: 'sessionStart', targets: ['claude', 'codex'] }],
      mcpApps: [{ name: 'status', targets: ['portable'] }],
      mcpServers: [{ name: 'status', targets: ['claude', 'codex', 'portable'] }],
      scripts: [{ name: 'check-service-fixture', targets: ['claude', 'codex', 'portable'] }],
      skills: [{ name: 'service-readiness', targets: ['portable', 'codex', 'claude'] }],
      targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
    });
    for (const target of ['portable', 'codex', 'claude'] as const) {
      await expect(readFile(join(output, target, 'skills', 'service-readiness', 'SKILL.md'), 'utf8'))
        .resolves.toContain('# Service readiness');
      await expect(readFile(join(output, target, 'skills', 'service-readiness', 'references', 'status-policy.md'), 'utf8'))
        .resolves.toContain('# Service status policy');
      await expect(readFile(join(output, target, 'skills', 'service-readiness', 'assets', 'readiness-report.md'), 'utf8'))
        .resolves.toContain('# Service readiness report');
      await expect(readFile(join(output, target, 'scripts', 'check-service-fixture.mjs'), 'utf8'))
        .resolves.toContain('Compiler fixture is healthy.');
    }
    const fixtureCheck = await execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'check-service-fixture.mjs'),
    ], { cwd: root });
    expect(fixtureCheck.stdout).toBe('Compiler fixture is healthy.\n');
    await expect(readFile(join(output, 'portable', 'mcp-apps', 'status.html'), 'utf8'))
      .resolves.toContain('aria-label="Service checks"');
    expect(built.build.compiledMcpApps).toMatchObject([{ name: 'status', target: 'portable' }]);
    expect(built.build.compiledMcpEntries.map(({ target }) => target).sort()).toEqual(['claude', 'codex', 'portable']);
    await Promise.all(built.build.compiledMcpEntries.map(({ output: mcpOutput }) =>
      expect(readFile(mcpOutput, 'utf8')).resolves.toContain('payments-api'),
    ));
    expect(built.build.compiledHooks.map(({ target }) => target).sort()).toEqual(['claude', 'codex']);
    await Promise.all(built.build.compiledHooks.map(({ output: hookOutput }) =>
      expect(readFile(hookOutput, 'utf8')).resolves.toContain('Service readiness session'),
    ));
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
      trials: [{
        caseId: 'status-is-healthy',
        host: 'portable',
        outcome: 'pass',
        provenance: { invocation: { mode: 'explicit', skill: 'service-readiness' } },
      }],
    });
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
}, 30_000);

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
