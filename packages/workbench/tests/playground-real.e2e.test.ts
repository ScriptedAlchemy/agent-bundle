import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { agentBundleNodeModules, workbenchNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { buildWorkbench, workbenchUrl } from './support/workbench-e2e.ts';

const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 8_000 * timeScale;
const nativePathFallback = `${dirname(process.execPath)}:/usr/bin:/bin`;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const writeFakeClaude = async (directory: string): Promise<void> => {
  const executable = join(directory, 'claude');
  const implementation = join(directory, 'claude.mjs');
  await Promise.all([
    writeFile(executable, '#!/bin/sh\nexec node "$(dirname "$0")/claude.mjs" "$@"\n'),
    writeFile(implementation, [
      "import { writeFileSync } from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write('2.1.240 (Claude Code)\\n'); process.exit(0); }",
      "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('{\"authMethod\":\"claude.ai\",\"loggedIn\":true,\"subscriptionType\":\"max\"}\\n'); process.exit(0); }",
      `const prompt = args.at(-1) ?? '';`,
      "if (prompt.includes('Gate native Playground run')) { setInterval(() => undefined, 1_000); }",
      "writeFileSync('result.json', '{\"risk\":\"native-completed\"}\\n');",
      'process.stdout.write([',
      "  '{\"type\":\"system\",\"subtype\":\"init\",\"plugins\":[{\"name\":\"playground-real-fixture\"}],\"mcp_servers\":[{\"name\":\"project\"}]}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Skill\",\"input\":{\"skill\":\"playground-real-fixture:review\"}}]}}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"mcp__project__status_report\",\"input\":{}}]}}',",
      "  '{\"type\":\"system\",\"hook_event_name\":\"SessionStart\"}',",
      "  '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"duration_ms\":42,\"num_turns\":2,\"result\":\"Native fixture completed.\",\"usage\":{\"input_tokens\":9,\"output_tokens\":3}}',",
      "  '',",
      "].join('\\n'));",
      '',
    ].join('\n')),
  ]);
  await chmod(executable, 0o755);
};

const writePlaygroundProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'evals', 'fixtures', 'native'), { recursive: true }),
    mkdir(join(root, 'evals', 'graders'), { recursive: true }),
    mkdir(join(root, 'src', 'hooks'), { recursive: true }),
    symlink(join(agentBundleNodeModules, '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
    symlink(join(workbenchNodeModules, 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'node_modules', 'agent-bundle', 'package.json'), JSON.stringify({
      exports: { '.': './index.ts', './eval': './eval.ts' },
      name: 'agent-bundle',
      type: 'module',
    })),
    writeFile(join(root, 'node_modules', 'agent-bundle', 'eval.ts'),
      `export * from ${JSON.stringify(join(workspaceRoot, 'packages', 'agent-bundle', 'src', 'eval', 'index.ts'))};\n`),
    writeFile(join(root, 'evals', 'fixtures', 'native', 'input.txt'), 'Native Playground fixture.\n'),
    writeFile(join(root, 'evals', 'graders', 'native-result.ts'), [
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      '',
      'export default async ({ fixturePath }: { fixturePath: string }) => {',
      "  const result = await readFile(join(fixturePath, 'result.json'), 'utf8');",
      "  return result.includes('native-completed')",
      "    ? { detail: 'The native host completed the fixture.', outcome: 'pass' }",
      "    : { detail: 'The native host did not complete the fixture.', outcome: 'fail' };",
      '};',
      '',
    ].join('\n')),
    writeFile(join(root, 'evals', 'native.eval.ts'), [
      "import { defineEvalSuite, expectExitCode, expectMcpCall, expectOutcome, expectSkillActivation } from 'agent-bundle/eval';",
      '',
      'export default defineEvalSuite({',
      '  cases: [{',
      "    assertions: [expectExitCode(0), expectMcpCall({ server: 'project', tool: 'status_report' }), expectOutcome({ script: './graders/native-result.ts' }), expectSkillActivation({ minimumEvidence: 'observed', skill: 'review' })],",
      "    fixture: './fixtures/native',",
      "    hosts: { claude: { model: 'claude-sonnet-4-5' } },",
      "    id: 'native-review',",
      "    invocation: { mode: 'explicit', skill: 'review' },",
      "    prompt: 'Review the native fixture.',",
      '    trials: 1,',
      '  }],',
      "  name: 'native-playground',",
      '});',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'hooks', 'session-start.ts'), [
      'export default (event: { source?: string }) => ({',
      "  additionalContext: `playground:${event.source}`,",
      "  outcome: 'continue' as const,",
      '});',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'review.ts'), [
      "process.stdout.write('playground script stdout\\n');",
      "process.stderr.write('playground script stderr\\n');",
      'process.exitCode = 17;',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'large-output.ts'), "process.stdout.write('x'.repeat(64 * 1024));\n"),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      "import { z } from 'zod';",
      '',
      "const server = new McpServer({ name: 'playground-real-fixture', version: '1.0.0' });",
      "server.registerTool('echo', { description: 'Echo one message.', inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({",
      "  content: [{ type: 'text', text: `Echo: ${message}` }],",
      '}));',
      "server.registerTool('wait', { description: 'Wait until the foreground cancels this operation.' }, async () => new Promise(() => {}));",
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  hooks: { sessionStart: './src/hooks/session-start.ts' },",
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'playground-real-fixture', version: '1.0.0' },",
      "  scripts: { large: './src/large-output.ts', review: './src/review.ts' },",
      "  skills: ['src/skills/review'],",
      "  targets: ['claude'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

const runRequest = (origin: string) => (response: { readonly request: () => { readonly method: () => string }; readonly url: () => string }): boolean =>
  response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST';

interface PlaygroundAdmission {
  readonly run: {
    readonly session: {
      readonly id: string;
      readonly identity: { readonly epoch: { readonly digest: string; readonly id: string } };
    };
  };
}

e2e('executes server-owned Playground operations with pinned traces, export, promotion, and cancellation', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  let project: Awaited<ReturnType<typeof createProjectFixture>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    project = await createProjectFixture();
    await writePlaygroundProject(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root: project.root,
    });
    const runBodies: unknown[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: Error[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`${message.text()} (${message.location().url})`);
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url() === `${server!.url}/api/playground/runs` && request.method() === 'POST') {
        runBodies.push(JSON.parse(request.postData() ?? 'null'));
      }
    });

    await page.goto(workbenchUrl(server.url, 'hooks'));
    await expect(page.getByRole('heading', { name: 'Hooks' })).toBeVisible({ timeout: browserTimeout });
    const hookOption = page.locator('#hook-binding option').first();
    await expect(hookOption).toBeAttached({ timeout: browserTimeout });
    const hookKey = await hookOption.getAttribute('value');
    if (hookKey === null || !hookKey.startsWith('claude/')) throw new Error('Expected the fixture to publish one selectable Claude Hook binding.');
    const hookId = hookKey.slice('claude/'.length);

    await page.goto(workbenchUrl(server.url, 'playground'));
    await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#playground-operation').selectOption('skill.inspect');
    await page.locator('#playground-target').selectOption('claude');

    const waitForRun = (): Promise<{ readonly run: { readonly id: string; readonly session: { readonly identity: { readonly epoch: { readonly id: string } } } } }> =>
      page.waitForResponse(runRequest(server!.url)).then(async (response) => response.json());

    await page.locator('#playground-skill-id').selectOption('skill:review');
    const skillStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('skill.inspected')).toBeVisible({ timeout: browserTimeout });
    await skillStarted;
    await expect(page.locator('#playground-operation')).toBeEnabled({ timeout: browserTimeout });

    await page.locator('#playground-operation').selectOption('hook.simulate');
    await page.locator('#playground-hook').selectOption(hookId);
    await expect(page.locator('#playground-hook-input')).toHaveValue(/workbench-preview/u);
    const hookStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('hook.simulated')).toBeVisible({ timeout: browserTimeout });
    await hookStarted;
    await expect(page.locator('#playground-operation')).toBeEnabled({ timeout: browserTimeout });

    await page.locator('#playground-operation').selectOption('mcp.call-tool');
    await page.locator('#playground-mcp-tool').fill('wait');
    await page.locator('#playground-mcp-arguments').fill('{}');
    const waitingStarted = waitForRun();
    await page.getByRole('button', { name: 'Start run' }).click();
    const waiting = await waitingStarted;
    const pinnedEpoch = waiting.run.session.identity.epoch.id;
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeEnabled({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });

    await page.getByRole('link', { name: 'Overview' }).click();
    const rebuildCompleted = page.waitForResponse((response) =>
      response.url() === `${server!.url}/api/project/rebuild` && response.request().method() === 'POST' && response.ok(),
    );
    await page.getByRole('button', { name: /Rebuild/u }).click();
    const rebuilt = await rebuildCompleted;
    const rebuiltStatus = await rebuilt.json() as { readonly status: { readonly artifact: { readonly activeEpoch?: { readonly id: string } } } };
    expect(rebuiltStatus.status.artifact.activeEpoch?.id).not.toBe(pinnedEpoch);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('link', { name: 'Playground', exact: true }).click();
    await expect(page.getByText(pinnedEpoch, { exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });

    await page.locator('#playground-target').selectOption('claude');
    await page.locator('#playground-operation').selectOption('script.run');
    await expect(page.locator('#playground-script-id option[value="script:review"]')).toBeAttached({ timeout: browserTimeout });
    await page.locator('#playground-script-id').selectOption('script:review');
    const scriptStarted = waitForRun();
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.getByText('script.completed')).toBeVisible({ timeout: browserTimeout });
    const scriptTrace = await page.locator('.playground-trace').innerText();
    expect(scriptTrace).toContain('playground script stdout');
    expect(scriptTrace).toContain('playground script stderr');
    expect(scriptTrace).toContain('17');
    await scriptStarted;

    await page.locator('#playground-script-id').selectOption('script:large');
    const largeStarted = waitForRun();
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.locator('.playground-trace .playground-json').last()).toContainText('x'.repeat(64), { timeout: browserTimeout });
    await largeStarted;
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole('button', { name: 'Export trace' }).click();
    await expect(page.getByRole('heading', { name: /Exported trace/u })).toBeVisible({ timeout: browserTimeout });
    const firstReference = page.getByRole('checkbox').first();
    await firstReference.check();
    await expect(page.getByText(/events\.jsonl#\d+/u).first()).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Promote to draft eval case' }).click();
    await expect(page.getByRole('heading', { name: /Draft eval case/u })).toBeVisible({ timeout: browserTimeout });

    expect(runBodies).toHaveLength(5);
    expect(runBodies).toContainEqual({ arguments: {}, operation: 'mcp.call-tool', serverName: 'fixture', target: 'claude', tool: 'wait' });
    expect(runBodies).toContainEqual({ operation: 'script.run', scriptId: 'script:review', target: 'claude' });
    expect(runBodies).toContainEqual({ operation: 'script.run', scriptId: 'script:large', target: 'claude' });
    for (const body of runBodies) {
      expect(body).not.toHaveProperty('epochId');
      expect(body).not.toHaveProperty('path');
      expect(body).not.toHaveProperty('command');
      expect(body).not.toHaveProperty('cwd');
      expect(body).not.toHaveProperty('env');
      expect(body).not.toHaveProperty('evidence');
      expect(body).not.toHaveProperty('outcome');
      expect(body).not.toHaveProperty('session');
      expect(body).not.toHaveProperty('fixture');
      expect(body).not.toHaveProperty('task');
      expect(body).not.toHaveProperty('script');
    }
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.allSettled(server === undefined ? [] : [server.close()]);
    await Promise.allSettled(project === undefined ? [] : [removeProjectFixture(project.root)]);
  }
});

e2e('executes catalog-admitted native prompts through the real host harness', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const priorPath = process.env.PATH;
  let project: Awaited<ReturnType<typeof createProjectFixture>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    project = await createProjectFixture();
    await writePlaygroundProject(project.root);
    const fakeHostDirectory = join(project.root, '.test-native-host');
    await mkdir(fakeHostDirectory, { recursive: true });
    await writeFakeClaude(fakeHostDirectory);
    process.env.PATH = `${fakeHostDirectory}:${nativePathFallback}`;
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root: project.root,
    });

    const nativeRequests: Array<Record<string, unknown>> = [];
    let nativeAdmissionA: PlaygroundAdmission | undefined;
    let nativeAdmissionB: PlaygroundAdmission | undefined;
    const consoleErrors: string[] = [];
    const pageErrors: Error[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`${message.text()} (${message.location().url})`);
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url() !== `${server!.url}/api/playground/runs` || request.method() !== 'POST') return;
      const body = JSON.parse(request.postData() ?? 'null') as unknown;
      if (typeof body === 'object' && body !== null && (body as { readonly operation?: unknown }).operation === 'native.prompt') {
        nativeRequests.push(body as Record<string, unknown>);
      }
    });

    let marker = 'initial setup';
    const mark = (next: string): void => { marker = next; };
    const settleNativeSelection = (): Promise<void> => page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const selectNativePrompt = async (prompt: string): Promise<void> => {
      mark('select native operation');
      await page.locator('#playground-operation').selectOption('native.prompt');
      mark('wait for enabled native catalog');
      await expect(page.locator('#playground-native-host')).toBeEnabled({ timeout: browserTimeout });
      mark('select native target');
      await page.locator('#playground-native-target').selectOption('claude');
      mark('settle native target');
      await settleNativeSelection();
      mark('wait for native case option');
      await expect(page.locator('#playground-native-case option').nth(1)).toBeAttached({ timeout: browserTimeout });
      mark('select native case');
      await page.locator('#playground-native-case').selectOption({ index: 1 });
      mark('settle native case');
      await settleNativeSelection();
      mark('select native host');
      await page.locator('#playground-native-host').selectOption('claude');
      mark('settle native host');
      await settleNativeSelection();
      mark('wait for native fixture choices');
      await expect(page.locator('#playground-native-fixture')).toBeEnabled({ timeout: browserTimeout });
      mark('select native fixture');
      await page.locator('#playground-native-fixture').selectOption({ index: 1 });
      mark('settle native fixture');
      await settleNativeSelection();
      mark('wait for native model pin choices');
      await expect(page.locator('#playground-native-model-pin')).toBeEnabled({ timeout: browserTimeout });
      mark('select native model pin');
      await page.locator('#playground-native-model-pin').selectOption({ index: 1 });
      mark('fill native prompt');
      await page.locator('#playground-native-prompt').fill(prompt);
      mark('wait for native start enabled');
      await expect(page.getByRole('button', { name: 'Start native prompt' })).toBeEnabled({ timeout: browserTimeout });
    };
    const phase = async (label: string, action: () => Promise<void>): Promise<void> => {
      try { await action(); }
      catch (error) {
        throw new Error(`Native Chrome phase ${label} failed at ${marker}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    };

    await phase('catalog admission on epoch A', async () => {
      mark('open Playground');
      await page.goto(`${server!.url}#playground`);
      mark('wait for Playground heading');
      await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible({ timeout: browserTimeout });
      await selectNativePrompt('Gate native Playground run until cancellation.');
      mark('click native start');
      const admitted = page.waitForResponse(runRequest(server!.url));
      await page.getByRole('button', { name: 'Start native prompt' }).click();
      nativeAdmissionA = await (await admitted).json() as PlaygroundAdmission;
      mark('wait for native host started evidence');
      await expect(page.getByText('native.host.started')).toBeVisible({ timeout: browserTimeout });
    });

    const firstRequest = nativeRequests[0];
    if (firstRequest === undefined) throw new Error('The catalog-admitted native prompt did not issue a request.');
    const epochA = firstRequest.epochId;
    const pinA = firstRequest.modelPinId;
    if (typeof epochA !== 'string' || typeof pinA !== 'string') throw new Error('The native request did not retain epoch-A provenance.');
    if (nativeAdmissionA === undefined) throw new Error('The epoch-A native admission did not return a durable run identity.');
    expect(nativeAdmissionA.run.session.identity.epoch.id).toBe(epochA);

    await phase('rebuild B and cancel the admitted epoch-A native run', async () => {
      await page.getByRole('link', { name: 'Overview' }).click();
      const rebuildCompleted = page.waitForResponse((response) =>
        response.url() === `${server!.url}/api/project/rebuild` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: /Rebuild/u }).click();
      const rebuilt = await rebuildCompleted;
      const rebuiltStatus = await rebuilt.json() as { readonly status: { readonly artifact: { readonly activeEpoch?: { readonly id: string } } } };
      expect(rebuiltStatus.status.artifact.activeEpoch?.id).not.toBe(epochA);
      await page.getByRole('link', { name: 'Playground', exact: true }).click();
      await expect(page.getByText(epochA, { exact: true })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText(pinA, { exact: true })).toBeVisible({ timeout: browserTimeout });
      await page.getByRole('button', { name: 'Cancel run' }).click();
      await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled({ timeout: browserTimeout });
      await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('native.host.started')).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });
    });

    await phase('complete a rebuilt catalog-native prompt and retain normalized evidence', async () => {
      await selectNativePrompt('Complete the native Playground fixture.');
      mark('click completed native prompt');
      const admitted = page.waitForResponse(runRequest(server!.url));
      await page.getByRole('button', { name: 'Start native prompt' }).click();
      nativeAdmissionB = await (await admitted).json() as PlaygroundAdmission;
      mark('wait for normalized native evidence');
      for (const kind of ['native.activation', 'native.mcp', 'native.assertions', 'native.hooks', 'native.scripts', 'native.response', 'native.workspace']) {
        await expect(page.getByText(kind)).toBeVisible({ timeout: browserTimeout });
      }
      await expect(page.getByText('Native fixture completed.', { exact: true })).toBeVisible({ timeout: browserTimeout });
    });

    const secondRequest = nativeRequests[1];
    if (secondRequest === undefined || typeof secondRequest.epochId !== 'string') throw new Error('The completed native prompt did not retain epoch-B admission provenance.');
    const epochB = secondRequest.epochId;
    if (nativeAdmissionB === undefined) throw new Error('The epoch-B native admission did not return a durable run identity.');
    const completedNativeSession = nativeAdmissionB.run.session;
    expect(epochB).not.toBe(epochA);
    expect(completedNativeSession.identity.epoch.id).toBe(epochB);

    await phase('server-owned native export and promotion provenance', async () => {
      const nativeResponseCard = page.locator('details.playground-event-card').filter({
        has: page.getByText('native.response', { exact: true }),
      }).last();
      await expect(nativeResponseCard).toBeVisible({ timeout: browserTimeout });
      const nativeResponseCheckbox = nativeResponseCard.getByRole('checkbox');
      const nativeResponseLabel = await nativeResponseCheckbox.getAttribute('aria-label');
      const nativeResponseRef = /^Select (events\.jsonl#\d+) for the draft eval case$/u.exec(nativeResponseLabel ?? '')?.[1];
      if (nativeResponseRef === undefined) throw new Error('The persisted native response card did not expose one raw event reference.');
      const exportedResponse = page.waitForResponse((response) =>
        response.url() === `${server!.url}/api/playground/sessions/${encodeURIComponent(completedNativeSession.id)}/export` &&
        response.request().method() === 'GET',
      );
      await page.getByRole('button', { name: 'Export trace' }).click();
      const exportedBody = await (await exportedResponse).json() as { readonly export: {
        readonly events: readonly { readonly kind: string; readonly rawEventRef: string }[];
        readonly session: { readonly id: string; readonly identity: { readonly epoch: { readonly id: string } } };
      } };
      expect(exportedBody.export.session.id).toBe(completedNativeSession.id);
      expect(exportedBody.export.session.identity.epoch.id).toBe(epochB);
      expect(exportedBody.export.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'native.response', rawEventRef: nativeResponseRef }),
      ]));
      await expect(page.getByRole('heading', { name: /Exported trace/u })).toBeVisible({ timeout: browserTimeout });
      const exportSection = page.getByRole('heading', { name: /Exported trace/u }).locator('..');
      await expect(exportSection).toContainText(epochB);
      await expect(exportSection).toContainText(nativeResponseRef);
      await nativeResponseCheckbox.check();
      const draftResponse = page.waitForResponse((response) =>
        response.url() === `${server!.url}/api/playground/sessions/${encodeURIComponent(completedNativeSession.id)}/draft-eval` &&
        response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Promote to draft eval case' }).click();
      const draftResult = await draftResponse;
      expect(draftResult.request().postDataJSON()).toEqual({ rawEventRefs: [nativeResponseRef] });
      const draftBody = await draftResult.json() as { readonly draftEvalCase: {
        readonly assertions: readonly { readonly evidence: { readonly rawEventRef: string }; readonly expectation: { readonly kind: string }; readonly id: string }[];
        readonly epoch: { readonly id: string };
      } };
      expect(draftBody.draftEvalCase.epoch.id).toBe(epochB);
      expect(draftBody.draftEvalCase.assertions).toEqual([
        expect.objectContaining({
          evidence: expect.objectContaining({ rawEventRef: nativeResponseRef }),
          expectation: expect.objectContaining({ kind: 'native.response' }),
          id: nativeResponseRef,
        }),
      ]);
      await expect(page.getByRole('heading', { name: /Draft eval case/u })).toBeVisible({ timeout: browserTimeout });
      const draftSection = page.getByRole('heading', { name: /Draft eval case/u }).locator('..');
      await expect(draftSection).toContainText(epochB);
      await expect(draftSection).toContainText(nativeResponseRef);
    });

    expect(nativeRequests).toHaveLength(2);
    for (const request of nativeRequests) {
      expect(Object.keys(request).sort()).toEqual(['caseId', 'epochId', 'fixtureId', 'host', 'modelPinId', 'operation', 'prompt', 'target']);
      expect(request.host).toBe('claude');
      expect(request).not.toHaveProperty('model');
      expect(request).not.toHaveProperty('path');
      expect(request).not.toHaveProperty('command');
      expect(request).not.toHaveProperty('cwd');
      expect(request).not.toHaveProperty('env');
      expect(request).not.toHaveProperty('key');
      expect(request).not.toHaveProperty('raw');
      expect(request).not.toHaveProperty('evidence');
      expect(request).not.toHaveProperty('outcome');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.allSettled(server === undefined ? [] : [server.close()]);
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await Promise.allSettled(project === undefined ? [] : [removeProjectFixture(project.root)]);
  }
});
