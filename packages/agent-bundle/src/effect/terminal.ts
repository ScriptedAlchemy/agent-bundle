import * as NodeStdio from '@effect/platform-node-shared/NodeStdio';
import * as NodeTerminal from '@effect/platform-node-shared/NodeTerminal';
import { Effect, Layer, type PlatformError, Stdio, Stream, Terminal } from 'effect';

/**
 * The first-party CLI's terminal seam. User-facing text reaches stdout only
 * through Effect's `Terminal` service (`terminal.display`); diagnostics reach
 * stderr and machine output (canonical JSON) reaches stdout byte-exact through
 * the `Stdio` service. Nothing in this package outside the generated-artifact
 * shells writes to `process.stdout` / `process.stderr` for user-facing text.
 *
 * The Node layers are provided exactly once, at the CLI composition root
 * (`makeCliTerminal` in `./cli-runtime.ts`, which `src/cli.ts` loads lazily on
 * the first command write so `--version` / `--help` never load Effect); tests
 * provide a capture layer instead. Commander's own help, version, and argv
 * error text is the one user-facing text that does not come through here: it
 * is written synchronously before any command runs. Emitted artifacts (routed
 * CLI bins, hook wrappers, installers, MCP entries) never import this module:
 * they stay self-contained and keep their raw stream adapters. See
 * `docs/effect-conventions.md`.
 */

/** The services a CLI output program needs. */
export type CliServices = Stdio.Stdio | Terminal.Terminal;

/**
 * Node-backed `Terminal` + `Stdio`. Composed from the two narrow layers, not
 * `NodeServices.layer`: the aggregate barrel also loads the child-process,
 * crypto, and filesystem services plus `undici`, which the CLI never uses and
 * which would quadruple its startup cost.
 */
export const nodeCliServices: Layer.Layer<CliServices> = Layer.mergeAll(NodeTerminal.layer, NodeStdio.layer);

/** Writes user-facing text to stdout through the `Terminal` service. */
export const display = Effect.fnUntraced(function* (text: string): Effect.fn.Return<void, PlatformError.PlatformError, Terminal.Terminal> {
  const terminal = yield* Terminal.Terminal;
  yield* terminal.display(text);
});

/** Writes machine output (canonical JSON, NDJSON) to stdout byte-exact through the `Stdio` service. */
export const writeStdout = Effect.fnUntraced(function* (text: string): Effect.fn.Return<void, PlatformError.PlatformError, Stdio.Stdio> {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.run(Stream.make(text), stdio.stdout());
});

/** Writes a diagnostic to stderr through the `Stdio` service. */
export const writeStderr = Effect.fnUntraced(function* (text: string): Effect.fn.Return<void, PlatformError.PlatformError, Stdio.Stdio> {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.run(Stream.make(text), stdio.stderr());
});
