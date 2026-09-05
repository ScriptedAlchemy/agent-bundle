import { execFile as executeFile, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { descendantProcessIds } from '../../workbench/tests/support/packed-release-harness.ts';
import { formatServeAppReadyLine, parseServeAppReadyLine } from '../src/serve-app/command-contract.ts';
import { removeProjectSource } from '../src/test/packed.ts';
import { WEB_HOST_SEED_ELEMENT_ID, type WebHostPageSeed } from '../src/web-host/browser/seed.ts';
import { WEB_HOST_TOKEN_HEADER } from '../src/web-host/page.ts';
import { awaitStdoutLine, connectionRefused, isProcessGone, killAll, runBin, type BinRun } from './support/bin-process.ts';
import { eventuallyPasses, within } from './support/eventually.ts';
import {
  cachedNpmInstallArguments,
  installedEnvironment,
  packOutputFromJson,
  sharedPackedTarball,
} from './support/shared-pack.ts';
import { timeScale } from './support/time-scale.ts';

const execFile = promisify(executeFile);
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/web-surface');
const pluginName = 'web-surface-fixture';
const app = 'status/status';
const resourceUri = 'ui://web-surface-fixture/status.html';
// Fixture configures no tool; the live server resolves the one declaring this App.
const tool = 'status';
const agentBundleImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]agent-bundle(?:\/[^'"]*)?['"]/u;
// The web host is plain Node and must not carry the compiler's Effect runtime.
const effectImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]effect(?:\/[^'"]*)?['"]/u;
const seedElementPattern = new RegExp(`<script\\b(?=[^>]*\\btype="application/json")(?=[^>]*\\bid="${WEB_HOST_SEED_ELEMENT_ID}")[^>]*>([\\s\\S]*?)</script>`, 'u');
const startupBudget = 60_000 * timeScale;
const exitBudget = 5_000 * timeScale;
const teardownBudget = { attempts: 50 * timeScale, delayMs: 100 } as const;

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

let consumer = '';
let project = '';
let artifact = '';
let packageRoot = '';
let installedPackageRoot = '';
let artifactBin = '';
let bin = '';
let packedPaths: readonly string[] = [];
const spawned = new Set<ChildProcess>();
const observedProcessIds = new Set<number>();

const spawnBin = (executable: string, args: readonly string[], cwd = project): BinRun =>
  runBin(executable, args, { cwd, env: installedEnvironment(), track: spawned });

const seedOf = (html: string): WebHostPageSeed => {
  const match = seedElementPattern.exec(html);
  if (match?.[1] === undefined) throw new Error(`The served page carries no #${WEB_HOST_SEED_ELEMENT_ID} element:\n${html}`);
  return JSON.parse(match[1]) as WebHostPageSeed;
};

const expectTornDown = async (urls: readonly string[], processIds: readonly number[]): Promise<void> => {
  await eventuallyPasses(async () => {
    for (const processId of processIds) expect(isProcessGone(processId), `process ${String(processId)} is still alive`).toBe(true);
    for (const url of urls) expect(await connectionRefused(url), `${url} still accepts connections`).toBe(true);
  }, teardownBudget);
};

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
  packageRoot = join(project, 'dist');
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
  artifactBin = join(artifact, 'bin', `${pluginName}.mjs`);

  const tarballs = join(consumer, 'tarballs');
  const installedConsumer = join(consumer, 'installed-consumer');
  await Promise.all([
    mkdir(tarballs),
    mkdir(installedConsumer),
  ]);
  await writeFile(join(installedConsumer, 'package.json'), '{"private":true}\n');
  const { stdout: packJson } = await execFile('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    tarballs,
  ], { cwd: packageRoot, env: installedEnvironment() });
  const packed = packOutputFromJson(packJson, pluginName);
  packedPaths = packed.files.map((file) => file.path);
  await execFile('npm', [
    'install',
    ...cachedNpmInstallArguments,
    join(tarballs, packed.filename),
  ], { cwd: installedConsumer, env: installedEnvironment() });
  installedPackageRoot = join(installedConsumer, 'node_modules', pluginName);
  const packageDocument = JSON.parse(
    await readFile(join(installedPackageRoot, 'package.json'), 'utf8'),
  ) as { readonly bin?: Readonly<Record<string, string>> };
  const declaredBin = packageDocument.bin?.[pluginName];
  if (declaredBin === undefined) {
    throw new Error(`Packed ${pluginName} package does not declare its executable.`);
  }
  bin = resolve(installedPackageRoot, declaredBin);
  // `packed-deleted-source`: the bin serves out of the artifact alone, so the
  // config, the routes, the server, and the App view are removed and verified
  // absent before any process runs.
  const receipt = await removeProjectSource({ extraPaths: ['payload', 'views'], projectRoot: project });
  expect(receipt.removed).toEqual(['agent-bundle.config.ts', 'payload', 'src', 'views']);
}, 300_000);

afterAll(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  killAll(observedProcessIds);
  if (consumer.length > 0) await rm(consumer, { force: true, recursive: true });
});

it('builds the exposed App into the composite root: a manifest web section, one launch record on the server row, and one self-contained bin carrying the host', { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8')) as {
    readonly executables: { readonly mcpServers: readonly Readonly<Record<string, unknown>>[] };
    readonly web?: unknown;
  };
  const mcpEntries = (await readdir(join(artifact, 'mcp'))).filter((name) => name.endsWith('.mjs')).sort();
  expect(mcpEntries).toHaveLength(1);
  // `ArtifactManifestLaunch` (web-host/manifest.ts): the compiled server row
  // carries the one launch record. The plugin-root-anchored argument is an
  // `artifact` path (the packaged payload file), the flag a `literal`, and
  // the env keeps its plugin-data token for the launcher to expand.
  expect(manifest.executables.mcpServers).toEqual([{
    apps: [expect.objectContaining({ resourceUri })],
    hosts: ['portable'],
    id: 'mcp:status',
    kind: 'compiled',
    launch: {
      args: [{ kind: 'literal', value: '--config' }, { kind: 'artifact', path: 'config/status.json' }],
      entry: `mcp/${mcpEntries[0]!}`,
      env: { STATUS_CACHE: 'agent-bundle:path:plugin-data/cache', STATUS_MODE: 'packed' },
    },
    name: 'status',
    transport: 'stdio',
  }]);
  // `WebManifest` (web-host/manifest.ts): `open` defaults to `never`; the
  // fixture configures no `tool` and no `input`, so neither key is written;
  // the App names its server and carries no copy of the launch.
  expect(manifest.web).toEqual({
    apps: [{
      allow: ['call-tool'],
      app,
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
  expect(source).toContain(WEB_HOST_SEED_ELEMENT_ID);
});

it('packs the composite root as the npm root and runs the package.json bin with the artifact command surface byte-for-byte', async () => {
  expect(packedPaths).toContain('agent-bundle.manifest.json');
  expect(packedPaths).toContain(`bin/${pluginName}.mjs`);
  expect(packedPaths.some((path) => path.startsWith('artifact/'))).toBe(false);
  await expect(readFile(bin)).resolves.toEqual(await readFile(artifactBin));

  const [artifactHelp, packedHelp] = [artifactBin, bin].map((executable) =>
    spawnBin(executable, ['--help']));
  await Promise.all([
    expect(within(artifactHelp.exit, 30_000 * timeScale)).resolves.toEqual({ code: 0, signal: null }),
    expect(within(packedHelp.exit, 30_000 * timeScale)).resolves.toEqual({ code: 0, signal: null }),
  ]);
  expect(packedHelp.stdout()).toBe(artifactHelp.stdout());
  expect(packedHelp.stdout()).toMatch(/^\s+dashboard\b/mu);
  expect(packedHelp.stdout()).toMatch(/^\s+web\b/mu);

  const [artifactDashboard, packedDashboard] = [artifactBin, bin].map((executable) =>
    spawnBin(executable, ['dashboard', '--json']));
  await Promise.all([
    expect(within(artifactDashboard.exit, 30_000 * timeScale)).resolves.toEqual({ code: 0, signal: null }),
    expect(within(packedDashboard.exit, 30_000 * timeScale)).resolves.toEqual({ code: 0, signal: null }),
  ]);
  expect(packedDashboard.stdout()).toBe(artifactDashboard.stdout());

  const [artifactWebHelp, packedWebHelp] = [artifactBin, bin].map((executable) =>
    spawnBin(executable, ['web', '--help']));
  await Promise.all([
    expect(within(artifactWebHelp.exit, 30_000 * timeScale)).resolves.toEqual({ code: 0, signal: null }),
    expect(within(packedWebHelp.exit, 30_000 * timeScale)).resolves.toEqual({ code: 0, signal: null }),
  ]);
  expect(packedWebHelp.stdout()).toBe(artifactWebHelp.stdout());
});

it('serves the App from `web --json --no-open` as a real process out of the deleted-source consumer, gates its routes by token, and tears down on SIGINT', { timeout: 120_000 }, async () => {
  const run = spawnBin(bin, ['web', '--no-open', '--json']);
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
  expect(ready.sandboxOrigin).not.toBe(new URL(ready.url).origin);
  expect(run.stdout()).toBe(`${line}\n`);

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
    tokenHeader: WEB_HOST_TOKEN_HEADER,
    toolName: tool,
  });
  // The server echoes what it was started with: the launch record's artifact
  // argument resolved under the installed root, the literal as declared, and
  // the plugin-data token expanded outside the artifact.
  expect(seed.result).toMatchObject({
    structuredContent: {
      launch: {
        args: ['--config', join(installedPackageRoot, 'config', 'status.json')],
        cache: expect.stringMatching(/^(?!.*\/artifact\/).*\/\.agent-bundle\/web-data\/[^/]+\/status\/cache$/u),
        mode: 'packed',
      },
    },
  });
  expect(seed.token.length).toBeGreaterThan(0);
  expect(seed.sessionId.length).toBeGreaterThan(0);

  const anonymous = await fetch(new URL(`/api/mcp/sessions/${encodeURIComponent(seed.sessionId)}/apps`, ready.url), {
    body: '{}',
    headers: { 'content-type': 'application/json', origin: new URL(ready.url).origin },
    method: 'POST',
  });
  expect(anonymous.status).toBe(403);

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

  const unknownApp = spawnBin(bin, ['web', 'nope/nope', '--no-open']);
  expect(await within(unknownApp.exit, 30_000 * timeScale), unknownApp.stderr()).toEqual({ code: 2, signal: null });
  expect(unknownApp.stdout()).toBe('');
  expect(unknownApp.stderr()).toContain('nope/nope');
  expect(unknownApp.stderr()).toContain(app);

  const unknownAllow = spawnBin(bin, ['web', '--allow', 'camera', '--no-open']);
  expect(await within(unknownAllow.exit, 30_000 * timeScale), unknownAllow.stderr()).toEqual({ code: 2, signal: null });
  expect(unknownAllow.stdout()).toBe('');
  expect(unknownAllow.stderr()).toContain('camera');
});
