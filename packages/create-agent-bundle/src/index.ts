import { UsageError, helpText, parseFlags, type ParsedFlags } from './options.ts';

/**
 * The argv layer of `create-agent-bundle`: parse the flags, answer `--help`
 * and flag errors with plain synchronous writes, and only then load the
 * scaffold (`./scaffold-cli.ts`: Effect, the Node platform layer, Clack)
 * through a dynamic `import()`. The bundled scaffold chunk measured ≈40 ms
 * of startup on rc.112, so the two trivial invocations never evaluate it.
 * See the "Terminal and Stdio" section of `docs/effect-conventions.md`.
 */

/** Synchronous text sinks for the argv layer's text: `--help` and flag errors. */
export interface CliStreams {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

const processStreams: CliStreams = Object.freeze({
  stderr: (text: string): void => void process.stderr.write(text),
  stdout: (text: string): void => void process.stdout.write(text),
});

/**
 * Runs the CLI. `--help` goes to `streams.stdout` and exits 0; a flag error
 * (`UsageError`) writes its message and the help text to `streams.stderr` and
 * exits 2; a non-usage `parseFlags` failure is a bug and keeps throwing.
 * Anything else scaffolds. Tests pass capture streams instead of spying on
 * `process.stdout`.
 */
export const runCli = async (argv: readonly string[], streams: CliStreams = processStreams): Promise<0 | 1 | 2> => {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      streams.stderr(`${error.message}\n\n${helpText}`);
      return 2;
    }
    throw error;
  }
  if (flags.help) {
    streams.stdout(helpText);
    return 0;
  }
  const { runScaffold } = await import('./scaffold-cli.ts');
  return runScaffold(flags);
};
