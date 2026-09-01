import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { build, inspect, invokeMcp, listHooks, listMcp, runEvals, simulateHook, validate } from '../src/api.ts';

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
        packageName: '@agent-bundle-example/skills-starter',
        packageVersion: '0.0.0-dev',
        scripts: [],
        targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
      },
      projectContext: {
        packageName: '@agent-bundle-example/skills-starter',
        packageVersion: '0.0.0-dev',
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
  const unrelatedCwd = await mkdtemp(join(tmpdir(), 'mcp-app-fixture-check-'));
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
    expect(inspected).toMatchObject({
      model: {
        packageName: '@agent-bundle-example/mcp-app',
        packageVersion: '0.0.0-dev',
        hooks: [{ event: 'sessionStart', targets: ['claude', 'codex'] }],
        mcpApps: [{ name: 'status', targets: ['portable'] }],
        mcpServers: [{ name: 'status', targets: ['claude', 'codex', 'portable'] }],
        scripts: [{ name: 'check-service-fixture', targets: ['claude', 'codex', 'portable'] }],
        skills: [{ name: 'service-readiness', targets: ['portable', 'codex', 'claude'] }],
        targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
      },
      projectContext: {
        packageName: '@agent-bundle-example/mcp-app',
        packageVersion: '0.0.0-dev',
      },
      state: 'ready',
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
      await expect(readFile(join(output, target, 'assets', 'evals', 'fixtures', 'status', 'result.json'), 'utf8'))
        .resolves.toContain('"Compiler service is ready for release."');
    }
    const fixtureCheck = await execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'check-service-fixture.mjs'),
    ], { cwd: unrelatedCwd });
    expect(fixtureCheck.stdout).toBe('Compiler fixture is healthy.\n');
    const fixturePath = join(output, 'portable', 'assets', 'evals', 'fixtures', 'status', 'result.json');
    const healthyFixture = await readFile(fixturePath, 'utf8');
    await writeFile(fixturePath, JSON.stringify({
      checks: [],
      service: 'compiler',
      status: 'healthy',
      summary: 'A stale summary.',
    }));
    try {
      const invalidFixtureCheck = await execFile(process.execPath, [
        join(output, 'portable', 'scripts', 'check-service-fixture.mjs'),
      ], { cwd: unrelatedCwd }).then(
        () => {
          throw new Error('Expected an incomplete compiler fixture to fail.');
        },
        (error: unknown) => error as { readonly code: number; readonly stderr: string },
      );
      expect(invalidFixtureCheck.code).toBe(1);
      expect(invalidFixtureCheck.stderr).toContain('compiler fixture must contain the exact healthy compiler status');
    } finally {
      await writeFile(fixturePath, healthyFixture);
    }
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
    await Promise.all([
      rm(stateRoot, { force: true, recursive: true }),
      rm(unrelatedCwd, { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('simulates the Hooks example and executes release checks', async () => {
  const root = join(examplesRoot, 'hooks-and-scripts');
  const output = join(root, '.agent-bundle', 'example-contract');
  const unrelatedCwd = await mkdtemp(join(tmpdir(), 'hooks-and-scripts-contract-'));
  await rm(output, { force: true, recursive: true });

  try {
    const built = await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    const artifactCatalog = built.build.compiledEntries.map(({ name }) => name);
    expect(artifactCatalog).toEqual(expect.arrayContaining(['verify-release', 'detect-risk']));
    await expect(readFile(join(output, 'portable', 'assets', 'release', 'release-manifest.json'), 'utf8'))
      .resolves.toContain('"version": "2.4.0"');
    await expect(readFile(join(output, 'portable', 'assets', 'release', 'risk-register.json'), 'utf8'))
      .resolves.toContain('"id": "REL-204"');
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
    expect(result).toMatchObject({ additionalContext: expect.stringContaining('release preparation') });
    const verify = await execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'verify-release.mjs'),
    ], { cwd: unrelatedCwd });
    expect(verify.stdout).toContain('Release 2.4.0 is ready for packaging.');
    const blocker = await execFile(process.execPath, [
      join(output, 'portable', 'scripts', 'detect-risk.mjs'),
    ], { cwd: unrelatedCwd }).then(
      () => {
        throw new Error('Expected detect-risk to block release packaging.');
      },
      (error: unknown) => error as { readonly code: number; readonly stderr: string },
    );
    expect(blocker.stderr).toContain('REL-204');
    expect(blocker.code).toBe(2);
  } finally {
    await Promise.all([
      rm(output, { force: true, recursive: true }),
      rm(unrelatedCwd, { force: true, recursive: true }),
    ]);
  }
});
