import { Effect, PlatformError } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { describeError, runPromise, toCliError } from '../src/effect/boundary.ts';
import { UsageError } from '../src/options.ts';

/**
 * The Promise edge keeps the CLI's observable failure contract: typed
 * `UsageError` and plain `Error` values rethrow as the same instances, and a
 * `PlatformError` unwraps to the Node error it wraps so messages match what
 * the scaffolder printed before the filesystem moved onto Effect.
 */

const enoent = (): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory, open '/tmp/missing.tgz'");
  error.code = 'ENOENT';
  error.syscall = 'open';
  error.path = '/tmp/missing.tgz';
  return error;
};

const wrapped = (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: 'NotFound',
    cause,
    method: 'readFile',
    module: 'FileSystem',
    pathOrDescriptor: '/tmp/missing.tgz',
  });

describe('create-agent-bundle effect boundary', () => {
  it('rethrows a usage error as the same instance', async () => {
    const error = new UsageError('bad flag');
    await expect(runPromise(Effect.fail(error))).rejects.toBe(error);
  });

  it('unwraps a platform error to the Node error it carries', async () => {
    const cause = enoent();
    await expect(runPromise(Effect.fail(wrapped(cause)))).rejects.toBe(cause);
    expect(describeError(wrapped(cause))).toBe("ENOENT: no such file or directory, open '/tmp/missing.tgz'");
  });

  it('keeps a platform error without an Error cause as itself', () => {
    const error = wrapped(undefined);
    expect(toCliError(error)).toBe(error);
    expect(describeError(error)).toBe('NotFound: FileSystem.readFile (/tmp/missing.tgz)');
  });

  it('rethrows defects as their Error and wraps non-Error values', async () => {
    const drift = new Error('Template drift: agent-bundle.config.ts no longer contains `targets: [...]`.');
    await expect(runPromise(Effect.die(drift))).rejects.toBe(drift);
    await expect(runPromise(Effect.fail('plain string'))).rejects.toThrow('plain string');
  });

  it('maps interruption to an AbortError', async () => {
    await expect(runPromise(Effect.interrupt)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
