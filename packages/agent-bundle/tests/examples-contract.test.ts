import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from '@rstest/core';

import { build, inspect, invokeMcp, listHooks, listMcp, runEvals, simulateHook, validate } from '../src/api.ts';
import { projectVersionLabel } from '../src/core/project-context.ts';

const execFile = promisify(executeFile);
const examplesRoot = join(process.cwd(), 'examples');

it('builds the Skills Starter through public Agent Bundle APIs', async () => {
  const root = join(examplesRoot, 'skills-starter');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });

  try {
    const inspection = await inspect({ root });
    expect(inspection).toMatchObject({
      model: {
        metadata: { name: 'skills-starter' },
        scripts: [],
        targets: [{ name: 'claude' }, { name: 'codex' }, { name: 'portable' }],
      },
      state: 'ready',
    });
    if (inspection.state !== 'ready') throw new Error('unreachable');
    // Identity stages 1-2 (#94): no package.json version, so the release
    // axis is absent and displays fall back to the labeled dev form.
    expect(inspection.projectContext.packageName).toBe('@agent-bundle-example/skills-starter');
    expect(inspection.projectContext.packageVersion).toBeUndefined();
    expect(projectVersionLabel(inspection.projectContext)).toContain('development fallback');
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(readFile(join(output, 'skills', 'release-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Release review');
    await expect(readFile(join(output, 'skills', 'release-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('## When to use');
    await expect(readFile(join(
      output,
      'skills',
      'release-review',
      'references',
      'checklist.md',
    ), 'utf8')).resolves.toContain('Confirm the release artifact');
    await expect(readFile(join(
      output,
      'skills',
      'release-review',
      'references',
      'release-policy.md',
    ), 'utf8')).resolves.toContain('# Release readiness policy');
    await expect(readFile(join(
      output,
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
        hooks: [{ event: 'sessionStart', targets: ['claude', 'codex'] }],
        mcpApps: [{ name: 'status', targets: ['portable'] }],
        mcpServers: [{ name: 'status', targets: ['claude', 'codex', 'portable'] }],
        scripts: [{ name: 'check-service-fixture', targets: ['claude', 'codex', 'portable'] }],
        skills: [{ name: 'service-readiness', targets: ['claude', 'codex', 'portable'] }],
        targets: [{ name: 'claude' }, { name: 'codex' }, { name: 'portable' }],
      },
      state: 'ready',
    });
    // The shared skill, script, and asset are emitted once into the composite
    // root that all three selected hosts read (#555).
    await expect(readFile(join(output, 'skills', 'service-readiness', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Service readiness');
    await expect(readFile(join(output, 'skills', 'service-readiness', 'references', 'status-policy.md'), 'utf8'))
      .resolves.toContain('# Service status policy');
    await expect(readFile(join(output, 'skills', 'service-readiness', 'assets', 'readiness-report.md'), 'utf8'))
      .resolves.toContain('# Service readiness report');
    await expect(readFile(join(output, 'scripts', 'check-service-fixture.mjs'), 'utf8'))
      .resolves.toContain('Compiler fixture is healthy.');
    await expect(readFile(join(output, 'assets', 'evals', 'fixtures', 'status', 'result.json'), 'utf8'))
      .resolves.toContain('"Compiler service is ready for release."');
    const fixtureCheck = await execFile(process.execPath, [
      join(output, 'scripts', 'check-service-fixture.mjs'),
    ], { cwd: unrelatedCwd });
    expect(fixtureCheck.stdout).toBe('Compiler fixture is healthy.\n');
    const fixturePath = join(output, 'assets', 'evals', 'fixtures', 'status', 'result.json');
    const healthyFixture = await readFile(fixturePath, 'utf8');
    await writeFile(fixturePath, JSON.stringify({
      checks: [],
      service: 'compiler',
      status: 'healthy',
      summary: 'A stale summary.',
    }));
    try {
      const invalidFixtureCheck = await execFile(process.execPath, [
        join(output, 'scripts', 'check-service-fixture.mjs'),
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
    const appHtml = await readFile(join(output, 'mcp-apps', 'status.html'), 'utf8');
    expect(appHtml).toContain('aria-label="Service checks"');
    expect(appHtml).toContain('mcp-app-example');
    expect(appHtml).toContain('1.0.0');
    expect(appHtml).not.toContain('mcp-app-status-panel');
    expect(appHtml).not.toContain('agent-bundle/meta');
    // Compiled surfaces are attributed to the composite root's identity (#555).
    expect(built.build.compiledMcpApps).toMatchObject([{ name: 'status', target: 'claude+codex+portable' }]);
    expect(built.build.compiledMcpEntries.map(({ target }) => target)).toEqual(['claude+codex+portable']);
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
    await expect(readFile(join(output, 'assets', 'release', 'release-manifest.json'), 'utf8'))
      .resolves.toContain('"version": "2.4.0"');
    await expect(readFile(join(output, 'assets', 'release', 'risk-register.json'), 'utf8'))
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
      join(output, 'scripts', 'verify-release.mjs'),
    ], { cwd: unrelatedCwd });
    expect(verify.stdout).toContain('Release 2.4.0 is ready for packaging.');
    const blocker = await execFile(process.execPath, [
      join(output, 'scripts', 'detect-risk.mjs'),
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

it('derives the Audiobook Curator release identity from package.json as the one version source', async () => {
  const root = join(examplesRoot, 'audiobook-curator');
  const inspection = await inspect({ root });
  expect(inspection.state).toBe('ready');
  if (inspection.state !== 'ready') throw new Error('unreachable');
  // package.json declares 1.0.0 once and the config declares no
  // plugin.version, so the model version is inferred and cannot mismatch.
  expect(inspection.projectContext.packageName).toBe('@agent-bundle-example/audiobook-curator');
  expect(inspection.projectContext.packageVersion).toBe('1.0.0');
  expect(inspection.model.metadata).toMatchObject({
    name: 'audiobook-curator',
    packageName: '@agent-bundle-example/audiobook-curator',
    packageVersion: '1.0.0',
    version: '1.0.0',
  });
  expect(projectVersionLabel(inspection.projectContext)).toBe('1.0.0');
  expect(inspection.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4008')).toEqual([]);
});


it('serves the routed Audiobook Curator artifact through a real MCP client', { retry: 2, timeout: 60_000 }, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'audiobook-routed-artifact-'));
  const root = join(fixtureRoot, 'project');
  await cp(join(examplesRoot, 'audiobook-curator'), root, {
    filter: (source) => !['.agent-bundle', 'artifact', 'dist', 'node_modules'].includes(source.slice(source.lastIndexOf('/') + 1)),
    recursive: true,
  });
  const fixtureTsconfig = await readFile(join(root, 'tsconfig.json'), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), fixtureTsconfig.replace('../../tsconfig.json', join(process.cwd(), 'tsconfig.json')));
  await symlink(join(examplesRoot, 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  const output = join(root, 'artifact');
  let client: Client | undefined;
  try {
    const compiled = await build({ output, root, targets: ['claude'] });
    await rm(join(root, 'src'), { force: true, recursive: true });
    const server = compiled.model.mcpServers.find((candidate) => candidate.name === 'curator');
    expect(server?.generatedRoutes).toHaveLength(18);
    const entry = join(output, server!.args![0]!);
    client = new Client({ name: 'audiobook-route-contract', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' }));

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('inspect_sources');
    const inspectResult = await client.callTool({ arguments: { root }, name: 'inspect_sources' });
    expect(inspectResult).toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
      structuredContent: { operation: 'inspect', root },
    });
    await expect(client.listResources()).resolves.toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ uri: 'audiobook-curator://catalog' }),
      ]),
    });
    await expect(client.readResource({ uri: 'audiobook-curator://catalog' })).resolves.toMatchObject({
      contents: [expect.objectContaining({ mimeType: 'application/json', uri: 'audiobook-curator://catalog' })],
    });
    await expect(client.listPrompts()).resolves.toMatchObject({
      prompts: [expect.objectContaining({ name: 'curate' })],
    });
    await expect(client.getPrompt({ arguments: { root }, name: 'curate' })).resolves.toMatchObject({
      messages: [{ content: { type: 'text' }, role: 'user' }],
    });
  } finally {
    await client?.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
