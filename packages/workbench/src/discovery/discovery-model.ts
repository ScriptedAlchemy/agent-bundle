import type {
  DiscoveryBundleFinding,
  DiscoveryDiagnostic,
  DiscoveryEndpointReport,
  DiscoveryFinding,
  DiscoveryFindingState,
  DiscoveryHost,
  DiscoveryHostReport,
  DiscoveryInventoryStatus,
  DiscoveryProbe,
  HostDiscoveryReport,
} from './discovery-client.ts';

export type DiscoveryPresentationTone = 'error' | 'info' | 'neutral' | 'warning';

export interface DiscoveryPresentation {
  readonly label: string;
  readonly tone: DiscoveryPresentationTone;
}

export interface DiscoveryFindingView {
  readonly finding: DiscoveryFinding;
  readonly presentation: DiscoveryPresentation;
}

export interface DiscoveryInventoryView {
  readonly findings: readonly DiscoveryFindingView[];
  readonly presentation: DiscoveryPresentation;
  readonly status: DiscoveryInventoryStatus;
}

export interface DiscoveryBundleView {
  readonly finding: DiscoveryBundleFinding | undefined;
  readonly presentation: DiscoveryPresentation;
}

export interface DiscoveryHostView {
  readonly bundle: DiscoveryBundleView;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly host: DiscoveryHost;
  readonly inventory: DiscoveryInventoryView;
  readonly label: string;
  readonly probe: DiscoveryProbe;
  readonly probePresentation: DiscoveryPresentation;
}

export interface DiscoveryEndpointView {
  readonly report: DiscoveryEndpointReport;
  readonly findings: readonly DiscoveryFindingView[];
  readonly presentation: DiscoveryPresentation;
}

export interface HostDiscoveryView {
  readonly build: DiscoveryPresentation;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly endpoints: DiscoveryEndpointView;
  readonly hosts: readonly DiscoveryHostView[];
  readonly report: HostDiscoveryReport;
}

const presentation = (
  label: string,
  tone: DiscoveryPresentationTone,
): DiscoveryPresentation => Object.freeze({ label, tone });

export const probePresentationFor = (probe: DiscoveryProbe): DiscoveryPresentation => {
  switch (probe.status) {
    case 'available':
      return presentation('Available', 'neutral');
    case 'failed':
      return presentation('Probe failed', 'neutral');
    case 'unavailable':
      return presentation('Not installed', 'neutral');
    default: {
      const exhaustive: never = probe.status;
      return exhaustive;
    }
  }
};

export const inventoryPresentationFor = (
  host: DiscoveryHost,
  status: DiscoveryInventoryStatus,
): DiscoveryPresentation => {
  switch (status) {
    case 'known':
      return presentation('Known inventory', 'neutral');
    case 'skipped':
      return presentation('Inventory scan skipped', 'neutral');
    case 'unknown':
      return presentation(`Unknown — ${host} owns its registry`, 'neutral');
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

export const findingPresentationFor = (state: DiscoveryFindingState): DiscoveryPresentation => {
  switch (state) {
    case 'conflicted':
      return presentation('Conflicted', 'warning');
    case 'corrupt':
      return presentation('Corrupt', 'warning');
    case 'drifted':
      return presentation('Drifted', 'warning');
    case 'failed':
      return presentation('Failed', 'error');
    case 'installed':
      return presentation('Installed', 'neutral');
    case 'interrupted-install':
      return presentation('Interrupted install', 'warning');
    case 'live':
      return presentation('Live', 'neutral');
    case 'missing':
      return presentation('Missing', 'neutral');
    case 'registered':
      return presentation('Registered', 'neutral');
    case 'skipped':
      return presentation('Skipped', 'neutral');
    case 'stale-lock':
      return presentation('Stale lock', 'warning');
    case 'stale-socket':
      return presentation('Stale socket', 'warning');
    case 'unknown':
      return presentation('Unknown', 'neutral');
    case 'unregistered':
      return presentation('Unregistered', 'neutral');
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const endpointPresentationFor = (report: DiscoveryEndpointReport): DiscoveryPresentation => {
  switch (report.status) {
    case 'failed':
      return presentation('Endpoint scan failed', 'error');
    case 'healthy':
      return presentation('Healthy', 'neutral');
    case 'skipped':
      return presentation(`Endpoint scan skipped — ${report.directory}`, 'neutral');
    case 'warnings':
      return presentation('Warnings', 'warning');
    default: {
      const exhaustive: never = report.status;
      return exhaustive;
    }
  }
};

const hostLabelFor = (host: DiscoveryHost): string => {
  switch (host) {
    case 'claude':
      return 'Claude';
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

const findingViewFor = (finding: DiscoveryFinding): DiscoveryFindingView => Object.freeze({
  finding,
  presentation: findingPresentationFor(finding.state),
});

const hostViewFor = (
  report: DiscoveryHostReport,
  bundleSource: string | undefined,
): DiscoveryHostView => {
  const inventoryPresentation = inventoryPresentationFor(report.host, report.inventory.status);
  const bundlePresentation = bundleSource === undefined
    ? presentation('No built bundle is available for drift checks', 'info')
    : report.bundle === undefined
      ? presentation('No installed bundle reported', 'neutral')
      : findingPresentationFor(report.bundle.state);
  return Object.freeze({
    bundle: Object.freeze({
      finding: report.bundle,
      presentation: bundlePresentation,
    }),
    diagnostics: report.diagnostics,
    host: report.host,
    inventory: Object.freeze({
      findings: Object.freeze(report.inventory.findings.map(findingViewFor)),
      presentation: inventoryPresentation,
      status: report.inventory.status,
    }),
    label: hostLabelFor(report.host),
    probe: report.probe,
    probePresentation: probePresentationFor(report.probe),
  });
};

const allDiagnosticsFor = (report: HostDiscoveryReport): readonly DiscoveryDiagnostic[] => Object.freeze([
  ...report.diagnostics,
  ...report.hosts.flatMap((host) => [
    ...host.diagnostics,
    ...(host.bundle?.durableState?.diagnostics ?? []),
  ]),
  ...report.endpoints.diagnostics,
]);

/** Pure read-model projection for host, bundle, endpoint, and diagnostic sections. */
export const hostDiscoveryViewFor = (report: HostDiscoveryReport): HostDiscoveryView => Object.freeze({
  build: report.bundleSource === undefined
    ? presentation('No built bundle is available for drift checks', 'info')
    : presentation(report.bundleSource, 'neutral'),
  diagnostics: allDiagnosticsFor(report),
  endpoints: Object.freeze({
    findings: Object.freeze(report.endpoints.findings.map(findingViewFor)),
    presentation: endpointPresentationFor(report.endpoints),
    report: report.endpoints,
  }),
  hosts: Object.freeze(report.hosts.map((host) => hostViewFor(host, report.bundleSource))),
  report,
});

export const isStaleReport = (
  currentManifestDigest: string | undefined,
  report: HostDiscoveryReport,
): boolean => currentManifestDigest !== undefined
  && report.manifestDigest !== undefined
  && currentManifestDigest !== report.manifestDigest;
