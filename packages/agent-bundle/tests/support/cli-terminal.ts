import { Effect, Layer, Sink, Stdio, Terminal } from 'effect';

import type { CliOutput } from '../../src/cli.ts';

export interface CapturedCliTerminal {
  /** Pass as the `runCli` output argument: a capture `Terminal` + `Stdio` layer instead of the process streams. */
  readonly output: CliOutput;
  /** Everything written to stderr through `Stdio`. */
  readonly stderr: () => string;
  /** Everything written to stdout: `Terminal.display` text and `Stdio` machine output, in order. */
  readonly stdout: () => string;
}

const chunkText = (chunk: string | Uint8Array): string =>
  typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);

/**
 * The test seam for the first-party CLI's terminal I/O: a `Terminal` whose
 * `display` appends to a buffer, and a `Stdio` whose stdout/stderr sinks
 * append to the same buffers, so tests never spy on `process.stdout`.
 * `readLine` replays `lines` and then quits, like a closed stdin.
 */
export const captureCliTerminal = (lines: readonly string[] = []): CapturedCliTerminal => {
  const out: string[] = [];
  const err: string[] = [];
  const scripted = [...lines];
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    display: (text) => Effect.sync(() => void out.push(text)),
    readInput: Effect.die('key input is not used by the agent-bundle CLI'),
    readLine: Effect.suspend(() =>
      scripted.length > 0 ? Effect.succeed(scripted.shift()!) : Effect.fail(new Terminal.QuitError({}))),
    rows: Effect.succeed(24),
  });
  const stdio = Stdio.layerTest({
    stderr: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void err.push(chunkText(chunk)))),
    stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void out.push(chunkText(chunk)))),
  });
  return Object.freeze({
    output: { services: Layer.merge(Layer.succeed(Terminal.Terminal, terminal), stdio) },
    stderr: () => err.join(''),
    stdout: () => out.join(''),
  });
};
