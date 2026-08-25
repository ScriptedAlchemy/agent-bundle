import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';

import type { ForegroundSessionAuthority } from './foreground-session.ts';
import type { ArtifactClient } from './artifacts/artifact-client.ts';
import { InspectorSessionAdapter } from './inspector/adapter/inspector-session-adapter-entry.ts';
import type { McpAppClient } from './mcp/mcp-app-client.ts';
import { McpPage, mcpPageServerCatalogFor, type McpPageServerCatalog } from './mcp/mcp-page.tsx';
import { mcpProtocolTraceDownload, type McpDownload } from './mcp/mcp-protocol-trace.ts';
import { McpRouteClient } from './mcp/mcp-route-client.ts';
import { createMcpSessionController } from './mcp/mcp-session-controller.ts';
import { activeEpochFor } from './overview-model.ts';
import { WorkbenchScreen, type WorkbenchPage } from './workbench-screen.tsx';

export type McpPresentation = 'inspector' | 'playground';

const mcpTargets = ['portable', 'claude', 'codex'] as const;

export const createMcpController = (authority: ForegroundSessionAuthority) => createMcpSessionController({
  routes: new McpRouteClient({ authority }),
});

const downloadMcpFile = ({ blob, filename }: McpDownload): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const McpScreen = ({ appPreviewClient, artifactClient, connectionError, controller, model, onNavigate, onResetSession, presentation, setPresentation, status }: {
  readonly appPreviewClient: McpAppClient;
  readonly artifactClient: ArtifactClient;
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
  const activeEpoch = activeEpochFor(status);
  const [serverCatalog, setServerCatalog] = useState<McpPageServerCatalog>();
  const targetOptions = mcpTargets.filter((target) => activeEpoch !== undefined && target in activeEpoch.targetDigests);
  const serverCatalogState = activeEpoch !== undefined && (serverCatalog === undefined || serverCatalog.epochId !== activeEpoch.id)
    ? 'loading'
    : 'ready';
  const serverOptions = activeEpoch !== undefined && serverCatalogState === 'ready' ? serverCatalog?.options ?? [] : [];
  useEffect(() => {
    const epochId = activeEpoch?.id;
    const controller = new AbortController();
    setServerCatalog(undefined);
    if (epochId === undefined) return () => controller.abort();
    void artifactClient.inspect(epochId, controller.signal).then((inspection) => {
      const catalog = mcpPageServerCatalogFor(epochId, inspection, controller.signal);
      if (catalog !== undefined) setServerCatalog(catalog);
    }).catch(() => {
      // An unavailable inspection leaves the editable server field available without stale catalog suggestions.
    });
    return () => controller.abort();
  }, [activeEpoch?.id, artifactClient]);
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
  const exportInspectorTrace = (entries: typeof model.timeline.entries): void => {
    downloadMcpFile(mcpProtocolTraceDownload({
      history: controller.history,
      model: { ...model, timeline: { ...model.timeline, entries } },
    }));
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
          onDownloadConfig={downloadMcpFile}
          onDownloadTrace={downloadMcpFile}
          onResetSession={onResetSession}
          presentationActive={presentation === 'playground'}
          serverCatalogState={serverCatalogState}
          serverOptions={serverOptions}
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
        <InspectorSessionAdapter controller={controller} model={model} onExportTrace={exportInspectorTrace} />
      </section>
    </div>
  </WorkbenchScreen>;
};
