import { Effect, FileSystem, Layer, Path, Sink, Stdio, Terminal } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { runPromise } from '../src/effect/boundary.ts';
import { cliProgram } from '../src/index.ts';
import { helpText } from '../src/options.ts';

/**
 * The scaffolder's plain text — `--help` and a flag error — goes through the
 * `Terminal` / `Stdio` services, so it is proven against a capture layer
 * rather than by spying on `process.stdout`. Clack renders the prompts and is
 * not under test here.
 */

type CliLayer = Layer.Layer<FileSystem.FileSystem | Path.Path | Stdio.Stdio | Terminal.Terminal>;

/**
 * Terminal and Stdio capture what the CLI writes; the filesystem is a noop
 * stub because neither `--help` nor a flag error may touch it (a call would
 * fail with `NotFound` and surface as a test failure).
 */
const captureLayer = (): { readonly layer: CliLayer; readonly stderr: () => string; readonly stdout: () => string } => {
  const out: string[] = [];
  const err: string[] = [];
  const decode = (chunk: string | Uint8Array): string => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    display: (text) => Effect.sync(() => void out.push(text)),
    readInput: Effect.die('key input is not used by create-agent-bundle'),
    readLine: Effect.fail(new Terminal.QuitError({})),
    rows: Effect.succeed(24),
  });
  const stdio = Stdio.layerTest({
    stderr: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void err.push(decode(chunk)))),
    stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void out.push(decode(chunk)))),
  });
  return {
    layer: Layer.mergeAll(Layer.succeed(Terminal.Terminal, terminal), stdio, FileSystem.layerNoop({}), Path.layer),
    stderr: () => err.join(''),
    stdout: () => out.join(''),
  };
};

describe('create-agent-bundle plain CLI text', () => {
  it('prints --help through Terminal.display on stdout and exits 0', async () => {
    const captured = captureLayer();
    const exitCode = await runPromise(Effect.provide(cliProgram(['--help']), captured.layer));

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toBe(helpText);
    expect(captured.stderr()).toBe('');
  });

  it('prints a flag error and the help text through Stdio.stderr and exits 2', async () => {
    const captured = captureLayer();
    const exitCode = await runPromise(Effect.provide(cliProgram(['one', 'two']), captured.layer));

    expect(exitCode).toBe(2);
    expect(captured.stdout()).toBe('');
    expect(captured.stderr()).toBe(`Pass at most one directory argument.\n\n${helpText}`);
  });
});
