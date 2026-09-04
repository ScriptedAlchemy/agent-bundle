import { Effect, type Layer } from 'effect';

import { makeScopedEffectRuntime } from '../effect/boundary.ts';
import {
  platformLayer,
  runWithPlatform,
  unwrapPlatformError,
  type PlatformRun,
  type PlatformServices,
} from '../effect/platform.ts';
import type { DevPlatformRuntime } from './platform-runtime.ts';

/**
 * The Effect-typed side of `DevPlatformRuntime`: `createDevPlatformRuntime`
 * builds one `makeScopedEffectRuntime(platformLayer)` and hands back the
 * Effect-free handle; `platformRunOf` resolves the handle to its `PlatformRun`
 * edge (`PlatformError` unwrapped to its Node cause, like `runWithPlatform`).
 * The edge is kept off the handle's type on purpose — see
 * `./platform-runtime.ts`. Imported by services for their implementation only,
 * so it never reaches an emitted `.d.ts`. Lives under `dev/`, not in
 * `src/effect/platform.ts`, so the emitted installer that bundles that module
 * stays byte-identical.
 */
const edges = new WeakMap<DevPlatformRuntime, PlatformRun>();

export const createDevPlatformRuntime = (
  layer: Layer.Layer<PlatformServices> = platformLayer,
): DevPlatformRuntime => {
  const runtime = makeScopedEffectRuntime(layer);
  const run: PlatformRun = (effect, options) => runtime.run(Effect.mapError(effect, unwrapPlatformError), options);
  const handle: DevPlatformRuntime = Object.freeze({ close: () => runtime.close() });
  edges.set(handle, run);
  return handle;
};

/**
 * The edge a service runs its platform programs through: the session
 * runtime's when one was given, otherwise `runWithPlatform` (one layer per
 * call), so every service stays constructible on its own.
 */
export const platformRunOf = (runtime: DevPlatformRuntime | undefined): PlatformRun => {
  if (runtime === undefined) return runWithPlatform;
  const run = edges.get(runtime);
  if (run === undefined) throw new TypeError('platformRuntime must come from createDevPlatformRuntime.');
  return run;
};
