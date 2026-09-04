import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, type Layer } from 'effect';
import { PlatformError } from 'effect/PlatformError';

import { runPromise, type RunPromiseOptions } from './boundary.ts';

/**
 * The Node platform layer for this package's Effect programs
 * (`FileSystem`, `Path`, and the rest of `NodeServices`).
 *
 * Provided at Promise edges only — the public API functions in `api.ts` and
 * the exported host validators are the composition roots for programmatic
 * callers — never deep inside library code. The dev server (phase 2) reuses
 * `platformLayer` through one `makeScopedEffectRuntime(platformLayer)`
 * owned by `startDevServer` and disposed from the session's `close`, and
 * `unwrapPlatformError` on the programs it runs.
 *
 * This module, not `boundary.ts`, imports `effect/PlatformError`: the
 * boundary is bundled into every emitted hook wrapper, and the error class
 * would drag `Data.TaggedError` into each of them. Emitted artifacts and
 * compiler hot paths never import this module. See
 * `docs/effect-conventions.md`, "Effect platform services".
 */
export type PlatformServices = NodeServices.NodeServices;

export const platformLayer: Layer.Layer<PlatformServices> = NodeServices.layer;

/**
 * A `PlatformError` carries the `NodeJS.ErrnoException` that `node:fs`
 * threw; a site that moved onto `FileSystem` keeps throwing that same
 * `ENOENT ...` error. Programs that own an AB#### diagnostic for a platform
 * failure map it to `DiagnosticError` themselves, before this runs.
 */
export const unwrapPlatformError = <E>(error: E): Exclude<E, PlatformError> | Error =>
  error instanceof PlatformError
    ? (error.cause instanceof Error ? error.cause : error)
    : (error as Exclude<E, PlatformError>);

/**
 * `const dir = await mkdtemp(...); try { return await use(dir) } finally
 * { await rm(dir, { recursive: true, force: true }) }` as an Effect, with
 * the same contract the two `try`/`finally` sites had before they moved
 * onto Effect:
 *
 * - `force: true` — an operation that removed (or renamed away) its own
 *   staging directory does not fail the call;
 * - the cleanup failure is a typed `PlatformError` on the error channel
 *   (unwrapped to its Node cause by `runWithPlatform`), and when both the
 *   operation and the cleanup fail the cleanup error wins, as a throwing
 *   `finally` did;
 * - cleanup runs on interruption as well, uninterruptibly.
 *
 * Not `fs.makeTempDirectoryScoped`: in rc.112 its finalizer removes without
 * `force` and `orDie`s, so a missing directory would reject an already
 * successful call, and an `EACCES` would surface as the `PlatformError`
 * wrapper (scope finalizers cannot fail typed).
 */
export const withTempDirectory = <A, E, R>(
  options: { readonly directory?: string; readonly prefix?: string } | undefined,
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError, R | FileSystem.FileSystem> =>
  Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory(options);
    const exit = yield* Effect.exit(restore(use(directory)));
    yield* fs.remove(directory, { force: true, recursive: true });
    return yield* exit;
  }));

/**
 * Run a platform-dependent Effect program at a Promise edge. Same failure
 * contract as `runPromise`, with `PlatformError` unwrapped to its Node cause.
 */
export const runWithPlatform = <A, E>(
  effect: Effect.Effect<A, E, PlatformServices>,
  options?: RunPromiseOptions,
): Promise<A> => runPromise(
  Effect.provide(effect, platformLayer).pipe(Effect.mapError(unwrapPlatformError)),
  options,
);
