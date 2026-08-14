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
    readonly help: readonly string[];
    readonly status: readonly string[];
    readonly version: readonly string[];
  }>;
  readonly requiredHelpTerms: readonly string[];
  readonly schemaVersion: 1;
}

export interface HostContractEvidence {
  readonly helpOutput: string;
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

export interface HostContractCommand {
  readonly args: readonly string[];
  readonly executable: string;
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const escapeRegularExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const helpIncludesTerm = (helpOutput: string, term: string): boolean => {
  if (!term.startsWith('--')) return helpOutput.includes(term);
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegularExpression(term)}(?![A-Za-z0-9_-])`, 'u').test(helpOutput);
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

const parseManifest = (value: unknown): HostContractManifest | undefined => {
  if (!isRecord(value)) return undefined;
  const probes = value.probes;
  const commandShapes = value.commandShapes;
  const schemaVersion = value.schemaVersion;
  const host = value.host;
  if (
    schemaVersion !== 1
    || !isNativeHost(host)
    || !isRecord(probes)
    || !isRecord(commandShapes)
    || !isStringArray(probes.version)
    || !isStringArray(probes.help)
    || !isStringArray(probes.status)
    || !isStringArray(value.requiredHelpTerms)
    || !isStringArray(value.eventEnvelopeFiles)
  ) return undefined;

  const executable = readString(value.executable);
  const minimumVersion = readString(value.minimumVersion);
  if (executable === undefined || minimumVersion === undefined || parseSemanticVersion(minimumVersion) === undefined) return undefined;

  const parsedCommandShapes: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const [name, shape] of Object.entries(commandShapes)) {
    if (!isStringArray(shape)) return undefined;
    parsedCommandShapes[name] = Object.freeze([...shape]);
  }
  return Object.freeze({
    commandShapes: Object.freeze(parsedCommandShapes),
    eventEnvelopeFiles: Object.freeze([...value.eventEnvelopeFiles]),
    executable,
    host,
    minimumVersion,
    probes: Object.freeze({
      help: Object.freeze([...probes.help]),
      status: Object.freeze([...probes.status]),
      version: Object.freeze([...probes.version]),
    }),
    requiredHelpTerms: Object.freeze([...value.requiredHelpTerms]),
    schemaVersion,
  });
};

export const evaluateHostContract = (manifestInput: unknown, evidence: HostContractEvidence): HostContractReport => {
  const manifest = parseManifest(manifestInput);
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

  const missingTerms = manifest.requiredHelpTerms.filter((term) => !helpIncludesTerm(evidence.helpOutput, term));
  if (missingTerms.length > 0) {
    return report(manifest.host, 'changed', {
      diagnostics: diagnostic(
        manifest.host,
        'host-contract.flags.changed',
        `${manifest.host} ${version} is missing required CLI contract terms: ${missingTerms.join(', ')}. Refresh the host fixture and harness together.`,
      ),
      minimumVersion: manifest.minimumVersion,
      version,
    });
  }

  return report(manifest.host, 'compatible', { minimumVersion: manifest.minimumVersion, version });
};

const commandFor = (manifest: HostContractManifest, kind: HostContractProbeKind): HostContractCommand => Object.freeze({
  args: manifest.probes[kind],
  executable: manifest.executable,
  host: manifest.host,
  kind,
});

const isMissingExecutableError = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

export const compareInstalledHostContract = async (
  manifestInput: unknown,
  options: CompareInstalledHostContractOptions,
): Promise<HostContractReport> => {
  const manifest = parseManifest(manifestInput);
  if (manifest === undefined) return evaluateHostContract(manifestInput, { helpOutput: '', versionOutput: '' });

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

  const outputs: Partial<Record<HostContractProbeKind, HostContractCommandResult>> = Object.create(null) as Partial<Record<HostContractProbeKind, HostContractCommandResult>>;
  for (const kind of ['version', 'help', 'status'] as const) {
    try {
      const result = await options.run(commandFor(manifest, kind));
      if (result.exitCode !== 0) {
        return report(manifest.host, 'changed', {
          diagnostics: diagnostic(
            manifest.host,
            'host-contract.probe.failed',
            `${manifest.host} ${kind} probe failed; inspect the local CLI without recording its output.`,
          ),
          minimumVersion: manifest.minimumVersion,
        });
      }
      outputs[kind] = result;
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
          `${manifest.host} ${kind} probe could not run; inspect the local CLI without recording its output.`,
        ),
        minimumVersion: manifest.minimumVersion,
      });
    }
  }

  return evaluateHostContract(manifest, {
    helpOutput: outputs.help!.stdout,
    versionOutput: outputs.version!.stdout,
  });
};

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
