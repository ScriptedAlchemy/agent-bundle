import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { stableJson } from './core/digest.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
import { formatInstallResult, formatUninstallResult } from './install/format.ts';
import {
  installBundle,
  type InstallHost,
  type InstallMode,
  type InstallResult,
  type InstallScope,
} from './install/install.ts';
import { uninstallBundle, type UninstallResult } from './install/uninstall.ts';

export interface GeneratedInstallProcessOptions {
  readonly artifactRoot: string | URL;
  readonly hosts: readonly InstallHost[];
  readonly name: string;
}

const usage = (options: GeneratedInstallProcessOptions): string => [
  `Usage: ${options.name} install <host> [--scope <scope>] [--mode local|marketplace] [--replace|--force] [--json]`,
  `       ${options.name} uninstall <host> [--scope <scope>] [--mode local|marketplace] [--keep-data | --purge-data --confirm-purge] [--force] [--plan] [--json]`,
  '',
  `Built hosts: ${options.hosts.join(', ')}`,
  '',
  '--replace (alias --force) replaces an existing agent-bundle install of this plugin even when',
  'its version differs. Same-version content drift is replaced automatically; foreign installs',
  'are always refused.',
  '',
  'uninstall removes exactly what the install receipt owns (files, directories, host registrations)',
  'and keeps durable runtime state unless --purge-data --confirm-purge is passed. It refuses a',
  'missing receipt or an owned-content mismatch unless --force; foreign directories are always',
  'refused. --plan prints the exact paths without changing anything.',
  '',
].join('\n');

const diagnosticsFor = (error: unknown): readonly Diagnostic[] =>
  error instanceof DiagnosticError
    ? error.diagnostics
    : Object.freeze([Object.freeze({
      code: 'AB7004',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error' as const,
    })]);

const isHost = (value: string): value is InstallHost =>
  value === 'claude' || value === 'codex' || value === 'cursor';

const isScope = (value: string): value is InstallScope =>
  value === 'local' || value === 'project' || value === 'user';

const isMode = (value: string): value is InstallMode =>
  value === 'local' || value === 'marketplace';

type InstallerVerb = 'install' | 'uninstall';

interface ParsedInstallArguments {
  readonly confirmPurge: boolean;
  readonly force: boolean;
  readonly host: InstallHost;
  readonly json: boolean;
  readonly keepData: boolean;
  readonly mode?: InstallMode;
  readonly plan: boolean;
  readonly purgeData: boolean;
  readonly replace: boolean;
  readonly scope: InstallScope;
  readonly verb: InstallerVerb;
}

const parseArguments = (
  argv: readonly string[],
  options: GeneratedInstallProcessOptions,
): ParsedInstallArguments => {
  const verb = argv[0];
  if (verb !== 'install' && verb !== 'uninstall') {
    throw new TypeError(`Expected "install <host>" or "uninstall <host>"; built hosts: ${options.hosts.join(', ')}.`);
  }
  const candidate = argv[1];
  if (candidate === undefined || !isHost(candidate) || !options.hosts.includes(candidate)) {
    throw new TypeError(
      `Cannot ${verb} host ${JSON.stringify(candidate ?? '')}; built hosts: ${options.hosts.join(', ')}.`,
    );
  }
  let json = false;
  let replace = false;
  let force = false;
  let keepData = false;
  let purgeData = false;
  let confirmPurge = false;
  let plan = false;
  let scope: InstallScope = 'user';
  let mode: InstallMode | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--replace' && verb === 'install') {
      replace = true;
      continue;
    }
    if (argument === '--force') {
      // `install --force` is the --replace alias; `uninstall --force` overrides a missing or mismatched receipt.
      replace = true;
      force = true;
      continue;
    }
    if (argument === '--keep-data' && verb === 'uninstall') {
      keepData = true;
      continue;
    }
    if (argument === '--purge-data' && verb === 'uninstall') {
      purgeData = true;
      continue;
    }
    if (argument === '--confirm-purge' && verb === 'uninstall') {
      confirmPurge = true;
      continue;
    }
    if (argument === '--plan' && verb === 'uninstall') {
      plan = true;
      continue;
    }
    if (argument === '--mode') {
      const value = argv[index + 1];
      if (value === undefined || !isMode(value)) {
        throw new TypeError('Install mode must be local or marketplace.');
      }
      mode = value;
      index += 1;
      continue;
    }
    if (argument === '--scope') {
      const value = argv[index + 1];
      if (value === undefined || !isScope(value)) {
        throw new TypeError('Install scope must be user, project, or local.');
      }
      scope = value;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown installer argument ${JSON.stringify(argument)}.`);
  }
  return Object.freeze({
    confirmPurge,
    force,
    host: candidate,
    json,
    keepData,
    ...(mode === undefined ? {} : { mode }),
    plan,
    purgeData,
    replace,
    scope,
    verb,
  });
};

const writeResult = (parsed: ParsedInstallArguments, result: InstallResult | UninstallResult, human: string): void => {
  process.stdout.write(parsed.json ? `${stableJson(result)}\n` : human);
};

export const runGeneratedInstallProcess = async (
  argv: readonly string[],
  options: GeneratedInstallProcessOptions,
): Promise<number> => {
  if (argv.length === 0 || argv.includes('--help')) {
    process.stdout.write(usage(options));
    return 0;
  }
  let parsed: ParsedInstallArguments | undefined;
  try {
    parsed = parseArguments(argv, options);
    const artifactRoot = options.artifactRoot instanceof URL
      ? fileURLToPath(options.artifactRoot)
      : options.artifactRoot;
    const metadata = await lstat(artifactRoot).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory()) {
      throw new Error(
        `Package artifact root is missing at ${JSON.stringify(artifactRoot)}; ` +
        'the package must ship its generated artifact directory.',
      );
    }
    switch (parsed.verb) {
      case 'install': {
        const result = await installBundle({
          from: artifactRoot,
          host: parsed.host,
          replace: parsed.replace,
          ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
          scope: parsed.scope,
        });
        writeResult(parsed, result, formatInstallResult(result));
        break;
      }
      case 'uninstall': {
        const result = await uninstallBundle({
          confirmPurge: parsed.confirmPurge,
          force: parsed.force,
          from: artifactRoot,
          host: parsed.host,
          keepData: parsed.keepData,
          ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
          plan: parsed.plan,
          purgeData: parsed.purgeData,
          scope: parsed.scope,
        });
        writeResult(parsed, result, formatUninstallResult(result));
        break;
      }
      default: {
        const exhaustive: never = parsed.verb;
        throw new TypeError(`Unknown installer verb ${String(exhaustive)}.`);
      }
    }
    return 0;
  } catch (error) {
    if (parsed?.json === true) {
      process.stderr.write(`${stableJson(diagnosticsFor(error))}\n`);
    } else {
      const diagnostics = diagnosticsFor(error);
      process.stderr.write(`${diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('\n')}\n`);
    }
    return 1;
  }
};
