import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { isErrno } from '../src/core/errors.ts';
import { formatServeAppReadyLine } from '../src/serve-app/command-contract.ts';
import {
  ServeAppCommandError,
  serveAppArgv,
  spawnServeApp,
  type SpawnServeAppOptions,
} from '../src/serve-app-command.ts';
import { eventuallyPasses } from './support/eventually.ts';
import { timeScale } from './support/time-scale.ts';

/**
 * `spawnServeApp` against fake `agent-bundle` CLIs: one `.mjs` per scenario,
 * written under a temporary directory and run through the injected `cli`, so
 * the ready-line, relay, abort, and exit contracts are exercised with real
 * child processes and no build. The last test runs the checkout's real CLI
 * to confirm its fast failure is classified the same way.
 */

const app = 'hauler/dashboard';
const ready = { app, tool: 'hauler_status', url: 'http://127.0.0.1:4941/' };
const readyLine = formatServeAppReadyLine(ready);
const realCli = join(import.meta.dirname, '..', 'bin', 'agent-bundle.js');

/** The single-signature shape the module calls `spawn` with; `typeof spawn` itself is overloaded. */
type SpawnLike = (...args: Parameters<typeof spawnChildProcess>) => ChildProcess;
const asSpawn = (fake: SpawnLike): typeof spawnChildProcess => fake as typeof spawnChildProcess;

const temporaryDirectories: string[] = [];
const spawnedPids: number[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-serve-app-spawn-')));
  temporaryDirectories.push(directory);
  return directory;
};

/** `kill -0`: true while the process exists (not yet reaped). */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    throw error;
  }
};

/** The real `spawn`, recording every child so a failing test cannot leak one. */
const trackingSpawn = asSpawn((...args) => {
  const child = spawnChildProcess(...args);
  if (child.pid !== undefined) spawnedPids.push(child.pid);
  return child;
});

const writeFakeCli = async (directory: string, name: string, lines: readonly string[]): Promise<string> => {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
};

/**
 * A fake `agent-bundle` that records its argv to `argvFile`, prints a noise
 * line and then the ready line, stays up, and exits 0 on SIGTERM — the
 * handler is installed before the ready line so a `close()` that follows it
 * is never racing the handler.
 */
const servingCli = async (directory: string): Promise<{ readonly argvFile: string; readonly cli: string }> => {
  const argvFile = join(directory, 'argv.json');
  const cli = await writeFakeCli(directory, 'serving', [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    "process.on('SIGTERM', () => { process.exit(0); });",
    "process.stdout.write('Building…\\n');",
    `process.stdout.write(${JSON.stringify(`${readyLine}\n`)});`,
    'setInterval(() => undefined, 60_000);',
  ]);
  return { argvFile, cli };
};

const rejection = async (pending: Promise<unknown>): Promise<ServeAppCommandError> => {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(ServeAppCommandError);
    return error as ServeAppCommandError;
  }
  throw new Error('Expected spawnServeApp to reject.');
};

const relayInto = (lines: string[]): SpawnServeAppOptions['relay'] => (line) => { lines.push(line); };

/** Bounded polling (about two seconds, scaled for shared machines) for a process-level fact. */
const polling = { attempts: 400 * timeScale, delayMs: 5 } as const;

const untilGone = (pid: number): Promise<void> =>
  eventuallyPasses(() => { expect(isAlive(pid)).toBe(false); }, polling);

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) throw error;
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

it('serves through the CLI: relays every stdout line, resolves on the ready line, and closes on SIGTERM', async () => {
  const root = await temporaryDirectory();
  const { argvFile, cli } = await servingCli(root);
  const lines: string[] = [];
  const options: SpawnServeAppOptions = {
    app,
    cli,
    port: 4941,
    relay: relayInto(lines),
    root,
    spawn: trackingSpawn,
    tool: 'hauler_status',
  };
  const served = await spawnServeApp(options);
  expect(served).toMatchObject({ ...ready, port: 4941, server: 'hauler' });
  expect(served.pid).toBeGreaterThan(0);
  expect(spawnedPids).toEqual([served.pid]);
  expect(isAlive(served.pid)).toBe(true);
  expect(lines).toEqual(['Building…', readyLine]);
  expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual(serveAppArgv(options));

  await expect(served.close()).resolves.toEqual({ code: 0, signal: null });
  await expect(served.closed).resolves.toEqual({ code: 0, signal: null });
  expect(isAlive(served.pid)).toBe(false);
  expect(() => process.kill(served.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  await expect(served.close()).resolves.toEqual({ code: 0, signal: null });
});

it('rejects exited-before-ready with the exit when the CLI ends without printing its ready line', async () => {
  const root = await temporaryDirectory();
  const cli = await writeFakeCli(root, 'failing', [
    "process.stderr.write('AB6000 fake diagnostic: no artifact manifest (expected in this test)\\n');",
    'process.exitCode = 1;',
  ]);
  const lines: string[] = [];
  const failure = await rejection(spawnServeApp({ app, cli, relay: relayInto(lines), root, spawn: trackingSpawn }));
  expect(failure.name).toBe('ServeAppCommandError');
  expect(failure.code).toBe('exited-before-ready');
  expect(failure.exit).toEqual({ code: 1, signal: null });
  expect(failure.message).toContain(app);
  expect(failure.message).toContain('exit code 1');
  expect(lines).toEqual([]);
});

it('rejects aborted and ends the child when the signal aborts before the ready line', async () => {
  const root = await temporaryDirectory();
  const cli = await writeFakeCli(root, 'silent', ['setInterval(() => undefined, 60_000);']);
  const controller = new AbortController();
  const lines: string[] = [];
  const pending = spawnServeApp({ app, cli, relay: relayInto(lines), root, signal: controller.signal, spawn: trackingSpawn });
  await eventuallyPasses(() => { expect(spawnedPids).toHaveLength(1); }, polling);
  controller.abort();
  const failure = await rejection(pending);
  expect(failure.code).toBe('aborted');
  expect(failure.exit).toBeUndefined();
  expect(failure.message).toContain(app);
  await untilGone(spawnedPids[0]!);
  expect(lines).toEqual([]);
});

it('tears the served App down when the signal aborts after the ready line', async () => {
  const root = await temporaryDirectory();
  const { cli } = await servingCli(root);
  const controller = new AbortController();
  const served = await spawnServeApp({ app, cli, relay: relayInto([]), root, signal: controller.signal, spawn: trackingSpawn });
  expect(isAlive(served.pid)).toBe(true);
  controller.abort();
  await expect(served.closed).resolves.toEqual({ code: 0, signal: null });
  expect(isAlive(served.pid)).toBe(false);
});

it('rejects aborted without spawning when the signal is already aborted', async () => {
  const root = await temporaryDirectory();
  const { cli } = await servingCli(root);
  const failure = await rejection(spawnServeApp({ app, cli, relay: relayInto([]), root, signal: AbortSignal.abort(), spawn: trackingSpawn }));
  expect(failure.code).toBe('aborted');
  expect(failure.message).toContain(app);
  expect(spawnedPids).toEqual([]);
});

// The abort event has already been dispatched by the time the child exists
// and the listener is registered, so this relies on the post-spawn
// `signal.aborted` re-check: without it the App would be served and stay up
// under an aborted signal.
it('rejects aborted and ends the child when the signal aborts during the artifact check, before the spawn', async () => {
  const root = await temporaryDirectory();
  const { cli } = await servingCli(root);
  const artifact = await temporaryDirectory();
  const controller = new AbortController();
  const lines: string[] = [];
  const pending = spawnServeApp({ app, artifact, cli, relay: relayInto(lines), root, signal: controller.signal, spawn: trackingSpawn });
  expect(spawnedPids).toEqual([]);
  controller.abort();
  const failure = await rejection(pending);
  expect(failure.code).toBe('aborted');
  expect(spawnedPids).toHaveLength(1);
  await untilGone(spawnedPids[0]!);
  expect(lines).toEqual([]);
});

it('rejects framework-not-installed when no agent-bundle resolves from root', async () => {
  const root = await temporaryDirectory();
  const failure = await rejection(spawnServeApp({ app, relay: relayInto([]), root, spawn: trackingSpawn }));
  expect(failure.code).toBe('framework-not-installed');
  expect(failure.exit).toBeUndefined();
  expect(failure.message).toContain(root);
  expect(failure.message).toContain('node_modules/agent-bundle');
  expect(spawnedPids).toEqual([]);
});

it('rejects artifact-missing before spawning when the artifact path does not exist', async () => {
  const root = await temporaryDirectory();
  const { cli } = await servingCli(root);
  const artifact = join(root, 'missing');
  const failure = await rejection(spawnServeApp({ app, artifact, cli, relay: relayInto([]), root, spawn: trackingSpawn }));
  expect(failure.code).toBe('artifact-missing');
  expect(failure.message).toContain(resolve(artifact));
  expect(failure.message).toContain('agent-bundle build');
  expect(spawnedPids).toEqual([]);
});

it('rejects spawn-failed with the cause whether spawn throws or the child reports the failure', async () => {
  const root = await temporaryDirectory();
  const { cli } = await servingCli(root);
  const boom = new Error('boom');
  const thrown = await rejection(spawnServeApp({ app, cli, relay: relayInto([]), root, spawn: asSpawn(() => { throw boom; }) }));
  expect(thrown.code).toBe('spawn-failed');
  expect(thrown.cause).toBe(boom);
  expect(thrown.message).toContain(cli);

  const missingBinary = asSpawn((_command, args, options) => spawnChildProcess('/nonexistent/binary', args, options));
  const reported = await rejection(spawnServeApp({ app, cli, relay: relayInto([]), root, spawn: missingBinary }));
  expect(reported.code).toBe('spawn-failed');
  expect(reported.cause).toMatchObject({ code: 'ENOENT' });
  expect(reported.message).toContain(cli);
});

it('keeps closed pending through a post-spawn error until the child really exits', async () => {
  // Node reports a failed `kill()` on a running child as `error`; unlike a
  // spawn failure the process is still alive, so the exit must not be
  // fabricated: `closed` settles with the real exit, `close()` still works.
  const root = await temporaryDirectory();
  const { cli } = await servingCli(root);
  let child: ChildProcess | undefined;
  const capturing = asSpawn((...args) => {
    child = trackingSpawn(...args);
    return child;
  });
  const served = await spawnServeApp({ app, cli, relay: relayInto([]), root, spawn: capturing });
  child!.emit('error', new Error('kill EPERM'));
  let settled = false;
  void served.closed.then(() => { settled = true; });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  expect(settled).toBe(false);
  expect(isAlive(served.pid)).toBe(true);
  await expect(served.close()).resolves.toEqual({ code: 0, signal: null });
  await untilGone(served.pid);
});

it('carries a post-spawn error as the cause when the child then exits before its ready line', async () => {
  const root = await temporaryDirectory();
  // The handler is installed before the noise line, so a SIGTERM that
  // follows the line is never racing it.
  const cli = await writeFakeCli(root, 'never-ready', [
    "process.on('SIGTERM', () => { process.exit(3); });",
    "process.stdout.write('Building…\\n');",
    'setInterval(() => undefined, 60_000);',
  ]);
  let child: ChildProcess | undefined;
  const capturing = asSpawn((...args) => {
    child = trackingSpawn(...args);
    return child;
  });
  const lines: string[] = [];
  const pending = spawnServeApp({ app, cli, relay: relayInto(lines), root, spawn: capturing });
  await eventuallyPasses(() => { expect(lines).toEqual(['Building…']); }, polling);
  const late = new Error('kill EPERM');
  child!.emit('error', late);
  child!.kill('SIGTERM');
  const failure = await rejection(pending);
  expect(failure.code).toBe('exited-before-ready');
  expect(failure.exit).toEqual({ code: 3, signal: null });
  expect(failure.cause).toBe(late);
});

it('classifies the real CLI failing fast on a missing artifact manifest as exited-before-ready', async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const artifact = await temporaryDirectory();
  const lines: string[] = [];
  const failure = await rejection(spawnServeApp({
    app: 'nope/nope',
    artifact,
    cli: realCli,
    relay: relayInto(lines),
    root,
    spawn: trackingSpawn,
  }));
  expect(failure.code).toBe('exited-before-ready');
  expect(failure.exit).toEqual({ code: 1, signal: null });
  expect(failure.message).toContain('nope/nope');
  expect(lines).toEqual([]);
}, 30_000);
