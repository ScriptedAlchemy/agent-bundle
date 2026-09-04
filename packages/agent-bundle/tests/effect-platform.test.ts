import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, FileSystem, Path, PlatformError } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import { liftPromise } from '../src/effect/lift.ts';
import { platformLayer, runWithPlatform, unwrapPlatformError } from '../src/effect/platform.ts';
import * as devApi from '../src/dev/index.ts';
import * as rootApi from '../src/index.ts';

/**
 * `runWithPlatform` is the Promise edge for platform-dependent programs:
 * the scoped-temp-directory idiom the public API (`temporaryArtifact`) and
 * the Codex validator use must remove the directory whichever way the
 * program settles, and the failure contract must stay the boundary's.
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

  it('removes a scoped temp directory after the program succeeds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    try {
      const directory = await runWithPlatform(Effect.scoped(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const created = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: '.staging-' });
        expect(created.startsWith(join(parent, '.staging-'))).toBe(true);
        yield* fs.writeFileString(join(created, 'manifest.json'), '{}');
        yield* Effect.promise(() => access(created));
        return created;
      })));
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('removes the scoped temp directory and rethrows the typed failure when the program fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-platform-'));
    let directory: string | undefined;
    const failure = new DiagnosticError([{ code: 'AB7200', message: 'rebuild failed', severity: 'error' }]);
    try {
      await expect(runWithPlatform(Effect.scoped(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        directory = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: '.staging-' });
        yield* liftPromise(() => Promise.reject(failure));
      })))).rejects.toBe(failure);
      expect(directory).toBeDefined();
      await expect(access(directory!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it('throws the Node error when the temp directory cannot be created', async () => {
    const missingParent = join(tmpdir(), 'agent-bundle-platform-missing', String(process.pid));
    await expect(runWithPlatform(Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectoryScoped({ directory: missingParent, prefix: '.staging-' });
    })))).rejects.toMatchObject({ code: 'ENOENT', syscall: 'mkdtemp' });
  });
});
