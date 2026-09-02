import { useAtom, useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/unstable/reactivity';
import React, { useEffect, useMemo, useRef, type ReactNode } from 'react';

import {
  discoveryReportAtom,
  discoveryProbeKey,
  discoveryProbeLoaderAtom,
  discoveryProbeStateAtom,
  type DiscoveryLoader,
  type DiscoveryProbeLoader,
  useDiscoveryLoader,
  useDiscoveryProbeLoader,
  useDiscoveryRefresh,
} from './discovery-atoms.ts';
import {
  type DiscoveryClient,
  type DiscoveryDiagnostic,
  type DiscoveryFinding,
  type DiscoveryHost,
  type McpProbeLaunch,
  type McpProbeReport,
  type HostDiscoveryReport,
} from './discovery-client.ts';
import {
  hostDiscoveryViewFor,
  isStaleReport,
  mcpProbeViewFor,
  type DiscoveryBundleView,
  type DiscoveryFindingView,
  type DiscoveryHostView,
  type DiscoveryPresentation,
} from './discovery-model.ts';
import './discovery-page.css';

export type DiscoveryClientSurface = Pick<DiscoveryClient, 'discover' | 'probe'>;

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

const probeErrorDetails = (
  reason: unknown,
): Readonly<{ readonly code: string; readonly message: string }> => {
  if (reason instanceof Error) {
    const code = 'code' in reason && typeof reason.code === 'string' ? reason.code : 'AB8235';
    return Object.freeze({ code, message: reason.message });
  }
  return Object.freeze({
    code: 'AB8235',
    message: 'MCP probe request could not be completed.',
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

const launchSummary = (launch: McpProbeLaunch): ReactNode => {
  switch (launch.kind) {
    case 'stdio': {
      const environment = Object.entries(launch.env);
      return <>
        <code>{[launch.command, ...launch.args].join(' ')}</code>
        {launch.cwd === undefined ? undefined : <p>Working directory: <code>{launch.cwd}</code></p>}
        {environment.length === 0
          ? <p>No environment entries.</p>
          : <ul aria-label="Redacted launch environment">
              {environment.map(([name, value]) => <li key={name}><code>{name}={value}</code></li>)}
            </ul>}
      </>;
    }
    case 'streamable-http':
      return <code>{launch.url}</code>;
    default: {
      const exhaustive: never = launch;
      return exhaustive;
    }
  }
};

const McpProbeResult = ({ report }: Readonly<{ readonly report: McpProbeReport }>) => {
  const view = mcpProbeViewFor(report);
  const metadata = <dl className="discovery-facts discovery-mcp-probe-metadata">
    <div><dt>Duration</dt><dd>{String(report.durationMs)} ms</dd></div>
    <div><dt>Generated at</dt><dd>{report.generatedAt}</dd></div>
  </dl>;
  const launch = <section className="discovery-mcp-launch" aria-label="Redacted launch summary">
    <h5>Redacted launch summary</h5>
    {launchSummary(report.launch)}
  </section>;

  switch (report.status) {
    case 'ok': {
      const snapshot = report.snapshot;
      if (snapshot === undefined) return undefined;
      return <div className="discovery-mcp-result">
        <div className="discovery-mcp-result-heading">
          <h4>Live probe result</h4>
          <StatusBadge presentation={view.presentation} />
        </div>
        <dl className="discovery-facts discovery-mcp-server-facts">
          <div><dt>Protocol</dt><dd>{snapshot.protocolVersion}</dd></div>
          <div><dt>Server name</dt><dd>{snapshot.serverInfo.name}</dd></div>
          <div><dt>Title</dt><dd>{valueOrDash(snapshot.serverInfo.title)}</dd></div>
          <div><dt>Version</dt><dd>{snapshot.serverInfo.version}</dd></div>
        </dl>
        {view.capabilityNames.length === 0 ? undefined : <div className="discovery-mcp-capabilities">
          <h5>Capabilities</h5>
          <div>{view.capabilityNames.map((capability) =>
            <span className="discovery-badge discovery-badge--neutral" key={capability}>{capability}</span>)}</div>
        </div>}
        {snapshot.instructions === undefined ? undefined : <section className="discovery-mcp-instructions">
          <h5>Instructions</h5>
          <p>{snapshot.instructions}</p>
        </section>}
        <section className="discovery-mcp-tools" aria-label={`${report.serverName} tools`}>
          <h5>Read-only tool catalog</h5>
          {snapshot.tools.length === 0
            ? <p className="discovery-empty">No tools were reported.</p>
            : <table className="discovery-table discovery-mcp-tools-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Title</th>
                    <th scope="col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.tools.map((tool) => <tr key={tool.name}>
                    <td><code>{tool.name}</code></td>
                    <td>{valueOrDash(tool.title)}</td>
                    <td>{valueOrDash(tool.description)}</td>
                  </tr>)}
                </tbody>
              </table>}
          {snapshot.toolsTruncated
            ? <p className="discovery-honest-state">The tool catalog was truncated by the probe response limit.</p>
            : undefined}
        </section>
        {launch}
        {metadata}
      </div>;
    }
    case 'timed-out':
    case 'unreachable':
      return <div className="discovery-mcp-result discovery-mcp-result--down">
        <div className="discovery-mcp-result-heading">
          <h4>Live probe result</h4>
          <StatusBadge presentation={view.presentation} />
        </div>
        {report.failure === undefined ? undefined : <>
          <p><strong>{report.failure.kind}</strong></p>
          <p>{report.failure.detail}</p>
        </>}
        {launch}
        {metadata}
      </div>;
    default: {
      const exhaustive: never = report.status;
      return exhaustive;
    }
  }
};

const McpServerProbe = ({ host, refreshKey, serverName }: Readonly<{
  readonly host: DiscoveryHost;
  readonly refreshKey: number;
  readonly serverName: string;
}>) => {
  const [state, setState] = useAtom(
    discoveryProbeStateAtom(discoveryProbeKey(refreshKey, host, serverName)),
  );
  const probe = useAtomValue(discoveryProbeLoaderAtom);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => {
    activeRequest.current?.abort();
    activeRequest.current = undefined;
  }, []);

  const confirm = (): void => {
    if (probe === undefined || activeRequest.current !== undefined) return;
    const request = new AbortController();
    activeRequest.current = request;
    setState(Object.freeze({ state: 'probing' }));
    void probe(Object.freeze({ host, serverName }), request.signal).then(
      (report) => {
        if (activeRequest.current !== request) return;
        activeRequest.current = undefined;
        setState(Object.freeze({ report, state: 'settled' }));
      },
      (reason: unknown) => {
        if (activeRequest.current !== request) return;
        activeRequest.current = undefined;
        if (reason instanceof Error && reason.name === 'AbortError') return;
        const error = probeErrorDetails(reason);
        setState(Object.freeze({ ...error, state: 'failed' }));
      },
    );
  };

  if (state === undefined) {
    return <button
      aria-label={`Probe ${serverName}`}
      className="discovery-mcp-probe-button"
      onClick={() => setState(Object.freeze({ state: 'consent-pending' }))}
      type="button"
    >
      Probe
    </button>;
  }
  switch (state.state) {
    case 'consent-pending':
      return <div className="discovery-mcp-consent">
        <h4>Consent required</h4>
        <p>
          This read-only live probe performs an MCP initialize handshake and tools/list against
          the installed bundle&apos;s <strong>{serverName}</strong> server. It starts the server
          process or connects to its endpoint on this machine. Nothing is stored, and this
          surface cannot call tools.
        </p>
        <div>
          <button onClick={() => setState(undefined)} type="button">Cancel</button>
          <button disabled={probe === undefined} onClick={confirm} type="button">Run live probe</button>
        </div>
      </div>;
    case 'probing':
      return <p className="discovery-mcp-probing" role="status">Probing {serverName}…</p>;
    case 'settled':
      return <>
        <McpProbeResult report={state.report} />
        <button
          aria-label={`Probe ${serverName} again`}
          className="discovery-mcp-probe-button"
          onClick={() => setState(Object.freeze({ state: 'consent-pending' }))}
          type="button"
        >
          Probe again
        </button>
      </>;
    case 'failed':
      return <>
        <div className="discovery-mcp-request-error" role="alert">
          <h4>Live probe unavailable</h4>
          <p><strong>{state.code}</strong> {state.message}</p>
        </div>
        <button
          aria-label={`Probe ${serverName} again`}
          className="discovery-mcp-probe-button"
          onClick={() => setState(Object.freeze({ state: 'consent-pending' }))}
          type="button"
        >
          Try again
        </button>
      </>;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const transportLabelFor = (
  transport: 'stdio' | 'streamable-http',
): string => {
  switch (transport) {
    case 'stdio':
      return 'stdio';
    case 'streamable-http':
      return 'streamable HTTP';
    default: {
      const exhaustive: never = transport;
      return exhaustive;
    }
  }
};

const McpServers = ({ bundle, host, refreshKey }: Readonly<{
  readonly bundle: DiscoveryBundleView;
  readonly host: DiscoveryHost;
  readonly refreshKey: number;
}>) => {
  const servers = bundle.finding?.mcpServers;
  if (servers === undefined) return undefined;
  return <section className="discovery-mcp-servers" aria-label={`${hostLabelFor(host)} MCP servers`}>
    <div className="discovery-section-heading">
      <h3>MCP servers</h3>
      <span>{String(servers.length)} declared</span>
    </div>
    {servers.length === 0
      ? <p className="discovery-empty">No MCP servers are declared by this bundle.</p>
      : <ul>
          {servers.map((server) => <li key={server.name}>
            <div className="discovery-mcp-server-heading">
              <div>
                <strong>{server.name}</strong>
                <span className="discovery-badge discovery-badge--neutral">
                  {transportLabelFor(server.transport)}
                </span>
              </div>
            </div>
            <McpServerProbe host={host} refreshKey={refreshKey} serverName={server.name} />
          </li>)}
        </ul>}
  </section>;
};

const BundleCheck = ({ bundle, host, refreshKey }: Readonly<{
  readonly bundle: DiscoveryBundleView;
  readonly host: DiscoveryHost;
  readonly refreshKey: number;
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
    <McpServers bundle={bundle} host={host} refreshKey={refreshKey} />
  </>}
</section>;

const HostCard = ({ refreshKey, view }: Readonly<{
  readonly refreshKey: number;
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
  <BundleCheck bundle={view.bundle} host={view.host} refreshKey={refreshKey} />
</section>;

const RuntimeIdentity = ({ finding }: Readonly<{ readonly finding: DiscoveryFinding }>) => {
  const runtime = finding.runtime;
  if (runtime === undefined) return <p className="discovery-honest-state">Runtime identity not reported.</p>;
  switch (runtime.status) {
    case 'available':
      return <dl className="discovery-facts">
        <div><dt>Instance ID</dt><dd><code>{runtime.instanceId}</code></dd></div>
        <div><dt>Artifact epoch</dt><dd><code>{runtime.artifactEpoch}</code></dd></div>
        <div><dt>Availability</dt><dd>{runtime.availability}</dd></div>
        <div><dt>PID</dt><dd>{String(runtime.pid)}</dd></div>
      </dl>;
    case 'unsupported':
      return <p className="discovery-honest-state">Runtime identity is unsupported by this endpoint.</p>;
    case 'unavailable':
      return <p className="discovery-honest-state">Runtime identity became unavailable during discovery.</p>;
    case 'failed':
      return <p className="discovery-honest-state">Runtime identity probe failed.</p>;
    default: {
      const exhaustive: never = runtime;
      return exhaustive;
    }
  }
};

const EndpointFindings = ({ findings }: Readonly<{
  readonly findings: readonly DiscoveryFindingView[];
}>) => findings.length === 0
  ? <p className="discovery-empty">No runtime endpoint findings were reported.</p>
  : <ul className="discovery-endpoint-findings">
      {findings.map(({ finding, presentation }, index) => <li key={`${finding.path ?? 'endpoint'}-${String(index)}`}>
        <StatusBadge presentation={presentation} />
        <code>{valueOrDash(finding.path)}</code>
        <RuntimeIdentity finding={finding} />
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

const DiscoveryReport = ({ manifestDigest, onRefresh, refreshKey, report }: Readonly<{
  readonly manifestDigest: string | undefined;
  readonly onRefresh: () => void;
  readonly refreshKey: number;
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
      {view.hosts.map((host) => <HostCard key={host.host} refreshKey={refreshKey} view={host} />)}
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
      refreshKey={refreshKey}
      report={value}
    />,
    onWaiting: () => <p className="discovery-loading" role="status">Loading host discovery</p>,
  });
};

/** Read-only browser view of local hosts, installed bundles, drift, and runtime endpoints. */
export const DiscoveryPage = ({ client, manifestDigest }: DiscoveryPageProps) => {
  const loader = useMemo<DiscoveryLoader>(() => (signal) => client.discover(signal), [client]);
  const probeLoader = useMemo<DiscoveryProbeLoader>(
    () => (request, signal) => client.probe(request, signal),
    [client],
  );
  const loaderReady = useDiscoveryLoader(loader);
  const probeLoaderReady = useDiscoveryProbeLoader(probeLoader);
  const [refreshKey, refresh] = useDiscoveryRefresh();

  return <section aria-label="Host discovery" className="discovery-content" role="region">
    <div className="page-heading discovery-page-heading">
      <div>
        <p className="discovery-eyebrow">Local environment</p>
        <h1>Hosts</h1>
        <p>Read-only discovery of local agent hosts, installed bundles, drift against the current build, and runtime endpoints.</p>
      </div>
    </div>
    {loaderReady && probeLoaderReady
      ? <DiscoveryResult manifestDigest={manifestDigest} onRefresh={refresh} refreshKey={refreshKey} />
      : <p className="discovery-loading" role="status">Loading host discovery</p>}
  </section>;
};
