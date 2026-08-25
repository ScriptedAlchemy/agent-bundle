import { errorMessage as messageFrom } from './client-helpers.ts';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { PlaygroundRun } from '../../agent-bundle/src/contracts/playground.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';

import { ArtifactClient } from './artifacts/artifact-client.ts';
import { ComparisonClient } from './comparisons/comparison-client.ts';
import { ComparisonsPage } from './comparisons/comparisons-page.tsx';
import { EvalClient } from './evals/eval-client.ts';
import { EvalsPage } from './evals/evals-page.tsx';
import { ArtifactsPage } from './artifacts/artifacts-page.tsx';
import { HookClient } from './hooks/hook-client.ts';
import { ForegroundSessionAuthority } from './foreground-session.ts';
import { HooksPage } from './hooks/hooks-page.tsx';
import { McpAppClient } from './mcp/mcp-app-client.ts';
import { LogClient } from './logs/log-client.ts';
import { LogsPage } from './logs/logs-page.tsx';
import { createMcpController, McpScreen, type McpPresentation } from './mcp-screen.tsx';
import { activeEpochFor } from './overview-model.ts';
import { Overview } from './overview-page.tsx';
import { PlaygroundClient } from './playground/playground-client.ts';
import { PlaygroundScreen } from './playground-screen.tsx';
import { ProjectClient, type ProjectConnectionState } from './project-client.ts';
import { SkillClient } from './skill-client.ts';
import { SkillsPage } from './skills-page.tsx';
import {
  generalWorkbenchPages,
  loadWorkbenchCapabilities,
  type WorkbenchCapabilities,
} from './workbench-capabilities.ts';
import { Navigation, pageForHash, Topbar, WorkbenchScreen, type WorkbenchPage } from './workbench-screen.tsx';
import './styles.css';

const errorMessage = (reason: unknown): string => messageFrom(reason, 'Foreground project state could not be refreshed.');

const activeEpochId = (status: ProjectStatus): string | undefined => activeEpochFor(status)?.id;

const SkillsScreen = ({ connectionError, evalClient, onNavigate, pages, skillClient, status }: {
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly skillClient: SkillClient;
  readonly status: ProjectStatus;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page="skills" pages={pages} />
  <main className="canvas" id="skills">
    <Topbar connectionError={connectionError} />
    <SkillsPage client={skillClient} evalClient={evalClient} status={status} />
  </main>
</div>;

type CapabilityState =
  | Readonly<{ readonly state: 'empty' }>
  | Readonly<{ readonly buildId: string; readonly state: 'loading' }>
  | Readonly<{ readonly buildId: string; readonly message: string; readonly state: 'error' }>
  | Readonly<{ readonly state: 'ready'; readonly value: WorkbenchCapabilities }>;

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
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [capabilityState, setCapabilityState] = useState<CapabilityState>({ state: 'empty' });
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
  if (skillClient.current === undefined) skillClient.current = new SkillClient();

  const buildId = status === undefined ? undefined : activeEpochId(status);
  const capabilities = capabilityState.state === 'ready' && capabilityState.value.buildId === buildId
    ? capabilityState.value
    : undefined;
  const pages = capabilities?.pages ?? generalWorkbenchPages;
  const routesReady = status !== undefined && (buildId === undefined || capabilities !== undefined);

  const navigate = (next: WorkbenchPage): void => {
    const available = pages.has(next) ? next : 'overview';
    const hash = `#${available}`;
    if (window.location.hash !== hash) window.history.pushState(undefined, '', hash);
    if (available === 'mcp') setMcpPresentation('playground');
    setPage(available);
  };

  const resetMcpSession = (): void => {
    const replacement = createMcpController(authority);
    setMcpController(replacement);
    setMcpModel(replacement.model);
  };

  useEffect(() => {
    const next = new ProjectClient({ authority });
    let mounted = true;
    client.current = next;
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
    const controller = new AbortController();
    if (buildId === undefined) {
      setCapabilityState({ state: 'empty' });
      return () => controller.abort();
    }
    setCapabilityState((current) => current.state === 'ready' && current.value.buildId === buildId
      ? current
      : { buildId, state: 'loading' });
    void loadWorkbenchCapabilities({
      artifactClient: artifactClient.current!,
      buildId,
      evalClient: evalClient.current!,
      signal: controller.signal,
      skillClient: skillClient.current!,
    }).then(
      (value) => { if (!controller.signal.aborted) setCapabilityState({ state: 'ready', value }); },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setCapabilityState({
          buildId,
          message: messageFrom(reason, 'Bundle capabilities could not be loaded.'),
          state: 'error',
        });
      },
    );
    return () => controller.abort();
  }, [buildId, capabilityRetry]);

  useEffect(() => {
    if (!routesReady) return undefined;
    const updatePage = () => {
      const next = pageForHash(window.location.hash, pages);
      if (`#${next}` !== window.location.hash) window.history.replaceState(undefined, '', `#${next}`);
      setPage(next);
      if (next === 'mcp') setMcpPresentation('playground');
    };
    updatePage();
    window.addEventListener('hashchange', updatePage);
    return () => window.removeEventListener('hashchange', updatePage);
  }, [pages, routesReady]);

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
  if (status !== undefined && buildId !== undefined && capabilities === undefined) {
    if (capabilityState.state === 'error' && capabilityState.buildId === buildId) {
      return <main aria-live="polite" className="loading-state">
        <h1>Bundle capabilities unavailable</h1>
        <p role="alert">{capabilityState.message}</p>
        <button onClick={() => setCapabilityRetry((current) => current + 1)} type="button">Retry</button>
      </main>;
    }
    return <main aria-live="polite" className="loading-state"><strong>Loading bundle capabilities…</strong></main>;
  }
  if (status !== undefined && client.current !== undefined && skillClient.current !== undefined) {
    let screen: ReactNode;
    switch (page) {
      case 'mcp':
        screen = <McpScreen
          appPreviewClient={mcpAppClient.current}
          artifactClient={artifactClient.current}
          connectionError={connectionError}
          controller={mcpController}
          model={mcpModel}
          onNavigate={navigate}
          onResetSession={resetMcpSession}
          pages={pages}
          presentation={mcpPresentation}
          setPresentation={setMcpPresentation}
          status={status}
        />;
        break;
      case 'playground':
        screen = <PlaygroundScreen
          connectionError={connectionError}
          inspection={capabilities!.inspection}
          onNavigate={navigate}
          onRunChange={setPlaygroundRun}
          pages={pages}
          playgroundClient={playgroundClient.current}
          run={playgroundRun}
          skillTree={capabilities!.skillTree}
          status={status}
        />;
        break;
      case 'logs':
        screen = <WorkbenchScreen connectionError={connectionError} onNavigate={navigate} page="logs" pages={pages}>
          <LogsPage client={logClient.current} />
        </WorkbenchScreen>;
        break;
      case 'evals':
        screen = <WorkbenchScreen connectionError={connectionError} onNavigate={navigate} page="evals" pages={pages}>
          <EvalsPage client={evalClient.current} />
        </WorkbenchScreen>;
        break;
      case 'comparisons':
        screen = <WorkbenchScreen connectionError={connectionError} onNavigate={navigate} page="comparisons" pages={pages}>
          <ComparisonsPage comparisonClient={comparisonClient.current} evalClient={evalClient.current} />
        </WorkbenchScreen>;
        break;
      case 'artifacts':
        screen = <WorkbenchScreen connectionError={connectionError} onNavigate={navigate} page="artifacts" pages={pages}>
          <ArtifactsPage client={artifactClient.current} epochId={activeEpochId(status)} />
        </WorkbenchScreen>;
        break;
      case 'hooks':
        screen = <WorkbenchScreen connectionError={connectionError} onNavigate={navigate} page="hooks" pages={pages}>
          <HooksPage client={hookClient.current} epochId={activeEpochId(status)} />
        </WorkbenchScreen>;
        break;
      case 'skills':
        screen = <SkillsScreen connectionError={connectionError} evalClient={evalClient.current} onNavigate={navigate} pages={pages} skillClient={skillClient.current} status={status} />;
        break;
      case 'overview':
        screen = <Overview capabilities={capabilities} changedFiles={changedFiles} client={client.current} connectionError={connectionError} onNavigate={navigate} onStatus={setStatus} pages={pages} status={status} />;
        break;
      default: {
        const unhandled: never = page;
        screen = unhandled;
      }
    }
    return <Fragment key={`foreground-${connection.generation ?? 'unknown'}`}>{screen}</Fragment>;
  }
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{error === undefined ? undefined : <p role="alert">{error}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<Workbench />);
