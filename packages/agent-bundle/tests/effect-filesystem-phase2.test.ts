import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, FileSystem, Option, PlatformError } from 'effect';
import { afterEach, describe, expect, it } from '@rstest/core';

import { runPromise } from '../src/effect/boundary.ts';
import { isPlatformErrno, readFileBytes, readFileString, runWithPlatform } from '../src/effect/platform.ts';
import { createTemporaryCodexTrialHome, removeTemporaryCodexTrialHome } from '../src/eval/codex-home.ts';
import { materializeEvalFixture, planEvalFixture } from '../src/eval/fixtures.ts';
import { copyOpaqueCodexAuthStateProgram } from '../src/host-contracts/native-codex-contract.ts';
import { validatePortablePluginFiles } from '../src/host-contracts/portable-plugin-validation.ts';
import { forwardingSignals } from '../src/services/mcp-run-signals.ts';

/**
 * Phase-2 FileSystem adoption: the ordinary reads, copies, and temp
 * directories in host-contracts, services, eval, and the post-build readers
 * now run as `FileSystem` programs through `runWithPlatform`. These tests pin
 * the contracts the `try`/`catch` predecessors had — the same Node errors at
 * the boundary, the same bytes, the same branches on `ENOENT`/`ELOOP` — with
 * `FileSystem.layerNoop` for the call paths and real directories for the OS
 * semantics.
 */
const roots: string[] = [];
const scratch = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const errno = (code: string, message: string): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
};

const wrapped = (cause: NodeJS.ErrnoException, method: string, path: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: 'NotFound', cause, method, module: 'FileSystem', pathOrDescriptor: path });

const fileInfo = (mode: number): FileSystem.File.Info => ({
  atime: Option.none(),
  birthtime: Option.none(),
  blksize: Option.none(),
  blocks: Option.none(),
  dev: 0,
  gid: Option.none(),
  ino: Option.none(),
  mode,
  mtime: Option.none(),
  nlink: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(3),
  type: 'File',
  uid: Option.none(),
});

describe('readFileString / readFileBytes', () => {
  it('decodes exactly as readFile(path, "utf8"): a leading BOM survives', async () => {
    const root = await scratch('agent-bundle-fs-phase2-');
    const path = join(root, 'bom.json');
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]));
    const text = await runWithPlatform(readFileString(path));
    expect(text).toBe(await readFile(path, 'utf8'));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const bytes = await runWithPlatform(readFileBytes(path));
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.equals(await readFile(path))).toBe(true);
  });

  it('surfaces a missing file as the Node ENOENT error at the Promise boundary', async () => {
    const root = await scratch('agent-bundle-fs-phase2-');
    await expect(runWithPlatform(readFileString(join(root, 'absent.json')))).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'open',
    });
  });
});

describe('isPlatformErrno', () => {
  it('matches the wrapped Node cause, a bare Node error, and nothing else', () => {
    const enoent = errno('ENOENT', 'no such file');
    expect(isPlatformErrno(wrapped(enoent, 'readFile', '/nope'), 'ENOENT')).toBe(true);
    expect(isPlatformErrno(wrapped(enoent, 'readFile', '/nope'), 'ENOTDIR', 'ELOOP')).toBe(false);
    expect(isPlatformErrno(enoent, 'EACCES', 'ENOENT')).toBe(true);
    expect(isPlatformErrno(new Error('plain'), 'ENOENT')).toBe(false);
    expect(isPlatformErrno(undefined, 'ENOENT')).toBe(false);
  });

  it('is the branch a program takes where the predecessor caught the errno', async () => {
    const root = await scratch('agent-bundle-fs-phase2-');
    const kind = await runWithPlatform(readFileString(join(root, 'missing', 'file')).pipe(
      Effect.map(() => 'present'),
      Effect.catch((error) => isPlatformErrno(error, 'ENOENT', 'ENOTDIR')
        ? Effect.succeed('missing')
        : Effect.fail(error)),
    ));
    expect(kind).toBe('missing');
  });
});

describe('portable plugin validation on FileSystem', () => {
  const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

  it('treats a symlink loop at a stdio command like a missing bundled file (ELOOP)', async () => {
    const root = await scratch('agent-bundle-fs-phase2-portable-');
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      $schema: pluginSchema,
      description: 'Loop fixture',
      name: 'loop-fixture',
      version: '1.0.0',
    }));
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: mcpSchema,
      mcpServers: { looped: { command: './bin/loop', type: 'stdio' } },
    }));
    await mkdir(join(root, 'bin'));
    await symlink('loop', join(root, 'bin', 'loop'));
    await expect(stat(join(root, 'bin', 'loop'))).rejects.toMatchObject({ code: 'ELOOP' });

    const diagnostics = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      'mcp.json/mcpServers/looped/command "./bin/loop" does not resolve to a bundled regular file (Agent Plugins 1.0.0 §7.2.1).',
    );
  });
});

describe('copyOpaqueCodexAuthStateProgram', () => {
  it('stats the source, creates the parent, copies, and re-applies the permission bits', async () => {
    const calls: string[] = [];
    const layer = FileSystem.layerNoop({
      chmod: (path, mode) => Effect.sync(() => { calls.push(`chmod ${path} ${mode.toString(8)}`); }),
      copyFile: (from, to) => Effect.sync(() => { calls.push(`copyFile ${from} ${to}`); }),
      makeDirectory: (path, options) => Effect.sync(() => { calls.push(`makeDirectory ${path} ${String(options?.recursive)}`); }),
      stat: (path) => Effect.sync(() => {
        calls.push(`stat ${path}`);
        return fileInfo(0o100600);
      }),
    });
    await runPromise(copyOpaqueCodexAuthStateProgram('/home/u/.codex/auth.json', '/tmp/trial/home/auth.json').pipe(
      Effect.provide(layer),
    ));
    expect(calls).toEqual([
      'stat /home/u/.codex/auth.json',
      'makeDirectory /tmp/trial/home true',
      'copyFile /home/u/.codex/auth.json /tmp/trial/home/auth.json',
      'chmod /tmp/trial/home/auth.json 600',
    ]);
  });

  it('copies nothing when the source is missing and rejects with the Node error', async () => {
    const enoent = errno('ENOENT', "ENOENT: no such file or directory, stat '/home/u/.codex/auth.json'");
    const calls: string[] = [];
    const layer = FileSystem.layerNoop({
      copyFile: (from) => Effect.sync(() => { calls.push(`copyFile ${from}`); }),
      stat: (path) => Effect.fail(wrapped(enoent, 'stat', path)),
    });
    await expect(runWithPlatform(copyOpaqueCodexAuthStateProgram('/home/u/.codex/auth.json', '/tmp/trial/home/auth.json').pipe(
      Effect.provide(layer),
    ))).rejects.toBe(enoent);
    expect(calls).toEqual([]);
  });
});

describe('codex trial home', () => {
  it('creates the prefixed root with its home directory and removes it on request', async () => {
    const parent = join(await scratch('agent-bundle-fs-phase2-codex-'), 'nested', 'trials');
    const trial = await createTemporaryCodexTrialHome(parent);
    expect(trial.root.startsWith(join(parent, 'agent-bundle-codex-trial-'))).toBe(true);
    expect(trial.home).toBe(join(trial.root, 'home'));
    expect(trial.candidate).toBe(join(trial.root, 'candidate'));
    expect(trial.workspace).toBe(join(trial.root, 'workspace'));
    await expect(stat(trial.home)).resolves.toMatchObject({});
    await expect(access(trial.candidate)).rejects.toMatchObject({ code: 'ENOENT' });

    await removeTemporaryCodexTrialHome(trial.root);
    await expect(access(trial.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeTemporaryCodexTrialHome(trial.root)).resolves.toBeUndefined();
  });
});

describe('eval fixture materialization', () => {
  it('copies planned files with their modes and rejects a source changed after planning', async () => {
    const root = await scratch('agent-bundle-fs-phase2-fixture-');
    const suite = join(root, 'suite');
    await mkdir(join(suite, 'fixture', 'nested'), { recursive: true });
    await writeFile(join(suite, 'fixture', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(suite, 'fixture', 'nested', 'data.txt'), 'data\n');
    const plan = await planEvalFixture({ baseDir: suite, fixture: { git: false, include: ['**/*'], path: 'fixture' } });

    const destination = join(root, 'trial-1');
    const materialized = await materializeEvalFixture({ destination, plan });
    expect(materialized.path).toBe(destination);
    expect((await stat(join(destination, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(destination, 'nested', 'data.txt'))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(destination, 'nested', 'data.txt'), 'utf8')).toBe('data\n');

    await writeFile(join(suite, 'fixture', 'nested', 'data.txt'), 'changed\n');
    await expect(materializeEvalFixture({ destination: join(root, 'trial-2'), plan })).rejects.toMatchObject({
      code: 'EVAL_FIXTURE_SOURCE_INVALID',
    });
    await expect(materializeEvalFixture({ destination, plan })).rejects.toMatchObject({
      code: 'EVAL_FIXTURE_DESTINATION_EXISTS',
    });
  });
});

describe('mcp run signal forwarding', () => {
  it('forwards SIGINT/SIGTERM to the child only while the scope is open', async () => {
    const signals: string[] = [];
    const child = new EventEmitter() as ChildProcess;
    child.kill = (signal) => { signals.push(String(signal)); return true; };
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');

    await runPromise(Effect.scoped(Effect.gen(function* () {
      yield* forwardingSignals(child);
      expect(process.listenerCount('SIGINT')).toBe(sigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(sigterm + 1);
      process.emit('SIGINT');
      process.emit('SIGTERM');
    })));

    expect(signals).toEqual(['SIGINT', 'SIGTERM']);
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
    process.emit('SIGINT');
    expect(signals).toEqual(['SIGINT', 'SIGTERM']);
  });
});
