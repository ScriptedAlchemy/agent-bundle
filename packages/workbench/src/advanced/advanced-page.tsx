/**
 * Advanced (#600): the secondary destinations behind one sub-nav — Evals
 * (Runs · Compare) · Artifact · Protocol · Host diagnostics · Raw logs — each
 * mounting the existing page component. The sub-nav is URL-addressable
 * (`/advanced/<section>`); the section components own their own state.
 */
import React, { useEffect, useState } from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import { ArtifactClient } from '../artifacts/artifact-client.ts';
import { ArtifactsPage } from '../artifacts/artifacts-page.tsx';
import { downloadBlob } from '../client-helpers.ts';
import type { ComparisonClient } from '../evals/comparison-client.ts';
import type { DiscoveryClient } from '../discovery/discovery-client.ts';
import { DiscoveryPage } from '../discovery/discovery-page.tsx';
import type { EvalClient } from '../evals/eval-client.ts';
import { EvalsPage } from '../evals/evals-page.tsx';
import type { LogClient } from '../logs/log-client.ts';
import { LogsPage } from '../logs/logs-page.tsx';
import type { McpAppClient } from '../mcp/mcp-app-client.ts';
import type { McpInspectorLaunchController } from '../mcp/mcp-inspector-launch-controller.ts';
import {
  McpPage,
  mcpPageEmptyServerCatalogFor,
  mcpPageServerCatalogFor,
  type McpPageController,
  type McpPageServerCatalog,
} from '../mcp/mcp-page.tsx';
import type { McpDownload } from '../mcp/mcp-protocol-trace.ts';
import { activeEpochFor } from '../shell/build-status-model.ts';
import { advancedSections, formatWorkbenchLocation, type AdvancedSection, type WorkbenchLocation } from '../shell/workbench-location.ts';

export interface AdvancedClients {
  readonly appClient: McpAppClient;
  readonly artifactClient: ArtifactClient;
  readonly comparisonClient: ComparisonClient;
  readonly discoveryClient: DiscoveryClient;
  readonly evalClient: EvalClient;
  readonly logClient: LogClient;
}

/** The raw MCP session the Protocol section drives; the shell owns its lifetime so it survives navigation. */
export interface AdvancedProtocolSession {
  readonly controller: McpPageController;
  readonly inspectorLaunch: McpInspectorLaunchController;
  /** Replaces a terminal controller with a fresh idle one. */
  readonly onResetSession: () => void;
}

export interface AdvancedPageProps {
  readonly clients: AdvancedClients;
  /** The compiled route manifest's source revision, which Host diagnostics compares installed plugins against. */
  readonly manifestSourceRevision?: string;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly protocol: AdvancedProtocolSession;
  readonly section: AdvancedSection;
  readonly status: ProjectStatus;
}

export const advancedSectionLabels: Readonly<Record<AdvancedSection, string>> = Object.freeze({
  artifact: 'Artifact',
  evals: 'Evals',
  hosts: 'Host diagnostics',
  logs: 'Raw logs',
  protocol: 'Protocol',
});

const mcpTargets = ['portable', 'claude', 'codex'] as const;

const downloadMcpFile = ({ blob, filename }: McpDownload): void => downloadBlob(blob, filename);

/**
 * The raw MCP protocol inspector: the artifact-bound `McpPage` with the
 * published epoch's servers as advisory defaults. Unmounting closes any App
 * preview the page opened; the session controller itself outlives the section.
 */
const ProtocolSection = ({ appClient, artifactClient, onNavigate, protocol, status }: {
  readonly appClient: McpAppClient;
  readonly artifactClient: Pick<ArtifactClient, 'inspect'>;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly protocol: AdvancedProtocolSession;
  readonly status: ProjectStatus;
}) => {
  const activeEpoch = activeEpochFor(status);
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
  return <div className="mcp-content">
    <McpPage
      appPreviewClient={appClient}
      controller={protocol.controller}
      epochOptions={activeEpoch === undefined ? [] : [activeEpoch.id]}
      initialBinding={activeEpoch === undefined ? undefined : { epochId: activeEpoch.id }}
      inspectorLaunch={protocol.inspectorLaunch}
      onDownloadConfig={downloadMcpFile}
      onDownloadTrace={downloadMcpFile}
      onNavigate={onNavigate}
      onResetSession={protocol.onResetSession}
      presentationActive={true}
      serverCatalogState={serverCatalogState}
      serverOptions={serverOptions}
      targetOptions={targetOptions}
    />
  </div>;
};

const AdvancedSectionContent = ({ clients, manifestSourceRevision, onNavigate, protocol, section, status }: AdvancedPageProps) => {
  switch (section) {
    case 'evals':
      return <EvalsPage client={clients.evalClient} comparisonClient={clients.comparisonClient} />;
    case 'artifact':
      return <ArtifactsPage client={clients.artifactClient} epochId={activeEpochFor(status)?.id} />;
    case 'protocol':
      return <ProtocolSection appClient={clients.appClient} artifactClient={clients.artifactClient} onNavigate={onNavigate} protocol={protocol} status={status} />;
    case 'hosts':
      return <DiscoveryPage client={clients.discoveryClient} manifestDigest={manifestSourceRevision} />;
    case 'logs':
      return <LogsPage client={clients.logClient} />;
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
};

export const AdvancedPage = (props: AdvancedPageProps) => {
  const { onNavigate, section } = props;
  return <div className="advanced-page" data-testid="advanced-page">
    <nav aria-label="Advanced sections" className="sub-nav advanced-sub-nav" data-testid="advanced-nav">
      {advancedSections.map((candidate) => {
        const location: WorkbenchLocation = Object.freeze({ area: 'advanced', section: candidate });
        return <a
          key={candidate}
          aria-current={candidate === section ? 'page' : undefined}
          href={formatWorkbenchLocation(location)}
          onClick={(event) => { event.preventDefault(); onNavigate(location); }}
        >{advancedSectionLabels[candidate]}</a>;
      })}
    </nav>
    <div className={`advanced-section advanced-section--${section}`}>
      <AdvancedSectionContent {...props} />
    </div>
  </div>;
};
