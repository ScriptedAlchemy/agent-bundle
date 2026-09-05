/**
 * The MCP App leaf workspace (#600): the bound App preview iframe is the
 * center. An App is a browser surface registered as a resource on the
 * generated server and bound to tools through `_meta.ui.resourceUri`, so the
 * workspace opens one MCP session against the published build, lists the
 * server's tools, defaults to the one bound to this App, and calls it with
 * the tool input editor beside the preview. The call result feeds the same
 * preview machinery the protocol inspector uses (`src/mcp/**`, imported, not
 * copied). Nothing here executes the App outside its sandboxed frame.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { JsonObject } from '../../../agent-bundle/src/contracts/strict-json.ts';
import { errorMessage, isRecord } from '../client-helpers.ts';
import { workbenchMcpAppHostContext, type McpAppJsonValue, type McpAppPreviewProfile } from '../mcp/mcp-app-client.ts';
import { McpAppPreview } from '../mcp/mcp-app-preview.tsx';
import { McpJsonInput } from '../mcp/mcp-json-input.tsx';
import { supportedMcpAppPreviewProfiles } from '../mcp/mcp-page.tsx';
import { createMcpSessionController, type McpSessionController } from '../mcp/mcp-session-controller.ts';
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

/** MCP tool params carrying the Workbench correlation key understood by the session service. */
export const appToolCallRequest = (
  name: string,
  input: JsonObject,
  correlationId: string,
): Readonly<Record<string, unknown>> => Object.freeze({
  _meta: Object.freeze({ 'agent-bundle/correlationId': correlationId }),
  arguments: input,
  name,
});

interface ToolCall {
  readonly input: JsonObject;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

const preferredTarget = (targets: readonly string[]): string | undefined =>
  targets.find((target) => target === 'portable') ?? targets[0];

/** The App preview as the center, one MCP session per workspace, the bound tool's input beside it. */
export const AppRouteWorkspace = ({ clients, leaf, onNavigate, status }: AppRouteWorkspaceProps): React.ReactNode => {
  const epoch = publishedEpochFor(status);
  const targets = useMemo(() => Object.keys(epoch?.targetDigests ?? {}).sort((left, right) => left.localeCompare(right)), [epoch]);
  const serverName = leaf.ref.kind === 'app' ? leaf.ref.server : undefined;
  const resourceUri = appResourceUriFor(leaf);
  const [target, setTarget] = useState<string | undefined>(() => preferredTarget(targets));
  const [profile, setProfile] = useState<McpAppPreviewProfile>('portable');
  const [model, setModel] = useState<McpBrowserSessionModel>();
  const [sessionError, setSessionError] = useState<string>();
  const [selectedTool, setSelectedTool] = useState<string>();
  const [toolInput, setToolInput] = useState<JsonObject>(Object.freeze({}));
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string>();
  const [call, setCall] = useState<ToolCall>();
  const controllerRef = useRef<McpSessionController | undefined>(undefined);
  const host = useMemo(workbenchMcpAppHostContext, []);

  useEffect(() => {
    setTarget((previous) => previous !== undefined && targets.includes(previous) ? previous : preferredTarget(targets));
  }, [targets]);

  // One session per (epoch, server, target); closed when any of them changes.
  useEffect(() => {
    if (epoch === undefined || serverName === undefined || target === undefined) {
      setModel(undefined);
      return;
    }
    const controller = createMcpSessionController({ routes: clients.mcpRoutes });
    controllerRef.current = controller;
    setSessionError(undefined);
    setCall(undefined);
    const unsubscribe = controller.subscribe(setModel);
    void controller.open({ epochId: epoch.id, serverName, target }).catch((reason: unknown) => {
      if (controllerRef.current === controller) setSessionError(errorMessage(reason, 'The MCP session could not be opened.'));
    });
    return () => {
      unsubscribe();
      if (controllerRef.current === controller) controllerRef.current = undefined;
      void controller.close().catch(() => undefined);
    };
  }, [clients.mcpRoutes, epoch, serverName, target]);

  const tools = useMemo(() => orderedToolsForApp(catalogToolsFor(model?.catalogs.tools ?? []), resourceUri), [model, resourceUri]);
  const boundTools = tools.filter((tool) => resourceUri !== undefined && tool.resourceUri === resourceUri);
  const tool = tools.find((candidate) => candidate.name === selectedTool) ?? tools[0];

  useEffect(() => {
    if (tool !== undefined && selectedTool !== tool.name) {
      setSelectedTool(tool.name);
      setToolInput(Object.freeze({}));
    }
  }, [selectedTool, tool]);

  const callTool = (input: JsonObject): void => {
    const controller = controllerRef.current;
    if (controller === undefined || tool === undefined || model?.phase !== 'ready' || calling) return;
    setCalling(true);
    setCallError(undefined);
    const sessionId = model.sessionId;
    const correlationId = newCorrelationId();
    void controller.invoke({
      id: `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      operation: 'callTool',
      request: appToolCallRequest(tool.name, input, correlationId),
    }).then(
      (result) => { setCall(Object.freeze({ input, result: result as McpAppJsonValue, sessionId, toolName: tool.name })); },
      (reason: unknown) => { setCallError(errorMessage(reason, 'The tool call failed.')); },
    ).finally(() => setCalling(false));
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
          <label><span>Target</span>
            <select disabled={targets.length === 0} onChange={(event) => setTarget(event.currentTarget.value)} value={target ?? ''}>
              {targets.map((name) => <option key={name} value={name}>{name}</option>)}
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
              key={`${call.sessionId}:${call.toolName}:${profile}`}
              previewProfile={profile}
              result={call.result}
              sessionId={call.sessionId}
              title={`MCP App preview: ${leaf.label}`}
              toolName={call.toolName}
            />}
          {call === undefined ? undefined : <details className="app-preview-result">
            <summary>Tool result</summary>
            <pre className="result-json"><code>{displayAgentDocumentValue(call.result)}</code></pre>
          </details>}
        </section>
      </div>
    </div>
  </div>;
};
