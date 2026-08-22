import React, { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { McpSessionBinding, McpSessionInspectorConfig, McpSessionOperation } from '../../../agent-bundle/src/contracts/mcp-session.ts';
import { errorMessage as messageFrom, isRecord } from '../client-helpers.ts';

import { McpJsonInput, type ImmutableJsonRecord } from './mcp-json-input.tsx';
import {
  createMcpAppPreviewController,
  McpAppPreviewFrame,
  type McpAppPreviewClient,
  type McpAppPreviewController,
  type McpAppPreviewState,
} from './mcp-app-preview.tsx';
import type {
  McpAppHostContext,
  McpAppJsonValue,
  McpAppPreviewProfile,
} from './mcp-app-client.ts';
import { createMcpAppFrameRelay } from './mcp-app-frame.tsx';
import type {
  McpBrowserSessionInvocation,
  McpBrowserSessionModel,
  McpBrowserSessionTimelineEntry,
} from './mcp-session-model.ts';
import type { McpSessionControllerReplay, McpSessionControllerRequest } from './mcp-session-controller.ts';
import {
  mcpProtocolTraceDownload,
  type McpDownload,
  type McpProtocolTraceSource,
} from './mcp-protocol-trace.ts';

import './mcp-page.css';

export interface McpPageController {
  readonly history: readonly McpBrowserSessionInvocation[];
  readonly model: McpBrowserSessionModel;
  readonly session?: Readonly<{ readonly timeoutMs: number }>;
  cancel(id: string): boolean;
  close(): Promise<void>;
  invoke(input: McpSessionControllerRequest): Promise<unknown>;
  open(binding: McpSessionBinding, timeoutMs?: number): Promise<McpBrowserSessionModel>;
  replay(input: McpSessionControllerReplay): Promise<unknown>;
  restart(): Promise<McpBrowserSessionModel>;
  subscribe(listener: (model: McpBrowserSessionModel) => void): () => void;
}

export interface McpPageProps {
  /** Credential-owning foreground client; it is never passed to the sandbox frame. */
  readonly appPreviewClient?: McpAppPreviewClient;
  readonly controller: McpPageController;
  readonly epochOptions: readonly string[];
  readonly initialBinding?: Partial<McpSessionBinding>;
  readonly onDownloadConfig?: (download: McpConfigDownload) => void;
  readonly onDownloadTrace?: (download: McpDownload) => void;
  /** Replaces the terminal controller with a fresh idle controller in the parent. */
  readonly onResetSession?: () => void;
  readonly targetOptions: readonly string[];
}

export type McpConfigDownload = McpDownload;

type TraceTab = 'raw' | 'logs' | 'progress';

export interface McpPageAppPreviewSource {
  readonly input: McpAppJsonValue;
  readonly invocationId: string;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

export const supportedMcpAppPreviewProfiles: readonly McpAppPreviewProfile[] = Object.freeze([
  'portable',
  'chatgpt',
  'claude',
]);

export interface McpPageActionTracker {
  readonly pending: readonly string[];
  finish(action: string): void;
  isPending(action: string): boolean;
  start(action: string): boolean;
}

export interface McpPageSessionControls {
  readonly close: boolean;
  readonly open: boolean;
  readonly recovery: 'available' | 'none' | 'unavailable';
  readonly restart: boolean;
}

export interface McpPageControllerReplacementState {
  readonly actionError: undefined;
  readonly cancelledRequests: readonly string[];
  readonly pendingActions: readonly string[];
}

export interface McpPageActionRun {
  readonly action: string;
  readonly generation: number;
  readonly tracker: McpPageActionTracker;
}

export interface McpPageActionSession {
  readonly pending: readonly string[];
  finish(run: McpPageActionRun): readonly string[] | undefined;
  isCurrent(run: McpPageActionRun): boolean;
  reset(): readonly string[];
  start(action: string): McpPageActionRun | undefined;
}

type CatalogItem = Readonly<{
  readonly description?: string;
  readonly name: string;
  readonly schema?: unknown;
  readonly uri?: string;
  readonly uriTemplate?: string;
}>;

const traceTabs: readonly TraceTab[] = ['raw', 'logs', 'progress'];

export const createMcpPageActionTracker = (): McpPageActionTracker => {
  const pending = new Set<string>();
  return {
    get pending(): readonly string[] {
      return [...pending];
    },
    finish: (action) => { pending.delete(action); },
    isPending: (action) => pending.has(action),
    start: (action) => {
      if (pending.has(action)) return false;
      pending.add(action);
      return true;
    },
  };
};

export const createMcpPageActionSession = (): McpPageActionSession => {
  let generation = 0;
  let tracker = createMcpPageActionTracker();
  const isCurrent = (run: McpPageActionRun): boolean => run.generation === generation && run.tracker === tracker;
  return {
    get pending(): readonly string[] {
      return tracker.pending;
    },
    finish: (run) => {
      if (!isCurrent(run)) return undefined;
      tracker.finish(run.action);
      return tracker.pending;
    },
    isCurrent,
    reset: () => {
      generation += 1;
      tracker = createMcpPageActionTracker();
      return tracker.pending;
    },
    start: (action) => {
      if (!tracker.start(action)) return undefined;
      return { action, generation, tracker };
    },
  };
};

export const mcpPageControllerReplacementState = (): McpPageControllerReplacementState => ({
  actionError: undefined,
  cancelledRequests: [],
  pendingActions: [],
});

export const mcpPageSessionControls = (
  phase: McpBrowserSessionModel['phase'],
  pending: readonly string[],
  hasReset: boolean,
): McpPageSessionControls => {
  const isPending = (action: string): boolean => pending.includes(action);
  const terminal = phase === 'closed' || phase === 'error';
  return {
    close: !terminal && !isPending('close') && (phase === 'opening' || phase === 'ready' || phase === 'restarting' || isPending('open') || isPending('restart')),
    open: phase === 'idle' && !isPending('open'),
    recovery: terminal ? hasReset ? 'available' : 'unavailable' : 'none',
    restart: phase === 'ready' && !isPending('restart'),
  };
};

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

const browserMcpAppHost = (): McpAppHostContext => {
  const browser = typeof window === 'undefined' ? undefined : window;
  const locale = browser?.navigator.language;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Object.freeze({
    availableDisplayModes: Object.freeze(['inline']),
    containerDimensions: Object.freeze({ height: Math.max(0, browser?.innerHeight ?? 0), width: Math.max(0, browser?.innerWidth ?? 0) }),
    deviceCapabilities: Object.freeze({}),
    displayMode: 'inline',
    locale: typeof locale === 'string' && locale.length > 0 ? locale : 'en',
    platform: 'web',
    safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
    styles: Object.freeze({}),
    theme: browser?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    timeZone: typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'UTC',
    userAgent: browser?.navigator.userAgent ?? 'unknown',
  });
};

export const mcpAppPreviewSourceFor = (
  session: Pick<McpBrowserSessionModel, 'phase' | 'sessionId'>,
  invocation: McpBrowserSessionInvocation,
): McpPageAppPreviewSource | undefined => {
  if (session.phase !== 'ready' || invocation.operation !== 'callTool' || invocation.error !== undefined || invocation.result === undefined) {
    return undefined;
  }
  const request = isRecord(invocation.request) ? invocation.request : undefined;
  const toolName = request === undefined ? undefined : text(request.name);
  if (toolName === undefined || request === undefined || !Object.hasOwn(request, 'arguments')) return undefined;
  return Object.freeze({
    input: request.arguments as McpAppJsonValue,
    invocationId: invocation.id,
    result: invocation.result as McpAppJsonValue,
    sessionId: session.sessionId,
    toolName,
  });
};

const catalogItems = (catalog: readonly unknown[], fallback: string): readonly CatalogItem[] =>
  catalog.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    return {
      description: text(record.description),
      name: text(record.name) ?? `${fallback} ${index + 1}`,
      schema: record.inputSchema ?? record.argumentsSchema,
      uri: text(record.uri),
      uriTemplate: text(record.uriTemplate),
    };
  });

const display = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unserializable protocol value]';
  }
};

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The MCP session action failed.');

const connectionSummary = (connection: McpBrowserSessionModel['connection']): string => {
  if (connection === undefined) return 'No negotiated connection.';
  const server = isRecord(connection.serverInfo) ? text(connection.serverInfo.name) : undefined;
  return [connection.protocolVersion === undefined ? undefined : `Protocol ${connection.protocolVersion}`, server]
    .filter((value): value is string => value !== undefined)
    .join(' · ') || 'Connection negotiated.';
};

export const mcpConfigDownload = (config: McpSessionInspectorConfig, sessionId: string): McpConfigDownload => ({
  blob: new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: 'application/json' }),
  filename: `mcp-${sessionId}-inspector.json`,
});

export const downloadCurrentMcpProtocolTrace = (
  onDownload: ((download: McpDownload) => void) | undefined,
  source: McpProtocolTraceSource,
): void => {
  if (onDownload !== undefined) onDownload(mcpProtocolTraceDownload(source));
};

const environmentEntries = (environment: Readonly<Record<string, string>>): ReadonlyArray<readonly [string, string]> =>
  Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

const McpLaunchConfiguration = ({ config }: { readonly config: McpSessionInspectorConfig | undefined }) => {
  if (config === undefined) return <section aria-labelledby="mcp-launch-configuration-heading" className="mcp-page-launch-configuration">
    <h3 id="mcp-launch-configuration-heading">Launch configuration</h3>
    <p className="mcp-page-empty">No launch configuration is available for this session.</p>
  </section>;

  if (config.launch.kind === 'streamable-http') return <section aria-labelledby="mcp-launch-configuration-heading" className="mcp-page-launch-configuration">
    <h3 id="mcp-launch-configuration-heading">Launch configuration</h3>
    <dl>
      <div><dt>Transport</dt><dd>streamable-http</dd></div>
      <div><dt>URL</dt><dd><code>{config.launch.url}</code></dd></div>
    </dl>
  </section>;

  const environment = environmentEntries(config.launch.env);
  return <section aria-labelledby="mcp-launch-configuration-heading" className="mcp-page-launch-configuration">
    <h3 id="mcp-launch-configuration-heading">Launch configuration</h3>
    <dl>
      <div><dt>Transport</dt><dd>stdio</dd></div>
      <div><dt>Command</dt><dd><code>{config.launch.command}</code></dd></div>
      <div><dt>Arguments</dt><dd>{config.launch.args.length === 0
        ? <span className="mcp-page-empty">No arguments specified.</span>
        : <ol aria-label="Launch arguments">{config.launch.args.map((argument, index) => <li key={`${argument}-${index}`}><code>{argument}</code></li>)}</ol>}</dd></div>
      <div><dt>Working directory</dt><dd><code>{config.launch.cwd ?? 'Not specified'}</code></dd></div>
      <div><dt>Environment</dt><dd>{environment.length === 0
        ? <span className="mcp-page-empty">No environment variables specified.</span>
        : <ul aria-label="Launch environment">{environment.map(([name, value]) => <li key={name}><code>{name}</code><span aria-hidden="true">=</span><code>{value}</code></li>)}</ul>}</dd></div>
    </dl>
  </section>;
};

const catalogList = (label: string, items: readonly CatalogItem[], action?: (item: CatalogItem) => void) => <section className="mcp-page-catalog" aria-label={label}>
  <h3>{label}</h3>
  {items.length === 0 ? <p className="mcp-page-empty">No {label.toLowerCase()} were advertised.</p> : <ol>
    {items.map((item, index) => <li key={`${item.name}-${index}`}>
      <div>
        <strong>{item.name}</strong>
        {item.description === undefined ? undefined : <p>{item.description}</p>}
        {item.uri === undefined ? undefined : <code>{item.uri}</code>}
        {item.uriTemplate === undefined ? undefined : <code>{item.uriTemplate}</code>}
      </div>
      {action === undefined ? undefined : <button onClick={() => action(item)} type="button">Read {item.uri ?? item.name}</button>}
    </li>)}
  </ol>}
</section>;

const traceValue = (entry: McpBrowserSessionTimelineEntry): unknown => {
  if ('type' in entry && entry.type === 'replay.gap') return entry;
  if ('type' in entry && entry.type === 'invocation') return entry.invocation;
  return entry;
};

interface McpPageAppPreviewProps {
  readonly client: McpAppPreviewClient;
  readonly host: McpAppHostContext;
  readonly onControllerChange: (controller: McpAppPreviewController | undefined) => void;
  readonly previewProfile: McpAppPreviewProfile;
  readonly source: McpPageAppPreviewSource;
}

const previewProfileName = (state: McpAppPreviewState, fallback: McpAppPreviewProfile): string => {
  if (state.phase !== 'ready' && state.phase !== 'fallback') return fallback;
  const profile = isRecord(state.preview.profile) ? text(state.preview.profile.profile) : undefined;
  return profile ?? fallback;
};

/** Page-owned composition keeps the approved preview close promise ahead of session teardown. */
const McpPageAppPreview = ({ client, host, onControllerChange, previewProfile, source }: McpPageAppPreviewProps) => {
  const [state, setState] = useState<McpAppPreviewState>(() => Object.freeze({ phase: 'loading' }));
  const controller = useRef<McpAppPreviewController | undefined>(undefined);
  const iframe = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const current = createMcpAppPreviewController({
      client,
      frameRelayFactory: createMcpAppFrameRelay,
      host,
      input: source.input,
      previewProfile,
      result: source.result,
      sessionId: source.sessionId,
      toolName: source.toolName,
    });
    controller.current = current;
    onControllerChange(current);
    const unsubscribe = current.subscribe(setState);
    void current.start();
    return () => {
      unsubscribe();
      if (controller.current === current) controller.current = undefined;
      onControllerChange(undefined);
      void current.close();
    };
  }, [client, host, onControllerChange, previewProfile, source]);

  useEffect(() => {
    if (state.phase !== 'ready' || iframe.current === null || typeof window === 'undefined') return;
    controller.current?.attachFrame(iframe.current, window);
  }, [state]);

  const fallback = state.phase === 'fallback' || state.phase === 'error' ? state.fallback : undefined;
  return <section aria-busy={state.phase === 'loading'} aria-label="MCP App preview" className="mcp-page-app-preview">
    <header>
      <h3>MCP App preview</h3>
      <dl><div><dt>Profile</dt><dd>{previewProfileName(state, previewProfile)}</dd></div></dl>
    </header>
    {state.phase === 'loading' ? <p role="status">Creating MCP App preview…</p> : undefined}
    {state.phase === 'error' ? <p role="alert">{state.message}</p> : undefined}
    {fallback === undefined ? undefined : <section aria-label="MCP App fallback" className="mcp-page-app-fallback">
      <p role="status">Interactive App rendering is unavailable ({fallback.reason}). Showing the ordinary tool result instead.</p>
      <details open><summary>Tool input</summary><pre><code>{display(fallback.input)}</code></pre></details>
      <details open><summary>Tool result</summary><pre><code>{display(fallback.result)}</code></pre></details>
    </section>}
    {state.phase === 'ready' && state.preview.frame !== undefined
      ? <McpAppPreviewFrame frame={state.preview.frame} iframeRef={iframe} title={`MCP App preview: ${source.toolName}`} />
      : undefined}
  </section>;
};

export const McpPage = ({ appPreviewClient, controller, epochOptions, initialBinding, onDownloadConfig, onDownloadTrace, onResetSession, targetOptions }: McpPageProps) => {
  const [model, setModel] = useState(() => controller.model);
  const [epochId, setEpochId] = useState(initialBinding?.epochId ?? '');
  const [target, setTarget] = useState(initialBinding?.target ?? '');
  const [serverName, setServerName] = useState(initialBinding?.serverName ?? '');
  const [timeoutMs, setTimeoutMs] = useState('5000');
  const [timeoutError, setTimeoutError] = useState<string>();
  const [activeTimeoutMs, setActiveTimeoutMs] = useState(controller.session?.timeoutMs);
  const [toolName, setToolName] = useState('');
  const [toolArguments, setToolArguments] = useState<ImmutableJsonRecord>({});
  const [promptName, setPromptName] = useState('');
  const [promptArguments, setPromptArguments] = useState<ImmutableJsonRecord>({});
  const [actionError, setActionError] = useState<string>();
  const [cancelledRequests, setCancelledRequests] = useState<readonly string[]>([]);
  const [pendingActions, setPendingActions] = useState<readonly string[]>([]);
  const [traceTab, setTraceTab] = useState<TraceTab>('raw');
  const [appPreview, setAppPreview] = useState<McpPageAppPreviewSource>();
  const [appPreviewBusy, setAppPreviewBusy] = useState(false);
  const [appPreviewProfile, setAppPreviewProfile] = useState<McpAppPreviewProfile>('portable');
  const [appHost] = useState(browserMcpAppHost);
  const actionSession = useRef(createMcpPageActionSession());
  const appPreviewClosePromise = useRef<Promise<void> | undefined>(undefined);
  const appPreviewController = useRef<McpAppPreviewController | undefined>(undefined);
  const appPreviewOpenGeneration = useRef(0);
  const controllerIdentity = useRef(controller);
  const requestNumber = useRef(0);
  const traceTabsByName = useRef<Partial<Record<TraceTab, HTMLButtonElement | null>>>({});

  if (controllerIdentity.current !== controller) {
    controllerIdentity.current = controller;
    actionSession.current.reset();
    const replacement = mcpPageControllerReplacementState();
    if (actionError !== replacement.actionError) setActionError(replacement.actionError);
    if (cancelledRequests.length > 0) setCancelledRequests(replacement.cancelledRequests);
    if (pendingActions.length > 0) setPendingActions(replacement.pendingActions);
  }

  useEffect(() => controller.subscribe((next) => {
    setModel(next);
    setActiveTimeoutMs(controller.session?.timeoutMs);
  }), [controller]);
  useEffect(() => () => { void appPreviewController.current?.close(); }, []);

  // Derived at render instead of pruned in state: ids whose requests already settled are simply invisible.
  const cancelledActiveRequests = cancelledRequests.filter((id) => Object.hasOwn(model.activeRequests, id));

  const setActiveAppPreviewController = useCallback((next: McpAppPreviewController | undefined): void => {
    appPreviewController.current = next;
  }, []);
  const closeCurrentAppPreview = (): Promise<void> => {
    if (appPreviewClosePromise.current !== undefined) return appPreviewClosePromise.current;
    const current = appPreviewController.current;
    appPreviewController.current = undefined;
    setAppPreviewBusy(true);
    const close: Promise<void> = Promise.resolve(current?.close()).finally(() => {
      if (appPreviewClosePromise.current !== close) return;
      appPreviewClosePromise.current = undefined;
      setAppPreview(undefined);
      setAppPreviewBusy(false);
    });
    appPreviewClosePromise.current = close;
    return close;
  };
  const closeAppPreview = (): Promise<void> => {
    appPreviewOpenGeneration.current += 1;
    return closeCurrentAppPreview();
  };
  const openAppPreview = (source: McpPageAppPreviewSource, profile = appPreviewProfile): void => {
    const generation = ++appPreviewOpenGeneration.current;
    setAppPreviewBusy(true);
    void closeCurrentAppPreview().catch(() => undefined).finally(() => {
      if (appPreviewOpenGeneration.current !== generation) return;
      setAppPreviewProfile(profile);
      setAppPreview(source);
      setAppPreviewBusy(false);
    });
  };
  useEffect(() => {
    if (appPreview !== undefined && (appPreview.sessionId !== model.sessionId || model.phase === 'closed' || model.phase === 'error')) {
      void closeAppPreview();
    }
  }, [appPreview?.sessionId, model.phase, model.sessionId]);

  const nextRequestId = (): string => {
    requestNumber.current += 1;
    return `mcp-page-${requestNumber.current}`;
  };
  const run = (action: string, operation: () => Promise<unknown>): void => {
    const session = actionSession.current;
    const run = session.start(action);
    if (run === undefined) return;
    setActionError(undefined);
    setPendingActions(session.pending);
    void operation().catch((reason: unknown) => {
      if (session.isCurrent(run)) setActionError(errorMessage(reason));
    }).finally(() => {
      const pending = session.finish(run);
      if (pending !== undefined) setPendingActions(pending);
    });
  };
  const invoke = (operation: Exclude<McpSessionOperation, 'cancel' | 'close' | 'restart'>, request: Readonly<Record<string, unknown>>): void => {
    const requestId = nextRequestId();
    run(`invoke:${operation}`, () => controller.invoke({ id: requestId, operation, request }));
  };

  const tools = catalogItems(model.catalogs.tools, 'Tool');
  const prompts = catalogItems(model.catalogs.prompts, 'Prompt');
  const resources = catalogItems(model.catalogs.resources, 'Resource');
  const resourceTemplates = catalogItems(model.catalogs.resourceTemplates, 'Resource template');
  const selectedTool = tools.find((item) => item.name === toolName) ?? tools[0];
  const selectedPrompt = prompts.find((item) => item.name === promptName) ?? prompts[0];
  const active = Object.values(model.activeRequests);
  const controls = mcpPageSessionControls(model.phase, pendingActions, onResetSession !== undefined);
  const isPending = (action: string): boolean => pendingActions.includes(action);
  const rawTrace = model.conciseTrace;
  const config = model.config;
  const traceEntries = traceTab === 'raw' ? rawTrace : traceTab === 'logs' ? model.logs : model.progress;
  const traceLabel = traceTab === 'raw' ? 'Raw protocol' : traceTab === 'logs' ? 'Logs' : 'Progress';
  const tracePanelId = 'mcp-trace-panel';
  const selectTraceTab = (next: TraceTab): void => {
    setTraceTab(next);
    traceTabsByName.current[next]?.focus();
  };
  const onTraceTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: TraceTab): void => {
    const index = traceTabs.indexOf(current);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? traceTabs[(index + 1) % traceTabs.length]!
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? traceTabs[(index + traceTabs.length - 1) % traceTabs.length]!
        : event.key === 'Home'
          ? traceTabs[0]
          : event.key === 'End'
            ? traceTabs[traceTabs.length - 1]
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectTraceTab(next);
  };

  return <div className="mcp-page" aria-label="MCP playground">
    <header className="mcp-page-heading">
      <div>
        <p className="mcp-page-eyebrow">Artifact-bound protocol workbench</p>
        <h1>MCP playground</h1>
        <p>Start one server from an explicit epoch, inspect its negotiated protocol, and replay recorded calls.</p>
      </div>
      <p className={`mcp-page-phase mcp-page-phase--${model.phase}`} role="status">Session {model.phase}</p>
    </header>

    <section className="mcp-page-section" aria-labelledby="mcp-session-heading">
      <h2 id="mcp-session-heading">Session</h2>
      {controls.recovery !== 'none' ? <div className="mcp-page-recovery" role="status">
        <p>This controller is terminal. Supply a new controller before opening another MCP session.</p>
        {controls.recovery === 'available'
          ? <button onClick={() => run('reset', async () => {
            await closeAppPreview();
            onResetSession?.();
          })} type="button">Reset MCP session</button>
          : <button disabled type="button">New MCP session unavailable</button>}
      </div> : <form className="mcp-page-binding" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const parsedTimeoutMs = Number(timeoutMs);
        if (!Number.isFinite(parsedTimeoutMs) || parsedTimeoutMs <= 0) {
          setTimeoutError('Session timeout must be a positive finite number.');
          return;
        }
        setTimeoutError(undefined);
        run('open', () => controller.open({ epochId, serverName, target }, parsedTimeoutMs));
      }}>
        <label htmlFor="mcp-epoch">Artifact epoch
          <select disabled={!controls.open} id="mcp-epoch" onChange={(event) => setEpochId(event.currentTarget.value)} required value={epochId}>
            <option value="">Select an epoch</option>
            {epochOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label htmlFor="mcp-target">Generated target
          <select disabled={!controls.open} id="mcp-target" onChange={(event) => setTarget(event.currentTarget.value)} required value={target}>
            <option value="">Select a target</option>
            {targetOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label htmlFor="mcp-server-name">Server name
          <input disabled={!controls.open} id="mcp-server-name" onChange={(event) => setServerName(event.currentTarget.value)} required value={serverName} />
        </label>
        <label htmlFor="mcp-session-timeout">Session timeout (ms)
          <input
            aria-describedby={timeoutError === undefined ? undefined : 'mcp-session-timeout-error'}
            aria-invalid={timeoutError === undefined ? undefined : true}
            disabled={!controls.open}
            id="mcp-session-timeout"
            inputMode="numeric"
            onChange={(event) => {
              setTimeoutMs(event.currentTarget.value);
              setTimeoutError(undefined);
            }}
            type="number"
            value={timeoutMs}
          />
          {timeoutError === undefined ? undefined : <span id="mcp-session-timeout-error" role="alert">{timeoutError}</span>}
        </label>
        <div className="mcp-page-actions">
          {controls.open ? <button type="submit">Open MCP session</button> : undefined}
          <button disabled={!controls.restart} onClick={() => run('restart', async () => {
            await closeAppPreview();
            return controller.restart();
          })} type="button">Restart MCP session</button>
          <button disabled={!controls.close} onClick={() => run('close', async () => {
            await closeAppPreview();
            return controller.close();
          })} type="button">Close MCP session</button>
        </div>
      </form>}
      {activeTimeoutMs === undefined ? undefined : <p className="mcp-page-session-timeout">Active session timeout: {activeTimeoutMs} ms.</p>}
      <div className="mcp-page-connection" aria-label="Negotiated connection">
        <h3>Negotiated connection</h3>
        <p>{connectionSummary(model.connection)}</p>
        {model.connection === undefined ? undefined : <pre><code>{display({ capabilities: model.connection.serverCapabilities, server: model.connection.serverInfo })}</code></pre>}
      </div>
      <McpLaunchConfiguration config={config} />
      {active.length === 0 ? undefined : <section aria-label="Active MCP operations" className="mcp-page-active">
        <h3>Active operations</h3>
        <ul>{active.map((request) => <li key={request.id}><span>{request.operation} · {request.id}</span><button disabled={cancelledActiveRequests.includes(request.id)} onClick={() => {
          if (!controller.cancel(request.id)) {
            setActionError(`MCP operation ${request.id} is no longer active.`);
            return;
          }
          setCancelledRequests((current) => current.includes(request.id) ? current : [...current, request.id]);
        }} type="button">Cancel {request.id}</button></li>)}</ul>
      </section>}
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-catalog-heading">
      <h2 id="mcp-catalog-heading">Catalog</h2>
      <div className="mcp-page-catalog-grid">
        <section className="mcp-page-catalog" aria-label="Tools">
          <h3>Tools</h3>
          {tools.length === 0 ? <p className="mcp-page-empty">No tools were advertised.</p> : <ol>{tools.map((item, index) => <li key={`${item.name}-${index}`}>
            <button aria-pressed={selectedTool?.name === item.name} onClick={() => {
              setToolName(item.name);
              setToolArguments({});
            }} type="button">{item.name}</button>
            {item.description === undefined ? undefined : <p>{item.description}</p>}
          </li>)}</ol>}
          {selectedTool === undefined ? undefined : <McpJsonInput
            disabled={model.phase !== 'ready' || isPending('invoke:callTool')}
            id="mcp-tool-arguments"
            label="Tool arguments"
            onChange={setToolArguments}
            onSubmit={(argumentsValue) => invoke('callTool', { arguments: argumentsValue, name: selectedTool.name })}
            schema={selectedTool.schema}
            submitLabel={`Call ${selectedTool.name}`}
            value={toolArguments}
          />}
        </section>
        <section className="mcp-page-catalog" aria-label="Prompts">
          <h3>Prompts</h3>
          {prompts.length === 0 ? <p className="mcp-page-empty">No prompts were advertised.</p> : <ol>{prompts.map((item, index) => <li key={`${item.name}-${index}`}>
            <button aria-pressed={selectedPrompt?.name === item.name} onClick={() => {
              setPromptName(item.name);
              setPromptArguments({});
            }} type="button">{item.name}</button>
            {item.description === undefined ? undefined : <p>{item.description}</p>}
          </li>)}</ol>}
          {selectedPrompt === undefined ? undefined : <McpJsonInput
            disabled={model.phase !== 'ready' || isPending('invoke:getPrompt')}
            id="mcp-prompt-arguments"
            label="Prompt arguments"
            onChange={setPromptArguments}
            onSubmit={(argumentsValue) => invoke('getPrompt', { arguments: argumentsValue, name: selectedPrompt.name })}
            submitLabel={`Get ${selectedPrompt.name}`}
            value={promptArguments}
          />}
        </section>
        {catalogList('Resources', resources, (item) => {
          if (item.uri !== undefined) invoke('readResource', { uri: item.uri });
        })}
        {catalogList('Resource templates', resourceTemplates)}
      </div>
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-operations-heading">
      <h2 id="mcp-operations-heading">Operations and results</h2>
      <div className="mcp-page-actions" aria-label="Catalog operations">
        <button disabled={model.phase !== 'ready' || isPending('invoke:listTools')} onClick={() => invoke('listTools', {})} type="button">List tools</button>
        <button disabled={model.phase !== 'ready' || isPending('invoke:listResources')} onClick={() => invoke('listResources', {})} type="button">List resources</button>
        <button disabled={model.phase !== 'ready' || isPending('invoke:listResourceTemplates')} onClick={() => invoke('listResourceTemplates', {})} type="button">List resource templates</button>
        <button disabled={model.phase !== 'ready' || isPending('invoke:listPrompts')} onClick={() => invoke('listPrompts', {})} type="button">List prompts</button>
      </div>
      {appPreviewClient === undefined ? undefined : <section aria-label="MCP App preview controls" className="mcp-page-app-controls">
        <div>
          <h3>App preview</h3>
          <p>Open a sandboxed preview from a successful tool call using the selected supported host profile.</p>
        </div>
        <label htmlFor="mcp-app-profile">Preview profile
          <select disabled={appPreviewBusy} id="mcp-app-profile" onChange={(event) => {
            const profile = event.currentTarget.value as McpAppPreviewProfile;
            if (!supportedMcpAppPreviewProfiles.includes(profile)) return;
            if (appPreview === undefined) {
              setAppPreviewProfile(profile);
              return;
            }
            openAppPreview(appPreview, profile);
          }} value={appPreviewProfile}>
            {supportedMcpAppPreviewProfiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
          </select>
        </label>
        {appPreview === undefined ? <p className="mcp-page-empty">Select a completed tool call below to create an App preview.</p> : <button disabled={appPreviewBusy} onClick={() => { void closeAppPreview(); }} type="button">Close App preview</button>}
      </section>}
      {appPreviewClient === undefined || appPreview === undefined ? undefined : <McpPageAppPreview
        client={appPreviewClient}
        host={appHost}
        key={`${appPreview.invocationId}-${appPreviewProfile}`}
        onControllerChange={setActiveAppPreviewController}
        previewProfile={appPreviewProfile}
        source={appPreview}
      />}
      <section aria-label="Invocation history" className="mcp-page-history">
        <h3>Invocation history</h3>
        {controller.history.length === 0 ? <p className="mcp-page-empty">No completed invocations yet.</p> : <ol>{controller.history.map((invocation) => {
          const previewSource = mcpAppPreviewSourceFor(model, invocation);
          return <li key={invocation.id}>
            <div><strong>{invocation.operation}</strong><span>{invocation.id}</span>{invocation.replayOf === undefined ? undefined : <span>Replay of {invocation.replayOf}</span>}</div>
            <pre><code>{display({ error: invocation.error, request: invocation.request, result: invocation.result, timing: invocation.timing })}</code></pre>
            <button disabled={model.phase !== 'ready' || isPending('replay')} onClick={() => run('replay', () => controller.replay({ id: nextRequestId(), invocationId: invocation.id }))} type="button">Replay {invocation.id}</button>
            {appPreviewClient === undefined || previewSource === undefined ? undefined : <button disabled={appPreviewBusy} onClick={() => openAppPreview(previewSource)} type="button">Open App preview for {invocation.id}</button>}
          </li>;
        })}</ol>}
      </section>
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-trace-heading">
      <h2 id="mcp-trace-heading">Trace</h2>
      <p>Download the current browser MCP trace, not a durable Playground session export.</p>
      <button disabled={onDownloadTrace === undefined} onClick={() => downloadCurrentMcpProtocolTrace(onDownloadTrace, { history: controller.history, model })} type="button">Download current protocol trace</button>
      <div aria-label="Trace-derived views" className="mcp-page-tabs" role="tablist">
        {traceTabs.map((candidate) => <button
          aria-controls={tracePanelId}
          aria-selected={traceTab === candidate}
          id={`mcp-trace-tab-${candidate}`}
          key={candidate}
          onClick={() => selectTraceTab(candidate)}
          onKeyDown={(event) => onTraceTabKeyDown(event, candidate)}
          ref={(element) => { traceTabsByName.current[candidate] = element; }}
          role="tab"
          tabIndex={traceTab === candidate ? 0 : -1}
          type="button"
        >
          {candidate === 'raw' ? 'Raw protocol' : candidate[0]!.toUpperCase()}{candidate === 'raw' ? undefined : candidate.slice(1)}
        </button>)}
      </div>
      <section aria-labelledby={`mcp-trace-tab-${traceTab}`} className="mcp-page-trace" id={tracePanelId} role="tabpanel" tabIndex={0}>
        <h3>{traceLabel}</h3>
        {traceEntries.length === 0 ? <p className="mcp-page-empty">No {traceLabel.toLowerCase()} entries yet.</p> : <ol>{traceEntries.map((entry, index) => <li key={'sequence' in entry ? entry.sequence : index}>
          <pre><code>{display(traceValue(entry))}</code></pre>
        </li>)}</ol>}
      </section>
    </section>

    <section className="mcp-page-section mcp-page-config" aria-labelledby="mcp-config-heading">
      <h2 id="mcp-config-heading">Inspector config</h2>
      <p>Export the selected session’s resolved command and non-secret environment for the standalone Inspector.</p>
      <button disabled={config === undefined || onDownloadConfig === undefined} onClick={() => {
        if (config !== undefined && onDownloadConfig !== undefined) onDownloadConfig(mcpConfigDownload(config, model.sessionId));
      }} type="button">Download Inspector config</button>
    </section>

    {actionError === undefined && model.diagnostics.length === 0 ? undefined : <section aria-label="MCP diagnostics" className="mcp-page-diagnostics" role="alert">
      {actionError === undefined ? undefined : <p>{actionError}</p>}
      {model.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}
    </section>}
  </div>;
};
