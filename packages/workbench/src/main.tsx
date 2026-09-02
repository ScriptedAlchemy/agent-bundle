import { RegistryProvider } from '@effect/atom-react';
import { type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Diagnostic } from '../../agent-bundle/src/contracts/diagnostics.ts';
import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import { MCP_APP_PROFILE_DESCRIPTORS, type McpAppProfileId } from '../../agent-bundle/src/contracts/mcp-apps.ts';
import type { McpAppPreviewAppsSnapshot } from '../../agent-bundle/src/contracts/mcp-apps.ts';
import type { PlaygroundRun } from '../../agent-bundle/src/contracts/playground.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import type { NativePlaygroundCatalog } from '../../agent-bundle/src/contracts/playground.ts';
import type { SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';

import { ArtifactClient } from './artifacts/artifact-client.ts';
import { ComparisonClient } from './comparisons/comparison-client.ts';
import { ComparisonsPage } from './comparisons/comparisons-page.tsx';
import { EvalClient } from './evals/eval-client.ts';
import { EvalsPage } from './evals/evals-page.tsx';
import { ArtifactsPage } from './artifacts/artifacts-page.tsx';
import { HookClient } from './hooks/hook-client.ts';
import { HooksPage } from './hooks/hooks-page.tsx';
import { LifecycleClient } from './lifecycles/lifecycle-client.ts';
import { LifecyclesPage } from './lifecycles/lifecycles-page.tsx';
import {
  createRuntimeAppBridgeFactory,
  type RuntimeAppBridgeFactory,
  type RuntimeAppBridgeOperationTrace,
  type RuntimeAppBridgeTrace,
} from './mcp/runtime-app-bridge.ts';
import { McpAppClient, type McpAppConsentChallenge } from './mcp/mcp-app-client.ts';
import type { McpAppConsentChallenge as RuntimeMcpAppConsentChallenge } from '../../agent-bundle/src/contracts/mcp-apps.ts';
import { RuntimeConsentDialog } from './mcp/runtime-consent-dialog.tsx';
import { createRuntimeConsentQueue, type RuntimeConsentQueue, type RuntimeConsentQueueCurrent } from './mcp/runtime-consent-queue.ts';
import { McpAppPreview } from './mcp/mcp-app-preview.tsx';
import { McpPage, mcpPageEmptyServerCatalogFor, mcpPageServerCatalogFor, type McpConfigDownload, type McpPagePreviewSelection, type McpPageRuntimePreviewDependencies, type McpPageServerCatalog } from './mcp/mcp-page.tsx';
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
import { mcpProtocolTraceDownload, type McpDownload } from './mcp/mcp-protocol-trace.ts';
import { LogClient } from './logs/log-client.ts';
import { LogsPage } from './logs/logs-page.tsx';
import { PlaygroundClient } from './playground/playground-client.ts';
import {
  PlaygroundPage,
  createPlaygroundCatalogLifecycle,
  playgroundScriptsForEpoch,
} from './playground/playground-page.tsx';
import { RouteManifestClient } from './routes/route-manifest-client.ts';
import {
  mcpToolPrefillFromNavigationState,
  mcpToolPrefillNavigationState,
  type McpToolPrefill,
  type RouteCatalog,
} from './routes/routes-model.ts';
import { RoutesPage } from './routes/routes-page.tsx';
import { overviewFor } from './overview-model.ts';
import { downloadBlob } from './client-helpers.ts';
import { BundleWorkflow } from './overview-page.tsx';
import { ProjectClient, type ProjectConnectionState } from './project-client.ts';
import { SkillClient } from './skill-client.ts';
import { SkillsPage } from './skills-page.tsx';
import {
  generalWorkbenchPages,
  loadWorkbenchCapabilities,
  type WorkbenchCapabilities,
} from './workbench-capabilities.ts';
import type { WorkbenchPage as GeneralWorkbenchPage } from './workbench-screen.tsx';
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

const isRuntimeModelBinding = (
  binding: WorkbenchMcpController['model']['binding'],
): binding is Extract<NonNullable<WorkbenchMcpController['model']['binding']>, { readonly kind: 'runtime' }> =>
  binding !== undefined && 'kind' in binding && binding.kind === 'runtime';

const controllerMatchesRuntimePreview = (controller: WorkbenchMcpController, preview: McpAppPreviewAppsSnapshot): boolean => {
  const binding = controller.model.binding;
  return controller.model.phase === 'ready' && isRuntimeModelBinding(binding) && sameRuntimeMcpAppBinding(binding.binding, preview.session.binding);
};

type RuntimeOperationTraceAuthority = Readonly<{
  readonly bindingId: string;
  readonly registryRevision: number;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly vector: RuntimeAppBridgeOperationTrace['vector'];
}>;

const emptyRuntimeOperationTraces: readonly RuntimeAppBridgeOperationTrace[] = Object.freeze([]);

const runtimeOperationTraceAuthority = (binding: McpAppPreviewAppsSnapshot['binding']): RuntimeOperationTraceAuthority => Object.freeze({
  bindingId: binding.id,
  registryRevision: binding.registryRevision,
  sessionId: binding.sessionId,
  sessionRevision: binding.sessionRevision,
  vector: Object.freeze({
    ...(binding.runVector.artifactEpochId === undefined ? {} : { artifactEpochId: binding.runVector.artifactEpochId }),
    runtimeGenerationId: binding.runVector.runtimeGenerationId,
    sourceRevision: binding.runVector.sourceRevision,
    stateVersion: binding.runVector.stateVersion,
  }),
});

const sameRuntimeOperationTraceAuthority = (left: RuntimeOperationTraceAuthority, right: RuntimeOperationTraceAuthority): boolean =>
  left.bindingId === right.bindingId &&
  left.registryRevision === right.registryRevision &&
  left.sessionId === right.sessionId &&
  left.sessionRevision === right.sessionRevision &&
  left.vector.artifactEpochId === right.vector.artifactEpochId &&
  left.vector.runtimeGenerationId === right.vector.runtimeGenerationId &&
  left.vector.sourceRevision === right.vector.sourceRevision &&
  left.vector.stateVersion === right.vector.stateVersion;

const runtimeConsentQueueChallenge = (challenge: RuntimeMcpAppConsentChallenge): McpAppConsentChallenge => Object.freeze({
  expiresAt: challenge.expiresAt,
  id: challenge.id,
  request: Object.freeze({
    actionFingerprint: challenge.request.actionFingerprint,
    capability: challenge.request.capability,
    details: challenge.request.details,
    scope: challenge.request.scope,
    summary: challenge.request.summary,
  }) as unknown as McpAppConsentChallenge['request'],
});

const isRuntimeOperationTrace = (entry: RuntimeAppBridgeTrace): entry is RuntimeAppBridgeOperationTrace => {
  if (entry === null || typeof entry !== 'object') return false;
  const candidate = entry as unknown as Readonly<Record<string, unknown>>;
  const vector = candidate.vector;
  const vectorRecord = vector as Readonly<Record<string, unknown>>;
  return typeof candidate.bindingId === 'string' && candidate.bindingId.length > 0 &&
    (candidate.kind === 'resources/list' || candidate.kind === 'resources/read' || candidate.kind === 'tools/call' || candidate.kind === 'tools/list') &&
    (candidate.name === undefined || typeof candidate.name === 'string') &&
    typeof candidate.operationId === 'string' && candidate.operationId.length > 0 &&
    typeof candidate.registryRevision === 'number' && Number.isSafeInteger(candidate.registryRevision) && candidate.registryRevision > 0 &&
    typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0 &&
    typeof candidate.sessionRevision === 'number' && Number.isSafeInteger(candidate.sessionRevision) && candidate.sessionRevision > 0 &&
    vector !== null && typeof vector === 'object' && !Array.isArray(vector) &&
    (vectorRecord.artifactEpochId === undefined || typeof vectorRecord.artifactEpochId === 'string') &&
    typeof vectorRecord.runtimeGenerationId === 'string' &&
    typeof vectorRecord.sourceRevision === 'string' &&
    typeof vectorRecord.stateVersion === 'number' &&
    Number.isSafeInteger(vectorRecord.stateVersion) &&
    vectorRecord.stateVersion >= 0;
};

const traceMatchesAuthority = (trace: RuntimeAppBridgeOperationTrace, authority: RuntimeOperationTraceAuthority): boolean =>
  trace.bindingId === authority.bindingId &&
  trace.registryRevision === authority.registryRevision &&
  trace.sessionId === authority.sessionId &&
  trace.sessionRevision === authority.sessionRevision &&
  trace.vector.artifactEpochId === authority.vector.artifactEpochId &&
  trace.vector.runtimeGenerationId === authority.vector.runtimeGenerationId &&
  trace.vector.sourceRevision === authority.vector.sourceRevision &&
  trace.vector.stateVersion === authority.vector.stateVersion;

/** The stable host callback admits only the existing controller's route-free runtime binding. */
const createWorkbenchRuntimeBridgeFactory = (
  appClient: McpAppClient,
  controllerRef: MutableRefObject<WorkbenchMcpController>,
  onClosed: (binding: McpAppPreviewAppsSnapshot['binding']) => void,
  onTrace: (binding: McpAppPreviewAppsSnapshot['binding'], entry: RuntimeAppBridgeTrace) => void,
  requestConsent: (challenge: RuntimeMcpAppConsentChallenge, signal?: AbortSignal) => Promise<'allow-once' | 'deny'>,
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
        await controller.adoptRuntimeSession(preview.session);
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
        onTrace: (entry) => { onTrace(preview.binding, entry); },
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
        .then(() => inner?.close())
        .then(() => { onClosed(preview.binding); });
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

const downloadMcpFile = ({ blob, filename }: McpDownload): void => downloadBlob(blob, filename);

const StateMark = ({ state }: { readonly state: string }) => (
  <span aria-hidden="true" className={`state-mark state-mark--${state}`}>{
    state === 'active' || state === 'ready' || state === 'built' ? '✓'
      : state === 'stale' || state === 'invalid' || state === 'failed' ? '!'
        : '–'
  }</span>
);

type WorkbenchPage = GeneralWorkbenchPage | 'runtime';
type RuntimeCapability = 'available' | 'unavailable' | 'unknown';
type CapabilityState =
  | Readonly<{ readonly state: 'empty' }>
  | Readonly<{ readonly buildId: string; readonly previous?: WorkbenchCapabilities; readonly state: 'loading' }>
  | Readonly<{ readonly buildId: string; readonly message: string; readonly previous?: WorkbenchCapabilities; readonly state: 'error' }>
  | Readonly<{ readonly state: 'ready'; readonly value: WorkbenchCapabilities }>;

/** The last loaded catalog, retained so an epoch flip revalidates without unmounting live content. */
const staleCapabilities = (state: CapabilityState): WorkbenchCapabilities | undefined => {
  switch (state.state) {
    case 'ready':
      return state.value;
    case 'loading':
    case 'error':
      return state.previous;
    case 'empty':
      return undefined;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const navigationItems: readonly Readonly<{ glyph: string; label: string; page: WorkbenchPage }>[] = [
  { glyph: '⊞', label: 'Overview', page: 'overview' },
  { glyph: '⌸', label: 'Routes', page: 'routes' },
  { glyph: '⌘', label: 'Skills', page: 'skills' },
  { glyph: '⌥', label: 'Hooks', page: 'hooks' },
  { glyph: '↻', label: 'Lifecycles', page: 'lifecycles' },
  { glyph: '⌁', label: 'MCP playground', page: 'mcp' },
  { glyph: '◫', label: 'Runtime', page: 'runtime' },
  { glyph: '▤', label: 'Artifacts', page: 'artifacts' },
  { glyph: '◇', label: 'Playground', page: 'playground' },
  { glyph: '≡', label: 'Logs', page: 'logs' },
  { glyph: '✓', label: 'Evals', page: 'evals' },
  { glyph: '⇄', label: 'Comparisons', page: 'comparisons' },
];

const workbenchPages: ReadonlySet<WorkbenchPage> = new Set(navigationItems.map((item) => item.page));

const pageForHash = (runtimeAvailable = false, pages: ReadonlySet<WorkbenchPage> = workbenchPages): WorkbenchPage => {
  const page = window.location.hash.slice(1);
  if (page === 'runtime' && !runtimeAvailable) return 'overview';
  return workbenchPages.has(page as WorkbenchPage) && pages.has(page as WorkbenchPage) ? page as WorkbenchPage : 'overview';
};

const Navigation = ({ onNavigate, page, pages, runtimeDiagnostic }: {
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic?: string;
}) => <aside className="rail" aria-label="Workbench navigation">
  <div className="brand">Agent Bundle</div>
  {navigationItems.filter((item) => pages.has(item.page)).map((item) => (
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
  {runtimeDiagnostic === undefined ? undefined : <p className="runtime-capability-error" role="status">Runtime capability issue: {runtimeDiagnostic}</p>}
</aside>;

const Overview = ({ capabilities, changedFiles, client, connectionError, onNavigate, pages, runtimeDiagnostic, status, onStatus }: {
  readonly capabilities?: WorkbenchCapabilities;
  readonly changedFiles: readonly string[];
  readonly client: ProjectClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onStatus: (status: ProjectStatus) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
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
      <Navigation onNavigate={onNavigate} page="overview" pages={pages} runtimeDiagnostic={runtimeDiagnostic} />
      <main className="canvas" id="overview">
        <header className="topbar">
          <span className="menu-glyph" aria-hidden="true">☰</span>
          <span className="topbar-title">Project workbench</span>
          <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
            <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
          </span>
        </header>
        <div className="page-content">
          <BundleWorkflow capabilities={capabilities} onNavigate={onNavigate} />

          <section aria-labelledby="build-health-heading" className="build-health section">
            <div>
              <h2 id="build-health-heading">Build health</h2>
              <div className="build-health-state">
                <StateMark state={overview.epoch.state} />
                <div><strong>{overview.epoch.summary}</strong><p>{overview.nextAction.summary}</p></div>
              </div>
            </div>
            <button disabled={rebuilding} onClick={() => void rebuild()} type="button">
              {rebuilding ? 'Rebuilding…' : overview.nextAction.label}
            </button>
          </section>
          {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}

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

          <details className="build-details">
            <summary>Inspect build details</summary>
          <section aria-labelledby="normalization-heading" className="section">
            <h2 id="normalization-heading">Source and build state</h2>
            <dl className="definition-row">
              <div><dt>Source state</dt><dd><StateMark state={overview.normalization.state} />{overview.normalization.label}</dd></div>
              <div><dt>Source revision</dt><dd className="identifier">{overview.normalization.revision ?? 'Not available'}</dd></div>
              <div><dt>Build state</dt><dd className="status-text">{stateLabel(status.build.state)}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="epoch-heading" className="section">
            <h2 id="epoch-heading">Published build</h2>
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

          <section aria-labelledby="changed-files-heading" className="section">
            <h2 id="changed-files-heading">Latest changed files ({overview.changedFiles.length})</h2>
            {overview.changedFiles.length === 0 ? <p className="empty-row">No source changes have been reported in this browser session.</p> : (
              <ul className="changed-file-list">
                {overview.changedFiles.map((path) => <li className="identifier" key={path}>{path}</li>)}
              </ul>
            )}
          </section>
          </details>
        </div>
      </main>
    </div>
  );
};

const SkillsScreen = ({ connectionError, evalClient, onNavigate, pages, runtimeDiagnostic, skillClient, status }: {
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic?: string;
  readonly skillClient: SkillClient;
  readonly status: ProjectStatus;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page="skills" pages={pages} runtimeDiagnostic={runtimeDiagnostic} />
  <main className="canvas" id="skills">
    <header className="topbar">
      <span className="menu-glyph" aria-hidden="true">☰</span>
      <span className="topbar-title">Project workbench</span>
      <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
        <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
      </span>
    </header>
    <SkillsPage client={skillClient} evalClient={evalClient} status={status} />
  </main>
</div>;

const WorkbenchScreen = ({ children, connectionError, inert = false, onNavigate, page, pages, runtimeDiagnostic }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly inert?: boolean;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
}) => <div className="workbench-shell" inert={inert || undefined}>
  <Navigation onNavigate={onNavigate} page={page} pages={pages} runtimeDiagnostic={runtimeDiagnostic} />
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

const EvalsScreen = ({ connectionError, evalClient, onNavigate, pages, runtimeDiagnostic }: {
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="evals" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <EvalsPage client={evalClient} />
</WorkbenchScreen>;

const ComparisonsScreen = ({ comparisonClient, connectionError, evalClient, onNavigate, pages, runtimeDiagnostic }: {
  readonly comparisonClient: ComparisonClient;
  readonly connectionError?: string;
  readonly evalClient: EvalClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="comparisons" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <ComparisonsPage comparisonClient={comparisonClient} evalClient={evalClient} />
</WorkbenchScreen>;

const ArtifactsScreen = ({ artifactClient, connectionError, onNavigate, pages, runtimeDiagnostic, status }: {
  readonly artifactClient: ArtifactClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
  readonly status: ProjectStatus;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="artifacts" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <ArtifactsPage client={artifactClient} epochId={activeEpochId(status)} />
</WorkbenchScreen>;

const PlaygroundScreen = ({ connectionError, inspection, onNavigate, onRunChange, pages, playgroundClient, run, runtimeDiagnostic, skillTree, status }: {
  readonly connectionError?: string;
  readonly inspection: ArtifactInspection;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onRunChange: (run: PlaygroundRun | undefined) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly playgroundClient: PlaygroundClient;
  readonly run: PlaygroundRun | undefined;
  readonly runtimeDiagnostic: string | undefined;
  readonly skillTree: SkillDocumentTree;
  readonly status: ProjectStatus;
}) => {
  const epoch = activeEpochFor(status);
  const [nativeCatalog, setNativeCatalog] = useState<NativePlaygroundCatalog>();
  const [nativeCatalogError, setNativeCatalogError] = useState<string>();
  const [nativeCatalogLoading, setNativeCatalogLoading] = useState(false);
  const catalogLifecycle = useRef(createPlaygroundCatalogLifecycle());
  const catalogClient = useRef(playgroundClient);
  const clientReplaced = catalogClient.current !== playgroundClient;
  if (clientReplaced) {
    catalogClient.current = playgroundClient;
    catalogLifecycle.current.invalidate();
  }
  const visibleNativeCatalog = !clientReplaced && nativeCatalog?.epochId === epoch?.id ? nativeCatalog : undefined;
  const scripts = playgroundScriptsForEpoch({ epochId: inspection.epochId, scripts: inspection.runtime.scripts }, epoch?.id);

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

  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="playground" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
    <PlaygroundPage
      catalog={visibleNativeCatalog}
      catalogError={nativeCatalogError}
      catalogLoading={nativeCatalogLoading || (epoch !== undefined && visibleNativeCatalog === undefined && nativeCatalogError === undefined)}
      client={playgroundClient}
      epoch={playgroundEpochFor(status)}
      hooks={inspection.runtime.hooks}
      mcpServers={inspection.runtime.mcpServers}
      onRunChange={onRunChange}
      run={run}
      scripts={scripts}
      skills={skillTree.skills}
      targets={playgroundTargetsFor(status)}
    />
  </WorkbenchScreen>;
};

const RoutesScreen = ({ catalog, connectionError, onNavigate, onOpenMcp, pages, runtimeDiagnostic }: {
  readonly catalog: RouteCatalog;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onOpenMcp: (prefill: McpToolPrefill) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="routes" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <RoutesPage catalog={catalog} onOpenMcp={onOpenMcp} />
</WorkbenchScreen>;

const LogsScreen = ({ connectionError, logClient, onNavigate, pages, runtimeDiagnostic }: {
  readonly connectionError?: string;
  readonly logClient: LogClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="logs" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <LogsPage client={logClient} />
</WorkbenchScreen>;

const HooksScreen = ({ connectionError, hookClient, onNavigate, pages, runtimeDiagnostic, status }: {
  readonly connectionError?: string;
  readonly hookClient: HookClient;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
  readonly status: ProjectStatus;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="hooks" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <HooksPage client={hookClient} epochId={activeEpochId(status)} />
</WorkbenchScreen>;

const LifecyclesScreen = ({ connectionError, lifecycleClient, manifestDigest, onNavigate, pages, runtimeDiagnostic }: {
  readonly connectionError?: string;
  readonly lifecycleClient: LifecycleClient;
  readonly manifestDigest: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic: string | undefined;
}) => <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="lifecycles" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
  <LifecyclesPage client={lifecycleClient} manifestDigest={manifestDigest} />
</WorkbenchScreen>;

const McpScreen = ({ appPreviewClient, artifactClient, connectionError, controller, initialToolPrefill, mcpDepartureDiagnostic, model, onNavigate, onResetSession, onRuntimeInitialPreviewConsumed, pages, registerPreviewClose, runtimeDiagnostic, runtimeHandoff, runtimePreviewDependencies, status }: {
  readonly appPreviewClient: McpAppClient;
  readonly artifactClient: ArtifactClient;
  readonly connectionError?: string;
  readonly controller: ReturnType<typeof createMcpController>;
  readonly initialToolPrefill?: McpToolPrefill;
  readonly mcpDepartureDiagnostic?: string;
  readonly model: ReturnType<typeof createMcpController>['model'];
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onResetSession: () => void;
  readonly onRuntimeInitialPreviewConsumed: (selection: Extract<McpPagePreviewSelection, { readonly kind: 'runtime' }>) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly runtimeDiagnostic?: string;
  readonly runtimeHandoff?: RuntimeMcpHandoff;
  readonly runtimePreviewDependencies: McpPageRuntimePreviewDependencies;
  readonly registerPreviewClose: (close: () => Promise<void>) => () => void;
  readonly status: ProjectStatus;
}) => {
  useEffect(() => {
    const selection = runtimeHandoff?.initialPreview;
    if (selection !== undefined) onRuntimeInitialPreviewConsumed(selection);
  }, [onRuntimeInitialPreviewConsumed, runtimeHandoff]);
  const activeEpoch = status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;
  const [serverCatalog, setServerCatalog] = useState<McpPageServerCatalog>();
  const targetOptions = mcpTargets.filter((target) => activeEpoch !== undefined && target in activeEpoch.targetDigests);
  const serverCatalogState = activeEpoch !== undefined && (serverCatalog === undefined || serverCatalog.epochId !== activeEpoch.id)
    ? 'loading' as const
    : 'ready' as const;
  const serverOptions = activeEpoch !== undefined && serverCatalogState === 'ready' ? serverCatalog?.options ?? [] : [];
  useEffect(() => {
    const epochId = activeEpoch?.id;
    const request = new AbortController();
    setServerCatalog(undefined);
    if (epochId === undefined) return () => request.abort();
    void artifactClient.inspect(epochId, request.signal).then((inspection) => {
      const catalog = mcpPageServerCatalogFor(epochId, inspection, request.signal);
      if (catalog !== undefined) setServerCatalog(catalog);
    }).catch(() => {
      const catalog = mcpPageEmptyServerCatalogFor(epochId, request.signal);
      if (catalog !== undefined) setServerCatalog(catalog);
    });
    return () => request.abort();
  }, [activeEpoch?.id, artifactClient]);
  const runtimeSource = isRuntimeModelBinding(model.binding)
    ? Object.freeze({ binding: model.binding.binding, kind: 'runtime' as const })
    : undefined;
  const runtimeInitialPreview = runtimeSource !== undefined && runtimeHandoff?.initialPreview !== undefined &&
    sameRuntimeMcpAppBinding(runtimeHandoff.source.binding, runtimeSource.binding)
    ? runtimeHandoff.initialPreview
    : undefined;
  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="mcp" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
    <div className="mcp-content">
      {mcpDepartureDiagnostic === undefined ? undefined : <p role="alert">{mcpDepartureDiagnostic}</p>}
      {runtimeSource === undefined
        ? <McpPage
            appPreviewClient={appPreviewClient}
            controller={controller}
            epochOptions={activeEpoch === undefined ? [] : [activeEpoch.id]}
            initialBinding={activeEpoch === undefined ? undefined : {
              epochId: activeEpoch.id,
              ...(initialToolPrefill === undefined ? {} : { serverName: initialToolPrefill.serverName }),
            }}
            initialToolPrefill={initialToolPrefill}
            onDownloadConfig={downloadMcpFile}
            onDownloadTrace={downloadMcpFile}
            onResetSession={onResetSession}
            presentationActive={true}
            registerPreviewClose={registerPreviewClose}
            serverCatalogState={serverCatalogState}
            serverOptions={serverOptions}
            targetOptions={targetOptions}
          />
        : <McpPage
            controller={controller}
            initialPreview={runtimeInitialPreview}
            onResetSession={onResetSession}
            registerPreviewClose={registerPreviewClose}
            runtimePreviewDependencies={runtimePreviewDependencies}
            source={runtimeSource}
          />}
    </div>
  </WorkbenchScreen>;
};

const RuntimeScreen = ({ connectionError, controller, handoffDiagnostic, liveMcpPageAdapter, onNavigate, pages, registerAppPreviewLifecycle, renderAppPreview, runtimeConsent, runtimeDiagnostic, resolveRuntimeConsent }: {
  readonly connectionError?: string;
  readonly controller: RuntimePlaygroundController;
  readonly handoffDiagnostic?: string;
  readonly liveMcpPageAdapter: RuntimeLiveMcpPageAdapter;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly registerAppPreviewLifecycle: (handle: Readonly<{ close(): Promise<void> }>) => () => void;
  readonly renderAppPreview: RuntimeAppPreviewRenderer;
  readonly resolveRuntimeConsent: (current: RuntimeConsentQueueCurrent, decision: 'allow-once' | 'deny') => boolean;
  readonly runtimeConsent?: RuntimeConsentQueueCurrent;
  readonly runtimeDiagnostic?: string;
}) => {
  const diagnostic = useRef<HTMLParagraphElement>(null);
  useEffect(() => { diagnostic.current?.focus(); }, [handoffDiagnostic]);
  return <>
    <WorkbenchScreen connectionError={connectionError} inert={runtimeConsent !== undefined} onNavigate={onNavigate} page="runtime" pages={pages} runtimeDiagnostic={runtimeDiagnostic}>
      <div className="runtime-content">
        {handoffDiagnostic === undefined ? undefined : <p ref={diagnostic} role="alert" tabIndex={-1}>{handoffDiagnostic}</p>}
        <RuntimePlayground
          controller={controller}
          liveMcpPageAdapter={liveMcpPageAdapter}
          registerAppPreviewLifecycle={registerAppPreviewLifecycle}
          renderAppPreview={renderAppPreview}
        />
      </div>
    </WorkbenchScreen>
    {runtimeConsent === undefined ? undefined : <RuntimeConsentDialog current={runtimeConsent} onResolve={resolveRuntimeConsent} />}
  </>;
};

const Workbench = () => {
  const client = useRef<ProjectClient | undefined>(undefined);
  const foreground = useRef<ForegroundRouteClient | undefined>(undefined);
  const mcpRoutes = useRef<WorkbenchMcpRouteClient | undefined>(undefined);
  const mcpControllerRef = useRef<WorkbenchMcpController | undefined>(undefined);
  const mcpAppClient = useRef<McpAppClient | undefined>(undefined);
  const runtimeClient = useRef<RuntimeClient | undefined>(undefined);
  const runtimeController = useRef<RuntimePlaygroundController | undefined>(undefined);
  const skillClient = useRef<SkillClient | undefined>(undefined);
  const lifecycleAuthorities = useRef(new WeakMap<Readonly<{ close(): Promise<void> }>, RuntimeHandoffAuthority>());
  const handoffCoordinator = useRef<RuntimeMcpHandoffCoordinator | undefined>(undefined);
  const mcpPreviewDeparture = useRef<McpPreviewDepartureCoordinator | undefined>(undefined);
  const runtimeOperationTraceAuthorities = useRef(new Map<string, RuntimeOperationTraceAuthority>());
  const resetRuntimeInstance = useRef<() => void>(() => undefined);
  const artifactClient = useRef<ArtifactClient | undefined>(undefined);
  const comparisonClient = useRef<ComparisonClient | undefined>(undefined);
  const evalClient = useRef<EvalClient | undefined>(undefined);
  const hookClient = useRef<HookClient | undefined>(undefined);
  const lifecycleClient = useRef<LifecycleClient | undefined>(undefined);
  const logClient = useRef<LogClient | undefined>(undefined);
  const playgroundClient = useRef<PlaygroundClient | undefined>(undefined);
  const routeManifestClient = useRef<RouteManifestClient | undefined>(undefined);
  const [connectionError, setConnectionError] = useState<string>();
  const [connection, setConnection] = useState<ProjectConnectionState>({ state: 'connecting' });
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [capabilityState, setCapabilityState] = useState<CapabilityState>({ state: 'empty' });
  if (foreground.current === undefined) foreground.current = new ForegroundRouteClient();
  const foregroundClient = foreground.current;
  if (mcpRoutes.current === undefined) mcpRoutes.current = new WorkbenchMcpRouteClient({ foreground: foregroundClient });

  const [mcpController, setMcpController] = useState(() => createMcpController(mcpRoutes.current!));
  const [mcpModel, setMcpModel] = useState(() => mcpController.model);
  const [page, setPage] = useState<WorkbenchPage>(() => pageForHash(false));
  const pageRef = useRef(page);
  const [runtimeCapability, setRuntimeCapability] = useState<RuntimeCapability>('unknown');
  const [runtimeControllerState, setRuntimeControllerState] = useState<RuntimePlaygroundController>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [runtimeHandoff, setRuntimeHandoff] = useState<RuntimeMcpHandoff>();
  const [runtimeHandoffError, setRuntimeHandoffError] = useState<string>();
  const [mcpDepartureError, setMcpDepartureError] = useState<string>();
  const [runtimeConsent, setRuntimeConsent] = useState<RuntimeConsentQueueCurrent>();
  const runtimeConsentQueue = useRef<RuntimeConsentQueue | undefined>(undefined);
  if (runtimeConsentQueue.current === undefined) {
    runtimeConsentQueue.current = createRuntimeConsentQueue(setRuntimeConsent);
  }
  const [status, setStatus] = useState<ProjectStatus>();
  const [changedFiles, setChangedFiles] = useState<readonly string[]>([]);
  const [runtimeOperationTraces, setRuntimeOperationTraces] = useState<readonly RuntimeAppBridgeOperationTrace[]>(emptyRuntimeOperationTraces);
  const [playgroundRun, setPlaygroundRun] = useState<PlaygroundRun>();

  pageRef.current = page;

  if (client.current === undefined) {
    client.current = new ProjectClient({
      beforeInstanceChange: async () => {
        handoffCoordinator.current?.cancel();
        mcpPreviewDeparture.current?.cancel();
        runtimeConsentQueue.current?.resolveAll('deny');
        const results = await Promise.allSettled([
          handoffCoordinator.current?.close() ?? Promise.resolve(),
          mcpPreviewDeparture.current?.close() ?? Promise.resolve(),
          mcpControllerRef.current?.close() ?? Promise.resolve(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') setConnectionError(errorMessage(failure.reason));
        mcpAppClient.current?.resetRuntimeForForegroundReplacement();
        handoffCoordinator.current = undefined;
        mcpPreviewDeparture.current = undefined;
        resetRuntimeInstance.current();
        runtimeOperationTraceAuthorities.current.clear();
        setRuntimeOperationTraces(emptyRuntimeOperationTraces);
        runtimeController.current?.close();
        runtimeController.current = undefined;
        setRuntimeControllerState(undefined);
        setRuntimeCapability('unknown');
        setRuntimeHandoff(undefined);
        setPlaygroundRun(undefined);
        setChangedFiles([]);
        setCapabilityState({ state: 'empty' });
        const replacement = createMcpController(mcpRoutes.current!);
        mcpControllerRef.current = replacement;
        setMcpController(replacement);
        setMcpModel(replacement.model);
      },
      foreground: foregroundClient,
    });
  }
  if (mcpAppClient.current === undefined) {
    mcpAppClient.current = new McpAppClient({ foreground: foregroundClient, projectClient: client.current });
  }
  if (mcpControllerRef.current !== mcpController) mcpControllerRef.current = mcpController;
  if (runtimeClient.current === undefined) runtimeClient.current = new RuntimeClient(foregroundClient);
  if (artifactClient.current === undefined) artifactClient.current = new ArtifactClient({ foreground: foregroundClient });
  if (comparisonClient.current === undefined) comparisonClient.current = new ComparisonClient({ foreground: foregroundClient });
  if (evalClient.current === undefined) evalClient.current = new EvalClient({ foreground: foregroundClient });
  if (hookClient.current === undefined) hookClient.current = new HookClient({ foreground: foregroundClient });
  if (lifecycleClient.current === undefined) lifecycleClient.current = new LifecycleClient({ foreground: foregroundClient });
  if (logClient.current === undefined) logClient.current = new LogClient({ foreground: foregroundClient });
  if (playgroundClient.current === undefined) playgroundClient.current = new PlaygroundClient({ foreground: foregroundClient });
  if (routeManifestClient.current === undefined) routeManifestClient.current = new RouteManifestClient({ foreground: foregroundClient });

  const runtimeAvailable = runtimeCapability === 'available';
  const buildId = status === undefined ? undefined : activeEpochId(status);
  const epochSourceRevision = status === undefined ? undefined : activeEpochFor(status)?.projectRevision;
  // Serve the last loaded catalog while a new epoch's catalog loads. A build
  // flip must not unmount live content: a Runtime App preview keeps its
  // session across artifact-only changes (for example a prebuilt payload
  // rewritten by the consumer's own dev compiler), and remounting it would
  // discard a healthy binding just to re-create it from the same evidence.
  const capabilities = staleCapabilities(capabilityState);
  const capabilityPages = capabilities?.pages ?? generalWorkbenchPages;
  const pages = useMemo<ReadonlySet<WorkbenchPage>>(() => Object.freeze(new Set<WorkbenchPage>([
    ...capabilityPages,
    ...(runtimeAvailable ? ['runtime' as const] : []),
  ])), [capabilityPages, runtimeAvailable]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const routesReady = status !== undefined && (buildId === undefined || capabilities !== undefined);

  const commitNavigation = useCallback((next: WorkbenchPage): void => {
    const available = pagesRef.current.has(next) ? next : 'overview';
    if (available !== 'runtime') {
      handoffCoordinator.current?.cancel();
      mcpPreviewDeparture.current?.cancel();
    }
    const hash = `#${available}`;
    if (window.location.hash !== hash) window.history.pushState(undefined, '', hash);
    setPage(available);
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

  const navigate = useCallback((next: WorkbenchPage, afterCommit?: () => void): void => {
    const commit = (): void => {
      commitNavigation(next);
      afterCommit?.();
    };
    const current = pageRef.current;
    if (next === current) {
      if (current === 'mcp') {
        mcpPreviewDeparture.current!.cancelDeparture();
      } else if (current === 'runtime') {
        handoffCoordinator.current!.cancelDeparture();
      }
      afterCommit?.();
      return;
    }
    if (current === 'mcp') {
      setMcpDepartureError(undefined);
      if (mcpPreviewDeparture.current!.depart({
        commit: () => {
          setMcpDepartureError(undefined);
          commit();
        },
        reject: (reason) => { setMcpDepartureError(`Navigation could not close the MCP App preview: ${errorMessage(reason)}`); },
      })) {
        // A hash/back navigation has changed the URL already; the mounted Page remains authoritative until close settles.
        if (window.location.hash !== '#mcp') window.history.replaceState(undefined, '', '#mcp');
        return;
      }
    }
    if (current === 'runtime') {
      setRuntimeHandoffError(undefined);
      if (handoffCoordinator.current!.depart({
        commit: () => {
          setRuntimeHandoffError(undefined);
          commit();
        },
        reject: (reason) => { setRuntimeHandoffError(`Runtime navigation could not close the Runtime App: ${errorMessage(reason)}`); },
      })) {
        // A hash/back navigation has already changed the URL; keep Runtime mounted until its exact close settles.
        if (window.location.hash !== '#runtime') window.history.replaceState(undefined, '', '#runtime');
        return;
      }
    }
    commit();
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

  const activateRuntimeOperationTraceAuthority = useCallback((binding: McpAppPreviewAppsSnapshot['binding']): RuntimeOperationTraceAuthority => {
    const next = runtimeOperationTraceAuthority(binding);
    const previous = runtimeOperationTraceAuthorities.current.get(next.bindingId);
    if (previous !== undefined && sameRuntimeOperationTraceAuthority(previous, next)) return previous;
    runtimeOperationTraceAuthorities.current.set(next.bindingId, next);
    setRuntimeOperationTraces((current) => {
      const retained = current.filter((trace) => trace.bindingId !== next.bindingId);
      return retained.length === current.length ? current : Object.freeze(retained);
    });
    return next;
  }, []);

  const clearRuntimeOperationTrace = useCallback((authority: RuntimeOperationTraceAuthority): void => {
    if (runtimeOperationTraceAuthorities.current.get(authority.bindingId) !== authority) return;
    runtimeOperationTraceAuthorities.current.delete(authority.bindingId);
    setRuntimeOperationTraces((current) => {
      const retained = current.filter((trace) => trace.bindingId !== authority.bindingId);
      return retained.length === current.length ? current : Object.freeze(retained);
    });
  }, []);

  const clearRuntimeOperationTraces = useCallback((): void => {
    runtimeOperationTraceAuthorities.current.clear();
    setRuntimeOperationTraces(emptyRuntimeOperationTraces);
  }, []);

  const resetMcpSession = useCallback((): void => {
    handoffCoordinator.current?.cancel();
    clearRuntimeOperationTraces();
    setRuntimeHandoff(undefined);
    setRuntimeHandoffError(undefined);
    const replacement = createMcpController(mcpRoutes.current!);
    mcpControllerRef.current = replacement;
    setMcpController(replacement);
    setMcpModel(replacement.model);
  }, [clearRuntimeOperationTraces]);

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
    subscribe: (listener: () => void) => handoffCoordinator.current!.subscribe(listener),
  }), [canOpenRuntimeHandoff, openRuntimeHandoff]);

  const requestRuntimeConsent = useCallback((challenge: RuntimeMcpAppConsentChallenge, signal?: AbortSignal): Promise<'allow-once' | 'deny'> =>
    runtimeConsentQueue.current!.request(runtimeConsentQueueChallenge(challenge), signal), []);

  const resolveRuntimeConsent = useCallback((current: RuntimeConsentQueueCurrent, decision: 'allow-once' | 'deny'): boolean => {
    return runtimeConsentQueue.current!.resolve(current, decision);
  }, []);

  const onRuntimeBridgeTrace = useCallback((binding: McpAppPreviewAppsSnapshot['binding'], entry: RuntimeAppBridgeTrace): void => {
    const authority = runtimeOperationTraceAuthorities.current.get(binding.id);
    if (authority === undefined || !sameRuntimeOperationTraceAuthority(authority, runtimeOperationTraceAuthority(binding)) ||
      !isRuntimeOperationTrace(entry) || !traceMatchesAuthority(entry, authority)) return;
    setRuntimeOperationTraces((current) => Object.freeze([
      ...current.filter((trace) => trace.bindingId !== authority.bindingId).slice(-63),
      entry,
    ]));
  }, []);

  const onRuntimeBridgeClosed = useCallback((binding: McpAppPreviewAppsSnapshot['binding']): void => {
    const authority = runtimeOperationTraceAuthorities.current.get(binding.id);
    if (authority === undefined || !sameRuntimeOperationTraceAuthority(authority, runtimeOperationTraceAuthority(binding))) return;
    clearRuntimeOperationTrace(authority);
  }, [clearRuntimeOperationTrace]);

  const createBridgeFactory = useCallback((preview: McpAppPreviewAppsSnapshot): RuntimeAppBridgeFactory => {
    const appClient = mcpAppClient.current;
    if (appClient === undefined) throw new Error('Runtime App client is not connected.');
    activateRuntimeOperationTraceAuthority(preview.binding);
    return createWorkbenchRuntimeBridgeFactory(appClient, mcpControllerRef as MutableRefObject<WorkbenchMcpController>, onRuntimeBridgeClosed, onRuntimeBridgeTrace, requestRuntimeConsent)(preview);
  }, [activateRuntimeOperationTraceAuthority, onRuntimeBridgeClosed, onRuntimeBridgeTrace, requestRuntimeConsent]);

  const renderAppPreview = useCallback<RuntimeAppPreviewRenderer>((props) => {
    const authority = prepareRuntimeMcpHandoffAuthority(props, runtimeProfileId);
    const appClient = mcpAppClient.current;
    if (authority === undefined || appClient === undefined) return undefined;
    return <McpAppPreview
      client={appClient}
      createBridgeFactory={createBridgeFactory}
      kind="runtime"
      operationTraces={runtimeOperationTraces}
      profile={props.profile}
      profileId={props.profileId}
      registerLifecycle={(handle) => {
        lifecycleAuthorities.current.set(handle, authority);
        return props.registerLifecycle?.(handle) ?? (() => undefined);
      }}
      run={props.run}
      surface={props.surface}
    />;
  }, [createBridgeFactory, runtimeOperationTraces]);

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
    let runtimeEvents = createRuntimeEventBuffer();
    let mounted = true;
    let runtimeInstanceVersion = 0;
    let runtimeTopologyPresent = false;
    let runtimeBootstrapStarted = false;
    let runtimeRetry: ReturnType<typeof setTimeout> | undefined;
    let runtimeRetryCount = 0;
    const resetRuntimeBootstrap = (): void => {
      runtimeInstanceVersion += 1;
      runtimeTopologyPresent = false;
      runtimeBootstrapStarted = false;
      runtimeRetryCount = 0;
      if (runtimeRetry !== undefined) clearTimeout(runtimeRetry);
      runtimeRetry = undefined;
      runtimeEvents.close();
      runtimeEvents = createRuntimeEventBuffer();
    };
    resetRuntimeInstance.current = resetRuntimeBootstrap;
    client.current = next;
    skillClient.current = nextSkillClient;
    const unsubscribeActivity = next.onActivity((activity) => {
      if (mounted) setChangedFiles(activity.changedFiles);
    });
    const unsubscribeConnection = next.onConnection((nextConnection) => {
      if (!mounted) return;
      setConnection(nextConnection);
      if (nextConnection.state === 'connected') setConnectionError(undefined);
    });
    const resolveRuntimeCapability = (bootstrap: RuntimeBootstrap): void => {
      if (!mounted) return;
      if (bootstrap.kind === 'unavailable') {
        runtimeEvents.close();
        runtimeRetryCount = 0;
        clearRuntimeOperationTraces();
        setRuntimeError(undefined);
        setRuntimeCapability('unavailable');
        if (window.location.hash === '#runtime') {
          window.history.replaceState(undefined, '', '#overview');
          navigate('overview');
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
      if (!mounted || !runtimeTopologyPresent) return;
      const instanceVersion = runtimeInstanceVersion;
      runtimeBootstrapStarted = true;
      void nextRuntimeClient.bootstrap().then((bootstrap) => {
        if (instanceVersion === runtimeInstanceVersion) resolveRuntimeCapability(bootstrap);
      }).catch((reason: unknown) => {
        if (!mounted || instanceVersion !== runtimeInstanceVersion) return;
        setRuntimeError(errorMessage(reason));
        scheduleRuntimeBootstrap();
      });
    };
    void next.connect(
      (nextStatus) => {
        if (!mounted) return;
        setConnectionError(undefined);
        setStatus(nextStatus);
        if (nextStatus.runtime?.state === 'configured') {
          runtimeTopologyPresent = true;
          if (!runtimeBootstrapStarted) bootstrapRuntime();
          return;
        }
        runtimeEvents.close();
        runtimeRetryCount = 0;
        clearRuntimeOperationTraces();
        setRuntimeError(undefined);
        setRuntimeCapability('unavailable');
        if (window.location.hash === '#runtime') {
          window.history.replaceState(undefined, '', '#overview');
          navigate('overview');
        }
      },
      (reason) => {
        if (mounted) setConnectionError(errorMessage(reason));
      },
      (event) => { runtimeEvents.receive(event); },
    ).catch((reason: unknown) => {
      if (mounted) setConnectionError(errorMessage(reason));
    });
    return () => {
      mounted = false;
      if (resetRuntimeInstance.current === resetRuntimeBootstrap) resetRuntimeInstance.current = () => undefined;
      clearRuntimeOperationTraces();
      if (runtimeRetry !== undefined) clearTimeout(runtimeRetry);
      runtimeEvents.close();
      unsubscribeActivity();
      unsubscribeConnection();
      const pagePreviewClose = mcpPreviewDeparture.current?.close();
      runtimeConsentQueue.current?.resolveAll('deny');
      void (async () => {
        try {
          await handoffCoordinator.current?.close();
        } catch {
          // Preview ownership remains retryable, but shutdown must proceed.
        }
        try {
          await pagePreviewClose;
        } catch {
          // The Page owns its retryable preview diagnostic while mounted; shutdown still drains the controller.
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
  }, [clearRuntimeOperationTraces, navigate]);

  useEffect(() => {
    const request = new AbortController();
    if (buildId === undefined) {
      setCapabilityState({ state: 'empty' });
      return () => request.abort();
    }
    setCapabilityState((current) => {
      if (current.state === 'ready' && current.value.buildId === buildId) return current;
      const previous = staleCapabilities(current);
      return { buildId, ...(previous === undefined ? {} : { previous }), state: 'loading' };
    });
    void loadWorkbenchCapabilities({
      artifactClient: artifactClient.current!,
      buildId,
      ...(epochSourceRevision === undefined ? {} : { epochSourceRevision }),
      evalClient: evalClient.current!,
      routeManifestClient: routeManifestClient.current!,
      signal: request.signal,
      skillClient: skillClient.current!,
    }).then(
      (value) => { if (!request.signal.aborted) setCapabilityState({ state: 'ready', value }); },
      (reason: unknown) => {
        if (request.signal.aborted) return;
        setCapabilityState((current) => {
          const previous = staleCapabilities(current);
          return {
            buildId,
            message: errorMessage(reason),
            ...(previous === undefined ? {} : { previous }),
            state: 'error',
          };
        });
      },
    );
    return () => request.abort();
  }, [buildId, capabilityRetry, epochSourceRevision]);

  useEffect(() => {
    if (!routesReady) return undefined;
    const updatePage = (fromHashChange: boolean) => {
      if (window.location.hash === '#runtime' && !runtimeAvailable) {
        if (runtimeCapability === 'unavailable') window.history.replaceState(undefined, '', '#overview');
        navigate('overview');
        return;
      }
      const next = pageForHash(runtimeAvailable, pages);
      if (!fromHashChange && next === pageRef.current) return;
      navigate(next);
    };
    const onHashChange = () => updatePage(true);
    updatePage(false);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [navigate, pages, routesReady, runtimeAvailable, runtimeCapability]);

  useEffect(() => () => {
    // Root shutdown owns the active controller's ordered preview→controller
    // close. This cleanup owns only a superseded controller after reset.
    if (mcpControllerRef.current !== mcpController) void mcpController.close().catch(() => undefined);
  }, [mcpController]);
  useEffect(() => mcpController.subscribe(setMcpModel), [mcpController]);

  const connectionGate = connection.state === 'connected' ? undefined : <main aria-live="polite" className="connection-recovery loading-state">
    <h1>{connection.state === 'unavailable' ? 'Foreground connection unavailable' : 'Foreground connection reconnecting'}</h1>
    <p>{connection.state === 'unavailable' ? 'Waiting for the foreground server to recover.' : 'Connecting to the foreground server.'}</p>
    {connectionError === undefined ? undefined : <p role="alert">{connectionError}</p>}
  </main>;
  const withConnectionGate = (content: ReactNode): ReactNode => <>
    <div className="connection-content" inert={connectionGate === undefined ? undefined : true} key={connection.generation}>{content}</div>
    {connectionGate}
  </>;
  if (connection.generation === undefined && connectionGate !== undefined) return connectionGate;
  if (status !== undefined && buildId !== undefined && capabilities === undefined) {
    const content = capabilityState.state === 'error' && capabilityState.buildId === buildId
      ? <main aria-live="polite" className="loading-state">
          <h1>Bundle capabilities unavailable</h1>
          <p role="alert">{capabilityState.message}</p>
          <button onClick={() => setCapabilityRetry((current) => current + 1)} type="button">Retry</button>
        </main>
      : <main aria-live="polite" className="loading-state"><strong>Loading bundle capabilities…</strong></main>;
    return withConnectionGate(content);
  }
  if (status !== undefined && client.current !== undefined && skillClient.current !== undefined) {
    if (page === 'mcp') {
      return withConnectionGate(<McpScreen
        appPreviewClient={mcpAppClient.current}
        artifactClient={artifactClient.current}
        connectionError={connectionError}
        controller={mcpController}
        initialToolPrefill={mcpToolPrefillFromNavigationState(window.history.state)}
        mcpDepartureDiagnostic={mcpDepartureError}
        model={mcpModel}
        onNavigate={navigate}
        onRuntimeInitialPreviewConsumed={consumeRuntimeInitialPreview}
        onResetSession={resetMcpSession}
        pages={pages}
        registerPreviewClose={registerMcpPreviewClose}
        runtimeDiagnostic={runtimeError}
        runtimeHandoff={runtimeHandoff}
        runtimePreviewDependencies={runtimePreviewDependencies}
        status={status}
      />);
    }
    if (page === 'runtime' && runtimeControllerState !== undefined) {
      return withConnectionGate(<RuntimeScreen
        connectionError={connectionError}
        controller={runtimeControllerState}
        handoffDiagnostic={runtimeHandoffError}
        liveMcpPageAdapter={liveMcpPageAdapter}
        onNavigate={navigate}
        pages={pages}
        registerAppPreviewLifecycle={registerAppPreviewLifecycle}
        renderAppPreview={renderAppPreview}
        resolveRuntimeConsent={resolveRuntimeConsent}
        runtimeConsent={runtimeConsent}
        runtimeDiagnostic={runtimeError}
      />);
    }
    if (page === 'playground') {
      return withConnectionGate(<PlaygroundScreen
        connectionError={connectionError}
        inspection={capabilities!.inspection}
        onNavigate={navigate}
        onRunChange={setPlaygroundRun}
        pages={pages}
        playgroundClient={playgroundClient.current}
        run={playgroundRun}
        runtimeDiagnostic={runtimeError}
        skillTree={capabilities!.skillTree}
        status={status}
      />);
    }
    if (page === 'routes') {
      return withConnectionGate(<RoutesScreen
        catalog={capabilities!.routes}
        connectionError={connectionError}
        onNavigate={navigate}
        onOpenMcp={(prefill) => navigate('mcp', () => {
          window.history.replaceState(mcpToolPrefillNavigationState(prefill), '', '#mcp');
        })}
        pages={pages}
        runtimeDiagnostic={runtimeError}
      />);
    }
    if (page === 'logs') {
      return withConnectionGate(<LogsScreen
        connectionError={connectionError}
        logClient={logClient.current}
        onNavigate={navigate}
        pages={pages}
        runtimeDiagnostic={runtimeError}
      />);
    }
    if (page === 'evals') {
      return withConnectionGate(<EvalsScreen connectionError={connectionError} evalClient={evalClient.current} onNavigate={navigate} pages={pages} runtimeDiagnostic={runtimeError} />);
    }
    if (page === 'comparisons') {
      return withConnectionGate(<ComparisonsScreen
        comparisonClient={comparisonClient.current}
        connectionError={connectionError}
        evalClient={evalClient.current}
        onNavigate={navigate}
        pages={pages}
        runtimeDiagnostic={runtimeError}
      />);
    }
    if (page === 'artifacts') {
      return withConnectionGate(<ArtifactsScreen artifactClient={artifactClient.current} connectionError={connectionError} onNavigate={navigate} pages={pages} runtimeDiagnostic={runtimeError} status={status} />);
    }
    if (page === 'hooks') {
      return withConnectionGate(<HooksScreen
        connectionError={connectionError}
        hookClient={hookClient.current}
        onNavigate={navigate}
        pages={pages}
        runtimeDiagnostic={runtimeError}
        status={status}
      />);
    }
    if (page === 'lifecycles') {
      return withConnectionGate(<LifecyclesScreen
        connectionError={connectionError}
        lifecycleClient={lifecycleClient.current}
        manifestDigest={capabilities!.routes.digest}
        onNavigate={navigate}
        pages={pages}
        runtimeDiagnostic={runtimeError}
      />);
    }
    return withConnectionGate(page === 'skills'
      ? <SkillsScreen connectionError={connectionError} evalClient={evalClient.current} onNavigate={navigate} pages={pages} runtimeDiagnostic={runtimeError} skillClient={skillClient.current} status={status} />
      : <Overview capabilities={capabilities} changedFiles={changedFiles} client={client.current} connectionError={connectionError} onNavigate={navigate} onStatus={setStatus} pages={pages} runtimeDiagnostic={runtimeError} status={status} />);
  }
  if (connectionGate !== undefined) return connectionGate;
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{runtimeError === undefined ? undefined : <p className="runtime-capability-error">Runtime capability issue: {runtimeError}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<RegistryProvider><Workbench /></RegistryProvider>);
