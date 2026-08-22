import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isErrno } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';
import { escapeRegExp } from '../core/strings.ts';

// Pure parsing and opt-in probing contract for subscription-backed native host CLIs.
export type NativeHost = 'claude' | 'codex';

export type HostContractStatus = 'changed' | 'compatible' | 'incompatible' | 'missing' | 'skipped';

export interface HostContractDiagnostic {
  readonly code: string;
  readonly host: NativeHost | 'unknown';
  readonly message: string;
}

export interface HostContractManifest {
  readonly commandShapes: Readonly<Record<string, readonly string[]>>;
  readonly eventEnvelopeFiles: readonly string[];
  readonly executable: string;
  readonly host: NativeHost;
  readonly minimumVersion: string;
  readonly probes: Readonly<{
    readonly help: readonly HostContractHelpProbe[];
    readonly status: HostContractProbe;
    readonly version: HostContractProbe;
  }>;
  readonly temporaryHomeEnvironment?: 'CODEX_HOME';
}

export interface HostContractEvidence {
  readonly helpOutputs: Readonly<Record<string, string>>;
  readonly versionOutput: string;
}

export interface HostContractReport {
  readonly diagnostics: readonly HostContractDiagnostic[];
  readonly host: NativeHost | 'unknown';
  readonly minimumVersion?: string;
  readonly status: HostContractStatus;
  readonly version?: string;
}

export type HostContractProbeKind = keyof HostContractManifest['probes'];

export interface HostContractProbe {
  readonly args: readonly string[];
}

export interface HostContractHelpProbe extends HostContractProbe {
  readonly id: string;
  readonly output: string;
  readonly requiredCommands?: readonly string[];
  readonly requiredLiterals?: readonly string[];
  readonly requiredOptions?: readonly string[];
}

export interface HostContractCommand {
  readonly args: readonly string[];
  readonly executable: string;
  readonly helpId?: string;
  readonly host: NativeHost;
  readonly kind: HostContractProbeKind;
}

export interface HostContractCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type HostContractCommandRunner = (command: HostContractCommand) => Promise<HostContractCommandResult>;

export interface CompareInstalledHostContractOptions {
  readonly enabled: boolean;
  readonly run: HostContractCommandRunner;
}

export interface RedactedEventEnvelope {
  readonly fields: readonly string[];
  readonly type?: string;
}

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
}

const isNativeHost = (value: unknown): value is NativeHost => value === 'claude' || value === 'codex';

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const readString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const parseSemanticVersion = (value: string): SemanticVersion | undefined => {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?=$|[^0-9A-Za-z.-])/u.exec(value);
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: Object.freeze(match[4].split('.')) }),
  });
};

const formatSemanticVersion = (version: SemanticVersion): string =>
  `${version.major}.${version.minor}.${version.patch}${version.prerelease === undefined ? '' : `-${version.prerelease.join('.')}`}`;

const compareNumericIdentifiers = (left: string, right: string): number => {
  const normalizedLeft = left.replace(/^0+/u, '') || '0';
  const normalizedRight = right.replace(/^0+/u, '') || '0';
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
};

const comparePrereleases = (left: readonly string[] | undefined, right: readonly string[] | undefined): number => {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
};

const compareSemanticVersions = (left: SemanticVersion, right: SemanticVersion): number => {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return comparePrereleases(left.prerelease, right.prerelease);
};

const sameStringArrays = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const sameOptionalStringArrays = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  left === undefined || right === undefined ? left === right : sameStringArrays(left, right);

const declaredOptions = (helpOutput: string): ReadonlySet<string> => {
  const options = new Set<string>();
  let inOptionsSection = false;
  for (const line of helpOutput.split(/\r?\n/u)) {
    if (/^\s*Options:\s*$/iu.test(line)) {
      inOptionsSection = true;
      continue;
    }
    if (!inOptionsSection) continue;
    if (/^\S.*:\s*$/u.test(line)) {
      inOptionsSection = false;
      continue;
    }
    const definition = /^\s+(?:-[A-Za-z0-9],\s+)?(--[A-Za-z][A-Za-z0-9-]*)(?:\s+(?:<[^>\r\n]+>|\[[^\]\r\n]+\]|[A-Z][A-Z0-9_-]*))*(?:\s{2,}|$)/u.exec(line);
    if (definition !== null) options.add(definition[1]!);
  }
  return Object.freeze(options);
};

const declaredCommands = (helpOutput: string): ReadonlySet<string> => Object.freeze(new Set(
  helpOutput
    .split(/\r?\n/u)
    .flatMap((line) => /^\s{2,}([A-Za-z][A-Za-z0-9-]*(?:\|[A-Za-z][A-Za-z0-9-]*)*)(?:\s+(?:\[[^\]\r\n]+\]|<[^>\r\n]+>|[A-Z][A-Z0-9_-]*))*\s{2,}/u.exec(line)?.[1].split('|') ?? []),
));

const hasExactToken = (value: string, token: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`, 'u').test(value);

const missingHelpRequirement = (probe: HostContractHelpProbe, output: string): { readonly label: string; readonly values: readonly string[] } | undefined => {
  const options = (probe.requiredOptions ?? []).filter((option) => !declaredOptions(output).has(option));
  if (options.length > 0) return Object.freeze({ label: 'options', values: Object.freeze(options) });
  const commands = (probe.requiredCommands ?? []).filter((command) => !declaredCommands(output).has(command));
  if (commands.length > 0) return Object.freeze({ label: 'commands', values: Object.freeze(commands) });
  const literals = (probe.requiredLiterals ?? []).filter((literal) => !hasExactToken(output, literal));
  return literals.length === 0 ? undefined : Object.freeze({ label: 'literal tokens', values: Object.freeze(literals) });
};

const diagnostic = (
  host: NativeHost | 'unknown',
  code: string,
  message: string,
): readonly HostContractDiagnostic[] => Object.freeze([Object.freeze({ code, host, message })]);

const report = (
  host: NativeHost | 'unknown',
  status: HostContractStatus,
  options: Omit<HostContractReport, 'diagnostics' | 'host' | 'status'> & { readonly diagnostics?: readonly HostContractDiagnostic[] } = {},
): HostContractReport => Object.freeze({
  diagnostics: options.diagnostics ?? Object.freeze([]),
  host,
  ...(options.minimumVersion === undefined ? {} : { minimumVersion: options.minimumVersion }),
  status,
  ...(options.version === undefined ? {} : { version: options.version }),
});

interface HostContractStructure {
  readonly commandShapes: Readonly<Record<string, readonly string[]>>;
  readonly help: readonly HostContractHelpProbe[];
  readonly status: readonly string[];
  readonly temporaryHomeEnvironment?: 'CODEX_HOME';
  readonly version: readonly string[];
}

const canonicalStructures: Readonly<Record<NativeHost, HostContractStructure>> = Object.freeze({
  claude: Object.freeze({
    commandShapes: Object.freeze({
      hookEvent: Object.freeze(['hook_event_name', 'PreToolUse']),
      nativeExecution: Object.freeze(['-p', '--plugin-dir', '<plugin-root>', '--output-format', 'stream-json', '--no-session-persistence', '<task-input>']),
    }),
    help: Object.freeze([
      Object.freeze({
        args: Object.freeze(['--help']),
        id: 'root',
        output: 'help.txt',
        requiredLiterals: Object.freeze(['stream-json']),
        requiredOptions: Object.freeze(['--plugin-dir', '--output-format', '--no-session-persistence']),
      }),
      Object.freeze({
        args: Object.freeze(['plugin', '--help']),
        id: 'plugin',
        output: 'plugin-help.txt',
        requiredCommands: Object.freeze(['install', 'marketplace', 'validate']),
      }),
    ]),
    status: Object.freeze(['plugin', '--help']),
    version: Object.freeze(['--version']),
  }),
  codex: Object.freeze({
    commandShapes: Object.freeze({
      ephemeralExecution: Object.freeze(['exec', '--ephemeral', '--json', '<task-input>']),
      marketplaceAdd: Object.freeze(['plugin', 'marketplace', 'add', '<marketplace-path>']),
      pluginAdd: Object.freeze(['plugin', 'add', '<plugin>@<marketplace>']),
      pluginList: Object.freeze(['plugin', 'list', '--json']),
    }),
    help: Object.freeze([
      Object.freeze({ args: Object.freeze(['--help']), id: 'root', output: 'help.txt', requiredCommands: Object.freeze(['exec', 'plugin']) }),
      Object.freeze({ args: Object.freeze(['exec', '--help']), id: 'exec', output: 'exec-help.txt', requiredOptions: Object.freeze(['--ephemeral', '--json']) }),
      Object.freeze({ args: Object.freeze(['plugin', '--help']), id: 'plugin', output: 'plugin-help.txt', requiredCommands: Object.freeze(['add', 'list', 'marketplace']) }),
      Object.freeze({ args: Object.freeze(['plugin', 'add', '--help']), id: 'plugin-add', output: 'plugin-add-help.txt' }),
      Object.freeze({ args: Object.freeze(['plugin', 'list', '--help']), id: 'plugin-list', output: 'plugin-list-help.txt', requiredOptions: Object.freeze(['--json']) }),
      Object.freeze({ args: Object.freeze(['plugin', 'marketplace', '--help']), id: 'marketplace', output: 'marketplace-help.txt', requiredCommands: Object.freeze(['add', 'list']) }),
    ]),
    status: Object.freeze(['plugin', 'list', '--json']),
    temporaryHomeEnvironment: 'CODEX_HOME',
    version: Object.freeze(['--version']),
  }),
});

const parseProbe = (value: unknown): HostContractProbe | undefined => {
  if (!isRecord(value) || !isStringArray(value.args) || value.args.length === 0) return undefined;
  return Object.freeze({ args: Object.freeze([...value.args]) });
};

const parseOptionalStringArray = (value: unknown): readonly string[] | undefined =>
  value === undefined ? undefined : isStringArray(value) ? Object.freeze([...value]) : undefined;

const parseHelpProbe = (value: unknown): HostContractHelpProbe | undefined => {
  if (!isRecord(value)) return undefined;
  const probe = parseProbe(value);
  const id = readString(value.id);
  const output = readString(value.output);
  const requiredCommands = parseOptionalStringArray(value.requiredCommands);
  const requiredLiterals = parseOptionalStringArray(value.requiredLiterals);
  const requiredOptions = parseOptionalStringArray(value.requiredOptions);
  if (
    probe === undefined
    || id === undefined
    || output === undefined
    || (value.requiredCommands !== undefined && requiredCommands === undefined)
    || (value.requiredLiterals !== undefined && requiredLiterals === undefined)
    || (value.requiredOptions !== undefined && requiredOptions === undefined)
  ) return undefined;
  return Object.freeze({
    ...probe,
    id,
    output,
    ...(requiredCommands === undefined ? {} : { requiredCommands }),
    ...(requiredLiterals === undefined ? {} : { requiredLiterals }),
    ...(requiredOptions === undefined ? {} : { requiredOptions }),
  });
};

const sameHelpProbe = (left: HostContractHelpProbe, right: HostContractHelpProbe): boolean =>
  left.id === right.id
  && left.output === right.output
  && sameStringArrays(left.args, right.args)
  && sameOptionalStringArrays(left.requiredCommands, right.requiredCommands)
  && sameOptionalStringArrays(left.requiredLiterals, right.requiredLiterals)
  && sameOptionalStringArrays(left.requiredOptions, right.requiredOptions);

const hasCanonicalStructure = (manifest: HostContractManifest): boolean => {
  const structure = canonicalStructures[manifest.host];
  const expectedCommandShapeNames = Object.keys(structure.commandShapes).sort();
  const actualCommandShapeNames = Object.keys(manifest.commandShapes).sort();
  return sameStringArrays(expectedCommandShapeNames, actualCommandShapeNames)
    && expectedCommandShapeNames.every((name) => sameStringArrays(manifest.commandShapes[name]!, structure.commandShapes[name]!))
    && sameStringArrays(manifest.probes.version.args, structure.version)
    && sameStringArrays(manifest.probes.status.args, structure.status)
    && manifest.probes.help.length === structure.help.length
    && manifest.probes.help.every((probe, index) => sameHelpProbe(probe, structure.help[index]!))
    && manifest.temporaryHomeEnvironment === structure.temporaryHomeEnvironment;
};

const hostContractManifestKeys = new Set([
  'commandShapes',
  'eventEnvelopeFiles',
  'executable',
  'host',
  'minimumVersion',
  'probes',
  'temporaryHomeEnvironment',
]);

export const parseHostContractManifest = (value: unknown): HostContractManifest | undefined => {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !hostContractManifestKeys.has(key))) return undefined;
  const probes = value.probes;
  const commandShapes = value.commandShapes;
  const host = value.host;
  if (
    !isNativeHost(host)
    || !isRecord(probes)
    || !isRecord(commandShapes)
    || !Array.isArray(probes.help)
    || !isStringArray(value.eventEnvelopeFiles)
  ) return undefined;

  const executable = readString(value.executable);
  const minimumVersion = readString(value.minimumVersion);
  const version = parseProbe(probes.version);
  const status = parseProbe(probes.status);
  const help = probes.help.map(parseHelpProbe);
  if (
    executable === undefined
    || minimumVersion === undefined
    || parseSemanticVersion(minimumVersion) === undefined
    || version === undefined
    || status === undefined
    || help.some((probe) => probe === undefined)
  ) return undefined;

  const parsedCommandShapes: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const [name, shape] of Object.entries(commandShapes)) {
    if (!isStringArray(shape)) return undefined;
    parsedCommandShapes[name] = Object.freeze([...shape]);
  }
  const temporaryHomeEnvironment = value.temporaryHomeEnvironment;
  if (temporaryHomeEnvironment !== undefined && temporaryHomeEnvironment !== 'CODEX_HOME') return undefined;

  const manifest = Object.freeze({
    commandShapes: Object.freeze(parsedCommandShapes),
    eventEnvelopeFiles: Object.freeze([...value.eventEnvelopeFiles]),
    executable,
    host,
    minimumVersion,
    probes: Object.freeze({
      help: Object.freeze(help as HostContractHelpProbe[]),
      status,
      version,
    }),
    ...(temporaryHomeEnvironment === undefined ? {} : { temporaryHomeEnvironment }),
  });
  return hasCanonicalStructure(manifest) ? manifest : undefined;
};

export const evaluateHostContract = (manifestInput: unknown, evidence: HostContractEvidence): HostContractReport => {
  const manifest = parseHostContractManifest(manifestInput);
  if (manifest === undefined) {
    return report('unknown', 'changed', {
      diagnostics: diagnostic('unknown', 'host-contract.fixture.invalid', 'The checked-in host contract fixture is invalid; refresh its contract data.'),
    });
  }

  const observedVersion = parseSemanticVersion(evidence.versionOutput);
  const minimumVersion = parseSemanticVersion(manifest.minimumVersion)!;
  if (observedVersion === undefined) {
    return report(manifest.host, 'changed', {
      diagnostics: diagnostic(
        manifest.host,
        'host-contract.version.unparseable',
        `${manifest.host} did not report a semantic version for the ${manifest.minimumVersion} contract.`,
      ),
      minimumVersion: manifest.minimumVersion,
    });
  }

  const version = formatSemanticVersion(observedVersion);
  if (compareSemanticVersions(observedVersion, minimumVersion) < 0) {
    return report(manifest.host, 'incompatible', {
      diagnostics: diagnostic(
        manifest.host,
        'host-contract.version.incompatible',
        `${manifest.host} ${version} is older than the minimum supported version ${manifest.minimumVersion}; upgrade the CLI.`,
      ),
      minimumVersion: manifest.minimumVersion,
      version,
    });
  }

  for (const probe of manifest.probes.help) {
    const output = evidence.helpOutputs[probe.id];
    if (output === undefined) {
      return report(manifest.host, 'changed', {
        diagnostics: diagnostic(
          manifest.host,
          'host-contract.help.missing',
          `${manifest.host} ${version} did not return output for help probe "${probe.id}". Refresh the host fixture and harness together.`,
        ),
        minimumVersion: manifest.minimumVersion,
        version,
      });
    }
    const missing = missingHelpRequirement(probe, output);
    if (missing !== undefined) {
      return report(manifest.host, 'changed', {
        diagnostics: diagnostic(
          manifest.host,
          'host-contract.help.changed',
          `${manifest.host} ${version} help probe "${probe.id}" is missing required ${missing.label}: ${missing.values.join(', ')}. Refresh the host fixture and harness together.`,
        ),
        minimumVersion: manifest.minimumVersion,
        version,
      });
    }
  }

  return report(manifest.host, 'compatible', { minimumVersion: manifest.minimumVersion, version });
};

const commandFor = (
  manifest: HostContractManifest,
  kind: Exclude<HostContractProbeKind, 'help'>,
): HostContractCommand => Object.freeze({
  args: manifest.probes[kind].args,
  executable: manifest.executable,
  host: manifest.host,
  kind,
});

const helpCommandFor = (manifest: HostContractManifest, probe: HostContractHelpProbe): HostContractCommand => Object.freeze({
  args: probe.args,
  executable: manifest.executable,
  helpId: probe.id,
  host: manifest.host,
  kind: 'help',
});

const isMissingExecutableError = (error: unknown): boolean => isErrno(error, 'ENOENT');

export const compareInstalledHostContract = async (
  manifestInput: unknown,
  options: CompareInstalledHostContractOptions,
): Promise<HostContractReport> => {
  const manifest = parseHostContractManifest(manifestInput);
  if (manifest === undefined) return evaluateHostContract(manifestInput, { helpOutputs: {}, versionOutput: '' });

  if (!options.enabled) {
    return report(manifest.host, 'skipped', {
      diagnostics: diagnostic(
        manifest.host,
        'host-contract.opt-in.required',
        `Set AGENT_BUNDLE_NATIVE_HOST_CONTRACTS=1 to compare the installed ${manifest.host} CLI contract.`,
      ),
      minimumVersion: manifest.minimumVersion,
    });
  }

  const helpOutputs: Record<string, string> = Object.create(null) as Record<string, string>;
  let versionOutput = '';
  const probes = [
    commandFor(manifest, 'version'),
    ...manifest.probes.help.map((probe) => helpCommandFor(manifest, probe)),
    commandFor(manifest, 'status'),
  ];
  for (const command of probes) {
    try {
      const result = await options.run(command);
      if (result.exitCode !== 0) {
        return report(manifest.host, 'changed', {
          diagnostics: diagnostic(
            manifest.host,
            'host-contract.probe.failed',
            `${manifest.host} ${command.kind}${command.helpId === undefined ? '' : ` "${command.helpId}"`} probe failed; inspect the local CLI without recording its output.`,
          ),
          minimumVersion: manifest.minimumVersion,
        });
      }
      if (command.kind === 'version') versionOutput = result.stdout;
      if (command.kind === 'help') helpOutputs[command.helpId!] = result.stdout;
    } catch (error) {
      if (isMissingExecutableError(error)) {
        return report(manifest.host, 'missing', {
          diagnostics: diagnostic(
            manifest.host,
            'host-contract.cli.missing',
            `${manifest.executable} is not installed or is not on PATH; install ${manifest.host} ${manifest.minimumVersion} or newer.`,
          ),
          minimumVersion: manifest.minimumVersion,
        });
      }
      return report(manifest.host, 'changed', {
        diagnostics: diagnostic(
          manifest.host,
          'host-contract.probe.failed',
          `${manifest.host} ${command.kind}${command.helpId === undefined ? '' : ` "${command.helpId}"`} probe could not run; inspect the local CLI without recording its output.`,
        ),
        minimumVersion: manifest.minimumVersion,
      });
    }
  }

  return evaluateHostContract(manifest, {
    helpOutputs,
    versionOutput,
  });
};

const executeFileAsync = promisify(executeFile);

export const nativeHostContractComparisonEnabled = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean => environment.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1';

const runLocalHostContractCommand: HostContractCommandRunner = async (command) => {
  try {
    const result = await executeFileAsync(command.executable, [...command.args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return Object.freeze({ exitCode: 0, stdout: result.stdout });
  } catch (error) {
    if (isMissingExecutableError(error)) throw error;
    if (isRecord(error)) {
      return Object.freeze({
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
      });
    }
    throw error;
  }
};

export const compareLocalHostContract = async (
  manifestInput: unknown,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<HostContractReport> => compareInstalledHostContract(manifestInput, {
  enabled: nativeHostContractComparisonEnabled(environment),
  run: runLocalHostContractCommand,
});

const parseEventRecords = (raw: string): readonly unknown[] => {
  const trimmed = raw.trim();
  try {
    return Object.freeze([JSON.parse(trimmed) as unknown]);
  } catch {
    return Object.freeze(
      raw
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown),
    );
  }
};

export const parseRedactedEventEnvelopes = (raw: string): readonly RedactedEventEnvelope[] => Object.freeze(
  parseEventRecords(raw)
    .map((value) => {
      if (!isRecord(value)) throw new TypeError('Host event envelope must be a JSON object.');
      return Object.freeze({
        fields: Object.freeze(Object.keys(value).sort()),
        ...(typeof value.type === 'string' ? { type: value.type } : {}),
      });
    }),
);
