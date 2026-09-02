import type {
  DiscoveryBundleFinding,
  DiscoveryDiagnostic,
  DiscoveryDurableState,
  DiscoveryDurableStateStore,
  DiscoveryEndpointReport,
  DiscoveryFinding,
  DiscoveryHostReport,
  DiscoveryProbe,
  HostDiscoveryReport,
} from '../../contracts/discovery.ts';
import {
  runDoctor,
  type DoctorDurableStateReport,
  type DoctorDurableStateStore,
  type DoctorEndpointReport,
  type DoctorFinding,
  type DoctorHostProbe,
  type DoctorHostReport,
  type DoctorOptions,
  type DoctorReport,
} from '../../install/doctor.ts';
import type { HostDiscoveryRouteService } from './host-discovery-routes.ts';

export interface HostDiscoveryServiceOptions {
  readonly doctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  readonly doctorOptions?: DoctorOptions;
  readonly now?: () => Date;
  readonly prepared?: () => Readonly<{
    readonly bundleSource: string;
    readonly manifestDigest?: string;
  }> | undefined;
}

const discoveryDiagnostic = (
  value: DoctorReport['diagnostics'][number],
): DiscoveryDiagnostic => {
  if (value.recovery === undefined) {
    throw new TypeError(`Doctor diagnostic ${JSON.stringify(value.code)} has no recovery guidance.`);
  }
  return Object.freeze({
    code: value.code,
    message: value.message,
    recovery: value.recovery,
    severity: value.severity,
    ...(value.target === undefined ? {} : { target: value.target }),
  });
};

const durableStateStore = (
  value: DoctorDurableStateStore,
): DiscoveryDurableStateStore => Object.freeze({
  bytes: value.bytes,
  file: value.file,
  mtime: value.mtime,
  path: value.path,
});

const durableState = (
  value: DoctorDurableStateReport,
): DiscoveryDurableState => Object.freeze({
  diagnostics: Object.freeze(value.diagnostics.map(discoveryDiagnostic)),
  directory: value.directory,
  findings: Object.freeze(value.findings.map(durableStateStore)),
  status: value.status,
  summary: Object.freeze({
    bytes: value.summary.bytes,
    stores: value.summary.stores,
  }),
});

const findingFields = (value: DoctorFinding): DiscoveryFinding => Object.freeze({
  ...(value.durableState === undefined ? {} : { durableState: durableState(value.durableState) }),
  ...(value.entry === undefined ? {} : { entry: value.entry }),
  ...(value.manifest === undefined ? {} : { manifest: value.manifest }),
  ...(value.name === undefined ? {} : { name: value.name }),
  ...(value.path === undefined ? {} : { path: value.path }),
  state: value.state,
  ...(value.version === undefined ? {} : { version: value.version }),
});

const bundleFinding = (
  value: NonNullable<DoctorHostReport['bundle']>,
): DiscoveryBundleFinding => Object.freeze({
  ...findingFields(value),
  ...(value.bundleRoot === undefined ? {} : { bundleRoot: value.bundleRoot }),
  ...(value.marketplace === undefined ? {} : { marketplace: value.marketplace }),
});

const discoveryProbe = (value: DoctorHostProbe): DiscoveryProbe => Object.freeze({
  ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
  status: value.status,
  ...(value.version === undefined ? {} : { version: value.version }),
});

const hostReport = (value: DoctorHostReport): DiscoveryHostReport => Object.freeze({
  ...(value.bundle === undefined ? {} : { bundle: bundleFinding(value.bundle) }),
  diagnostics: Object.freeze(value.diagnostics.map(discoveryDiagnostic)),
  host: value.host,
  inventory: Object.freeze({
    findings: Object.freeze(value.inventory.findings.map(findingFields)),
    status: value.inventory.status,
  }),
  probe: discoveryProbe(value.probe),
});

const endpointReport = (value: DoctorEndpointReport): DiscoveryEndpointReport => Object.freeze({
  diagnostics: Object.freeze(value.diagnostics.map(discoveryDiagnostic)),
  directory: value.directory,
  findings: Object.freeze(value.findings.map(findingFields)),
  status: value.status,
  summary: Object.freeze({
    live: value.summary.live,
    staleLocks: value.summary.staleLocks,
    staleSockets: value.summary.staleSockets,
  }),
});

export class HostDiscoveryService implements HostDiscoveryRouteService {
  readonly #doctor: (options: DoctorOptions) => Promise<DoctorReport>;
  readonly #doctorOptions: DoctorOptions;
  readonly #now: () => Date;
  readonly #prepared: NonNullable<HostDiscoveryServiceOptions['prepared']>;
  #inFlight: Promise<HostDiscoveryReport> | undefined;

  constructor(options: HostDiscoveryServiceOptions = {}) {
    this.#doctor = options.doctor ?? runDoctor;
    this.#doctorOptions = options.doctorOptions ?? Object.freeze({});
    this.#now = options.now ?? (() => new Date());
    this.#prepared = options.prepared ?? (() => undefined);
  }

  discover(): Promise<HostDiscoveryReport> {
    const inFlight = this.#inFlight;
    if (inFlight !== undefined) return inFlight;
    const scan = this.#scan();
    this.#inFlight = scan;
    const settle = (): void => {
      if (this.#inFlight === scan) this.#inFlight = undefined;
    };
    void scan.then(settle, settle);
    return scan;
  }

  async #scan(): Promise<HostDiscoveryReport> {
    const prepared = this.#prepared();
    const bundleSource = prepared?.bundleSource;
    const report = await this.#doctor({
      ...this.#doctorOptions,
      ...(bundleSource ? { from: bundleSource } : {}),
    });
    const hosts: readonly DiscoveryHostReport[] = Object.freeze(report.hosts.map(hostReport));
    const endpoints: DiscoveryEndpointReport = endpointReport(report.endpoints);
    const diagnostics: readonly DiscoveryDiagnostic[] = Object.freeze(
      report.diagnostics.map(discoveryDiagnostic),
    );
    const summary: HostDiscoveryReport['summary'] = Object.freeze({
      errors: report.summary.errors,
      infos: report.summary.infos,
      warnings: report.summary.warnings,
    });
    return Object.freeze({
      ...(bundleSource === undefined ? {} : { bundleSource }),
      diagnostics,
      endpoints,
      generatedAt: this.#now().toISOString(),
      hosts,
      ...(prepared?.manifestDigest === undefined
        ? {}
        : { manifestDigest: prepared.manifestDigest }),
      summary,
    });
  }
}
