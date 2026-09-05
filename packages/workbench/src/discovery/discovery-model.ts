import type {
  DiscoveryDiagnostic,
  DiscoveryHost,
  DiscoveryHostReport,
  DiscoveryProbe,
  HostDiscoveryReport,
  McpProbeStatus,
} from './discovery-client.ts';

export type DiscoveryPresentationTone = 'error' | 'info' | 'neutral' | 'positive' | 'warning';

export type PluginAttachState = 'attached' | 'detached' | 'stale' | 'unknown';

export interface DiscoveryPresentation {
  readonly label: string;
  readonly tone: DiscoveryPresentationTone;
}

export interface PluginAttachView {
  readonly epochId?: string;
  readonly label: string;
  readonly state: PluginAttachState;
}

export interface HostDiagnosticsCard {
  readonly attach: PluginAttachView;
  readonly errors: readonly DiscoveryDiagnostic[];
  readonly executablePath?: string;
  readonly handshakeServer?: string;
  readonly host: DiscoveryHost;
  readonly installed: boolean;
  readonly label: string;
  readonly probe: DiscoveryProbe;
  readonly probePresentation: DiscoveryPresentation;
  readonly version?: string;
}

export interface HostDiagnosticsView {
  readonly hosts: readonly HostDiagnosticsCard[];
  readonly report: HostDiscoveryReport;
}

const presentation = (
  label: string,
  tone: DiscoveryPresentationTone,
): DiscoveryPresentation => Object.freeze({ label, tone });

export const probePresentationFor = (probe: DiscoveryProbe): DiscoveryPresentation => {
  switch (probe.status) {
    case 'available':
      return presentation('Installed', 'positive');
    case 'failed':
      return presentation('Probe failed', 'warning');
    case 'unavailable':
      return presentation('Not installed', 'neutral');
    default: {
      const exhaustive: never = probe.status;
      return exhaustive;
    }
  }
};

export const mcpProbePresentationFor = (status: McpProbeStatus): DiscoveryPresentation => {
  switch (status) {
    case 'ok':
      return presentation('Handshake ok', 'positive');
    case 'timed-out':
      return presentation('Handshake timed out', 'neutral');
    case 'unreachable':
      return presentation('Handshake unreachable', 'neutral');
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

export const hostLabelFor = (host: DiscoveryHost): string => {
  switch (host) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
  }
};

const attachPresentationFor = (state: PluginAttachState): string => {
  switch (state) {
    case 'attached':
      return 'Current dev plugin attached';
    case 'detached':
      return 'Current dev plugin not attached';
    case 'stale':
      return 'Installed plugin is stale versus this build';
    case 'unknown':
      return 'Plugin attach state is unknown';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const pluginAttachFor = (host: DiscoveryHostReport): PluginAttachView => {
  const bundle = host.bundle;
  if (bundle === undefined) {
    return Object.freeze({
      label: attachPresentationFor(host.probe.status === 'unavailable' ? 'detached' : 'unknown'),
      state: host.probe.status === 'unavailable' ? 'detached' : 'unknown',
    });
  }
  const epochId = bundle.version;
  const state: PluginAttachState = bundle.state === 'drifted' || bundle.state === 'conflicted'
    ? 'stale'
    : bundle.state === 'installed' || bundle.state === 'registered' || bundle.state === 'live'
      ? 'attached'
      : bundle.state === 'missing' || bundle.state === 'unregistered' || bundle.state === 'disabled'
        ? 'detached'
        : 'unknown';
  return Object.freeze({
    ...(epochId === undefined ? {} : { epochId }),
    label: attachPresentationFor(state),
    state,
  });
};

const executablePathFor = (host: DiscoveryHostReport): string | undefined =>
  host.inventory.findings.find((finding) => finding.path !== undefined)?.path
  ?? host.bundle?.bundleRoot
  ?? host.bundle?.path;

const versionFor = (host: DiscoveryHostReport): string | undefined =>
  host.probe.version ?? host.bundle?.version ?? host.inventory.findings.find((finding) => finding.version !== undefined)?.version;

const actionableErrorsFor = (host: DiscoveryHostReport): readonly DiscoveryDiagnostic[] =>
  Object.freeze(host.diagnostics.filter((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning'));

const handshakeServerFor = (host: DiscoveryHostReport): string | undefined =>
  host.bundle?.mcpServers?.[0]?.name;

const hostCardFor = (host: DiscoveryHostReport): HostDiagnosticsCard => Object.freeze({
  attach: pluginAttachFor(host),
  errors: actionableErrorsFor(host),
  ...(executablePathFor(host) === undefined ? {} : { executablePath: executablePathFor(host) }),
  ...(handshakeServerFor(host) === undefined ? {} : { handshakeServer: handshakeServerFor(host) }),
  host: host.host,
  installed: host.probe.status === 'available',
  label: hostLabelFor(host.host),
  probe: host.probe,
  probePresentation: probePresentationFor(host.probe),
  ...(versionFor(host) === undefined ? {} : { version: versionFor(host) }),
});

/** Per-host install, attach, and handshake facts for Advanced / Host diagnostics. */
export const hostDiagnosticsViewFor = (report: HostDiscoveryReport): HostDiagnosticsView => Object.freeze({
  hosts: Object.freeze(report.hosts.map(hostCardFor)),
  report,
});

export const isStaleReport = (
  currentManifestDigest: string | undefined,
  report: HostDiscoveryReport,
): boolean => currentManifestDigest !== undefined
  && report.manifestDigest !== undefined
  && currentManifestDigest !== report.manifestDigest;
