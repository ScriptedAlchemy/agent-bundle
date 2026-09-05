import { execFile as executeFile, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { descendantProcessIds } from '../../workbench/tests/support/packed-release-harness.ts';
import { formatServeAppReadyLine, parseServeAppReadyLine } from '../src/serve-app/command-contract.ts';
import { removeProjectSource } from '../src/test/packed.ts';
import { awaitStdoutLine, connectionRefused, isProcessGone, killAll, runBin, type BinRun } from './support/bin-process.ts';
import { eventuallyPasses, within } from './support/eventually.ts';
import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';
import { timeScale } from './support/time-scale.ts';

/**
 * The `<plugin> web` packed proof (#564): a plugin exposes its MCP App through
 * `web.apps`, and the *installed* framework builds a composite root whose
 * `bin/<plugin>.mjs` carries the framework-owned `web` command — the browser
 * host, its page script, and the stdio session to the packed MCP server —
 * beside the author's own routed command, with nothing loaded from outside
 * the artifact.
 *
 * One tarball set (the run-level shared pack), one scratch consumer copied
 * from `fixtures/web-surface`, one `agent-bundle build` with the installed
 * CLI, then the project source is removed and verified absent
 * (`packed-deleted-source`) before the generated bin runs as a separate
 * operating-system process: the `--json` ready document and the human ready
 * line, the served page (seed element, CSP, token-gated routes), teardown of
 * the MCP server child on SIGINT/SIGTERM with the envelope's exit codes, the
 * `--help` listing shared with the authored command, and the fail-closed
 * exits (no manifest, unknown App, unknown `--allow`).
 */

const execFile = promisify(executeFile);
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/web-surface');
const pluginName = 'web-surface-fixture';
const app = 'status/status';
const resourceUri = 'ui://web-surface-fixture/status.html';
/** The App's opening tool: the fixture configures none, so the one tool declaring its `_meta.ui.resourceUri` is resolved on the live server. */
const tool = 'status';
/** `WEB_HOST_SEED_ELEMENT_ID` (web-host/browser/seed.ts): the `<script type="application/json">` the host page reads its seed from. */
const seedElementId = 'agent-bundle-web-host-seed';
/** `WEB_HOST_TOKEN_HEADER` (web-host/page.ts): the header the standalone host page presents on `/api/mcp/...`. */
const tokenHeader = 'x-agent-bundle-web-host';
/** A live framework import surviving in a generated executable: `from "agent-bundle/..."` or `import("agent-bundle/...")`. */
const agentBundleImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]agent-bundle(?:\/[^'"]*)?['"]/u;
/** A live Effect import surviving in a generated executable: the web host is plain Node and never carries the compiler's runtime. */
const effectImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]effect(?:\/[^'"]*)?['"]/u;
const seedElementPattern = new RegExp(`<script\\b(?=[^>]*\\btype="application/json")(?=[^>]*\\bid="${seedElementId}")[^>]*>([\\s\\S]*?)</script>`, 'u');
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

let consumer = '';
let project = '';
let artifact = '';
let bin = '';
/** Every bin this file spawned and every descendant it observed, killed on teardown if still alive. */
const spawned = new Set<ChildProcess>();
const observedProcessIds = new Set<number>();

const spawnBin = (executable: string, args: readonly string[], cwd = project): BinRun =>
  runBin(executable, args, { cwd, env: installedEnvironment(), track: spawned });

const seedOf = (html: string): WebHostSeed => {
  const match = seedElementPattern.exec(html);
  if (match?.[1] === undefined) throw new Error(`The served page carries no #${seedElementId} element:\n${html}`);
  return JSON.parse(match[1]) as WebHostSeed;
};

/** Polls (≤5 s, scaled) until every listed URL refuses connections and every listed process is gone. */
const expectTornDown = async (urls: readonly string[], processIds: readonly number[]): Promise<void> => {
  await eventuallyPasses(async () => {
    for (const processId of processIds) expect(isProcessGone(processId), `process ${String(processId)} is still alive`).toBe(true);
    for (const url of urls) expect(await connectionRefused(url), `${url} still accepts connections`).toBe(true);
  }, teardownBudget);
};

/** Records the MCP server (and anything else) the bin spawned, so teardown can be asserted and a failure cannot leak them. */
const observeDescendants = async (run: BinRun): Promise<readonly number[]> => {
  const descendants = await descendantProcessIds(run.child.pid!);
  for (const processId of descendants) observedProcessIds.add(processId);
  return descendants;
};

beforeAll(async () => {
  const [agentBundle, runtime, markdownStream] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('runtime'),
    sharedPackedTarball('markdown-stream'),
  ]);
  consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-web-command-'));
  project = join(consumer, 'project');
  artifact = join(project, 'artifact');
  await cp(fixtureRoot, project, { recursive: true });
  // The generated routed-CLI bin resolves `@agent-bundle/runtime` (and its
  // React peer) from the consumer, exactly like the packed stdio proof.
  await execFile('npm', ['install', ...cachedNpmInstallArguments,
    agentBundle.tarball,
    runtime.tarball,
    markdownStream.tarball,
    'react@19.2.8',
    'react-dom@19.2.8',
    'zod@4.4.3',
  ], { cwd: project, env: installedEnvironment() });
  const cli = join(project, 'node_modules', '.bin', 'agent-bundle');
  await execFile(cli, ['build', '--root', project, '--output', artifact], {
    cwd: project,
    env: installedEnvironment(),
  });
  bin = join(artifact, 'bin', `${pluginName}.mjs`);
  // `packed-deleted-source`: the bin serves out of the artifact alone, so the
  // config, the routes, the server, and the App view are removed and verified
  // absent before any process runs.
  const receipt = await removeProjectSource({ extraPaths: ['views'], projectRoot: project });
  expect(receipt.removed).toEqual(['agent-bundle.config.ts', 'src', 'views']);
}, 300_000);

afterAll(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  killAll(observedProcessIds);
  if (consumer.length > 0) await rm(consumer, { force: true, recursive: true });
});

it('builds the exposed App into the composite root: a manifest web section and one self-contained bin carrying the host', { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8')) as { readonly web?: unknown };
  const mcpEntries = (await readdir(join(artifact, 'mcp'))).filter((name) => name.endsWith('.mjs')).sort();
  expect(mcpEntries).toHaveLength(1);
  // `WebManifest` (web-host/manifest.ts): `open` defaults to `never`; the
  // fixture configures no `tool` and no `input`, so neither key is written;
  // `env` is the server's static env (none) and `entry` the artifact-relative
  // compiled MCP executable the host launches.
  expect(manifest.web).toEqual({
    apps: [{
      allow: ['call-tool'],
      app,
      entry: `mcp/${mcpEntries[0]!}`,
      env: {},
      name: 'status',
      resourceUri,
      server: 'status',
    }],
    open: 'never',
  });

  await expect(stat(bin)).resolves.toMatchObject({});
  const source = await readFile(bin, 'utf8');
  // Self-contained (AB6005): no live framework import and no Effect import
  // survive; the ready-line contract and the host page (whose seed element
  // the inlined page script reads) are part of the executable's bytes.
  expect(source).not.toMatch(agentBundleImport);
  expect(source).not.toMatch(effectImport);
  expect(source).toContain('Ctrl-C stops the server');
  expect(source).toContain(seedElementId);
});

it('serves the App from `web --json --no-open` as a real process out of the deleted-source consumer, gates its routes by token, and tears down on SIGINT', { timeout: 120_000 }, async () => {
  const run = spawnBin(bin, ['web', '--no-open', '--json']);
  const line = await awaitStdoutLine(run, (candidate) => candidate.startsWith('{'), startupBudget);
  const ready = JSON.parse(line) as WebReadyDocument;
  // One JSON line, keys sorted, nothing else on stdout while serving.
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
  expect(ready.sandboxOrigin).not.toBe(new URL(ready.url).origin);
  expect(run.stdout()).toBe(`${line}\n`);

  // The page: the seed element the page script reads, framed by no one
  // (`frame-ancestors 'none'`), framing only the sandbox origin.
  const page = await fetch(ready.url);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toMatch(/^text\/html/u);
  const policy = page.headers.get('content-security-policy') ?? '';
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain(`frame-src ${ready.sandboxOrigin}`);
  const html = await page.text();
  expect(html).toMatch(seedElementPattern);
  const seed = seedOf(html);
  expect(seed).toMatchObject({
    autoApprove: ['call-tool'],
    input: {},
    previewProfile: 'portable',
    result: { structuredContent: { status: 'healthy' } },
    tokenHeader,
    toolName: tool,
  });
  expect(seed.token.length).toBeGreaterThan(0);
  expect(seed.sessionId.length).toBeGreaterThan(0);

  // The authenticated routes refuse a request that presents no token, even
  // one that names the seeded session from the host's own origin.
  const anonymous = await fetch(new URL(`/api/mcp/sessions/${encodeURIComponent(seed.sessionId)}/apps`, ready.url), {
    body: '{}',
    headers: { 'content-type': 'application/json', origin: new URL(ready.url).origin },
    method: 'POST',
  });
  expect(anonymous.status).toBe(403);

  // The packed MCP server runs under the bin; SIGINT reaches the envelope
  // (exit 130), which closes the host, the sandbox proxy, and the session.
  const descendants = await observeDescendants(run);
  expect(descendants.length).toBeGreaterThanOrEqual(1);
  run.child.kill('SIGINT');
  const exit = await within(run.exit, exitBudget);
  expect(exit, run.stderr()).toEqual({ code: 130, signal: null });
  expect(run.stdout()).toBe(`${line}\n`);
  await expectTornDown([ready.url, ready.sandboxOrigin], descendants);
});

it('prints the shared ready line without --json and exits 143 on SIGTERM', { timeout: 120_000 }, async () => {
  const run = spawnBin(bin, ['web', '--no-open']);
  const line = await awaitStdoutLine(run, (candidate) => parseServeAppReadyLine(candidate) !== undefined, startupBudget);
  // The same line `agent-bundle serve-app` prints (serve-app/command-contract.ts).
  const ready = parseServeAppReadyLine(line);
  expect(ready).toEqual({ app, tool, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u) });
  expect(line).toBe(formatServeAppReadyLine(ready!));
  expect((await fetch(ready!.url)).status).toBe(200);

  const descendants = await observeDescendants(run);
  expect(descendants.length).toBeGreaterThanOrEqual(1);
  run.child.kill('SIGTERM');
  const exit = await within(run.exit, exitBudget);
  expect(exit, run.stderr()).toEqual({ code: 143, signal: null });
  expect(run.stdout()).toBe(`${line}\n`);
  await expectTornDown([ready!.url], descendants);
});

it('shares one bin with the authored command: --help lists both, `web --help` answers, and the routed command still runs', { timeout: 60_000 }, async () => {
  const help = spawnBin(bin, ['--help']);
  expect(await within(help.exit, 30_000 * timeScale), help.stderr()).toEqual({ code: 0, signal: null });
  expect(help.stdout()).toContain(`${pluginName} 1.0.0`);
  expect(help.stdout()).toMatch(/^Commands:$/mu);
  expect(help.stdout()).toMatch(/^\s+dashboard\b/mu);
  expect(help.stdout()).toMatch(/^\s+web\b/mu);

  const webHelp = spawnBin(bin, ['web', '--help']);
  expect(await within(webHelp.exit, 30_000 * timeScale), webHelp.stderr()).toEqual({ code: 0, signal: null });
  expect(webHelp.stdout()).toContain('web');
  expect(webHelp.stdout()).toContain('--port');
  expect(webHelp.stdout()).toContain('--json');

  const dashboard = spawnBin(bin, ['dashboard', '--json']);
  expect(await within(dashboard.exit, 30_000 * timeScale), dashboard.stderr()).toEqual({ code: 0, signal: null });
  expect(dashboard.stdout()).toBe('{"ok":true}\n');
});

it('fails closed: exit 1 without a manifest beside the bin, exit 2 for an App web.apps does not expose or an --allow outside the vocabulary', { timeout: 120_000 }, async () => {
  // The bin alone, copied out of its artifact: no `agent-bundle.manifest.json`
  // resolves from it (nor from the working directory), and the message
  // names the file it looked for.
  const strayBinDirectory = join(consumer, 'elsewhere', 'bin');
  await mkdir(strayBinDirectory, { recursive: true });
  const strayBin = join(strayBinDirectory, `${pluginName}.mjs`);
  await cp(bin, strayBin);
  const missing = spawnBin(strayBin, ['web', '--no-open', '--json'], consumer);
  expect(await within(missing.exit, 30_000 * timeScale), missing.stderr()).toEqual({ code: 1, signal: null });
  expect(missing.stdout()).toBe('');
  expect(missing.stderr()).toContain('agent-bundle.manifest.json');

  // A selector the manifest's `web` section does not expose is a usage error
  // that lists what is exposed.
  const unknownApp = spawnBin(bin, ['web', 'nope/nope', '--no-open']);
  expect(await within(unknownApp.exit, 30_000 * timeScale), unknownApp.stderr()).toEqual({ code: 2, signal: null });
  expect(unknownApp.stdout()).toBe('');
  expect(unknownApp.stderr()).toContain('nope/nope');
  expect(unknownApp.stderr()).toContain(app);

  // `--allow` accepts the serve-app vocabulary only (command-contract.ts
  // `serveAppAllowCapabilities`); browser permissions stay interactive.
  const unknownAllow = spawnBin(bin, ['web', '--allow', 'camera', '--no-open']);
  expect(await within(unknownAllow.exit, 30_000 * timeScale), unknownAllow.stderr()).toEqual({ code: 2, signal: null });
  expect(unknownAllow.stdout()).toBe('');
  expect(unknownAllow.stderr()).toContain('camera');
});
