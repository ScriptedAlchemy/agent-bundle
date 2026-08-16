import { type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import { MCP_APP_PROFILE_DESCRIPTORS, type McpAppProfileId } from '../../agent-bundle/src/dev/mcp-app-profile-descriptors.ts';
import type { McpAppPreviewAppsSnapshot } from '../../agent-bundle/src/dev/mcp-app-runtime-preview-service.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';

import { InspectorSessionAdapter } from './inspector/adapter/inspector-session-adapter-entry.ts';
import { createRuntimeAppBridgeFactory, type RuntimeAppBridgeFactory } from './inspector/adapter/runtime-app-bridge.ts';
import { McpAppClient, type McpAppConsentChallenge } from './mcp/mcp-app-client.ts';
import { McpAppPreview } from './mcp/mcp-app-preview.tsx';
import { McpPage, type McpConfigDownload, type McpPagePreviewSelection, type McpPageRuntimePreviewDependencies } from './mcp/mcp-page.tsx';
import { ForegroundRouteClient, McpRouteClient } from './mcp/mcp-route-client.ts';
import { createMcpSessionController } from './mcp/mcp-session-controller.ts';
import {
  McpPreviewDepartureCoordinator,
  prepareRuntimeMcpHandoffAuthority,
  RuntimeMcpHandoffCoordinator,
  sameRuntimeMcpAppBinding,
  type RuntimeHandoffAuthority,
  type RuntimeMcpHandoff,
} from './mcp/runtime-mcp-handoff.ts';
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
import type { RuntimeAppPreviewRenderer, RuntimeLiveMcpPageAdapter } from './runtime-stage.tsx';
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

const runtimeProfiles = Object.values(MCP_APP_PROFILE_DESCRIPTORS) satisfies readonly RuntimeProfileOption[];
const runtimeProfileIds = Object.freeze(Object.keys(MCP_APP_PROFILE_DESCRIPTORS) as McpAppProfileId[]);

interface RuntimeHandoffHost {
  canOpen(authority: RuntimeHandoffAuthority): boolean;
  open(authority: RuntimeHandoffAuthority): void;
  subscribe(listener: () => void): () => void;
}

const runtimeProfileId = (value: string): value is typeof runtimeProfileIds[number] =>
  runtimeProfileIds.includes(value as typeof runtimeProfileIds[number]);

/** The Workbench, rather than an individual MCP transport, owns this shared foreground credential. */
class WorkbenchMcpRouteClient extends McpRouteClient {
  override forgetAuthentication(): void {}
}

const createMcpController = (routes: WorkbenchMcpRouteClient) => createMcpSessionController({
  routes,
});

type WorkbenchMcpController = ReturnType<typeof createMcpController>;

const controllerMatchesRuntimePreview = (controller: WorkbenchMcpController, preview: McpAppPreviewAppsSnapshot): boolean => {
  const binding = controller.model.binding;
  return controller.model.phase === 'ready' && binding?.kind === 'runtime' && sameRuntimeMcpAppBinding(binding.binding, preview.session.binding);
};

/** The stable host callback admits only the existing controller's route-free runtime binding. */
const createWorkbenchRuntimeBridgeFactory = (
  appClient: McpAppClient,
  controllerRef: MutableRefObject<WorkbenchMcpController>,
  onTrace: (bindingId: string, entry: unknown) => void,
  requestConsent: (challenge: McpAppConsentChallenge) => Promise<'allow-once' | 'deny'>,
): ((preview: McpAppPreviewAppsSnapshot) => RuntimeAppBridgeFactory) => (preview) => {
  const controller = controllerRef.current;
  let admission: Promise<void> | undefined;
  let inner: RuntimeAppBridgeFactory | undefined;
  let setup: Promise<Awaited<ReturnType<RuntimeAppBridgeFactory>>> | undefined;
  let close: Promise<void> | undefined;
  let closed = false;
  const admit = (): Promise<void> => {
    if (admission !== undefined) return admission;
    admission = Promise.resolve().then(async () => {
      if (controllerRef.current !== controller) throw new Error('Runtime MCP controller changed before App admission.');
      if (controller.model.phase === 'idle') {
        await controller.open(Object.freeze({
          binding: preview.session.binding,
          kind: 'runtime' as const,
          session: preview.session,
        }));
      } else if (!controllerMatchesRuntimePreview(controller, preview)) {
        throw new Error('MCP controller is not ready for this exact runtime App session.');
      }
      if (controllerRef.current !== controller || !controllerMatchesRuntimePreview(controller, preview)) {
        throw new Error('Runtime MCP controller admission became stale.');
      }
    });
    return admission;
  };
  const factory = ((iframe: Parameters<RuntimeAppBridgeFactory>[0], tool: Parameters<RuntimeAppBridgeFactory>[1]) => {
    if (closed) return Promise.reject(new Error('Runtime MCP App bridge factory is closed.'));
    if (setup !== undefined) return setup;
    setup = admit().then(() => {
      if (closed) throw new Error('Runtime MCP App bridge factory is closed.');
      inner ??= createRuntimeAppBridgeFactory({
        client: appClient,
        controller,
        installedHandlers: Object.freeze({}),
        listChanged: Object.freeze({ resources: false, tools: false }),
        onTrace: (entry) => { onTrace(preview.binding.id, entry); },
        preview,
        requestConsent,
        simulationFeatures: Object.freeze({ chatGptWidgetState: 'disabled' as const }),
      });
      return inner(iframe, tool);
    });
    return setup;
  }) as RuntimeAppBridgeFactory;
  Object.defineProperty(factory, 'close', {
    configurable: false,
    value: (): Promise<void> => {
      if (close !== undefined) return close;
      closed = true;
      const pending = setup ?? admission;
      close = (pending === undefined ? Promise.resolve() : pending.catch(() => undefined))
        .then(() => inner?.close());
      return close;
    },
    writable: false,
  });
  return factory;
};

const RuntimeMcpHandoffButton = ({ authority, host }: { readonly authority: RuntimeHandoffAuthority; readonly host: RuntimeHandoffHost }) => {
  const [, render] = useState(0);
  useEffect(() => host.subscribe(() => { render((version) => version + 1); }), [host]);
  return <button disabled={!host.canOpen(authority)} onClick={() => { host.open(authority); }} type="button">Open in MCP playground</button>;
};

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

type WorkbenchPage = 'mcp' | 'overview' | 'runtime' | 'skills';
type RuntimeCapability = 'available' | 'unavailable' | 'unknown';
type McpPresentation = 'inspector' | 'playground';

const pageForHash = (runtimeAvailable = false): WorkbenchPage => {
  if (window.location.hash === '#mcp' || window.location.hash === '#inspector') return 'mcp';
  if (window.location.hash === '#runtime' && runtimeAvailable) return 'runtime';
  return window.location.hash === '#skills' ? 'skills' : 'overview';
};

const mcpPresentationForHash = (): McpPresentation => window.location.hash === '#inspector' ? 'inspector' : 'playground';

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

const McpScreen = ({ appPreviewClient, connectionError, controller, mcpDepartureDiagnostic, model, onNavigate, onResetSession, onRuntimeInitialPreviewConsumed, presentation, registerPreviewClose, runtimeAvailable = false, runtimeDiagnostic, runtimeHandoff, runtimePreviewDependencies, setPresentation, status }: {
  readonly appPreviewClient: McpAppClient;
  readonly connectionError?: string;
  readonly controller: ReturnType<typeof createMcpController>;
  readonly mcpDepartureDiagnostic?: string;
  readonly model: ReturnType<typeof createMcpController>['model'];
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onResetSession: () => void;
  readonly onRuntimeInitialPreviewConsumed: (selection: Extract<McpPagePreviewSelection, { readonly kind: 'runtime' }>) => void;
  readonly runtimeAvailable?: boolean;
  readonly runtimeDiagnostic?: string;
  readonly runtimeHandoff?: RuntimeMcpHandoff;
  readonly runtimePreviewDependencies: McpPageRuntimePreviewDependencies;
  readonly presentation: McpPresentation;
  readonly registerPreviewClose: (close: () => Promise<void>) => () => void;
  readonly setPresentation: (presentation: McpPresentation) => void;
  readonly status: ProjectStatus;
}) => {
  useEffect(() => {
    const selection = runtimeHandoff?.initialPreview;
    if (selection !== undefined) onRuntimeInitialPreviewConsumed(selection);
  }, [onRuntimeInitialPreviewConsumed, runtimeHandoff]);
  const activeEpoch = status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;
  const targetOptions = mcpTargets.filter((target) => activeEpoch !== undefined && target in activeEpoch.targetDigests);
  const runtimeSource = model.binding?.kind === 'runtime'
    ? Object.freeze({ binding: model.binding.binding, kind: 'runtime' as const })
    : undefined;
  const runtimeInitialPreview = runtimeSource !== undefined && runtimeHandoff?.initialPreview !== undefined &&
    sameRuntimeMcpAppBinding(runtimeHandoff.source.binding, runtimeSource.binding)
    ? runtimeHandoff.initialPreview
    : undefined;
  const runtimeAvailability = model.binding?.kind !== 'runtime' ? undefined : Object.freeze({
    prompts: 'not-routed' as const,
    resourceTemplates: 'not-routed' as const,
    resources: 'available' as const,
    tools: 'available' as const,
  });
  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="mcp" runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeDiagnostic}>
    <div className="mcp-content">
      {mcpDepartureDiagnostic === undefined ? undefined : <p role="alert">{mcpDepartureDiagnostic}</p>}
      <div aria-label="MCP presentation" className="mcp-presentation-tabs" role="tablist">
        <button
          aria-controls="mcp-playground-presentation"
          aria-selected={presentation === 'playground'}
          className={presentation === 'playground' ? 'mcp-presentation-tab mcp-presentation-tab--active' : 'mcp-presentation-tab'}
          id="mcp-playground-tab"
          onClick={() => setPresentation('playground')}
          role="tab"
          type="button"
        >
          Playground
        </button>
        <button
          aria-controls="mcp-inspector-presentation"
          aria-selected={presentation === 'inspector'}
          className={presentation === 'inspector' ? 'mcp-presentation-tab mcp-presentation-tab--active' : 'mcp-presentation-tab'}
          id="mcp-inspector-tab"
          onClick={() => setPresentation('inspector')}
          role="tab"
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
        {runtimeSource === undefined
          ? <McpPage
              appPreviewClient={appPreviewClient}
              controller={controller}
              epochOptions={activeEpoch === undefined ? [] : [activeEpoch.id]}
              initialBinding={activeEpoch === undefined ? undefined : { epochId: activeEpoch.id }}
              onDownloadConfig={downloadMcpConfig}
              onResetSession={onResetSession}
              registerPreviewClose={registerPreviewClose}
              targetOptions={targetOptions}
            />
          : <MantineProvider><McpPage
              controller={controller}
              initialPreview={runtimeInitialPreview}
              onResetSession={onResetSession}
              registerPreviewClose={registerPreviewClose}
              runtimePreviewDependencies={runtimePreviewDependencies}
              source={runtimeSource}
            /></MantineProvider>}
      </section>
      <section
        aria-labelledby="mcp-inspector-tab"
        className="inspector-content"
        hidden={presentation !== 'inspector'}
        id="mcp-inspector-presentation"
        inert={presentation !== 'inspector'}
        role="tabpanel"
      >
        <InspectorSessionAdapter availability={runtimeAvailability} controller={controller} model={model} />
      </section>
    </div>
  </WorkbenchScreen>;
};

const RuntimeScreen = ({ connectionError, controller, handoffDiagnostic, liveMcpPageAdapter, onNavigate, registerAppPreviewLifecycle, renderAppPreview, runtimeConsent, runtimeDiagnostic, resolveRuntimeConsent }: {
  readonly connectionError?: string;
  readonly controller: RuntimePlaygroundController;
  readonly handoffDiagnostic?: string;
  readonly liveMcpPageAdapter: RuntimeLiveMcpPageAdapter;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly registerAppPreviewLifecycle: (handle: Readonly<{ close(): Promise<void> }>) => () => void;
  readonly renderAppPreview: RuntimeAppPreviewRenderer;
  readonly resolveRuntimeConsent: (decision: 'allow-once' | 'deny') => void;
  readonly runtimeConsent?: McpAppConsentChallenge;
  readonly runtimeDiagnostic?: string;
}) => {
  const diagnostic = useRef<HTMLParagraphElement>(null);
  useEffect(() => { diagnostic.current?.focus(); }, [handoffDiagnostic]);
  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="runtime" runtimeAvailable runtimeDiagnostic={runtimeDiagnostic}>
    <div className="runtime-content">
      {handoffDiagnostic === undefined ? undefined : <p ref={diagnostic} role="alert" tabIndex={-1}>{handoffDiagnostic}</p>}
      {runtimeConsent === undefined ? undefined : <section aria-label="Runtime App consent" role="dialog">
        <h2>Runtime App permission request</h2>
        <p>{typeof runtimeConsent.request === 'object' && runtimeConsent.request !== null && 'summary' in runtimeConsent.request && typeof runtimeConsent.request.summary === 'string'
          ? runtimeConsent.request.summary
          : 'Allow this Runtime App action?'}</p>
        <button onClick={() => { resolveRuntimeConsent('allow-once'); }} type="button">Allow once</button>
        <button onClick={() => { resolveRuntimeConsent('deny'); }} type="button">Deny</button>
      </section>}
      <RuntimePlayground
        controller={controller}
        liveMcpPageAdapter={liveMcpPageAdapter}
        registerAppPreviewLifecycle={registerAppPreviewLifecycle}
        renderAppPreview={renderAppPreview}
      />
    </div>
  </WorkbenchScreen>;
};

const Workbench = () => {
  const client = useRef<ProjectClient>();
  const foreground = useRef<ForegroundRouteClient>();
  const mcpRoutes = useRef<WorkbenchMcpRouteClient>();
  const mcpControllerRef = useRef<WorkbenchMcpController>();
  const mcpAppClient = useRef<McpAppClient>();
  const runtimeClient = useRef<RuntimeClient>();
  const runtimeController = useRef<RuntimePlaygroundController>();
  const skillClient = useRef<SkillClient>();
  const lifecycleAuthorities = useRef(new WeakMap<Readonly<{ close(): Promise<void> }>, RuntimeHandoffAuthority>());
  const handoffCoordinator = useRef<RuntimeMcpHandoffCoordinator>();
  const mcpPreviewDeparture = useRef<McpPreviewDepartureCoordinator>();
  const runtimeBridgeTrace = useRef(new Map<string, readonly unknown[]>());
  const runtimeConsentQueue = useRef<Array<Readonly<{ readonly challenge: McpAppConsentChallenge; readonly resolve: (decision: 'allow-once' | 'deny') => void }>>>([]);
  const [connectionError, setConnectionError] = useState<string>();
  const [error, setError] = useState<string>();
  if (foreground.current === undefined) foreground.current = new ForegroundRouteClient();
  if (mcpRoutes.current === undefined) mcpRoutes.current = new WorkbenchMcpRouteClient({ foreground: foreground.current });

  const [mcpController, setMcpController] = useState(() => createMcpController(mcpRoutes.current!));
  const [mcpModel, setMcpModel] = useState(() => mcpController.model);
  const [page, setPage] = useState<WorkbenchPage>(() => pageForHash(false));
  const [runtimeCapability, setRuntimeCapability] = useState<RuntimeCapability>('unknown');
  const [runtimeControllerState, setRuntimeControllerState] = useState<RuntimePlaygroundController>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [runtimeHandoff, setRuntimeHandoff] = useState<RuntimeMcpHandoff>();
  const [runtimeHandoffError, setRuntimeHandoffError] = useState<string>();
  const [mcpDepartureError, setMcpDepartureError] = useState<string>();
  const [runtimeConsent, setRuntimeConsent] = useState<McpAppConsentChallenge>();
  const [mcpPresentation, setMcpPresentation] = useState(mcpPresentationForHash);
  const [status, setStatus] = useState<ProjectStatus>();
  const [changedFiles, setChangedFiles] = useState<readonly string[]>([]);

  if (client.current === undefined) client.current = new ProjectClient({ foreground: foreground.current! });
  if (mcpAppClient.current === undefined) mcpAppClient.current = new McpAppClient({ projectClient: client.current });
  if (mcpControllerRef.current !== mcpController) mcpControllerRef.current = mcpController;
  if (runtimeClient.current === undefined) runtimeClient.current = new RuntimeClient(foreground.current);

  const runtimeAvailable = runtimeCapability === 'available';

  const commitNavigation = useCallback((next: WorkbenchPage): void => {
    if (next !== 'runtime') {
      handoffCoordinator.current?.cancel();
      mcpPreviewDeparture.current?.cancel();
    }
    const hash = next === 'mcp' ? '#mcp' : next === 'runtime' ? '#runtime' : next === 'skills' ? '#skills' : '#overview';
    if (window.location.hash !== hash) window.history.pushState(undefined, '', hash);
    if (next === 'mcp') setMcpPresentation('playground');
    setPage(next);
  }, []);

  if (mcpPreviewDeparture.current === undefined) {
    mcpPreviewDeparture.current = new McpPreviewDepartureCoordinator({
      commit: () => {
        setMcpDepartureError(undefined);
        commitNavigation('runtime');
      },
      reject: (reason) => { setMcpDepartureError(`Runtime navigation could not close the MCP App preview: ${errorMessage(reason)}`); },
    });
  }

  const navigate = useCallback((next: WorkbenchPage): void => {
    if (next === 'runtime' && mcpPreviewDeparture.current!.request()) return;
    if (next === 'runtime') setMcpDepartureError(undefined);
    commitNavigation(next);
  }, [commitNavigation]);

  if (handoffCoordinator.current === undefined) {
    handoffCoordinator.current = new RuntimeMcpHandoffCoordinator({
      commit: (handoff) => {
        setRuntimeHandoff(handoff);
        navigate('mcp');
      },
      reject: (reason) => { setRuntimeHandoffError(`MCP playground handoff could not close the Runtime App: ${errorMessage(reason)}`); },
    });
  }

  const resetMcpSession = useCallback((): void => {
    handoffCoordinator.current?.cancel();
    setRuntimeHandoff(undefined);
    setRuntimeHandoffError(undefined);
    const replacement = createMcpController(mcpRoutes.current!);
    mcpControllerRef.current = replacement;
    setMcpController(replacement);
    setMcpModel(replacement.model);
  }, []);

  const registerAppPreviewLifecycle = useCallback((handle: Readonly<{ close(): Promise<void> }>): (() => void) => {
    const authority = lifecycleAuthorities.current.get(handle);
    if (authority === undefined) return () => undefined;
    return handoffCoordinator.current!.register(handle, authority);
  }, []);

  const registerMcpPreviewClose = useCallback((close: () => Promise<void>): (() => void) => {
    return mcpPreviewDeparture.current!.register(close);
  }, []);

  const canOpenRuntimeHandoff = useCallback((authority: RuntimeHandoffAuthority): boolean => {
    return handoffCoordinator.current!.canOpen(authority);
  }, []);

  const openRuntimeHandoff = useCallback((authority: RuntimeHandoffAuthority): void => {
    setRuntimeHandoffError(undefined);
    handoffCoordinator.current!.open(authority);
  }, []);

  const handoffHost = useMemo<RuntimeHandoffHost>(() => Object.freeze({
    canOpen: canOpenRuntimeHandoff,
    open: openRuntimeHandoff,
    subscribe: (listener) => handoffCoordinator.current!.subscribe(listener),
  }), [canOpenRuntimeHandoff, openRuntimeHandoff]);

  const requestRuntimeConsent = useCallback((challenge: McpAppConsentChallenge): Promise<'allow-once' | 'deny'> => new Promise((resolve) => {
    const entry = Object.freeze({ challenge, resolve });
    runtimeConsentQueue.current.push(entry);
    if (runtimeConsentQueue.current.length === 1) setRuntimeConsent(challenge);
  }), []);

  const resolveRuntimeConsent = useCallback((decision: 'allow-once' | 'deny'): void => {
    const [current, ...pending] = runtimeConsentQueue.current;
    runtimeConsentQueue.current = pending;
    if (current !== undefined) current.resolve(decision);
    setRuntimeConsent(pending[0]?.challenge);
  }, []);

  const onRuntimeBridgeTrace = useCallback((bindingId: string, entry: unknown): void => {
    const previous = runtimeBridgeTrace.current.get(bindingId) ?? [];
    runtimeBridgeTrace.current.set(bindingId, Object.freeze([...previous.slice(-63), entry]));
  }, []);

  const createBridgeFactory = useCallback((preview: McpAppPreviewAppsSnapshot): RuntimeAppBridgeFactory => {
    const appClient = mcpAppClient.current;
    if (appClient === undefined) throw new Error('Runtime App client is not connected.');
    return createWorkbenchRuntimeBridgeFactory(appClient, mcpControllerRef as MutableRefObject<WorkbenchMcpController>, onRuntimeBridgeTrace, requestRuntimeConsent)(preview);
  }, [onRuntimeBridgeTrace, requestRuntimeConsent]);

  const renderAppPreview = useCallback<RuntimeAppPreviewRenderer>((props) => {
    const authority = prepareRuntimeMcpHandoffAuthority(props, runtimeProfileId);
    const appClient = mcpAppClient.current;
    if (authority === undefined || appClient === undefined) return undefined;
    return <MantineProvider><McpAppPreview
      client={appClient}
      createBridgeFactory={createBridgeFactory}
      kind="runtime"
      profile={props.profile}
      profileId={props.profileId}
      registerLifecycle={(handle) => {
        lifecycleAuthorities.current.set(handle, authority);
        return props.registerLifecycle?.(handle) ?? (() => undefined);
      }}
      run={props.run}
      surface={props.surface}
    /></MantineProvider>;
  }, [createBridgeFactory]);

  const liveMcpPageAdapter = useMemo<RuntimeLiveMcpPageAdapter>(() => Object.freeze({
    kind: 'host-owned',
    render: (props) => {
      const authority = prepareRuntimeMcpHandoffAuthority(props, runtimeProfileId);
      return authority === undefined ? undefined : <RuntimeMcpHandoffButton authority={authority} host={handoffHost} />;
    },
  }), [handoffHost]);

  const runtimePreviewDependencies = useMemo<McpPageRuntimePreviewDependencies>(() => Object.freeze({
    client: mcpAppClient.current!,
    createBridgeFactory,
  }), [createBridgeFactory]);

  const consumeRuntimeInitialPreview = useCallback((selection: Extract<McpPagePreviewSelection, { readonly kind: 'runtime' }>): void => {
    setRuntimeHandoff((current) => current?.initialPreview === selection
      ? Object.freeze({ source: current.source })
      : current);
  }, []);

  useEffect(() => {
    const next = client.current!;
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
        const nextController = createRuntimePlaygroundController({
          bootstrap,
          client: nextRuntimeClient,
          defaultProfileId: 'portable',
          profiles: runtimeProfiles,
        });
        runtimeController.current = nextController;
        runtimeEvents.install(nextController);
        setRuntimeControllerState(nextController);
      } else {
        controller.dispatch({ bootstrap, type: 'bootstrap.received' });
      }
      setRuntimeCapability('available');
      setRuntimeError(undefined);
      if (window.location.hash === '#runtime') navigate('runtime');
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
      mcpPreviewDeparture.current?.cancel();
      for (const pending of runtimeConsentQueue.current.splice(0)) pending.resolve('deny');
      setRuntimeConsent(undefined);
      void (async () => {
        try {
          await handoffCoordinator.current?.close();
        } catch {
          // Preview ownership remains retryable, but shutdown must proceed.
        }
        try {
          await mcpControllerRef.current?.close();
        } catch {
          // Draining errors are surfaced by the owning controller while active.
        }
        mcpAppClient.current?.disposeRuntime();
        next.close();
      })();
      runtimeController.current?.close();
      runtimeController.current = undefined;
    };
  }, [navigate]);

  useEffect(() => {
    const updatePage = (fromHashChange: boolean) => {
      if (window.location.hash === '#inspector') {
        window.history.replaceState(undefined, '', '#mcp');
        setMcpPresentation('inspector');
        setPage('mcp');
        return;
      }
      if (window.location.hash === '#runtime' && !runtimeAvailable) {
        if (runtimeCapability === 'unavailable') window.history.replaceState(undefined, '', '#overview');
        setPage('overview');
        return;
      }
      const next = pageForHash(runtimeAvailable);
      if (next === 'runtime' && mcpPreviewDeparture.current!.request()) {
        window.history.replaceState(undefined, '', '#mcp');
        setMcpPresentation('playground');
        setPage('mcp');
        return;
      }
      setPage(next);
      if (fromHashChange && window.location.hash === '#mcp') setMcpPresentation('playground');
    };
    const onHashChange = () => updatePage(true);
    updatePage(false);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [runtimeAvailable, runtimeCapability]);

  useEffect(() => () => {
    // Root shutdown owns the active controller's ordered preview→controller
    // close. This cleanup owns only a superseded controller after reset.
    if (mcpControllerRef.current !== mcpController) void mcpController.close().catch(() => undefined);
  }, [mcpController]);
  useEffect(() => mcpController.subscribe(setMcpModel), [mcpController]);

  if (status !== undefined && client.current !== undefined && skillClient.current !== undefined) {
    if (page === 'mcp') {
      return <McpScreen
        appPreviewClient={mcpAppClient.current}
        connectionError={connectionError}
        controller={mcpController}
        mcpDepartureDiagnostic={mcpDepartureError}
        model={mcpModel}
        onNavigate={navigate}
        onRuntimeInitialPreviewConsumed={consumeRuntimeInitialPreview}
        onResetSession={resetMcpSession}
        registerPreviewClose={registerMcpPreviewClose}
        runtimeAvailable={runtimeAvailable}
        runtimeDiagnostic={runtimeError}
        runtimeHandoff={runtimeHandoff}
        runtimePreviewDependencies={runtimePreviewDependencies}
        presentation={mcpPresentation}
        setPresentation={setMcpPresentation}
        status={status}
      />;
    }
    if (page === 'runtime' && runtimeControllerState !== undefined) {
      return <RuntimeScreen
        connectionError={connectionError}
        controller={runtimeControllerState}
        handoffDiagnostic={runtimeHandoffError}
        liveMcpPageAdapter={liveMcpPageAdapter}
        onNavigate={navigate}
        registerAppPreviewLifecycle={registerAppPreviewLifecycle}
        renderAppPreview={renderAppPreview}
        resolveRuntimeConsent={resolveRuntimeConsent}
        runtimeConsent={runtimeConsent}
        runtimeDiagnostic={runtimeError}
      />;
    }
    return page === 'skills'
      ? <SkillsScreen connectionError={connectionError} onNavigate={navigate} runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeError} skillClient={skillClient.current} status={status} />
      : <Overview changedFiles={changedFiles} client={client.current} connectionError={connectionError} onNavigate={navigate} onStatus={setStatus} runtimeAvailable={runtimeAvailable} runtimeDiagnostic={runtimeError} status={status} />;
  }
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{error === undefined ? undefined : <p role="alert">{error}</p>}{runtimeError === undefined ? undefined : <p className="runtime-capability-error">Runtime capability issue: {runtimeError}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<Workbench />);
