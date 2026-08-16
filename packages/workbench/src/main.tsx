import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';

import { InspectorSessionAdapter } from './inspector/adapter/inspector-session-adapter-entry.ts';
import { McpAppClient } from './mcp/mcp-app-client.ts';
import { McpPage, type McpConfigDownload } from './mcp/mcp-page.tsx';
import { ForegroundRouteClient, McpRouteClient } from './mcp/mcp-route-client.ts';
import { createMcpSessionController } from './mcp/mcp-session-controller.ts';
import { overviewFor } from './overview-model.ts';
import { ProjectClient } from './project-client.ts';
import { SkillClient } from './skill-client.ts';
import { SkillsPage } from './skills-page.tsx';
import { RuntimeClient, type RuntimeBootstrap } from './runtime-client.ts';
import {
  createRuntimeEventBuffer,
  createRuntimePlaygroundController,
  runtimeBootstrapRetryPlan,
  RuntimePlayground,
  type RuntimePlaygroundController,
} from './runtime-playground.tsx';
import type { RuntimeProfileOption } from './runtime-model.ts';
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

const runtimeProfiles = [{
  claimsRealHostParity: false,
  evidence: 'simulated',
  id: 'portable',
  label: 'Portable MCP Apps',
  version: 'agent-bundle:mcp-apps:2026-01-26',
}] satisfies readonly RuntimeProfileOption[];

/** The Workbench, rather than an individual MCP transport, owns this shared foreground credential. */
class WorkbenchMcpRouteClient extends McpRouteClient {
  override forgetAuthentication(): void {}
}

const createMcpController = (foreground: ForegroundRouteClient) => createMcpSessionController({
  routes: new WorkbenchMcpRouteClient({ foreground }),
});

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

type WorkbenchPage = 'inspector' | 'mcp' | 'overview' | 'runtime' | 'skills';
type RuntimeCapability = 'available' | 'unavailable' | 'unknown';

const pageForHash = (runtimeAvailable = false): WorkbenchPage => {
  if (window.location.hash === '#mcp') return 'mcp';
  if (window.location.hash === '#inspector') return 'inspector';
  if (window.location.hash === '#runtime' && runtimeAvailable) return 'runtime';
  return window.location.hash === '#skills' ? 'skills' : 'overview';
};

const Navigation = ({ onNavigate, page, runtimeAvailable = false, runtimeDiagnostic }: {
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
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
  <a
    aria-current={page === 'inspector' ? 'page' : undefined}
    className={page === 'inspector' ? 'nav-item nav-item--active' : 'nav-item'}
    href="#inspector"
    onClick={(event) => { event.preventDefault(); onNavigate('inspector'); }}
  >
    <span aria-hidden="true" className="nav-glyph">⌕</span>
    Inspector
  </a>
  {runtimeAvailable ? <a
    aria-current={page === 'runtime' ? 'page' : undefined}
    className={page === 'runtime' ? 'nav-item nav-item--active' : 'nav-item'}
    href="#runtime"
    onClick={(event) => { event.preventDefault(); onNavigate('runtime'); }}
  >
    <span aria-hidden="true" className="nav-glyph">◫</span>
    Runtime
  </a> : undefined}
  {runtimeDiagnostic === undefined ? undefined : <p className="runtime-capability-error" role="status">Runtime capability issue: {runtimeDiagnostic}</p>}
</aside>;

const Overview = ({ changedFiles, client, connectionError, onNavigate, runtimeAvailable = false, runtimeDiagnostic, status, onStatus }: {
  readonly changedFiles: readonly string[];
  readonly client: ProjectClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onStatus: (status: ProjectStatus) => void;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
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
      <Navigation onNavigate={onNavigate} page="overview" runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeDiagnostic} />
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

const SkillsScreen = ({ connectionError, onNavigate, runtimeAvailable = false, runtimeDiagnostic, skillClient, status }: {
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
  readonly skillClient: SkillClient;
  readonly status: ProjectStatus;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page="skills" runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeDiagnostic} />
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

const WorkbenchScreen = ({ children, connectionError, onNavigate, page, runtimeAvailable = false, runtimeDiagnostic }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page={page} runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeDiagnostic} />
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

const McpScreen = ({ appPreviewClient, connectionError, controller, onNavigate, onResetSession, runtimeAvailable = false, runtimeDiagnostic, status }: {
  readonly appPreviewClient: McpAppClient;
  readonly connectionError?: string;
  readonly controller: ReturnType<typeof createMcpController>;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onResetSession: () => void;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
  readonly status: ProjectStatus;
}) => {
  const activeEpoch = status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;
  const targetOptions = mcpTargets.filter((target) => activeEpoch !== undefined && target in activeEpoch.targetDigests);
  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="mcp" runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeDiagnostic}>
    <div className="mcp-content">
      <McpPage
        appPreviewClient={appPreviewClient}
        controller={controller}
        epochOptions={activeEpoch === undefined ? [] : [activeEpoch.id]}
        initialBinding={activeEpoch === undefined ? undefined : { epochId: activeEpoch.id }}
        onDownloadConfig={downloadMcpConfig}
        onResetSession={onResetSession}
        targetOptions={targetOptions}
      />
    </div>
  </WorkbenchScreen>;
};

const InspectorScreen = ({ connectionError, controller, model, onNavigate, runtimeAvailable = false, runtimeDiagnostic }: {
  readonly connectionError?: string;
  readonly controller: ReturnType<typeof createMcpController>;
  readonly model: ReturnType<typeof createMcpController>['model'];
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="inspector" runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeDiagnostic}>
  <div className="inspector-content">
    <InspectorSessionAdapter controller={controller} model={model} />
  </div>
</WorkbenchScreen>;

const RuntimeScreen = ({ connectionError, controller, onNavigate, runtimeDiagnostic }: {
  readonly connectionError?: string;
  readonly controller: RuntimePlaygroundController;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly runtimeDiagnostic?: string;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="runtime" runtimeAvailable runtimeDiagnostic={runtimeDiagnostic}>
  <div className="runtime-content"><RuntimePlayground controller={controller} /></div>
</WorkbenchScreen>;

const Workbench = () => {
  const client = useRef<ProjectClient>();
  const foreground = useRef<ForegroundRouteClient>();
  const mcpAppClient = useRef<McpAppClient>();
  const runtimeClient = useRef<RuntimeClient>();
  const runtimeController = useRef<RuntimePlaygroundController>();
  const skillClient = useRef<SkillClient>();
  const [connectionError, setConnectionError] = useState<string>();
  const [error, setError] = useState<string>();
  if (foreground.current === undefined) foreground.current = new ForegroundRouteClient();

  const [mcpController, setMcpController] = useState(() => createMcpController(foreground.current!));
  const [mcpModel, setMcpModel] = useState(() => mcpController.model);
  const [page, setPage] = useState<WorkbenchPage>(() => pageForHash(false));
  const [runtimeCapability, setRuntimeCapability] = useState<RuntimeCapability>('unknown');
  const [runtimeControllerState, setRuntimeControllerState] = useState<RuntimePlaygroundController>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [status, setStatus] = useState<ProjectStatus>();
  const [changedFiles, setChangedFiles] = useState<readonly string[]>([]);

  if (mcpAppClient.current === undefined) mcpAppClient.current = new McpAppClient();
  if (runtimeClient.current === undefined) runtimeClient.current = new RuntimeClient(foreground.current);

  const runtimeAvailable = runtimeCapability === 'available';

  const navigate = (next: WorkbenchPage): void => {
    const hash = next === 'mcp' ? '#mcp' : next === 'inspector' ? '#inspector' : next === 'runtime' ? '#runtime' : next === 'skills' ? '#skills' : '#overview';
    if (window.location.hash !== hash) window.history.pushState(undefined, '', hash);
    setPage(next);
  };

  const resetMcpSession = (): void => {
    const replacement = createMcpController(foreground.current!);
    setMcpController(replacement);
    setMcpModel(replacement.model);
  };

  useEffect(() => {
    const next = new ProjectClient({ foreground: foreground.current! });
    const nextSkillClient = new SkillClient();
    const nextRuntimeClient = runtimeClient.current!;
    const runtimeEvents = createRuntimeEventBuffer();
    let mounted = true;
    let runtimeRetry: ReturnType<typeof setTimeout> | undefined;
    let runtimeRetryCount = 0;
    client.current = next;
    skillClient.current = nextSkillClient;
    const unsubscribeActivity = next.onActivity((activity) => {
      if (mounted) setChangedFiles(activity.changedFiles);
    });
    const resolveRuntimeCapability = (bootstrap: RuntimeBootstrap): void => {
      if (!mounted) return;
      if (bootstrap.kind === 'unavailable') {
        runtimeEvents.close();
        runtimeRetryCount = 0;
        setRuntimeError(undefined);
        setRuntimeCapability('unavailable');
        if (window.location.hash === '#runtime') {
          window.history.replaceState(undefined, '', '#overview');
          setPage('overview');
        }
        return;
      }
      const controller = runtimeController.current;
      if (controller === undefined) {
        const nextController = createRuntimePlaygroundController({ bootstrap, client: nextRuntimeClient, profiles: runtimeProfiles });
        runtimeController.current = nextController;
        runtimeEvents.install(nextController);
        setRuntimeControllerState(nextController);
      } else {
        controller.dispatch({ bootstrap, type: 'bootstrap.received' });
      }
      setRuntimeCapability('available');
      setRuntimeError(undefined);
      if (window.location.hash === '#runtime') setPage('runtime');
      if (bootstrap.status.activeVector === undefined && bootstrap.status.state !== 'failed' && bootstrap.status.state !== 'closed') {
        scheduleRuntimeBootstrap();
      } else {
        runtimeRetryCount = 0;
      }
    };
    const scheduleRuntimeBootstrap = (): void => {
      if (!mounted || runtimeRetry !== undefined) return;
      const retry = runtimeBootstrapRetryPlan(runtimeRetryCount, runtimeController.current !== undefined);
      runtimeRetryCount = retry.retryCount;
      if (retry.closePreControllerIngress) runtimeEvents.close();
      if (retry.delay === undefined) return;
      runtimeRetry = setTimeout(() => {
        runtimeRetry = undefined;
        bootstrapRuntime();
      }, retry.delay);
    };
    const bootstrapRuntime = (): void => {
      void nextRuntimeClient.bootstrap().then(resolveRuntimeCapability).catch((reason: unknown) => {
        if (!mounted) return;
        setRuntimeError(errorMessage(reason));
        scheduleRuntimeBootstrap();
      });
    };
    void next.connect(
      (nextStatus) => {
        if (!mounted) return;
        setConnectionError(undefined);
        setStatus(nextStatus);
      },
      (reason) => {
        if (mounted) setConnectionError(errorMessage(reason));
      },
      (event) => { runtimeEvents.receive(event); },
    ).catch((reason: unknown) => {
      if (mounted) setError(errorMessage(reason));
    });
    bootstrapRuntime();
    return () => {
      mounted = false;
      if (runtimeRetry !== undefined) clearTimeout(runtimeRetry);
      runtimeEvents.close();
      unsubscribeActivity();
      next.close();
      runtimeController.current?.close();
      runtimeController.current = undefined;
    };
  }, []);

  useEffect(() => {
    const updatePage = () => {
      if (window.location.hash === '#runtime' && !runtimeAvailable) {
        if (runtimeCapability === 'unavailable') window.history.replaceState(undefined, '', '#overview');
        setPage('overview');
        return;
      }
      setPage(pageForHash(runtimeAvailable));
    };
    window.addEventListener('hashchange', updatePage);
    return () => window.removeEventListener('hashchange', updatePage);
  }, [runtimeAvailable, runtimeCapability]);

  useEffect(() => () => { void mcpController.close().catch(() => undefined); }, [mcpController]);
  useEffect(() => mcpController.subscribe(setMcpModel), [mcpController]);

  if (status !== undefined && client.current !== undefined && skillClient.current !== undefined) {
    if (page === 'mcp') {
      return <McpScreen
        appPreviewClient={mcpAppClient.current}
        connectionError={connectionError}
        controller={mcpController}
        onNavigate={navigate}
        onResetSession={resetMcpSession}
        runtimeAvailable={runtimeAvailable}
        runtimeDiagnostic={runtimeError}
        status={status}
      />;
    }
    if (page === 'inspector') {
      return <InspectorScreen connectionError={connectionError} controller={mcpController} model={mcpModel} onNavigate={navigate} runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeError} />;
    }
    if (page === 'runtime' && runtimeControllerState !== undefined) {
      return <RuntimeScreen connectionError={connectionError} controller={runtimeControllerState} onNavigate={navigate} runtimeDiagnostic={runtimeError} />;
    }
    return page === 'skills'
      ? <SkillsScreen connectionError={connectionError} onNavigate={navigate} runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeError} skillClient={skillClient.current} status={status} />
      : <Overview changedFiles={changedFiles} client={client.current} connectionError={connectionError} onNavigate={navigate} onStatus={setStatus} runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeError} status={status} />;
  }
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{error === undefined ? undefined : <p role="alert">{error}</p>}{runtimeError === undefined ? undefined : <p className="runtime-capability-error">Runtime capability issue: {runtimeError}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<Workbench />);
