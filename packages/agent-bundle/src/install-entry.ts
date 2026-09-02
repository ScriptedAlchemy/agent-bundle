import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { stableJson } from './core/digest.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
import {
  installBundle,
  type InstallHost,
  type InstallResult,
  type InstallScope,
} from './install/install.ts';

export interface GeneratedInstallProcessOptions {
  readonly artifactRelativeUrl: string;
  readonly hosts: readonly InstallHost[];
  readonly name: string;
}

const usage = (options: GeneratedInstallProcessOptions): string => [
  `Usage: ${options.name} install <host> [--scope <scope>] [--json]`,
  '',
  `Built hosts: ${options.hosts.join(', ')}`,
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

const writeHuman = (result: InstallResult): void => {
  const destination = result.destination ?? result.bundleRoot;
  process.stdout.write(
    `${result.state === 'already-installed' ? 'Already installed' : 'Installed'} ` +
    `${result.plugin}@${result.version} for ${result.host} at ${destination}\n`,
  );
};

const isHost = (value: string): value is InstallHost =>
  value === 'claude' || value === 'codex' || value === 'cursor';

const isScope = (value: string): value is InstallScope =>
  value === 'local' || value === 'project' || value === 'user';

interface ParsedInstallArguments {
  readonly host: InstallHost;
  readonly json: boolean;
  readonly scope: InstallScope;
}

const parseArguments = (
  argv: readonly string[],
  options: GeneratedInstallProcessOptions,
): ParsedInstallArguments => {
  if (argv[0] !== 'install') {
    throw new TypeError(`Expected "install <host>"; built hosts: ${options.hosts.join(', ')}.`);
  }
  const candidate = argv[1];
  if (candidate === undefined || !isHost(candidate) || !options.hosts.includes(candidate)) {
    throw new TypeError(
      `Cannot install host ${JSON.stringify(candidate ?? '')}; built hosts: ${options.hosts.join(', ')}.`,
    );
  }
  let json = false;
  let scope: InstallScope = 'user';
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
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
  return Object.freeze({ host: candidate, json, scope });
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
    const artifactRoot = fileURLToPath(new URL(options.artifactRelativeUrl, import.meta.url));
    const metadata = await lstat(artifactRoot).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory()) {
      throw new Error(
        `Package artifact root is missing at ${JSON.stringify(artifactRoot)}; ` +
        'the package must ship its generated artifact directory.',
      );
    }
    const result = await installBundle({
      from: artifactRoot,
      host: parsed.host,
      scope: parsed.scope,
    });
    if (parsed.json) process.stdout.write(`${stableJson(result)}\n`);
    else writeHuman(result);
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
