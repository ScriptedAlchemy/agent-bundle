export type HostCliHost = 'claude' | 'codex';

export interface HostCliPin {
  readonly host: HostCliHost;
  readonly package: string;
  readonly provenancePath: string;
  readonly version: string;
}

export type HostCliPins = Readonly<Record<HostCliHost, HostCliPin>>;

export interface HostCliProbeResult {
  readonly error?: unknown;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

export type HostCliVerification =
  | { readonly host: HostCliHost; readonly installed: string; readonly line: string; readonly status: 'match' }
  | { readonly host: HostCliHost; readonly installed: string; readonly line: string; readonly status: 'mismatch' }
  | { readonly host: HostCliHost; readonly line: string; readonly status: 'missing' };

export interface HostCliVerificationReport {
  readonly ok: boolean;
  readonly results: readonly HostCliVerification[];
}

export interface RunHostCliPinsOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly root?: string;
}

export declare const hostCliHosts: readonly HostCliHost[];

export declare const hostCliProvenancePaths: Readonly<Record<HostCliHost, string>>;

export declare const hostCliPinFromProvenance: (
  host: HostCliHost,
  provenancePath: string,
  document: unknown,
) => HostCliPin;

export declare const readHostCliPins: (root?: string) => Promise<HostCliPins>;

export declare const parseCliVersion: (stdout: string) => string | undefined;

export declare const verifyHostCliPins: (
  pins: HostCliPins,
  probe: (host: HostCliHost) => Promise<HostCliProbeResult> | HostCliProbeResult,
) => Promise<HostCliVerificationReport>;

export declare const installArguments: (pins: HostCliPins, prefix?: string) => readonly string[];

export declare const runHostCliPins: (options?: RunHostCliPinsOptions) => Promise<HostCliPins>;
