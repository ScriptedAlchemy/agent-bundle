import { describe, expect, it } from '@rstest/core';

import { runCli, type CliStreams } from '../src/index.ts';
import { helpText } from '../src/options.ts';

/**
 * The scaffolder's plain text — `--help` and a flag error — is written by the
 * argv layer's synchronous sinks before the scaffold chunk (Effect, the Node
 * platform layer, Clack) is ever loaded, so it is proven against capture
 * sinks rather than by spying on `process.stdout`. Clack renders the prompts
 * and is not under test here.
 */

const captureStreams = (): { readonly stderr: () => string; readonly stdout: () => string; readonly streams: CliStreams } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stderr: () => err.join(''),
    stdout: () => out.join(''),
    streams: {
      stderr: (text) => void err.push(text),
      stdout: (text) => void out.push(text),
    },
  };
};

describe('create-agent-bundle plain CLI text', () => {
  it('prints --help on stdout and exits 0', async () => {
    const captured = captureStreams();
    const exitCode = await runCli(['--help'], captured.streams);

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toBe(helpText);
    expect(captured.stderr()).toBe('');
  });

  it('prints a flag error and the help text on stderr and exits 2', async () => {
    const captured = captureStreams();
    const exitCode = await runCli(['one', 'two'], captured.streams);

    expect(exitCode).toBe(2);
    expect(captured.stdout()).toBe('');
    expect(captured.stderr()).toBe(`Pass at most one directory argument.\n\n${helpText}`);
  });
});
