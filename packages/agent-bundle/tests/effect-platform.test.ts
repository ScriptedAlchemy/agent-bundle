import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option, Path, PlatformError } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import { liftPromise } from '../src/effect/lift.ts';
import { platformLayer, runWithPlatform, unwrapPlatformError, withTempDirectory } from '../src/effect/platform.ts';
import * as devApi from '../src/dev/index.ts';
import * as rootApi from '../src/index.ts';

/**
 * `runWithPlatform` is the Promise edge for platform-dependent programs:
 * the `withTempDirectory` bracket the public API (`temporaryArtifact`) and
 * the Codex validator use must remove the directory whichever way the
 * operation settles, and the failure contract must stay the one the
 * `try`/`finally` sites had.
 */
describe('effect platform layer (agent-bundle)', () => {
  it('is not part of any public export', () => {
    expect('runWithPlatform' in rootApi).toBe(false);
    expect('platformLayer' in rootApi).toBe(false);
    expect('runWithPlatform' in devApi).toBe(false);
  });

  it('unwraps a PlatformError to the Node error it carries, and keeps a bare one', async () => {
    const enoent: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory, mkdtemp '/nope/.agent-bundle-artifact-'");
    enoent.code = 'ENOENT';
    const wrapped = PlatformError.systemError({
      _tag: 'NotFound',
      cause: enoent,
      method: 'makeTempDirectoryScoped',
      module: 'FileSystem',
      pathOrDescriptor: '/nope',
    });
    expect(unwrapPlatformError(wrapped)).toBe(enoent);
    await expect(runWithPlatform(Effect.fail(wrapped))).rejects.toBe(enoent);

    const bare = PlatformError.systemError({
      _tag: 'NotFound',
      method: 'readFile',
      module: 'FileSystem',
      pathOrDescriptor: '/nope',
    });
    expect(unwrapPlatformError(bare)).toBe(bare);
    const typed = new DiagnosticError([{ code: 'AB7200', message: 'rebuild failed', severity: 'error' }]);
    expect(unwrapPlatformError(typed)).toBe(typed);
  });

  it('provides FileSystem and Path', async () => {
    const joined = await runWithPlatform(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(tmpdir())).toBe(true);
      return path.join('a', 'b');
    }));
    expect(joined).toBe(join('a', 'b'));
    expect(platformLayer).toBeDefined();
  });

  it('removes the temp directory after the operation succeeds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    try {
      const directory = await runWithPlatform(withTempDirectory(
        { directory: parent, prefix: '.staging-' },
        (created) => Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          expect(created.startsWith(join(parent, '.staging-'))).toBe(true);
          yield* fs.writeFileString(join(created, 'manifest.json'), '{}');
          yield* Effect.promise(() => access(created));
          return created;
        }),
      ));
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('removes the temp directory and rethrows the typed failure when the operation fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    let directory: string | undefined;
    const failure = new DiagnosticError([{ code: 'AB7200', message: 'rebuild failed', severity: 'error' }]);
    try {
      await expect(runWithPlatform(withTempDirectory(
        { directory: parent, prefix: '.staging-' },
        (created) => {
          directory = created;
          return liftPromise(() => Promise.reject(failure));
        },
      ))).rejects.toBe(failure);
      expect(directory).toBeDefined();
      await expect(access(directory!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('keeps the result when the operation already removed its temp directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    try {
      const result = await runWithPlatform(withTempDirectory(
        { directory: parent, prefix: '.staging-' },
        (created) => Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(created, { recursive: true });
          return 'settled';
        }),
      ));
      expect(result).toBe('settled');
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('removes the temp directory when the operation is interrupted', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    let directory: string | undefined;
    try {
      const exit = await runWithPlatform(Effect.exit(withTempDirectory(
        { directory: parent, prefix: '.staging-' },
        (created) => {
          directory = created;
          return Effect.interrupt;
        },
      )));
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(directory).toBeDefined();
      await expect(access(directory!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('lets an external interrupt reach the operation, then removes the temp directory', async () => {
    // `withTempDirectory` delegates to `ensuringRemoved` from inside its own
    // mask; the operation must still run at the caller's interruptibility,
    // or a fiber parked in it could never be interrupted.
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    try {
      const outcome = await runWithPlatform(Effect.gen(function* () {
        const created = yield* Deferred.make<string>();
        const fiber = yield* Effect.forkChild(withTempDirectory(
          { directory: parent, prefix: '.staging-' },
          (directory) => Deferred.succeed(created, directory).pipe(Effect.andThen(Effect.never)),
        ));
        const directory = yield* Deferred.await(created);
        const exit = yield* Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.timeoutOption('2 seconds'),
        );
        return { directory, exit };
      }));
      expect(Option.isSome(outcome.exit)).toBe(true);
      expect(Option.isSome(outcome.exit) && Exit.isFailure(outcome.exit.value) && Cause.hasInterrupts(outcome.exit.value.cause)).toBe(true);
      await expect(access(outcome.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('throws the Node error when the temp directory cannot be created', async () => {
    const missingParent = join(tmpdir(), 'agent-bundle-platform-missing', String(process.pid));
    await expect(runWithPlatform(withTempDirectory(
      { directory: missingParent, prefix: '.staging-' },
      (created) => Effect.succeed(created),
    ))).rejects.toMatchObject({ code: 'ENOENT', syscall: 'mkdtemp' });
  });

  describe('cleanup failures (FileSystem.layerNoop)', () => {
    const eacces: NodeJS.ErrnoException = new Error("EACCES: permission denied, rmdir '/virtual/tmp/.staging-1'");
    eacces.code = 'EACCES';
    const failingRemove = FileSystem.layerNoop({
      makeTempDirectory: () => Effect.succeed('/virtual/tmp/.staging-1'),
      remove: (path) => Effect.fail(PlatformError.systemError({
        _tag: 'PermissionDenied',
        cause: eacces,
        method: 'remove',
        module: 'FileSystem',
        pathOrDescriptor: path,
      })),
    });

    it('throws the Node cleanup error after a successful operation, as the former finally did', async () => {
      await expect(runWithPlatform(withTempDirectory(
        { prefix: '.staging-' },
        (created) => Effect.succeed(created),
      ).pipe(Effect.provide(failingRemove)))).rejects.toBe(eacces);
    });

    it('lets the cleanup error win when the operation failed too', async () => {
      const failure = new DiagnosticError([{ code: 'AB7200', message: 'rebuild failed', severity: 'error' }]);
      await expect(runWithPlatform(withTempDirectory(
        { prefix: '.staging-' },
        () => Effect.fail(failure),
      ).pipe(Effect.provide(failingRemove)))).rejects.toBe(eacces);
    });
  });
});
