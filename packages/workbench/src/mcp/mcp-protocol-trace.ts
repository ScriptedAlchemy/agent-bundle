import type {
  McpBrowserSessionBinding,
  McpBrowserSessionConnection,
  McpBrowserSessionInvocation,
  McpBrowserSessionModel,
  McpBrowserSessionPhase,
  McpBrowserSessionTimeline,
} from './mcp-session-model.ts';

export interface McpDownload {
  readonly blob: Blob;
  readonly filename: string;
}

export interface McpProtocolTraceSource {
  readonly history: readonly McpBrowserSessionInvocation[];
  readonly model: McpBrowserSessionModel;
}

export interface McpProtocolTraceExport {
  readonly history: readonly McpBrowserSessionInvocation[];
  readonly kind: 'agent-bundle.mcp-protocol-trace';
  readonly schemaVersion: 1;
  readonly session: Readonly<{
    readonly binding: McpBrowserSessionBinding | null;
    readonly connection: McpBrowserSessionConnection | null;
    readonly id: string | null;
    readonly phase: McpBrowserSessionPhase;
  }>;
  readonly timeline: McpBrowserSessionTimeline;
}

const sessionId = (model: Pick<McpBrowserSessionModel, 'binding' | 'sessionId'>): string | null =>
  model.binding === undefined || model.sessionId.length === 0 ? null : model.sessionId;

export const mcpProtocolTraceExport = ({ history, model }: McpProtocolTraceSource): McpProtocolTraceExport => ({
  history,
  kind: 'agent-bundle.mcp-protocol-trace',
  schemaVersion: 1,
  session: {
    binding: model.binding ?? null,
    connection: model.connection ?? null,
    id: sessionId(model),
    phase: model.phase,
  },
  timeline: model.timeline,
});

export const mcpProtocolTraceDownload = (source: McpProtocolTraceSource): McpDownload => {
  const trace = mcpProtocolTraceExport(source);
  return {
    blob: new Blob([`${JSON.stringify(trace, null, 2)}\n`], { type: 'application/json' }),
    filename: `mcp-${trace.session.id ?? 'idle'}-protocol-trace.json`,
  };
};
