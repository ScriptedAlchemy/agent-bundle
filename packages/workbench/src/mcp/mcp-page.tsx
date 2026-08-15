import React, { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { McpSessionBinding, McpSessionInspectorConfig, McpSessionOperation } from '../../../agent-bundle/src/dev/mcp-session-protocol.ts';

import { McpJsonInput, type ImmutableJsonRecord } from './mcp-json-input.tsx';
import type {
  McpBrowserSessionInvocation,
  McpBrowserSessionModel,
  McpBrowserSessionTimelineEntry,
} from './mcp-session-model.ts';
import type { McpSessionControllerReplay, McpSessionControllerRequest } from './mcp-session-controller.ts';

import './mcp-page.css';

export interface McpPageController {
  readonly history: readonly McpBrowserSessionInvocation[];
  readonly model: McpBrowserSessionModel;
  cancel(id: string): boolean;
  close(): Promise<void>;
  invoke(input: McpSessionControllerRequest): Promise<unknown>;
  open(binding: McpSessionBinding): Promise<McpBrowserSessionModel>;
  replay(input: McpSessionControllerReplay): Promise<unknown>;
  restart(): Promise<McpBrowserSessionModel>;
  subscribe(listener: (model: McpBrowserSessionModel) => void): () => void;
}

export interface McpPageProps {
  readonly controller: McpPageController;
  readonly epochOptions: readonly string[];
  readonly initialBinding?: Partial<McpSessionBinding>;
  readonly onDownloadConfig?: (download: McpConfigDownload) => void;
  /** Replaces the terminal controller with a fresh idle controller in the parent. */
  readonly onResetSession?: () => void;
  readonly targetOptions: readonly string[];
}

export interface McpConfigDownload {
  readonly blob: Blob;
  readonly filename: string;
}

type TraceTab = 'raw' | 'logs' | 'progress';

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

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

const errorMessage = (reason: unknown): string => reason instanceof Error ? reason.message : 'The MCP session action failed.';

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

export const McpPage = ({ controller, epochOptions, initialBinding, onDownloadConfig, onResetSession, targetOptions }: McpPageProps) => {
  const [model, setModel] = useState(() => controller.model);
  const [epochId, setEpochId] = useState(initialBinding?.epochId ?? '');
  const [target, setTarget] = useState(initialBinding?.target ?? '');
  const [serverName, setServerName] = useState(initialBinding?.serverName ?? '');
  const [toolName, setToolName] = useState('');
  const [toolArguments, setToolArguments] = useState<ImmutableJsonRecord>({});
  const [promptName, setPromptName] = useState('');
  const [promptArguments, setPromptArguments] = useState<ImmutableJsonRecord>({});
  const [actionError, setActionError] = useState<string>();
  const [cancelledRequests, setCancelledRequests] = useState<readonly string[]>([]);
  const [pendingActions, setPendingActions] = useState<readonly string[]>([]);
  const [traceTab, setTraceTab] = useState<TraceTab>('raw');
  const actions = useRef(createMcpPageActionTracker());
  const requestNumber = useRef(0);
  const traceTabsByName = useRef<Partial<Record<TraceTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    actions.current = createMcpPageActionTracker();
    setPendingActions([]);
    setCancelledRequests([]);
    return controller.subscribe(setModel);
  }, [controller]);
  useEffect(() => {
    setCancelledRequests((current) => current.filter((id) => Object.hasOwn(model.activeRequests, id)));
  }, [model.activeRequests]);

  const nextRequestId = (): string => {
    requestNumber.current += 1;
    return `mcp-page-${requestNumber.current}`;
  };
  const run = (action: string, operation: () => Promise<unknown>): void => {
    if (!actions.current.start(action)) return;
    setActionError(undefined);
    setPendingActions(actions.current.pending);
    void operation().catch((reason: unknown) => setActionError(errorMessage(reason))).finally(() => {
      actions.current.finish(action);
      setPendingActions(actions.current.pending);
    });
  };
  const invoke = (operation: Exclude<McpSessionOperation, 'cancel' | 'close' | 'restart'>, request: Readonly<Record<string, unknown>>): void => {
    run(`invoke:${operation}`, () => controller.invoke({ id: nextRequestId(), operation, request }));
  };

  const tools = catalogItems(model.catalogs.tools, 'Tool');
  const prompts = catalogItems(model.catalogs.prompts, 'Prompt');
  const resources = catalogItems(model.catalogs.resources, 'Resource');
  const resourceTemplates = catalogItems(model.catalogs.resourceTemplates, 'Resource template');
  const selectedTool = tools.find((item) => item.name === toolName) ?? tools[0];
  const selectedPrompt = prompts.find((item) => item.name === promptName) ?? prompts[0];
  const active = Object.values(model.activeRequests);
  const controls = mcpPageSessionControls(model.phase, pendingActions, onResetSession !== undefined);
  const isPending = (action: string): boolean => actions.current.isPending(action);
  const rawTrace = model.conciseTrace;
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

  return <main className="mcp-page" aria-label="MCP playground">
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
          ? <button onClick={onResetSession} type="button">Reset MCP session</button>
          : <button disabled type="button">New MCP session unavailable</button>}
      </div> : <form className="mcp-page-binding" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        run('open', () => controller.open({ epochId, serverName, target }));
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
        <div className="mcp-page-actions">
          {controls.open ? <button type="submit">Open MCP session</button> : undefined}
          <button disabled={!controls.restart} onClick={() => run('restart', () => controller.restart())} type="button">Restart MCP session</button>
          <button disabled={!controls.close} onClick={() => run('close', () => controller.close())} type="button">Close MCP session</button>
        </div>
      </form>}
      <div className="mcp-page-connection" aria-label="Negotiated connection">
        <h3>Negotiated connection</h3>
        <p>{connectionSummary(model.connection)}</p>
        {model.connection === undefined ? undefined : <pre><code>{display({ capabilities: model.connection.serverCapabilities, server: model.connection.serverInfo })}</code></pre>}
      </div>
      {active.length === 0 ? undefined : <section aria-label="Active MCP operations" className="mcp-page-active">
        <h3>Active operations</h3>
        <ul>{active.map((request) => <li key={request.id}><span>{request.operation} · {request.id}</span><button disabled={cancelledRequests.includes(request.id)} onClick={() => {
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
      <section aria-label="Invocation history" className="mcp-page-history">
        <h3>Invocation history</h3>
        {controller.history.length === 0 ? <p className="mcp-page-empty">No completed invocations yet.</p> : <ol>{controller.history.map((invocation) => <li key={invocation.id}>
          <div><strong>{invocation.operation}</strong><span>{invocation.id}</span>{invocation.replayOf === undefined ? undefined : <span>Replay of {invocation.replayOf}</span>}</div>
          <pre><code>{display({ error: invocation.error, request: invocation.request, result: invocation.result, timing: invocation.timing })}</code></pre>
          <button disabled={model.phase !== 'ready' || isPending('replay')} onClick={() => run('replay', () => controller.replay({ id: nextRequestId(), invocationId: invocation.id }))} type="button">Replay {invocation.id}</button>
        </li>)}</ol>}
      </section>
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-trace-heading">
      <h2 id="mcp-trace-heading">Trace</h2>
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
      <button disabled={model.config === undefined || onDownloadConfig === undefined} onClick={() => {
        if (model.config !== undefined && onDownloadConfig !== undefined) onDownloadConfig(mcpConfigDownload(model.config, model.sessionId));
      }} type="button">Download Inspector config</button>
    </section>

    {actionError === undefined && model.diagnostics.length === 0 ? undefined : <section aria-label="MCP diagnostics" className="mcp-page-diagnostics" role="alert">
      {actionError === undefined ? undefined : <p>{actionError}</p>}
      {model.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}
    </section>}
  </main>;
};
