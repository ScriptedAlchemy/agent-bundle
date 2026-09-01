import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import * as devApi from '../src/dev/index.ts';
import { EpochStoreError } from '../src/dev/epoch-store.ts';
import { DevLockError } from '../src/dev/dev-lock.ts';
import { ProjectEventHubError } from '../src/dev/events.ts';
import {
  abortError,
  interruptWhenAborted,
  isAbortError,
  isTypedDevError,
  mapCause,
  runPromise,
  runPromiseExit,
  runSync,
  toDevError,
} from '../src/effect/boundary.ts';
import * as rootApi from '../src/index.ts';

describe('effect boundary (agent-bundle dev seam)', () => {
  it('is not part of any public export', () => {
    expect('runPromise' in rootApi).toBe(false);
    expect('runSync' in rootApi).toBe(false);
    expect('runPromise' in devApi).toBe(false);
    expect('interruptWhenAborted' in devApi).toBe(false);
  });

  it('resolves a successful effect', async () => {
    await expect(runPromise(Effect.succeed(41))).resolves.toBe(41);
    expect(runSync(Effect.succeed('ok'))).toBe('ok');
  });

  it('rethrows the dev seam typed errors from the fail channel unchanged', async () => {
    const store = new EpochStoreError('EPOCH_NOT_FOUND', 'Epoch "e1" does not exist.');
    const lock = new DevLockError('DEV_LOCK_HELD', 'Another agent-bundle dev process owns this project.');
    const hub = new ProjectEventHubError('PROJECT_EVENT_CURSOR_AHEAD', 'cursor is ahead');
    const diagnostics = new DiagnosticError([
      { code: 'AB7200', message: 'rebuild failed', severity: 'error' },
    ]);
    for (const error of [store, lock, hub, diagnostics]) {
      expect(isTypedDevError(error)).toBe(true);
      await expect(runPromise(Effect.fail(error))).rejects.toBe(error);
    }
  });

  it('maps interruption to DOMException AbortError', async () => {
    const mapped = mapCause(Cause.interrupt(1));
    expect(isAbortError(mapped)).toBe(true);
    expect(mapped).toBeInstanceOf(DOMException);

    const controller = new AbortController();
    controller.abort();
    await expect(runPromise(Effect.never, { signal: controller.signal })).rejects.toSatisfy(isAbortError);
  });

  it('interrupts an in-flight effect when the host signal aborts', async () => {
    const controller = new AbortController();
    const pending = runPromise(interruptWhenAborted(Effect.never, controller.signal));
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('preserves Exit on runPromiseExit', async () => {
    const success = await runPromiseExit(Effect.succeed(7));
    expect(Exit.isSuccess(success)).toBe(true);
    if (Exit.isSuccess(success)) expect(success.value).toBe(7);

    const failure = await runPromiseExit(Effect.fail('nope'));
    expect(Exit.isFailure(failure)).toBe(true);
  });

  it('wraps non-Error fail values', () => {
    expect(toDevError('plain')).toEqual(new Error('plain'));
    expect(abortError().name).toBe('AbortError');
  });
});
