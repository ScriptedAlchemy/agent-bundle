import type { Layer } from 'effect';

import { makeScopedEffectRuntime } from './boundary.ts';
import { type CliServices, display, nodeCliServices, writeStderr, writeStdout } from './terminal.ts';

/**
 * The first-party CLI's Effect terminal runtime, behind one Promise-shaped
 * object so `src/cli.ts` can load it with a dynamic `import()` on the first
 * command write instead of at module load.
 *
 * This module is the only thing that pulls `effect`, `effect/Terminal`,
 * `effect/Stdio`, and the `@effect/platform-node-shared` layers into the CLI
 * process. Loading that graph measured ≈250 ms on rc.112 (module loading;
 * building the runtime and the layer is ≈6 ms), which is more than the rest
 * of `agent-bundle --version` put together, so `--version`, `--help`, and
 * argv errors must never reach this file. See the "Terminal and Stdio"
 * section of `docs/effect-conventions.md`.
 */
export interface CliTerminal {
  /** Finalizes the runtime's scope exactly once. */
  close(): Promise<void>;
  /** User-facing text to stdout through `Terminal.display`. */
  display(text: string): Promise<void>;
  /** A diagnostic to stderr through `Stdio.stderr()`. */
  writeStderr(text: string): Promise<void>;
  /** Machine output (canonical JSON) to stdout byte-exact through `Stdio.stdout()`. */
  writeStdout(text: string): Promise<void>;
}

/**
 * Builds the CLI terminal over `services` (default: the process-backed Node
 * `Terminal` + `Stdio` layers). One per `runCli` call: it is the CLI's
 * composition root for the terminal services.
 */
export const makeCliTerminal = (services: Layer.Layer<CliServices> = nodeCliServices): CliTerminal => {
  const runtime = makeScopedEffectRuntime(services);
  return Object.freeze({
    close: (): Promise<void> => runtime.close(),
    display: (text: string): Promise<void> => runtime.run(display(text)),
    writeStderr: (text: string): Promise<void> => runtime.run(writeStderr(text)),
    writeStdout: (text: string): Promise<void> => runtime.run(writeStdout(text)),
  });
};
