import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';

import { InspectorSessionAdapter } from './inspector/adapter/inspector-session-adapter-entry.ts';
import { McpAppClient } from './mcp/mcp-app-client.ts';
import { McpPage, type McpConfigDownload } from './mcp/mcp-page.tsx';
import { McpRouteClient } from './mcp/mcp-route-client.ts';
import { createMcpSessionController } from './mcp/mcp-session-controller.ts';
import { overviewFor } from './overview-model.ts';
import { ProjectClient } from './project-client.ts';
import { SkillClient } from './skill-client.ts';
import { SkillsPage } from './skills-page.tsx';
import './styles.css';

const dateTime = (value: string | undefined): string => value === undefined
  ? 'Not available'
  : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(value));

const stateLabel = (state: string): string => state.replaceAll('-', ' ');

const sourceFor = (diagnostic: Diagnostic): string =>
  diagnostic.sourcePath ?? diagnostic.generatedPath ?? diagnostic.target ?? 'Project';

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'Foreground project state could not be refreshed.';

const mcpTargets = ['portable', 'claude', 'codex'] as const;

const createMcpController = () => createMcpSessionController({ routes: new McpRouteClient() });

const downloadMcpConfig = ({ blob, filename }: McpConfigDownload): void => {
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

type WorkbenchPage = 'mcp' | 'overview' | 'skills';
type McpPresentation = 'inspector' | 'playground';

const pageForHash = (): WorkbenchPage => {
  if (window.location.hash === '#mcp' || window.location.hash === '#inspector') return 'mcp';
  return window.location.hash === '#skills' ? 'skills' : 'overview';
};

const mcpPresentationForHash = (): McpPresentation => window.location.hash === '#inspector' ? 'inspector' : 'playground';

const Navigation = ({ onNavigate, page }: {
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
}) => <aside className="rail" aria-label="Workbench navigation">
  <div className="brand">Agent Bundle</div>
  <a
    aria-current={page === 'overview' ? 'page' : undefined}
    className={page === 'overview' ? 'nav-item nav-item--active' : 'nav-item'}
    href="#overview"
    onClick={(event) => { event.preventDefault(); onNavigate('overview'); }}
  >
    <span aria-hidden="true" className="nav-glyph">⊞</span>
    Overview
  </a>
  <a
    aria-current={page === 'skills' ? 'page' : undefined}
    className={page === 'skills' ? 'nav-item nav-item--active' : 'nav-item'}
    href="#skills"
    onClick={(event) => { event.preventDefault(); onNavigate('skills'); }}
  >
    <span aria-hidden="true" className="nav-glyph">⌘</span>
    Skills
  </a>
  <a
    aria-current={page === 'mcp' ? 'page' : undefined}
    className={page === 'mcp' ? 'nav-item nav-item--active' : 'nav-item'}
    href="#mcp"
    onClick={(event) => { event.preventDefault(); onNavigate('mcp'); }}
  >
    <span aria-hidden="true" className="nav-glyph">⌁</span>
    MCP playground
  </a>
</aside>;

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
        <header className="topbar">
          <span className="menu-glyph" aria-hidden="true">☰</span>
          <span className="topbar-title">Project workbench</span>
          <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
            <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
          </span>
        </header>
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

const SkillsScreen = ({ connectionError, onNavigate, skillClient, status }: {
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly skillClient: SkillClient;
  readonly status: ProjectStatus;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page="skills" />
  <main className="canvas" id="skills">
    <header className="topbar">
      <span className="menu-glyph" aria-hidden="true">☰</span>
      <span className="topbar-title">Project workbench</span>
      <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
        <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
      </span>
    </header>
    <SkillsPage client={skillClient} status={status} />
  </main>
</div>;

const WorkbenchScreen = ({ children, connectionError, onNavigate, page }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page={page} />
  <div className="canvas" id={page}>
    <header className="topbar">
      <span className="menu-glyph" aria-hidden="true">☰</span>
      <span className="topbar-title">Project workbench</span>
      <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
        <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
      </span>
    </header>
    {children}
  </div>
</div>;

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
          onDownloadConfig={downloadMcpConfig}
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
        <InspectorSessionAdapter controller={controller} model={model} />
      </section>
    </div>
  </WorkbenchScreen>;
};

const Workbench = () => {
  const client = useRef<ProjectClient>();
  const mcpAppClient = useRef<McpAppClient>();
  const skillClient = useRef<SkillClient>();
  const [connectionError, setConnectionError] = useState<string>();
  const [error, setError] = useState<string>();
  const [mcpController, setMcpController] = useState(createMcpController);
  const [mcpModel, setMcpModel] = useState(() => mcpController.model);
  const [mcpPresentation, setMcpPresentation] = useState(mcpPresentationForHash);
  const [page, setPage] = useState<WorkbenchPage>(pageForHash);
  const [status, setStatus] = useState<ProjectStatus>();
  const [changedFiles, setChangedFiles] = useState<readonly string[]>([]);

  if (mcpAppClient.current === undefined) mcpAppClient.current = new McpAppClient();

  const navigate = (next: WorkbenchPage): void => {
    const hash = next === 'mcp' ? '#mcp' : next === 'skills' ? '#skills' : '#overview';
    if (window.location.hash !== hash) window.history.pushState(undefined, '', hash);
    if (next === 'mcp') setMcpPresentation('playground');
    setPage(next);
  };

  const resetMcpSession = (): void => {
    const replacement = createMcpController();
    setMcpController(replacement);
    setMcpModel(replacement.model);
  };

  useEffect(() => {
    const next = new ProjectClient();
    const nextSkillClient = new SkillClient();
    let mounted = true;
    client.current = next;
    skillClient.current = nextSkillClient;
    const unsubscribeActivity = next.onActivity((activity) => {
      if (mounted) setChangedFiles(activity.changedFiles);
    });
    void next.connect(
      (nextStatus) => {
        if (!mounted) return;
        setConnectionError(undefined);
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
      next.close();
    };
  }, []);

  useEffect(() => {
    const updatePage = () => {
      if (window.location.hash === '#inspector') {
        window.history.replaceState(undefined, '', '#mcp');
        setMcpPresentation('inspector');
        setPage('mcp');
        return;
      }
      setPage(pageForHash());
      if (window.location.hash === '#mcp') setMcpPresentation('playground');
    };
    updatePage();
    window.addEventListener('hashchange', updatePage);
    return () => window.removeEventListener('hashchange', updatePage);
  }, []);

  useEffect(() => () => { void mcpController.close().catch(() => undefined); }, [mcpController]);
  useEffect(() => mcpController.subscribe(setMcpModel), [mcpController]);

  if (status !== undefined && client.current !== undefined && skillClient.current !== undefined) {
    if (page === 'mcp') {
      return <McpScreen
        appPreviewClient={mcpAppClient.current}
        connectionError={connectionError}
        controller={mcpController}
        model={mcpModel}
        onNavigate={navigate}
        onResetSession={resetMcpSession}
        presentation={mcpPresentation}
        setPresentation={setMcpPresentation}
        status={status}
      />;
    }
    return page === 'skills'
      ? <SkillsScreen connectionError={connectionError} onNavigate={navigate} skillClient={skillClient.current} status={status} />
      : <Overview changedFiles={changedFiles} client={client.current} connectionError={connectionError} onNavigate={navigate} onStatus={setStatus} status={status} />;
  }
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{error === undefined ? undefined : <p role="alert">{error}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<Workbench />);
