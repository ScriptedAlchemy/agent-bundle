import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, type Layer, type Scope } from 'effect';
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
 * A temporary directory that lives exactly as long as the enclosing scope,
 * with the `rm(dir, { recursive: true, force: true })` finalizer the
 * `try`/`finally` sites had before they moved onto Effect. rc.112's own
 * `makeTempDirectoryScoped` finalizes without `force`, so an operation that
 * removes (or renames away) its own staging directory would die with ENOENT
 * at scope close and reject a call that had already succeeded. A finalizer
 * failure other than "already gone" is still a defect, as the `finally`
 * throw was.
 */
export const scopedTempDirectory = (
  options?: { readonly directory?: string; readonly prefix?: string },
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.acquireRelease(
      fs.makeTempDirectory(options),
      (directory) => Effect.orDie(fs.remove(directory, { force: true, recursive: true })),
    );
  });

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
