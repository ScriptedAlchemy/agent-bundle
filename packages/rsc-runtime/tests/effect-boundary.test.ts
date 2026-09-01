import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { AgentContractError } from '../src/agent-document.js';
import { AgentRequestError } from '../src/agent-request.js';
import {
  abortError,
  interruptWhenAborted,
  isAbortError,
  isTypedRuntimeError,
  mapCause,
  runPromise,
  runPromiseExit,
  runSync,
  toRuntimeError,
} from '../src/effect/boundary.js';
import * as runtime from '../src/index.js';

describe('effect boundary', () => {
  it('is not part of the public runtime export', () => {
    expect('runPromise' in runtime).toBe(false);
    expect('runSync' in runtime).toBe(false);
    expect('interruptWhenAborted' in runtime).toBe(false);
  });

  it('resolves a successful effect', async () => {
    await expect(runPromise(Effect.succeed(41))).resolves.toBe(41);
    expect(runSync(Effect.succeed('ok'))).toBe('ok');
  });

  it('rethrows AgentRequestError and AgentContractError from the fail channel', async () => {
    const request = new AgentRequestError('outside-invocation', 'agent() used outside a real invocation');
    const contract = new AgentContractError('invalid-document', 'document is not an Agent Document');
    await expect(runPromise(Effect.fail(request))).rejects.toBe(request);
    await expect(runPromise(Effect.fail(contract))).rejects.toBe(contract);
  });

  it('rethrows AgentStateError by name without importing the state kernel', async () => {
    const stateError = new Error('store closed');
    stateError.name = 'AgentStateError';
    expect(isTypedRuntimeError(stateError)).toBe(true);
    await expect(runPromise(Effect.fail(stateError))).rejects.toBe(stateError);
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
    expect(toRuntimeError('plain')).toEqual(new Error('plain'));
    expect(abortError().name).toBe('AbortError');
  });
});
