import {
  Cause,
  Effect,
  Exit,
  type Layer,
  ManagedRuntime,
  type Scope,
} from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { CodedError } from '../core/errors.ts';

/**
 * The sole Effect → Promise / sync edge for the `agent-bundle` package
 * (the dev seam, Wave 3.5 stage 3).
 *
 * Internals write Effect programs. This module is the only place in this
 * package that may call `Effect.runPromise` / `Effect.runSync` (and
 * siblings). Public authoring stays Promise + zod: nothing here is
 * re-exported from any package entry. See `docs/effect-conventions.md`.
 *
 * Error mapping mirrors `packages/rsc-runtime/src/effect/boundary.ts`: the
 * dev seam's typed contracts (`CodedError` subclasses such as
 * `EpochStoreError`, `DevLockError`, `ProjectEventHubError`, and the AB
 * diagnostic carrier `DiagnosticError`) ride the fail channel as ordinary
 * `Error` instances and rethrow unchanged, so callers of `runPromise` see
 * exactly the same types they see today.
 */

export interface RunPromiseOptions {
  readonly signal?: AbortSignal;
}

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
 * True for the dev seam's typed Error contracts: `CodedError` subclasses
 * (`DevLockError`, `ProjectEventHubError`, ...), any coded-shape error that
 * predates `CodedError` (`EpochStoreError` carries a bare `code` string),
 * and the AB diagnostic carrier `DiagnosticError`. Plain `Error` values also
 * rethrow as-is; this predicate only exists so intent is greppable at the
 * boundary.
 */
export const isTypedDevError = (error: unknown): error is Error =>
  error instanceof CodedError
  || error instanceof DiagnosticError
  || (error instanceof Error && typeof (error as { readonly code?: unknown }).code === 'string');

export const toDevError = (value: unknown): Error => {
  if (isAbortError(value) || isTypedDevError(value)) return value;
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : String(value));
};

export const mapCause = <E>(cause: Cause.Cause<E>): Error => {
  if (Cause.hasInterruptsOnly(cause)) return abortError(cause);
  return toDevError(Cause.squash(cause));
};

const throwExitFailure = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw mapCause(exit.cause);
};

const runOptions = (options: RunPromiseOptions | undefined): Effect.RunOptions | undefined =>
  options?.signal === undefined ? undefined : { signal: options.signal };

/**
 * Promise edge. Interruption (including `options.signal`) becomes
 * `DOMException` `AbortError`. Typed dev-seam failures rethrow as-is.
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

export const runSyncExit = <A, E>(effect: Effect.Effect<A, E>): Exit.Exit<A, E> =>
  Effect.runSyncExit(effect);

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

/**
 * Effect interruption → AbortSignal, for Promise/fetch APIs that take a
 * signal. Requires `Scope`; close the scope to abort. This is the stage-2
 * lesson's bridge: interrupt a source through its signal instead of calling
 * `cancel()` on a web stream a consumer may have locked.
 */
export const scopedAbortSignal: Effect.Effect<AbortSignal, never, Scope.Scope> = Effect.abortSignal;
