import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Latch,
  Stream,
  type Layer,
  ManagedRuntime,
  type Scope,
} from 'effect';

import { AgentContractError } from '../agent-document.js';
import { AgentRequestError } from '../agent-request.js';

/**
 * The sole Effect → Promise / sync edge for `@agent-bundle/runtime`.
 *
 * Internals write Effect programs. This module is the only place that may
 * call `Effect.runPromise` / `Effect.runSync` (and siblings). Public
 * authoring stays Promise + zod: nothing here is re-exported from the
 * package root. See `docs/effect-conventions.md`.
 */

export interface RunPromiseOptions {
  readonly signal?: AbortSignal;
}

const TYPED_ERROR_NAMES = new Set([
  'AgentContractError',
  'AgentRequestError',
  'AgentRuntimeError',
  'AgentStateError',
  'McpProjectionError',
]);

const interruptAs = <A, E, R>(): Effect.Effect<A, E, R> =>
  Effect.interrupt as Effect.Effect<A, E, R>;

export const abortError = (cause?: unknown): DOMException => {
  const error = new DOMException('The operation was aborted', 'AbortError');
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
};

export const isAbortError = (error: unknown): error is DOMException =>
  (error instanceof DOMException && error.name === 'AbortError')
  || (error instanceof Error && error.name === 'AbortError');

/**
 * True for the runtime's existing typed Error classes. `AgentStateError` is
 * matched by name so this module never imports `./state/contract` — the
 * kernel must stay off the package-root graph (#98).
 */
export const isTypedRuntimeError = (error: unknown): error is Error =>
  error instanceof AgentRequestError
  || error instanceof AgentContractError
  || (error instanceof Error && TYPED_ERROR_NAMES.has(error.name));

export const toRuntimeError = (value: unknown): Error => {
  if (isAbortError(value) || isTypedRuntimeError(value)) return value;
  if (value instanceof Error) return value;
  return new Error(String(value));
};

export const mapCause = <E>(cause: Cause.Cause<E>): Error => {
  if (Cause.hasInterruptsOnly(cause)) return abortError(cause);
  return toRuntimeError(Cause.squash(cause));
};

const throwExitFailure = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw mapCause(exit.cause);
};

const runOptions = (options: RunPromiseOptions | undefined): Effect.RunOptions | undefined =>
  options?.signal === undefined ? undefined : { signal: options.signal };

/**
 * Promise edge. Interruption (including `options.signal`) becomes
 * `DOMException` `AbortError`. Typed `Agent*` failures rethrow as-is.
 */
export const runPromise = async <A, E>(
  effect: Effect.Effect<A, E>,
  options?: RunPromiseOptions,
): Promise<A> => throwExitFailure(await Effect.runPromiseExit(effect, runOptions(options)));

/** Promise edge that preserves the Effect `Exit` for callers that branch on cause. */
export const runPromiseExit = async <A, E>(
  effect: Effect.Effect<A, E>,
  options?: RunPromiseOptions,
): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect, runOptions(options));

/**
 * Sync edge for effects that cannot suspend. Do not use for I/O, streams,
 * or anything that waits on a fiber.
 */
export const runSync = <A, E>(effect: Effect.Effect<A, E>): A =>
  throwExitFailure(Effect.runSyncExit(effect));

/**
 * Internal long-lived Effect runtime. Its Layer owns one Scope, which stays
 * live across Promise API calls and is finalized exactly once by close().
 */
export interface ScopedEffectRuntime<R> {
  close(): Promise<void>;
  run<A, E2>(effect: Effect.Effect<A, E2, R>, options?: RunPromiseOptions): Promise<A>;
}

export const makeScopedEffectRuntime = <R, E>(
  layer: Layer.Layer<R, E>,
): ScopedEffectRuntime<R> => {
  const runtime = ManagedRuntime.make(layer);
  let closing: Promise<void> | undefined;
  return Object.freeze({
    close(): Promise<void> {
      closing ??= runtime.dispose();
      return closing;
    },
    async run<A, E2>(
      effect: Effect.Effect<A, E2, R>,
      options?: RunPromiseOptions,
    ): Promise<A> {
      return throwExitFailure(await runtime.runPromiseExit(effect, runOptions(options)));
    },
  });
};

/**
 * Host AbortSignal → Effect interruption. Re-checks `signal.aborted` when
 * the effect starts (not only when this helper is constructed) so a signal
 * that aborts between construction and run still interrupts. The listener
 * is registered first; aborted signals do not replay `abort`, so the
 * callback rechecks immediately after `addEventListener`.
 */
export const abortToInterrupt = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.suspend(() => {
    if (signal.aborted) return interruptAs();
    return Effect.callback<never>((resume) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        resume(Effect.interrupt);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      return Effect.sync(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  });

/**
 * AbortSignal → Effect interruption, for programs that still run inside
 * Effect and receive a host signal. The Promise edge also accepts `signal`
 * directly via {@link runPromise}.
 */
export const interruptWhenAborted = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal,
): Effect.Effect<A, E, R> => Effect.raceFirst(effect, abortToInterrupt(signal));

export interface StreamToReadableOptions<A> {
  readonly closeOn?: (value: A) => boolean;
  readonly onPull?: () => void;
  readonly onPullDelivered?: () => void;
  readonly signal?: AbortSignal;
  readonly strategy?: QueuingStrategy<A>;
}

/**
 * Stream → web ReadableStream. Owns the `runFork` / cancel `runPromise` pair
 * that Effect's `Stream.toReadableStream` would otherwise call. Failures map
 * through {@link mapCause} so interrupt-only causes stay `AbortError`
 * (Effect's helper uses `Cause.squash`, which is the wrong public contract).
 */
export const streamToReadableStream = <A, E>(
  stream: Stream.Stream<A, E>,
  options: StreamToReadableOptions<A> = {},
): ReadableStream<A> => {
  let currentPull: { readonly resolve: () => void; readonly reject: (error: Error) => void } | undefined;
  let fiber: Fiber.Fiber<void, E> | undefined;
  let terminal: { readonly error?: Error } | undefined;
  const latch = Latch.makeUnsafe(false);
  const source = options.signal === undefined
    ? stream
    : Stream.interruptWhen(stream, abortToInterrupt(options.signal));
  const settlePull = (error?: Error): void => {
    const waiter = currentPull;
    currentPull = undefined;
    if (waiter === undefined) return;
    if (error === undefined) waiter.resolve();
    else waiter.reject(error);
  };
  const finish = (error?: Error): void => {
    if (terminal !== undefined) return;
    terminal = { error };
    settlePull(error);
  };

  const failController = (controller: ReadableStreamDefaultController<A>, error: Error): void => {
    try {
      controller.error(error);
    } catch {
      // Already closed or errored — pull() still rejects via `terminal`.
    }
    finish(error);
  };

  return new ReadableStream<A>({
    cancel() {
      const running = fiber;
      fiber = undefined;
      if (running === undefined) return;
      // Fork, never `runPromise`: cancel may run inside Effect teardown
      // (or a consumer's cancel path), and blocking a finalizer on the
      // producer fiber's exit risks deadlock and hides contract / abort
      // errors. Interrupt in the background and return immediately.
      void Effect.runFork(Effect.asVoid(Fiber.interrupt(running)));
    },
    pull() {
      if (terminal !== undefined) {
        return terminal.error === undefined ? Promise.resolve() : Promise.reject(terminal.error);
      }
      options.onPull?.();
      return new Promise<void>((resolve, reject) => {
        currentPull = { reject, resolve };
        latch.openUnsafe();
      });
    },
    start(controller) {
      const watched = Stream.tapError(source, (error) =>
        Effect.sync(() => {
          failController(controller, toRuntimeError(error));
        }),
      );
      fiber = Effect.runFork(Stream.runForEachArray(watched, (chunk) =>
        latch.whenOpen(Effect.sync(() => {
          if (terminal !== undefined) return;
          latch.closeUnsafe();
          for (const item of chunk) {
            controller.enqueue(item);
            if (options.closeOn?.(item) === true) {
              controller.close();
              options.onPullDelivered?.();
              finish();
              if (fiber !== undefined) {
                void Effect.runFork(Fiber.interrupt(fiber));
              }
              return;
            }
          }
          options.onPullDelivered?.();
          settlePull();
        })),
      ));
      fiber.addObserver((exit) => {
        if (terminal !== undefined) return;
        if (Exit.isFailure(exit)) {
          failController(controller, mapCause(exit.cause));
          return;
        }
        try {
          controller.close();
        } catch {
          // Already closed by closeOn.
        }
        finish();
      });
    },
  }, options.strategy);
};

/**
 * Effect interruption → AbortSignal, for Promise/fetch APIs that take a
 * signal. Requires `Scope`; close the scope to abort.
 */
export const scopedAbortSignal: Effect.Effect<AbortSignal, never, Scope.Scope> = Effect.abortSignal;
