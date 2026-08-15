import { createTheme, MantineProvider } from '@mantine/core';
import type {
  CallToolResult,
  GetPromptResult,
  LoggingLevel,
  Prompt,
  Resource,
  ResourceTemplateType as ResourceTemplate,
  Tool,
} from '@modelcontextprotocol/client';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { McpBrowserSessionModel, McpBrowserSessionTimelineEntry } from '../../mcp/mcp-session-model.ts';
import { clearScrollMemory } from '../vendor/clients/web/src/hooks/useScrollMemory.ts';
import {
  inspectorLogEntries,
  inspectorProtocolEntries,
  inspectorSessionBindingKey,
  inspectorSessionTabs,
  type InspectorTab,
} from './inspector-session-adapter-model.ts';
import { LoggingScreen, PromptsScreen, ProtocolScreen, ResourcesScreen, ToolsScreen } from './vendor-screens.jsx';

export {
  inspectorLogEntries,
  inspectorProtocolEntries,
  inspectorSessionBindingKey,
  inspectorSessionTabs,
} from './inspector-session-adapter-model.ts';

export interface InspectorSessionAdapterController {
  cancel(id: string): boolean;
  invoke(input: InspectorSessionControllerRequest): Promise<unknown>;
}

export interface InspectorSessionAdapterProps {
  readonly controller: InspectorSessionAdapterController;
  readonly initialTab?: InspectorTab;
  readonly model: McpBrowserSessionModel;
  readonly onExportTrace?: (entries: readonly McpBrowserSessionTimelineEntry[]) => void;
}

type SortDirection = 'oldest-first' | 'newest-first';

type InspectorSessionOperation = 'callTool' | 'getPrompt' | 'listPrompts' | 'listResources' | 'listTools' | 'readResource';

interface InspectorSessionControllerRequest {
  readonly id: string;
  readonly operation: InspectorSessionOperation;
  readonly request: Readonly<Record<string, unknown>>;
}

interface ToolsUiState {
  readonly formValues: Record<string, unknown>;
  readonly runAsTask: boolean;
  readonly search: string;
  readonly selectedToolName?: string;
}

interface ResourcesUiState {
  readonly search: string;
  readonly selectedResourceUri?: string;
  readonly selectedTemplateUri?: string;
}

interface PromptsUiState {
  readonly argumentValues: Record<string, string>;
  readonly search: string;
  readonly selectedPromptName?: string;
}

interface ProtocolUiState {
  readonly search: string;
  readonly visibleDirections: Readonly<Record<'client' | 'server', boolean>>;
}

interface LogsUiState {
  readonly filterText: string;
  readonly visibleLevels: Readonly<Record<LoggingLevel, boolean>>;
}

interface ToolCallState {
  readonly error?: string;
  readonly result?: CallToolResult;
  readonly status: 'idle' | 'pending' | 'ok' | 'error';
}

interface ReadResourceState {
  readonly error?: string;
  readonly result?: unknown;
  readonly status: 'idle' | 'pending' | 'ok' | 'error';
  readonly uri?: string;
}

interface GetPromptState {
  readonly error?: string;
  readonly promptName?: string;
  readonly result?: GetPromptResult;
  readonly status: 'idle' | 'pending' | 'ok' | 'error';
}

const emptyPagination = {
  canLoadMore: false,
  loadedPages: 1,
  onLoadMore: () => undefined,
  onPaginatedChange: () => undefined,
  paginated: false,
};

const initialToolsUi: ToolsUiState = { formValues: {}, runAsTask: false, search: '' };
const initialResourcesUi: ResourcesUiState = { search: '' };
const initialPromptsUi: PromptsUiState = { argumentValues: {}, search: '' };
const initialProtocolUi: ProtocolUiState = {
  search: '',
  visibleDirections: { client: true, server: true },
};
const initialLogsUi: LogsUiState = {
  filterText: '',
  visibleLevels: { alert: true, critical: true, debug: true, emergency: true, error: true, info: true, notice: true, warning: true },
};

export const agentBundleInspectorTheme = createTheme({
  defaultRadius: 'sm',
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  primaryColor: 'violet',
});

const operationError = (reason: unknown): string => reason instanceof Error ? reason.message : 'The Inspector operation failed.';

export const InspectorSessionAdapter = ({ controller, initialTab = 'tools', model, onExportTrace }: InspectorSessionAdapterProps) => {
  const bindingKey = inspectorSessionBindingKey(model.binding);
  const previousBindingKey = useRef(bindingKey);
  const requestNumber = useRef(0);
  const actionGeneration = useRef(0);
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [toolsUi, setToolsUi] = useState<ToolsUiState>(initialToolsUi);
  const [resourcesUi, setResourcesUi] = useState<ResourcesUiState>(initialResourcesUi);
  const [promptsUi, setPromptsUi] = useState<PromptsUiState>(initialPromptsUi);
  const [protocolUi, setProtocolUi] = useState<ProtocolUiState>(initialProtocolUi);
  const [logsUi, setLogsUi] = useState<LogsUiState>(initialLogsUi);
  const [toolCall, setToolCall] = useState<ToolCallState>();
  const [toolRequestId, setToolRequestId] = useState<string>();
  const [readResource, setReadResource] = useState<ReadResourceState>();
  const [getPrompt, setGetPrompt] = useState<GetPromptState>();
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [protocolCleared, setProtocolCleared] = useState(false);
  const [loggingCleared, setLoggingCleared] = useState(false);
  const [loggingDiagnostic, setLoggingDiagnostic] = useState('Log-level changes are unavailable because this W13 session does not expose logging/setLevel.');
  const [sortDirection, setSortDirection] = useState<SortDirection>('oldest-first');
  const [compact, setCompact] = useState(false);
  const [protocolReplayUnavailable, setProtocolReplayUnavailable] = useState(false);

  useEffect(() => {
    if (previousBindingKey.current === bindingKey) return;
    previousBindingKey.current = bindingKey;
    actionGeneration.current += 1;
    clearScrollMemory();
    setToolsUi(initialToolsUi);
    setResourcesUi(initialResourcesUi);
    setPromptsUi(initialPromptsUi);
    setProtocolUi(initialProtocolUi);
    setLogsUi(initialLogsUi);
    setToolCall(undefined);
    setToolRequestId(undefined);
    setReadResource(undefined);
    setGetPrompt(undefined);
    setPinnedIds(new Set());
    setProtocolCleared(false);
    setLoggingCleared(false);
    setLoggingDiagnostic('Log-level changes are unavailable because this W13 session does not expose logging/setLevel.');
    setProtocolReplayUnavailable(false);
  }, [bindingKey]);

  const protocolEntries = useMemo(() => inspectorProtocolEntries(model.timeline.entries), [model.timeline.entries]);
  const loggingEntries = useMemo(() => inspectorLogEntries(model.timeline.entries), [model.timeline.entries]);
  const tools = useMemo(() => [...model.catalogs.tools] as unknown as Tool[], [model.catalogs.tools]);
  const resources = useMemo(() => [...model.catalogs.resources] as unknown as Resource[], [model.catalogs.resources]);
  const templates = useMemo(() => [...model.catalogs.resourceTemplates] as unknown as ResourceTemplate[], [model.catalogs.resourceTemplates]);
  const prompts = useMemo(() => [...model.catalogs.prompts] as unknown as Prompt[], [model.catalogs.prompts]);
  const displayedProtocol = protocolCleared ? [] : protocolEntries;
  const displayedLogs = loggingCleared ? [] : loggingEntries;

  const nextRequest = (operation: InspectorSessionOperation, request: Readonly<Record<string, unknown>>): InspectorSessionControllerRequest => {
    requestNumber.current += 1;
    return { id: `inspector-${model.sessionId}-${requestNumber.current}`, operation, request };
  };

  const run = (operation: InspectorSessionOperation, request: Readonly<Record<string, unknown>>): Promise<unknown> =>
    controller.invoke(nextRequest(operation, request));

  const runTool = (name: string, args: Record<string, unknown>): void => {
    const generation = actionGeneration.current;
    const request = nextRequest('callTool', { arguments: args, name });
    setToolRequestId(request.id);
    setToolCall({ status: 'pending' });
    void controller.invoke(request).then((result) => {
      if (generation === actionGeneration.current) setToolCall({ result: result as CallToolResult, status: 'ok' });
    }, (reason: unknown) => {
      if (generation === actionGeneration.current) setToolCall({ error: operationError(reason), status: 'error' });
    });
  };

  const runReadResource = (uri: string): void => {
    const generation = actionGeneration.current;
    setReadResource({ status: 'pending', uri });
    void run('readResource', { uri }).then((result) => {
      if (generation === actionGeneration.current) setReadResource({ result: result as ReadResourceState['result'], status: 'ok', uri });
    }, (reason: unknown) => {
      if (generation === actionGeneration.current) setReadResource({ error: operationError(reason), status: 'error', uri });
    });
  };

  const runGetPrompt = (name: string, args: Record<string, string>): void => {
    const generation = actionGeneration.current;
    setGetPrompt({ promptName: name, status: 'pending' });
    void run('getPrompt', { arguments: args, name }).then((result) => {
      if (generation === actionGeneration.current) setGetPrompt({ promptName: name, result: result as GetPromptResult, status: 'ok' });
    }, (reason: unknown) => {
      if (generation === actionGeneration.current) setGetPrompt({ error: operationError(reason), promptName: name, status: 'error' });
    });
  };

  const refresh = (operation: InspectorSessionOperation): void => { void run(operation, {}); };
  const negotiatedProtocol = model.connection?.protocolVersion ?? 'Not negotiated';

  return <MantineProvider theme={agentBundleInspectorTheme}>
    <section aria-label="MCP Inspector presentation" className="inspector-session-adapter">
      <header>
        <h2>Inspector</h2>
        <p>Negotiated protocol: {negotiatedProtocol}</p>
        <nav aria-label="Inspector screens">
          {inspectorSessionTabs.map(({ id, label }) => <button aria-current={tab === id ? 'page' : undefined} key={id} onClick={() => setTab(id)} type="button">{label}</button>)}
        </nav>
      </header>
      {tab === 'tools' ? <ToolsScreen
        callState={toolCall}
        listChanged={false}
        onCallTool={runTool}
        onCancelCall={() => {
          if (toolRequestId !== undefined) controller.cancel(toolRequestId);
          setToolCall(undefined);
          setToolRequestId(undefined);
        }}
        onClearResult={() => {
          setToolCall(undefined);
          setToolRequestId(undefined);
        }}
        onRefreshList={() => refresh('listTools')}
        onUiChange={setToolsUi}
        pagination={emptyPagination}
        serverSupportsTaskToolCalls={false}
        tools={tools}
        ui={toolsUi}
      /> : undefined}
      {tab === 'resources' ? <ResourcesScreen
        compact={compact}
        listChanged={false}
        onCompactChange={setCompact}
        onReadResource={runReadResource}
        onRefreshList={() => refresh('listResources')}
        onSubscribeResource={() => undefined}
        onUiChange={setResourcesUi}
        onUnsubscribeResource={() => undefined}
        pagination={emptyPagination}
        readState={readResource}
        resources={resources}
        subscriptions={[]}
        subscriptionsSupported={false}
        templates={templates}
        ui={resourcesUi}
      /> : undefined}
      {tab === 'prompts' ? <PromptsScreen
        getPromptState={getPrompt}
        listChanged={false}
        onGetPrompt={runGetPrompt}
        onRefreshList={() => refresh('listPrompts')}
        onUiChange={setPromptsUi}
        pagination={emptyPagination}
        prompts={prompts}
        ui={promptsUi}
      /> : undefined}
      {tab === 'protocol' ? <ProtocolScreen
        compact={compact}
        entries={displayedProtocol}
        onClearAll={() => setProtocolCleared(true)}
        onClearSection={(section: 'history' | 'pinned') => section === 'history' ? setProtocolCleared(true) : setPinnedIds(new Set())}
        onExport={() => onExportTrace?.(model.timeline.entries)}
        onExportSection={() => onExportTrace?.(model.timeline.entries)}
        onReplay={() => setProtocolReplayUnavailable(true)}
        onSortChange={setSortDirection}
        onToggleCompact={() => setCompact((value) => !value)}
        onTogglePin={(id: string) => setPinnedIds((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        })}
        onUiChange={setProtocolUi}
        pinnedIds={pinnedIds}
        sortDirection={sortDirection}
        ui={protocolUi}
      /> : undefined}
      {protocolReplayUnavailable ? <p role="status">Replay is unavailable for raw W13 trace frames.</p> : undefined}
      {tab === 'logging' ? <section aria-label="Logging inspector">
        <p role="note">{loggingDiagnostic}</p>
        <LoggingScreen
          currentLevel={'info' as LoggingLevel}
          embedded
          entries={displayedLogs}
          onClear={() => setLoggingCleared(true)}
          onExport={() => onExportTrace?.(model.timeline.entries)}
          onSetLevel={() => setLoggingDiagnostic('Log-level changes remain unavailable because this W13 session does not expose logging/setLevel.')}
          onSortChange={setSortDirection}
          onUiChange={setLogsUi}
          sortDirection={sortDirection}
          ui={logsUi}
        />
      </section> : undefined}
    </section>
  </MantineProvider>;
};
