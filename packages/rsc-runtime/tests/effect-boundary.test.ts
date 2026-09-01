import { Cause, Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { AgentContractError } from '../src/agent-document.js';
import { AgentRequestError } from '../src/agent-request.js';

import {
  abortError,
  abortToInterrupt,
  interruptWhenAborted,
  isAbortError,
  isTypedRuntimeError,
  mapCause,
  runPromise,
  runPromiseExit,
  runSync,
  streamToReadableStream,
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

  it('rethrows AgentRuntimeError and McpProjectionError by name', async () => {
    const runtime = new Error('runtime unavailable');
    runtime.name = 'AgentRuntimeError';
    const projection = new Error('unsupported image');
    projection.name = 'McpProjectionError';
    expect(isTypedRuntimeError(runtime)).toBe(true);
    expect(isTypedRuntimeError(projection)).toBe(true);
    await expect(runPromise(Effect.fail(runtime))).rejects.toBe(runtime);
    await expect(runPromise(Effect.fail(projection))).rejects.toBe(projection);
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

  it('interrupts when the host signal aborts between construction and run', async () => {
    const controller = new AbortController();
    const program = interruptWhenAborted(Effect.never, controller.signal);
    controller.abort();
    const pending = runPromise(program);
    const hung = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('interruptWhenAborted hung after abort-before-start')), 250);
    });
    await expect(Promise.race([pending, hung])).rejects.toSatisfy(isAbortError);
    await expect(runPromise(abortToInterrupt(controller.signal))).rejects.toSatisfy(isAbortError);
  });

  it('fails the readable when the stream fails', async () => {
    const readable = streamToReadableStream(Stream.fail(new AgentContractError('event-count-exceeded', 'too many')));
    const reader = readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'event-count-exceeded' });
  });

  it('fails the readable after a successful event when the stream fails', async () => {
    const readable = streamToReadableStream(
      Stream.make({ type: 'shell' as const }).pipe(
        Stream.concat(Stream.fail(new AgentContractError('event-count-exceeded', 'too many'))),
      ),
      { strategy: { highWaterMark: 0 } },
    );
    const reader = readable.getReader();
    const first = await reader.read();
    expect(first.value).toEqual({ type: 'shell' });
    await expect(reader.read()).rejects.toMatchObject({ code: 'event-count-exceeded' });
  });

  it('maps stream interruption to AbortError without a complete event', async () => {
    const controller = new AbortController();
    const readable = streamToReadableStream(Stream.never, { signal: controller.signal });
    const reader = readable.getReader();
    const pending = reader.read();
    controller.abort();
    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('rejects a later read after the producer has already failed', async () => {
    const stream = Stream.succeed('shell').pipe(
      Stream.concat(Stream.fromEffect(Effect.sleep('20 millis').pipe(
        Effect.andThen(Effect.fail(new AgentContractError('event-count-exceeded', 'too many'))),
      ))),
    );
    const readable = streamToReadableStream(stream, { strategy: { highWaterMark: 0 } });
    const reader = readable.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBe('shell');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await expect(reader.read()).rejects.toMatchObject({
      name: 'AgentContractError',
      code: 'event-count-exceeded',
    });
  });

});
