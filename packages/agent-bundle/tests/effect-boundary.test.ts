import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import * as devApi from '../src/dev/index.ts';
import { EpochStoreError } from '../src/dev/epoch-store.ts';
import { DevLockError } from '../src/dev/dev-lock.ts';
import { ProjectEventHubError } from '../src/dev/events.ts';
import {
  abortError,
  isAbortError,
  isTypedDevError,
  mapCause,
  runPromise,
  runSync,
  toDevError,
} from '../src/effect/boundary.ts';
import { liftPromise, liftTry } from '../src/effect/lift.ts';
import * as rootApi from '../src/index.ts';

describe('effect boundary (agent-bundle dev seam)', () => {
  it('is not part of any public export', () => {
    expect('runPromise' in rootApi).toBe(false);
    expect('runSync' in rootApi).toBe(false);
    expect('runPromise' in devApi).toBe(false);
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

  it('wraps non-Error fail values', () => {
    expect(toDevError('plain')).toEqual(new Error('plain'));
    expect(abortError().name).toBe('AbortError');
  });
});

describe('effect lifts (src/effect/lift.ts)', () => {
  it('keeps the rejected or thrown value identity-preserved on the fail channel', async () => {
    const typed = new EpochStoreError('EPOCH_NOT_FOUND', 'Epoch "e1" does not exist.');
    const reason = { code: 'ECUSTOM', message: 'not an Error' };
    const rejected = await runPromise(Effect.exit(liftPromise(() => Promise.reject(typed))));
    expect(Exit.isFailure(rejected) && Cause.squash(rejected.cause)).toBe(typed);
    const rawReason = await runPromise(Effect.exit(liftPromise(() => Promise.reject(reason))));
    expect(Exit.isFailure(rawReason) && Cause.squash(rawReason.cause)).toBe(reason);
    const thrown = await runPromise(Effect.exit(liftTry((): never => { throw typed; })));
    expect(Exit.isFailure(thrown) && Cause.squash(thrown.cause)).toBe(typed);
    expect(runSync(liftTry(() => 7))).toBe(7);
    // The Promise edge rethrows typed errors as-is and wraps non-Error values,
    // exactly per the boundary's mapping table — the lift itself never
    // normalizes, so a caller that must re-raise a raw reason reads the Exit.
    await expect(runPromise(liftPromise(() => Promise.reject(typed)))).rejects.toBe(typed);
    await expect(runPromise(liftPromise(() => Promise.reject(reason)))).rejects.toEqual(new Error(String(reason)));
  });

  it('hands the lifted helper an AbortSignal that aborts when the fiber is interrupted', async () => {
    const host = new AbortController();
    let observed: AbortSignal | undefined;
    const pending = runPromise(
      liftPromise((signal) => {
        observed = signal;
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
      { signal: host.signal },
    );
    await Promise.resolve();
    expect(observed?.aborted).toBe(false);
    host.abort();
    await expect(pending).rejects.toSatisfy(isAbortError);
    expect(observed?.aborted).toBe(true);
  });
});
