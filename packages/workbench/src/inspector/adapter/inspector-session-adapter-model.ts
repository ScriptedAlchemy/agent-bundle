import type { McpSessionTraceEntry } from '../../../../agent-bundle/src/dev/mcp-session-protocol.ts';
import type { McpBrowserSessionModel, McpBrowserSessionTimelineEntry } from '../../mcp/mcp-session-model.ts';

export type InspectorTab = 'tools' | 'resources' | 'prompts' | 'protocol' | 'logging';

export interface InspectorProtocolEntry {
  readonly direction: 'request' | 'response' | 'notification';
  readonly id: string;
  readonly message: Readonly<Record<string, unknown>>;
  readonly origin: 'client' | 'server';
  readonly sequence: number;
  readonly timestamp: Date;
}

export interface InspectorLogEntry {
  readonly params: Readonly<{ readonly data: unknown; readonly level: string; readonly logger?: string }>;
  readonly receivedAt: Date;
  readonly sequence: number;
}

type FrameTraceEntry = McpSessionTraceEntry & Readonly<{
  readonly direction: 'client' | 'server';
  readonly kind: 'frame';
  readonly message: unknown;
}>;

type LoggingTraceEntry = McpSessionTraceEntry & Readonly<{
  readonly kind: 'logging';
  readonly payload: unknown;
}>;

export const inspectorSessionTabs: readonly Readonly<{ readonly id: InspectorTab; readonly label: string }>[] = [
  { id: 'tools', label: 'Tools' },
  { id: 'resources', label: 'Resources' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'protocol', label: 'Protocol' },
  { id: 'logging', label: 'Logging' },
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFrame = (entry: McpBrowserSessionTimelineEntry): entry is FrameTraceEntry =>
  'kind' in entry && entry.kind === 'frame';

const isLogging = (entry: McpBrowserSessionTimelineEntry): entry is LoggingTraceEntry =>
  'kind' in entry && entry.kind === 'logging';

const vendorReplayableMethods = new Set([
  'ping',
  'prompts/get',
  'prompts/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'tasks/list',
  'tools/call',
  'tools/list',
]);

const jsonRpcDirection = (message: Readonly<Record<string, unknown>>): InspectorProtocolEntry['direction'] | undefined => {
  const hasId = Object.hasOwn(message, 'id');
  const hasMethod = typeof message.method === 'string';
  if (hasId && hasMethod) return 'request';
  if (!hasId && hasMethod) return 'notification';
  if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return 'response';
  return undefined;
};

const logParams = (payload: unknown): InspectorLogEntry['params'] | undefined => {
  if (!isRecord(payload) || typeof payload.level !== 'string' || !Object.hasOwn(payload, 'data')) return undefined;
  return payload as InspectorLogEntry['params'];
};

export const inspectorSessionBindingKey = (binding: McpBrowserSessionModel['binding']): string =>
  binding === undefined ? '' : `${binding.epochId}\u0000${binding.target}\u0000${binding.serverName}`;

export const inspectorProtocolEntries = (
  timeline: readonly McpBrowserSessionTimelineEntry[],
): InspectorProtocolEntry[] => timeline.flatMap((entry) => {
  if (!isFrame(entry) || !isRecord(entry.message)) return [];
  const direction = jsonRpcDirection(entry.message);
  if (direction === undefined) return [];
  if (direction === 'request' && typeof entry.message.method === 'string' && vendorReplayableMethods.has(entry.message.method)) return [];
  return [{
    direction,
    id: `trace-${entry.sequence}`,
    message: entry.message,
    origin: entry.direction,
    sequence: entry.sequence,
    timestamp: new Date(entry.occurredAt),
  }];
});

export const inspectorLogEntries = (
  timeline: readonly McpBrowserSessionTimelineEntry[],
): InspectorLogEntry[] => timeline.flatMap((entry) => {
  if (!isLogging(entry)) return [];
  const params = logParams(entry.payload);
  return params === undefined ? [] : [{ params, receivedAt: new Date(entry.occurredAt), sequence: entry.sequence }];
});
