import { Cause, Effect, Exit } from 'effect';
import { PlatformError } from 'effect/PlatformError';

/**
 * The sole Effect → Promise edge for `create-agent-bundle`.
 *
 * The scaffolder's filesystem work runs as Effect programs over the
 * `FileSystem` / `Path` services; `runCli` provides the Node platform layer
 * and crosses back to the bin's Promise contract here. Nothing in this module
 * is exported from the package. See `docs/effect-conventions.md`.
 *
 * Error mapping keeps the CLI's observable contract: `UsageError` (exit 2)
 * and every other `Error` (exit 1, message printed) rethrow unchanged, and a
 * `PlatformError` unwraps to the Node error it wraps, so a failed read still
 * reports `ENOENT: no such file or directory, open '...'` — the message the
 * scaffolder printed before the filesystem moved onto Effect.
 */

const abortError = (cause: unknown): DOMException => {
  const error = new DOMException('The operation was aborted', 'AbortError');
  error.cause = cause;
  return error;
};

/**
 * `FileSystem` and `Path` fail with `PlatformError` whose `cause` is the
 * original `NodeJS.ErrnoException`. The CLI's user-facing messages are
 * built from that Node error, so the wrapper is peeled off here.
 */
export const toCliError = (value: unknown): Error => {
  if (value instanceof PlatformError) {
    return value.cause instanceof Error ? value.cause : value;
  }
  if (value instanceof Error) return value;
  return new Error(String(value));
};

/** The message a failed platform operation prints: the Node error's, when there is one. */
export const describeError = (value: unknown): string => toCliError(value).message;

export const mapCause = <E>(cause: Cause.Cause<E>): Error => {
  if (Cause.hasInterruptsOnly(cause)) return abortError(cause);
  return toCliError(Cause.squash(cause));
};

/** Promise edge. Typed CLI failures rethrow as-is; platform failures unwrap to their Node cause. */
export const runPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw mapCause(exit.cause);
};
