import { Command, InvalidArgumentError } from 'commander';

import type { DoctorHost, runDoctor } from './doctor.ts';
import { formatDoctorReport, formatInstallResult, formatUninstallResult } from './format.ts';
import type { DevInstallHost, installBundle, InstallHost, InstallMode, InstallScope } from './install.ts';
import type { uninstallBundle } from './uninstall.ts';

/**
 * The `install`, `uninstall`, and `doctor` commands, declared once for the
 * `agent-bundle` CLI and for package-bound installer bins
 * (`agent-bundle/install`). The two differ only in where the bundle root
 * comes from: the CLI takes `--from`, a bin pins its own package root.
 */
export interface LifecycleApi {
  readonly installBundle: typeof installBundle;
  readonly runDoctor: typeof runDoctor;
  readonly uninstallBundle: typeof uninstallBundle;
}

export interface LifecycleCommandOptions {
  /** Pins the bundle root and hides `--from`: a package-bound bin binds the root its own package ships. */
  readonly from?: string;
  /** Loads the lifecycle implementation when a command runs, so parsing `--help` never pays for it. */
  readonly lifecycle: () => Promise<LifecycleApi>;
  /** Writes one canonical JSON document (`--json`). */
  readonly machine: (result: unknown) => Promise<void>;
  /** Receives the exit code a command decides after writing its output. */
  readonly setExitCode: (code: number) => void;
  /** Writes human-readable text. */
  readonly show: (text: string) => Promise<void>;
}

interface InstallCommandOptions {
  readonly force?: boolean;
  readonly from?: string;
  readonly json?: boolean;
  readonly replace?: boolean;
  readonly mode?: InstallMode;
  readonly scope: string;
}

interface UninstallCommandOptions {
  readonly confirmPurge?: boolean;
  readonly force?: boolean;
  readonly from?: string;
  readonly json?: boolean;
  readonly keepData?: boolean;
  readonly mode?: InstallMode;
  readonly plan?: boolean;
  readonly purgeData?: boolean;
  readonly scope: string;
}

interface DoctorCommandOptions {
  readonly from?: string;
  readonly host: readonly DoctorHost[];
  readonly json?: boolean;
}

export const installHost = (value: string): InstallHost => {
  if (value === 'amp' || value === 'claude' || value === 'codex' || value === 'cursor') return value;
  throw new InvalidArgumentError('Install host must be amp, claude, codex, or cursor.');
};

const devInstallHost = (value: string): DevInstallHost => {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value;
  throw new InvalidArgumentError('Development install host must be claude, codex, or cursor.');
};

export const collectInstallHost = (value: string, previous: readonly DevInstallHost[]): readonly DevInstallHost[] =>
  [...previous, devInstallHost(value)];

const installMode = (value: string): InstallMode => {
  if (value === 'local' || value === 'marketplace') return value;
  throw new InvalidArgumentError('Install mode must be local or marketplace.');
};

const installScope = (value: string): InstallScope => {
  if (value === 'user' || value === 'project' || value === 'local') return value;
  throw new InvalidArgumentError('Install scope must be user, project, or local.');
};

const doctorHost = (value: string): DoctorHost => {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value;
  throw new InvalidArgumentError('Doctor host must be claude, codex, or cursor.');
};

const collectDoctorHost = (value: string, previous: readonly DoctorHost[]): readonly DoctorHost[] =>
  [...previous, doctorHost(value)];

export const registerLifecycleCommands = (program: Command, options: LifecycleCommandOptions): void => {
  const { from: pinned, lifecycle, machine, setExitCode, show } = options;
  // `process.cwd()` is read only when the option exists: a pinned bin must work from a deleted cwd.
  const fromOption = (command: Command, help: string, defaultToCwd = false): Command =>
    pinned === undefined ? command.option('--from <bundle-dir>', help, defaultToCwd ? process.cwd() : undefined) : command;

  const installCommand = fromOption(
    program.command('install')
      .description('Install a built bundle into a supported host')
      .argument('<host>', 'Destination host: amp, claude, codex, or cursor', installHost),
    'Target bundle directory or artifact root',
    true,
  )
    .option('--scope <scope>', 'Host install scope', installScope, 'user')
    .option(
      '--replace',
      'Replace an existing agent-bundle install of this plugin even when its version differs; ' +
        'same-version content drift is replaced automatically and foreign installs are always refused',
    )
    .option('--force', 'Alias for --replace')
    .option('--mode <mode>', 'Cursor delivery mode: local (default) or marketplace', installMode)
    .option('--json', 'Write one machine-readable JSON document');
  installCommand.action(async (host: InstallHost, commandOptions: InstallCommandOptions) => {
    const { installBundle: install } = await lifecycle();
    const result = await install({
      from: pinned ?? commandOptions.from ?? process.cwd(),
      host,
      replace: commandOptions.replace === true || commandOptions.force === true,
      ...(commandOptions.mode === undefined ? {} : { mode: commandOptions.mode }),
      scope: installScope(commandOptions.scope),
    });
    await (commandOptions.json === true ? machine(result) : show(formatInstallResult(result)));
  });

  const uninstallCommand = fromOption(
    program.command('uninstall')
      .description('Remove a receipt-owned host install of a built bundle, and nothing else')
      .argument('<host>', 'Host to uninstall from: amp, claude, codex, or cursor', installHost),
    'Target bundle directory or artifact root that identifies the plugin',
    true,
  )
    .option('--scope <scope>', 'Host install scope', installScope, 'user')
    .option('--mode <mode>', 'Cursor delivery mode to uninstall: local (default) or marketplace', installMode)
    .option('--keep-data', 'Keep the plugin\'s durable runtime state (state/) in place; this is the default')
    .option('--purge-data', 'Also remove the plugin\'s durable runtime state; requires --confirm-purge')
    .option('--confirm-purge', 'Confirm that --purge-data may delete durable state')
    .option(
      '--force',
      'Proceed without an install receipt (legacy or host-only install) or when owned content no longer matches the receipt; ' +
        'foreign directories are still refused',
    )
    .option('--plan', 'Print the exact paths and host registrations that would be removed without changing anything')
    .option('--json', 'Write one machine-readable JSON document');
  uninstallCommand.action(async (host: InstallHost, commandOptions: UninstallCommandOptions) => {
    const { uninstallBundle: uninstall } = await lifecycle();
    const result = await uninstall({
      ...(commandOptions.confirmPurge === undefined ? {} : { confirmPurge: commandOptions.confirmPurge }),
      ...(commandOptions.force === undefined ? {} : { force: commandOptions.force }),
      from: pinned ?? commandOptions.from ?? process.cwd(),
      host,
      ...(commandOptions.keepData === undefined ? {} : { keepData: commandOptions.keepData }),
      ...(commandOptions.mode === undefined ? {} : { mode: commandOptions.mode }),
      ...(commandOptions.plan === undefined ? {} : { plan: commandOptions.plan }),
      ...(commandOptions.purgeData === undefined ? {} : { purgeData: commandOptions.purgeData }),
      scope: installScope(commandOptions.scope),
    });
    await (commandOptions.json === true ? machine(result) : show(formatUninstallResult(result)));
  });

  const doctorCommand = fromOption(
    program.command('doctor')
      .description('Inspect host installs and runtime endpoints without changing them')
      .option('--host <host>', 'Host to inspect (repeatable)', collectDoctorHost, []),
    'Target bundle directory or artifact root',
  )
    .option('--json', 'Write one machine-readable JSON document');
  doctorCommand.action(async (commandOptions: DoctorCommandOptions) => {
    const { runDoctor: doctor } = await lifecycle();
    const from = pinned ?? commandOptions.from;
    const result = await doctor({
      ...(from === undefined ? {} : { from }),
      ...(commandOptions.host.length === 0 ? {} : { hosts: commandOptions.host }),
    });
    await (commandOptions.json === true ? machine(result) : show(formatDoctorReport(result)));
    if (result.diagnostics.some((entry) => entry.severity === 'error')) setExitCode(1);
  });
};
