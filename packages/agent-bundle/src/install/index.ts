import { Command, CommanderError } from 'commander';

import { diagnosticsFor } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import { registerLifecycleCommands } from './commands.ts';
import { runDoctor } from './doctor.ts';
import { installBundle } from './install.ts';
import { uninstallBundle } from './uninstall.ts';

export { runDoctor } from './doctor.ts';
export type * from './doctor.ts';
export { formatDoctorReport, formatInstallResult, formatUninstallResult } from './format.ts';
export { installBundle } from './install.ts';
export type * from './install.ts';
export { uninstallBundle } from './uninstall.ts';
export type * from './uninstall.ts';

/**
 * A package-bound lifecycle CLI (#724): the `agent-bundle` CLI's own
 * `install`, `uninstall`, and `doctor` commands with the bundle root pinned
 * to the package that ships the bin, so a published plugin can offer
 * `<name> install <host>` without bundling the framework's installer source
 * or parsing argv itself.
 */
export interface InstallCliOptions {
  /** The bundle root the bin binds: the package root of an npm-root layout (`new URL('..', import.meta.url)` from `bin/`). */
  readonly from: string;
  /** The bin name shown in `--help`; defaults to `install`. */
  readonly name?: string;
  readonly stderr?: (text: string) => void;
  readonly stdout?: (text: string) => void;
  /** The version `--version` prints; omitted when absent. */
  readonly version?: string;
}

const lifecycle = async () => ({ installBundle, runDoctor, uninstallBundle });

/**
 * Runs `install <host>`, `uninstall <host>`, or `doctor` against the pinned
 * bundle root and returns the process exit code, exactly like the
 * `agent-bundle` CLI: 0 on success; 1 when the command threw (its
 * diagnostics as one JSON line on stderr) or when `doctor`'s report, written
 * to stdout, carries an error diagnostic; 2 on a usage error.
 */
export const runInstallCli = async (argv: readonly string[], options: InstallCliOptions): Promise<number> => {
  const stdout = options.stdout ?? ((text: string): void => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string): void => void process.stderr.write(text));
  let exitCode = 0;
  const program = new Command()
    .name(options.name ?? 'install')
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({ writeErr: stderr, writeOut: stdout });
  if (options.version !== undefined) program.version(options.version);
  registerLifecycleCommands(program, {
    from: options.from,
    lifecycle,
    machine: async (result) => stdout(`${stableJson(result ?? null)}\n`),
    setExitCode: (code) => { exitCode = code; },
    show: async (text) => stdout(text),
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    stderr(`${stableJson(diagnosticsFor(error))}\n`);
    return 1;
  }
};
