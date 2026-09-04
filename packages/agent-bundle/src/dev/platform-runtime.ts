import { Effect } from 'effect';

import { makeScopedEffectRuntime, type ScopedEffectRuntime } from '../effect/boundary.ts';
import { platformLayer, unwrapPlatformError, type PlatformRun, type PlatformServices } from '../effect/platform.ts';

/**
 * The dev server's platform runtime: one `makeScopedEffectRuntime(platformLayer)`
 * per `startDevServer` call, whose `run` is the `PlatformRun` every dev service
 * takes as `runPlatform`, and whose `close` releases the runtime's Scope after
 * the last service has closed. Created inside `startDevServer`, never at
 * module top level: `effect` is a CLI cold-start cost (#530). Lives here, not
 * in `src/effect/platform.ts`, so the emitted installer that bundles that
 * module stays byte-identical.
 */
export interface DevPlatformRuntime {
  close(): Promise<void>;
  readonly run: PlatformRun;
}

export const createDevPlatformRuntime = (): DevPlatformRuntime => {
  const runtime: ScopedEffectRuntime<PlatformServices> = makeScopedEffectRuntime(platformLayer);
  const run: PlatformRun = (effect, options) => runtime.run(Effect.mapError(effect, unwrapPlatformError), options);
  return Object.freeze({ close: () => runtime.close(), run });
};
