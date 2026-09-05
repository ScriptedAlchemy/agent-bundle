import type { ChildProcess } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@rstest/playwright';
import type { Frame, Page } from 'playwright';

import { build } from '../../agent-bundle/src/api.ts';
import { awaitStdoutLine, connectionRefused, isProcessGone, killAll, runBin } from '../../agent-bundle/tests/support/bin-process.ts';
import { eventuallyPasses, within } from '../../agent-bundle/tests/support/eventually.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { copyExample } from './support/example-acceptance.ts';
import { descendantProcessIds } from './support/packed-release-harness.ts';
import { e2e } from './support/workbench-e2e.ts';

/**
 * The `<plugin> web` browser acceptance (#564) over the public example:
 * `examples/mcp-app` exposes `status/status` through `web.apps`, so its
 * composite root carries `bin/mcp-app-example.mjs` with the framework-owned
 * `web` command. The bin runs as a real process (`web --no-open --json`), the
 * page it serves is opened in a 1440×900 desktop browser, and the App renders
 * in the separate-origin sandbox and round-trips the MCP Apps bridge — no
 * assertion is made while the host page is still binding. SIGINT then ends
 * the bin with the envelope's exit code and nothing it spawned survives.
 */

const pluginName = 'mcp-app-example';
const app = 'status/status';
const resourceUri = 'ui://mcp-app-example/status.html';
const tool = 'show-status';
/**
 * `show-status` validates `{ service: 'compiler' | 'payments-api' }`
 * (examples/mcp-app/src/mcp/status.ts), so the opening call needs an input:
 * `--input` (web-host/command.ts argv) supplies it, whatever the example's
 * `web.apps` entry configures.
 */
const openingInput = { service: 'compiler' } as const;
/** What `show-status` returns for that input: `healthyCompilerStatus` (examples/mcp-app/src/compiler-status-contract.ts). */
const healthyCompilerStatus = {
  checks: [
    { label: 'Availability', status: 'passing' },
    { label: 'Build queue', status: 'passing' },
  ],
  service: 'compiler',
  status: 'healthy',
  summary: 'Compiler service is ready for release.',
} as const;
/** `WEB_HOST_SEED_ELEMENT_ID` (web-host/browser/seed.ts). */
const seedElementId = 'agent-bundle-web-host-seed';
/** `WEB_HOST_TOKEN_HEADER` (web-host/page.ts): the header the standalone host page presents on `/api/mcp/...`. */
const tokenHeader = 'x-agent-bundle-web-host';
const seedElementPattern = new RegExp(`<script\\b(?=[^>]*\\btype="application/json")(?=[^>]*\\bid="${seedElementId}")[^>]*>`, 'u');
/** A live framework import surviving in a generated executable: `from "agent-bundle/..."` or `import("agent-bundle/...")`. */
const agentBundleImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]agent-bundle(?:\/[^'"]*)?['"]/u;
/** A live Effect import surviving in a generated executable: the web host is plain Node and never carries the compiler's runtime. */
const effectImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]effect(?:\/[^'"]*)?['"]/u;
/** The host page's `#status` while it binds the opening call, then once the App is served over the bound session. */
const bindingStatus = `Binding ${tool} to the App…`;
const servingStatus = `Serving ${app} over the bound session.`;
const statusLogKey = '__agentBundleWebHostStatusLog';

const browserTimeout = 15_000 * timeScale;
/** Spawning the packed MCP server, listing its tools, making the opening call, and opening the sandbox proxy. */
const startupBudget = 60_000 * timeScale;
/** The envelope's signal exit lands within 5 s (scaled for shared machines). */
const exitBudget = 5_000 * timeScale;
const teardownBudget = { attempts: 50 * timeScale, delayMs: 100 } as const;

/** The one stdout line `<plugin> web --json` prints (web-host/command.ts): these keys, in this (sorted) order. */
interface WebReadyDocument {
  readonly app: string;
  readonly port: number;
  readonly resourceUri: string;
  readonly sandboxOrigin: string;
  readonly server: string;
  readonly tool: string;
  readonly url: string;
}
const webReadyKeys: readonly (keyof WebReadyDocument)[] = ['app', 'port', 'resourceUri', 'sandboxOrigin', 'server', 'tool', 'url'];

/** `WebHostPageSeed` (web-host/browser/seed.ts), as embedded in the served document. */
interface WebHostSeed {
  readonly autoApprove: readonly string[];
  readonly input: unknown;
  readonly previewProfile: string;
  readonly result: unknown;
  readonly sessionId: string;
  readonly title: string;
  readonly token: string;
  readonly tokenHeader: string;
  readonly toolName: string;
}

interface StatusEntry {
  readonly text: string;
  readonly tone: string;
}

interface HostRequest {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

const requestBody = (body: string | null): unknown => {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** The JSON-RPC method a relayed App frame carries: `{ message }` as `McpAppRoutes` reads it. */
const relayedMethod = (body: unknown): string | undefined => {
  if (body === null || typeof body !== 'object') return undefined;
  const message = (body as { readonly message?: unknown }).message;
  if (message === null || typeof message !== 'object') return undefined;
  const method = (message as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
};

/**
 * Records every distinct `#status` text/tone the host page shows, from the
 * first paint on, so the binding state can be asserted after the fact
 * without racing it. Installed before navigation; runs in the page.
 */
const installStatusLog = async (page: Page): Promise<void> => {
  await page.addInitScript((key: string) => {
    const log: { text: string; tone: string }[] = [];
    (globalThis as unknown as Record<string, unknown>)[key] = log;
    const record = (): void => {
      const status = document.getElementById('status');
      if (status === null) return;
      const entry = { text: status.textContent ?? '', tone: status.dataset['tone'] ?? '' };
      const last = log.at(-1);
      if (last !== undefined && last.text === entry.text && last.tone === entry.tone) return;
      log.push(entry);
    };
    new MutationObserver(record).observe(document, { attributes: true, characterData: true, childList: true, subtree: true });
  }, statusLogKey);
};

const readStatusLog = (page: Page): Promise<readonly StatusEntry[]> =>
  page.evaluate((key: string) => (globalThis as unknown as Record<string, readonly { text: string; tone: string }[]>)[key] ?? [], statusLogKey);

const frameWhere = async (page: Page, accept: (frame: Frame) => boolean, description: string): Promise<Frame> => {
  await expect.poll(() => page.frames().some(accept), { timeout: browserTimeout }).toBe(true);
  const frame = page.frames().find(accept);
  if (frame === undefined) throw new Error(`Expected ${description}; frames: ${page.frames().map((candidate) => candidate.url()).join(', ')}`);
  return frame;
};

e2e('serves examples/mcp-app through `<plugin> web` from its composite root and renders the App in the separate-origin sandbox', { timeout: 300_000 * timeScale }, async ({ page }) => {
  const spawned = new Set<ChildProcess>();
  const observedProcessIds = new Set<number>();
  let example: Awaited<ReturnType<typeof copyExample>> | undefined;
  let testFailure: unknown;
  let cleanupFailure: unknown;
  try {
    // Artifact: the example's `web.apps` entry lands in the manifest and the
    // composite root gains the bin that carries the `web` command.
    example = await copyExample('mcp-app');
    const artifactRoot = join(example.root, 'artifact');
    const built = await build({ output: artifactRoot, root: example.root });
    expect(built.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    const bin = join(artifactRoot, 'bin', `${pluginName}.mjs`);
    await expect(stat(bin)).resolves.toMatchObject({});
    const manifest = JSON.parse(await readFile(join(artifactRoot, 'agent-bundle.manifest.json'), 'utf8')) as { readonly web?: unknown };
    const mcpEntries = (await readdir(join(artifactRoot, 'mcp'))).filter((name) => name.endsWith('.mjs')).sort();
    expect(mcpEntries).toHaveLength(1);
    expect(manifest.web).toEqual({
      apps: [{
        allow: ['call-tool'],
        app,
        entry: `mcp/${mcpEntries[0]!}`,
        env: {},
        name: 'status',
        resourceUri,
        server: 'status',
        tool,
      }],
      open: 'never',
    });
    const binSource = await readFile(bin, 'utf8');
    expect(binSource).not.toMatch(agentBundleImport);
    expect(binSource).not.toMatch(effectImport);

    // Process: one JSON line, keys sorted, then the bin keeps serving.
    const run = runBin(bin, ['web', '--no-open', '--json', '--input', JSON.stringify(openingInput)], { cwd: artifactRoot, track: spawned });
    const line = await awaitStdoutLine(run, (candidate) => candidate.startsWith('{'), startupBudget);
    const ready = JSON.parse(line) as WebReadyDocument;
    expect(Object.keys(ready)).toEqual(webReadyKeys);
    expect(JSON.stringify(ready)).toBe(line);
    expect(ready).toEqual({
      app,
      port: expect.any(Number),
      resourceUri,
      sandboxOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
      server: 'status',
      tool,
      url: `http://127.0.0.1:${String(ready.port)}/`,
    });
    const hostOrigin = new URL(ready.url).origin;
    expect(ready.sandboxOrigin).not.toBe(hostOrigin);

    // Page: the seed element and a policy that lets no one frame the host
    // and lets the host frame only the sandbox origin.
    const response = await fetch(ready.url);
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain(`frame-src ${ready.sandboxOrigin}`);
    expect(await response.text()).toMatch(seedElementPattern);

    // Browser: every relayed App frame and every non-OK host response is
    // recorded so the bridge traffic can be asserted, not inferred.
    const hostRequests: HostRequest[] = [];
    const failedHostResponses: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== hostOrigin || !url.pathname.startsWith('/api/mcp/')) return;
      hostRequests.push({ body: requestBody(request.postData()), method: request.method(), path: url.pathname });
    });
    page.on('response', (httpResponse) => {
      const url = new URL(httpResponse.url());
      if (url.origin !== hostOrigin || !url.pathname.startsWith('/api/mcp/')) return;
      if (!httpResponse.ok()) failedHostResponses.push(`${String(httpResponse.status())} ${httpResponse.request().method()} ${url.pathname}`);
    });
    const relayed = (method: string): boolean =>
      hostRequests.some((request) => request.method === 'POST' && request.path.endsWith('/messages') && relayedMethod(request.body) === method);
    await installStatusLog(page);
    await page.goto(ready.url);
    const seed = JSON.parse(await page.locator(`#${seedElementId}`).textContent() ?? 'null') as WebHostSeed;
    expect(seed).toMatchObject({
      autoApprove: ['call-tool'],
      input: openingInput,
      previewProfile: 'portable',
      result: { structuredContent: healthyCompilerStatus },
      tokenHeader,
      toolName: tool,
    });
    expect(seed.token.length).toBeGreaterThan(0);

    // Never accept the page while it is binding: wait for the served state,
    // then check the binding state was shown before it and no error or
    // warning tone ever was.
    const hostStatus = page.locator('#status');
    await expect(hostStatus).toHaveText(servingStatus, { timeout: browserTimeout });
    await expect(hostStatus).toHaveAttribute('data-tone', 'ok');
    const statusLog = await readStatusLog(page);
    const bindingIndex = statusLog.findIndex((entry) => entry.text === bindingStatus);
    const servingIndex = statusLog.findIndex((entry) => entry.text === servingStatus && entry.tone === 'ok');
    expect(bindingIndex, JSON.stringify(statusLog)).toBeGreaterThanOrEqual(0);
    expect(servingIndex, JSON.stringify(statusLog)).toBeGreaterThan(bindingIndex);
    expect(statusLog.filter((entry) => entry.tone === 'error' || entry.tone === 'warn')).toEqual([]);

    // Frames: the host page frames the sandbox proxy on its own origin, and
    // the proxy frames the App as a `srcdoc` document under `allow-scripts`
    // alone (dev/mcp-apps/mcp-app-sandbox.ts).
    const outerFrame = page.locator('iframe');
    await expect(outerFrame).toHaveCount(1);
    await expect(outerFrame).toBeVisible({ timeout: browserTimeout });
    expect(new URL(await outerFrame.getAttribute('src') ?? '').origin).toBe(ready.sandboxOrigin);
    await expect(outerFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    await expect(outerFrame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const proxyFrame = await frameWhere(page, (frame) => frame.url().startsWith(ready.sandboxOrigin), 'the sandbox proxy frame on the sandbox origin');
    const appIframe = proxyFrame.locator('iframe#app');
    await expect(appIframe).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(appIframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    const appFrame = await frameWhere(page, (frame) => frame.url() === 'about:blank' && frame.parentFrame() === proxyFrame, 'the App srcdoc frame inside the sandbox proxy');

    // App: the opening call's structuredContent is rendered
    // (examples/mcp-app/views/status-panel.ts), and the App document never
    // sees the host token.
    await expect(appFrame.locator('#service')).toHaveText(healthyCompilerStatus.service, { timeout: browserTimeout });
    await expect(appFrame.locator('#status')).toHaveText(healthyCompilerStatus.status);
    await expect(appFrame.locator('#status-indicator')).toHaveAttribute('data-state', healthyCompilerStatus.status);
    await expect(appFrame.locator('#summary')).toHaveText(healthyCompilerStatus.summary);
    await expect(appFrame.locator('#checks li')).toHaveCount(healthyCompilerStatus.checks.length);
    expect(await appFrame.content()).not.toContain(seed.token);

    // Bridge: `#read-policy` reads `ui://mcp-app-example/readiness-policy`,
    // which examples/mcp-app/src/mcp/status.ts does not register, so the
    // relayed error reply is what fills `#bridge-outcome` — a relay that never
    // answered would leave it empty. `#refresh-status` calls `refresh-status`
    // (also unregistered) under the pre-approved `call-tool` capability: the
    // reply arrives without the consent panel ever showing.
    const consent = page.getByLabel('MCP App consent');
    await expect(consent).toBeHidden();
    const bridgeOutcome = appFrame.locator('#bridge-outcome');
    await expect(bridgeOutcome).toBeEmpty();
    await appFrame.locator('#read-policy').click();
    await expect(bridgeOutcome).toHaveText('Readiness policy unavailable.', { timeout: browserTimeout });
    await expect.poll(() => relayed('resources/read'), { timeout: browserTimeout }).toBe(true);
    await appFrame.locator('#refresh-status').click();
    await expect(bridgeOutcome).toHaveText('Refresh unavailable.', { timeout: browserTimeout });
    await expect.poll(() => relayed('tools/call'), { timeout: browserTimeout }).toBe(true);
    await expect(consent).toBeHidden();
    await expect(hostStatus).toHaveText(servingStatus);
    await expect(hostStatus).toHaveAttribute('data-tone', 'ok');
    expect(failedHostResponses).toEqual([]);

    // Teardown: SIGINT reaches the envelope (exit 130) and ends the MCP
    // server under the bin, the host, and the sandbox proxy; stdout stayed
    // the one JSON line.
    const descendants = await descendantProcessIds(run.child.pid!);
    expect(descendants.length).toBeGreaterThanOrEqual(1);
    for (const processId of descendants) observedProcessIds.add(processId);
    run.child.kill('SIGINT');
    const exit = await within(run.exit, exitBudget);
    expect(exit, run.stderr()).toEqual({ code: 130, signal: null });
    expect(run.stdout()).toBe(`${line}\n`);
    await eventuallyPasses(async () => {
      for (const processId of descendants) expect(isProcessGone(processId), `process ${String(processId)} is still alive`).toBe(true);
      expect(await connectionRefused(ready.url), 'the host still accepts connections').toBe(true);
      expect(await connectionRefused(ready.sandboxOrigin), 'the sandbox proxy still accepts connections').toBe(true);
    }, teardownBudget);
  } catch (error) {
    testFailure = error;
  } finally {
    for (const child of spawned) child.kill('SIGKILL');
    killAll(observedProcessIds);
    const exampleCleanup = await Promise.allSettled(example === undefined ? [] : [example.release()]);
    const failedCleanup = exampleCleanup.find((result) => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') cleanupFailure = failedCleanup.reason;
  }
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
