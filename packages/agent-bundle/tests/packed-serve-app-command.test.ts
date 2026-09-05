import { execFile as executeFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { descendantProcessIds } from '../../workbench/tests/support/packed-release-harness.ts';
import { eventuallyPasses, within } from './support/eventually.ts';
import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';

/**
 * The `agent-bundle/serve-app-command` packed proof (#558): a plugin's routed
 * CLI command serves the plugin's own MCP App by spawning the *installed*
 * framework's `agent-bundle serve-app` through `spawnServeApp`, from inside
 * a generated executable that the installed framework built.
 *
 * One tarball set (the run-level shared pack), one scratch consumer copied
 * from `fixtures/serve-app-command`, one `agent-bundle build` with the
 * installed CLI, then the generated bins run as separate operating-system
 * processes: the package build's `dist/bin/<plugin>.js` and the composite
 * root's `bin/<plugin>.mjs`. The proof covers the ready-line relay to stderr
 * (stdout stays the JSON result), the served page, teardown of the
 * `serve-app` child and its packed MCP server, the request `signal` reaching
 * the child on Ctrl-C, and every `ServeAppCommandError` code a checkout can
 * hit without a seam: `artifact-missing`, `framework-not-installed`, and
 * `exited-before-ready`.
 */

const execFile = promisify(executeFile);
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/serve-app-command');
const pluginName = 'serve-app-command-fixture';
/** A live framework import surviving in a generated executable: `from "agent-bundle/..."` or `import("agent-bundle/...")`. */
const agentBundleImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]agent-bundle(?:\/[^'"]*)?['"]/u;
/** The `agent-bundle serve-app` ready line as the route relays it to stderr (`serve-app/command-contract.ts`). */
const readyLine = (url: string): string => `MCP App status/status at ${url} (tool status; Ctrl-C stops the server)`;
const readyLinePattern = /^MCP App status\/status at (?<url>http:\/\/127\.0\.0\.1:\d+\/) \(tool status; Ctrl-C stops the server\)$/mu;
const teardownBudget = { attempts: 50, delayMs: 100 } as const;

/** The fixture route's `resultSchema`. */
interface DashboardResult {
  readonly exitCode: number;
  readonly message: string;
  readonly pid: number | null;
  readonly probeStatus: number | null;
  readonly url: string | null;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface BinRun {
  readonly child: ChildProcess;
  readonly exit: Promise<ProcessExit>;
  stderr(): string;
  stdout(): string;
}

let consumer = '';
let project = '';
let packageBin = '';
let artifactBin = '';
/** Every bin this file spawned and every descendant it observed, killed on teardown if still alive. */
const spawned = new Set<ChildProcess>();
const observedProcessIds = new Set<number>();

/**
 * Runs one generated bin as `node <bin> <args>` with both output streams
 * piped — neither is a terminal, so the routed CLI emits its JSON result —
 * in the NODE_PATH-free installed environment.
 */
const runBin = (bin: string, args: readonly string[], cwd: string): BinRun => {
  const child = spawn(process.execPath, [bin, ...args], { cwd, env: installedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const exit = new Promise<ProcessExit>((settle, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      spawned.delete(child);
      settle({ code, signal });
    });
  });
  return { child, exit, stderr: () => stderr, stdout: () => stdout };
};

/** The one JSON result document a plain routed command prints: exactly one line, nothing else on stdout. */
const resultDocument = (stdout: string): DashboardResult => {
  const lines = stdout.split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe('');
  return JSON.parse(lines[0]!) as DashboardResult;
};

/** Resolves with the served URL once the relayed ready line reaches the bin's stderr; rejects if the bin exits first. */
const awaitReadyLine = (run: BinRun): Promise<string> => within(new Promise<string>((settle, reject) => {
  const check = (): void => {
    const url = readyLinePattern.exec(run.stderr())?.groups?.['url'];
    if (url !== undefined) settle(url);
  };
  run.child.stderr?.on('data', check);
  void run.exit.then(
    (exit) => reject(new Error(`The routed bin exited (${JSON.stringify(exit)}) before serving the App.\nstderr:\n${run.stderr()}`)),
    reject,
  );
  check();
}), 60_000);

/** Signal 0 probes for existence: `ESRCH` is the one outcome that means the process is gone. */
const processGone = (processId: number): void => {
  let outcome: unknown = 'alive';
  try {
    process.kill(processId, 0);
  } catch (error) {
    outcome = (error as NodeJS.ErrnoException).code;
  }
  expect(outcome).toBe('ESRCH');
};

const refused = async (url: string): Promise<boolean> => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

/** Polls (≤5s) until the served host refuses connections and every listed process is gone. */
const expectTornDown = async (url: string, processIds: readonly number[]): Promise<void> => {
  await eventuallyPasses(async () => {
    for (const processId of processIds) processGone(processId);
    expect(await refused(url)).toBe(true);
  }, teardownBudget);
};

beforeAll(async () => {
  const [agentBundle, runtime, markdownStream] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('runtime'),
    sharedPackedTarball('markdown-stream'),
  ]);
  consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-serve-app-command-'));
  project = join(consumer, 'project');
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
  // The installed CLI builds both surfaces at once: the composite root the
  // route serves from (`artifact/`) and the package build whose generated bin
  // carries the route (`dist/bin/`).
  const cli = join(project, 'node_modules', '.bin', 'agent-bundle');
  await execFile(cli, ['build', '--root', project, '--output', join(project, 'artifact')], {
    cwd: project,
    env: installedEnvironment(),
  });
  packageBin = join(project, 'dist', 'bin', `${pluginName}.js`);
  artifactBin = join(project, 'artifact', 'bin', `${pluginName}.mjs`);
}, 300_000);

afterAll(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  for (const processId of observedProcessIds) {
    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // Already gone, which is what the tests asserted.
    }
  }
  if (consumer.length > 0) await rm(consumer, { force: true, recursive: true });
});

it('builds the routed command with the installed framework into self-contained package and artifact bins', { timeout: 60_000 }, async () => {
  await expect(stat(join(project, 'artifact', 'agent-bundle.manifest.json'))).resolves.toMatchObject({});
  expect((await stat(packageBin)).mode & 0o111).not.toBe(0);
  for (const bin of [packageBin, artifactBin]) {
    const source = await readFile(bin, 'utf8');
    // The helper was inlined (a residual framework import would have failed
    // the build as AB6005 anyway): no live `agent-bundle` import remains, and
    // the ready-line contract it parses is part of the executable's bytes.
    expect(source).not.toMatch(agentBundleImport);
    expect(source).toContain('Ctrl-C stops the server');
  }
});

it('serves the App from the routed command, relays the ready line to stderr, and tears the server down (probe run)', { timeout: 120_000 }, async () => {
  for (const bin of [packageBin, artifactBin]) {
    // `root: process.cwd()` / `artifact: 'artifact'` in the route: the
    // checkout root is the working directory, as for a real `pnpm exec`.
    const run = runBin(bin, ['dashboard', '--probe', '--no-open'], project);
    const exit = await within(run.exit, 90_000);
    expect(exit, run.stderr()).toEqual({ code: 0, signal: null });
    const result = resultDocument(run.stdout());
    expect(result).toEqual({
      exitCode: 0,
      message: 'dashboard closed',
      pid: expect.any(Number),
      probeStatus: 200,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
    });
    expect(Number.isInteger(result.pid) && result.pid! > 0).toBe(true);
    observedProcessIds.add(result.pid!);
    // The child's stdout (its ready line) was relayed to the bin's stderr —
    // the operator's channel — so stdout stayed the one JSON document.
    expect(run.stderr()).toContain(readyLine(result.url!));
    expect(run.stderr()).not.toContain('"exitCode"');
    // `close()` ended `agent-bundle serve-app` (the reported pid) and, with
    // it, the host and the packed MCP server behind it.
    await expectTornDown(result.url!, [result.pid!]);
  }
});

it('stops the served App when the routed bin receives SIGINT: the request signal reaches the serve-app child (signal run)', { timeout: 120_000 }, async () => {
  const run = runBin(packageBin, ['dashboard', '--no-open'], project);
  const url = await awaitReadyLine(run);
  expect((await fetch(url)).status).toBe(200);
  // The `serve-app` CLI and, under it, the packed MCP server it launched.
  const descendants = await descendantProcessIds(run.child.pid!);
  expect(descendants.length).toBeGreaterThanOrEqual(1);
  for (const processId of descendants) observedProcessIds.add(processId);

  run.child.kill('SIGINT');
  // The generated CLI shell (`cli-entry.ts`) maps SIGINT to exit 130: the
  // signal aborts the route's request `AbortSignal`, `spawnServeApp` turns the
  // abort into the child's SIGTERM, `agent-bundle serve-app` closes and exits
  // 0, the route returns — and the shell, finding the request aborted, prints
  // `Aborted.` on stderr instead of the result and exits with the signal's
  // code. Nothing reaches stdout.
  const exit = await within(run.exit, 30_000);
  expect(exit, run.stderr()).toEqual({ code: 130, signal: null });
  expect(run.stdout()).toBe('');
  expect(run.stderr()).toContain(readyLine(url));
  expect(run.stderr()).toContain('Aborted.\n');
  await expectTornDown(url, descendants);
});

it('reports every ServeAppCommandError as the result document, with the route\'s exit code (failure paths)', { timeout: 120_000 }, async () => {
  // `artifact-missing`: a working directory under the consumer still resolves
  // `node_modules/agent-bundle` above it, but has no `artifact/`.
  const unbuilt = join(project, 'unbuilt');
  await mkdir(unbuilt, { recursive: true });
  const missing = runBin(packageBin, ['dashboard', '--no-open'], unbuilt);
  expect(await within(missing.exit, 60_000), missing.stderr()).toEqual({ code: 1, signal: null });
  expect(resultDocument(missing.stdout())).toEqual({
    exitCode: 1,
    message: expect.stringMatching(/^artifact-missing: No built artifact at .*[\\/]unbuilt[\\/]artifact\. Run `agent-bundle build` first/u),
    pid: null,
    probeStatus: null,
    url: null,
  });

  // `framework-not-installed`: the self-contained bin runs anywhere, but only
  // a checkout (or a consumer that installed `agent-bundle`) can serve.
  const noFramework = join(consumer, 'no-framework');
  await mkdir(noFramework, { recursive: true });
  const uninstalled = runBin(packageBin, ['dashboard', '--no-open'], noFramework);
  expect(await within(uninstalled.exit, 60_000), uninstalled.stderr()).toEqual({ code: 1, signal: null });
  expect(resultDocument(uninstalled.stdout())).toEqual({
    exitCode: 1,
    message: expect.stringMatching(/^framework-not-installed: agent-bundle is not installed for the project at .*[\\/]no-framework: no node_modules\/agent-bundle\/package\.json resolves from it\./u),
    pid: null,
    probeStatus: null,
    url: null,
  });

  // `exited-before-ready`: the artifact exists but is empty, so the spawned
  // `agent-bundle serve-app` fails (AB6000) before its ready line; its
  // diagnostics arrive on the bin's inherited stderr, the result names the
  // exit, and stdout is still exactly one document.
  const broken = join(project, 'broken');
  await mkdir(join(broken, 'artifact'), { recursive: true });
  const unready = runBin(packageBin, ['dashboard', '--no-open'], broken);
  expect(await within(unready.exit, 60_000), unready.stderr()).toEqual({ code: 1, signal: null });
  expect(resultDocument(unready.stdout())).toEqual({
    exitCode: 1,
    message: 'exited-before-ready: agent-bundle serve-app exited with exit code 1 before serving status/status; its diagnostics are on stderr.',
    pid: null,
    probeStatus: null,
    url: null,
  });
  expect(unready.stderr()).toContain('"code":"AB6000"');
});
