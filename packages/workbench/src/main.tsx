import { errorMessage as messageFrom } from './client-helpers.ts';
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type { PlaygroundRun } from '../../agent-bundle/src/dev/playground-contract.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';
import type { NativePlaygroundCatalog } from '../../agent-bundle/src/dev/native-playground-service.ts';

import { ArtifactClient } from './artifacts/artifact-client.ts';
import { ComparisonClient } from './comparisons/comparison-client.ts';
import { ComparisonsPage } from './comparisons/comparisons-page.tsx';
import { EvalClient } from './evals/eval-client.ts';
import { EvalsPage } from './evals/evals-page.tsx';
import { ArtifactsPage } from './artifacts/artifacts-page.tsx';
import { HookClient } from './hooks/hook-client.ts';
import { ForegroundSessionAuthority } from './foreground-session.ts';
import { HooksPage } from './hooks/hooks-page.tsx';
import { InspectorSessionAdapter } from './inspector/adapter/inspector-session-adapter-entry.ts';
import { McpAppClient } from './mcp/mcp-app-client.ts';
import { McpPage } from './mcp/mcp-page.tsx';
import { mcpProtocolTraceDownload, type McpDownload } from './mcp/mcp-protocol-trace.ts';
import { McpRouteClient } from './mcp/mcp-route-client.ts';
import { createMcpSessionController } from './mcp/mcp-session-controller.ts';
import { LogClient } from './logs/log-client.ts';
import { LogsPage } from './logs/logs-page.tsx';
import { PlaygroundClient } from './playground/playground-client.ts';
import {
  PlaygroundPage,
  createPlaygroundCatalogLifecycle,
  playgroundScriptsForEpoch,
  type PlaygroundScriptCatalog,
} from './playground/playground-page.tsx';
import { overviewFor } from './overview-model.ts';
import { ProjectClient, type ProjectConnectionState } from './project-client.ts';
import { SkillClient } from './skill-client.ts';
import { SkillsPage } from './skills-page.tsx';
import './styles.css';

const Topbar = ({ connectionError }: { readonly connectionError?: string }) => <header className="topbar">
  <span className="menu-glyph" aria-hidden="true">☰</span>
  <span className="topbar-title">Project workbench</span>
  <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
    <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
  </span>
</header>;

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

const dateTime = (value: string | undefined): string => value === undefined
  ? 'Not available'
  : dateTimeFormat.format(new Date(value));

const stateLabel = (state: string): string => state.replaceAll('-', ' ');

const sourceFor = (diagnostic: Diagnostic): string =>
  diagnostic.sourcePath ?? diagnostic.generatedPath ?? diagnostic.target ?? 'Project';

const errorMessage = (reason: unknown): string => messageFrom(reason, 'Foreground project state could not be refreshed.');

const activeEpochFor = (status: ProjectStatus) =>
  status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;

const activeEpochId = (status: ProjectStatus): string | undefined => activeEpochFor(status)?.id;

/** The normalized model digest identifies the epoch's content for durable playground identity. */
const playgroundEpochFor = (status: ProjectStatus) => {
  const epoch = activeEpochFor(status);
  return epoch === undefined ? undefined : { digest: epoch.modelDigest, id: epoch.id };
};

const playgroundTargetsFor = (status: ProjectStatus) => {
  const epoch = activeEpochFor(status);
  return epoch === undefined
    ? []
    : Object.entries(epoch.targetDigests).map(([name, digest]) => ({ digest, name }));
};

const mcpTargets = ['portable', 'claude', 'codex'] as const;

const createMcpController = (authority: ForegroundSessionAuthority) => createMcpSessionController({
  routes: new McpRouteClient({ authority }),
});

const downloadMcpFile = ({ blob, filename }: McpDownload): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const StateMark = ({ state }: { readonly state: string }) => (
  <span aria-hidden="true" className={`state-mark state-mark--${state}`}>{
    state === 'active' || state === 'ready' || state === 'built' ? '✓'
      : state === 'stale' || state === 'invalid' || state === 'failed' ? '!'
        : '–'
  }</span>
);

type WorkbenchPage = 'artifacts' | 'comparisons' | 'evals' | 'hooks' | 'logs' | 'mcp' | 'overview' | 'playground' | 'skills';
type McpPresentation = 'inspector' | 'playground';

const navigationItems: readonly Readonly<{ glyph: string; label: string; page: WorkbenchPage }>[] = [
  { glyph: '⊞', label: 'Overview', page: 'overview' },
  { glyph: '⌘', label: 'Skills', page: 'skills' },
  { glyph: '⌥', label: 'Hooks', page: 'hooks' },
  { glyph: '⌁', label: 'MCP playground', page: 'mcp' },
  { glyph: '▤', label: 'Artifacts', page: 'artifacts' },
  { glyph: '◇', label: 'Playground', page: 'playground' },
  { glyph: '≡', label: 'Logs', page: 'logs' },
  { glyph: '✓', label: 'Evals', page: 'evals' },
  { glyph: '⇄', label: 'Comparisons', page: 'comparisons' },
];

const workbenchPages: ReadonlySet<string> = new Set(navigationItems.map((item) => item.page));

const pageForHash = (): WorkbenchPage => {
  const page = window.location.hash.slice(1);
  return workbenchPages.has(page) ? page as WorkbenchPage : 'overview';
};

const Navigation = ({ onNavigate, page }: {
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
}) => <nav className="rail" aria-label="Workbench navigation">
  <div className="brand">Agent Bundle</div>
  {navigationItems.map((item) => (
    <a
      key={item.page}
      aria-current={page === item.page ? 'page' : undefined}
      className={page === item.page ? 'nav-item nav-item--active' : 'nav-item'}
      href={`#${item.page}`}
      onClick={(event) => { event.preventDefault(); onNavigate(item.page); }}
    >
      <span aria-hidden="true" className="nav-glyph">{item.glyph}</span>
      {item.label}
    </a>
  ))}
</nav>;

const Overview = ({ changedFiles, client, connectionError, onNavigate, status, onStatus }: {
  readonly changedFiles: readonly string[];
  readonly client: ProjectClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onStatus: (status: ProjectStatus) => void;
  readonly status: ProjectStatus;
}) => {
  const overview = overviewFor(status, changedFiles);
  const [error, setError] = useState<string>();
  const [rebuilding, setRebuilding] = useState(false);

  const rebuild = async (): Promise<void> => {
    setError(undefined);
    setRebuilding(true);
    try {
      onStatus(await client.rebuild());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Rebuild request could not be completed.');
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="workbench-shell">
      <Navigation onNavigate={onNavigate} page="overview" />
      <main className="canvas" id="overview">
        <Topbar connectionError={connectionError} />
        <div className="page-content">
          <div className="page-heading">
            <h1>Project overview</h1>
          </div>

          <section aria-labelledby="normalization-heading" className="section">
            <h2 id="normalization-heading">Normalization summary</h2>
            <dl className="definition-row">
              <div><dt>Source state</dt><dd><StateMark state={overview.normalization.state} />{overview.normalization.label}</dd></div>
              <div><dt>Source revision</dt><dd className="identifier">{overview.normalization.revision ?? 'Not available'}</dd></div>
              <div><dt>Build state</dt><dd className="status-text">{stateLabel(status.build.state)}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="epoch-heading" className="section">
            <h2 id="epoch-heading">Artifact epoch</h2>
            <div className={`epoch-row epoch-row--${overview.epoch.state}`}>
              <div className="epoch-state"><StateMark state={overview.epoch.state} /><strong>{stateLabel(overview.epoch.state)}</strong></div>
              <div><span>State</span><strong>{overview.epoch.summary}</strong></div>
              <div><span>Epoch ID</span><strong className="identifier">{overview.epoch.id ?? 'None published'}</strong></div>
              <div><span>Published</span><strong>{dateTime(overview.epoch.createdAt)}</strong></div>
            </div>
          </section>

          <section aria-labelledby="targets-heading" className="section">
            <h2 id="targets-heading">Generated targets</h2>
            {overview.targets.length === 0 ? <p className="empty-row">No generated targets are available for this project state.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Target</th><th>Artifact state</th><th>Digest</th></tr></thead>
                <tbody>{overview.targets.map((target) => <tr key={target.name}>
                  <td><strong>{target.name}</strong></td>
                  <td><StateMark state={target.state} />{stateLabel(target.state)}</td>
                  <td className="identifier">{target.digest}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>

          <section aria-labelledby="diagnostics-heading" className="section">
            <h2 id="diagnostics-heading">Diagnostics ({overview.diagnostics.length})</h2>
            {overview.diagnostics.length === 0 ? <p className="empty-row">No source or latest-build diagnostics.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>Source</th></tr></thead>
                <tbody>{overview.diagnostics.map((diagnostic, index) => <tr key={`${diagnostic.code}-${index}`}>
                  <td><span className={`severity severity--${diagnostic.severity}`}>{diagnostic.severity}</span></td>
                  <td className="identifier">{diagnostic.code}</td>
                  <td>{diagnostic.message}</td>
                  <td className="identifier">{sourceFor(diagnostic)}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>

          <section aria-labelledby="changed-files-heading" className="section">
            <h2 id="changed-files-heading">Latest changed files ({overview.changedFiles.length})</h2>
            {overview.changedFiles.length === 0 ? <p className="empty-row">No source changes have been reported in this browser session.</p> : (
              <ul className="changed-file-list">
                {overview.changedFiles.map((path) => <li className="identifier" key={path}>{path}</li>)}
              </ul>
            )}
          </section>

          <section aria-labelledby="action-heading" className="next-action">
            <div><h2 id="action-heading">Next action</h2><p>{overview.nextAction.summary}</p></div>
            <button disabled={rebuilding} onClick={() => void rebuild()} type="button">
              {rebuilding ? 'Rebuilding…' : overview.nextAction.label}
            </button>
          </section>
          {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
        </div>
      </main>
    </div>
  );
};

const SkillsScreen = ({ connectionError, evalClient, onNavigate, skillClient, status }: {
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly skillClient: SkillClient;
  readonly status: ProjectStatus;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page="skills" />
  <main className="canvas" id="skills">
    <Topbar connectionError={connectionError} />
    <SkillsPage client={skillClient} evalClient={evalClient} status={status} />
  </main>
</div>;

const WorkbenchScreen = ({ children, connectionError, onNavigate, page }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page={page} />
  <main className="canvas" id={page}>
    <Topbar connectionError={connectionError} />
    {children}
  </main>
</div>;

const EvalsScreen = ({ connectionError, evalClient, onNavigate }: {
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="evals">
  <EvalsPage client={evalClient} />
</WorkbenchScreen>;

const ComparisonsScreen = ({ comparisonClient, connectionError, evalClient, onNavigate }: {
  readonly comparisonClient: ComparisonClient;
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="comparisons">
  <ComparisonsPage comparisonClient={comparisonClient} evalClient={evalClient} />
</WorkbenchScreen>;

const ArtifactsScreen = ({ artifactClient, connectionError, onNavigate, status }: {
  readonly artifactClient: ArtifactClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly status: ProjectStatus;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="artifacts">
  <ArtifactsPage client={artifactClient} epochId={activeEpochId(status)} />
</WorkbenchScreen>;

const PlaygroundScreen = ({ artifactClient, connectionError, onNavigate, onRunChange, playgroundClient, run, status }: {
  readonly artifactClient: ArtifactClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onRunChange: (run: PlaygroundRun | undefined) => void;
  readonly playgroundClient: PlaygroundClient;
  readonly run: PlaygroundRun | undefined;
  readonly status: ProjectStatus;
}) => {
  const epoch = activeEpochFor(status);
  const [nativeCatalog, setNativeCatalog] = useState<NativePlaygroundCatalog>();
  const [nativeCatalogError, setNativeCatalogError] = useState<string>();
  const [nativeCatalogLoading, setNativeCatalogLoading] = useState(false);
  const [scriptCatalog, setScriptCatalog] = useState<PlaygroundScriptCatalog>();
  const catalogLifecycle = useRef(createPlaygroundCatalogLifecycle());
  const catalogClient = useRef(playgroundClient);
  const clientReplaced = catalogClient.current !== playgroundClient;
  if (clientReplaced) {
    catalogClient.current = playgroundClient;
    catalogLifecycle.current.invalidate();
  }
  const visibleNativeCatalog = !clientReplaced && nativeCatalog?.epochId === epoch?.id ? nativeCatalog : undefined;
  const scripts = playgroundScriptsForEpoch(scriptCatalog, epoch?.id);

  useEffect(() => {
    const requestedEpochId = epoch?.id;
    const lease = catalogLifecycle.current.begin({ client: playgroundClient, epochId: requestedEpochId ?? '' });
    setNativeCatalog(undefined);
    setNativeCatalogError(undefined);
    setNativeCatalogLoading(requestedEpochId !== undefined);
    if (requestedEpochId === undefined) return () => lease.abort();
    void playgroundClient.catalog(requestedEpochId, lease.signal).then((catalog) => {
      if (lease.current() && catalog.epochId === requestedEpochId) setNativeCatalog(catalog);
    }).catch((reason: unknown) => {
      if (lease.current() && !(reason instanceof Error && reason.name === 'AbortError')) setNativeCatalogError(errorMessage(reason));
    }).finally(() => {
      if (lease.current()) setNativeCatalogLoading(false);
    });
    return () => lease.abort();
  }, [epoch?.id, playgroundClient]);

  useEffect(() => {
    if (clientReplaced) onRunChange(undefined);
  }, [clientReplaced, onRunChange, playgroundClient]);

  useEffect(() => {
    let current = true;
    if (epoch === undefined) {
      setScriptCatalog(undefined);
      return () => { current = false; };
    }
    setScriptCatalog({ epochId: epoch.id, scripts: [] });
    void artifactClient.inspect(epoch.id).then((inspection) => {
      if (current) setScriptCatalog({ epochId: epoch.id, scripts: inspection.runtime.scripts });
    }).catch(() => {
      if (current) setScriptCatalog({ epochId: epoch.id, scripts: [] });
    });
    return () => { current = false; };
  }, [artifactClient, epoch?.id]);

  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="playground">
    <PlaygroundPage
      catalog={visibleNativeCatalog}
      catalogError={nativeCatalogError}
      catalogLoading={nativeCatalogLoading || (epoch !== undefined && visibleNativeCatalog === undefined && nativeCatalogError === undefined)}
      client={playgroundClient}
      epoch={playgroundEpochFor(status)}
      onRunChange={onRunChange}
      run={run}
      scripts={scripts}
      targets={playgroundTargetsFor(status)}
    />
  </WorkbenchScreen>;
};

const LogsScreen = ({ connectionError, logClient, onNavigate }: {
  readonly connectionError?: string;
  readonly logClient: LogClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="logs">
  <LogsPage client={logClient} />
</WorkbenchScreen>;

const HooksScreen = ({ connectionError, hookClient, onNavigate, status }: {
  readonly connectionError?: string;
  readonly hookClient: HookClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly status: ProjectStatus;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="hooks">
  <HooksPage client={hookClient} epochId={activeEpochId(status)} />
</WorkbenchScreen>;

const McpScreen = ({ appPreviewClient, connectionError, controller, model, onNavigate, onResetSession, presentation, setPresentation, status }: {
  readonly appPreviewClient: McpAppClient;
  readonly connectionError?: string;
  readonly controller: ReturnType<typeof createMcpController>;
  readonly model: ReturnType<typeof createMcpController>['model'];
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onResetSession: () => void;
  readonly presentation: McpPresentation;
  readonly setPresentation: (presentation: McpPresentation) => void;
  readonly status: ProjectStatus;
}) => {
  const presentationTabs = useRef<Record<McpPresentation, HTMLButtonElement | null>>({ inspector: null, playground: null });
  const activeEpoch = status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;
  const targetOptions = mcpTargets.filter((target) => activeEpoch !== undefined && target in activeEpoch.targetDigests);
  const selectPresentation = (next: McpPresentation): void => {
    setPresentation(next);
    presentationTabs.current[next]?.focus();
  };
  const handlePresentationKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = event.key === 'Home' ? 'playground'
      : event.key === 'End' ? 'inspector'
        : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          ? presentation === 'playground' ? 'inspector' : 'playground'
          : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectPresentation(next);
  };
  const exportInspectorTrace = (entries: typeof model.timeline.entries): void => {
    downloadMcpFile(mcpProtocolTraceDownload({
      history: controller.history,
      model: { ...model, timeline: { ...model.timeline, entries } },
    }));
  };
  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="mcp">
    <div className="mcp-content">
      <div aria-label="MCP presentation" className="mcp-presentation-tabs" role="tablist">
        <button
          aria-controls="mcp-playground-presentation"
          aria-selected={presentation === 'playground'}
          className={presentation === 'playground' ? 'mcp-presentation-tab mcp-presentation-tab--active' : 'mcp-presentation-tab'}
          id="mcp-playground-tab"
          onClick={() => selectPresentation('playground')}
          onKeyDown={handlePresentationKeyDown}
          ref={(element) => { presentationTabs.current.playground = element; }}
          role="tab"
          tabIndex={presentation === 'playground' ? 0 : -1}
          type="button"
        >
          Playground
        </button>
        <button
          aria-controls="mcp-inspector-presentation"
          aria-selected={presentation === 'inspector'}
          className={presentation === 'inspector' ? 'mcp-presentation-tab mcp-presentation-tab--active' : 'mcp-presentation-tab'}
          id="mcp-inspector-tab"
          onClick={() => selectPresentation('inspector')}
          onKeyDown={handlePresentationKeyDown}
          ref={(element) => { presentationTabs.current.inspector = element; }}
          role="tab"
          tabIndex={presentation === 'inspector' ? 0 : -1}
          type="button"
        >
          Inspector
        </button>
      </div>
      <section
        aria-labelledby="mcp-playground-tab"
        hidden={presentation !== 'playground'}
        id="mcp-playground-presentation"
        inert={presentation !== 'playground'}
        role="tabpanel"
      >
        <McpPage
          appPreviewClient={appPreviewClient}
          controller={controller}
          epochOptions={activeEpoch === undefined ? [] : [activeEpoch.id]}
          initialBinding={activeEpoch === undefined ? undefined : { epochId: activeEpoch.id }}
          onDownloadConfig={downloadMcpFile}
          onDownloadTrace={downloadMcpFile}
          onResetSession={onResetSession}
          targetOptions={targetOptions}
        />
      </section>
      <section
        aria-labelledby="mcp-inspector-tab"
        className="inspector-content"
        hidden={presentation !== 'inspector'}
        id="mcp-inspector-presentation"
        inert={presentation !== 'inspector'}
        role="tabpanel"
      >
        <InspectorSessionAdapter controller={controller} model={model} onExportTrace={exportInspectorTrace} />
      </section>
    </div>
  </WorkbenchScreen>;
};

const Workbench = () => {
  const sessionAuthority = useRef<ForegroundSessionAuthority | undefined>(undefined);
  const client = useRef<ProjectClient | undefined>(undefined);
  const artifactClient = useRef<ArtifactClient | undefined>(undefined);
  const comparisonClient = useRef<ComparisonClient | undefined>(undefined);
  const evalClient = useRef<EvalClient | undefined>(undefined);
  const hookClient = useRef<HookClient | undefined>(undefined);
  const logClient = useRef<LogClient | undefined>(undefined);
  const playgroundClient = useRef<PlaygroundClient | undefined>(undefined);
  const mcpAppClient = useRef<McpAppClient | undefined>(undefined);
  const skillClient = useRef<SkillClient | undefined>(undefined);
  const foregroundGeneration = useRef<number | undefined>(undefined);
  const authority = sessionAuthority.current ?? (sessionAuthority.current = new ForegroundSessionAuthority());
  const [connection, setConnection] = useState<ProjectConnectionState>({ state: 'connecting' });
  const [connectionError, setConnectionError] = useState<string>();
  const [error, setError] = useState<string>();
  const [mcpController, setMcpController] = useState(() => createMcpController(authority));
  const [mcpModel, setMcpModel] = useState(() => mcpController.model);
  const [mcpPresentation, setMcpPresentation] = useState<McpPresentation>('playground');
  const [page, setPage] = useState<WorkbenchPage>(pageForHash);
  const [status, setStatus] = useState<ProjectStatus>();
  const [changedFiles, setChangedFiles] = useState<readonly string[]>([]);
  const [playgroundRun, setPlaygroundRun] = useState<PlaygroundRun>();

  if (artifactClient.current === undefined) artifactClient.current = new ArtifactClient({ authority });
  if (comparisonClient.current === undefined) comparisonClient.current = new ComparisonClient({ authority });
  if (evalClient.current === undefined) evalClient.current = new EvalClient({ authority });
  if (hookClient.current === undefined) hookClient.current = new HookClient({ authority });
  if (logClient.current === undefined) logClient.current = new LogClient({ authority });
  if (playgroundClient.current === undefined) playgroundClient.current = new PlaygroundClient({ authority });
  if (mcpAppClient.current === undefined) mcpAppClient.current = new McpAppClient({ authority });

  const navigate = (next: WorkbenchPage): void => {
    const hash = `#${next}`;
    if (window.location.hash !== hash) window.history.pushState(undefined, '', hash);
    if (next === 'mcp') setMcpPresentation('playground');
    setPage(next);
  };

  const resetMcpSession = (): void => {
    const replacement = createMcpController(authority);
    setMcpController(replacement);
    setMcpModel(replacement.model);
  };

  useEffect(() => {
    const next = new ProjectClient({ authority });
    const nextSkillClient = new SkillClient();
    let mounted = true;
    client.current = next;
    skillClient.current = nextSkillClient;
    const unsubscribeActivity = next.onActivity((activity) => {
      if (mounted) setChangedFiles(activity.changedFiles);
    });
    const unsubscribeConnection = next.onConnection((nextConnection) => {
      if (!mounted) return;
      const previousGeneration = foregroundGeneration.current;
      if (
        nextConnection.generation !== undefined && previousGeneration !== undefined &&
        previousGeneration !== nextConnection.generation
      ) {
        setChangedFiles([]);
        setPlaygroundRun(undefined);
        resetMcpSession();
      }
      if (nextConnection.generation !== undefined) foregroundGeneration.current = nextConnection.generation;
      setConnection(nextConnection);
      if (nextConnection.state === 'connected') setConnectionError(undefined);
    });
    void next.connect(
      (nextStatus) => {
        if (!mounted) return;
        setStatus(nextStatus);
      },
      (reason) => {
        if (mounted) setConnectionError(errorMessage(reason));
      },
    ).catch((reason: unknown) => {
      if (mounted) setError(errorMessage(reason));
    });
    return () => {
      mounted = false;
      unsubscribeActivity();
      unsubscribeConnection();
      next.close();
    };
  }, []);

  useEffect(() => {
    const updatePage = () => {
      setPage(pageForHash());
      if (window.location.hash === '#mcp') setMcpPresentation('playground');
    };
    updatePage();
    window.addEventListener('hashchange', updatePage);
    return () => window.removeEventListener('hashchange', updatePage);
  }, []);

  useEffect(() => () => { void mcpController.close().catch(() => undefined); }, [mcpController]);
  useEffect(() => mcpController.subscribe(setMcpModel), [mcpController]);

  if (connection.state !== 'connected') {
    const unavailable = connection.state === 'unavailable';
    return <main aria-live="polite" className="loading-state">
      <h1>{unavailable ? 'Foreground connection unavailable' : 'Foreground connection reconnecting'}</h1>
      <p>{unavailable ? 'Waiting for the foreground server to recover.' : 'Connecting to the foreground server.'}</p>
      {connectionError === undefined ? undefined : <p role="alert">{connectionError}</p>}
    </main>;
  }
  if (status !== undefined && client.current !== undefined && skillClient.current !== undefined) {
    if (page === 'mcp') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><McpScreen
        appPreviewClient={mcpAppClient.current}
        connectionError={connectionError}
        controller={mcpController}
        model={mcpModel}
        onNavigate={navigate}
        onResetSession={resetMcpSession}
        presentation={mcpPresentation}
        setPresentation={setMcpPresentation}
        status={status}
      /></Fragment>;
    }
    if (page === 'playground') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><PlaygroundScreen
        artifactClient={artifactClient.current}
        connectionError={connectionError}
        onNavigate={navigate}
        onRunChange={setPlaygroundRun}
        playgroundClient={playgroundClient.current}
        run={playgroundRun}
        status={status}
      /></Fragment>;
    }
    if (page === 'logs') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><LogsScreen
        connectionError={connectionError}
        logClient={logClient.current}
        onNavigate={navigate}
      /></Fragment>;
    }
    if (page === 'evals') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><EvalsScreen connectionError={connectionError} evalClient={evalClient.current} onNavigate={navigate} /></Fragment>;
    }
    if (page === 'comparisons') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><ComparisonsScreen
        comparisonClient={comparisonClient.current}
        connectionError={connectionError}
        evalClient={evalClient.current}
        onNavigate={navigate}
      /></Fragment>;
    }
    if (page === 'artifacts') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><ArtifactsScreen artifactClient={artifactClient.current} connectionError={connectionError} onNavigate={navigate} status={status} /></Fragment>;
    }
    if (page === 'hooks') {
      return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}><HooksScreen
        connectionError={connectionError}
        hookClient={hookClient.current}
        onNavigate={navigate}
        status={status}
      /></Fragment>;
    }
    return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}>{page === 'skills'
      ? <SkillsScreen connectionError={connectionError} evalClient={evalClient.current} onNavigate={navigate} skillClient={skillClient.current} status={status} />
      : <Overview changedFiles={changedFiles} client={client.current} connectionError={connectionError} onNavigate={navigate} onStatus={setStatus} status={status} />}</Fragment>;
  }
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{error === undefined ? undefined : <p role="alert">{error}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<Workbench />);
