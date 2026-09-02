export type DiscoveryHost = 'claude' | 'codex' | 'cursor';
export type DiscoveryProbeStatus = 'available' | 'failed' | 'unavailable';
export type DiscoveryInventoryStatus = 'known' | 'skipped' | 'unknown';
export type DiscoveryFindingState =
  | 'conflicted'
  | 'corrupt'
  | 'drifted'
  | 'failed'
  | 'installed'
  | 'interrupted-install'
  | 'live'
  | 'missing'
  | 'registered'
  | 'skipped'
  | 'stale-lock'
  | 'stale-socket'
  | 'unknown'
  | 'unregistered';

export interface DiscoveryDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly recovery: string;
  readonly severity: 'error' | 'info' | 'warning';
  readonly target?: string;
}

export interface DiscoveryDurableStateStore {
  readonly bytes: number;
  readonly file: string;
  readonly mtime: string;
  readonly path: string;
}

export interface DiscoveryDurableState {
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly directory: string;
  readonly findings: readonly DiscoveryDurableStateStore[];
  readonly status: 'known' | 'warnings';
  readonly summary: Readonly<{
    readonly bytes: number;
    readonly stores: number;
  }>;
}

export interface DiscoveryFinding {
  readonly durableState?: DiscoveryDurableState;
  readonly entry?: string;
  readonly manifest?: string;
  readonly name?: string;
  readonly path?: string;
  readonly state: DiscoveryFindingState;
  readonly version?: string;
}

export interface DiscoveryBundleFinding extends DiscoveryFinding {
  readonly bundleRoot?: string;
  readonly marketplace?: string;
}

export interface DiscoveryProbe {
  readonly evidence?: 'directory';
  readonly status: DiscoveryProbeStatus;
  readonly version?: string;
}

export interface DiscoveryHostReport {
  readonly bundle?: DiscoveryBundleFinding;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly host: DiscoveryHost;
  readonly inventory: Readonly<{
    readonly findings: readonly DiscoveryFinding[];
    readonly status: DiscoveryInventoryStatus;
  }>;
  readonly probe: DiscoveryProbe;
}

export interface DiscoveryEndpointReport {
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly directory: string;
  readonly findings: readonly DiscoveryFinding[];
  readonly status: 'failed' | 'healthy' | 'skipped' | 'warnings';
  readonly summary: Readonly<{
    readonly live: number;
    readonly staleLocks: number;
    readonly staleSockets: number;
  }>;
}

export interface HostDiscoveryReport {
  readonly bundleSource?: string;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly endpoints: DiscoveryEndpointReport;
  readonly generatedAt: string;
  readonly hosts: readonly DiscoveryHostReport[];
  readonly manifestDigest?: string;
  readonly summary: Readonly<{
    readonly errors: number;
    readonly infos: number;
    readonly warnings: number;
  }>;
}
