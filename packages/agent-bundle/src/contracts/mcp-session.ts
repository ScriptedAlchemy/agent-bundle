/**
 * Browser-consumable contract surface for MCP session inspection. Type-only:
 * the session service runs on the server.
 */
export type {
  McpSessionBinding,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceReplayGap,
} from '../dev/mcp-session-protocol.ts';
