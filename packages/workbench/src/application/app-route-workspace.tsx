/**
 * The MCP App leaf workspace (#600): the bound App preview iframe is the
 * center. An App is a browser surface registered as a resource on the
 * generated server and bound to tools through `_meta.ui.resourceUri`, so the
 * workspace opens one MCP session against the published build, lists the
 * server's tools, defaults to the one bound to this App, and calls it with
 * the tool input editor beside the preview. The session opens against one of
 * the launches the dev server judged eligible for this server (#747), and
 * the preview mounts as soon as the call starts: the App sees its input, then
 * the one terminal outcome, result or cancellation (#751), through the same
 * preview machinery the protocol inspector uses (`src/mcp/**`, imported, not
 * copied). Nothing here executes the App outside its sandboxed frame.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { JsonObject } from '../../../agent-bundle/src/contracts/strict-json.ts';
import { errorMessage, isRecord } from '../client-helpers.ts';
import { workbenchMcpAppHostContext, type McpAppJsonValue, type McpAppPreviewProfile, type McpAppPreviewTerminal } from '../mcp/mcp-app-client.ts';
import { McpAppPreview } from '../mcp/mcp-app-preview.tsx';
import { McpJsonInput } from '../mcp/mcp-json-input.tsx';
import { supportedMcpAppPreviewProfiles } from '../mcp/mcp-page.tsx';
import type { McpRouteLaunch } from '../mcp/mcp-route-client.ts';
import { createMcpSessionController, type McpSessionController, type McpSessionControllerRequest } from '../mcp/mcp-session-controller.ts';
import type { McpBrowserSessionModel } from '../mcp/mcp-session-model.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import { newCorrelationId, WorkspaceHeader } from './executable-route-workspace.tsx';
import { displayAgentDocumentValue } from './rendered-document.tsx';
import { publishedEpochFor, type WorkspaceClients } from './workspace-contracts.ts';
import './workspace.css';

export interface AppRouteWorkspaceProps {
  readonly clients: Pick<WorkspaceClients, 'appClient' | 'mcpRoutes'>;
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly status: ProjectStatus;
}

export interface McpCatalogTool {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly name: string;
  readonly resourceUri?: string;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

/** The `ui://` resource this App leaf serves, from its static `config.resourceUri`. */
export const appResourceUriFor = (leaf: ApplicationLeaf): string | undefined =>
  leaf.config.find((entry) => entry.key === 'resourceUri' && entry.kind === 'string')?.value;

/** The server's live tool catalog with each tool's `_meta.ui.resourceUri` binding surfaced. */
export const catalogToolsFor = (tools: readonly unknown[]): readonly McpCatalogTool[] => Object.freeze(tools.flatMap((entry) => {
  if (!isRecord(entry)) return [];
  const name = text(entry.name);
  if (name === undefined) return [];
  const meta = isRecord(entry._meta) ? entry._meta : undefined;
  const ui = meta !== undefined && isRecord(meta.ui) ? meta.ui : undefined;
  const resourceUri = ui === undefined ? undefined : text(ui.resourceUri);
  return [Object.freeze({
    ...(text(entry.description) === undefined ? {} : { description: text(entry.description) }),
    ...(entry.inputSchema === undefined ? {} : { inputSchema: entry.inputSchema }),
    name,
    ...(resourceUri === undefined ? {} : { resourceUri }),
  })];
}));

/** Tools bound to this App first, then the rest of the server's tools. */
export const orderedToolsForApp = (tools: readonly McpCatalogTool[], resourceUri: string | undefined): readonly McpCatalogTool[] => Object.freeze([
  ...tools.filter((tool) => resourceUri !== undefined && tool.resourceUri === resourceUri),
  ...tools.filter((tool) => resourceUri === undefined || tool.resourceUri !== resourceUri),
]);

/**
 * The tool call the App workspace hands the session controller: plain MCP params
 * plus the Workbench correlation, which the route stamps into `_meta` itself
 * (a browser-sent `_meta` is refused with `AB8016`).
 */
export const appToolCallRequest = (
  name: string,
  input: JsonObject,
  correlationId: string,
): Pick<McpSessionControllerRequest, 'correlationId' | 'request'> => Object.freeze({
  correlationId,
  request: Object.freeze({ arguments: input, name }),
});

interface ToolCall {
  readonly id: string;
  readonly input: JsonObject;
  readonly sessionId: string;
  /** Absent while the call is in flight; set exactly once. */
  readonly terminal?: McpAppPreviewTerminal;
  readonly toolName: string;
}

/** The launch whose representative is `portable` when one exists, else the first. */
export const preferredLaunch = (launches: readonly McpRouteLaunch[]): McpRouteLaunch | undefined =>
  launches.find((launch) => launch.targets.includes('portable')) ?? launches[0];

/** Sorted targets read `portable · codex`; the launch id stays the stable option value. */
export const launchLabel = (launch: McpRouteLaunch): string => launch.targets.join(' · ');

const cancelledFromWorkbench = 'Cancelled from the Workbench.';

/** The App preview as the center, one MCP session per workspace, the bound tool's input beside it. */
export const AppRouteWorkspace = ({ clients, leaf, onNavigate, status }: AppRouteWorkspaceProps): React.ReactNode => {
  const epoch = publishedEpochFor(status);
  const epochId = epoch?.id;
  const serverName = leaf.ref.kind === 'app' ? leaf.ref.server : undefined;
  const resourceUri = appResourceUriFor(leaf);
  const [launches, setLaunches] = useState<readonly McpRouteLaunch[]>();
  const [launchError, setLaunchError] = useState<string>();
  const [launchId, setLaunchId] = useState<string>();
  const [profile, setProfile] = useState<McpAppPreviewProfile>('portable');
  const [model, setModel] = useState<McpBrowserSessionModel>();
  const [sessionError, setSessionError] = useState<string>();
  const [selectedTool, setSelectedTool] = useState<string>();
  const [toolInput, setToolInput] = useState<JsonObject>(Object.freeze({}));
  const [callError, setCallError] = useState<string>();
  const [call, setCall] = useState<ToolCall>();
  const controllerRef = useRef<McpSessionController | undefined>(undefined);
  // The call this workspace cancelled itself, so its rejection reads as the
  // cancellation rather than as the transport's abort error.
  const cancelledCallRef = useRef<string | undefined>(undefined);
  const host = useMemo(workbenchMcpAppHostContext, []);

  // The launches the dev server judged eligible for this server on this build
  // (#747): distinct launch identities, each with the targets that share it.
  useEffect(() => {
    setLaunches(undefined);
    setLaunchError(undefined);
    if (epochId === undefined || serverName === undefined) return;
    let current = true;
    clients.mcpRoutes.launches(epochId, serverName).then(
      (found) => { if (current) setLaunches(found); },
      (reason: unknown) => { if (current) setLaunchError(errorMessage(reason, 'The eligible launches could not be resolved.')); },
    );
    return () => { current = false; };
  }, [clients.mcpRoutes, epochId, serverName]);

  const launch = useMemo(
    () => launches?.find((candidate) => candidate.launchId === launchId) ?? preferredLaunch(launches ?? []),
    [launchId, launches],
  );
  const target = launch?.targets[0];

  // One session per (epoch, server, launch); closed when any of them changes.
  useEffect(() => {
    if (epochId === undefined || serverName === undefined || target === undefined) {
      setModel(undefined);
      return;
    }
    const controller = createMcpSessionController({ routes: clients.mcpRoutes });
    controllerRef.current = controller;
    setSessionError(undefined);
    setCall(undefined);
    setCallError(undefined);
    const unsubscribe = controller.subscribe(setModel);
    void controller.open({ epochId, serverName, target }).catch((reason: unknown) => {
      if (controllerRef.current === controller) setSessionError(errorMessage(reason, 'The MCP session could not be opened.'));
    });
    return () => {
      unsubscribe();
      if (controllerRef.current === controller) controllerRef.current = undefined;
      void controller.close().catch(() => undefined);
    };
  }, [clients.mcpRoutes, epochId, serverName, target]);

  const tools = useMemo(() => orderedToolsForApp(catalogToolsFor(model?.catalogs.tools ?? []), resourceUri), [model, resourceUri]);
  const boundTools = tools.filter((tool) => resourceUri !== undefined && tool.resourceUri === resourceUri);
  const tool = tools.find((candidate) => candidate.name === selectedTool) ?? tools[0];

  useEffect(() => {
    if (tool !== undefined && selectedTool !== tool.name) {
      setSelectedTool(tool.name);
      setToolInput(Object.freeze({}));
    }
  }, [selectedTool, tool]);

  const calling = call !== undefined && call.terminal === undefined;

  // The preview mounts with the call's input the moment the call starts; the
  // outcome settles the same call once (#751). An outcome for a call this
  // workspace no longer shows (a newer call, a replaced session) is dropped.
  const settle = (id: string, terminal: McpAppPreviewTerminal): void => {
    setCall((current) => current?.id === id && current.terminal === undefined ? Object.freeze({ ...current, terminal }) : current);
  };

  const callTool = (input: JsonObject): void => {
    const controller = controllerRef.current;
    if (controller === undefined || tool === undefined || model?.phase !== 'ready' || calling) return;
    setCallError(undefined);
    const id = `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setCall(Object.freeze({ id, input, sessionId: model.sessionId, toolName: tool.name }));
    void controller.invoke({
      id,
      operation: 'callTool',
      ...appToolCallRequest(tool.name, input, newCorrelationId()),
    }).then(
      (result) => { settle(id, Object.freeze({ result: result as McpAppJsonValue })); },
      (reason: unknown) => {
        const cancelled = cancelledCallRef.current === id;
        const message = cancelled ? cancelledFromWorkbench : errorMessage(reason, 'The tool call failed.');
        if (!cancelled && controllerRef.current === controller) setCallError(message);
        settle(id, Object.freeze({ cancelled: message }));
      },
    );
  };

  const cancelCall = (): void => {
    if (call === undefined || call.terminal !== undefined) return;
    cancelledCallRef.current = call.id;
    // A request the session no longer tracks settles here so the App is told.
    if (controllerRef.current?.cancel(call.id) !== true) settle(call.id, Object.freeze({ cancelled: cancelledFromWorkbench }));
  };

  const phase = model?.phase ?? 'idle';

  return <div className="route-workspace app-workspace" data-testid="route-workspace">
    <div className="route-workspace-main">
      <WorkspaceHeader leaf={leaf} />
      <section aria-label="App session" className="app-session">
        <dl className="inspector-rows app-session-facts">
          <div><dt>Server</dt><dd>{serverName ?? '—'}</dd></div>
          <div><dt>Resource</dt><dd>{resourceUri === undefined ? <span className="app-session-missing">No static <code>config.resourceUri</code></span> : <code>{resourceUri}</code>}</dd></div>
          <div><dt>Build</dt><dd>{epoch === undefined ? 'No published build' : epoch.id}</dd></div>
          <div><dt>Session</dt><dd><span className={`app-session-phase app-session-phase--${phase}`}>{phase}</span></dd></div>
        </dl>
        <div className="app-session-controls">
          <label><span>Launch</span>
            <select disabled={launches === undefined || launches.length === 0} onChange={(event) => setLaunchId(event.currentTarget.value)} value={launch?.launchId ?? ''}>
              {(launches ?? []).map((candidate) => <option key={candidate.launchId} value={candidate.launchId}>{launchLabel(candidate)}</option>)}
            </select>
          </label>
          <label><span>Profile</span>
            <select onChange={(event) => setProfile(event.currentTarget.value as McpAppPreviewProfile)} value={profile}>
              {supportedMcpAppPreviewProfiles.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <button
            className="inspector-copy"
            onClick={() => onNavigate({ area: 'advanced', section: 'protocol' })}
            type="button"
          >Open protocol inspector</button>
        </div>
        {launchError === undefined ? undefined : <p className="route-input-error" role="alert">{launchError}</p>}
        {launches !== undefined && launches.length === 0 ? <p className="result-note" role="status">No installed host launches this server on this build.</p> : undefined}
        {sessionError === undefined ? undefined : <p className="route-input-error" role="alert">{sessionError}</p>}
        {model?.diagnostics.length ? <ul className="inspector-diagnostics">{model.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${String(index)}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</li>)}</ul> : undefined}
      </section>
      <div className="app-workspace-body">
        <section aria-label="Tool call" className="app-tool-call">
          {epoch === undefined
            ? <p className="result-empty" role="status">Publish a build to preview this App: the preview runs against the generated server.</p>
            : phase !== 'ready'
              ? <p className="result-empty" role="status">{phase === 'error' || phase === 'closed' ? 'The MCP session is not available.' : 'Opening the MCP session…'}</p>
              : tools.length === 0
                ? <p className="result-empty" role="status">The server lists no tools; an App renders from a tool call result.</p>
                : <>
                  <label className="app-tool-select"><span>Tool</span>
                    <select onChange={(event) => { setSelectedTool(event.currentTarget.value); setToolInput(Object.freeze({})); }} value={tool?.name ?? ''}>
                      {tools.map((candidate) => <option key={candidate.name} value={candidate.name}>
                        {candidate.name}{boundTools.includes(candidate) ? ' · bound to this App' : ''}
                      </option>)}
                    </select>
                  </label>
                  {boundTools.length === 0
                    ? <p className="result-note">No tool declares <code>_meta.ui.resourceUri</code> for this App; call any tool to exercise the preview.</p>
                    : tool !== undefined && !boundTools.includes(tool)
                      ? <p className="result-note">This tool is not bound to the App; its result renders as a plain tool result.</p>
                      : undefined}
                  {tool === undefined ? undefined : <McpJsonInput
                    disabled={calling}
                    id={`app-tool-${leaf.key}`.replace(/[^a-zA-Z0-9_-]/gu, '-')}
                    label={`${tool.name} arguments`}
                    onChange={setToolInput}
                    onSubmit={callTool}
                    schema={tool.inputSchema}
                    submitLabel={calling ? 'Calling…' : 'Call tool and preview'}
                    value={toolInput}
                  />}
                  {calling ? <button className="inspector-copy" onClick={cancelCall} type="button">Cancel call</button> : undefined}
                  {callError === undefined ? undefined : <p className="route-input-error" role="alert">{callError}</p>}
                </>}
        </section>
        <section aria-label="App preview" className="app-preview" data-testid="app-preview">
          {call === undefined
            ? <p className="result-empty" role="status">Call the bound tool to render the App with its result.</p>
            : <McpAppPreview
              client={clients.appClient}
              host={host}
              input={call.input as McpAppJsonValue}
              key={`${call.id}:${profile}`}
              previewProfile={profile}
              sessionId={call.sessionId}
              terminal={call.terminal}
              title={`MCP App preview: ${leaf.label}`}
              toolName={call.toolName}
            />}
          {call === undefined ? undefined : <details className="app-preview-result" data-testid="app-call-outcome">
            <summary>{call.terminal === undefined ? 'Tool call pending' : 'cancelled' in call.terminal ? 'Tool call cancelled' : 'Tool result'}</summary>
            {call.terminal === undefined
              ? <p className="result-note" role="status">Waiting for {call.toolName} to finish; the App already has its input.</p>
              : 'cancelled' in call.terminal
                ? <p className="result-note" role="status">{call.terminal.cancelled}</p>
                : <pre className="result-json"><code>{displayAgentDocumentValue(call.terminal.result)}</code></pre>}
          </details>}
        </section>
      </div>
    </div>
  </div>;
};
