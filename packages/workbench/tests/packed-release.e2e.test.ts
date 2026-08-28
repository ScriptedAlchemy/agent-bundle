import { spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import {
  assertOutageLedger,
  hasCanonicalAfterCursor,
  validateOutageLedger,
  type ConsoleErrorRecord,
} from './support/packed-outage-ledger.ts';

const execFile = promisify((await import('node:child_process')).execFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixtureRoot = join(workspaceRoot, 'fixtures', 'integration', 'packed-release');
const browserTimeout = 12_000;
const packedServerStartupBudget = 45_000;
const productTemporaryRootPrefixes = [
  'agent-bundle-hook-playground-',
  'agent-bundle-mcp-',
  'agent-bundle-playground-script-',
] as const;
let builtPackage: Promise<void> | undefined;

const expectedAgentApiToolNames = [
  'project_status',
  'skills_list',
  'skill_inspect',
  'artifacts_list',
  'artifact_inspect',
  'mcp_servers_list',
  'mcp_invoke',
  'hooks_list',
  'hook_simulate',
  'evals_list',
  'eval_run',
  'eval_get',
  'diagnostics_list',
] as const;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const installedEnvironment = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  return environment;
};

const availablePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  }));
  return address.port;
};

const buildPackage = (): Promise<void> => builtPackage ??= (async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
})();

const awaitReady = async (origin: string, child: ChildProcess, output: () => string): Promise<void> => {
  const startedAt = Date.now();
  const diagnostics = (): string =>
    `after ${String(Date.now() - startedAt)}ms (PID ${String(child.pid ?? 'unknown')}): ${output()}`;
  while (Date.now() - startedAt < packedServerStartupBudget) {
    if (child.exitCode !== null) throw new Error(`The packed dev server exited before readiness ${diagnostics()}`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // The fixed loopback port is not ready yet.
    }
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
  }
  throw new Error(`Timed out waiting for the packed dev server ${diagnostics()}`);
};

const childExitedWithin = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
      resolvePromise(exited);
    };
    const onExit = (): void => { finish(true); };
    const onError = (error: Error): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      rejectPromise(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    const timeout = setTimeout(() => { finish(false); }, timeoutMs);
    if (child.exitCode !== null) finish(true);
  });
};

const closeChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const signalAndWait = async (signal: NodeJS.Signals): Promise<boolean> => {
    if (child.exitCode !== null) return true;
    if (!child.kill(signal)) {
      if (child.exitCode !== null) return true;
      throw new Error(`The packed dev server could not receive ${signal}.`);
    }
    return childExitedWithin(child, 5_000);
  };
  const closeFailures: unknown[] = [];
  try {
    if (await signalAndWait('SIGTERM')) return;
    closeFailures.push(new Error('The packed dev server did not exit after SIGTERM.'));
  } catch (error) {
    closeFailures.push(error);
  }
  let forceExited = false;
  try { forceExited = await signalAndWait('SIGKILL'); }
  catch (error) { closeFailures.push(error); }
  if (forceExited) throw new AggregateError(closeFailures, 'The packed dev server required SIGKILL after SIGTERM.');
  closeFailures.push(new Error('The packed dev server remained alive after SIGKILL.'));
  throw new AggregateError(closeFailures, 'The packed dev server could not be stopped.');
};

const writeFakeClaude = async (root: string): Promise<string> => {
  const directory = join(root, '.packed-release-fake-claude');
  const executable = join(directory, 'claude');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(executable, '#!/bin/sh\nexec node "$(dirname "$0")/claude.mjs" "$@"\n'),
    writeFile(join(directory, 'claude.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write('2.1.240 (Claude Code)\\n'); process.exit(0); }",
      "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('{\"authMethod\":\"claude.ai\",\"loggedIn\":true,\"subscriptionType\":\"max\"}\\n'); process.exit(0); }",
      "const prompt = args.at(-1) ?? '';",
      "if (prompt.includes('Wait for packed native cancellation.')) setInterval(() => undefined, 1_000);",
      "writeFileSync('result.json', '{\"risk\":\"packed-native\"}\\n');",
      'process.stdout.write([',
      "  '{\"type\":\"system\",\"subtype\":\"init\",\"plugins\":[{\"name\":\"packed-release-fixture\"}],\"mcp_servers\":[{\"name\":\"fixture\"}]}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Skill\",\"input\":{\"skill\":\"packed-release-fixture:review\"}}]}}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"mcp__fixture__show-dashboard\",\"input\":{}}]}}',",
      "  '{\"type\":\"system\",\"hook_event_name\":\"SessionStart\"}',",
      "  '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"duration_ms\":7,\"num_turns\":2,\"result\":\"Packed native fixture completed.\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}',",
      "  '',",
      "].join('\\n'));",
      '',
    ].join('\n')),
  ]);
  await chmod(executable, 0o755);
  return directory;
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected ${label} to be an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Expected ${label} to be a string.`);
  return value;
};

const firstRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Expected ${label} to contain one entry.`);
  return record(value[0], `${label}[0]`);
};

const isWithin = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path.length === 0 || (!isAbsolute(path) && !path.startsWith('..'));
};

const descendantProcessIds = async (parentProcessId: number): Promise<readonly number[]> => {
  const { stdout } = await execFile('ps', ['-eo', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const row of stdout.split('\n')) {
    const [processIdText, ancestorProcessIdText] = row.trim().split(/\s+/u);
    const processId = Number(processIdText);
    const ancestorProcessId = Number(ancestorProcessIdText);
    if (!Number.isInteger(processId) || !Number.isInteger(ancestorProcessId)) continue;
    const descendants = children.get(ancestorProcessId) ?? [];
    descendants.push(processId);
    children.set(ancestorProcessId, descendants);
  }
  const descendants = new Set<number>();
  const pending = [...(children.get(parentProcessId) ?? [])];
  while (pending.length > 0) {
    const processId = pending.pop();
    if (processId === undefined || descendants.has(processId)) continue;
    descendants.add(processId);
    pending.push(...(children.get(processId) ?? []));
  }
  return [...descendants];
};

const isAppRoute = (url: URL): boolean =>
  url.pathname.startsWith('/api/mcp/apps/') || /^\/api\/mcp\/sessions\/[^/]+\/apps$/u.test(url.pathname);


e2e('runs every Agent API tool from the installed tarball', { timeout: 360_000 }, async ({ page }) => {
  await buildPackage();
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-release-'));
  const forbiddenStagedPackage = join(consumer, 'staged-package');
  const project = join(consumer, 'project');
  const agentApiToken = 'packed-release-token';
  let child: ChildProcess | undefined;
  let phase = 'package setup';
  const trackedProcessIds = new Set<number>();
  const observedOperationDescendantProcessIds = new Set<number>();
  const productTemporaryRootsBefore = new Set<string>();
  let cleanupFailure: AggregateError | undefined;
  let primaryFailure: Error | undefined;
  try {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', consumer], {
      cwd: packageRoot,
      env: installedEnvironment(),
    });
    const [packed] = JSON.parse(stdout) as Array<{ readonly filename: string }>;
    const tarball = join(consumer, packed.filename);
    await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
    await execFile('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: consumer,
      env: installedEnvironment(),
    });
    const installedPackageRoot = await realpath(join(consumer, 'node_modules', 'agent-bundle'));
    const installedCli = await realpath(join(consumer, 'node_modules', '.bin', 'agent-bundle'));
    expect(isWithin(consumer, installedPackageRoot)).toBe(true);
    expect(isWithin(workspaceRoot, installedPackageRoot)).toBe(false);
    expect(installedCli).toBe(join(installedPackageRoot, 'bin', 'agent-bundle.js'));
    expect(isWithin(workspaceRoot, installedCli)).toBe(false);
    const installedManifest = record(JSON.parse(await readFile(join(installedPackageRoot, 'package.json'), 'utf8')), 'installed package manifest');
    const runtimeDependencies = record(installedManifest.dependencies, 'installed package runtime dependencies');
    for (const dependency of Object.keys(runtimeDependencies)) {
      const installedDependency = await realpath(join(consumer, 'node_modules', dependency));
      expect(isWithin(consumer, installedDependency)).toBe(true);
      expect(isWithin(workspaceRoot, installedDependency)).toBe(false);
    }
    await expect(access(forbiddenStagedPackage)).rejects.toMatchObject({ code: 'ENOENT' });
    await cp(fixtureRoot, project, {
      filter: (source) => source !== join(fixtureRoot, '.agent-bundle') && source !== join(fixtureRoot, 'node_modules'),
      recursive: true,
    });
    await expect(access(join(project, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    const configSource = join(project, 'agent-bundle.config.ts');
    const skillSource = join(project, 'skills', 'review', 'SKILL.md');
    const [originalConfig, originalSkill] = await Promise.all([
      readFile(configSource, 'utf8'),
      readFile(skillSource, 'utf8'),
    ]);
    const fakeClaudeDirectory = await writeFakeClaude(project);
    const installedBinDirectory = join(consumer, 'node_modules', '.bin');
    const childPathEntries = [fakeClaudeDirectory, installedBinDirectory, dirname(process.execPath), '/usr/bin', '/bin'];
    expect(childPathEntries.some((entry) => isWithin(workspaceRoot, entry))).toBe(false);

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    let commandOutput = '';
    let commandStderr = '';
    const startInstalledServer = (serverPort: number): ChildProcess => {
      const nextChild = spawn(installedCli, [
        'dev', '--agent-api', '--no-open', '--port', String(serverPort), '--root', project,
      ], {
        cwd: consumer,
        env: {
          ...installedEnvironment(),
          AGENT_BUNDLE_AGENT_API_TOKEN: agentApiToken,
          PATH: childPathEntries.join(delimiter),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      nextChild.stdout?.on('data', (chunk: Buffer) => { commandOutput += chunk.toString(); });
      nextChild.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        commandOutput += text;
        commandStderr += text;
      });
      return nextChild;
    };
    child = startInstalledServer(port);
    await awaitReady(origin, child, () => commandOutput);
    for (const root of await readdir(tmpdir())) {
      if (productTemporaryRootPrefixes.some((prefix) => root.startsWith(prefix))) productTemporaryRootsBefore.add(root);
    }
    phase = 'browser startup status';
    const consoleErrorRecords: ConsoleErrorRecord[] = [];
    const pageErrors: Error[] = [];
    const appRouteRequests: Array<Record<string, unknown>> = [];
    const failedAppRouteRequests: Array<Record<string, unknown>> = [];
    const browserRequests: Array<{
      at: number;
      completedAt?: number;
      error?: string;
      method: string;
      origin: string;
      path: string;
      phase: string;
      respondedAt?: number;
      status?: number;
      url: string;
    }> = [];
    const browserRequestByPlaywrightRequest = new WeakMap<object, typeof browserRequests[number]>();
    const nativeRequests: Array<Record<string, unknown>> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrorRecords.push(Object.freeze({ at: Date.now(), text: message.text(), url: message.location().url }));
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('response', (response) => {
      const url = new URL(response.url());
      const tracked = browserRequestByPlaywrightRequest.get(response.request());
      if (tracked !== undefined) {
        tracked.respondedAt = Date.now();
        tracked.status = response.status();
      }
      if (!isAppRoute(url)) return;
      const request = response.request();
      appRouteRequests.push(Object.freeze({
        frameUrl: request.frame().url(),
        isNavigation: request.isNavigationRequest(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        timing: request.timing(),
        path: url.pathname,
        url: response.url(),
      }));
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      const tracked = browserRequestByPlaywrightRequest.get(request);
      if (tracked !== undefined) {
        tracked.completedAt = Date.now();
        tracked.error = request.failure()?.errorText;
      }
      if (!isAppRoute(url)) return;
      failedAppRouteRequests.push(Object.freeze({
        error: request.failure()?.errorText,
        frameUrl: request.frame().url(),
        isNavigation: request.isNavigationRequest(),
        method: request.method(),
        resourceType: request.resourceType(),
        timing: request.timing(),
        path: url.pathname,
        url: request.url(),
      }));
    });
    page.on('requestfinished', (request) => {
      const tracked = browserRequestByPlaywrightRequest.get(request);
      if (tracked !== undefined) tracked.completedAt = Date.now();
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      const tracked = {
        at: Date.now(), method: request.method(), origin: url.origin, path: url.pathname, phase, url: request.url(),
      };
      browserRequests.push(tracked);
      browserRequestByPlaywrightRequest.set(request, tracked);
      if (request.method() !== 'POST' || url.pathname !== '/api/playground/runs') return;
      try {
        const body: unknown = JSON.parse(request.postData() ?? 'null');
        if (
          typeof body === 'object' && body !== null && !Array.isArray(body) &&
          (body as { readonly operation?: unknown }).operation === 'native.prompt'
        ) {
          nativeRequests.push(body as Record<string, unknown>);
        }
      } catch {
        // The test only records well-formed native Playground requests.
      }
    });
    const waitForBrowserRequestsAfter = async (startIndex: number): Promise<void> => {
      await expect.poll(() => browserRequests.slice(startIndex).filter((request) =>
        request.completedAt === undefined,
      ).map((request) => `${request.method} ${request.url}`), { timeout: browserTimeout }).toEqual([]);
    };
    phase = 'browser startup navigation';
    await page.goto(`${origin}#overview`);
    phase = 'browser startup dashboard';
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    phase = 'browser startup build health';
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });

    const client = new Client({ name: 'packed-release-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: { token: async () => agentApiToken },
    });
    let appProxyOrigin: string | undefined;
    let clientClosed = false;
    try {
      phase = 'Agent API catalog tools';
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expectedAgentApiToolNames);

      const called = new Set<string>();
      const call = async (name: typeof expectedAgentApiToolNames[number], args?: Record<string, unknown>) => {
        called.add(name);
        return client.callTool({ ...(args === undefined ? {} : { arguments: args }), name });
      };
      const status = await call('project_status');
      let statusDto = record(status.structuredContent, 'project status').status;
      expect(statusDto).toEqual(expect.any(Object));
      let active = record(statusDto, 'project status DTO').artifact;
      for (let attempt = 0; attempt < 120 && record(active, 'project artifact').state !== 'active'; attempt += 1) {
        await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
        const next = await client.callTool({ name: 'project_status' });
        statusDto = record(next.structuredContent, 'project status').status;
        active = record(statusDto, 'project status DTO').artifact;
      }
      if (record(active, 'project artifact').state !== 'active') {
        throw new Error(`The public project status never reported an active artifact: ${JSON.stringify(statusDto)}; CLI output: ${commandOutput}`);
      }

      const skillsList = await call('skills_list', { target: 'portable' });
      const skillsPayload = record(skillsList.structuredContent, 'skills list');
      if (skillsPayload.skills === undefined) {
        throw new Error(`The packed skills list did not expose skills after active publication: ${JSON.stringify({ skills: skillsPayload, status: statusDto })}; CLI output: ${commandOutput}`);
      }
      const skills = record(skillsPayload.skills, 'skills list.skills').skills;
      const skill = firstRecord(skills, 'skills list.skills.skills');
      const skillId = string(skill.id, 'skill id');
      const inspectedSkill = await call('skill_inspect', { skill_id: skillId, target: 'portable' });
      expect(record(inspectedSkill.structuredContent, 'inspected skill').skill).toEqual(expect.objectContaining({ id: skillId }));
      const expectGeneratedSkill = async (
        label: string,
        expectedEpoch: string,
        expectedBodyMarker: string,
        epoch?: string,
      ): Promise<void> => {
        const inspected = await call('skill_inspect', {
          skill_id: skillId,
          target: 'portable',
          ...(epoch === undefined ? {} : { epoch }),
        });
        const inspectedSkill = record(record(inspected.structuredContent, `${label} inspection`).skill, `${label} skill`);
        expect(string(record(inspectedSkill.base, `${label} skill base`).epochId, `${label} skill epoch`))
          .toBe(expectedEpoch);
        expect(string(inspectedSkill.body, `${label} skill body`)).toContain(expectedBodyMarker);
      };

      const artifacts = await call('artifacts_list');
      const epoch = firstRecord(record(artifacts.structuredContent, 'artifact list').epochs, 'artifact list.epochs');
      const epochId = string(epoch.id, 'epoch id');
      const inspectedArtifact = await call('artifact_inspect', { epoch: epochId });
      expect(record(inspectedArtifact.structuredContent, 'artifact inspection').artifact).toEqual(expect.any(Object));

      const servers = await call('mcp_servers_list', { epoch: epochId, target: 'portable' });
      expect(record(servers.structuredContent, 'MCP server list').servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'fixture', target: 'portable' }),
      ]));
      const invoked = await call('mcp_invoke', {
        arguments: {}, epoch: epochId, server: 'fixture', target: 'portable', tool: 'show-dashboard',
      });
      expect(record(invoked.structuredContent, 'MCP invocation').result).toEqual(expect.objectContaining({
        content: [expect.objectContaining({ text: 'packed dashboard ready' })],
      }));

      const hooksList = await call('hooks_list', { epoch: epochId, target: 'claude' });
      const hook = firstRecord(record(hooksList.structuredContent, 'hook list').hooks, 'hook list.hooks');
      const hookId = string(record(hook.binding, 'hook binding').hook, 'hook id');
      const simulated = await call('hook_simulate', {
        epoch: epochId,
        hook: hookId,
        input: { cwd: '/workspace', sessionId: 'packed-release', source: 'packed-release', transcriptPath: '/workspace/transcript.json' },
        target: 'claude',
      });
      expect(record(record(simulated.structuredContent, 'hook simulation').simulation, 'hook simulation result').canonicalResult)
        .toEqual(expect.objectContaining({ outcome: 'continue' }));

      phase = 'Skills and Artifacts pages';
      await page.goto(`${origin}#skills`);
      await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
      await page.goto(`${origin}#artifacts`);
      await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('heading', { name: 'Artifact tree' })).toBeVisible({ timeout: browserTimeout });

      phase = 'Hooks page simulation';
      const hookListing = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/hooks');
      await page.goto(`${origin}#hooks`);
      phase = 'Hooks page heading';
      await expect(page.getByRole('heading', { name: 'Hooks' })).toBeVisible({ timeout: browserTimeout });
      phase = 'Hooks catalog';
      const hookListingResponse = await hookListing;
      if (!hookListingResponse.ok()) throw new Error(`The Hooks page list route failed with ${hookListingResponse.status()}: ${await hookListingResponse.text()}`);
      await expect.poll(async () => page.locator('#hook-binding option').count(), { timeout: browserTimeout }).toBeGreaterThan(0);
      await page.locator('#hook-binding').selectOption({ index: 0 });
      phase = 'Hooks input';
      await page.getByText('Advanced input', { exact: true }).click();
      await page.locator('#hook-canonical-input').fill(JSON.stringify({
        cwd: '/workspace', sessionId: 'packed-browser', source: 'packed-browser', transcriptPath: '/workspace/transcript.json',
      }));
      phase = 'Hooks submit';
      const hookSimulation = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/hooks/simulations');
      await page.getByRole('button', { name: 'Run simulation' }).click();
      phase = 'Hooks result';
      const hookSimulationResponse = await hookSimulation;
      if (!hookSimulationResponse.ok()) throw new Error(`The Hooks page simulation failed with ${hookSimulationResponse.status()}: ${await hookSimulationResponse.text()}`);
      expect(await hookSimulationResponse.json()).toMatchObject({
        simulation: { canonicalResult: { additionalContext: 'packed:packed-browser', outcome: 'continue' } },
      });
      await expect(page.getByRole('heading', { name: 'Canonical result' })).toBeVisible({ timeout: browserTimeout });

      phase = 'MCP, Inspector, and App pages';
      await page.goto(`${origin}#mcp`);
      await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#mcp-target').selectOption('portable');
      await page.locator('#mcp-server-name').fill('fixture');
      const openedOldBrowserMcpSession = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Open MCP session' }).click();
      const oldBrowserMcpSessionResponse = record(await (await openedOldBrowserMcpSession).json(), 'old browser MCP session response');
      const oldBrowserMcpSessionId = string(record(oldBrowserMcpSessionResponse.session, 'old browser MCP session').id, 'old browser MCP session id');
      await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
      await page.getByRole('button', { name: 'show-dashboard', exact: true }).click();
      await page.getByRole('button', { name: 'Call show-dashboard' }).click();
      const mcpHistory = page.getByRole('region', { name: 'Invocation history' });
      await expect(mcpHistory).toContainText('packed dashboard ready', { timeout: browserTimeout });
      await page.getByRole('button', { name: /Open App preview for mcp-page-1/u }).click();
      const appPreview = page.locator('iframe[title="MCP App preview: show-dashboard"]');
      await expect(appPreview).toBeVisible({ timeout: browserTimeout });
      const appPreviewSource = await appPreview.getAttribute('src');
      if (appPreviewSource === null) throw new Error('The packed MCP App preview does not expose a proxy source.');
      appProxyOrigin = new URL(appPreviewSource, origin).origin;
      expect(appProxyOrigin).not.toBe(origin);
      await expect.poll(() => page.frames().filter((frame) => frame.url() === 'about:blank').length, { timeout: browserTimeout }).toBe(1);
      const appFrame = page.frames().find((frame) => frame.url() === 'about:blank');
      if (appFrame === undefined) throw new Error('The packed MCP App proxy did not create an App frame.');
      await expect(appFrame.locator('#view')).toHaveText('packed release dashboard', { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Inspector' }).click();
      await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
      const inspector = page.locator('[aria-label="MCP Inspector presentation"]');
      await expect(inspector.getByText('show-dashboard', { exact: true })).toBeVisible({ timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Playground' }).click();
      await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });

      phase = 'Logs, Evals, and Comparisons pages';
      await page.goto(`${origin}#logs`);
      phase = 'Logs page heading';
      await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
      const initialEvalsRequestIndex = browserRequests.length;
      await page.goto(`${origin}#evals`);
      phase = 'Evals page heading';
      await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
      phase = 'Evals suite catalog';
      await expect(page.getByLabel('Suite')).toContainText('packed-deterministic', { timeout: browserTimeout });
      await waitForBrowserRequestsAfter(initialEvalsRequestIndex);
      const initialComparisonsRequestIndex = browserRequests.length;
      await page.goto(`${origin}#comparisons`);
      phase = 'Comparisons page heading';
      await expect(page.getByRole('heading', { name: 'Comparisons' })).toBeVisible({ timeout: browserTimeout });
      await waitForBrowserRequestsAfter(initialComparisonsRequestIndex);

      phase = 'Playground direct skill';
      await page.goto(`${origin}#playground`);
      await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#playground-operation').selectOption('skill.inspect');
      await page.locator('#playground-target').selectOption('portable');
      await page.locator('#playground-skill-id').selectOption(skillId);
      await page.getByRole('button', { name: 'Start run' }).click();
      await expect(page.getByText('skill.inspected')).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('#playground-operation')).toBeEnabled({ timeout: browserTimeout });

      phase = 'Playground direct hook';
      await page.locator('#playground-operation').selectOption('hook.simulate');
      await page.locator('#playground-target').selectOption('claude');
      await page.locator('#playground-hook').selectOption(hookId);
      await expect(page.locator('#playground-hook-input')).toHaveValue(/workbench-preview/u);
      await page.getByRole('button', { name: 'Start run' }).click();
      await expect(page.getByText('hook.simulated')).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('#playground-operation')).toBeEnabled({ timeout: browserTimeout });

      phase = 'Playground direct script';
      await page.locator('#playground-operation').selectOption('script.run');
      await page.locator('#playground-target').selectOption('portable');
      await expect(page.locator('#playground-script-id option[value="script:review"]')).toBeAttached({ timeout: browserTimeout });
      await page.locator('#playground-script-id').selectOption('script:review');
      const scriptAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Run script' }).click();
      const scriptRun = record(record(await (await scriptAdmitted).json(), 'direct script admission').run, 'direct script run');
      const scriptSession = record(scriptRun.session, 'direct script session');
      const scriptSessionId = string(scriptSession.id, 'direct script session id');
      await expect(page.getByText('script.completed')).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.playground-trace')).toContainText('packed release script stdout', { timeout: browserTimeout });
      const scriptCompletedCard = page.locator('details.playground-event-card').filter({
        has: page.getByText('script.completed', { exact: true }),
      }).last();
      await expect(scriptCompletedCard).toBeVisible({ timeout: browserTimeout });
      const scriptCompletedCheckbox = scriptCompletedCard.getByRole('checkbox');
      const scriptCompletedLabel = await scriptCompletedCheckbox.getAttribute('aria-label');
      const scriptCompletedReference = /^Select (events\.jsonl#\d+) for the draft eval case$/u.exec(scriptCompletedLabel ?? '')?.[1];
      if (scriptCompletedReference === undefined) throw new Error('The completed direct script trace did not expose a persisted raw event reference.');
      const exportedScriptResponse = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/sessions/${encodeURIComponent(scriptSessionId)}/export` &&
        response.request().method() === 'GET' && response.ok(),
      );
      await page.getByRole('button', { name: 'Export trace' }).click();
      const exportedScriptTrace = record(record(await (await exportedScriptResponse).json(), 'direct script export response').export, 'direct script export');
      expect(string(record(exportedScriptTrace.session, 'direct script exported session').id, 'direct script exported session id')).toBe(scriptSessionId);
      expect(exportedScriptTrace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'script.completed', rawEventRef: scriptCompletedReference }),
      ]));
      await expect(page.getByRole('heading', { name: 'Exported trace' })).toBeVisible({ timeout: browserTimeout });
      const exportedScriptSection = page.getByRole('heading', { name: 'Exported trace' }).locator('..');
      await expect(exportedScriptSection).toContainText(scriptSessionId);
      await expect(exportedScriptSection).toContainText(scriptCompletedReference);
      const scriptSelectedCheckbox = scriptCompletedCheckbox;
      await scriptSelectedCheckbox.check();
      await expect(page.getByRole('button', { name: 'Promote to draft eval case' })).toBeEnabled({ timeout: browserTimeout });
      const promotedScriptResponse = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/sessions/${encodeURIComponent(scriptSessionId)}/draft-eval` &&
        response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Promote to draft eval case' }).click();
      const promotedScriptResult = await promotedScriptResponse;
      expect(promotedScriptResult.request().postDataJSON()).toEqual({ rawEventRefs: [scriptCompletedReference] });
      const promotedScriptDraft = record(record(await promotedScriptResult.json(), 'direct script draft response').draftEvalCase, 'direct script draft');
      const promotedScriptAssertion = firstRecord(promotedScriptDraft.assertions, 'direct script draft assertions');
      expect(record(promotedScriptAssertion.evidence, 'direct script draft evidence').rawEventRef).toBe(scriptCompletedReference);
      expect(record(promotedScriptAssertion.expectation, 'direct script draft expectation').kind).toBe('script.completed');
      await expect(page.getByRole('heading', { name: 'Draft eval case' })).toBeVisible({ timeout: browserTimeout });
      const promotedScriptSection = page.getByRole('heading', { name: 'Draft eval case' }).locator('..');
      await expect(promotedScriptSection).toContainText(scriptCompletedReference);
      await expect(promotedScriptSection).toContainText('script.completed');

      const activeEpochFrom = (toolResult: Awaited<ReturnType<typeof client.callTool>>, label: string) => {
        const resultStatus = record(record(toolResult.structuredContent, `${label} result`).status, `${label} status`);
        const artifactStatus = record(resultStatus.artifact, `${label} artifact`);
        const activeEpoch = record(artifactStatus.activeEpoch, `${label} active epoch`);
        return {
          artifactStatus,
          epochId: string(activeEpoch.id, `${label} epoch id`),
          modelDigest: string(activeEpoch.modelDigest, `${label} model digest`),
        };
      };
      const rebuildFromOverview = async (label: string): Promise<void> => {
        const rebuilt = page.waitForResponse((response) =>
          response.url() === `${origin}/api/project/rebuild` && response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Rebuild' }).click();
        const response = await rebuilt;
        if (!response.ok()) throw new Error(`${label} rebuild returned HTTP ${response.status()}: ${await response.text()}`);
      };
      const settleNativeSelection = (): Promise<void> => page.evaluate(async () => {
        await new Promise<void>((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise())));
      });
      const selectNativePrompt = async (prompt: string): Promise<void> => {
        await page.locator('#playground-operation').selectOption('native.prompt');
        await expect(page.locator('#playground-native-host')).toBeEnabled({ timeout: browserTimeout });
        await page.locator('#playground-native-target').selectOption('claude');
        await settleNativeSelection();
        await expect(page.locator('#playground-native-case option').nth(1)).toBeAttached({ timeout: browserTimeout });
        await page.locator('#playground-native-case').selectOption({ index: 1 });
        await settleNativeSelection();
        await page.locator('#playground-native-host').selectOption('claude');
        await settleNativeSelection();
        await expect(page.locator('#playground-native-fixture')).toBeEnabled({ timeout: browserTimeout });
        await page.locator('#playground-native-fixture').selectOption({ index: 1 });
        await settleNativeSelection();
        await expect(page.locator('#playground-native-model-pin')).toBeEnabled({ timeout: browserTimeout });
        await page.locator('#playground-native-model-pin').selectOption({ index: 1 });
        await page.locator('#playground-native-prompt').fill(prompt);
        await expect(page.getByRole('button', { name: 'Start native prompt' })).toBeEnabled({ timeout: browserTimeout });
      };

      phase = 'Playground native epoch A admission';
      await selectNativePrompt('Wait for packed native cancellation.');
      const nativeAAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Start native prompt' }).click();
      const nativeAAdmission = record(await (await nativeAAdmitted).json(), 'native epoch A admission');
      const nativeARunId = string(record(nativeAAdmission.run, 'native epoch A run').id, 'native epoch A run id');
      await expect(page.getByText('native.host.started')).toBeVisible({ timeout: browserTimeout });
      if (child?.pid === undefined) throw new Error('The packed dev server process did not expose a PID.');
      const nativeOperationDescendants = await descendantProcessIds(child.pid);
      expect(nativeOperationDescendants).not.toHaveLength(0);
      for (const processId of nativeOperationDescendants) {
        expect(processId).not.toBe(child.pid);
        observedOperationDescendantProcessIds.add(processId);
        trackedProcessIds.add(processId);
      }
      const nativeRequestA = nativeRequests.at(-1);
      if (nativeRequestA === undefined) throw new Error('The packed epoch-A native operation did not issue a request.');
      const nativeEpochA = string(nativeRequestA.epochId, 'epoch-A native request epoch id');
      const nativePinA = string(nativeRequestA.modelPinId, 'epoch-A native request model pin id');
      expect(nativeEpochA).toBe(epochId);

      phase = 'good edit rebuild B';
      const epochBMarker = 'Epoch B changed the packed review guidance.';
      await writeFile(skillSource, `${originalSkill}\n\n${epochBMarker}\n`);
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
      await rebuildFromOverview('epoch B');
      const epochBStatus = activeEpochFrom(await call('project_status'), 'epoch B');
      expect(epochBStatus.artifactStatus.state).toBe('active');
      const epochB = epochBStatus.epochId;
      expect(epochB).not.toBe(epochId);
      const sameClientOnB = await call('skills_list', { target: 'portable' });
      expect(record(sameClientOnB.structuredContent, 'same client epoch B skills').skills).toEqual(expect.any(Object));
      await expectGeneratedSkill('same client epoch B', epochB, epochBMarker);

      phase = 'artifact epoch diff';
      await page.getByRole('link', { name: 'Artifacts', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#artifact-diff-base').fill(epochId);
      await page.getByRole('button', { name: 'Compare builds' }).click();
      await expect(page.getByRole('heading', { name: 'Build comparison' })).toBeVisible({ timeout: browserTimeout });
      const changedRows = page.locator('.artifact-diff-group').filter({
        has: page.getByRole('heading', { name: /^Changed \([1-9][0-9]*\)$/u }),
      }).locator('tbody tr');
      await expect(changedRows).not.toHaveCount(0, { timeout: browserTimeout });
      const changedCells = await changedRows.first().locator('th, td').allTextContents();
      expect(changedCells).toHaveLength(5);
      expect(changedCells[0]).toContain('SKILL.md');
      expect(changedCells[1]).not.toBe(changedCells[3]);
      expect(changedCells[2]).not.toBe(changedCells[4]);

      phase = 'pinned epoch-A native cancellation';
      await page.getByRole('link', { name: 'Playground', exact: true }).click();
      await expect(page.getByText(nativeEpochA, { exact: true })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText(nativePinA, { exact: true })).toBeVisible({ timeout: browserTimeout });
      const nativeACancelled = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === `/api/playground/runs/${encodeURIComponent(nativeARunId)}/cancel` &&
          url.search.length === 0 && response.request().method() === 'POST' && response.status() === 200;
      });
      const cancelRun = page.getByRole('button', { name: 'Cancel run', exact: true });
      await cancelRun.click();
      await expect(page.getByRole('button', { name: 'Cancelling…', exact: true })).toBeVisible({ timeout: browserTimeout });
      expect(await (await nativeACancelled).json()).toEqual({ cancelled: true });
      await expect(page.getByRole('button', { name: 'Cancelling…', exact: true })).toBeHidden({ timeout: browserTimeout });
      await expect(cancelRun).toBeDisabled({ timeout: browserTimeout });
      await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });

      phase = 'invalid edit retains stale epoch B';
      const lastGoodEpochBStatus = activeEpochFrom(await call('project_status'), 'last-good epoch B');
      expect(lastGoodEpochBStatus.artifactStatus.state).toBe('active');
      const lastGoodEpochB = lastGoodEpochBStatus.epochId;
      await expectGeneratedSkill('last-good epoch B', lastGoodEpochB, epochBMarker);
      const invalidConfig = originalConfig.replace('ui://packed-release/dashboard.html', 'https://packed-release.example/dashboard.html');
      if (invalidConfig === originalConfig) throw new Error('The packed fixture did not contain the resource URI used for the invalid rebuild.');
      await writeFile(configSource, invalidConfig);
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
      await rebuildFromOverview('invalid epoch B');
      const staleStatus = activeEpochFrom(await call('project_status'), 'stale epoch B');
      expect(staleStatus.artifactStatus.state).toBe('stale');
      expect(staleStatus.modelDigest).toBe(lastGoodEpochBStatus.modelDigest);
      const staleDiagnostics = await client.callTool({ name: 'diagnostics_list' });
      const staleDiagnosticRows = record(staleDiagnostics.structuredContent, 'stale diagnostics').diagnostics;
      expect(Array.isArray(staleDiagnosticRows)).toBe(true);
      expect(staleDiagnosticRows).not.toHaveLength(0);
      await expectGeneratedSkill('stale epoch B', staleStatus.epochId, epochBMarker);

      phase = 'repaired edit rebuild C';
      const epochCMarker = 'Epoch C repaired the packed review guidance.';
      await Promise.all([
        writeFile(configSource, originalConfig),
        writeFile(skillSource, `${originalSkill}\n\n${epochCMarker}\n`),
      ]);
      await rebuildFromOverview('epoch C');
      const epochCStatus = activeEpochFrom(await call('project_status'), 'epoch C');
      expect(epochCStatus.artifactStatus.state).toBe('active');
      const epochC = epochCStatus.epochId;
      expect(epochC).not.toBe(lastGoodEpochB);
      const retainedEpochA = await call('skills_list', { epoch: epochId, target: 'portable' });
      expect(record(retainedEpochA.structuredContent, 'retained epoch-A skills').skills).toEqual(expect.any(Object));
      await expectGeneratedSkill('same client epoch C', epochC, epochCMarker);

      phase = 'Playground native fake-host epoch C';
      await page.getByRole('link', { name: 'Playground', exact: true }).click();
      await selectNativePrompt('Complete the packed native fixture.');
      const nativeCAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Start native prompt' }).click();
      expect(record(await (await nativeCAdmitted).json(), 'native epoch C admission').run).toEqual(expect.any(Object));
      await expect(page.getByText('native.response')).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('Packed native fixture completed.', { exact: true })).toBeVisible({ timeout: browserTimeout });
      const nativeRequestC = nativeRequests.at(-1);
      if (nativeRequestC === undefined) throw new Error('The packed epoch-C native operation did not issue a request.');
      expect(string(nativeRequestC.epochId, 'epoch-C native request epoch id')).toBe(epochC);

      phase = 'Logs after rebuilds';
      type ReplayResponse = Awaited<ReturnType<typeof page.waitForResponse>>;
      const logsReplayResponses: ReplayResponse[] = [];
      let logsReplayWaiter: ReturnType<typeof Promise.withResolvers<ReplayResponse>> | undefined;
      const collectLogsReplay = (response: ReplayResponse): void => {
        if (new URL(response.url()).pathname !== '/api/logs/replay') return;
        if (logsReplayWaiter !== undefined) {
          logsReplayWaiter.resolve(response);
          logsReplayWaiter = undefined;
        } else {
          logsReplayResponses.push(response);
        }
      };
      const nextLogsReplay = (): Promise<ReplayResponse> => {
        const response = logsReplayResponses.shift();
        if (response !== undefined) return Promise.resolve(response);
        logsReplayWaiter = Promise.withResolvers<ReplayResponse>();
        return logsReplayWaiter.promise;
      };
      page.on('response', collectLogsReplay);
      await page.getByRole('link', { name: 'Logs', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
      let logsReplayDocument: unknown;
      while (logsReplayDocument === undefined) {
        const candidate = await nextLogsReplay();
        if (!candidate.ok()) {
          throw new Error(`The packed Logs replay route returned HTTP ${candidate.status()}: ${await candidate.text().catch(() => '')}`);
        }
        try {
          logsReplayDocument = await candidate.json();
        } catch {
          // The Logs page may abort an old replay while settling. Wait for the
          // newest response whose body remains readable.
        }
      }
      page.off('response', collectLogsReplay);
      const logsReplayPayload = record(record(logsReplayDocument, 'packed Logs replay').replay, 'packed Logs replay result');
      const logRecords = logsReplayPayload.records;
      if (!Array.isArray(logRecords) || logRecords.length === 0) {
        throw new Error(`The packed Logs replay is empty after B/C rebuilds: ${JSON.stringify(logRecords)}`);
      }
      await expect.poll(async () => page.locator('.logs-entries > li').count(), { timeout: browserTimeout }).toBeGreaterThan(0);
      const hookLog = logRecords.map((value, index) => record(value, `packed log record ${index}`)).find((value) =>
        value.producer === 'hook' && value.kind === 'hook.simulate.completed',
      );
      if (hookLog === undefined) throw new Error('The packed Logs replay did not retain a completed Hook simulation record.');
      const hookLogText = JSON.stringify(hookLog);
      expect(hookLogText).not.toContain('/workspace');
      expect(hookLogText).not.toContain(agentApiToken);
      if (typeof hookLog.sequence !== 'number') throw new Error('The completed Hook log record does not have a numeric sequence.');
      const hookLogSequence = String(hookLog.sequence);
      const hookLogEntry = page.locator('.logs-entries > li').filter({ hasText: `#${hookLogSequence}` });
      await expect(hookLogEntry).toContainText('hook.simulate.completed', { timeout: browserTimeout });
      await hookLogEntry.locator('summary').click();
      await expect(hookLogEntry.locator('.logs-details')).toContainText('outcome');
      await expect(hookLogEntry.locator('.logs-details')).not.toContainText('/workspace');

      phase = 'Logs live Agent API update and filters';
      const logsUrlBeforeLiveUpdate = page.url();
      const logEntriesBeforeLiveUpdate = await page.locator('.logs-entries > li').count();
      const latestLogSequenceBeforeLiveUpdate = Number.parseInt(
        (await page.locator('.logs-entry-sequence').first().innerText()).replace(/^#/u, ''),
        10,
      );
      expect(latestLogSequenceBeforeLiveUpdate).toBeGreaterThan(0);
      const liveHookSimulation = await call('hook_simulate', {
        epoch: epochC,
        hook: hookId,
        input: {
          cwd: '/workspace',
          sessionId: 'packed-live-logs',
          source: 'packed-live-logs',
          transcriptPath: '/workspace/packed-live-logs.json',
        },
        target: 'claude',
      });
      expect(record(record(liveHookSimulation.structuredContent, 'live Hook simulation').simulation, 'live Hook simulation result').canonicalResult)
        .toEqual(expect.objectContaining({ outcome: 'continue' }));
      await expect.poll(async () => page.locator('.logs-entries > li').count(), { timeout: browserTimeout })
        .toBeGreaterThan(logEntriesBeforeLiveUpdate);
      expect(page.url()).toBe(logsUrlBeforeLiveUpdate);

      const expectedLiveLogProducer = 'hook';
      await page.locator('#logs-producer').selectOption(expectedLiveLogProducer);
      await page.locator('#logs-level').selectOption('info');
      await page.locator('#logs-kind').selectOption('hook.simulate.completed');
      await page.locator('#logs-context').selectOption(hookId);
      const matchingLiveHookEntries = page.locator('.logs-entries > li');
      await expect.poll(async () => matchingLiveHookEntries.count(), { timeout: browserTimeout }).toBeGreaterThan(0);
      expect([...new Set(await matchingLiveHookEntries.locator('.logs-entry-source').allTextContents())]).toEqual(['hook']);
      expect([...new Set(await matchingLiveHookEntries.locator('.logs-entry-level').allTextContents())]).toEqual(['info']);
      expect([...new Set(await matchingLiveHookEntries.locator('.logs-entry-kind').allTextContents())]).toEqual(['hook.simulate.completed']);
      await expect(matchingLiveHookEntries.first()).toContainText(`hookId ${hookId}`);
      await expect(matchingLiveHookEntries.first().locator('.logs-details')).toContainText('outcome');
      expect(Number.parseInt(
        (await matchingLiveHookEntries.first().locator('.logs-entry-sequence').innerText()).replace(/^#/u, ''),
        10,
      )).toBeGreaterThan(latestLogSequenceBeforeLiveUpdate);
      await page.locator('#logs-level').selectOption('error');
      await expect.poll(async () => matchingLiveHookEntries.count(), { timeout: browserTimeout }).toBe(0);
      await expect(page.getByText('No production log record matches this filter.')).toBeVisible({ timeout: browserTimeout });

      phase = 'Agent API Eval tools';
      const listed = await call('evals_list');
      const suites = record(record(listed.structuredContent, 'eval list').suites, 'eval suites').suites;
      expect(suites).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'packed-deterministic' }),
        expect.objectContaining({ name: 'packed-native' }),
      ]));
      const started = await call('eval_run', {
        case_ids: ['deterministic-review'], suites: ['packed-deterministic'], trials: 1,
      });
      const startedPayload = record(started.structuredContent, 'eval start');
      if (startedPayload.run === undefined) {
        const agentEvalList = await client.callTool({ name: 'evals_list' });
        const diagnostics = await client.callTool({ name: 'diagnostics_list' });
        const bootstrap = await fetch(`${origin}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
        const session = record(await bootstrap.json(), 'browser session');
        const list = await fetch(`${origin}/api/evals/runs`, {
          headers: { 'x-agent-bundle-session': string(session.token, 'browser session token') },
        });
        const listedRuns = record(await list.json(), 'public eval runs').runs;
        const runProbes = await Promise.all((Array.isArray(listedRuns) ? listedRuns : []).map(async (listedRun) => {
          const runId = string(record(listedRun, 'public eval run').id, 'public eval run id');
          const [run, events] = await Promise.all([
            fetch(`${origin}/api/evals/runs/${encodeURIComponent(runId)}`, {
              headers: { 'x-agent-bundle-session': string(session.token, 'browser session token') },
            }),
            fetch(`${origin}/api/evals/runs/${encodeURIComponent(runId)}/events?after=0`, {
              headers: { 'x-agent-bundle-session': string(session.token, 'browser session token') },
            }),
          ]);
          return {
            events: { body: await events.text(), status: events.status },
            run: { body: await run.text(), status: run.status },
            runId,
          };
        }));
        throw new Error(`The packed deterministic eval did not start: ${JSON.stringify({
          agentEvalList: agentEvalList.structuredContent,
          diagnostics: diagnostics.structuredContent,
          postFailureRuns: runProbes,
          started: startedPayload,
        })}; CLI stderr: ${commandStderr}`);
      }
      const run = record(startedPayload.run, 'started eval');
      const runId = string(run.id, 'run id');
      await expect.poll(async () => {
        const read = await client.callTool({ arguments: { run_id: runId }, name: 'eval_get' });
        const result = record(record(read.structuredContent, 'eval read').run, 'recorded eval result');
        return record(result.run, 'recorded eval').completedAt;
      }, { timeout: browserTimeout }).toEqual(expect.any(String));
      const completedAgentEval = record(record((await client.callTool({ arguments: { run_id: runId }, name: 'eval_get' })).structuredContent, 'completed eval read').run, 'completed recorded eval');
      const completedAgentRun = record(completedAgentEval.run, 'completed agent eval run');
      expect(completedAgentRun.completedAt).toEqual(expect.any(String));
      const completedAgentSummary = record(completedAgentRun.summary, 'completed agent eval summary');
      expect(completedAgentSummary).toEqual({ cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 });
      expect(completedAgentEval.trials).toEqual(expect.arrayContaining([
        expect.objectContaining({ caseId: 'deterministic-review', host: 'portable', model: 'deterministic', outcome: 'pass' }),
      ]));
      called.add('eval_get');

      phase = 'Evals live evidence and comparisons';
      const evalsBrowserRequestIndex = browserRequests.length;
      await page.getByRole('link', { name: 'Evals', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
      await page.getByLabel('Suite').selectOption('packed-deterministic');
      await page.getByLabel('Harness').selectOption('deterministic');
      const uiEvalAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202,
      );
      await page.getByRole('button', { name: 'Run deterministic suite' }).click();
      const uiEval = record(await (await uiEvalAdmitted).json(), 'browser eval admission').run;
      const uiEvalRunId = string(record(uiEval, 'browser eval run').id, 'browser eval run id');
      phase = 'Evals UI completion';
      try {
        await expect(page.getByText(`Run ${uiEvalRunId} finished:`)).toBeVisible({ timeout: browserTimeout });
      } catch (error) {
        throw new Error(`The packed browser eval did not render its finalized run: ${JSON.stringify({
          errors: await page.locator('.request-error').allTextContents(),
          summaries: await page.locator('.eval-summary').allTextContents(),
          timeline: await page.locator('.eval-timeline strong').allTextContents(),
        })}`, { cause: error });
      }
      phase = 'Evals durable evidence';
      await expect(page.getByRole('heading', { name: 'Durable event timeline' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('heading', { name: 'Host / model matrix' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.eval-counts')).toHaveText('1 passed · 0 failed · 0 inconclusive', { timeout: browserTimeout });
      await expect(page.locator('.eval-timeline .eval-event-sequence')).not.toHaveCount(0, { timeout: browserTimeout });
      await expect(page.locator('.eval-timeline')).toContainText('run.completed');
      await expect(page.locator('.eval-host-models')).toContainText('portable');
      await expect(page.locator('.eval-host-models')).toContainText('deterministic');
      await expect(page.locator('.eval-host-models')).toContainText('Pass');
      await expect(page.locator('.eval-trial-provenance').first()).toContainText('agent-bundle@0.1.0');
      await expect(page.locator('.eval-trial-provenance').first()).toContainText('automatic');
      await page.getByRole('button', { name: 'Preview safe text' }).first().click();
      await expect(page.locator('.eval-raw-result')).toContainText('The deterministic packed fixture passed.', { timeout: browserTimeout });
      await waitForBrowserRequestsAfter(evalsBrowserRequestIndex);
      phase = 'Evals comparison run availability';
      await page.getByRole('link', { name: 'Comparisons', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Comparisons' })).toBeVisible({ timeout: browserTimeout });
      await expect.poll(async () => page.locator('#comparison-base option').count(), { timeout: browserTimeout }).toBeGreaterThanOrEqual(2);
      phase = 'Evals comparison matrix';
      await page.locator('#comparison-base').selectOption(runId);
      await page.locator('#comparison-candidate').selectOption(uiEvalRunId);
      await page.getByRole('button', { name: 'Compare runs' }).click();
      await expect(page.locator('.comparison-matrix table')).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.comparison-matrix')).toContainText(
        'CLI agent-bundle@0.1.0 · Invocation automatic · Semantic grader none',
      );

      phase = 'foreground restart/reconnect';
      const comparisonsHashBeforeRestart = new URL(page.url()).hash;
      expect(comparisonsHashBeforeRestart).toBe('#comparisons');
      if (child === undefined) throw new Error('The packed dev server child was not created.');
      const stoppedChild = child;
      if (stoppedChild.pid !== undefined) {
        trackedProcessIds.add(stoppedChild.pid);
        for (const processId of await descendantProcessIds(stoppedChild.pid)) trackedProcessIds.add(processId);
      }
      const outageStartedAt = Date.now();
      const recoveredBrowserSession = page.waitForResponse((response) =>
        response.url() === `${origin}/api/project/session` && response.request().method() === 'GET' && response.ok(),
      );
      await closeChild(stoppedChild);
      phase = 'foreground restart/reconnect disconnected state';
      await expect(page.getByRole('heading', { name: 'Foreground connection unavailable' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('Waiting for the foreground server to recover.')).toBeVisible({ timeout: browserTimeout });
      phase = 'foreground restart/reconnect browser recovery';
      child = startInstalledServer(port);
      await awaitReady(origin, child, () => commandOutput);
      await expect(page.locator('.connection')).toContainText('Foreground server connected', { timeout: browserTimeout });
      const recoveredBrowserSessionResponse = await recoveredBrowserSession;
      const recoveredBrowserSessionPayload = record(await recoveredBrowserSessionResponse.json(), 'recovered browser session');
      const browserGenerationBToken = string(recoveredBrowserSessionPayload.token, 'recovered browser session token');
      const recoveredBrowserSessionRequest = browserRequestByPlaywrightRequest.get(recoveredBrowserSessionResponse.request());
      if (recoveredBrowserSessionRequest?.completedAt === undefined) throw new Error('The recovered browser session was not recorded as a completed request.');
      const recoveredAt = recoveredBrowserSessionRequest.completedAt;
      expect(new URL(page.url()).hash).toBe(comparisonsHashBeforeRestart);
      await expect(page.getByRole('heading', { name: 'Comparisons' })).toBeVisible({ timeout: browserTimeout });
      const rebuiltWithRecoveredSession = page.waitForResponse((response) =>
        response.url() === `${origin}/api/project/rebuild` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await page.getByRole('button', { name: 'Rebuild' }).click();
      const rebuiltWithRecoveredSessionResponse = await rebuiltWithRecoveredSession;
      expect(rebuiltWithRecoveredSessionResponse.request().headers()['x-agent-bundle-session']).toBe(browserGenerationBToken);
      phase = 'foreground restart/reconnect Agent API recovery';
      const recoveredStatus = await client.callTool({ name: 'project_status' });
      const recoveredEpochStatus = activeEpochFrom(recoveredStatus, 'recovered project status');
      expect(recoveredEpochStatus.artifactStatus).toEqual(expect.objectContaining({ state: 'active' }));
      const recoveredEpochId = recoveredEpochStatus.epochId;

      phase = 'foreground restart/reconnect fresh B browser MCP session';
      await page.getByRole('link', { name: 'MCP playground', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('button', { name: 'Open MCP session' })).toBeEnabled({ timeout: browserTimeout });
      await expect(page.locator('#mcp-epoch')).toHaveValue(recoveredEpochId, { timeout: browserTimeout });
      await expect(page.locator('#mcp-target')).toHaveValue('portable');
      await expect(page.locator('#mcp-server-name')).toHaveValue('fixture');
      const openedBrowserMcpSessionB = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Open MCP session' }).click();
      const browserMcpSessionBResponse = await openedBrowserMcpSessionB;
      expect(browserMcpSessionBResponse.request().headers()['x-agent-bundle-session']).toBe(browserGenerationBToken);
      const browserMcpSessionB = record(await browserMcpSessionBResponse.json(), 'B browser MCP session response');
      const browserMcpSessionBRecord = record(browserMcpSessionB.session, 'B browser MCP session');
      const browserMcpSessionBId = string(browserMcpSessionBRecord.id, 'B browser MCP session id');
      const browserMcpSessionBRequest = browserRequestByPlaywrightRequest.get(browserMcpSessionBResponse.request());
      if (browserMcpSessionBRequest === undefined) throw new Error('The fresh B browser MCP session admission was not recorded.');
      const browserMcpSessionBOpenedAt = browserMcpSessionBRequest.at;
      expect(browserMcpSessionBId).not.toBe(oldBrowserMcpSessionId);
      expect(record(browserMcpSessionBRecord.binding, 'B browser MCP session binding').epochId).toBe(recoveredEpochId);
      await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
      await page.getByRole('button', { name: 'show-dashboard', exact: true }).click();
      const browserMcpSessionBOperation = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions/${encodeURIComponent(browserMcpSessionBId)}/operations` &&
        response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Call show-dashboard' }).click();
      await browserMcpSessionBOperation;
      await expect(page.getByRole('region', { name: 'Invocation history' })).toContainText('packed dashboard ready', { timeout: browserTimeout });
      const closedBrowserMcpSessionB = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions/${encodeURIComponent(browserMcpSessionBId)}` &&
        response.request().method() === 'DELETE' && response.ok(),
      );
      const browserMcpSessionBCloseStartedAt = Date.now();
      await page.getByRole('button', { name: 'Close MCP session' }).click();
      const closedBrowserMcpSessionBResponse = await closedBrowserMcpSessionB;
      expect(closedBrowserMcpSessionBResponse.request().headers()['x-agent-bundle-session']).toBe(browserGenerationBToken);
      await expect(page.locator('.mcp-page-phase')).toContainText('Session closed', { timeout: browserTimeout });
      const browserMcpSessionBCloseCompletedAt = Date.now();

      phase = 'desktop navigation floor';
      await page.setViewportSize({ height: 900, width: 1440 });
      const mobileNavigationRequestIndex = browserRequests.length;
      const mobileRoutes: readonly Readonly<{ heading: string; label: string }>[] = [
        { heading: 'Bundle dashboard', label: 'Overview' }, { heading: 'Skills', label: 'Skills' }, { heading: 'Hooks', label: 'Hooks' },
        { heading: 'MCP playground', label: 'MCP playground' }, { heading: 'Artifacts', label: 'Artifacts' }, { heading: 'Playground', label: 'Playground' },
        { heading: 'Logs', label: 'Logs' }, { heading: 'Evals', label: 'Evals' }, { heading: 'Comparisons', label: 'Comparisons' },
      ];
      const postRecoveryNavigationUrls = new Map<string, readonly string[]>([
        ['Hooks', [`${origin}/api/hooks?epochId=${encodeURIComponent(recoveredEpochId)}`]],
        ['MCP playground', [`${origin}/api/artifacts/epochs/${encodeURIComponent(recoveredEpochId)}`]],
        ['Playground', [`${origin}/api/playground/catalog?epochId=${encodeURIComponent(recoveredEpochId)}`]],
        ['Logs', [`${origin}/api/logs/replay?after=0`]],
        ['Evals', [`${origin}/api/evals/suites`, `${origin}/api/evals/runs`]],
        ['Comparisons', [`${origin}/api/evals/runs`]],
      ]);
      const respondedNavigationStreams = new Set<string>();
      const postRecoveryNavigation: Array<Readonly<{
        leftAt: number;
        openedAt: number;
        respondedStream?: true;
        url: string;
      }>> = [];
      let activeMobileRoute: Readonly<{ openedAt: number; urls?: readonly string[] }> | undefined;
      const leaveActiveMobileRoute = (leftAt: number): void => {
        if (activeMobileRoute === undefined) return;
        for (const url of activeMobileRoute.urls ?? []) postRecoveryNavigation.push(Object.freeze({
          leftAt,
          openedAt: activeMobileRoute.openedAt,
          ...(respondedNavigationStreams.has(url) ? { respondedStream: true as const } : {}),
          url,
        }));
        activeMobileRoute = undefined;
      };
      for (const route of mobileRoutes) {
        const openedAt = Date.now();
        leaveActiveMobileRoute(openedAt);
        const logsStreamResponse = route.label === 'Logs'
          ? page.waitForResponse((response) => {
            const url = new URL(response.url());
            return response.request().method() === 'GET' && url.origin === origin &&
              url.pathname === '/api/logs/stream' && hasCanonicalAfterCursor(url);
          // Wider than the interaction budget for a loaded runner, but finite:
          // a stream that never responds must fail the test, not hang the job.
          }, { timeout: browserTimeout * 5 })
          : undefined;
        await page.getByRole('link', { name: route.label, exact: true }).click();
        await expect(page.getByRole('heading', { name: route.heading })).toBeVisible({ timeout: browserTimeout });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const routeUrls = [...(postRecoveryNavigationUrls.get(route.label) ?? [])];
        if (route.label === 'Logs') {
          const response = await logsStreamResponse;
          if (response === undefined || !response.ok()) throw new Error('The Logs navigation stream did not return a successful response.');
          const streamUrl = response.url();
          const stream = browserRequestByPlaywrightRequest.get(response.request());
          if (
            stream === undefined || stream.at < openedAt || stream.respondedAt === undefined ||
            stream.status !== response.status()
          ) throw new Error('The Logs navigation stream response was not recorded in the network ledger.');
          respondedNavigationStreams.add(streamUrl);
          routeUrls.push(streamUrl);
        }
        activeMobileRoute = Object.freeze({ openedAt, urls: Object.freeze(routeUrls) });
      }
      leaveActiveMobileRoute(Date.now());
      await page.getByRole('link', { name: 'Overview', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
      await waitForBrowserRequestsAfter(mobileNavigationRequestIndex);

      phase = 'foreground outage ledger quiet fence';
      const requestFailuresBeforeQuietFence = browserRequests.filter((request) => request.error !== undefined);
      const quietFenceBaseline = Object.freeze({
        consoleErrors: consoleErrorRecords.length,
        pageErrors: pageErrors.length,
        requestFailures: requestFailuresBeforeQuietFence.length,
      });
      await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 1_000); });
      const requestFailuresAfterQuietFence = browserRequests.filter((request) => request.error !== undefined);
      assertOutageLedger(consoleErrorRecords.length === quietFenceBaseline.consoleErrors && pageErrors.length === quietFenceBaseline.pageErrors &&
        requestFailuresAfterQuietFence.length === quietFenceBaseline.requestFailures,
      `quiet fence observed new console, page, or requestfailed events: ${JSON.stringify({
        after: { consoleErrors: consoleErrorRecords.length, pageErrors: pageErrors.length, requestFailures: requestFailuresAfterQuietFence.length },
        before: quietFenceBaseline,
        newRequestFailures: requestFailuresAfterQuietFence.slice(requestFailuresBeforeQuietFence.length),
      })}`);
      validateOutageLedger({
        consoleErrors: consoleErrorRecords,
        oldSessionId: oldBrowserMcpSessionId,
        origin,
        outageStartedAt,
        postRecovery: Object.freeze({
          freshMcpSession: Object.freeze({
            closeCompletedAt: browserMcpSessionBCloseCompletedAt,
            closeStartedAt: browserMcpSessionBCloseStartedAt,
            id: browserMcpSessionBId,
            openedAt: browserMcpSessionBOpenedAt,
          }),
          navigation: Object.freeze(postRecoveryNavigation),
        }),
        recoveredAt,
        requests: browserRequests,
      });

      phase = 'browser console and page errors';
      const diagnostics = await call('diagnostics_list');
      expect(record(diagnostics.structuredContent, 'diagnostic list').diagnostics).toEqual(expect.any(Array));
      expect([...called]).toEqual(expectedAgentApiToolNames);
      if (pageErrors.length > 0) {
        const iframeSources = await page.locator('iframe').evaluateAll((frames) => frames.map((frame) => Object.freeze({
          src: frame.getAttribute('src'),
          title: frame.getAttribute('title'),
        })));
        throw new Error(`Chrome reported errors: ${JSON.stringify({
          appRouteRequests,
          consoleErrors: consoleErrorRecords,
          failedAppRouteRequests,
          frames: page.frames().map((frame) => Object.freeze({
            parentUrl: frame.parentFrame()?.url(),
            url: frame.url(),
          })),
          iframeSources,
          pageErrors: pageErrors.map((error) => error.message),
        })}`);
      }
      expect(appRouteRequests).not.toHaveLength(0);
      expect(appRouteRequests.every((request) => typeof request.status === 'number' && request.status < 400)).toBe(true);
      expect(appRouteRequests.some((request) => request.method === 'POST' && /^\/api\/mcp\/sessions\/[^/]+\/apps$/u.test(string(request.path, 'App route path')) && request.status === 200)).toBe(true);
      expect(appRouteRequests.some((request) => request.method === 'GET' && /^\/api\/mcp\/apps\/[^/]+$/u.test(string(request.path, 'App route path')))).toBe(false);
      expect(failedAppRouteRequests).toEqual([]);

      phase = 'packed installed-product shutdown';
      await client.close();
      clientClosed = true;
      if (child === undefined) throw new Error('The packed dev server child was not created.');
      if (child.pid !== undefined) {
        trackedProcessIds.add(child.pid);
        for (const processId of await descendantProcessIds(child.pid)) trackedProcessIds.add(processId);
      }
      expect(observedOperationDescendantProcessIds.size).toBeGreaterThan(0);
      await closeChild(child);
      expect(child.exitCode).not.toBeNull();
      for (const shutdownOrigin of new Set([origin, appProxyOrigin].filter((value): value is string => value !== undefined))) {
        await expect.poll(async () => {
          try {
            await fetch(shutdownOrigin);
            return false;
          } catch {
            return true;
          }
        }, { timeout: browserTimeout }).toBe(true);
      }
      await expect(access(join(project, '.agent-bundle', 'dev.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      const leakedProductTemporaryRoots = (await readdir(tmpdir())).filter((root) =>
        productTemporaryRootPrefixes.some((prefix) => root.startsWith(prefix)) && !productTemporaryRootsBefore.has(root),
      );
      expect(leakedProductTemporaryRoots).toEqual([]);
      const nativeWorkspaceEntries = await readdir(join(project, '.agent-bundle'));
      expect(nativeWorkspaceEntries.filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
      for (const processId of trackedProcessIds) {
        await expect.poll(() => {
          try {
            process.kill(processId, 0);
            return false;
          } catch {
            return true;
          }
        }, { timeout: browserTimeout }).toBe(true);
      }
      expect(commandOutput).not.toContain(agentApiToken);
      expect(commandOutput).not.toContain('"authMethod"');
    } finally {
      if (!clientClosed) await client.close();
    }
  } catch (error) {
    primaryFailure = new Error(`Packed dogfood phase ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    const cleanupFailures: unknown[] = [];
    if (child !== undefined) {
      try { await closeChild(child); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await rm(consumer, { force: true, recursive: true }); }
    catch (error) { cleanupFailures.push(error); }
    try { await access(consumer); cleanupFailures.push(new Error(`Packed consumer temporary directory still exists: ${consumer}`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) cleanupFailure = new AggregateError(cleanupFailures, 'Packed release cleanup failed.');
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], 'Packed release test and cleanup both failed.', { cause: primaryFailure });
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
