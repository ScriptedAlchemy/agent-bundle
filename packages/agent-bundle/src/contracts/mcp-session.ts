/**
 * Browser-consumable contract surface for MCP session inspection. The target
 * vocabulary is the only runtime export; the session service itself runs on
 * the server.
 */
export type {
  McpSessionBinding,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceMeta,
  McpSessionTraceReplayGap,
} from '../dev/mcp-session/mcp-session-protocol.ts';

/** MCP `params._meta` key used to correlate a tool call with its Workbench invocation. */
export const mcpCorrelationMetaKey = 'agent-bundle/correlationId';

/** The host targets a Workbench MCP session may bind. */
export const MCP_SESSION_TARGETS = Object.freeze(['claude', 'codex', 'cursor', 'portable'] as const);

export type McpSessionTarget = (typeof MCP_SESSION_TARGETS)[number];

export const isMcpSessionTarget = (value: unknown): value is McpSessionTarget =>
  (MCP_SESSION_TARGETS as readonly unknown[]).includes(value);
