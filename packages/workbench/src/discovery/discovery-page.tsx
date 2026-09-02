import { useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/unstable/reactivity';
import React, { useMemo, type ReactNode } from 'react';

import {
  discoveryReportAtom,
  type DiscoveryLoader,
  useDiscoveryLoader,
  useDiscoveryRefresh,
} from './discovery-atoms.ts';
import {
  type DiscoveryClient,
  type DiscoveryDiagnostic,
  type DiscoveryFinding,
  type DiscoveryHost,
  type HostDiscoveryReport,
} from './discovery-client.ts';
import {
  hostDiscoveryViewFor,
  isStaleReport,
  type DiscoveryBundleView,
  type DiscoveryFindingView,
  type DiscoveryHostView,
  type DiscoveryPresentation,
} from './discovery-model.ts';
import './discovery-page.css';

export type DiscoveryClientSurface = Pick<DiscoveryClient, 'discover'>;

export interface DiscoveryPageProps {
  readonly client: DiscoveryClientSurface;
  readonly manifestDigest?: string;
}

const valueOrDash = (value: string | undefined): string => value ?? '—';

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

const errorDetails = (reason: unknown): Readonly<{ readonly code: string; readonly message: string }> => {
  if (reason instanceof Error) {
    const code = 'code' in reason && typeof reason.code === 'string' ? reason.code : 'AB8234';
    return Object.freeze({ code, message: reason.message });
  }
  return Object.freeze({
    code: 'AB8234',
    message: 'Host discovery request could not be completed.',
  });
};

const StatusBadge = ({ presentation }: Readonly<{
  readonly presentation: DiscoveryPresentation;
}>) => <span className={`discovery-badge discovery-badge--${presentation.tone}`}>
  {presentation.label}
</span>;

const FindingTable = ({ findings }: Readonly<{
  readonly findings: readonly DiscoveryFindingView[];
}>) => <table className="discovery-table">
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Version</th>
      <th scope="col">Path</th>
      <th scope="col">State</th>
    </tr>
  </thead>
  <tbody>
    {findings.map(({ finding, presentation }, index) => <tr key={`${finding.path ?? finding.name ?? 'finding'}-${String(index)}`}>
      <td>{valueOrDash(finding.name ?? finding.entry ?? finding.manifest)}</td>
      <td>{valueOrDash(finding.version)}</td>
      <td><code>{valueOrDash(finding.path)}</code></td>
      <td><StatusBadge presentation={presentation} /></td>
    </tr>)}
  </tbody>
</table>;

const DurableState = ({ finding }: Readonly<{
  readonly finding: DiscoveryFinding;
}>) => finding.durableState === undefined ? undefined : <div className="discovery-durable">
  <h4>Durable state</h4>
  <dl>
    <div><dt>Status</dt><dd>{finding.durableState.status}</dd></div>
    <div><dt>Directory</dt><dd><code>{finding.durableState.directory}</code></dd></div>
    <div><dt>Stores</dt><dd>{String(finding.durableState.summary.stores)}</dd></div>
    <div><dt>Bytes</dt><dd>{String(finding.durableState.summary.bytes)}</dd></div>
  </dl>
  {finding.durableState.findings.length === 0 ? undefined : <ul aria-label="Durable state stores">
    {finding.durableState.findings.map((store) => <li key={store.path}>
      <code>{store.path}</code>
      <span>{store.file} · {String(store.bytes)} bytes · {store.mtime}</span>
    </li>)}
  </ul>}
</div>;

const BundleCheck = ({ bundle }: Readonly<{
  readonly bundle: DiscoveryBundleView;
}>) => <section className="discovery-bundle" aria-label="Bundle check">
  <div className="discovery-section-heading">
    <h3>Bundle check</h3>
    <StatusBadge presentation={bundle.presentation} />
  </div>
  {bundle.finding === undefined ? undefined : <>
    <dl className="discovery-facts">
      <div><dt>Bundle root</dt><dd><code>{valueOrDash(bundle.finding.bundleRoot)}</code></dd></div>
      <div><dt>Marketplace</dt><dd>{valueOrDash(bundle.finding.marketplace)}</dd></div>
      <div><dt>Version</dt><dd>{valueOrDash(bundle.finding.version)}</dd></div>
    </dl>
    <DurableState finding={bundle.finding} />
  </>}
</section>;

const HostCard = ({ view }: Readonly<{
  readonly view: DiscoveryHostView;
}>) => <section aria-label={view.label} className="discovery-host-card" role="group">
  <header>
    <div>
      <p className="discovery-host-kicker">Local host</p>
      <h2>{hostLabelFor(view.host)}</h2>
    </div>
    <StatusBadge presentation={view.probePresentation} />
  </header>
  <dl className="discovery-facts discovery-probe-facts">
    <div><dt>Version</dt><dd>{valueOrDash(view.probe.version)}</dd></div>
    <div><dt>Evidence</dt><dd>{valueOrDash(view.probe.evidence)}</dd></div>
  </dl>
  <section className="discovery-inventory" aria-label={`${view.label} inventory`}>
    <div className="discovery-section-heading">
      <h3>Installed inventory</h3>
      <StatusBadge presentation={view.inventory.presentation} />
    </div>
    {view.inventory.status === 'known'
      ? view.inventory.findings.length === 0
        ? <p className="discovery-empty">No installed items were reported.</p>
        : <FindingTable findings={view.inventory.findings} />
      : <p className="discovery-honest-state">{view.inventory.presentation.label}</p>}
  </section>
  <BundleCheck bundle={view.bundle} />
</section>;

const EndpointFindings = ({ findings }: Readonly<{
  readonly findings: readonly DiscoveryFindingView[];
}>) => findings.length === 0
  ? <p className="discovery-empty">No runtime endpoint findings were reported.</p>
  : <ul className="discovery-endpoint-findings">
      {findings.map(({ finding, presentation }, index) => <li key={`${finding.path ?? 'endpoint'}-${String(index)}`}>
        <StatusBadge presentation={presentation} />
        <code>{valueOrDash(finding.path)}</code>
      </li>)}
    </ul>;

const Diagnostics = ({ diagnostics }: Readonly<{
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}>) => <section aria-label="Discovery diagnostics" className="discovery-diagnostics">
  <div className="discovery-title-row">
    <div>
      <p className="discovery-eyebrow">Report evidence</p>
      <h2>Diagnostics</h2>
    </div>
    <span>{String(diagnostics.length)} total</span>
  </div>
  {diagnostics.length === 0
    ? <p className="discovery-empty">No discovery diagnostics were reported.</p>
    : <ol>
        {diagnostics.map((diagnostic, index) => <li
          className={`discovery-diagnostic discovery-diagnostic--${diagnostic.severity}`}
          key={`${diagnostic.code}-${String(index)}`}
        >
          <div>
            <code>{diagnostic.code}</code>
            <span>{diagnostic.severity}</span>
          </div>
          <p>{diagnostic.message}</p>
          <p><strong>Recovery:</strong> {diagnostic.recovery}</p>
          {diagnostic.target === undefined ? undefined : <small>Target: {diagnostic.target}</small>}
        </li>)}
      </ol>}
</section>;

const DiscoveryReport = ({ manifestDigest, onRefresh, report }: Readonly<{
  readonly manifestDigest: string | undefined;
  readonly onRefresh: () => void;
  readonly report: HostDiscoveryReport;
}>) => {
  const view = hostDiscoveryViewFor(report);
  const stale = isStaleReport(manifestDigest, report);
  return <>
    <div className="discovery-toolbar">
      <button onClick={onRefresh} type="button">Re-run discovery</button>
      <dl>
        <div><dt>Generated at</dt><dd>{report.generatedAt}</dd></div>
        {report.manifestDigest === undefined ? undefined : <div>
          <dt>Manifest digest</dt><dd><code>{report.manifestDigest}</code></dd>
        </div>}
      </dl>
    </div>
    {stale ? <section className="discovery-stale" role="status">
      <div>
        <h2>Discovery report is from an older build</h2>
        <p>This read-only report was generated against an older build. Re-run discovery to compare hosts with the current manifest.</p>
      </div>
      <button onClick={onRefresh} type="button">Re-run discovery</button>
    </section> : undefined}
    <section aria-label="Build drift source" className="discovery-build-source">
      <h2>Build drift source</h2>
      <StatusBadge presentation={view.build} />
    </section>
    <div className="discovery-host-grid">
      {view.hosts.map((host) => <HostCard key={host.host} view={host} />)}
    </div>
    <section aria-label="Runtime endpoints" className="discovery-endpoints">
      <div className="discovery-title-row">
        <div>
          <p className="discovery-eyebrow">Runtime health</p>
          <h2>Endpoints</h2>
        </div>
        <StatusBadge presentation={view.endpoints.presentation} />
      </div>
      <dl className="discovery-facts discovery-endpoint-summary">
        <div><dt>Directory</dt><dd><code>{report.endpoints.directory}</code></dd></div>
        <div><dt>Live</dt><dd>{String(report.endpoints.summary.live)}</dd></div>
        <div><dt>Stale locks</dt><dd>{String(report.endpoints.summary.staleLocks)}</dd></div>
        <div><dt>Stale sockets</dt><dd>{String(report.endpoints.summary.staleSockets)}</dd></div>
      </dl>
      <EndpointFindings findings={view.endpoints.findings} />
    </section>
    <Diagnostics diagnostics={view.diagnostics} />
  </>;
};

const DiscoveryResult = ({ manifestDigest, onRefresh, refreshKey }: Readonly<{
  readonly manifestDigest: string | undefined;
  readonly onRefresh: () => void;
  readonly refreshKey: number;
}>): ReactNode => {
  const result = useAtomValue(discoveryReportAtom(refreshKey));
  const errorPanel = (reason: unknown): ReactNode => {
    const error = errorDetails(reason);
    return <section className="discovery-error" role="alert">
      <h2>Host discovery unavailable</h2>
      <p><strong>{error.code}</strong> {error.message}</p>
    </section>;
  };
  return AsyncResult.matchWithWaiting(result, {
    onDefect: errorPanel,
    onError: errorPanel,
    onSuccess: ({ value }) => <DiscoveryReport
      manifestDigest={manifestDigest}
      onRefresh={onRefresh}
      report={value}
    />,
    onWaiting: () => <p className="discovery-loading" role="status">Loading host discovery</p>,
  });
};

/** Read-only browser view of local hosts, installed bundles, drift, and runtime endpoints. */
export const DiscoveryPage = ({ client, manifestDigest }: DiscoveryPageProps) => {
  const loader = useMemo<DiscoveryLoader>(() => (signal) => client.discover(signal), [client]);
  const loaderReady = useDiscoveryLoader(loader);
  const [refreshKey, refresh] = useDiscoveryRefresh();

  return <section aria-label="Host discovery" className="discovery-content" role="region">
    <div className="page-heading discovery-page-heading">
      <div>
        <p className="discovery-eyebrow">Local environment</p>
        <h1>Hosts</h1>
        <p>Read-only discovery of local agent hosts, installed bundles, drift against the current build, and runtime endpoints.</p>
      </div>
    </div>
    {loaderReady
      ? <DiscoveryResult manifestDigest={manifestDigest} onRefresh={refresh} refreshKey={refreshKey} />
      : <p className="discovery-loading" role="status">Loading host discovery</p>}
  </section>;
};
