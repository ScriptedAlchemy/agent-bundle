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
  type DiscoveryHost,
  type HostDiscoveryReport,
} from './discovery-client.ts';
import {
  hostDiagnosticsViewFor,
  hostLabelFor,
  isStaleReport,
  mcpProbePresentationFor,
  type DiscoveryPresentation,
  type HostDiagnosticsCard,
} from './discovery-model.ts';
import './discovery-page.css';

export type DiscoveryClientSurface = Pick<DiscoveryClient, 'discover' | 'probe'>;

export interface DiscoveryPageProps {
  readonly client: DiscoveryClientSurface;
  readonly manifestDigest?: string;
}

const valueOrDash = (value: string | undefined): string => value ?? '—';

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

const HandshakeIndicator = ({ host, refreshKey, serverName }: Readonly<{
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
      aria-label={`Probe MCP handshake for ${hostLabelFor(host)}`}
      className="discovery-mcp-probe-button"
      onClick={() => setState(Object.freeze({ state: 'consent-pending' }))}
      type="button"
    >
      Probe handshake
    </button>;
  }
  switch (state.state) {
    case 'consent-pending':
      return <div className="discovery-mcp-consent">
        <h4>Consent required</h4>
        <p>
          This read-only live probe performs one MCP initialize handshake against
          the installed bundle&apos;s <strong>{serverName}</strong> server. Nothing is stored,
          and this surface cannot call tools.
        </p>
        <div>
          <button onClick={() => setState(undefined)} type="button">Cancel</button>
          <button disabled={probe === undefined} onClick={confirm} type="button">Run handshake</button>
        </div>
      </div>;
    case 'probing':
      return <p className="discovery-mcp-probing" role="status">Probing {serverName}…</p>;
    case 'settled':
      return <div className="discovery-handshake">
        <StatusBadge presentation={mcpProbePresentationFor(state.report.status)} />
        <button
          aria-label={`Probe MCP handshake for ${hostLabelFor(host)} again`}
          className="discovery-mcp-probe-button"
          onClick={() => setState(Object.freeze({ state: 'consent-pending' }))}
          type="button"
        >
          Probe again
        </button>
      </div>;
    case 'failed':
      return <>
        <div className="discovery-mcp-request-error" role="alert">
          <h4>Handshake unavailable</h4>
          <p><strong>{state.code}</strong> {state.message}</p>
        </div>
        <button
          aria-label={`Probe MCP handshake for ${hostLabelFor(host)} again`}
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

const ActionableErrors = ({
  diagnostics,
  onRefresh,
}: Readonly<{
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly onRefresh: () => void;
}>) => diagnostics.length === 0
  ? <p className="discovery-empty">No actionable host errors.</p>
  : <ol className="discovery-host-errors">
      {diagnostics.map((diagnostic, index) => <li
        className={`discovery-diagnostic discovery-diagnostic--${diagnostic.severity}`}
        key={`${diagnostic.code}-${String(index)}`}
      >
        <div>
          <code>{diagnostic.code}</code>
          <span>{diagnostic.severity}</span>
        </div>
        <p>{diagnostic.message}</p>
        <p><strong>Fix:</strong> {diagnostic.recovery}</p>
        <button onClick={onRefresh} type="button">Re-run discovery</button>
      </li>)}
    </ol>;

const HostCard = ({
  onRefresh,
  refreshKey,
  view,
}: Readonly<{
  readonly onRefresh: () => void;
  readonly refreshKey: number;
  readonly view: HostDiagnosticsCard;
}>) => <section aria-label={view.label} className="discovery-host-card" role="group">
  <header>
    <div>
      <p className="discovery-host-kicker">Local host</p>
      <h2>{view.label}</h2>
    </div>
    <StatusBadge presentation={view.probePresentation} />
  </header>
  <dl className="discovery-facts discovery-probe-facts">
    <div><dt>Installed</dt><dd>{view.installed ? 'Yes' : 'No'}</dd></div>
    <div><dt>Version</dt><dd>{valueOrDash(view.version)}</dd></div>
    <div><dt>Executable path</dt><dd><code>{valueOrDash(view.executablePath)}</code></dd></div>
    <div>
      <dt>Dev plugin</dt>
      <dd>
        {view.attach.label}
        {view.attach.epochId === undefined ? undefined : <> · <code>{view.attach.epochId}</code></>}
      </dd>
    </div>
  </dl>
  <section aria-label={`${view.label} errors`} className="discovery-host-actions">
    <h3>Actionable errors</h3>
    <ActionableErrors diagnostics={view.errors} onRefresh={onRefresh} />
  </section>
  <section aria-label={`${view.label} MCP handshake`} className="discovery-handshake-section">
    <h3>MCP handshake</h3>
    {view.handshakeServer === undefined
      ? <p className="discovery-empty">No MCP server is declared for this host.</p>
      : <HandshakeIndicator host={view.host} refreshKey={refreshKey} serverName={view.handshakeServer} />}
  </section>
</section>;

const DiscoveryReport = ({ manifestDigest, onRefresh, refreshKey, report }: Readonly<{
  readonly manifestDigest: string | undefined;
  readonly onRefresh: () => void;
  readonly refreshKey: number;
  readonly report: HostDiscoveryReport;
}>) => {
  const view = hostDiagnosticsViewFor(report);
  const stale = isStaleReport(manifestDigest, report);
  return <>
    <div className="discovery-toolbar">
      <button onClick={onRefresh} type="button">Re-run discovery</button>
    </div>
    {stale ? <section className="discovery-stale" role="status">
      <div>
        <h2>Discovery report is from an older build</h2>
        <p>This read-only report was generated against an older build. Re-run discovery to compare hosts with the current manifest.</p>
      </div>
      <button onClick={onRefresh} type="button">Re-run discovery</button>
    </section> : undefined}
    <div className="discovery-host-grid">
      {view.hosts.map((host) => <HostCard
        key={host.host}
        onRefresh={onRefresh}
        refreshKey={refreshKey}
        view={host}
      />)}
    </div>
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
      <h2>Host diagnostics unavailable</h2>
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
    onWaiting: () => <p className="discovery-loading" role="status">Loading host diagnostics</p>,
  });
};

/** Per-host install, attach, and handshake diagnostics. */
export const DiscoveryPage = ({ client, manifestDigest }: DiscoveryPageProps) => {
  const loader = useMemo<DiscoveryLoader>(() => (signal) => client.discover(signal), [client]);
  const probeLoader = useMemo<DiscoveryProbeLoader>(
    () => (request, signal) => client.probe(request, signal),
    [client],
  );
  const loaderReady = useDiscoveryLoader(loader);
  const probeLoaderReady = useDiscoveryProbeLoader(probeLoader);
  const [refreshKey, refresh] = useDiscoveryRefresh();

  return <section aria-label="Host diagnostics" className="discovery-content" role="region">
    <div className="page-heading discovery-page-heading">
      <div>
        <p className="discovery-eyebrow">Advanced</p>
        <h1>Host diagnostics</h1>
        <p>Installed hosts, the current dev plugin attach state, actionable errors, and one MCP handshake per host.</p>
      </div>
    </div>
    {loaderReady && probeLoaderReady
      ? <DiscoveryResult manifestDigest={manifestDigest} onRefresh={refresh} refreshKey={refreshKey} />
      : <p className="discovery-loading" role="status">Loading host diagnostics</p>}
  </section>;
};
